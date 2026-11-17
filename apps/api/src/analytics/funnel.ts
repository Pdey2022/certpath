import type { SecurityDatabase } from "../security/database.ts";

// The pilot funnel measurement: one query, two readings.
//
// The cohort - how many checkouts were created, paid, refunded or parked in a
// window - is computed from `commerce_checkouts`, the ledger that already exists
// and cannot be lost by an analytics failure. The event side sits beside it, and
// `eventGap` names the difference so a dropped event is a visible number rather
// than a quietly better conversion rate.
//
// Nothing here is a route. `readPilotFunnel` is called by tests and by an
// operator running the same SQL against D1; a future read route would be a Global
// Admin capability and a separate change (ADR 0004).
//
// Cohort semantics are on `created_at`: a checkout counts in the window it was
// created, so the numerator and the denominator are the same population. Event
// counts use `received_at` (our clock), never the client's `occurred_at`.
//
// Rules: docs/pilot-hardening.md, docs/analytics-events.md.

/**
 * The measurement, with the product filter as a JSON array parameter so one
 * statement can serve Standard and Pro: `?3` is `null` for everything, or
 * `["pro-3m","bundle-standard-3m-pro"]` for the Pro reading.
 *
 * Zero rows is a valid answer - no checkouts and no events in the window - and
 * within a row `conversionRate` is NULL when nothing was created (`NULLIF`, never
 * a division by zero).
 */
export const funnelMeasurementSql = `WITH cohort AS (
   SELECT sku AS productId, currency, total_minor AS amountMinor,
          COUNT(*)                                    AS checkoutsCreated,
          SUM(status = 'paid')                        AS checkoutsPaid,
          SUM(status IN ('refunded','needs_support')) AS checkoutsNotConverting,
          SUM(status = 'refunded')                    AS checkoutsRefunded
   FROM commerce_checkouts
   WHERE created_at >= ?1 AND created_at < ?2
     AND (?3 IS NULL OR sku IN (SELECT value FROM json_each(?3)))
   GROUP BY sku, currency, total_minor
 ), interest AS (
   SELECT product_id AS productId, currency, amount_minor AS amountMinor,
          SUM(event_name = 'checkout_started')        AS checkoutStarts,
          COUNT(DISTINCT anonymous_session_id)        AS consentedSessions
   FROM pilot_events
   WHERE received_at >= ?1 AND received_at < ?2
     AND event_name IN ('checkout_started','purchase_confirmed')
   GROUP BY product_id, currency, amount_minor
 )
 SELECT c.productId AS productId, c.currency AS currency,
        c.amountMinor AS amountMinor,
        COALESCE(i.checkoutStarts, 0)      AS checkoutStartsFromEvents,
        COALESCE(i.consentedSessions, 0)   AS consentedSessions,
        c.checkoutsCreated AS checkoutsCreated,
        c.checkoutsPaid AS checkoutsPaid,
        c.checkoutsRefunded AS checkoutsRefunded,
        c.checkoutsNotConverting AS checkoutsNotConverting,
        c.checkoutsCreated - COALESCE(i.checkoutStarts, 0) AS eventGap,
        CAST(c.checkoutsPaid AS REAL) / NULLIF(c.checkoutsCreated, 0)
          AS conversionRate
 FROM cohort c LEFT JOIN interest i
   ON i.productId = c.productId
  AND i.currency = c.currency
  AND i.amountMinor = c.amountMinor
 ORDER BY c.productId, c.currency, c.amountMinor`;

/** The products whose purchase grants Pro, for the Pro reading of the query. */
export const proFunnelProducts = ["pro-3m", "bundle-standard-3m-pro"] as const;

export interface PilotFunnelWindow {
  /** Inclusive lower bound on `commerce_checkouts.created_at` / `received_at`. */
  from: number;
  /** Exclusive upper bound. */
  to: number;
  /** `null` reads every product; a list filters to those SKUs. */
  products: readonly string[] | null;
}

export interface PilotFunnelRow {
  productId: string;
  currency: string;
  amountMinor: number;
  checkoutStartsFromEvents: number;
  consentedSessions: number;
  checkoutsCreated: number;
  checkoutsPaid: number;
  checkoutsRefunded: number;
  checkoutsNotConverting: number;
  eventGap: number;
  /** `null` when `checkoutsCreated` is 0 - never `Infinity` and never an error. */
  conversionRate: number | null;
}

/**
 * Read the funnel for a window. Returns one row per (product, currency, amount)
 * that had a checkout created in it; no rows means "no data", which the caller
 * prints rather than turning into a zero.
 */
export async function readPilotFunnel(
  database: SecurityDatabase,
  window: PilotFunnelWindow,
): Promise<PilotFunnelRow[]> {
  const result = await database
    .prepare(funnelMeasurementSql)
    .bind(
      window.from,
      window.to,
      window.products === null ? null : JSON.stringify([...window.products]),
    )
    .all<PilotFunnelRow>();
  return result.results;
}
