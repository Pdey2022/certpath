import { addTerm } from "../calendar.ts";
import type { AccessGrantRecord } from "../entitlements.ts";
import { refundWindowMs, standardCoverageEndMs } from "../pricing.ts";
import type {
  D1PreparedStatement,
  SecurityDatabase,
} from "../security/database.ts";
import { grantOperationId } from "./checkouts.ts";
import type { PilotEventRecorder } from "../analytics/pilot-events.ts";
import { recordSafely } from "../analytics/pilot-events.ts";
import type { FakePaymentProvider } from "./providers/fake.ts";
import type { PaymentProvider, ProviderEvent } from "./provider.ts";

// The provider webhook: verify, dedupe, settle.
//
// This is the only unauthenticated write surface in the application. Its door is
// `provider.verifyEvent` (an HMAC and a 300-second replay window in the fake), the
// provider event id's primary key, and the deterministic grant `operation_id`.
// There is no session, no cookie, no CSRF token and no IP allowlist here, and
// nothing on this path reads a learner-supplied header.
//
// A learner never has access because a provider said so. Access exists because a
// row in `learner_access_grants` exists, and every other row this module writes -
// the checkout's status, the receipt, the event, the audit - is a witness that
// the same batch wrote it.
//
// ## The shape of the effect batch
//
// One `database.batch()` is one transaction, and a failing statement rolls the
// whole batch back. The statements are ordered so that **every witness reads a
// write the same transaction made**, and so that no statement can succeed whose
// prerequisite did not:
//
//   1. the Standard grant, if the SKU grants Standard - guarded by the
//      compare-and-swap on the coverage end read for this settlement;
//   2. the Pro grant, if the SKU grants Pro - after the Standard row, because
//      0013 requires the covering Standard row to exist;
//   3. the checkout transition to `paid`, predicated on the grants above having
//      landed, so "paid with no entitlement" is unrepresentable;
//   4. the purchase receipt, predicated on the paid checkout;
//   5. the provider event row **last**, its `outcome` computed from what this
//      transaction actually wrote.
//
// Why the event row is last rather than first. Its `outcome` column is
// append-only and NOT NULL, so the value has to be decided once and be true. An
// event row written first would name an outcome before the effects ran, and a
// lost compare-and-swap would then leave a row claiming `applied` with no grant
// behind it. Written last, the outcome is a function of the state this
// transaction produced. The property the "first" ordering was there to buy - a
// duplicate can never fail the batch and pin the provider in a retry loop - is
// kept by `ON CONFLICT (provider_event_id) DO NOTHING`, and is strengthened:
// every effect statement also requires the event id to be unseen, so a duplicate
// delivery provably writes nothing at all.
//
// This is the approved amendment to the design, which specified the event row
// first. `docs/commerce.md` ("Why the event row is last") records that the
// event-first ordering is superseded, and why.
//
// ## Row witnesses
//
// `meta.changes` is never used. `learner_access_grants` carries an `AFTER INSERT`
// audit trigger (0013), so `changes` on that statement counts the grant *and* its
// audit row - a row witness that reads 2 for one insert. Every statement here
// returns `RETURNING id` and the returned rows are counted.
//
// ## `failed` is a settleable source
//
// Money can arrive after a `checkout.failed` - an out-of-order completion, or a
// retry the provider authorised twice - and 0020 makes `failed -> paid` and
// `failed -> needs_support` legal edges. The migration alone would be decoration,
// so every "settleable" predicate in this module names `failed` too: both grant
// statements, the checkout transition, the event row's retryable test, the park,
// and the final status check. An edge the statements do not use is a rule the
// code does not have.
//
// `applyFailure` deliberately keeps `WHERE status = 'pending'`: a
// `checkout.failed` must never move a `paid` or `refunded` row backwards.
//
// Rules: docs/commerce.md, docs/decisions/0003-pricing-pro-and-refunds.md.

/** Raw webhook bodies larger than this are refused before a signature is read. */
export const maxWebhookBodyBytes = 16 * 1024;

/** The values `commerce_provider_events.outcome` admits. */
export type WebhookOutcome =
  | "applied"
  | "ignored-unknown-checkout"
  | "ignored-inconsistent";

export type WebhookResult =
  | { ok: true; duplicate: boolean; outcome: WebhookOutcome }
  | {
      ok: false;
      status: 400 | 401 | 404 | 413 | 503;
      code:
        | "malformed_event"
        | "invalid_signature"
        | "unknown_provider"
        | "payload_too_large"
        | "commerce_disabled"
        | "provider_unavailable";
    };

/** How many times a lost compare-and-swap is retried before `needs_support`. */
export const settlementAttempts = 3;

const checkoutColumns = `id, user_id, certification_id, sku, currency,
                         total_minor, status, paid_at, provider,
                         provider_session_id`;

export interface SettleableCheckout {
  id: string;
  user_id: string;
  certification_id: string;
  sku: string;
  currency: string;
  total_minor: number;
  status:
    | "pending"
    | "paid"
    | "failed"
    | "expired"
    | "needs_support"
    | "refunded";
  paid_at: number | null;
  provider: string;
  provider_session_id: string | null;
}

export interface SnapshotLine {
  position: number;
  sku: string;
  label: string;
  amount_minor: number;
  grants_feature: "standard" | "pro";
  grants_unit: "calendar_months" | "days";
  grants_months: number | null;
  grants_days: number | null;
}

/** One grant a settlement will write, with the window computed for it. */
export interface PlannedGrant {
  feature: "standard" | "pro";
  startsAt: number;
  expiresAt: number;
  operationId: string;
}

/** A term as the snapshot stores it, reconstructed from its two columns. */
export function termOf(line: SnapshotLine) {
  return line.grants_unit === "calendar_months"
    ? { unit: "calendar_months" as const, months: line.grants_months ?? 0 }
    : { unit: "days" as const, days: line.grants_days ?? 0 };
}

/**
 * Everything one attempt at the effect batch needs, computed from one `now`.
 *
 * `casToken`/`casFallback` are the compare-and-swap: `casFallback` is what
 * `COALESCE(MAX(expires_at), ?)` uses when the account has no Standard grant, and
 * `casToken` is the exact value `MAX(expires_at)` had when the windows were
 * computed. The statement only inserts when storage still says the same thing, so
 * two settlements that read the same coverage cannot both append from it.
 */
export interface SettlementPlan {
  checkoutId: string;
  eventId: string;
  provider: string;
  amountMinor: number;
  currency: string;
  occurredAt: number;
  /** One instant for the whole settlement: both bundle legs, the receipt, the event row. */
  now: number;
  paidAt: number;
  source: "purchase" | "bundle";
  grants: readonly PlannedGrant[];
  casToken: number;
  casFallback: number;
  linesJson: string;
  grantsJson: string;
}

export interface SettlementWitness {
  /** True when this call inserted the provider event row. */
  eventRecorded: boolean;
  outcome: WebhookOutcome | null;
  /** True when this call moved the checkout to `paid`. */
  transitioned: boolean;
  /** How many grant rows this call inserted. */
  granted: number;
  receiptIssued: boolean;
  /** True when not every grant the plan promises was written. */
  incomplete: boolean;
}

function rowCount(result: { results?: unknown[] } | undefined): number {
  return (result?.results ?? []).length;
}

function idList(count: number, firstIndex: number): string {
  return new Array(count)
    .fill(0)
    .map((_, index) => `?${firstIndex + index}`)
    .join(", ");
}

/**
 * Resolve the checkout a verified event is about.
 *
 * On the session **we** bound at checkout creation, never on the provider's echo
 * of our id: the echo is provider-supplied input and the fake adapter accepts up
 * to 128 characters of it. `provider_session_id` is UNIQUE and write-once (0019),
 * so it names exactly one checkout; `provider` keeps a webhook delivered to one
 * provider's path from settling another provider's checkout.
 */
export async function readCheckoutForSession(
  database: SecurityDatabase,
  providerName: string,
  sessionRef: string,
): Promise<SettleableCheckout | null> {
  return database
    .prepare(
      `SELECT ${checkoutColumns}
       FROM commerce_checkouts
       WHERE provider_session_id = ? AND provider = ?`,
    )
    .bind(sessionRef, providerName)
    .first<SettleableCheckout>();
}

async function readCheckoutById(
  database: SecurityDatabase,
  checkoutId: string,
): Promise<SettleableCheckout | null> {
  return database
    .prepare(`SELECT ${checkoutColumns} FROM commerce_checkouts WHERE id = ?`)
    .bind(checkoutId)
    .first<SettleableCheckout>();
}

export async function readSnapshotLines(
  database: SecurityDatabase,
  checkoutId: string,
): Promise<SnapshotLine[]> {
  const rows = await database
    .prepare(
      `SELECT position, sku, label, amount_minor, grants_feature,
              grants_unit, grants_months, grants_days
       FROM commerce_checkout_lines
       WHERE checkout_id = ?
       ORDER BY position`,
    )
    .bind(checkoutId)
    .all<SnapshotLine>();
  return rows.results;
}

export async function readAccountGrants(
  database: SecurityDatabase,
  userId: string,
  certificationId: string,
): Promise<AccessGrantRecord[]> {
  const rows = await database
    .prepare(
      `SELECT feature, starts_at, expires_at, revoked_at
       FROM learner_access_grants
       WHERE user_id = ? AND certification_id = ?`,
    )
    .bind(userId, certificationId)
    .all<{
      feature: "standard" | "pro";
      starts_at: number;
      expires_at: number;
      revoked_at: number | null;
    }>();
  return rows.results.map((row) => ({
    feature: row.feature,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  }));
}

/**
 * The windows one settlement writes, from the **stored** price snapshot and one
 * `now`.
 *
 * Standard-granting SKUs append to continuous coverage
 * (`[coverageEnd, coverageEnd + term)`); the Pro leg never appends
 * (`[now, now + proTerm)`), because 0013 requires a single row that starts at or
 * before the Pro window. The bundle is the one exception: its Standard leg starts
 * at `now` so that one row can cover the Pro leg, and ends at
 * `max(addTerm(coverageEnd, term), addTerm(now, term))`.
 *
 * The `max` is load-bearing, not defensive: calendar addition with a day clamp is
 * not order-preserving, so `addTerm(coverageEnd, term)` can land *before*
 * `addTerm(now, term)` (30 January 18:00 and 31 January 00:00 both clamp into
 * 30 April). Without it the Standard leg can end before the Pro leg and 0013
 * would abort a purchase the learner already paid for.
 *
 * The arithmetic is done here, in JavaScript, because a calendar month is not a
 * constant: SQLite's `date('2024-01-31','+1 month')` overflows to `2024-03-02`
 * instead of clamping to `2024-02-29`, so doing it in SQL would be a second
 * implementation of `addCalendarMonths`, in a different language, losing
 * sub-second precision. The concurrency property that living in the statement
 * bought is kept by the compare-and-swap instead.
 */
export function planSettlementWindows(
  grants: readonly AccessGrantRecord[],
  lines: readonly SnapshotLine[],
  now: number,
  checkoutId: string,
): { grants: PlannedGrant[]; casToken: number; casFallback: number } {
  let rawMax: number | null = null;
  for (const grant of grants) {
    if (grant.feature !== "standard" || grant.revokedAt !== null) continue;
    rawMax = rawMax === null ? grant.expiresAt : Math.max(rawMax, grant.expiresAt);
  }
  const coverageEnd = standardCoverageEndMs(grants, now) ?? now;
  const casFallback = coverageEnd;
  const casToken = rawMax ?? casFallback;

  const standardLine = lines.find((line) => line.grants_feature === "standard");
  const proLine = lines.find((line) => line.grants_feature === "pro");
  // The bundle is the only SKU whose snapshot carries both legs. Reading that
  // from the snapshot rather than from the price list is what keeps a price-list
  // change from rewriting what an already-created checkout grants.
  const isBundle = standardLine !== undefined && proLine !== undefined;

  const planned: PlannedGrant[] = [];
  if (standardLine) {
    const startsAt = isBundle ? now : coverageEnd;
    const stacked = addTerm(
      isBundle ? coverageEnd : startsAt,
      termOf(standardLine),
    );
    const expiresAt =
      isBundle && proLine
        ? Math.max(stacked, addTerm(now, termOf(proLine)))
        : stacked;
    planned.push({
      feature: "standard",
      startsAt,
      expiresAt,
      operationId: grantOperationId(checkoutId, "standard"),
    });
  }
  if (proLine) {
    planned.push({
      feature: "pro",
      startsAt: now,
      expiresAt: addTerm(now, termOf(proLine)),
      operationId: grantOperationId(checkoutId, "pro"),
    });
  }
  return { grants: planned, casToken, casFallback };
}

function standardGrantStatement(
  database: SecurityDatabase,
  plan: SettlementPlan,
  grant: PlannedGrant,
): D1PreparedStatement {
  // The compare-and-swap: `COALESCE(MAX(expires_at), ?11) = ?12` is "the coverage
  // this plan was computed from is still the coverage in storage". Zero rows
  // means another settlement appended first, so this attempt wrote nothing and
  // the caller re-reads and retries.
  return database
    .prepare(
      `INSERT INTO learner_access_grants (
         id, user_id, certification_id, feature, starts_at, expires_at,
         revoked_at, created_at, sku, source, operation_id, created_by_user_id
       )
       SELECT ?1, checkout.user_id, checkout.certification_id, 'standard',
              ?2, ?3, NULL, ?4, checkout.sku, ?5, ?6, NULL
       FROM commerce_checkouts AS checkout
       WHERE checkout.id = ?7
         AND checkout.status IN ('pending', 'expired', 'failed')
         AND checkout.total_minor = ?8
         AND checkout.currency = ?9
         AND NOT EXISTS (
           SELECT 1 FROM learner_access_grants AS existing
           WHERE existing.operation_id = ?6
         )
         AND NOT EXISTS (
           SELECT 1 FROM commerce_provider_events AS seen
           WHERE seen.provider_event_id = ?10
         )
         AND (
           SELECT COALESCE(MAX(stored.expires_at), ?11)
           FROM learner_access_grants AS stored
           WHERE stored.user_id = checkout.user_id
             AND stored.certification_id = checkout.certification_id
             AND stored.feature = 'standard'
             AND stored.revoked_at IS NULL
         ) = ?12
       RETURNING id`,
    )
    .bind(
      crypto.randomUUID(),
      grant.startsAt,
      grant.expiresAt,
      plan.now,
      plan.source,
      grant.operationId,
      plan.checkoutId,
      plan.amountMinor,
      plan.currency,
      plan.eventId,
      plan.casFallback,
      plan.casToken,
    );
}

function proGrantStatement(
  database: SecurityDatabase,
  plan: SettlementPlan,
  grant: PlannedGrant,
  standardLegOperationId: string | null,
): D1PreparedStatement {
  // The Pro leg runs after the Standard leg. When this plan wrote one, the row
  // is required to be there first, so the order 0013 demands is the order the
  // batch wrote rather than an ordering the statements happen to have. A Pro
  // add-on has no Standard leg here, and 0013 checks the pre-existing cover.
  //
  // The `EXISTS` is load-bearing for a second reason, not only ordering: it is
  // what stops an **orphan Pro**. When the Standard leg loses the compare-and-swap
  // and this guard is absent, the Pro row still inserts (0013 is satisfied by the
  // learner's existing cover), the transition then matches nothing because it
  // counts both operation ids, and the batch **commits** a live Pro grant with no
  // paid checkout, no receipt and no event row - a window bought by nobody. The
  // retry can then never succeed: 0019's one-Pro-window trigger refuses the Pro
  // insert for pointing at that orphan, and the learner's real payment ends in
  // `needs_support`. Do not simplify this into "the transition already checks".
  const covering = standardLegOperationId
    ? `
         AND EXISTS (
           SELECT 1 FROM learner_access_grants AS cover
           WHERE cover.operation_id = ?11
             AND cover.revoked_at IS NULL
         )`
    : "";
  const values: (string | number)[] = [
    crypto.randomUUID(),
    grant.startsAt,
    grant.expiresAt,
    plan.now,
    plan.source,
    grant.operationId,
    plan.checkoutId,
    plan.amountMinor,
    plan.currency,
    plan.eventId,
  ];
  if (standardLegOperationId) values.push(standardLegOperationId);
  return database
    .prepare(
      `INSERT INTO learner_access_grants (
         id, user_id, certification_id, feature, starts_at, expires_at,
         revoked_at, created_at, sku, source, operation_id, created_by_user_id
       )
       SELECT ?1, checkout.user_id, checkout.certification_id, 'pro',
              ?2, ?3, NULL, ?4, checkout.sku, ?5, ?6, NULL
       FROM commerce_checkouts AS checkout
       WHERE checkout.id = ?7
         AND checkout.status IN ('pending', 'expired', 'failed')
         AND checkout.total_minor = ?8
         AND checkout.currency = ?9
         AND NOT EXISTS (
           SELECT 1 FROM learner_access_grants AS existing
           WHERE existing.operation_id = ?6
         )
         AND NOT EXISTS (
           SELECT 1 FROM commerce_provider_events AS seen
           WHERE seen.provider_event_id = ?10
         )${covering}
       RETURNING id`,
    )
    .bind(...values);
}

function transitionStatement(
  database: SecurityDatabase,
  plan: SettlementPlan,
): D1PreparedStatement {
  const expected = plan.grants.length;
  const firstOpIndex = 5;
  const countIndex = firstOpIndex + expected;
  const eventIndex = countIndex + 1;
  // Predicated on the grants having landed *in this transaction*: a paid
  // checkout with no entitlement is unrepresentable, so a lost compare-and-swap
  // leaves the checkout exactly as it was - `pending`, not `paid`.
  return database
    .prepare(
      `UPDATE commerce_checkouts
       SET status = 'paid', paid_at = ?1, updated_at = ?1
       WHERE id = ?2
         AND status IN ('pending', 'expired', 'failed')
         AND total_minor = ?3
         AND currency = ?4
         AND (
           SELECT COUNT(*) FROM learner_access_grants
           WHERE operation_id IN (${idList(expected, firstOpIndex)})
             AND revoked_at IS NULL
         ) = ?${countIndex}
         AND NOT EXISTS (
           SELECT 1 FROM commerce_provider_events AS seen
           WHERE seen.provider_event_id = ?${eventIndex}
         )
       RETURNING id`,
    )
    .bind(
      plan.paidAt,
      plan.checkoutId,
      plan.amountMinor,
      plan.currency,
      ...plan.grants.map((grant) => grant.operationId),
      expected,
      plan.eventId,
    );
}

function receiptStatement(
  database: SecurityDatabase,
  plan: SettlementPlan,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO commerce_receipts (
         id, receipt_number, kind, checkout_id, refund_id, user_id,
         certification_id, currency, total_minor, lines_json, grants_json,
         provider, provider_ref, delivery, refund_window_ends_at, issued_at
       )
       SELECT ?1,
              'CP' || strftime('%Y%m%d', ?2 / 1000, 'unixepoch') || '-' ||
                upper(substr(replace(?1, '-', ''), 1, 12)),
              'purchase', checkout.id, NULL, checkout.user_id,
              checkout.certification_id, checkout.currency,
              checkout.total_minor, ?3, ?4, checkout.provider,
              checkout.provider_session_id, 'stored', ?2 + ?5, ?2
       FROM commerce_checkouts AS checkout
       WHERE checkout.id = ?6
         AND checkout.status = 'paid'
         AND checkout.paid_at = ?2
         AND NOT EXISTS (
           SELECT 1 FROM commerce_receipts AS issued
           WHERE issued.checkout_id = ?6 AND issued.kind = 'purchase'
         )
         AND NOT EXISTS (
           SELECT 1 FROM commerce_provider_events AS seen
           WHERE seen.provider_event_id = ?7
         )
       RETURNING id`,
    )
    .bind(
      crypto.randomUUID(),
      plan.paidAt,
      plan.linesJson,
      plan.grantsJson,
      refundWindowMs,
      plan.checkoutId,
      plan.eventId,
    );
}

function eventStatement(
  database: SecurityDatabase,
  plan: SettlementPlan,
): D1PreparedStatement {
  const expected = plan.grants.length;
  const firstOpIndex = 8;
  const countIndex = firstOpIndex + expected;
  const applied = `(SELECT status FROM commerce_checkouts WHERE id = ?3) = 'paid'
                   AND (
                     SELECT COUNT(*) FROM learner_access_grants
                     WHERE operation_id IN (${idList(expected, firstOpIndex)})
                       AND revoked_at IS NULL
                   ) = ?${countIndex}`;
  // "Settleable and still unapplied" is a lost compare-and-swap, not an
  // inconsistency: the event row is suppressed so this attempt writes nothing at
  // all and the retry can record the truth.
  const retryable = `EXISTS (
                       SELECT 1 FROM commerce_checkouts AS open
                       WHERE open.id = ?3
                         AND open.status IN ('pending', 'expired', 'failed')
                         AND open.total_minor = ?4
                         AND open.currency = ?5
                     )
                     AND (
                       SELECT COUNT(*) FROM learner_access_grants
                       WHERE operation_id IN (${idList(expected, firstOpIndex)})
                         AND revoked_at IS NULL
                     ) <> ?${countIndex}`;
  // Last, and its outcome is a function of what this transaction wrote.
  // `ON CONFLICT ... DO NOTHING` keeps a duplicate delivery from failing the
  // batch, and the `NOT EXISTS` above it keeps a duplicate delivery from writing
  // anything at all.
  return database
    .prepare(
      `INSERT INTO commerce_provider_events (
         provider_event_id, provider, kind, checkout_id, amount_minor, currency,
         occurred_at, received_at, outcome
       )
       SELECT ?1, ?2, 'checkout.completed', ?3, ?4, ?5, ?6, ?7,
              CASE WHEN ${applied}
                   THEN 'applied' ELSE 'ignored-inconsistent' END
       WHERE NOT EXISTS (
               SELECT 1 FROM commerce_provider_events AS seen
               WHERE seen.provider_event_id = ?1
             )
         AND NOT (${retryable})
       ON CONFLICT (provider_event_id) DO NOTHING
       RETURNING provider_event_id, outcome`,
    )
    .bind(
      plan.eventId,
      plan.provider,
      plan.checkoutId,
      plan.amountMinor,
      plan.currency,
      plan.occurredAt,
      plan.now,
      ...plan.grants.map((grant) => grant.operationId),
      expected,
    );
}

/**
 * The effect batch for one `checkout.completed`, as one transaction.
 *
 * Every statement but the event row requires the provider event id to be unseen,
 * so a duplicate delivery writes nothing. The event row is written last and its
 * `outcome` is read from the state this transaction produced.
 */
export async function applySettlement(
  database: SecurityDatabase,
  plan: SettlementPlan,
): Promise<SettlementWitness> {
  const labels: string[] = [];
  const statements: D1PreparedStatement[] = [];
  const standardGrant = plan.grants.find((grant) => grant.feature === "standard");
  const proGrant = plan.grants.find((grant) => grant.feature === "pro");

  // 1. Standard, then 2. Pro. 0013 reads the Standard row this batch wrote.
  if (standardGrant) {
    labels.push("grant:standard");
    statements.push(standardGrantStatement(database, plan, standardGrant));
  }
  if (proGrant) {
    labels.push("grant:pro");
    statements.push(
      proGrantStatement(
        database,
        plan,
        proGrant,
        standardGrant ? standardGrant.operationId : null,
      ),
    );
  }
  labels.push("transition");
  statements.push(transitionStatement(database, plan));
  labels.push("receipt");
  statements.push(receiptStatement(database, plan));
  labels.push("event");
  statements.push(eventStatement(database, plan));

  const results = await database.batch(statements);
  const byLabel = new Map<string, { results?: unknown[] }>();
  labels.forEach((label, index) => {
    byLabel.set(label, results[index] ?? {});
  });

  const eventRows = (byLabel.get("event")?.results ?? []) as {
    outcome: WebhookOutcome;
  }[];
  const granted = plan.grants.filter(
    (grant) => rowCount(byLabel.get(`grant:${grant.feature}`)) > 0,
  ).length;

  return {
    eventRecorded: eventRows.length === 1,
    outcome: eventRows[0]?.outcome ?? null,
    transitioned: rowCount(byLabel.get("transition")) > 0,
    granted,
    receiptIssued: rowCount(byLabel.get("receipt")) > 0,
    incomplete: granted < plan.grants.length,
  };
}

/** True when the event id is already in the provider ledger. */
export async function eventAlreadyRecorded(
  database: SecurityDatabase,
  eventId: string,
): Promise<boolean> {
  const row = await database
    .prepare(
      "SELECT provider_event_id FROM commerce_provider_events WHERE provider_event_id = ?",
    )
    .bind(eventId)
    .first<{ provider_event_id: string }>();
  return row !== null;
}

/** The outcome a previously recorded event carries, or null when it is unseen. */
async function recordedOutcome(
  database: SecurityDatabase,
  eventId: string,
): Promise<WebhookOutcome | null> {
  const row = await database
    .prepare(
      "SELECT outcome FROM commerce_provider_events WHERE provider_event_id = ?",
    )
    .bind(eventId)
    .first<{ outcome: WebhookOutcome }>();
  return row?.outcome ?? null;
}

/**
 * An authentic event for a checkout we do not know: another environment sharing
 * a secret, or a bug. Recorded, audited and answered `200` - retrying cannot fix
 * it, and a retry storm has a cost. `checkout_id` is NULL because the foreign key
 * must not point at a row that does not exist, and the audit row is keyed on the
 * event id so a redelivery cannot write a second one.
 */
async function recordUnknownCheckout(
  database: SecurityDatabase,
  event: ProviderEvent,
  providerName: string,
  now: number,
): Promise<WebhookResult> {
  const results = await database.batch([
    database
      .prepare(
        `INSERT INTO commerce_provider_events (
           provider_event_id, provider, kind, checkout_id, amount_minor,
           currency, occurred_at, received_at, outcome
         )
         SELECT ?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, 'ignored-unknown-checkout'
         WHERE NOT EXISTS (
           SELECT 1 FROM commerce_provider_events AS seen
           WHERE seen.provider_event_id = ?1
         )
         ON CONFLICT (provider_event_id) DO NOTHING
         RETURNING provider_event_id`,
      )
      .bind(
        event.eventId,
        providerName,
        event.kind,
        event.amountMinor,
        event.currency,
        event.occurredAt,
        now,
      ),
    database
      .prepare(
        `INSERT INTO audit_events (
           operation_id, actor_user_id, actor_ref, action, subject_type,
           subject_id, certification_id, reason, occurred_at
         )
         SELECT ?1, NULL, 'commerce-webhook', 'commerce_event_unknown_checkout',
                'commerce_provider_event', ?2, NULL, 'Unknown checkout', ?3
         WHERE NOT EXISTS (
           SELECT 1 FROM audit_events WHERE operation_id = ?1
         )`,
      )
      .bind(`commerce-event:${event.eventId}`, event.eventId, now),
  ]);

  return {
    ok: true,
    duplicate: rowCount(results[0]) === 0,
    outcome: "ignored-unknown-checkout",
  };
}

/**
 * `checkout.failed`: the provider reports no money. The checkout moves to
 * `failed` and nothing is granted, receipted or audited - a failed attempt is not
 * an access fact.
 */
async function applyFailure(
  database: SecurityDatabase,
  checkout: SettleableCheckout,
  event: ProviderEvent,
  providerName: string,
  now: number,
): Promise<WebhookResult> {
  const results = await database.batch([
    database
      .prepare(
        `UPDATE commerce_checkouts
         SET status = 'failed', updated_at = ?1
         WHERE id = ?2
           AND status = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM commerce_provider_events AS seen
             WHERE seen.provider_event_id = ?3
           )
         RETURNING id`,
      )
      .bind(now, checkout.id, event.eventId),
    database
      .prepare(
        `INSERT INTO commerce_provider_events (
           provider_event_id, provider, kind, checkout_id, amount_minor,
           currency, occurred_at, received_at, outcome
         )
         SELECT ?1, ?2, 'checkout.failed', ?3, ?4, ?5, ?6, ?7,
                CASE WHEN (
                  SELECT status FROM commerce_checkouts WHERE id = ?3
                ) = 'failed'
                     THEN 'applied' ELSE 'ignored-inconsistent' END
         WHERE NOT EXISTS (
           SELECT 1 FROM commerce_provider_events AS seen
           WHERE seen.provider_event_id = ?1
         )
         ON CONFLICT (provider_event_id) DO NOTHING
         RETURNING provider_event_id, outcome`,
      )
      .bind(
        event.eventId,
        providerName,
        checkout.id,
        event.amountMinor,
        event.currency,
        event.occurredAt,
        now,
      ),
  ]);
  const written = (results[1]?.results ?? []) as { outcome: WebhookOutcome }[];
  // The outcome reported is the one the row carries, never an assumption: a
  // `checkout.failed` for a checkout that was not `pending` writes
  // `ignored-inconsistent`, and answering `applied` for it would be a claim the
  // ledger contradicts.
  const outcome =
    written[0]?.outcome ?? (await recordedOutcome(database, event.eventId));
  if (outcome === null) {
    // Unreachable by construction - the insert either returned its row or the
    // `NOT EXISTS` / `ON CONFLICT` witness is an earlier row - but an unseen
    // event is not something to answer with a guess, so it fails closed.
    return { ok: false, status: 503, code: "provider_unavailable" };
  }
  return { ok: true, duplicate: written.length === 0, outcome };
}

/**
 * Close a settlement that could not be applied: record the event as
 * `ignored-inconsistent` and move the checkout to `needs_support` with the
 * instant we learned money moved.
 *
 * Both statuses settlement can arrive at are accepted by the transition trigger
 * (0019, widened in 0020): `pending -> needs_support`, `expired -> needs_support`
 * and `failed -> needs_support`. The second one matters - a late payment whose
 * amount disagrees, or whose Pro leg aborts, is a row our own expiry already closed. While that edge was illegal this batch
 * aborted and the webhook answered `503`, with the learner's money already taken;
 * what the provider saw next depended on the shape. A Pro leg that aborted rolled
 * the earlier settlement batch back, so no event row existed and every retry
 * repeated the `503`. An amount mismatch had already committed its event row as
 * `ignored-inconsistent`, so from the next delivery on the answer was
 * `200 {duplicate: true}` and the checkout stayed `expired` with `paid_at` NULL -
 * money recorded only in `commerce_provider_events`, outside the checkout-level
 * work queue.
 *
 * Nothing is granted and no receipt is issued. The learner is not granted an
 * entitlement they did not buy, and they are not silently refunded either - the
 * resolution policy is an owner decision, and these rows are its work queue.
 */
export async function markNeedsSupport(
  database: SecurityDatabase,
  checkout: SettleableCheckout,
  event: ProviderEvent,
  providerName: string,
  now: number,
  /**
   * True when the settlement batch already wrote this event row with
   * `ignored-inconsistent`. That row is this delivery, not an earlier one, so the
   * answer is `duplicate: false`.
   */
  eventRecordedByThisDelivery = false,
): Promise<WebhookResult> {
  const duplicate = eventRecordedByThisDelivery
    ? false
    : await eventAlreadyRecorded(database, event.eventId);
  const results = await database.batch([
    database
      .prepare(
        `UPDATE commerce_checkouts
         SET status = 'needs_support', paid_at = COALESCE(paid_at, ?1),
             updated_at = ?1
         WHERE id = ?2
           AND status IN ('pending', 'expired', 'failed')
         RETURNING id`,
      )
      .bind(now, checkout.id),
    database
      .prepare(
        `INSERT INTO commerce_provider_events (
           provider_event_id, provider, kind, checkout_id, amount_minor,
           currency, occurred_at, received_at, outcome
         )
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'ignored-inconsistent'
         WHERE NOT EXISTS (
           SELECT 1 FROM commerce_provider_events AS seen
           WHERE seen.provider_event_id = ?1
         )
         ON CONFLICT (provider_event_id) DO NOTHING
         RETURNING provider_event_id`,
      )
      .bind(
        event.eventId,
        providerName,
        event.kind,
        checkout.id,
        event.amountMinor,
        event.currency,
        event.occurredAt,
        now,
      ),
  ]);
  return {
    ok: true,
    duplicate,
    // The update may match nothing (an already `paid` or `failed` row) or the
    // event row may already exist; either way the answer to the provider is the
    // same, because retrying cannot fix a paid-but-unappliable purchase.
    outcome: "ignored-inconsistent",
  };
}

/** Build the plan for one attempt from a fresh read of the checkout and grants. */
export function buildSettlementPlan(
  checkout: SettleableCheckout,
  lines: readonly SnapshotLine[],
  grants: readonly AccessGrantRecord[],
  event: ProviderEvent,
  now: number,
): SettlementPlan {
  const windows = planSettlementWindows(grants, lines, now, checkout.id);
  return {
    checkoutId: checkout.id,
    eventId: event.eventId,
    provider: checkout.provider,
    amountMinor: event.amountMinor,
    currency: event.currency,
    occurredAt: event.occurredAt,
    now,
    // `paid_at` is written once. For a first settlement that is `now`; for a row
    // already paid it is the stored instant, so the receipt's refund window is
    // anchored on when the money moved rather than when we retried.
    paidAt: checkout.paid_at ?? now,
    source: windows.grants.length > 1 ? "bundle" : "purchase",
    grants: windows.grants,
    casToken: windows.casToken,
    casFallback: windows.casFallback,
    linesJson: JSON.stringify(
      lines.map((line) => ({
        sku: line.sku,
        label: line.label,
        amountMinor: line.amount_minor,
        feature: line.grants_feature,
        term: termOf(line),
      })),
    ),
    grantsJson: JSON.stringify(
      windows.grants.map((grant) => ({
        feature: grant.feature,
        startsAt: grant.startsAt,
        expiresAt: grant.expiresAt,
        operationId: grant.operationId,
      })),
    ),
  };
}

function isConstraintFailure(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return /constraint/i.test(message);
}

/**
 * Settle one authentic `checkout.completed`.
 *
 * The compare-and-swap is retried `settlementAttempts` times, re-reading coverage
 * between attempts: the Standard insert of each attempt writes nothing when
 * storage moved, so a retry cannot double-grant. Only when every attempt loses is
 * the checkout parked in `needs_support`, and by then nothing else was written.
 */
export async function settleCompletedEvent(
  database: SecurityDatabase,
  checkout: SettleableCheckout,
  event: ProviderEvent,
  now: number,
  /**
   * The pilot funnel recorder, or `null` when the server half is off. It is
   * called only after a settlement this delivery applied has committed, and it
   * cannot fail the settlement: the provider's answer is identical whether the
   * event row lands or is dropped.
   */
  events: PilotEventRecorder | null = null,
): Promise<WebhookResult> {
  const lines = await readSnapshotLines(database, checkout.id);
  for (let attempt = 1; attempt <= settlementAttempts; attempt += 1) {
    const current =
      attempt === 1 ? checkout : await readCheckoutById(database, checkout.id);
    if (!current) break;
    const grants = await readAccountGrants(
      database,
      current.user_id,
      current.certification_id,
    );
    const plan = buildSettlementPlan(current, lines, grants, event, now);
    let witness: SettlementWitness;
    try {
      witness = await applySettlement(database, plan);
    } catch (error) {
      if (!isConstraintFailure(error)) throw error;
      // A constraint aborted the batch, so nothing was written: no grant, no
      // paid checkout, no receipt, no event row. Access cannot be granted from
      // this shape - a second overlapping Pro window (0019) is the reachable
      // one - so the money is real and the entitlement is not.
      return markNeedsSupport(database, current, event, checkout.provider, now);
    }

    if (witness.eventRecorded) {
      if (witness.outcome === "applied") {
        // The purchase is durable at this point: the checkout is `paid`, the
        // grants are written and the receipt exists. Two deterministic ids -
        // `settlement:<providerEventId>` and `grant:<operationId>` - so a
        // replicated or replayed write collapses in storage even if this branch
        // runs twice.
        if (events) {
          await recordSafely(
            events,
            {
              name: "purchase_confirmed",
              checkoutId: current.id,
              productId: current.sku,
              currency: current.currency,
              amountMinor: plan.amountMinor,
              providerEventId: event.eventId,
              occurredAt: event.occurredAt,
            },
            now,
          );
          const proGrant = plan.grants.find(
            (grant) => grant.feature === "pro",
          );
          if (proGrant) {
            await recordSafely(
              events,
              {
                name: "pro_activated",
                checkoutId: current.id,
                productId: current.sku,
                certificationId: current.certification_id,
                grantOperationId: proGrant.operationId,
                occurredAt: now,
              },
              now,
            );
          }
        }
        return { ok: true, duplicate: false, outcome: "applied" };
      }
      return markNeedsSupport(
        database,
        current,
        event,
        checkout.provider,
        now,
        true,
      );
    }

    // No event row: either this event id was already recorded (a duplicate
    // delivery) or the compare-and-swap lost and the row was suppressed.
    if (await eventAlreadyRecorded(database, event.eventId)) {
      return { ok: true, duplicate: true, outcome: "applied" };
    }
    if (!witness.incomplete) break;
  }

  const latest = await readCheckoutById(database, checkout.id);
  if (
    latest &&
    (latest.status === "pending" ||
      latest.status === "expired" ||
      latest.status === "failed")
  ) {
    return markNeedsSupport(database, latest, event, checkout.provider, now);
  }
  return { ok: true, duplicate: true, outcome: "applied" };
}

/**
 * The one write path for a provider event.
 *
 * The route and the local dev seam both call this; there is no second door. The
 * caller has already read the raw body (with a size cap) and resolved the
 * provider from its own configuration.
 */
export async function handleProviderWebhook(
  database: SecurityDatabase,
  provider: PaymentProvider,
  input: {
    /** The `:provider` path segment, matched against `provider.name`. */
    providerName: string;
    rawBody: string;
    headers: Headers;
    now: number;
    /** The pilot funnel recorder, or `null`/absent when it is off. */
    events?: PilotEventRecorder | null;
  },
): Promise<WebhookResult> {
  if (input.providerName !== provider.name) {
    return { ok: false, status: 404, code: "unknown_provider" };
  }
  const verified = await provider.verifyEvent(
    input.rawBody,
    input.headers,
    input.now,
  );
  if (!verified.ok) {
    // `stale` is an authenticity failure, not a malformed body: the signature
    // was valid and outside the replay window, so it is answered like a bad
    // signature rather than inviting a retry of the same body.
    return verified.reason === "malformed"
      ? { ok: false, status: 400, code: "malformed_event" }
      : { ok: false, status: 401, code: "invalid_signature" };
  }
  const event = verified.event;

  // Everything below reads or writes storage. An unexpected error here - D1
  // unavailable, a missing table, a bug in a plan - is retryable and is answered
  // `503 provider_unavailable`, never a 5xx: the effect batch is one transaction,
  // so a failure before it commits wrote nothing, and a provider that retries the
  // same event is exactly the recovery we want. Nothing is logged or echoed: the
  // raw body, the signature header and the event id stay inside this call, so a
  // storage error cannot leak them into a log or a response.
  //
  // Every storage call below is `await`ed, and that is load-bearing: `return
  // somePromise` inside a `try` hands the rejection past the `catch`, because the
  // block only sees a rejection it awaited.
  try {
    // The duplicate fast path, before any write. The constraints below are the
    // race-safe backstop, not the only check.
    if (await eventAlreadyRecorded(database, event.eventId)) {
      return { ok: true, duplicate: true, outcome: "applied" };
    }

    const checkout = await readCheckoutForSession(
      database,
      input.providerName,
      event.sessionRef,
    );
    if (!checkout) {
      return await recordUnknownCheckout(
        database,
        event,
        input.providerName,
        input.now,
      );
    }
    if (event.kind === "checkout.failed") {
      return await applyFailure(
        database,
        checkout,
        event,
        input.providerName,
        input.now,
      );
    }
    return await settleCompletedEvent(
      database,
      checkout,
      event,
      input.now,
      input.events ?? null,
    );
  } catch {
    return { ok: false, status: 503, code: "provider_unavailable" };
  }
}

/**
 * Build a signed `checkout.completed` body for a stored checkout, for the
 * local-only dev seam. It grants nothing by itself: the caller dispatches the
 * result through `handleProviderWebhook`, exactly as the route does.
 */
export async function buildFakeCompletedEvent(
  database: SecurityDatabase,
  provider: FakePaymentProvider,
  input: { userId: string; checkoutId: string; now: number },
): Promise<{ rawBody: string; headers: Headers } | null> {
  const checkout = await database
    .prepare(
      `SELECT ${checkoutColumns} FROM commerce_checkouts
       WHERE id = ? AND user_id = ?`,
    )
    .bind(input.checkoutId, input.userId)
    .first<SettleableCheckout>();
  if (!checkout || checkout.provider_session_id === null) return null;
  const event: ProviderEvent = {
    // Deterministic, so pressing the button twice is a duplicate rather than a
    // second settlement: the same property a real provider gives an event.
    eventId: `fake_completed:${checkout.id}`,
    kind: "checkout.completed",
    sessionRef: checkout.provider_session_id,
    checkoutId: checkout.id,
    amountMinor: checkout.total_minor,
    currency: checkout.currency,
    occurredAt: input.now,
  };
  const rawBody = JSON.stringify(event);
  const signed = await provider.signEvent(event, Math.floor(input.now / 1000));
  return { rawBody, headers: new Headers(signed) };
}
