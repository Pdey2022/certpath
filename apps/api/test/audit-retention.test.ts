import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  auditRetentionWindowMs,
  cleanupExpiredAuditEvents,
} from "../src/security/audit-retention.ts";

// The D1 clock, not the fixture clock: the retention trigger compares against
// strftime('now'), so this file uses Date.now() deliberately.
const database: SecurityDatabase = env.DB;

const day = 24 * 60 * 60 * 1000;

function uniqueOperation(label: string): string {
  return `retention:${label}:${crypto.randomUUID()}`;
}

async function insertAudit(operationId: string, occurredAt: number): Promise<void> {
  await database
    .prepare(
      `INSERT INTO audit_events (
         operation_id, actor_user_id, actor_ref, action, subject_type,
         subject_id, certification_id, reason, details_json, occurred_at
       ) VALUES (?, NULL, ?, 'learner_record_viewed', 'user', ?, NULL, ?, NULL, ?)`,
    )
    .bind(
      operationId,
      "retention-scheduler",
      "retention-subject",
      "Retention probe",
      occurredAt,
    )
    .run();
}

async function auditExists(operationId: string): Promise<boolean> {
  const row = await database
    .prepare("SELECT 1 AS present FROM audit_events WHERE operation_id = ?")
    .bind(operationId)
    .first<{ present: number }>();
  return row !== null;
}

describe("audit retention", () => {
  it("refuses malformed audit details and accepts NULL or valid JSON", async () => {
    await expect(
      database
        .prepare(
          `INSERT INTO audit_events (
             operation_id, actor_user_id, actor_ref, action, subject_type,
             subject_id, certification_id, reason, details_json, occurred_at
           ) VALUES (?, NULL, ?, 'learner_record_viewed', 'user', ?, NULL, ?, '{not json', ?)`,
        )
        .bind(
          uniqueOperation("bad-json"),
          "retention-scheduler",
          "retention-subject",
          "Retention probe",
          Date.now(),
        )
        .run(),
    ).rejects.toThrow(/audit details must be JSON/);

    const nullOperation = uniqueOperation("null-json");
    const jsonOperation = uniqueOperation("valid-json");
    await insertAudit(nullOperation, Date.now());
    await database
      .prepare(
        `INSERT INTO audit_events (
           operation_id, actor_user_id, actor_ref, action, subject_type,
           subject_id, certification_id, reason, details_json, occurred_at
         ) VALUES (?, NULL, ?, 'learner_contact_revealed', 'user', ?, NULL, ?, ?, ?)`,
      )
      .bind(
        jsonOperation,
        "retention-scheduler",
        "retention-subject",
        "Retention probe",
        '{"fields":["email"]}',
        Date.now(),
      )
      .run();
    expect(await auditExists(nullOperation)).toBe(true);
    expect(await auditExists(jsonOperation)).toBe(true);
  });

  it("deletes only rows older than the window and reports the count", async () => {
    const now = Date.now();
    const outside = uniqueOperation("outside");
    const justOutside = uniqueOperation("just-outside");
    const inside = uniqueOperation("inside");
    await insertAudit(outside, now - 400 * day);
    await insertAudit(justOutside, now - 366 * day);
    await insertAudit(inside, now - 364 * day);

    const result = await cleanupExpiredAuditEvents(database, now, 500);
    expect(result).toEqual({ ok: true, value: { deleted: 2 } });
    expect(await auditExists(outside)).toBe(false);
    expect(await auditExists(justOutside)).toBe(false);
    expect(await auditExists(inside)).toBe(true);
  });

  it("is idempotent on a second run", async () => {
    const result = await cleanupExpiredAuditEvents(database, Date.now(), 500);
    expect(result).toEqual({ ok: true, value: { deleted: 0 } });
  });

  it("deletes at most the bounded batch size per call", async () => {
    const now = Date.now();
    const first = uniqueOperation("bounded-a");
    const second = uniqueOperation("bounded-b");
    await insertAudit(first, now - 500 * day);
    await insertAudit(second, now - 450 * day);

    expect(await cleanupExpiredAuditEvents(database, now, 1)).toEqual({
      ok: true,
      value: { deleted: 1 },
    });
    expect(await cleanupExpiredAuditEvents(database, now, 1)).toEqual({
      ok: true,
      value: { deleted: 1 },
    });
    expect(await cleanupExpiredAuditEvents(database, now, 1)).toEqual({
      ok: true,
      value: { deleted: 0 },
    });
  });

  it("refuses any delete of a row inside the retention window", async () => {
    const recent = uniqueOperation("recent-direct");
    await insertAudit(recent, Date.now() - day);

    await expect(
      database
        .prepare("DELETE FROM audit_events WHERE operation_id = ?")
        .bind(recent)
        .run(),
    ).rejects.toThrow(/audit events are retained for 12 months/);

    await expect(
      database.prepare("DELETE FROM audit_events WHERE 1").run(),
    ).rejects.toThrow(/audit events are retained for 12 months/);

    expect(await auditExists(recent)).toBe(true);
  });

  it("cannot over-delete even with a caller clock two years ahead", async () => {
    const now = Date.now();
    const recent = uniqueOperation("future-clock");
    await insertAudit(recent, now - day);

    const result = await cleanupExpiredAuditEvents(
      database,
      now + 2 * 365 * day,
      500,
    );
    expect(result).toEqual({ ok: true, value: { deleted: 0 } });
    expect(await auditExists(recent)).toBe(true);
  });

  it("rejects invalid callers without deleting anything", async () => {
    expect(await cleanupExpiredAuditEvents(database, Number.NaN)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(await cleanupExpiredAuditEvents(database, Date.now(), 0)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(await cleanupExpiredAuditEvents(database, Date.now(), 501)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(
      await cleanupExpiredAuditEvents(database, Date.now(), 1.5),
    ).toEqual({ ok: false, reason: "invalid-input" });
  });

  it("keeps the window at twelve months", () => {
    expect(auditRetentionWindowMs).toBe(365 * day);
  });
});
