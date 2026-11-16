import type {
  CommerceCheckoutResponse,
  CommerceOffer,
  CommerceOfferReason,
  CommerceOffersResponse,
  CommerceSku,
  CommerceTerm,
} from "@certpath/contracts";
import type { AccessGrantRecord } from "../entitlements.ts";
import {
  canPurchasePro,
  currency,
  isProOffered,
  priceList,
  proTerm,
  standardCoverageEndMs,
  termFor,
  type ProPurchaseDecision,
  type Sku,
} from "../pricing.ts";
import { addTerm } from "../calendar.ts";
import type { D1PreparedStatement, SecurityDatabase } from "../security/database.ts";
import { readProEnablement } from "../security/pro-enablement.ts";
import type { PaymentProvider } from "./provider.ts";

// The offers projection and checkout creation.
//
// Nothing here grants anything. A checkout is a priced request to buy; the
// grants it promises are written by settlement, from the price snapshot these
// lines record. That separation is why a provider outage can leave a `pending`
// row and no entitlement, and why the price list can change without touching a
// completed purchase.
//
// Rules: docs/commerce.md and docs/decisions/0003-pricing-pro-and-refunds.md.

const dayMs = 86_400_000;

/**
 * How long a provider session may live. A checkout is a redirect handoff, not a
 * reservation: the learner either completes it or the row expires and a new
 * checkout is a new `clientCheckoutKey`. Settlement still accepts an `expired`
 * row as a source of `paid`, because money taken after our own deadline is
 * money taken.
 */
export const checkoutSessionTtlMs = 30 * 60 * 1000;

/**
 * Checkout ids are minted here and are the anchor of the grant's deterministic
 * operation id (`"<checkoutId>:standard"` / `"<checkoutId>:pro"`), which 0019
 * writes. The contracts cap an operation id at 128 characters, so a checkout id
 * must never exceed 118: `chk_` + a UUID is 40, and the bound is asserted by a
 * test so a future id shape cannot quietly break the grant write.
 */
export const maxCheckoutIdLength = 118;

/** The suffix set 0019 must use. Derived from the stored row, never random. */
export const grantOperationIdSuffixes = {
  standard: ":standard",
  pro: ":pro",
} as const;

export function grantOperationId(
  checkoutId: string,
  feature: "standard" | "pro",
): string {
  return `${checkoutId}${grantOperationIdSuffixes[feature]}`;
}

function mintCheckoutId(): string {
  const id = `chk_${crypto.randomUUID()}`;
  if (id.length > maxCheckoutIdLength) {
    // Unreachable with the shape above; if it ever fires, minting must change
    // before a grant can be written with an over-long operation id.
    throw new Error("minted checkout id exceeds the operation id bound");
  }
  return id;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The idempotency witness for a checkout request. Two requests with the same
 * client key and the same fingerprint are the same purchase; the same key with
 * a different fingerprint is a client bug and must fail rather than silently
 * reuse a checkout for another SKU.
 */
export async function requestFingerprint(
  certificationId: string,
  sku: string,
): Promise<string> {
  return sha256Hex(`${certificationId}\n${sku}`);
}

export function isSku(value: string): value is Sku {
  return Object.hasOwn(priceList, value);
}

function isLive(grant: AccessGrantRecord, now: number): boolean {
  return grant.startsAt <= now && now < grant.expiresAt;
}

function hasLiveStandard(
  grants: readonly AccessGrantRecord[],
  now: number,
): boolean {
  return grants.some(
    (grant) =>
      grant.feature === "standard" &&
      grant.revokedAt === null &&
      isLive(grant, now),
  );
}

function activeProEndsAtMs(
  grants: readonly AccessGrantRecord[],
  now: number,
): number | null {
  let end: number | null = null;
  for (const grant of grants) {
    if (grant.feature !== "pro" || grant.revokedAt !== null) continue;
    if (!isLive(grant, now)) continue;
    end = end === null ? grant.expiresAt : Math.max(end, grant.expiresAt);
  }
  return end;
}

/**
 * The purchase rule for one SKU, as the offers projection and the checkout route
 * both need it. One function, so the offer a client is shown and the decision
 * the write path makes cannot disagree.
 */
export type OfferDecision =
  | { purchasable: true; reason: null; requiresBundle: false }
  | {
      purchasable: false;
      reason: CommerceOfferReason;
      requiresBundle: boolean;
    };

type PurchaseContext = {
  certificationId: string;
  proOffered: boolean;
  grants: readonly AccessGrantRecord[];
  coverageEnd: number | null;
  now: number;
};

const offerReasonForProRejection: Record<
  Extract<ProPurchaseDecision, { allowed: false }>["reason"],
  CommerceOfferReason
> = {
  "pro-not-offered": "pro_not_offered",
  "standard-too-short": "standard_too_short",
  "pro-window-active": "pro_window_active",
};

function proDecision(context: PurchaseContext): OfferDecision {
  const decision = canPurchasePro({
    proOffered: context.proOffered,
    standardGrants: context.grants,
    activeProEndsAtMs: activeProEndsAtMs(context.grants, context.now),
    now: context.now,
  });
  if (decision.allowed) {
    return { purchasable: true, reason: null, requiresBundle: false };
  }
  return {
    purchasable: false,
    reason: offerReasonForProRejection[decision.reason],
    requiresBundle: decision.requiresBundle,
  };
}

function bundleDecision(context: PurchaseContext): OfferDecision {
  // The bundle brings its own Standard leg, so `standard_too_short` is not a
  // refusal reason here - it is the reason the bundle exists. It can still be
  // refused for the two Pro-level rules.
  if (!context.proOffered) {
    return {
      purchasable: false,
      reason: "pro_not_offered",
      requiresBundle: false,
    };
  }
  if (activeProEndsAtMs(context.grants, context.now) !== null) {
    return {
      purchasable: false,
      reason: "pro_window_active",
      requiresBundle: false,
    };
  }
  return { purchasable: true, reason: null, requiresBundle: false };
}

function topUpDecision(context: PurchaseContext): OfferDecision {
  // A top-up exists to bring coverage up to a full Pro term so Pro can be sold.
  // Each of the three conditions has the same answer: not applicable.
  const coverageEnd = context.coverageEnd ?? context.now;
  const applies =
    context.proOffered &&
    hasLiveStandard(context.grants, context.now) &&
    coverageEnd < addTerm(context.now, proTerm);
  return applies
    ? { purchasable: true, reason: null, requiresBundle: false }
    : {
        purchasable: false,
        reason: "topup_not_applicable",
        requiresBundle: false,
      };
}

function extensionDecision(context: PurchaseContext): OfferDecision {
  return hasLiveStandard(context.grants, context.now)
    ? { purchasable: true, reason: null, requiresBundle: false }
    : {
        purchasable: false,
        reason: "extension_not_applicable",
        requiresBundle: false,
      };
}

export function evaluateSku(sku: Sku, context: PurchaseContext): OfferDecision {
  switch (sku) {
    case "standard-3m":
    case "standard-6m":
    case "standard-12m":
      return { purchasable: true, reason: null, requiresBundle: false };
    case "pro-3m":
      return proDecision(context);
    case "bundle-standard-3m-pro":
      return bundleDecision(context);
    case "standard-topup-3m":
      return topUpDecision(context);
    case "standard-extension-30d":
      return extensionDecision(context);
  }
}

interface GrantRow {
  feature: "standard" | "pro";
  starts_at: number;
  expires_at: number;
  revoked_at: number | null;
}

async function certificationExists(
  database: SecurityDatabase,
  certificationId: string,
): Promise<boolean> {
  const row = await database
    .prepare("SELECT id FROM certifications WHERE id = ?")
    .bind(certificationId)
    .first<{ id: string }>();
  return row !== null;
}

async function readGrants(
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
    .all<GrantRow>();
  return rows.results.map((row) => ({
    feature: row.feature,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  }));
}

async function purchaseContext(
  database: SecurityDatabase,
  input: { userId: string; certificationId: string; now: number },
): Promise<PurchaseContext | null> {
  if (!(await certificationExists(database, input.certificationId))) {
    return null;
  }
  const [grants, enablement] = await Promise.all([
    readGrants(database, input.userId, input.certificationId),
    readProEnablement(database, [input.certificationId]),
  ]);
  return {
    certificationId: input.certificationId,
    proOffered: isProOffered(enablement.get(input.certificationId) ?? null),
    grants,
    coverageEnd: standardCoverageEndMs(grants, input.now),
    now: input.now,
  };
}

export type OffersResult =
  | { ok: true; value: CommerceOffersResponse }
  | { ok: false; reason: "certification-not-found" };

/** All seven SKUs, in price-list order, priced from `priceList` and nothing else. */
export async function projectOffers(
  database: SecurityDatabase,
  input: { userId: string; certificationId: string; now: number },
): Promise<OffersResult> {
  const context = await purchaseContext(database, input);
  if (!context) return { ok: false, reason: "certification-not-found" };

  const offers: CommerceOffer[] = (Object.keys(priceList) as Sku[]).map(
    (sku) => {
      const entry = priceList[sku];
      const decision = evaluateSku(sku, context);
      return {
        sku,
        label: entry.label,
        amountMinor: entry.amountMinor,
        purchasable: decision.purchasable,
        reason: decision.reason,
      };
    },
  );

  const coverageEnd = context.coverageEnd ?? input.now;
  return {
    ok: true,
    value: {
      certificationId: input.certificationId,
      currency,
      standardRemainingDays: Math.max(
        0,
        Math.floor((coverageEnd - input.now) / dayMs),
      ),
      proOffered: context.proOffered,
      offers,
    },
  };
}

/** One line of the price snapshot, before it is persisted. */
type NewLine = {
  sku: Sku;
  label: string;
  amountMinor: number;
  feature: "standard" | "pro";
  term: CommerceTerm;
  priceSource: "price-list" | "bundle-residual";
};

function priceListLine(sku: Sku): NewLine {
  const entry = priceList[sku];
  return {
    sku,
    label: entry.label,
    amountMinor: entry.amountMinor,
    feature: entry.feature,
    term: entry.term as CommerceTerm,
    priceSource: "price-list",
  };
}

/**
 * The lines a SKU writes. The bundle is presented as two lines (ADR 0003):
 * Standard at the `standard-3m` price, and Pro at the **residual**
 * `bundle - standard-3m`, marked `bundle-residual` so a later reader can see the
 * number was derived rather than typed. Standard first, because settlement
 * writes Standard before Pro.
 */
export function linesForSku(sku: Sku): NewLine[] {
  if (sku !== "bundle-standard-3m-pro") return [priceListLine(sku)];
  const standard = priceListLine("standard-3m");
  return [
    standard,
    {
      sku: "pro-3m",
      label: `${priceList["pro-3m"].label} (bundle price)`,
      amountMinor: priceList[sku].amountMinor - standard.amountMinor,
      feature: "pro",
      term: proTerm as CommerceTerm,
      priceSource: "bundle-residual",
    },
  ];
}

interface CheckoutRow {
  id: string;
  user_id: string;
  certification_id: string;
  sku: string;
  client_checkout_key: string;
  request_fingerprint: string;
  currency: string;
  total_minor: number;
  status:
    | "pending"
    | "paid"
    | "failed"
    | "expired"
    | "needs_support"
    | "refunded";
  provider: string;
  provider_session_id: string | null;
  provider_redirect_url: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  paid_at: number | null;
}

interface LineRow {
  checkout_id: string;
  position: number;
  sku: string;
  label: string;
  amount_minor: number;
  grants_feature: "standard" | "pro";
  grants_unit: "calendar_months" | "days";
  grants_months: number | null;
  grants_days: number | null;
  price_source: "price-list" | "bundle-residual";
}

async function findCheckout(
  database: SecurityDatabase,
  where: string,
  ...values: string[]
): Promise<CheckoutRow | null> {
  return database
    .prepare(
      `SELECT id, user_id, certification_id, sku, client_checkout_key,
              request_fingerprint, currency, total_minor, status, provider,
              provider_session_id, provider_redirect_url, created_at,
              updated_at, expires_at, paid_at
       FROM commerce_checkouts WHERE ${where}`,
    )
    .bind(...values)
    .first<CheckoutRow>();
}

async function readLines(
  database: SecurityDatabase,
  checkoutId: string,
): Promise<LineRow[]> {
  const rows = await database
    .prepare(
      `SELECT checkout_id, position, sku, label, amount_minor, grants_feature,
              grants_unit, grants_months, grants_days, price_source
       FROM commerce_checkout_lines
       WHERE checkout_id = ?
       ORDER BY position`,
    )
    .bind(checkoutId)
    .all<LineRow>();
  return rows.results;
}

function toResponse(
  row: CheckoutRow,
  lines: LineRow[],
  now: number,
): CommerceCheckoutResponse {
  // A redirect is only usable while the session can still be completed: while
  // pending, or before our own expiry if a provider echoed it late. The same
  // stored string is returned on replay, which is what makes a replay
  // byte-identical.
  const redirectUsable =
    row.provider_redirect_url !== null &&
    (row.status === "pending" || row.expires_at > now);
  return {
    checkoutId: row.id,
    sku: row.sku as CommerceSku,
    status: row.status,
    currency: row.currency,
    totalMinor: row.total_minor,
    lines: lines.map((line) => ({
      sku: line.sku as CommerceSku,
      label: line.label,
      amountMinor: line.amount_minor,
      feature: line.grants_feature,
      term:
        line.grants_unit === "calendar_months"
          ? { unit: "calendar_months" as const, months: line.grants_months ?? 0 }
          : { unit: "days" as const, days: line.grants_days ?? 0 },
      priceSource: line.price_source,
    })),
    redirectUrl: redirectUsable ? row.provider_redirect_url : null,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    // Set when a checkout can be paid and refunded; nothing in this phase can
    // pay one, so there is no window to report.
    refundWindowEndsAt: null,
  };
}

export type CheckoutFailure =
  | { code: "certification-not-found" }
  | {
      code: "purchase-not-allowed";
      reason: CommerceOfferReason;
      requiresBundle: boolean;
    }
  | { code: "idempotency-conflict" }
  | { code: "provider-unavailable" }
  | { code: "checkout-not-found" };

export type CheckoutResult =
  | { ok: true; created: boolean; value: CommerceCheckoutResponse }
  | { ok: false; failure: CheckoutFailure };

function lineInsert(
  database: SecurityDatabase,
  checkoutId: string,
  position: number,
  line: NewLine,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO commerce_checkout_lines (
         checkout_id, position, sku, label, amount_minor, grants_feature,
         grants_unit, grants_months, grants_days, price_source
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM commerce_checkouts WHERE id = ?)`,
    )
    .bind(
      checkoutId,
      position,
      line.sku,
      line.label,
      line.amountMinor,
      line.feature,
      line.term.unit,
      line.term.unit === "calendar_months" ? line.term.months : null,
      line.term.unit === "days" ? line.term.days : null,
      line.priceSource,
      checkoutId,
    );
}

/**
 * Create (or replay) one checkout.
 *
 * Idempotency is the `UNIQUE (user_id, client_checkout_key)` constraint, and the
 * witness is the row id `RETURNING` hands back - never `meta.changes`, which an
 * audit trigger can inflate. The row and its lines are written in one batch, so
 * a checkout never exists without its price snapshot; the line inserts are
 * predicated on *our* row id existing, so the loser of a concurrent double-click
 * writes nothing at all.
 *
 * The provider is called only after the row is committed, and the provider's
 * idempotency key is *our* checkout id: a crash between the two leaves a
 * `pending` row with no session, and the retry with the same client key calls
 * the provider again with the same key instead of minting a second session.
 */
export async function createCheckout(
  database: SecurityDatabase,
  provider: PaymentProvider,
  input: {
    userId: string;
    certificationId: string;
    sku: Sku;
    clientCheckoutKey: string;
    origin: string;
    now: number;
  },
): Promise<CheckoutResult> {
  // Idempotency is decided before the purchase rule: a replay is a replay even
  // if the rule that allowed the original would now refuse it. Nothing is
  // created either way, so no unpurchasable checkout can appear.
  const fingerprint = await requestFingerprint(input.certificationId, input.sku);
  let row = await findCheckout(
    database,
    "user_id = ? AND client_checkout_key = ?",
    input.userId,
    input.clientCheckoutKey,
  );
  if (row && row.request_fingerprint !== fingerprint) {
    return { ok: false, failure: { code: "idempotency-conflict" } };
  }

  let created = false;
  if (!row) {
    const context = await purchaseContext(database, input);
    if (!context) {
      return { ok: false, failure: { code: "certification-not-found" } };
    }
    const decision = evaluateSku(input.sku, context);
    if (!decision.purchasable) {
      return {
        ok: false,
        failure: {
          code: "purchase-not-allowed",
          reason: decision.reason,
          requiresBundle: decision.requiresBundle,
        },
      };
    }

    const lines = linesForSku(input.sku);
    const totalMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0);
    const expiresAt = input.now + checkoutSessionTtlMs;
    const checkoutId = mintCheckoutId();
    const results = await database.batch([
      database
        .prepare(
          `INSERT INTO commerce_checkouts (
             id, user_id, certification_id, sku, client_checkout_key,
             request_fingerprint, currency, total_minor, status, provider,
             provider_session_id, provider_redirect_url, created_at, updated_at,
             expires_at, paid_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?, ?, NULL)
           ON CONFLICT (user_id, client_checkout_key) DO NOTHING
           RETURNING id`,
        )
        .bind(
          checkoutId,
          input.userId,
          input.certificationId,
          input.sku,
          input.clientCheckoutKey,
          fingerprint,
          currency,
          totalMinor,
          provider.name,
          input.now,
          input.now,
          expiresAt,
        ),
      ...lines.map((line, position) =>
        lineInsert(database, checkoutId, position, line),
      ),
    ]);

    created = (results[0]?.results ?? []).length === 1;
    row = created
      ? await findCheckout(database, "id = ?", checkoutId)
      : await findCheckout(
          database,
          "user_id = ? AND client_checkout_key = ?",
          input.userId,
          input.clientCheckoutKey,
        );
    if (!row) {
      // The insert reported no row and the key still finds nothing: unresolvable
      // here, and answering 503 is the fail-closed direction.
      return { ok: false, failure: { code: "provider-unavailable" } };
    }
    if (!created && row.request_fingerprint !== fingerprint) {
      return { ok: false, failure: { code: "idempotency-conflict" } };
    }
  }

  // The provider is handed the *stored* price snapshot, never a recomputation:
  // what the learner is charged is what the row says.
  const lines = await readLines(database, row.id);

  // A pending row without a provider session is a checkout whose provider call
  // either never happened or failed. Retrying it is the documented recovery.
  if (row.status === "pending" && row.provider_session_id === null) {
    let session;
    try {
      session = await provider.createCheckout({
        checkoutId: row.id,
        accountRef: input.userId,
        certificationId: row.certification_id,
        currency: row.currency,
        lines: lines.map((line) => ({
          sku: line.sku as Sku,
          label: line.label,
          amountMinor: line.amount_minor,
        })),
        totalMinor: row.total_minor,
        successUrl: `${input.origin}/commerce/checkout/complete?checkout=${encodeURIComponent(row.id)}`,
        cancelUrl: `${input.origin}/commerce/checkout/cancelled?checkout=${encodeURIComponent(row.id)}`,
        expiresAt: row.expires_at,
      });
    } catch {
      // No error detail is logged or returned: the row stays pending with no
      // session, and the client retries with the same key.
      return { ok: false, failure: { code: "provider-unavailable" } };
    }
    // The witness is the returned row, not `meta.changes`. A concurrent retry
    // that bound the session first leaves zero rows here, which is a success:
    // the binding is the one already stored.
    await database
      .prepare(
        `UPDATE commerce_checkouts
         SET provider_session_id = ?, provider_redirect_url = ?, updated_at = ?
         WHERE id = ? AND provider_session_id IS NULL
         RETURNING id`,
      )
      .bind(session.sessionRef, session.redirectUrl, input.now, row.id)
      .run();
    const bound = await findCheckout(database, "id = ?", row.id);
    if (!bound) return { ok: false, failure: { code: "provider-unavailable" } };
    row = bound;
  }

  return {
    ok: true,
    created,
    value: toResponse(row, lines, input.now),
  };
}

/**
 * Read one checkout, owner only. The owner is in the `WHERE`, not in an `if`
 * above it, so another learner's id is indistinguishable from one that does not
 * exist.
 */
export async function readCheckout(
  database: SecurityDatabase,
  input: { userId: string; checkoutId: string; now: number },
): Promise<CheckoutResult> {
  const row = await findCheckout(
    database,
    "id = ? AND user_id = ?",
    input.checkoutId,
    input.userId,
  );
  if (!row) return { ok: false, failure: { code: "checkout-not-found" } };
  return {
    ok: true,
    created: false,
    value: toResponse(row, await readLines(database, row.id), input.now),
  };
}
