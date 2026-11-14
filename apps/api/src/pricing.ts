// Server-side price list and purchase rules.
//
// One global USD price list per exam, fixed-term only, no recurring billing.
// Prices are provisional until a fake-door test measures conversion; the rules
// around them (Pro window, Standard coverage, bundle) are not provisional.
//
// Rules: docs/decisions/0003-pricing-pro-and-refunds.md.

import type { EntitlementFeature } from "./entitlements.ts";

export const currency = "USD";

/** Pro is valid for exactly three months. */
export const proWindowDays = 90;

/** Pro requires this much Standard remaining at purchase time. */
export const proMinimumStandardDays = 90;

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
  /** Window the SKU grants, when it grants one directly. */
  days: number | null;
};

export const priceList: Readonly<Record<Sku, PriceEntry>> = {
  "standard-3m": {
    sku: "standard-3m",
    label: "Standard, 3 months",
    feature: "standard",
    amountMinor: 5_900,
    days: 90,
  },
  "standard-6m": {
    sku: "standard-6m",
    label: "Standard, 6 months",
    feature: "standard",
    amountMinor: 8_900,
    days: 180,
  },
  "standard-12m": {
    sku: "standard-12m",
    label: "Standard, 12 months",
    feature: "standard",
    amountMinor: 12_900,
    days: 365,
  },
  "pro-3m": {
    sku: "pro-3m",
    label: "Pro, 3 months",
    feature: "pro",
    amountMinor: 4_900,
    days: proWindowDays,
  },
  "bundle-standard-3m-pro": {
    sku: "bundle-standard-3m-pro",
    label: "Standard 3 months + Pro 3 months",
    feature: "pro",
    amountMinor: 9_900,
    days: proWindowDays,
  },
  "standard-topup-3m": {
    sku: "standard-topup-3m",
    label: "Standard top-up, 3 months",
    feature: "standard",
    amountMinor: 3_900,
    days: 90,
  },
  "standard-extension-30d": {
    sku: "standard-extension-30d",
    label: "Standard extension, 30 days",
    feature: "standard",
    amountMinor: 2_500,
    days: 30,
  },
};

export type ProPurchaseInput = {
  /** Pro is only sold where the real exam is adaptive. */
  proOffered: boolean;
  standardRemainingDays: number;
  lastProStartAt: number | null;
  now: number;
};

export type ProPurchaseDecision =
  | { allowed: true; requiresBundle: boolean }
  | {
      allowed: false;
      reason:
        | "pro-not-offered"
        | "standard-too-short"
        | "pro-window-active";
      requiresBundle: boolean;
    };

const dayMs = 86_400_000;

/**
 * Pro needs 90 days of Standard to sit inside, and only one Pro window per
 * rolling 90 days. When Standard is too short the answer is the bundle or a
 * Standard top-up, never a Pro that outlives Standard.
 */
export function canPurchasePro(input: ProPurchaseInput): ProPurchaseDecision {
  const requiresBundle = input.standardRemainingDays < proMinimumStandardDays;
  if (!input.proOffered) {
    return { allowed: false, reason: "pro-not-offered", requiresBundle };
  }
  if (requiresBundle) {
    return { allowed: false, reason: "standard-too-short", requiresBundle };
  }
  if (
    input.lastProStartAt !== null &&
    input.lastProStartAt + proWindowDays * dayMs > input.now
  ) {
    return { allowed: false, reason: "pro-window-active", requiresBundle };
  }
  return { allowed: true, requiresBundle };
}

/** True when a Pro purchase must be presented as the bundle rather than an add-on. */
export function requiresBundle(standardRemainingDays: number): boolean {
  return standardRemainingDays < proMinimumStandardDays;
}

export function amountFor(sku: Sku): number {
  return priceList[sku].amountMinor;
}
