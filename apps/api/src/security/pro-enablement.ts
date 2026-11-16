import type { ProEnablementRecord } from "../pricing.ts";
import { globalAdminGuard, type StatementGuard } from "./capabilities.ts";
import type { SecurityDatabase } from "./database.ts";
import type { StaffMfaPolicy } from "./mfa.ts";

// Pro enablement: the commercial fact "Pro is sold on this exam".
//
// Storage is `certification_pro_enablement`, an append-only log beside the
// immutable `certifications` row. Current state is the row with the greatest
// `(effective_at, id)` per certification, read in one query however many
// certifications a caller asks about, so the dashboard never fans out.
//
// The write is a Global Admin act (`access.grant`). Like every other staff write
// in this codebase it re-reads the live session, the active role and the MFA
// assurance inside its own statement, and the audit row is written by an
// `AFTER INSERT` trigger rather than by this module, so a route that forgot to
// audit still produces one.
//
// Rules: docs/decisions/0003-pricing-pro-and-refunds.md and
// docs/decisions/0004-staff-capabilities-and-learner-data.md.

export interface ProEnablementActor {
  tokenDigest: string;
  userId: string;
}

export interface ProEnablementMutation {
  enabled: boolean;
  reason: string;
  operationId: string;
  now: number;
}

export type ProEnablementHistoryEntry = {
  enabled: boolean;
  effectiveAt: number;
  operationId: string;
  reason: string;
};

export type ProEnablementWriteFailure =
  | "invalid-input"
  // The guarded statement changed nothing because the actor is no longer a live
  // Global Admin with a fresh MFA assurance: fail closed, not as a conflict.
  | "unauthorized"
  | "certification-not-found"
  | "conflict";

export type ProEnablementWriteResult =
  | { ok: true; record: ProEnablementRecord; operationId: string }
  | { ok: false; reason: ProEnablementWriteFailure };

interface ProEnablementRow {
  certification_id: string;
  enabled: number;
  effective_at: number;
}

const operationPattern = /^[a-zA-Z0-9:_-]{1,128}$/;

export function isValidProEnablementMutation(
  mutation: ProEnablementMutation,
): boolean {
  return (
    typeof mutation.enabled === "boolean" &&
    operationPattern.test(mutation.operationId) &&
    mutation.reason.trim().length > 0 &&
    mutation.reason.length <= 500 &&
    Number.isSafeInteger(mutation.now)
  );
}

/**
 * Current Pro state for every requested certification, in one query. Missing
 * certifications are absent from the map; presence of a row with `enabled:
 * false` is the difference between "never decided" and "withdrawn".
 */
export async function readProEnablement(
  database: SecurityDatabase,
  certificationIds: readonly string[],
): Promise<Map<string, ProEnablementRecord>> {
  const ids = [...new Set(certificationIds)];
  const current = new Map<string, ProEnablementRecord>();
  if (ids.length === 0) return current;

  const placeholders = ids.map(() => "?").join(", ");
  const rows = await database
    .prepare(
      `WITH ranked AS (
         SELECT certification_id, enabled, effective_at,
                ROW_NUMBER() OVER (
                  PARTITION BY certification_id
                  ORDER BY effective_at DESC, id DESC
                ) AS position
         FROM certification_pro_enablement
         WHERE certification_id IN (${placeholders})
       )
       SELECT certification_id, enabled, effective_at
       FROM ranked
       WHERE position = 1`,
    )
    .bind(...ids)
    .all<ProEnablementRow>();

  for (const row of rows.results) {
    current.set(row.certification_id, {
      enabled: row.enabled === 1,
      effectiveAt: row.effective_at,
    });
  }
  return current;
}

/**
 * One certification's current state and its acts, newest first and bounded, or
 * `null` when the certification does not exist. The read route serves this and
 * nothing decides anything from the history.
 */
export async function readProEnablementDetail(
  database: SecurityDatabase,
  certificationId: string,
): Promise<{
  record: ProEnablementRecord | null;
  history: ProEnablementHistoryEntry[];
} | null> {
  if (!(await certificationExists(database, certificationId))) return null;
  const history = await readProEnablementHistory(database, certificationId);
  const newest = history[0];
  return {
    record: newest
      ? { enabled: newest.enabled, effectiveAt: newest.effectiveAt }
      : null,
    history,
  };
}

async function readProEnablementHistory(
  database: SecurityDatabase,
  certificationId: string,
  limit = 20,
): Promise<ProEnablementHistoryEntry[]> {
  const rows = await database
    .prepare(
      `SELECT enabled, effective_at, operation_id, reason
       FROM certification_pro_enablement
       WHERE certification_id = ?
       ORDER BY effective_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(certificationId, limit)
    .all<{
      enabled: number;
      effective_at: number;
      operation_id: string;
      reason: string;
    }>();
  return rows.results.map((row) => ({
    enabled: row.enabled === 1,
    effectiveAt: row.effective_at,
    operationId: row.operation_id,
    reason: row.reason,
  }));
}

async function certificationExists(
  database: SecurityDatabase,
  certificationId: string,
): Promise<boolean> {
  const row = await database
    .withSession("first-primary")
    .prepare("SELECT 1 AS present FROM certifications WHERE id = ?")
    .bind(certificationId)
    .first<{ present: number }>();
  return row !== null;
}

async function guardHolds(
  database: SecurityDatabase,
  guard: StatementGuard,
): Promise<boolean> {
  const row = await database
    .withSession("first-primary")
    .prepare(`SELECT ${guard.sql} AS allowed`)
    .bind(...guard.values)
    .first<{ allowed: number }>();
  return row?.allowed === 1;
}

export function isProEnablementConflictError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return message.includes("UNIQUE constraint failed");
}

/**
 * Record one act.
 *
 * The insert is guarded three ways in its own statement - the certification must
 * exist, the actor must still be a live Global Admin with a fresh MFA assurance,
 * and the requested state must differ from the current one - so two concurrent
 * acts cannot both flip the same state, and a revoked role cannot write a
 * commercial fact. The second statement in the batch reads the row back as the
 * witness; the audit row comes from the trigger.
 */
export async function recordProEnablement(
  database: SecurityDatabase,
  input: {
    actor: ProEnablementActor;
    certificationId: string;
    mutation: ProEnablementMutation;
    policy: StaffMfaPolicy;
  },
): Promise<ProEnablementWriteResult> {
  if (
    !operationPattern.test(input.certificationId) ||
    !isValidProEnablementMutation(input.mutation)
  ) {
    return { ok: false, reason: "invalid-input" };
  }

  const guard = globalAdminGuard(
    input.actor.tokenDigest,
    input.mutation.now,
    input.policy,
  );
  const enabled = input.mutation.enabled ? 1 : 0;
  const rowId = crypto.randomUUID();

  let results;
  try {
    results = await database.batch([
      database
        .prepare(
          `INSERT INTO certification_pro_enablement (
             id, certification_id, enabled, effective_at,
             changed_by_user_id, operation_id, reason
           )
           SELECT ?, target.id, ?, ?, ?, ?, ?
           FROM certifications AS target
           WHERE target.id = ?
             AND ${guard.sql}
             -- The requested state must differ from the current one, so two
             -- concurrent acts cannot both flip the same state and a repeat is a
             -- conflict rather than a second row.
             AND COALESCE((
               SELECT current.enabled
               FROM certification_pro_enablement AS current
               WHERE current.certification_id = target.id
               ORDER BY current.effective_at DESC, current.id DESC
               LIMIT 1
             ), -1) <> ?
           RETURNING id`,
        )
        .bind(
          rowId,
          enabled,
          input.mutation.now,
          input.actor.userId,
          input.mutation.operationId,
          input.mutation.reason,
          input.certificationId,
          ...guard.values,
          enabled,
        ),
      database
        .prepare(
          `SELECT enabled, effective_at
           FROM certification_pro_enablement
           WHERE operation_id = ?`,
        )
        .bind(input.mutation.operationId),
    ]);
  } catch (error) {
    if (isProEnablementConflictError(error)) {
      return { ok: false, reason: "conflict" };
    }
    throw error;
  }

  // The witness is the returned row, not `meta.changes`: the audit trigger
  // writes a second row, so `changes` is 2 for a single act.
  if ((results[0]?.results ?? []).length !== 1) {
    // No row: either the actor lost the role, or the certification is gone, or
    // the requested state already holds. All three fail closed; the probes use
    // the same predicates as the decision layer, so the answer cannot disclose
    // a certification to an actor who may not read it.
    if (!(await guardHolds(database, guard))) {
      return { ok: false, reason: "unauthorized" };
    }
    return (await certificationExists(database, input.certificationId))
      ? { ok: false, reason: "conflict" }
      : { ok: false, reason: "certification-not-found" };
  }

  const row = (results[1]?.results ?? [])[0] as
    | { enabled: number; effective_at: number }
    | undefined;
  if (!row) {
    // The insert landed but its witness is missing: impossible with a single
    // transaction, and unresolvable here. Fail closed rather than report a
    // success we cannot prove.
    return { ok: false, reason: "conflict" };
  }
  return {
    ok: true,
    record: { enabled: row.enabled === 1, effectiveAt: row.effective_at },
    operationId: input.mutation.operationId,
  };
}
