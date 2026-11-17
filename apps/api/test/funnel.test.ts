import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  funnelMeasurementSql,
  proFunnelProducts,
  readPilotFunnel,
} from "../src/analytics/funnel.ts";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  createTestCertification,
  createTestLearnerUser,
} from "./factories.ts";

// The funnel measurement: a ledger-derived conversion rate with the event side
// beside it, so a lost event is a number (`eventGap`) rather than a quietly
// better ratio.
//
// The cohort comes from `commerce_checkouts`, which is why these tests write
// commerce rows directly: the point is the measurement, not the checkout route.

const database: SecurityDatabase = env.DB;
const clock = Date.parse("2026-02-01T00:00:00.000Z");
const day = 86_400_000;
const windowFrom = clock;
const windowTo = clock + 7 * day;

async function checkout(options: {
  sku?: string;
  amountMinor?: number;
  status?: "pending" | "paid" | "failed" | "expired" | "needs_support" | "refunded";
  createdAt?: number;
}): Promise<string> {
  const userId = await createTestLearnerUser(database);
  const certificationId = await createTestCertification(database, userId);
  const status = options.status ?? "pending";
  const createdAt = options.createdAt ?? clock + day;
  const paid = status === "paid" || status === "refunded" || status === "needs_support";
  const id = `chk_${crypto.randomUUID()}`;
  await database
    .prepare(
      `INSERT INTO commerce_checkouts (
         id, user_id, certification_id, sku, client_checkout_key,
         request_fingerprint, currency, total_minor, status, provider,
         provider_session_id, provider_redirect_url, created_at, updated_at,
         expires_at, paid_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'USD', ?, ?, 'fake', NULL, NULL, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      userId,
      certificationId,
      options.sku ?? "standard-3m",
      `key_${crypto.randomUUID()}`,
      "0".repeat(64),
      options.amountMinor ?? 5_900,
      status,
      createdAt,
      createdAt,
      createdAt + 30 * 60 * 1000,
      paid ? createdAt : null,
    )
    .run();
  return id;
}

let eventCounter = 0;
async function checkoutStartedEvent(options: {
  productId?: string;
  amountMinor?: number;
  receivedAt?: number;
}): Promise<string> {
  eventCounter += 1;
  const eventId = `checkout:funnel_${eventCounter}_${crypto.randomUUID()}`;
  await database
    .prepare(
      `INSERT INTO pilot_events (
         source, event_id, event_name, schema_version, occurred_at, received_at,
         consent, anonymous_session_id, order_id, product_id, currency,
         amount_minor
       ) VALUES ('server', ?, 'checkout_started', 1, ?, ?, 'not-required',
                 NULL, ?, ?, 'USD', ?)`,
    )
    .bind(
      eventId,
      options.receivedAt ?? clock + day,
      options.receivedAt ?? clock + day,
      eventId.slice("checkout:".length),
      options.productId ?? "standard-3m",
      options.amountMinor ?? 5_900,
    )
    .run();
  return eventId;
}

describe("readPilotFunnel", () => {
  it("returns no rows for an empty window - 'no data', not a zero", async () => {
    const rows = await readPilotFunnel(database, {
      from: clock,
      to: clock + 60_000,
      products: null,
    });

    expect(rows).toEqual([]);
  });

  it("reports a gap when checkouts exist and events do not", async () => {
    const from = clock + 30 * day;
    const to = from + day;
    await checkout({ createdAt: from + 1_000 });
    await checkout({ createdAt: from + 2_000, status: "paid" });

    const rows = await readPilotFunnel(database, { from, to, products: null });

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.checkoutsCreated).toBe(2);
    expect(row.checkoutsPaid).toBe(1);
    expect(row.checkoutStartsFromEvents).toBe(0);
    expect(row.eventGap).toBe(2);
    // The rate is ledger-derived: it does not fall because no event arrived.
    expect(row.conversionRate).toBeCloseTo(0.5, 10);
    expect(Number.isFinite(row.conversionRate!)).toBe(true);
  });

  it("counts a cohort on created_at across paid, refunded, parked and expired", async () => {
    const from = clock + 60 * day;
    const to = from + day;
    const at = from + 1_000;
    await checkout({ createdAt: at, status: "paid" });
    await checkout({ createdAt: at, status: "paid" });
    await checkout({ createdAt: at, status: "refunded" });
    await checkout({ createdAt: at, status: "needs_support" });
    await checkout({ createdAt: at, status: "expired" });
    await checkoutStartedEvent({ receivedAt: at });
    await checkoutStartedEvent({ receivedAt: at });

    const rows = await readPilotFunnel(database, { from, to, products: null });

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.productId).toBe("standard-3m");
    expect(row.currency).toBe("USD");
    expect(row.amountMinor).toBe(5_900);
    expect(row.checkoutsCreated).toBe(5);
    expect(row.checkoutsPaid).toBe(2);
    expect(row.checkoutsRefunded).toBe(1);
    expect(row.checkoutsNotConverting).toBe(2);
    expect(row.checkoutStartsFromEvents).toBe(2);
    expect(row.eventGap).toBe(3);
    expect(row.conversionRate).toBeCloseTo(0.4, 10);
    // Server-originated events carry no session by construction, so this reads 0
    // until the owner rules on consent for server events.
    expect(row.consentedSessions).toBe(0);
  });

  it("makes a lost event visible: delete one and the gap grows", async () => {
    const from = clock + 90 * day;
    const to = from + day;
    const at = from + 1_000;
    await checkout({ createdAt: at, status: "paid" });
    await checkout({ createdAt: at, status: "paid" });
    await checkoutStartedEvent({ receivedAt: at });
    const lost = await checkoutStartedEvent({ receivedAt: at });

    const before = (
      await readPilotFunnel(database, { from, to, products: null })
    )[0]!;
    expect(before.eventGap).toBe(0);

    // No delete guard exists in 0021 (retention enforcement is a follow-up), so
    // this is exactly what a dropped write would look like afterwards.
    await database
      .prepare("DELETE FROM pilot_events WHERE event_id = ?")
      .bind(lost)
      .run();

    const after = (
      await readPilotFunnel(database, { from, to, products: null })
    )[0]!;
    expect(after.checkoutStartsFromEvents).toBe(1);
    expect(after.eventGap).toBe(1);
    // The conversion rate cannot move with the event count.
    expect(after.conversionRate).toBe(before.conversionRate);
  });

  it("windows on the server clock, not on the row's own bounds", async () => {
    const from = clock + 120 * day;
    const to = from + day;
    await checkout({ createdAt: from - 1 }); // just outside
    await checkout({ createdAt: to }); // the upper bound is exclusive
    await checkoutStartedEvent({ receivedAt: from - 1 });
    await checkout({ createdAt: from + 1 });

    const rows = await readPilotFunnel(database, { from, to, products: null });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.checkoutsCreated).toBe(1);
    expect(rows[0]!.checkoutStartsFromEvents).toBe(0);
    expect(rows[0]!.eventGap).toBe(1);
  });

  it("filters to the Pro products with the same query", async () => {
    const from = clock + 150 * day;
    const to = from + day;
    const at = from + 1_000;
    await checkout({ createdAt: at, sku: "standard-3m", amountMinor: 5_900 });
    await checkout({ createdAt: at, sku: "pro-3m", amountMinor: 4_900 });
    await checkout({
      createdAt: at,
      sku: "bundle-standard-3m-pro",
      amountMinor: 8_900,
    });

    const all = await readPilotFunnel(database, { from, to, products: null });
    const pro = await readPilotFunnel(database, {
      from,
      to,
      products: [...proFunnelProducts],
    });

    expect(all.map((row) => row.productId).sort()).toEqual([
      "bundle-standard-3m-pro",
      "pro-3m",
      "standard-3m",
    ]);
    expect(pro.map((row) => row.productId).sort()).toEqual([
      "bundle-standard-3m-pro",
      "pro-3m",
    ]);
  });

  it("never divides by zero: the NULLIF guard answers null, not Infinity", async () => {
    // A GROUP BY cannot produce `checkoutsCreated = 0` (a group exists because it
    // has rows), so the guard is defensive - and asserted at the expression:
    const guard = await database
      .prepare(
        `SELECT CAST(?1 AS REAL) / NULLIF(?2, 0) AS rate,
                CAST(2 AS REAL) / NULLIF(?2, 0) AS positive`,
      )
      .bind(0, 0)
      .first<{ rate: number | null; positive: number | null }>();
    expect(guard?.rate).toBeNull();
    expect(guard?.positive).toBeNull();

    // ...and every row the measurement returns carries a real number or null,
    // never Infinity or NaN.
    const rows = await readPilotFunnel(database, {
      from: clock,
      to: clock + 365 * day,
      products: null,
    });
    for (const row of rows) {
      const rate = row.conversionRate;
      expect(rate === null || Number.isFinite(rate), row.productId).toBe(true);
      expect(row.eventGap).toBe(
        row.checkoutsCreated - row.checkoutStartsFromEvents,
      );
    }
  });

  it("keeps the exported SQL usable by an operator on D1", async () => {
    // The operator path is the same statement the module runs: no bind helper, no
    // client-side arithmetic.
    expect(funnelMeasurementSql).toContain("commerce_checkouts");
    expect(funnelMeasurementSql).toContain("pilot_events");
    expect(funnelMeasurementSql).toContain("NULLIF(c.checkoutsCreated, 0)");
  });
});
