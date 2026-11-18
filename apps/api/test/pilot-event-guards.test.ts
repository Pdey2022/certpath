import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { SecurityDatabase } from "../src/security/database.ts";

// 0021's storage guarantees, driven with raw SQL so each one is tested where it
// lives: an address or a space cannot be *stored*, not merely "not sent by the
// route". Every case here fails if its CHECK or trigger is removed from the
// migration - that is what the guard-bite evidence in the PR shows.
//
// The columns are named explicitly (never `INSERT INTO pilot_events VALUES`)
// because the column set is part of the guarantee: a later migration that adds an
// address or a free-text column must change this file.

const database: SecurityDatabase = env.DB;
const clock = Date.parse("2026-02-01T00:00:00.000Z");
const day = 86_400_000;
const session = "session_0123456789abcdef";

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
  occurredAt?: number;
  receivedAt?: number;
  consent?: string;
  anonymousSessionId?: string | null;
  examId?: string | null;
  examVersion?: number | null;
  sampleId?: string | null;
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
    row.occurredAt ?? clock,
    row.receivedAt ?? clock,
    row.consent ?? (row.source === "browser" ? "granted" : "not-required"),
    row.anonymousSessionId === undefined
      ? row.source === "browser"
        ? session
        : null
      : row.anonymousSessionId,
    row.examId ?? null,
    row.examVersion ?? null,
    row.sampleId ?? null,
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
  return {
    source: "browser",
    eventId: `evt_guard_${counter}_${crypto.randomUUID()}`,
    eventName: "exam_viewed",
    examId: "cissp",
    ...overrides,
  };
}

function newServerRow(overrides: Partial<Row> = {}): Row {
  counter += 1;
  return {
    source: "server",
    eventId: `checkout:chk_guard_${counter}`,
    eventName: "checkout_started",
    orderId: `chk_guard_${counter}`,
    productId: "pro-3m",
    currency: "USD",
    amountMinor: 4_900,
    ...overrides,
  };
}

async function countRows(eventId: string): Promise<number> {
  const row = await database
    .prepare("SELECT COUNT(*) AS rows FROM pilot_events WHERE event_id = ?")
    .bind(eventId)
    .first<{ rows: number }>();
  return row?.rows ?? -1;
}

describe("0021 stores no address and no free text", () => {
  it("has exactly the typed columns 0021 declares", async () => {
    const info = await database
      .prepare("PRAGMA table_info(pilot_events)")
      .all<{ name: string }>();
    expect(info.results.map((column) => column.name).sort()).toEqual(
      [...columns].sort(),
    );
    // Nothing that could hold an address, a device fingerprint, a referrer, a
    // URL or a written comment - and no JSON property bag to hide one in.
    for (const forbidden of [
      "email",
      "ip",
      "user_agent",
      "referrer",
      "url",
      "free_text",
      "json",
      "properties",
      "metadata",
    ]) {
      expect(info.results.some((column) => column.name.includes(forbidden))).toBe(
        false,
      );
    }
  });

  it("refuses an address in exam_id", async () => {
    const row = newBrowserRow({ examId: "a@b.com" });
    await expect(insert(row)).rejects.toThrow(/CHECK constraint failed/);
    expect(await countRows(row.eventId)).toBe(0);
  });

  it("refuses a space in product_id", async () => {
    const row = newServerRow({ productId: "pro 3m" });
    await expect(insert(row)).rejects.toThrow(/CHECK constraint failed/);
    expect(await countRows(row.eventId)).toBe(0);
  });

  it("refuses a space in event_id", async () => {
    const row = newBrowserRow({ eventId: "x y zzzzz" });
    await expect(insert(row)).rejects.toThrow(/CHECK constraint failed/);
    expect(await countRows(row.eventId)).toBe(0);
  });

  it("refuses a currency that is not three capitals", async () => {
    for (const currency of ["a@b", "usd", "@@@", "zzz"]) {
      const row = newServerRow({ currency });
      await expect(insert(row), currency).rejects.toThrow(
        /CHECK constraint failed/,
      );
      expect(await countRows(row.eventId), currency).toBe(0);
    }

    const stored = newServerRow({ currency: "USD" });
    await insert(stored);
    expect(await countRows(stored.eventId)).toBe(1);
  });

  it("refuses free text in a band column", async () => {
    const row = newBrowserRow({
      eventName: "sample_completed",
      sampleId: "sample-1",
      resultBand: "hello",
    });
    await expect(insert(row)).rejects.toThrow(/CHECK constraint failed/);
    expect(await countRows(row.eventId)).toBe(0);
  });
});

describe("the per-name field matrix is enforced by storage", () => {
  it("refuses sample_completed without a sample_id", async () => {
    const row = newBrowserRow({ eventName: "sample_completed" });
    await expect(insert(row)).rejects.toThrow(
      /pilot event fields do not match its name/,
    );
    expect(await countRows(row.eventId)).toBe(0);
  });

  it("refuses a result_band on exam_viewed", async () => {
    const row = newBrowserRow({ resultBand: "near" });
    await expect(insert(row)).rejects.toThrow(
      /pilot event fields do not match its name/,
    );
    expect(await countRows(row.eventId)).toBe(0);
  });

  it("refuses checkout_started without an amount", async () => {
    const row = newServerRow({ currency: null, amountMinor: null });
    await expect(insert(row)).rejects.toThrow(
      /pilot event fields do not match its name/,
    );
    expect(await countRows(row.eventId)).toBe(0);
  });

  it("refuses purchase_confirmed without a provider event id", async () => {
    const row = newServerRow({
      eventId: `settlement:evt_guard_${crypto.randomUUID()}`,
      eventName: "purchase_confirmed",
    });
    await expect(insert(row)).rejects.toThrow(
      /pilot event fields do not match its name/,
    );
    expect(await countRows(row.eventId)).toBe(0);
  });

  it("accepts the three server facts the recorder writes", async () => {
    const started = newServerRow();
    await insert(started);
    expect(await countRows(started.eventId)).toBe(1);

    const confirmed = newServerRow({
      eventId: `settlement:evt_guard_${crypto.randomUUID()}`,
      eventName: "purchase_confirmed",
      providerEventId: "evt_guard_1",
    });
    await insert(confirmed);
    expect(await countRows(confirmed.eventId)).toBe(1);

    const pro = newServerRow({
      eventId: `grant:chk_guard_${crypto.randomUUID()}:pro`,
      eventName: "pro_activated",
      examId: "cissp",
      currency: null,
      amountMinor: null,
    });
    await insert(pro);
    expect(await countRows(pro.eventId)).toBe(1);
  });
});

describe("consent cannot be claimed without a signed session", () => {
  it("refuses a browser row that claims no consent was required", async () => {
    // Storage, not the route, is what makes consent a property of the row: a
    // browser event with `consent = 'not-required'` cannot exist, whatever wrote
    // it.
    const row = newBrowserRow({
      consent: "not-required",
      anonymousSessionId: null,
    });
    await expect(insert(row)).rejects.toThrow(/CHECK constraint failed/);
    expect(await countRows(row.eventId)).toBe(0);
  });

  it("refuses consent = granted with no session id", async () => {
    const row = newBrowserRow({ anonymousSessionId: null });
    await expect(insert(row)).rejects.toThrow(/CHECK constraint failed/);
    expect(await countRows(row.eventId)).toBe(0);
  });

  it("refuses a session id on a server row", async () => {
    const row = newServerRow({ anonymousSessionId: session });
    await expect(insert(row)).rejects.toThrow(/CHECK constraint failed/);
    expect(await countRows(row.eventId)).toBe(0);
  });

  it("refuses an occurred_at more than five minutes in the future", async () => {
    const row = newBrowserRow({ occurredAt: clock + 6 * 60_000 });
    await expect(insert(row)).rejects.toThrow(/CHECK constraint failed/);
    expect(await countRows(row.eventId)).toBe(0);
  });
});

describe("a browser cannot claim a server fact", () => {
  it("refuses a browser purchase_confirmed", async () => {
    const row = newBrowserRow({
      eventId: `settlement:forged_${crypto.randomUUID()}`,
      eventName: "purchase_confirmed",
      examId: null,
      orderId: "chk_forged",
      productId: "pro-3m",
      providerEventId: "evt_forged",
      currency: "USD",
      amountMinor: 4_900,
    });
    await expect(insert(row)).rejects.toThrow(
      /a browser event cannot claim a server fact/,
    );
    expect(await countRows(row.eventId)).toBe(0);
  });
});

describe("the vocabulary is a table, not a convention", () => {
  it("aborts an unknown event name and keeps the FK", async () => {
    const row = newServerRow({ eventName: "not_a_name" });
    await expect(insert(row)).rejects.toThrow(
      /pilot event fields do not match its name/,
    );
    expect(await countRows(row.eventId)).toBe(0);

    // The matrix trigger refuses an unknown name before the foreign key can, so
    // the FK is asserted where it is observable - the declared constraint.
    const foreignKeys = await database
      .prepare("PRAGMA foreign_key_list(pilot_events)")
      .all<{ table: string; from: string; to: string; on_delete: string }>();
    expect(foreignKeys.results).toEqual([
      expect.objectContaining({
        table: "pilot_event_names",
        from: "event_name",
        to: "name",
        on_delete: "RESTRICT",
      }),
    ]);
  });

  it("refuses to delete or rewrite a name rows reference", async () => {
    const row = newBrowserRow();
    await insert(row);

    await expect(
      database
        .prepare("DELETE FROM pilot_event_names WHERE name = 'exam_viewed'")
        .run(),
    ).rejects.toThrow(/pilot event vocabulary is append-only/);
    await expect(
      database
        .prepare("UPDATE pilot_event_names SET name = 'renamed' WHERE name = 'exam_viewed'")
        .run(),
    ).rejects.toThrow(/pilot event vocabulary is append-only/);
    const names = await database
      .prepare("SELECT COUNT(*) AS rows FROM pilot_event_names")
      .first<{ rows: number }>();
    expect(names?.rows).toBe(11);
  });
});

describe("rows are append-only", () => {
  it("refuses an UPDATE", async () => {
    const row = newBrowserRow();
    await insert(row);

    await expect(
      database
        .prepare("UPDATE pilot_events SET event_name = 'sample_started' WHERE event_id = ?")
        .bind(row.eventId)
        .run(),
    ).rejects.toThrow(/pilot events are append-only/);

    const stored = await database
      .prepare("SELECT event_name FROM pilot_events WHERE event_id = ?")
      .bind(row.eventId)
      .first<{ event_name: string }>();
    expect(stored?.event_name).toBe("exam_viewed");
  });

  it("refuses INSERT OR REPLACE that would rewrite the content (0016's hole)", async () => {
    const row = newBrowserRow();
    await insert(row);

    await expect(
      database
        .prepare(insertSql("INSERT OR REPLACE"))
        .bind(...values({ ...row, eventName: "sample_started", sampleId: "s-1" }))
        .run(),
    ).rejects.toThrow(/pilot events are append-only/);

    const stored = await database
      .prepare("SELECT event_name, sample_id FROM pilot_events WHERE event_id = ?")
      .bind(row.eventId)
      .first<{ event_name: string; sample_id: string | null }>();
    expect(stored).toEqual({ event_name: "exam_viewed", sample_id: null });
  });

  it("lets an identical resubmission collapse instead of aborting", async () => {
    // The recorder depends on this: a key-only replace guard would abort the
    // `ON CONFLICT DO NOTHING` that dedupe is built on. The guard compares
    // content, so the identical row is a no-op and the row survives.
    const row = newBrowserRow();
    await insert(row);

    const again = await database
      .prepare(`${insertSql()} ON CONFLICT (source, event_id) DO NOTHING`)
      .bind(...values(row))
      .run();
    expect(again.meta.changes).toBe(0);
    expect(await countRows(row.eventId)).toBe(1);
  });

  it("inventories the delete floor 0022 adds", async () => {
    // 0021 shipped no delete-floor trigger on purpose; 0022 lands it together
    // with the scheduled prune. The inventory is exact, so a later migration that
    // adds or drops a trigger has to change this test deliberately.
    const triggers = await database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger' AND tbl_name IN ('pilot_events', 'pilot_event_names')
         ORDER BY name`,
      )
      .all<{ name: string }>();
    expect(triggers.results.map((trigger) => trigger.name)).toEqual([
      "pilot_event_names_no_delete",
      "pilot_event_names_no_update",
      "pilot_events_browser_cannot_claim_server_event",
      "pilot_events_no_delete",
      "pilot_events_no_replace",
      "pilot_events_no_update",
      "pilot_events_validate_insert",
    ]);
  });

  it("lets a twelve-month-old row be deleted while a young one is refused", async () => {
    // The D1 clock decides, not the fixture clock: both timestamps are relative
    // to `Date.now()` so "twelve months old" means the same thing the trigger
    // measures.
    const now = Date.now();
    const old = newBrowserRow({
      occurredAt: now - 366 * day,
      receivedAt: now - 366 * day,
    });
    const young = newBrowserRow();
    await insert(old);
    await insert(young);

    await expect(
      database
        .prepare("DELETE FROM pilot_events WHERE event_id = ?")
        .bind(young.eventId)
        .run(),
    ).rejects.toThrow(/pilot events are retained for 12 months/);
    expect(await countRows(young.eventId)).toBe(1);

    await database
      .prepare("DELETE FROM pilot_events WHERE event_id = ?")
      .bind(old.eventId)
      .run();
    expect(await countRows(old.eventId)).toBe(0);
  });
});
