import type { SecurityDatabase } from "../security/database.ts";

// Expiry of stale checkouts, for the Worker's `scheduled` handler.
//
// A pending checkout past its deadline can no longer be completed at the
// provider, so the row is marked `expired` and the client starts a new one with
// a new `clientCheckoutKey`. The job is idempotent and safe to skip: a checkout
// that is still pending simply expires on the next run, and a `checkout.completed`
// that arrives afterwards still applies, because settlement accepts an
// `expired` row as a source of `paid`.
//
// The row witness is the `RETURNING id` set, never `meta.changes`: an audit
// trigger on the same row would inflate the count.
//
// Rules: docs/commerce.md.

export const staleCheckoutBatchLimit = 200;

export type CheckoutExpiryResult =
  | { ok: true; value: { expired: number } }
  | { ok: false; reason: "invalid-input" };

export async function expireStaleCheckouts(
  database: SecurityDatabase,
  now: number,
  limit = staleCheckoutBatchLimit,
): Promise<CheckoutExpiryResult> {
  if (
    !Number.isSafeInteger(now) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > staleCheckoutBatchLimit
  ) {
    return { ok: false, reason: "invalid-input" };
  }
  const results = await database
    .prepare(
      `UPDATE commerce_checkouts
       SET status = 'expired', updated_at = ?
       WHERE id IN (
         SELECT id FROM commerce_checkouts
         WHERE status = 'pending' AND expires_at <= ?
         ORDER BY expires_at, id
         LIMIT ?
       )
       RETURNING id`,
    )
    .bind(now, now, limit)
    .run();
  return { ok: true, value: { expired: (results.results ?? []).length } };
}
