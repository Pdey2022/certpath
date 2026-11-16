// Calendar-month term arithmetic.
//
// Pure, runtime-neutral and UTC-only: no `Date.now()`, no I/O, no local-time
// getters, so the same function runs in the Worker, in tests and in any future
// reporting job. A term is either calendar months (clamped to the last valid
// day) or a fixed number of days; the union makes the unit impossible to forget.
//
// Windows are half-open - `[starts_at, expires_at)` - so a returned instant is
// used directly as `expires_at`.
//
// Calendar addition does **not** compose. From 31 January, `+1 month` twice is
// 28 March, while `+2 months` is 31 March. That is why a stored expiry is always
// read back rather than re-derived from a stored start.
//
// Rules: docs/decisions/0003-pricing-pro-and-refunds.md and docs/product-design.md
// ("add calendar months from activation in UTC, clamp to the last valid day, end
// timestamp exclusive; do not infer 3 months as 90 days").

export type TermSpec =
  | { readonly unit: "calendar_months"; readonly months: number }
  | { readonly unit: "days"; readonly days: number };

const dayMs = 86_400_000;

function requireSafeInstant(atMs: number): void {
  if (!Number.isSafeInteger(atMs)) {
    throw new RangeError("atMs must be a finite safe integer");
  }
}

/**
 * UTC calendar-month arithmetic, clamped to the last valid day of the target
 * month. Time of day is preserved to the millisecond.
 *
 * Ordering: the result is non-decreasing across instants that share a time of
 * day, but **not** across a day clamp - 30 January 18:00 and 31 January 00:00
 * both clamp into 30 April, so the later instant yields the earlier expiry. Any
 * invariant that compares two calendar-added instants has to be written so it
 * does not depend on that ordering (the bundle's stacked Standard leg, which
 * takes `max(addTerm(coverageEnd, term), addTerm(now, term))`, is the one that
 * exists — the `max` is there because the leg is not capped; see ADR 0003,
 * 16 November 2026).
 *
 * `months` must be a positive safe integer: a zero or negative term would
 * silently produce a zero-length or inverted grant, which is not a state we can
 * recover from.
 */
export function addCalendarMonths(atMs: number, months: number): number {
  requireSafeInstant(atMs);
  if (!Number.isSafeInteger(months) || months <= 0) {
    throw new RangeError("months must be a positive safe integer");
  }
  const instant = new Date(atMs);
  const year = instant.getUTCFullYear();
  const month = instant.getUTCMonth();
  const day = instant.getUTCDate();
  const timeOfDayMs = atMs - Date.UTC(year, month, day);
  const targetMonth = month + months;
  // Day 0 of the following month is the last day of the target month.
  const lastDay = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();
  return Date.UTC(year, targetMonth, Math.min(day, lastDay)) + timeOfDayMs;
}

/**
 * One term applied to an anchor instant. The only way a grant window is ever
 * computed.
 */
export function addTerm(atMs: number, term: TermSpec): number {
  requireSafeInstant(atMs);
  if (term.unit === "calendar_months") {
    return addCalendarMonths(atMs, term.months);
  }
  if (!Number.isSafeInteger(term.days) || term.days <= 0) {
    throw new RangeError("days must be a positive safe integer");
  }
  return atMs + term.days * dayMs;
}

/**
 * Length of a term in whole days, for display and sanity tests. Never a purchase
 * gate: a gate compares instants.
 */
export function termLengthDays(atMs: number, term: TermSpec): number {
  return (addTerm(atMs, term) - atMs) / dayMs;
}
