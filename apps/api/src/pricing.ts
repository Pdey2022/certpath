// Server-side price list and purchase rules.
//
// One global USD price list per exam, fixed-term only, no recurring billing.
// Prices are provisional until a fake-door test measures conversion; the rules
// around them (Pro window, Standard coverage, bundle) are not provisional.
//
// Terms are calendar months, not day counts: 3 months is the calendar term
// beginning on the purchase instant, which is 89 days from 1 February and 92
// days from 1 July. Storage keeps an instant; this module decides what a term
// means.
//
// Rules: docs/decisions/0003-pricing-pro-and-refunds.md.

import { addTerm, type TermSpec } from "./calendar.ts";
import type { EntitlementFeature } from "./entitlements.ts";

export const currency = "USD";

/** Pro is valid for exactly three calendar months. */
export const proTermMonths = 3;

export const proTerm: TermSpec = {
  unit: "calendar_months",
  months: proTermMonths,
};

/**
 * Display-only constant, currently unreferenced; it gates nothing. ADR 0003 names
 * it, so it is kept, but no code reads it: the gate compares the Standard
 * coverage window against `addTerm(now, proTerm)`.
 */
export const proDisplayMinStandardDays = 90;

export type Sku =
  | "standard-3m"
  | "standard-6m"
  | "standard-12m"
  | "pro-3m"
  | "bundle-standard-3m-pro"
  | "standard-topup-3m"
  | "standard-extension-30d";

export type PriceEntry = {
  sku: Sku;
  label: string;
  feature: EntitlementFeature;
  /** Minor units, so no floating point ever touches money. */
  amountMinor: number;
  /**
   * Window this SKU grants. For the bundle this is the Standard leg that must
   * cover the Pro leg; the Pro leg is always `proTerm`.
   */
  term: TermSpec;
};

const threeMonths: TermSpec = { unit: "calendar_months", months: 3 };
const sixMonths: TermSpec = { unit: "calendar_months", months: 6 };
const twelveMonths: TermSpec = { unit: "calendar_months", months: 12 };

export const priceList: Readonly<Record<Sku, PriceEntry>> = {
  "standard-3m": {
    sku: "standard-3m",
    label: "Standard, 3 months",
    feature: "standard",
    amountMinor: 5_900,
    term: threeMonths,
  },
  "standard-6m": {
    sku: "standard-6m",
    label: "Standard, 6 months",
    feature: "standard",
    amountMinor: 8_900,
    term: sixMonths,
  },
  "standard-12m": {
    sku: "standard-12m",
    label: "Standard, 12 months",
    feature: "standard",
    amountMinor: 12_900,
    term: twelveMonths,
  },
  "pro-3m": {
    sku: "pro-3m",
    label: "Pro, 3 months",
    feature: "pro",
    amountMinor: 4_900,
    term: proTerm,
  },
  "bundle-standard-3m-pro": {
    sku: "bundle-standard-3m-pro",
    label: "Standard 3 months + Pro 3 months",
    feature: "pro",
    amountMinor: 9_900,
    term: threeMonths,
  },
  "standard-topup-3m": {
    sku: "standard-topup-3m",
    label: "Standard top-up, 3 months",
    feature: "standard",
    amountMinor: 3_900,
    term: threeMonths,
  },
  // ADR 0003 names this SKU "Standard extension (30 days)". 30 days is not a
  // calendar month and this SKU must not drift into one.
  "standard-extension-30d": {
    sku: "standard-extension-30d",
    label: "Standard extension, 30 days",
    feature: "standard",
    amountMinor: 2_500,
    term: { unit: "days", days: 30 },
  },
};

export function termFor(sku: Sku): TermSpec {
  return priceList[sku].term;
}

export function amountFor(sku: Sku): number {
  return priceList[sku].amountMinor;
}

/** Current commercial state of Pro for one certification, as storage records it. */
export type ProEnablementRecord = { enabled: boolean; effectiveAt: number };

/**
 * The single decision point for "may Pro be sold on this exam". Storage is a
 * fact; this is the rule.
 */
export function isProOffered(record: ProEnablementRecord | null): boolean {
  return record !== null && record.enabled;
}

/**
 * A Standard coverage window as storage records it, half-open
 * `[startsAt, endsAt)`. The gate takes the whole window rather than a bare end
 * so that it can test the start itself; see `standardCoversProWindow`.
 */
export type StandardCoverage = { startsAt: number; endsAt: number };

export type ProPurchaseInput = {
  /** Pro is only sold where the real exam is adaptive. */
  proOffered: boolean;
  /**
   * The Standard window that covers `now`, or null when there is none. A window
   * that starts after `now` is passed as it is and refused by the gate, not
   * dropped by the caller.
   */
  standardCoverage: StandardCoverage | null;
  /** End of a live non-revoked Pro grant on this certification, or null. */
  activeProEndsAtMs: number | null;
  now: number;
};

export type ProPurchaseDecision =
  | { allowed: true; requiresBundle: boolean }
  | {
      allowed: false;
      reason: "pro-not-offered" | "standard-too-short" | "pro-window-active";
      requiresBundle: boolean;
    };

/** The Pro window a purchase made at `now` would write. */
export function proWindow(now: number): { startsAt: number; endsAt: number } {
  return { startsAt: now, endsAt: addTerm(now, proTerm) };
}

/**
 * The two windows one bundle purchase writes, from one anchor.
 *
 * Product rule (`docs/product-design.md`: "Early Standard extension begins at the
 * end of continuous current coverage"): the Standard leg **stacks** on live
 * coverage, so 11 months of Standard plus the bundle is 14 months, 2 months is
 * 5, and no coverage is 3. `coverageEnd` is null-as-`now`, so a first-time buyer
 * gets a plain 3-month term.
 *
 * Both legs start at the same `now`. `max` is load-bearing, not defensive:
 * calendar addition with a day clamp is **not order-preserving**, so
 * `addTerm(coverageEnd, term)` can land *before* `addTerm(now, term)`. With
 * `coverageEnd = 2026-01-31T00:00Z` and `now = 2026-01-30T18:00Z` both clamp into
 * 30 April and the time of day decides: `addTerm(coverageEnd, 3 months)` is
 * 30 Apr 00:00, `addTerm(now, 3 months)` is 30 Apr 18:00. Without the `max` the
 * Standard leg would end before the Pro leg and 0013 would abort the bundle.
 *
 * With it, 0013 accepts by construction: `S.starts_at = P.starts_at = now` and
 * `S.expires_at = max(...) >= addTerm(now, term) = P.expires_at`, which needs no
 * ordering property of month arithmetic at all.
 */
export function bundleWindows(
  coverageEndMs: number | null,
  now: number,
): { standard: StandardCoverage; pro: StandardCoverage } {
  const term = termFor("bundle-standard-3m-pro");
  const proLeg = proWindow(now);
  const stacked = addTerm(coverageEndMs ?? now, term);
  return {
    standard: { startsAt: now, endsAt: Math.max(stacked, proLeg.endsAt) },
    pro: proLeg,
  };
}

/**
 * The Pro gate, identical to the storage predicate
 * `learner_access_grants_pro_requires_standard` (0013): a non-revoked Standard
 * grant must satisfy `starts_at <= now` **and**
 * `expires_at >= addTerm(now, proTerm)`. Equality is allowed.
 *
 * The start is tested here, not by the caller, so the guarantee is structural: a
 * coverage window that begins in the future has an end that can comfortably
 * exceed a full Pro term, and an end-only test would allow a purchase that 0013
 * then refuses.
 *
 * `startsAt <= now` and `endsAt` taken together stay 0013-consistent for the
 * pair `evaluateFeature` returns: the grant supplying `endsAt` is itself active
 * at `now`, so it is a single witness for both conditions.
 */
export function standardCoversProWindow(
  standardCoverage: StandardCoverage | null,
  now: number,
): boolean {
  if (standardCoverage === null) return false;
  return (
    standardCoverage.startsAt <= now &&
    standardCoverage.endsAt >= proWindow(now).endsAt
  );
}

/**
 * True when a Pro purchase must be presented as the bundle rather than an
 * add-on, i.e. exactly when Standard cannot cover a full Pro term.
 */
export function requiresBundle(
  standardCoverage: StandardCoverage | null,
  now: number,
): boolean {
  return !standardCoversProWindow(standardCoverage, now);
}

/**
 * Pro is refused until Standard covers a full Pro term, and only one Pro window
 * is live at a time. `standard-too-short` keeps its identifier and now means
 * "your Standard does not cover a full Pro term"; the fix is the bundle or a
 * Standard top-up, never a Pro that outlives Standard.
 *
 * The repurchase gate reads the stored Pro expiry rather than re-deriving it
 * from a start: calendar adds do not compose, so `start + term` is not a stable
 * way to find the end of a window.
 */
export function canPurchasePro(input: ProPurchaseInput): ProPurchaseDecision {
  const standardIsShort = requiresBundle(input.standardCoverage, input.now);
  if (!input.proOffered) {
    return {
      allowed: false,
      reason: "pro-not-offered",
      requiresBundle: standardIsShort,
    };
  }
  if (standardIsShort) {
    return {
      allowed: false,
      reason: "standard-too-short",
      requiresBundle: true,
    };
  }
  if (
    input.activeProEndsAtMs !== null &&
    input.activeProEndsAtMs > input.now
  ) {
    return {
      allowed: false,
      reason: "pro-window-active",
      requiresBundle: false,
    };
  }
  return { allowed: true, requiresBundle: false };
}
