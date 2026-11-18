import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  cleanupExpiredPilotEvents,
  pilotEventRetentionMaxBatch,
  pilotEventRetentionWindowMs,
  pilotEventsRetentionEnabled,
} from "../src/analytics/pilot-events-retention.ts";
import wranglerConfig from "../../web/wrangler.jsonc?raw";

// 0022's retention floor and the scheduled prune, driven against the real
// schema. The "12 months old" fixture is `Date.now() - 366 * day` and there is no
// clock control: the trigger compares `received_at` with D1's own `strftime`, so
// a mocked `Date.now()` would test a clock the floor does not use.
//
// The columns are named explicitly, as in `pilot-event-guards.test.ts`, because
// the column set is part of the guarantee.

const database: SecurityDatabase = env.DB;
const day = 86_400_000;
const session = "session_retention_0123456";

const columns = [
  "source",
  "event_id",
  "event_name",
  "schema_version",
  "occurred_at",
  "received_at",
  "consent",
  "anonymous_session_id",
  "exam_id",
  "exam_version",
  "sample_id",
  "order_id",
  "product_id",
  "provider_event_id",
  "currency",
  "amount_minor",
  "result_band",
  "question_count_band",
];

interface Row {
  source: string;
  eventId: string;
  eventName: string;
  occurredAt: number;
  receivedAt: number;
  consent?: string;
  anonymousSessionId?: string | null;
  examId?: string | null;
  orderId?: string | null;
  productId?: string | null;
  providerEventId?: string | null;
  currency?: string | null;
  amountMinor?: number | null;
  resultBand?: string | null;
  questionCountBand?: string | null;
}

function values(row: Row): (string | number | null)[] {
  return [
    row.source,
    row.eventId,
    row.eventName,
    1,
    row.occurredAt,
    row.receivedAt,
    row.consent ?? (row.source === "browser" ? "granted" : "not-required"),
    row.anonymousSessionId === undefined
      ? row.source === "browser"
        ? session
        : null
      : row.anonymousSessionId,
    row.examId ?? null,
    null,
    null,
    row.orderId ?? null,
    row.productId ?? null,
    row.providerEventId ?? null,
    row.currency ?? null,
    row.amountMinor ?? null,
    row.resultBand ?? null,
    row.questionCountBand ?? null,
  ];
}

function insertSql(prefix = "INSERT"): string {
  return `${prefix} INTO pilot_events (${columns.join(", ")})
          VALUES (${columns.map(() => "?").join(", ")})`;
}

async function insert(row: Row) {
  return database.prepare(insertSql()).bind(...values(row)).run();
}

let counter = 0;
function newBrowserRow(overrides: Partial<Row> = {}): Row {
  counter += 1;
  const at = overrides.receivedAt ?? Date.now() - day;
  return {
    source: "browser",
    eventId: `evt_retention_${counter}_${crypto.randomUUID()}`,
    eventName: "exam_viewed",
    occurredAt: at,
    receivedAt: at,
    examId: "cissp",
    ...overrides,
  };
}

function newServerRow(overrides: Partial<Row> = {}): Row {
  counter += 1;
  const at = overrides.receivedAt ?? Date.now() - day;
  return {
    source: "server",
    eventId: `checkout:chk_retention_${counter}`,
    eventName: "checkout_started",
    occurredAt: at,
    receivedAt: at,
    orderId: `chk_retention_${counter}`,
    productId: "pro-3m",
    currency: "USD",
    amountMinor: 4_900,
    ...overrides,
  };
}

/** A row stored 366 days ago on both clocks, so 0021's skew CHECK passes. */
function oldRow(overrides: Partial<Row> = {}): Row {
  const at = Date.now() - 366 * day;
  return newBrowserRow({ occurredAt: at, receivedAt: at, ...overrides });
}

async function countRows(source: string, eventId: string): Promise<number> {
  const row = await database
    .prepare(
      "SELECT COUNT(*) AS rows FROM pilot_events WHERE source = ? AND event_id = ?",
    )
    .bind(source, eventId)
    .first<{ rows: number }>();
  return row?.rows ?? -1;
}

function exists(row: Row): Promise<number> {
  return countRows(row.source, row.eventId);
}

describe("0022 gives pilot events a twelve-month floor", () => {
  it("deletes only rows older than the window and reports the count", async () => {
    const now = Date.now();
    const outside = oldRow({
      receivedAt: now - 400 * day,
      occurredAt: now - 400 * day,
    });
    const justOutside = oldRow();
    const inside = newBrowserRow({
      receivedAt: now - 364 * day,
      occurredAt: now - 364 * day,
    });
    await insert(outside);
    await insert(justOutside);
    await insert(inside);

    expect(await cleanupExpiredPilotEvents(database, now)).toEqual({
      ok: true,
      value: { deleted: 2 },
    });
    expect(await exists(outside)).toBe(0);
    expect(await exists(justOutside)).toBe(0);
    expect(await exists(inside)).toBe(1);
  });

  it("is idempotent on a second run", async () => {
    expect(await cleanupExpiredPilotEvents(database, Date.now())).toEqual({
      ok: true,
      value: { deleted: 0 },
    });
  });

  it("deletes at most the bounded batch size per call", async () => {
    const first = oldRow();
    const second = oldRow();
    await insert(first);
    await insert(second);

    expect(await cleanupExpiredPilotEvents(database, Date.now(), 1)).toEqual({
      ok: true,
      value: { deleted: 1 },
    });
    expect(await cleanupExpiredPilotEvents(database, Date.now(), 1)).toEqual({
      ok: true,
      value: { deleted: 1 },
    });
    expect(await cleanupExpiredPilotEvents(database, Date.now(), 1)).toEqual({
      ok: true,
      value: { deleted: 0 },
    });
  });

  it("refuses any delete of a row inside the window", async () => {
    const recent = newBrowserRow();
    await insert(recent);

    await expect(
      database
        .prepare("DELETE FROM pilot_events WHERE source = ? AND event_id = ?")
        .bind(recent.source, recent.eventId)
        .run(),
    ).rejects.toThrow(/pilot events are retained for 12 months/);

    await expect(
      database.prepare("DELETE FROM pilot_events WHERE 1").run(),
    ).rejects.toThrow(/pilot events are retained for 12 months/);

    expect(await exists(recent)).toBe(1);
  });

  it("cannot over-delete even with a caller clock two years ahead", async () => {
    const recent = newBrowserRow();
    await insert(recent);

    expect(
      await cleanupExpiredPilotEvents(database, Date.now() + 2 * 365 * day),
    ).toEqual({ ok: true, value: { deleted: 0 } });
    expect(await exists(recent)).toBe(1);
  });

  it("prunes a twelve-month-old row while a young row in the same fixture survives", async () => {
    const old = oldRow();
    const young = newBrowserRow();
    await insert(old);
    await insert(young);

    expect(await cleanupExpiredPilotEvents(database, Date.now())).toEqual({
      ok: true,
      value: { deleted: 1 },
    });
    expect(await exists(old)).toBe(0);
    expect(await exists(young)).toBe(1);
  });

  it("deletes by rowid, so a young row in another source with the same event_id survives", async () => {
    // `event_id` is unique only per `source`. An `event_id IN (...)` delete would
    // reach the server row this run never selected, which is why the prune
    // addresses `rowid`.
    const sharedId = "shared_retention_id_0001";
    const oldBrowser = oldRow({ eventId: sharedId });
    const youngServer = newServerRow({ eventId: sharedId });
    await insert(oldBrowser);
    await insert(youngServer);

    expect(await cleanupExpiredPilotEvents(database, Date.now())).toEqual({
      ok: true,
      value: { deleted: 1 },
    });
    expect(await countRows("browser", sharedId)).toBe(0);
    expect(await countRows("server", sharedId)).toBe(1);
  });

  it("rejects invalid callers without deleting anything", async () => {
    const old = oldRow();
    await insert(old);

    expect(await cleanupExpiredPilotEvents(database, Number.NaN)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(await cleanupExpiredPilotEvents(database, 0)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(await cleanupExpiredPilotEvents(database, Date.now(), 0)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(
      await cleanupExpiredPilotEvents(
        database,
        Date.now(),
        pilotEventRetentionMaxBatch + 1,
      ),
    ).toEqual({ ok: false, reason: "invalid-input" });
    expect(await cleanupExpiredPilotEvents(database, Date.now(), 1.5)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(await exists(old)).toBe(1);

    // The rejected row was genuinely prunable: a valid call removes it.
    expect(await cleanupExpiredPilotEvents(database, Date.now())).toEqual({
      ok: true,
      value: { deleted: 1 },
    });
  });

  it("keeps received_at fixed through an identical INSERT OR REPLACE", async () => {
    const row = newBrowserRow();
    await insert(row);

    const again = await database
      .prepare(insertSql("INSERT OR REPLACE"))
      .bind(...values(row))
      .run();
    expect(again.meta.changes).toBe(1);
    expect(await exists(row)).toBe(1);

    const stored = await database
      .prepare(
        "SELECT received_at FROM pilot_events WHERE source = ? AND event_id = ?",
      )
      .bind(row.source, row.eventId)
      .first<{ received_at: number }>();
    expect(stored?.received_at).toBe(row.receivedAt);

    // 0021's content-comparing guard is what makes the prune's window
    // un-refreshable: a REPLACE cannot move `received_at` forward.
    await expect(
      database
        .prepare(insertSql("INSERT OR REPLACE"))
        .bind(
          ...values({
            ...row,
            receivedAt: row.receivedAt + day,
            occurredAt: row.occurredAt,
          }),
        )
        .run(),
    ).rejects.toThrow(/pilot events are append-only/);
  });

  it("keeps the window at twelve months and the batch at 250 rows", () => {
    expect(pilotEventRetentionWindowMs).toBe(31_536_000_000);
    expect(pilotEventRetentionWindowMs).toBe(365 * day);
    expect(pilotEventRetentionMaxBatch).toBe(250);
    // 288 runs a day (every five minutes) x 250 rows stays under D1 Free's
    // 100,000 writes a day, with headroom; 500 would reach 144,000.
    expect(288 * pilotEventRetentionMaxBatch).toBe(72_000);
  });
});

describe("PILOT_EVENTS_RETENTION_ENABLED is an exact-string gate", () => {
  it('accepts only the exact string "true"', () => {
    expect(
      pilotEventsRetentionEnabled({ PILOT_EVENTS_RETENTION_ENABLED: "true" }),
    ).toBe(true);
    for (const value of ["TRUE", "True", " true", "true ", "1", "yes", "", "false"]) {
      expect(
        pilotEventsRetentionEnabled({ PILOT_EVENTS_RETENTION_ENABLED: value }),
        JSON.stringify(value),
      ).toBe(false);
    }
    expect(pilotEventsRetentionEnabled({})).toBe(false);
  });

  it("refuses an events flag in wrangler.jsonc without the retention flag", () => {
    // Read from the committed configuration, not from a copy: the retention job
    // is the only thing that delivers the 12-month period, so enabling event
    // capture while it is off would promise a period nothing enforces.
    function flag(name: string): string | null {
      const match = new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(
        wranglerConfig,
      );
      return match ? match[1] : null;
    }

    const retention = flag("PILOT_EVENTS_RETENTION_ENABLED");
    expect(retention).not.toBeNull();
    // No flag is enabled in this milestone; enabling one is an owner decision
    // that changes this line on purpose.
    expect(retention).toBe("false");

    for (const name of ["PILOT_EVENTS_ENABLED", "PILOT_SERVER_EVENTS_ENABLED"]) {
      const value = flag(name);
      expect(value, `${name} must be declared`).not.toBeNull();
      if (value === "true") {
        expect(
          retention,
          `${name} is "true" but PILOT_EVENTS_RETENTION_ENABLED is ${retention}`,
        ).toBe("true");
      }
    }
  });
});
