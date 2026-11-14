import type { SecurityDatabase } from "./database.ts";

// Twelve-month audit retention, on one flat rule.
//
// Every audit row - including contact reveals and account deactivations - is
// removed once it is older than the window. There is no legal hold and no
// second retention class. Storage enforces the bound: `audit_events_no_delete`
// compares `occurred_at` against D1's own clock, so a wrong or hostile caller
// clock can only ever under-delete.
//
// Rules: docs/decisions/0004-staff-capabilities-and-learner-data.md and
// docs/admin-capabilities.md.

export const auditRetentionWindowMs = 365 * 24 * 60 * 60 * 1000;
export const auditRetentionMaxBatch = 500;

export type AuditRetentionResult =
  | { ok: true; value: { deleted: number } }
  | { ok: false; reason: "invalid-input" };

/**
 * Deletes at most `limit` audit rows that are already older than the window.
 * Idempotent and re-entrant: the next run picks up where this one stopped.
 */
export async function cleanupExpiredAuditEvents(
  database: SecurityDatabase,
  now: number,
  limit: number = auditRetentionMaxBatch,
): Promise<AuditRetentionResult> {
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > auditRetentionMaxBatch
  ) {
    return { ok: false, reason: "invalid-input" };
  }

  const result = await database
    .prepare(
      `DELETE FROM audit_events
       WHERE operation_id IN (
         SELECT operation_id FROM audit_events
         WHERE occurred_at < ?
           AND occurred_at < (
             CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 31536000000
           )
         ORDER BY occurred_at, operation_id
         LIMIT ?
       )`,
    )
    .bind(now - auditRetentionWindowMs, limit)
    .run();

  return { ok: true, value: { deleted: result.meta.changes ?? 0 } };
}
