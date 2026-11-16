import type {
  CommerceRefundResponse,
  CommerceRefundRevokedGrant,
  CommerceSku,
} from "@certpath/contracts";
import { refundWindowMs } from "../pricing.ts";
import type {
  D1PreparedStatement,
  SecurityDatabase,
} from "../security/database.ts";
import { grantOperationId } from "./checkouts.ts";
import type { PaymentProvider } from "./provider.ts";
import { readSnapshotLines, termOf } from "./webhooks.ts";

// Refunds: the decision, the provider call, and the revocation.
//
// A refund is two transactions with a provider call between them, and the ledger
// decides, not the provider. Batch 1 records the **decision** - the refund row
// plus one line per checkout - while the one-per-exam index, the "inside the
// stored window" rule and the "paid checkout of this learner, this exam, this
// currency, this exact amount" rule all bite. Then `provider.refund` is called
// with our refund id as its idempotency key. Then batch 2 does what has to be one
// atomic act: revoke **Pro before Standard**, settle the refund under a
// compare-and-swap, move each checkout to `refunded` (which storage refuses unless
// a settled refund names it), and write one refund receipt per checkout (which
// storage refuses unless the refund is settled and the amount agrees).
//
// The refund unit is the **entitlement**, which can be two checkouts: revoking the
// Standard grant that is a Pro grant's only cover aborts at 0014, so a dependent
// Pro checkout is refunded in the same record rather than refused. The expansion
// is legal because a purchase-written grant can never start before its own
// `paid_at`; the runtime re-checks the arithmetic and refuses `409` if it ever
// breaks.
//
// That check runs **again** at settle time, and there it can only refuse. A
// purchase that lands while the provider is being called cannot be added to the
// refund - the lines are immutable and the provider has already been told the
// amount - so a set that no longer passes the guard leaves the refund `requested`,
// every grant intact and the answer `503`. Money returned with access retained is
// the fail-closed direction; the operator resolves the ledger.
//
// A refund revokes rather than expires, so `evaluateAccess` filters the grant out
// and the learner is locked with no grace - ADR 0005's grace is defined for the
// expiry of a grant that is still there.
//
// Rules: docs/commerce-refunds.md, docs/decisions/0003-pricing-pro-and-refunds.md.

/** The planner refuses a set larger than this, and 0020's line bound allows it. */
export const maxRefundCheckouts = 2;

/** How many times a lost settle compare-and-swap is retried before `503`. */
export const refundSettlementAttempts = 3;

/** How many expansion rounds the planner runs before refusing. */
const maxExpansionRounds = 3;

const proSuffix = ":pro";
const standardSuffix = ":standard";

export interface RefundCheckoutRow {
  id: string;
  user_id: string;
  certification_id: string;
  sku: string;
  currency: string;
  total_minor: number;
  status: string;
  paid_at: number | null;
  provider: string;
  provider_session_id: string | null;
}

export interface RefundRow {
  id: string;
  user_id: string;
  certification_id: string;
  requested_by_user_id: string;
  status: "requested" | "settled" | "failed";
  currency: string;
  amount_minor: number;
  reason: string;
  operation_id: string;
  provider: string;
  provider_refund_id: string | null;
  requested_at: number;
  settled_at: number | null;
}

interface GrantRow {
  id: string;
  feature: "standard" | "pro";
  starts_at: number;
  expires_at: number;
  revoked_at: number | null;
  source: string | null;
  operation_id: string | null;
}

interface RefundLineRow {
  position: number;
  checkout_id: string;
  amount_minor: number;
  window_ends_at: number;
  sku: string;
}

/** One checkout in the refund set, and why it is there. */
export interface PlannedRefundCheckout {
  checkout: RefundCheckoutRow;
  includedBecause: "requested" | "dependent-pro";
}

/** One grant the refund will revoke. Ordering is Pro first, then Standard. */
export interface PlannedRevocation {
  grantId: string;
  feature: "standard" | "pro";
  checkoutId: string;
  startsAt: number;
  expiresAt: number;
}

export interface RefundPlan {
  checkouts: readonly PlannedRefundCheckout[];
  revocations: readonly PlannedRevocation[];
  /** Non-revoked Standard grants that remain after this refund's revocations. */
  remainingStandardCount: number;
}

export type RefundPlanFailure = "requires-support";

export type RefundRequestResult =
  | { ok: true; status: 200 | 202; value: CommerceRefundResponse }
  | { ok: false; failure: RefundFailure };

export type RefundFailure =
  | { code: "checkout-not-found" }
  | { code: "refund-not-allowed" }
  | { code: "refund-window-closed" }
  | { code: "refund-already-used" }
  | { code: "refund-requires-support" }
  | { code: "refund-rejected" }
  | { code: "provider-unavailable" };

const checkoutColumns = `id, user_id, certification_id, sku, currency,
                         total_minor, status, paid_at, provider,
                         provider_session_id`;

const refundColumns = `id, user_id, certification_id, requested_by_user_id,
                       status, currency, amount_minor, reason, operation_id,
                       provider, provider_refund_id, requested_at, settled_at`;

export async function readRefundCheckout(
  database: SecurityDatabase,
  checkoutId: string,
  userId: string,
): Promise<RefundCheckoutRow | null> {
  return database
    .prepare(
      `SELECT ${checkoutColumns} FROM commerce_checkouts
       WHERE id = ? AND user_id = ?`,
    )
    .bind(checkoutId, userId)
    .first<RefundCheckoutRow>();
}

async function readCheckoutsByIds(
  database: SecurityDatabase,
  ids: readonly string[],
): Promise<Map<string, RefundCheckoutRow>> {
  const map = new Map<string, RefundCheckoutRow>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await database
    .prepare(
      `SELECT ${checkoutColumns} FROM commerce_checkouts
       WHERE id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<RefundCheckoutRow>();
  for (const row of rows.results) map.set(row.id, row);
  return map;
}

async function readGrants(
  database: SecurityDatabase,
  userId: string,
  certificationId: string,
): Promise<GrantRow[]> {
  const rows = await database
    .prepare(
      `SELECT id, feature, starts_at, expires_at, revoked_at, source, operation_id
       FROM learner_access_grants
       WHERE user_id = ? AND certification_id = ?
       ORDER BY rowid`,
    )
    .bind(userId, certificationId)
    .all<GrantRow>();
  return rows.results;
}

/** The refund that names this checkout with the given status, if any. */
export async function readRefundForCheckout(
  database: SecurityDatabase,
  checkoutId: string,
  status: "requested" | "settled",
): Promise<RefundRow | null> {
  return database
    .prepare(
      `SELECT ${refundColumns.split(",").map((c) => `refund.${c.trim()}`).join(", ")}
       FROM commerce_refund_lines AS line
       JOIN commerce_refunds AS refund ON refund.id = line.refund_id
       WHERE line.checkout_id = ? AND refund.status = ?
       ORDER BY refund.requested_at DESC, refund.id DESC
       LIMIT 1`,
    )
    .bind(checkoutId, status)
    .first<RefundRow>();
}

export async function readRefundById(
  database: SecurityDatabase,
  refundId: string,
): Promise<RefundRow | null> {
  return database
    .prepare(`SELECT ${refundColumns} FROM commerce_refunds WHERE id = ?`)
    .bind(refundId)
    .first<RefundRow>();
}

async function readRefundLines(
  database: SecurityDatabase,
  refundId: string,
): Promise<RefundLineRow[]> {
  const rows = await database
    .prepare(
      `SELECT line.position, line.checkout_id, line.amount_minor,
              line.window_ends_at, checkout.sku
       FROM commerce_refund_lines AS line
       JOIN commerce_checkouts AS checkout ON checkout.id = line.checkout_id
       WHERE line.refund_id = ?
       ORDER BY line.position`,
    )
    .bind(refundId)
    .all<RefundLineRow>();
  return rows.results;
}

/**
 * Any non-`failed` refund for this (account, exam), whoever requested it.
 *
 * `requested_by_user_id` is deliberately **not** filtered, unlike the partial
 * index: a staff-requested row is still a refund of this exam, and two payouts
 * for one entitlement is the error we cannot undo, so a Phase 5 staff refund
 * blocking the learner's self-serve one is the fail-closed direction. When the
 * staff route lands this predicate needs the same `requested_by_user_id`
 * narrowing the index already has, or the learner must be told support is
 * handling it. Phase 5 follow-up, recorded so it is not discovered by surprise.
 */
async function anotherRefundForExam(
  database: SecurityDatabase,
  userId: string,
  certificationId: string,
): Promise<{ id: string } | null> {
  return database
    .prepare(
      `SELECT id FROM commerce_refunds
       WHERE user_id = ? AND certification_id = ? AND status <> 'failed'
       LIMIT 1`,
    )
    .bind(userId, certificationId)
    .first<{ id: string }>();
}

/**
 * The grants this refund set revokes: exactly the rows the refunded checkouts
 * granted, by operation id.
 *
 * Defined by operation id and never by "live at now": a clock-dependent set would
 * make the same refund revoke different rows on a retry. A grant that has already
 * expired or has not started is still revoked - it is the record - while a grant
 * that is already revoked is not (0014 forbids a second revocation, and the
 * settle count would never match).
 */
function splitRevocations(
  grants: readonly GrantRow[],
  checkouts: readonly RefundCheckoutRow[],
): { pro: GrantRow[]; standard: GrantRow[] } | null {
  const live = new Map<string, GrantRow>();
  for (const grant of grants) {
    if (grant.revoked_at !== null || grant.operation_id === null) continue;
    live.set(grant.operation_id, grant);
  }
  // A checkout's grant is one settlement wrote. A live row claiming a checkout's
  // operation id without a purchase source did not come from money, so it may not
  // be revoked as if it had - and the planner refuses rather than guessing which
  // of the two the learner meant.
  const fromMoney = (grant: GrantRow): boolean =>
    grant.source === "purchase" || grant.source === "bundle";
  const pro: GrantRow[] = [];
  const standard: GrantRow[] = [];
  for (const checkout of checkouts) {
    const proGrant = live.get(grantOperationId(checkout.id, "pro"));
    if (proGrant) {
      // A mis-pointed operation id would revoke the wrong feature; fail closed.
      if (proGrant.feature !== "pro" || !fromMoney(proGrant)) return null;
      pro.push(proGrant);
    }
    const standardGrant = live.get(grantOperationId(checkout.id, "standard"));
    if (standardGrant) {
      if (standardGrant.feature !== "standard" || !fromMoney(standardGrant)) {
        return null;
      }
      standard.push(standardGrant);
    }
  }
  return { pro, standard };
}

/**
 * The refund set: the named checkout plus every Pro purchase whose only Standard
 * cover is about to be revoked, and the guards that refuse rather than act.
 *
 * `requires-support` covers three shapes that must never be a side effect of a
 * learner's self-serve action: a staff-granted Pro (`source = 'grant'`, or an
 * operation id that is not a checkout's `:pro`), a dependent checkout that is not
 * `paid`, and a dependent checkout outside its own seven-day window. The lemma
 * says the last cannot happen while the named refund is legal; if it does, the
 * arithmetic is broken and refusing is the fail-closed answer.
 *
 * The coverage-gap guard (owner decision, 2026-11-16) refuses a refund that would
 * leave the learner with future-but-not-present Standard coverage. Every Standard
 * purchase appends to the latest end, so a gap cannot be bought back: granting it
 * would leave a paying learner locked out with no purchasable route to access
 * until the later window starts.
 */
export async function planRefundSet(
  database: SecurityDatabase,
  named: RefundCheckoutRow,
  now: number,
): Promise<
  { ok: true; plan: RefundPlan } | { ok: false; reason: RefundPlanFailure }
> {
  if (named.paid_at === null || named.provider_session_id === null) {
    return { ok: false, reason: "requires-support" };
  }
  const grants = await readGrants(
    database,
    named.user_id,
    named.certification_id,
  );
  const set: RefundCheckoutRow[] = [named];
  const inSet = new Set<string>([named.id]);

  for (let round = 0; round < maxExpansionRounds; round += 1) {
    const split = splitRevocations(grants, set);
    if (!split) return { ok: false, reason: "requires-support" };
    const revokedIds = new Set(
      [...split.pro, ...split.standard].map((grant) => grant.id),
    );
    // 0014's predicate, verbatim: a Pro grant is at risk when no Standard grant
    // outside this refund's revoke set covers its whole window.
    const atRisk = grants.filter(
      (grant) =>
        grant.feature === "pro" &&
        grant.revoked_at === null &&
        !revokedIds.has(grant.id) &&
        !grants.some(
          (cover) =>
            cover.feature === "standard" &&
            cover.revoked_at === null &&
            !revokedIds.has(cover.id) &&
            cover.starts_at <= grant.starts_at &&
            cover.expires_at >= grant.expires_at,
        ),
    );
    const companions: string[] = [];
    for (const grant of atRisk) {
      // Provenance, not identity: a grant we cannot refund money for may not be
      // cancelled by a learner's self-serve action.
      if (grant.source !== "purchase" && grant.source !== "bundle") {
        return { ok: false, reason: "requires-support" };
      }
      if (!grant.operation_id?.endsWith(proSuffix)) {
        return { ok: false, reason: "requires-support" };
      }
      const checkoutId = grant.operation_id.slice(0, -proSuffix.length);
      if (!inSet.has(checkoutId)) companions.push(checkoutId);
    }
    if (companions.length === 0) break;

    const rows = await readCheckoutsByIds(database, companions);
    for (const checkoutId of companions) {
      const companion = rows.get(checkoutId);
      if (
        !companion ||
        companion.status !== "paid" ||
        companion.paid_at === null ||
        companion.provider_session_id === null ||
        companion.user_id !== named.user_id ||
        companion.certification_id !== named.certification_id ||
        now >= companion.paid_at + refundWindowMs
      ) {
        return { ok: false, reason: "requires-support" };
      }
      set.push(companion);
      inSet.add(companion.id);
      if (set.length > maxRefundCheckouts) {
        // The lemma bounds the set at two. A third means the arithmetic broke.
        return { ok: false, reason: "requires-support" };
      }
    }
  }

  const split = splitRevocations(grants, set);
  if (!split) return { ok: false, reason: "requires-support" };
  const revokedIds = new Set(
    [...split.pro, ...split.standard].map((grant) => grant.id),
  );
  const remainingStandard = grants.filter(
    (grant) =>
      grant.feature === "standard" &&
      grant.revoked_at === null &&
      !revokedIds.has(grant.id),
  );
  const liveAtNow = remainingStandard.some(
    (grant) => grant.starts_at <= now && now < grant.expires_at,
  );
  const startsInFuture = remainingStandard.some(
    (grant) => grant.starts_at > now,
  );
  if (!liveAtNow && startsInFuture) {
    return { ok: false, reason: "requires-support" };
  }

  const revocations: PlannedRevocation[] = [];
  const push = (
    grant: GrantRow,
    checkoutId: string,
  ): void => {
    revocations.push({
      grantId: grant.id,
      feature: grant.feature,
      checkoutId,
      startsAt: grant.starts_at,
      expiresAt: grant.expires_at,
    });
  };
  for (const grant of split.pro) {
    push(grant, checkoutIdOf(grant, proSuffix));
  }
  for (const grant of split.standard) {
    push(grant, checkoutIdOf(grant, standardSuffix));
  }
  if (revocations.length === 0) {
    // A paid checkout always granted something; no revocable rows means the
    // ledger and the grants disagree, so nothing is refunded.
    return { ok: false, reason: "requires-support" };
  }

  return {
    ok: true,
    plan: {
      checkouts: set.map((checkout) => ({
        checkout,
        includedBecause:
          checkout.id === named.id ? "requested" : "dependent-pro",
      })),
      revocations,
      remainingStandardCount: remainingStandard.length,
    },
  };
}

function checkoutIdOf(grant: GrantRow, suffix: string): string {
  return (grant.operation_id ?? "").slice(0, -suffix.length);
}

/** A provider request built from the stored plan, never from the request body. */
function providerRequest(
  refundId: string,
  currency: string,
  checkouts: readonly RefundCheckoutRow[],
  totalMinor: number,
  reason: string,
) {
  return {
    refundId,
    payments: checkouts.map((checkout) => ({
      sessionRef: checkout.provider_session_id ?? "",
      amountMinor: checkout.total_minor,
    })),
    totalMinor,
    currency,
    reason,
  };
}

/**
 * Request a self-serve refund for one checkout.
 *
 * No writes happen in the first six steps: a replay, a resume, an ineligible
 * checkout and an unplannable set are all decided by reading. Batch 1 is the
 * first write, and it happens before the provider is called, so a crash between
 * the two leaves a `requested` row the next call resumes with the same refund id.
 */
export async function requestRefund(
  database: SecurityDatabase,
  provider: PaymentProvider,
  input: {
    userId: string;
    checkoutId: string;
    reason: string;
    now: number;
  },
): Promise<RefundRequestResult> {
  const named = await readRefundCheckout(
    database,
    input.checkoutId,
    input.userId,
  );
  if (!named) return { ok: false, failure: { code: "checkout-not-found" } };

  // 2. A settled refund replays from storage and never calls the provider again.
  const settled = await readRefundForCheckout(database, named.id, "settled");
  if (settled) {
    const value = await projectSettledRefund(database, settled);
    return value === null
      ? { ok: false, failure: { code: "provider-unavailable" } }
      : { ok: true, status: 200, value };
  }

  // 3. A requested refund is resumed: the provider is called again with the same
  //    idempotency key, because a timeout is an unknown outcome and only the
  //    provider can resolve it. The window is not re-checked - the decision was
  //    taken inside it.
  const requested = await readRefundForCheckout(database, named.id, "requested");
  if (requested) {
    return completeRefund(database, provider, requested, input.now);
  }

  // 4. Eligibility.
  if (named.status !== "paid" || named.paid_at === null) {
    return { ok: false, failure: { code: "refund-not-allowed" } };
  }
  if (input.now >= named.paid_at + refundWindowMs) {
    return { ok: false, failure: { code: "refund-window-closed" } };
  }
  if (
    await anotherRefundForExam(database, named.user_id, named.certification_id)
  ) {
    return { ok: false, failure: { code: "refund-already-used" } };
  }

  // 5. Plan the set, including the expansion and the coverage-gap guard.
  const planned = await planRefundSet(database, named, input.now);
  if (!planned.ok) {
    return { ok: false, failure: { code: "refund-requires-support" } };
  }
  const checkouts = planned.plan.checkouts.map((entry) => entry.checkout);
  const totalMinor = checkouts.reduce(
    (sum, checkout) => sum + checkout.total_minor,
    0,
  );
  const refundId = `rfd_${crypto.randomUUID()}`;

  // 6. Batch 1 records the decision. The one-per-exam index is the witness that
  //    no second self-serve refund exists for this exam, and the line rules make
  //    "a pending checkout" or "a partial amount" unrepresentable.
  try {
    const statements: D1PreparedStatement[] = [
      database
        .prepare(
          `INSERT INTO commerce_refunds (
             id, user_id, certification_id, requested_by_user_id, status,
             currency, amount_minor, reason, operation_id, provider,
             provider_refund_id, requested_at, settled_at)
           VALUES (?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, NULL, ?, NULL)
           RETURNING id`,
        )
        .bind(
          refundId,
          named.user_id,
          named.certification_id,
          named.user_id,
          named.currency,
          totalMinor,
          input.reason,
          `refund:${refundId}`,
          provider.name,
          input.now,
        ),
    ];
    checkouts.forEach((checkout, position) => {
      statements.push(
        database
          .prepare(
            `INSERT INTO commerce_refund_lines (
               refund_id, position, checkout_id, amount_minor, window_ends_at)
             SELECT ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM commerce_refunds WHERE id = ?)
             RETURNING refund_id`,
          )
          .bind(
            refundId,
            position,
            checkout.id,
            checkout.total_minor,
            (checkout.paid_at ?? 0) + refundWindowMs,
            refundId,
          ),
      );
    });
    await database.batch(statements);
  } catch (error) {
    if (!isConstraintFailure(error)) throw error;
    // The loser of a race: either this checkout's refund already exists (replay
    // or resume) or another checkout for the exam won the cap.
    const raced =
      (await readRefundForCheckout(database, named.id, "settled")) ??
      (await readRefundForCheckout(database, named.id, "requested"));
    if (raced?.status === "settled") {
      const value = await projectSettledRefund(database, raced);
      return value === null
        ? { ok: false, failure: { code: "provider-unavailable" } }
        : { ok: true, status: 200, value };
    }
    if (raced?.status === "requested") {
      return completeRefund(database, provider, raced, input.now);
    }
    if (
      await anotherRefundForExam(database, named.user_id, named.certification_id)
    ) {
      return { ok: false, failure: { code: "refund-already-used" } };
    }
    return { ok: false, failure: { code: "provider-unavailable" } };
  }

  // 7. The provider call, outside any transaction. Our refund id is the
  //    idempotency key, so a retry cannot move money twice.
  return settleWithProvider(
    database,
    provider,
    {
      refundId,
      userId: named.user_id,
      certificationId: named.certification_id,
    },
    checkouts,
    totalMinor,
    named.currency,
    input.reason,
    input.now,
  );
}

/** Resume a `requested` refund: same id, same idempotency key, same payments. */
async function completeRefund(
  database: SecurityDatabase,
  provider: PaymentProvider,
  refund: RefundRow,
  now: number,
): Promise<RefundRequestResult> {
  const lines = await readRefundLines(database, refund.id);
  const rows = await readCheckoutsByIds(
    database,
    lines.map((line) => line.checkout_id),
  );
  const checkouts: RefundCheckoutRow[] = [];
  for (const line of lines) {
    const checkout = rows.get(line.checkout_id);
    if (!checkout) return { ok: false, failure: { code: "provider-unavailable" } };
    checkouts.push(checkout);
  }
  return settleWithProvider(
    database,
    provider,
    {
      refundId: refund.id,
      userId: refund.user_id,
      certificationId: refund.certification_id,
    },
    checkouts,
    refund.amount_minor,
    refund.currency,
    refund.reason,
    now,
  );
}

async function settleWithProvider(
  database: SecurityDatabase,
  provider: PaymentProvider,
  identity: { refundId: string; userId: string; certificationId: string },
  checkouts: readonly RefundCheckoutRow[],
  totalMinor: number,
  currency: string,
  reason: string,
  now: number,
): Promise<RefundRequestResult> {
  let outcome;
  try {
    outcome = await provider.refund(
      providerRequest(identity.refundId, currency, checkouts, totalMinor, reason),
    );
  } catch {
    // A timeout is an unknown outcome, not a failure: the refund stays
    // `requested`, access stays live, and the client retries the same refund id.
    // Losing access without money returning is the worse error.
    const pending = await readRefundById(database, identity.refundId);
    if (!pending) {
      return { ok: false, failure: { code: "provider-unavailable" } };
    }
    return {
      ok: true,
      status: 202,
      value: await projectPendingRefund(database, pending),
    };
  }

  if (outcome.status !== "succeeded") {
    // Nothing was revoked, nothing settled, no receipt, no checkout change. The
    // cap is not consumed (the index excludes `failed`), so a retry is a new
    // refund row.
    await database
      .prepare(
        `UPDATE commerce_refunds SET status = 'failed'
         WHERE id = ? AND status = 'requested'
         RETURNING id`,
      )
      .bind(identity.refundId)
      .run();
    return {
      ok: false,
      failure: {
        code:
          outcome.status === "rejected"
            ? "refund-rejected"
            : "provider-unavailable",
      },
    };
  }

  const settled = await settleRefund(
    database,
    identity,
    checkouts,
    outcome.refundRef,
    now,
  );
  if (!settled) {
    // A second request can settle this refund while ours loses every
    // compare-and-swap: a double submit, two tabs, a retried request. The batch
    // then cannot match a `requested` row, because the refund is already
    // `settled`. Answering `503 provider_unavailable` for a refund that succeeded
    // is a lie, so the re-read decides: a settled refund is projected exactly as
    // a replay would be, and only an unsettled one is an outage.
    const raced = await readRefundById(database, identity.refundId);
    if (raced?.status === "settled") {
      const value = await projectSettledRefund(database, raced);
      return value === null
        ? { ok: false, failure: { code: "provider-unavailable" } }
        : { ok: true, status: 200, value };
    }
    return { ok: false, failure: { code: "provider-unavailable" } };
  }
  const refund = await readRefundById(database, identity.refundId);
  if (!refund) return { ok: false, failure: { code: "provider-unavailable" } };
  const value = await projectSettledRefund(database, refund);
  return value === null
    ? { ok: false, failure: { code: "provider-unavailable" } }
    : { ok: true, status: 200, value };
}

interface RefundReceiptInput {
  checkout: RefundCheckoutRow;
  totalMinor: number;
  linesJson: string;
  grantsJson: string;
}

export interface RefundSettlementPlan {
  refundId: string;
  userId: string;
  certificationId: string;
  settledAt: number;
  providerRefundId: string;
  /** Pro first, then Standard, then `startsAt`. */
  revocations: readonly PlannedRevocation[];
  remainingStandardCount: number;
  checkouts: readonly string[];
  receipts: readonly RefundReceiptInput[];
}

/**
 * Batch 2, as one transaction.
 *
 * Order, and why not another:
 *
 *   1. Pro revocations, then 2. Standard revocations, because
 *      `learner_access_grants_revoke_keeps_pro_covered` (0014) aborts a Standard
 *      revocation that would leave a live Pro uncovered.
 *   3. The settle compare-and-swap counts the revocations this transaction wrote
 *      and the Standard rows that remain, so a revocation that matched nothing -
 *      already revoked, wrong id - leaves the refund `requested`.
 *   4. The `refunded` transition, after 3, because
 *      `commerce_checkouts_refunded_requires_settled_refund` aborts without a
 *      settled refund. A lost settle therefore fails the whole batch instead of
 *      committing a refunded checkout with live access.
 *   5. The refund receipt, after 3, because #79's trigger aborts a receipt whose
 *      refund is not settled or whose total disagrees with its line.
 *
 * Every statement returns its row and the caller counts rows, never
 * `meta.changes`: `learner_access_grants` has an AFTER INSERT audit trigger, so
 * `changes` counts the audit row too.
 *
 * All four witnesses (settled, revoked, checkouts, receipts) are returned, and
 * `settleRefund` compares each to the plan it executed. A count that is short is
 * not cosmetic - and it is a tripwire rather than a rollback: this batch has
 * already committed by the time the caller compares counts, so a short count can
 * only make the caller refuse to answer `200`. The shape that used to rely on the
 * count alone is now unreachable: statement 4 filters `status = 'paid'`, so a
 * checkout that is `pending` or `needs_support` when the batch runs matches zero
 * rows and fires no trigger there, and
 * `commerce_refunds_settle_requires_paid_checkouts` (0020) aborts the batch one
 * statement earlier, at the settle, for exactly that reason.
 */
export async function applyRefundSettlement(
  database: SecurityDatabase,
  plan: RefundSettlementPlan,
): Promise<{
  settled: boolean;
  revoked: number;
  checkouts: number;
  receipts: number;
}> {
  const statements: D1PreparedStatement[] = [];
  const labels: string[] = [];

  const revoke = (revocation: PlannedRevocation): D1PreparedStatement =>
    database
      .prepare(
        `UPDATE learner_access_grants
         SET revoked_at = ?, revocation_operation_id = ?, revoked_by_user_id = ?
         WHERE id = ? AND revoked_at IS NULL
         RETURNING id`,
      )
      .bind(
        plan.settledAt,
        `refund:${plan.refundId}:${revocation.grantId}`,
        plan.userId,
        revocation.grantId,
      );

  for (const revocation of plan.revocations) {
    if (revocation.feature !== "pro") continue;
    labels.push("revoke:pro");
    statements.push(revoke(revocation));
  }
  for (const revocation of plan.revocations) {
    if (revocation.feature !== "standard") continue;
    labels.push("revoke:standard");
    statements.push(revoke(revocation));
  }

  const revocationIds = plan.revocations.map(
    (revocation) => `refund:${plan.refundId}:${revocation.grantId}`,
  );
  const idPlaceholders = revocationIds.map(() => "?").join(", ");
  labels.push("settle");
  statements.push(
    database
      .prepare(
        `UPDATE commerce_refunds
         SET status = 'settled', settled_at = ?, provider_refund_id = ?
         WHERE id = ?
           AND status = 'requested'
           AND amount_minor = (
             SELECT COALESCE(SUM(amount_minor), 0)
             FROM commerce_refund_lines WHERE refund_id = ?
           )
           AND (
             SELECT COUNT(*) FROM learner_access_grants
             WHERE revocation_operation_id IN (${idPlaceholders})
           ) = ?
           AND (
             SELECT COUNT(*) FROM learner_access_grants
             WHERE user_id = ? AND certification_id = ?
               AND feature = 'standard' AND revoked_at IS NULL
           ) = ?
         RETURNING id`,
      )
      .bind(
        plan.settledAt,
        plan.providerRefundId,
        plan.refundId,
        plan.refundId,
        ...revocationIds,
        plan.revocations.length,
        plan.userId,
        plan.certificationId,
        plan.remainingStandardCount,
      ),
  );

  for (const checkoutId of plan.checkouts) {
    labels.push("checkout");
    statements.push(
      database
        .prepare(
          `UPDATE commerce_checkouts
           SET status = 'refunded', updated_at = ?
           WHERE id = ? AND status = 'paid'
           RETURNING id`,
        )
        .bind(plan.settledAt, checkoutId),
    );
  }

  for (const receipt of plan.receipts) {
    labels.push("receipt");
    statements.push(
      database
        .prepare(
          `INSERT INTO commerce_receipts (
             id, receipt_number, kind, checkout_id, refund_id, user_id,
             certification_id, currency, total_minor, lines_json, grants_json,
             provider, provider_ref, delivery, refund_window_ends_at, issued_at)
           SELECT ?, 'CP' || strftime('%Y%m%d', ? / 1000, 'unixepoch') || '-' ||
                     upper(substr(replace(?, '-', ''), 1, 12)),
                  'refund', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stored', NULL, ?
           WHERE EXISTS (
                   SELECT 1 FROM commerce_refunds
                   WHERE id = ? AND status = 'settled'
                 )
             AND NOT EXISTS (
                   SELECT 1 FROM commerce_receipts
                   WHERE checkout_id = ? AND kind = 'refund'
                 )
           RETURNING id`,
        )
        .bind(
          crypto.randomUUID(),
          plan.settledAt,
          crypto.randomUUID(),
          receipt.checkout.id,
          plan.refundId,
          receipt.checkout.user_id,
          receipt.checkout.certification_id,
          receipt.checkout.currency,
          receipt.totalMinor,
          receipt.linesJson,
          receipt.grantsJson,
          receipt.checkout.provider,
          plan.providerRefundId,
          plan.settledAt,
          plan.refundId,
          receipt.checkout.id,
        ),
    );
  }

  const results = await database.batch(statements);
  const settled =
    (results[labels.indexOf("settle")]?.results ?? []).length === 1;
  let revoked = 0;
  let checkouts = 0;
  let receipts = 0;
  labels.forEach((label, index) => {
    const rows = (results[index]?.results ?? []).length;
    if (label.startsWith("revoke:")) revoked += rows;
    if (label === "checkout") checkouts += rows;
    if (label === "receipt") receipts += rows;
  });
  return { settled, revoked, checkouts, receipts };
}

/**
 * Settle a refund the provider has confirmed, retrying a lost compare-and-swap
 * with a fresh read. The revoke set is recomputed from storage each attempt but
 * never changes membership: the lines are immutable and the provider has already
 * refunded those payments, so the refund revokes exactly what it was decided for
 * - and if that decision no longer survives the guard, the attempt is refused
 * rather than quietly expanded.
 */
async function settleRefund(
  database: SecurityDatabase,
  identity: { refundId: string; userId: string; certificationId: string },
  checkouts: readonly RefundCheckoutRow[],
  providerRefundId: string,
  now: number,
): Promise<boolean> {
  for (let attempt = 1; attempt <= refundSettlementAttempts; attempt += 1) {
    const plan = await buildRefundSettlementPlan(
      database,
      identity,
      checkouts,
      providerRefundId,
      now,
    );
    if (!plan) continue;
    try {
      const witness = await applyRefundSettlement(database, plan);
      if (settledExactlyAsPlanned(witness, plan)) return true;
    } catch (error) {
      // The batch is one transaction, so a constraint abort wrote nothing and the
      // next attempt re-reads. Anything that is **not** a constraint failure is
      // not a lost race: it is a bug or an outage we have not diagnosed, and
      // reporting it as `503 provider_unavailable` would both hide it and invite
      // a retry that cannot help.
      if (!isConstraintFailure(error)) throw error;
      continue;
    }
  }
  return false;
}

/**
 * Every witness the batch returns must match the plan it executed. `settled` on
 * its own is not enough: the settle statement's compare-and-swap cannot see a
 * checkout that statement 4 refused to move, because that statement filters
 * `status = 'paid'` and a row it never touches fires no trigger. The batch has
 * committed by this point, so a short count is a reason to refuse a `200`, not a
 * rollback - the abort for the non-`paid` checkout case is
 * `commerce_refunds_settle_requires_paid_checkouts`, and this comparison is what
 * would catch any other divergence between plan and storage.
 */
function settledExactlyAsPlanned(
  witness: {
    settled: boolean;
    revoked: number;
    checkouts: number;
    receipts: number;
  },
  plan: RefundSettlementPlan,
): boolean {
  return (
    witness.settled &&
    witness.revoked === plan.revocations.length &&
    witness.checkouts === plan.checkouts.length &&
    witness.receipts === plan.receipts.length
  );
}

async function buildRefundSettlementPlan(
  database: SecurityDatabase,
  identity: { refundId: string; userId: string; certificationId: string },
  checkouts: readonly RefundCheckoutRow[],
  providerRefundId: string,
  now: number,
): Promise<RefundSettlementPlan | null> {
  const grants = await readGrants(
    database,
    identity.userId,
    identity.certificationId,
  );
  const split = splitRevocations(grants, checkouts);
  if (!split) return null;
  const revokedIds = new Set(
    [...split.pro, ...split.standard].map((grant) => grant.id),
  );
  const remainingStandard = grants.filter(
    (grant) =>
      grant.feature === "standard" &&
      grant.revoked_at === null &&
      !revokedIds.has(grant.id),
  );
  // The coverage-gap guard (owner decision 1, docs/commerce-refunds.md §15.1), re-run
  // against storage rather than trusted from the request-time plan. Between the
  // decision and this batch a second purchase can be settled (a second tab, a
  // webhook that arrived late), and every Standard purchase appends to the latest
  // end - so revoking this purchase would leave the learner with coverage that
  // starts later and nothing live now: locked out with no purchasable route back,
  // which is exactly the shape §4.2 refuses.
  //
  // A retry cannot repair that by adding the new checkout to the refund: the lines
  // are immutable and the provider has already been told the amount. So this
  // attempt is refused, every retry is refused, and `settleRefund` answers `503`
  // with the refund `requested`, access live and money returned.
  const liveAtNow = remainingStandard.some(
    (grant) => grant.starts_at <= now && now < grant.expires_at,
  );
  const startsInFuture = remainingStandard.some(
    (grant) => grant.starts_at > now,
  );
  if (!liveAtNow && startsInFuture) return null;
  const remainingStandardCount = remainingStandard.length;

  const revocations: PlannedRevocation[] = [];
  for (const grant of split.pro) {
    revocations.push({
      grantId: grant.id,
      feature: "pro",
      checkoutId: checkoutIdOf(grant, proSuffix),
      startsAt: grant.starts_at,
      expiresAt: grant.expires_at,
    });
  }
  for (const grant of split.standard) {
    revocations.push({
      grantId: grant.id,
      feature: "standard",
      checkoutId: checkoutIdOf(grant, standardSuffix),
      startsAt: grant.starts_at,
      expiresAt: grant.expires_at,
    });
  }
  if (revocations.length === 0) return null;

  const receipts: RefundReceiptInput[] = [];
  for (const checkout of checkouts) {
    const lines = await readSnapshotLines(database, checkout.id);
    const revokedHere = revocations.filter(
      (revocation) => revocation.checkoutId === checkout.id,
    );
    receipts.push({
      checkout,
      totalMinor: checkout.total_minor,
      // The refunded purchase, as the price snapshot recorded it.
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
        revokedHere.map((revocation) => ({
          feature: revocation.feature,
          startsAt: revocation.startsAt,
          expiresAt: revocation.expiresAt,
          operationId: `${revocation.checkoutId}:${revocation.feature}`,
          grantId: revocation.grantId,
        })),
      ),
    });
  }

  return {
    refundId: identity.refundId,
    userId: identity.userId,
    certificationId: identity.certificationId,
    settledAt: now,
    providerRefundId,
    revocations,
    remainingStandardCount,
    checkouts: checkouts.map((checkout) => checkout.id),
    receipts,
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
 * The settled body, projected from storage so a replay cannot diverge.
 *
 * `null` when storage and the ledger disagree — a settled refund that revoked no
 * grant, or whose refund receipt is missing. The settle batch writes all three in
 * one transaction, so this is unreachable from the shipped writer; if it is
 * reached anyway, an unknown state must deny rather than answer with a body that
 * claims access ended when it did not.
 */
export async function projectSettledRefund(
  database: SecurityDatabase,
  refund: RefundRow,
): Promise<CommerceRefundResponse | null> {
  const lines = await readRefundLines(database, refund.id);
  const prefix = `refund:${refund.id}:`;
  const revokedRows = await database
    .prepare(
      `SELECT id, feature, starts_at, expires_at, operation_id
       FROM learner_access_grants
       WHERE user_id = ? AND certification_id = ?
         AND substr(revocation_operation_id, 1, ?) = ?
       ORDER BY CASE feature WHEN 'pro' THEN 0 ELSE 1 END, starts_at, id`,
    )
    .bind(
      refund.user_id,
      refund.certification_id,
      prefix.length,
      prefix,
    )
    .all<{
      id: string;
      feature: "standard" | "pro";
      starts_at: number;
      expires_at: number;
      operation_id: string | null;
    }>();

  const revoked: CommerceRefundRevokedGrant[] = revokedRows.results.map(
    (row) => ({
      feature: row.feature,
      grantId: row.id,
      checkoutId: checkoutIdOf(
        {
          id: row.id,
          feature: row.feature,
          starts_at: row.starts_at,
          expires_at: row.expires_at,
          revoked_at: null,
          source: null,
          operation_id: row.operation_id,
        },
        row.feature === "pro" ? proSuffix : standardSuffix,
      ),
      startsAt: row.starts_at,
      expiresAt: row.expires_at,
    }),
  );

  const receipts = await database
    .prepare(
      `SELECT id, receipt_number, checkout_id FROM commerce_receipts
       WHERE refund_id = ? AND kind = 'refund'`,
    )
    .bind(refund.id)
    .all<{ id: string; receipt_number: string; checkout_id: string }>();
  const receiptByCheckout = new Map(
    receipts.results.map((row) => [row.checkout_id, row]),
  );
  if (revoked.length === 0) return null;
  if (lines.some((line) => !receiptByCheckout.has(line.checkout_id))) {
    return null;
  }

  return {
    refundId: refund.id,
    status: "settled",
    currency: refund.currency,
    amountMinor: refund.amount_minor,
    requestedAt: refund.requested_at,
    settledAt: refund.settled_at ?? refund.requested_at,
    checkouts: lines.map((line, index) => ({
      checkoutId: line.checkout_id,
      sku: line.sku as CommerceSku,
      amountMinor: line.amount_minor,
      includedBecause: index === 0 ? "requested" : "dependent-pro",
    })),
    revoked,
    receipts: lines.map((line) => {
      const receipt = receiptByCheckout.get(line.checkout_id);
      return {
        receiptId: receipt?.id ?? "",
        receiptNumber: receipt?.receipt_number ?? "",
        checkoutId: line.checkout_id,
      };
    }),
    access: "ended",
  };
}

async function projectPendingRefund(
  database: SecurityDatabase,
  refund: RefundRow,
): Promise<CommerceRefundResponse> {
  const lines = await readRefundLines(database, refund.id);
  return {
    refundId: refund.id,
    status: "requested",
    currency: refund.currency,
    amountMinor: refund.amount_minor,
    requestedAt: refund.requested_at,
    checkouts: lines.map((line, index) => ({
      checkoutId: line.checkout_id,
      sku: line.sku as CommerceSku,
      amountMinor: line.amount_minor,
      includedBecause: index === 0 ? "requested" : "dependent-pro",
    })),
  };
}
