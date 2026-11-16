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
 * DISPLAY ONLY: the "≈90 days" number shown next to the Pro requirement. Never a
 * gate - the gate compares the stored coverage end against `addTerm(now,
 * proTerm)`.
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

export type ProPurchaseInput = {
  /** Pro is only sold where the real exam is adaptive. */
  proOffered: boolean;
  /**
   * End of the latest non-revoked Standard grant that is live at `now`, or null
   * when there is none.
   */
  standardCoverageEndMs: number | null;
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
 * The Pro gate, identical to the storage predicate
 * `learner_access_grants_pro_requires_standard` (0013): Standard coverage must
 * reach at least a full Pro term past `now`. Equality is allowed.
 *
 * A coverage end that reaches a full Pro term is necessarily later than `now`
 * (a term always advances), so this also rejects coverage that has ended.
 */
export function standardCoversProWindow(
  standardCoverageEndMs: number | null,
  now: number,
): boolean {
  if (standardCoverageEndMs === null) return false;
  return standardCoverageEndMs >= proWindow(now).endsAt;
}

/**
 * True when a Pro purchase must be presented as the bundle rather than an
 * add-on, i.e. exactly when Standard cannot cover a full Pro term.
 */
export function requiresBundle(
  standardCoverageEndMs: number | null,
  now: number,
): boolean {
  return !standardCoversProWindow(standardCoverageEndMs, now);
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
  const standardIsShort = requiresBundle(
    input.standardCoverageEndMs,
    input.now,
  );
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
