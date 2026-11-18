import type { SecurityDatabase } from "../security/database.ts";

// Twelve-month `pilot_events` retention, on one flat rule for both sources.
//
// Every event row - browser and server alike - is removed once it is older than
// the window. There is no erasure path and no second retention class: consent
// withdrawal stops future events and keeps stored history for the full window
// (owner decision, 18 November 2026). Storage enforces the bound:
// `pilot_events_no_delete` compares `received_at` against D1's own clock, so a
// wrong or hostile caller clock can only ever under-delete.
//
// This module is the scheduled prune, not the guarantee. The guarantee is the
// trigger in 0022, which a retry, an operator's `d1 execute`, or a future caller
// with a bug cannot bypass.
//
// Rules: docs/pilot-events-retention.md, docs/analytics-events.md,
// docs/open-decisions.md.

export const pilotEventRetentionWindowMs = 31_536_000_000;

/**
 * Rows removed per run, at most.
 *
 * ARC's cost math: the cron runs every five minutes, 288 times a day, so the
 * worst case is 288 x 250 = 72,000 row writes a day against D1 Free's 100,000
 * writes a day, which leaves headroom for the rest of the Worker. A batch of 500
 * would reach 144,000 and breach the limit. The prune is idempotent, so a backlog
 * larger than one batch drains over the following runs.
 */
export const pilotEventRetentionMaxBatch = 250;

export type PilotEventRetentionResult =
  | { ok: true; value: { deleted: number } }
  | { ok: false; reason: "invalid-input" };

/** The flag is an exact-string gate, like `COMMERCE_ENABLED`: only "true" is on. */
export function pilotEventsRetentionEnabled(bindings: {
  PILOT_EVENTS_RETENTION_ENABLED?: string;
}): boolean {
  return bindings.PILOT_EVENTS_RETENTION_ENABLED === "true";
}

/**
 * Deletes at most `limit` pilot event rows that are already older than the
 * window. Idempotent and re-entrant: the next run picks up where this one
 * stopped.
 *
 * The statement repeats the D1-clock predicate and never trusts the passed
 * `now`: `now` only narrows the candidate set, while the floor is decided by
 * `strftime('%s','now')`. The trigger would refuse an in-window delete anyway;
 * the predicate keeps such a statement from aborting the whole batch.
 *
 * The delete addresses `rowid`, not `event_id`: `event_id` is unique only per
 * `source`, so an id-based `IN` list would reach across sources and delete a
 * row this run never selected.
 */
export async function cleanupExpiredPilotEvents(
  database: SecurityDatabase,
  now: number,
  limit: number = pilotEventRetentionMaxBatch,
): Promise<PilotEventRetentionResult> {
  if (
    !Number.isSafeInteger(now) ||
    now < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > pilotEventRetentionMaxBatch
  ) {
    return { ok: false, reason: "invalid-input" };
  }

  const result = await database
    .prepare(
      `DELETE FROM pilot_events
       WHERE rowid IN (
         SELECT rowid FROM pilot_events
         WHERE received_at < ?
           AND received_at < (
             CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 31536000000
           )
         ORDER BY received_at, source, event_id
         LIMIT ?
       )`,
    )
    .bind(now - pilotEventRetentionWindowMs, limit)
    .run();

  return { ok: true, value: { deleted: result.meta.changes ?? 0 } };
}
