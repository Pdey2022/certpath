import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  cleanupExpiredPilotEvents,
  pilotEventRetentionMaxBatch,
  pilotEventRetentionWindowMs,
  pilotEventsRetentionEnabled,
} from "../src/analytics/pilot-events-retention.ts";
import { schedulePilotEventRetention } from "../../web/workers/pilot-events-retention-schedule.ts";

// Every committed Worker config, so a new `wrangler*.jsonc` in any workspace
// that declares the events flags cannot escape the coupling rule below. The
// patterns are the npm workspaces (`apps/*`, `packages/*`) plus the repository
// root; the coverage assertions below fail if they stop matching.
const wranglerConfigs: Record<string, string> = import.meta.glob(
  [
    "../../*/wrangler*.jsonc",
    "../../../packages/*/wrangler*.jsonc",
    "../../../wrangler*.jsonc",
  ],
  { query: "?raw", import: "default", eager: true },
);

// The staging entry point, read as text: it imports `./app`, which pulls React
// Router and the `virtual:react-router/server-build` bundle, so it can be
// bundled for the Worker but not imported here. Its wiring is asserted below
// instead.
const stagingAppSource: Record<string, string> = import.meta.glob(
  "../../web/workers/staging-app.ts",
  { query: "?raw", import: "default", eager: true },
);

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

const eventsFlags = [
  "PILOT_EVENTS_ENABLED",
  "PILOT_SERVER_EVENTS_ENABLED",
] as const;
const retentionFlag = "PILOT_EVENTS_RETENTION_ENABLED";

/** A quoted var value from a `wrangler*.jsonc`, comments and all. */
function declaredFlag(source: string, name: string): string | null {
  const match = new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(source);
  return match ? match[1] : null;
}

/**
 * The coupling rule, as a pure function so it can be driven by inputs that do
 * not exist in the repository. An events flag set to "true" while
 * `PILOT_EVENTS_RETENTION_ENABLED` is not "true" - including absent - is a
 * violation: enabling event capture would promise a twelve-month period that
 * nothing delivers.
 */
function couplingViolations(source: string): string[] {
  const retention = declaredFlag(source, retentionFlag);
  if (retention === "true") return [];
  return eventsFlags
    .filter((name) => declaredFlag(source, name) === "true")
    .map(
      (name) =>
        `${name} is "true" but ${retentionFlag} is ${String(retention)}`,
    );
}

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

  it("refuses an events flag in every wrangler config without the retention flag", () => {
    // Read from the committed configurations, not from copies: the retention
    // job is the only thing that delivers the 12-month period, so enabling event
    // capture while it is off would promise a period nothing enforces. The scan
    // covers every `wrangler*.jsonc`, and a config that declares no events flag
    // is out of scope by construction rather than by being missed.
    const covered = Object.entries(wranglerConfigs).filter(([, source]) =>
      eventsFlags.some((name) => declaredFlag(source, name) !== null),
    );
    expect(covered.length).toBeGreaterThan(0);
    expect(covered.map(([file]) => file).join("\n")).toContain(
      "wrangler.jsonc",
    );
    // Staging declares the events flags since #141, so the widened glob must
    // reach it: a pattern that silently skips the events target would leave
    // that config's coupling unchecked.
    expect(covered.map(([file]) => file).join("\n")).toContain(
      "wrangler.staging.jsonc",
    );

    for (const [file, source] of covered) {
      expect(couplingViolations(source), file).toEqual([]);
      // No flag is enabled in this milestone; enabling one is an owner decision
      // that changes this assertion on purpose.
      expect(declaredFlag(source, retentionFlag), file).toBe("false");
    }
  });

  it("proves the coupling rule bites on an enabled events flag", () => {
    // The committed configs all hold the rule, so the rule itself would never be
    // exercised by them alone. These inputs do not exist in the repository on
    // purpose: if `couplingViolations` is loosened to accept anything, the two
    // violation cases fail.
    expect(
      couplingViolations(
        `"PILOT_EVENTS_ENABLED": "true"`,
      ),
    ).toEqual([
      'PILOT_EVENTS_ENABLED is "true" but PILOT_EVENTS_RETENTION_ENABLED is null',
    ]);

    expect(
      couplingViolations(
        `"PILOT_EVENTS_RETENTION_ENABLED": "false",
         "PILOT_SERVER_EVENTS_ENABLED": "true"`,
      ),
    ).toEqual([
      'PILOT_SERVER_EVENTS_ENABLED is "true" but PILOT_EVENTS_RETENTION_ENABLED is false',
    ]);

    // The one shape the rule must accept: both events flags on, retention on.
    expect(
      couplingViolations(
        `"PILOT_EVENTS_RETENTION_ENABLED": "true",
         "PILOT_EVENTS_ENABLED": "true",
         "PILOT_SERVER_EVENTS_ENABLED": "true"`,
      ),
    ).toEqual([]);
  });
});

/**
 * A `pilot_events` access path that records every statement it is asked to
 * prepare. The prune reaches a row only through `prepare`, so an empty list is
 * proof that the job read no row.
 */
function recordingDatabase(inner: SecurityDatabase) {
  const statements: string[] = [];
  const db: SecurityDatabase = {
    prepare(query) {
      statements.push(query);
      return inner.prepare(query);
    },
    withSession(constraint) {
      return inner.withSession(constraint);
    },
    batch(items) {
      return inner.batch(items);
    },
  };
  return { db, statements };
}

/** A `scheduled` context that keeps the promises the job hands it. */
function recordingContext() {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    },
  };
}

// #136, for the Worker #141 made the events target. The staging Worker's
// `scheduled` handler is `schedulePilotEventRetention` in
// `apps/web/workers/pilot-events-retention-schedule.ts`, driven here against the
// same real 0022 schema as the tests above: the flag-off direction is the one
// that has to fail if the gate moves inside `ctx.waitUntil`, because a no-op
// that still prepares a statement is not a no-op.
describe("the staging scheduled handler gates the pilot-event prune", () => {
  it('prepares no statement and reads no row when the flag is absent or not exactly "true"', async () => {
    const retained = oldRow();
    await insert(retained);

    for (const bindings of [
      {},
      { PILOT_EVENTS_RETENTION_ENABLED: "false" },
      { PILOT_EVENTS_RETENTION_ENABLED: "TRUE" },
      { PILOT_EVENTS_RETENTION_ENABLED: " true" },
    ]) {
      const recorded = recordingDatabase(database);
      const { ctx, pending } = recordingContext();

      schedulePilotEventRetention({ DB: recorded.db, ...bindings }, ctx);

      expect(recorded.statements, JSON.stringify(bindings)).toEqual([]);
      expect(pending, JSON.stringify(bindings)).toHaveLength(0);
    }

    expect(await exists(retained)).toBe(1);

    // The row was genuinely prunable, and it leaves the fixture here: the batch
    // test above counts deletes and would otherwise see this row.
    expect(await cleanupExpiredPilotEvents(database, Date.now())).toEqual({
      ok: true,
      value: { deleted: 1 },
    });
  });

  it('runs the prune and deletes only aged rows when the flag is exactly "true"', async () => {
    const aged = oldRow();
    const young = newBrowserRow();
    await insert(aged);
    await insert(young);

    const recorded = recordingDatabase(database);
    const { ctx, pending } = recordingContext();

    schedulePilotEventRetention(
      { DB: recorded.db, PILOT_EVENTS_RETENTION_ENABLED: "true" },
      ctx,
    );

    expect(recorded.statements).toHaveLength(1);
    expect(recorded.statements[0]).toMatch(/^DELETE FROM pilot_events\b/);
    await Promise.all(pending);

    expect(await exists(aged)).toBe(0);
    expect(await exists(young)).toBe(1);
  });

  it("throws only the failure reason when the prune refuses its input", async () => {
    const aged = oldRow();
    await insert(aged);
    const recorded = recordingDatabase(database);
    const { ctx, pending } = recordingContext();

    schedulePilotEventRetention(
      { DB: recorded.db, PILOT_EVENTS_RETENTION_ENABLED: "true" },
      ctx,
      Number.NaN,
    );

    // The refusal happens before a statement exists, so no row is read either.
    expect(recorded.statements).toEqual([]);
    const failure = await pending[0].catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "Pilot event retention cleanup failed: invalid-input",
    );
    expect(await exists(aged)).toBe(1);
  });

  it("is wired into the staging entry point beside its cron", () => {
    const sources = Object.values(stagingAppSource);
    expect(sources).toHaveLength(1);
    const source = sources[0];
    // A `scheduled` handler that never calls the gate - or one that borrowed
    // `app.ts`'s handler and would also run question-import cleanup, audit
    // retention and commerce expiry - fails here.
    expect(source).toMatch(/scheduled\(_controller, env, ctx\)/);
    expect(source).toMatch(/schedulePilotEventRetention\(env, ctx\)/);

    const staging = Object.entries(wranglerConfigs).find(([file]) =>
      file.endsWith("/wrangler.staging.jsonc"),
    );
    expect(staging, "wrangler.staging.jsonc").toBeDefined();
    // No cron, no invocation: the declared schedule is part of the delivery.
    expect(staging?.[1]).toMatch(
      /"crons"\s*:\s*\[\s*"\*\/5 \* \* \* \*"\s*\]/,
    );
  });
});
