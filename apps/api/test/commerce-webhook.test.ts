import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { commerceCheckoutResponseSchema } from "@certpath/contracts";
import { createApi } from "../src/index.ts";
import { addTerm } from "../src/calendar.ts";
import { proTerm, termFor, type Sku } from "../src/pricing.ts";
import { expireStaleCheckouts } from "../src/commerce/expire.ts";
import { grantOperationId } from "../src/commerce/checkouts.ts";
import { createFakeProvider } from "../src/commerce/providers/fake.ts";
import type { ProviderEvent } from "../src/commerce/provider.ts";
import {
  applySettlement,
  buildSettlementPlan,
  readAccountGrants,
  readCheckoutForSession,
  readSnapshotLines,
  settlementAttempts,
} from "../src/commerce/webhooks.ts";
import { createCsrfToken, sessionDigest } from "../src/security/http-session.ts";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  createProEnablement,
  createTestCertification,
  createTestIdentity,
  createTestLearnerUser,
  createTestSessionCredentials,
  grantTestFeatureAccess,
} from "./factories.ts";

// The webhook and the settlement batch.
//
// The rule under test throughout: a learner has access because a row in
// `learner_access_grants` exists, and every other row the batch writes is a
// witness of the same transaction. So each test asserts the grant set *and* what
// the batch left behind when it declined to grant.

const database: SecurityDatabase = env.DB;
const origin = "https://localhost";
const csrfSecret = "local-worker-test-csrf-secret-with-enough-entropy";
const webhookSecret = "local-commerce-webhook-secret-with-enough-bytes";
const day = 86_400_000;
const clock = Date.parse("2026-02-01T00:00:00.000Z");

const fakeProvider = createFakeProvider({
  secret: webhookSecret,
  now: () => clock,
  origin,
});

const application = createApi(
  fetch,
  () => clock,
  undefined,
  undefined,
  fakeProvider,
);

const bindings = {
  DB: database,
  PUBLIC_SITE_ORIGIN: origin,
  CSRF_HMAC_SECRET: csrfSecret,
  COMMERCE_ENABLED: "true",
  PAYMENT_PROVIDER: "fake",
  COMMERCE_WEBHOOK_SECRET: webhookSecret,
  LOCAL_COMMERCE_DEV_TOOLS: "false",
};

type TestBindings = typeof bindings;

interface Learner {
  userId: string;
  cookie: string;
  csrf: string;
}

async function learner(): Promise<Learner> {
  const identity = await createTestIdentity(database);
  const { rawToken } = await createTestSessionCredentials(
    database,
    identity.userId,
    { now: clock, expiresAt: clock + 6 * 60 * 60 * 1000 },
  );
  const digest = await sessionDigest(rawToken);
  return {
    userId: identity.userId,
    cookie: rawToken,
    csrf: await createCsrfToken(
      origin,
      digest,
      new TextEncoder().encode(csrfSecret),
    ),
  };
}

/** A certification, optionally Pro-enabled by a synthetic Global Admin. */
async function exam(options: { proEnabled?: boolean } = {}): Promise<string> {
  const ownerUserId = await createTestLearnerUser(database);
  const certificationId = await createTestCertification(database, ownerUserId);
  if (options.proEnabled) {
    await createProEnablement(database, certificationId, ownerUserId);
  }
  return certificationId;
}

async function liveStandard(
  userId: string,
  certificationId: string,
  days: number,
): Promise<void> {
  await grantTestFeatureAccess(
    database,
    userId,
    certificationId,
    "standard",
    { startsAt: clock - day, expiresAt: clock + days * day },
  );
}

/** A learner with the fixtures that make `sku` purchasable, and the exam. */
async function purchaserOf(
  sku: Sku,
): Promise<{ actor: Learner; certificationId: string }> {
  const proSku =
    sku === "pro-3m" ||
    sku === "bundle-standard-3m-pro" ||
    sku === "standard-topup-3m";
  const certificationId = await exam({ proEnabled: proSku });
  const actor = await learner();
  switch (sku) {
    case "pro-3m":
      // Exactly a full Pro term of Standard: the equality case 0013 allows.
      await grantTestFeatureAccess(
        database,
        actor.userId,
        certificationId,
        "standard",
        { startsAt: clock, expiresAt: addTerm(clock, termFor("standard-3m")) },
      );
      break;
    case "standard-topup-3m":
    case "standard-extension-30d":
      await liveStandard(actor.userId, certificationId, 40);
      break;
    case "standard-3m":
    case "standard-6m":
    case "standard-12m":
    case "bundle-standard-3m-pro":
      break;
  }
  return { actor, certificationId };
}

interface RequestOptions {
  method?: string;
  actor?: Learner;
  body?: unknown;
  headers?: Record<string, string>;
  bindings?: TestBindings;
}

function call(path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.actor) headers.Cookie = `certpath_session=${options.actor.cookie}`;
  headers.Origin = origin;
  if (options.actor) headers["X-CSRF-Token"] = options.actor.csrf;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  return Promise.resolve(
    application.fetch(
      new Request(`${origin}${path}`, {
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      }),
      options.bindings ?? bindings,
    ),
  );
}

async function createCheckout(
  actor: Learner,
  certificationId: string,
  sku: Sku,
  clientCheckoutKey = crypto.randomUUID(),
): Promise<{ checkoutId: string; sessionRef: string; totalMinor: number }> {
  const response = await call("/api/commerce/checkouts", {
    actor,
    body: { certificationId, sku, clientCheckoutKey },
  });
  expect(response.status, sku).toBe(201);
  const body = commerceCheckoutResponseSchema.parse(await response.json());
  const row = await database
    .prepare(
      "SELECT provider_session_id FROM commerce_checkouts WHERE id = ?",
    )
    .bind(body.checkoutId)
    .first<{ provider_session_id: string }>();
  return {
    checkoutId: body.checkoutId,
    sessionRef: row!.provider_session_id,
    totalMinor: body.totalMinor,
  };
}

/** One authentic `checkout.completed` for a checkout, with its own event id. */
function completedEvent(
  checkout: { checkoutId: string; sessionRef: string; totalMinor: number },
  overrides: Partial<ProviderEvent> = {},
): ProviderEvent {
  return {
    eventId: `evt_${crypto.randomUUID()}`,
    kind: "checkout.completed",
    sessionRef: checkout.sessionRef,
    checkoutId: checkout.checkoutId,
    amountMinor: checkout.totalMinor,
    currency: "USD",
    occurredAt: clock,
    ...overrides,
  };
}

interface Delivery {
  status: number;
  body: { received?: boolean; duplicate?: boolean; error?: { code: string } };
}

/**
 * Deliver an event through the real webhook route: the body is the exact JSON the
 * signature covers, and the signature comes from the adapter's `signEvent`, so no
 * test hand-builds a digest.
 */
async function deliver(
  event: ProviderEvent,
  options: {
    path?: string;
    rawBody?: string;
    headers?: Record<string, string>;
    bindings?: TestBindings;
    signAt?: number;
  } = {},
): Promise<Delivery> {
  const rawBody = options.rawBody ?? JSON.stringify(event);
  const signed =
    options.headers ??
    (await fakeProvider.signEvent(
      event,
      Math.floor((options.signAt ?? clock) / 1000),
    ));
  const response = await application.fetch(
    new Request(`${origin}${options.path ?? "/api/commerce/webhooks/fake"}`, {
      method: "POST",
      headers: signed,
      body: rawBody,
    }),
    options.bindings ?? bindings,
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Delivery["body"]) : {},
  };
}

async function count(sql: string, ...values: (string | number | null)[]) {
  const row = await database
    .prepare(sql)
    .bind(...values)
    .first<{ rows: number }>();
  return row?.rows ?? -1;
}

async function grantsFor(userId: string) {
  const rows = await database
    .prepare(
      `SELECT id, feature, starts_at, expires_at, operation_id, sku, source
       FROM learner_access_grants WHERE user_id = ? ORDER BY rowid`,
    )
    .bind(userId)
    .all<{
      id: string;
      feature: string;
      starts_at: number;
      expires_at: number;
      operation_id: string | null;
      sku: string | null;
      source: string | null;
    }>();
  return rows.results;
}

async function checkoutRow(checkoutId: string) {
  return database
    .prepare(
      `SELECT status, paid_at, provider_session_id, total_minor
       FROM commerce_checkouts WHERE id = ?`,
    )
    .bind(checkoutId)
    .first<{
      status: string;
      paid_at: number | null;
      provider_session_id: string | null;
      total_minor: number;
    }>();
}

async function eventRow(eventId: string) {
  return database
    .prepare(
      `SELECT outcome, checkout_id, provider, kind
       FROM commerce_provider_events WHERE provider_event_id = ?`,
    )
    .bind(eventId)
    .first<{
      outcome: string;
      checkout_id: string | null;
      provider: string;
      kind: string;
    }>();
}

async function receiptFor(checkoutId: string) {
  return database
    .prepare(
      `SELECT receipt_number, kind, total_minor, currency, lines_json,
              grants_json, delivery, refund_window_ends_at, issued_at,
              provider_ref
       FROM commerce_receipts WHERE checkout_id = ? AND kind = 'purchase'`,
    )
    .bind(checkoutId)
    .first<{
      receipt_number: string;
      kind: string;
      total_minor: number;
      currency: string;
      lines_json: string;
      grants_json: string;
      delivery: string;
      refund_window_ends_at: number;
      issued_at: number;
      provider_ref: string | null;
    }>();
}

describe("a completed checkout settles what the SKU promised", () => {
  it("grants one Standard window for each Standard-granting SKU", async () => {
    for (const sku of [
      "standard-3m",
      "standard-6m",
      "standard-12m",
      "standard-topup-3m",
      "standard-extension-30d",
    ] as Sku[]) {
      const { actor, certificationId } = await purchaserOf(sku);
      const checkout = await createCheckout(actor, certificationId, sku);
      const event = completedEvent(checkout);

      const delivery = await deliver(event);
      expect(delivery.status, sku).toBe(200);
      expect(delivery.body).toEqual({ received: true, duplicate: false });

      const rows = (await grantsFor(actor.userId)).filter(
        (row) => row.operation_id === grantOperationId(checkout.checkoutId, "standard"),
      );
      expect(rows, sku).toHaveLength(1);
      expect(rows[0]!.feature).toBe("standard");
      expect(rows[0]!.sku).toBe(sku);
      expect(rows[0]!.source).toBe("purchase");
      // The window appends to coverage that already exists for the fixtures that
      // have it, and starts at `clock` for the ones that do not.
      expect(rows[0]!.starts_at).toBeGreaterThanOrEqual(clock);

      const row = await checkoutRow(checkout.checkoutId);
      expect(row?.status, sku).toBe("paid");
      expect(row?.paid_at).toBe(clock);

      const receipt = await receiptFor(checkout.checkoutId);
      expect(receipt?.kind).toBe("purchase");
      expect(receipt?.total_minor).toBe(checkout.totalMinor);
      expect(receipt?.currency).toBe("USD");
      expect(receipt?.delivery).toBe("stored");
      expect(receipt?.issued_at).toBe(clock);
      expect(receipt?.refund_window_ends_at).toBe(clock + 7 * day);
      expect(receipt?.receipt_number).toMatch(/^CP\d{8}-[0-9A-F]{12}$/);
      expect(JSON.parse(receipt!.lines_json)).toHaveLength(1);
      const granted = JSON.parse(receipt!.grants_json) as {
        feature: string;
        startsAt: number;
        expiresAt: number;
        operationId: string;
      }[];
      expect(granted).toHaveLength(1);
      expect(granted[0]!.feature).toBe("standard");
      expect(granted[0]!.operationId).toBe(
        grantOperationId(checkout.checkoutId, "standard"),
      );
      expect((await eventRow(event.eventId))?.outcome).toBe("applied");
    }
  });

  it("settles the bundle in one transaction, Standard before Pro", async () => {
    // The order in the batch is load-bearing, and this is what it buys: one
    // transaction that writes both legs, the paid checkout, the receipt and the
    // event. Pro first would leave the Pro insert with no covering row - it is
    // guarded by the Standard row this batch must write - so the first attempt
    // would grant only Standard, park nothing, and need a second attempt to
    // finish. Nothing is lost in that case, but the purchase would take two
    // transactions to become consistent instead of one.
    const { actor, certificationId } = await purchaserOf(
      "bundle-standard-3m-pro",
    );
    const checkout = await createCheckout(
      actor,
      certificationId,
      "bundle-standard-3m-pro",
    );
    const event = completedEvent(checkout);
    const row = await readCheckoutForSession(database, "fake", checkout.sessionRef);
    const plan = buildSettlementPlan(
      row!,
      await readSnapshotLines(database, row!.id),
      await readAccountGrants(database, row!.user_id, row!.certification_id),
      event,
      clock,
    );

    const witness = await applySettlement(database, plan);
    expect(witness.granted).toBe(2);
    expect(witness.transitioned).toBe(true);
    expect(witness.receiptIssued).toBe(true);
    expect(witness.eventRecorded).toBe(true);
    expect(witness.outcome).toBe("applied");
    expect(witness.incomplete).toBe(false);
  });

  it("grants the Pro add-on as one Pro window, and no Standard window", async () => {
    const { actor, certificationId } = await purchaserOf("pro-3m");
    const checkout = await createCheckout(actor, certificationId, "pro-3m");
    const event = completedEvent(checkout);

    expect((await deliver(event)).body).toEqual({
      received: true,
      duplicate: false,
    });
    const settled = (await grantsFor(actor.userId)).filter(
      (row) => row.operation_id !== null && row.operation_id.includes(":"),
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]!.feature).toBe("pro");
    expect(settled[0]!.operation_id).toBe(
      grantOperationId(checkout.checkoutId, "pro"),
    );
    expect(settled[0]!.starts_at).toBe(clock);
    expect(settled[0]!.expires_at).toBe(addTerm(clock, proTerm));
  });

  it("writes the bundle's two legs in order, one clock, and 0013 never fires", async () => {
    const { actor, certificationId } = await purchaserOf(
      "bundle-standard-3m-pro",
    );
    const checkout = await createCheckout(
      actor,
      certificationId,
      "bundle-standard-3m-pro",
    );
    const event = completedEvent(checkout);

    const delivery = await deliver(event);
    // The success itself is the proof that `pro_requires_standard` accepted the
    // Pro insert: a rejection would have rolled the batch back. The order is
    // asserted on `rowid`, because the Pro row cannot exist before the Standard
    // row it depends on.
    expect(delivery.body).toEqual({ received: true, duplicate: false });

    const rows = await grantsFor(actor.userId);
    expect(rows.map((row) => row.feature)).toEqual(["standard", "pro"]);
    expect(rows[0]!.source).toBe("bundle");
    expect(rows[1]!.source).toBe("bundle");
    // One `now` for both legs: byte-identical starts, which is what makes the
    // `max` in the bundle arithmetic sufficient instead of merely helpful.
    expect(rows[0]!.starts_at).toBe(rows[1]!.starts_at);
    expect(rows[0]!.starts_at).toBe(clock);
    // Standard covers Pro by construction.
    expect(rows[0]!.expires_at).toBeGreaterThanOrEqual(rows[1]!.expires_at);
    expect(rows[0]!.operation_id).toBe(
      grantOperationId(checkout.checkoutId, "standard"),
    );
    expect(rows[1]!.operation_id).toBe(
      grantOperationId(checkout.checkoutId, "pro"),
    );
    expect((await checkoutRow(checkout.checkoutId))?.status).toBe("paid");
  });

  it("stacks a second Standard purchase instead of overwriting the first", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const first = await createCheckout(actor, certificationId, "standard-3m");
    expect((await deliver(completedEvent(first))).body.duplicate).toBe(false);
    const afterFirst = (await grantsFor(actor.userId))[0]!;

    // A second checkout for the same product is refused while the first is open;
    // once it is paid, the slot is free and the second purchase is allowed.
    const second = await createCheckout(actor, certificationId, "standard-3m");
    expect((await deliver(completedEvent(second))).body.duplicate).toBe(false);

    const rows = await grantsFor(actor.userId);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.starts_at).toBe(afterFirst.expires_at);
    expect(rows[1]!.expires_at).toBe(
      addTerm(afterFirst.expires_at, termFor("standard-3m")),
    );
  });
});

describe("idempotency", () => {
  it("delivers the same event twice as one grant set, one receipt, one event row", async () => {
    const { actor, certificationId } = await purchaserOf(
      "bundle-standard-3m-pro",
    );
    const checkout = await createCheckout(
      actor,
      certificationId,
      "bundle-standard-3m-pro",
    );
    const event = completedEvent(checkout);

    const first = await deliver(event);
    const second = await deliver(event);

    expect(first.body).toEqual({ received: true, duplicate: false });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ received: true, duplicate: true });
    expect(await grantsFor(actor.userId)).toHaveLength(2);
    expect(await receiptFor(checkout.checkoutId)).not.toBeNull();
    expect(
      await count(
        "SELECT COUNT(*) AS rows FROM commerce_receipts WHERE checkout_id = ?",
        checkout.checkoutId,
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT COUNT(*) AS rows FROM commerce_provider_events WHERE provider_event_id = ?",
        event.eventId,
      ),
    ).toBe(1);
  });

  it("treats a second event id for the same checkout as the same settlement (#71)", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const checkout = await createCheckout(actor, certificationId, "standard-3m");

    expect((await deliver(completedEvent(checkout))).body.duplicate).toBe(false);
    const replay = completedEvent(checkout, {
      // A provider echo of our id is provider-supplied input; the fake accepts up
      // to 128 characters, so an id derived from the echo could exceed the
      // operation-id bound. Nothing may be derived from it.
      checkoutId: "x".repeat(128),
    });
    const second = await deliver(replay);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ received: true, duplicate: false });

    const rows = await grantsFor(actor.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operation_id).toBe(
      grantOperationId(checkout.checkoutId, "standard"),
    );
    // Both events are in the ledger and both name the same checkout: the second
    // is a duplicate notification of one payment, not a second payment.
    expect((await eventRow(replay.eventId))?.outcome).toBe("applied");
    expect((await eventRow(replay.eventId))?.checkout_id).toBe(
      checkout.checkoutId,
    );
    expect(await receiptFor(checkout.checkoutId)).not.toBeNull();
  });

  it("fails closed at UNIQUE when the same operation id is inserted twice (#71)", async () => {
    // The third idempotency layer: the operation id is derived from the stored
    // checkout id, so a repeated settlement re-inserts the same id and lands on
    // the constraint instead of granting twice. A random suffix would let this
    // second insert through.
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const checkout = await createCheckout(actor, certificationId, "standard-3m");
    const operationId = grantOperationId(checkout.checkoutId, "standard");
    const insert = (id: string) =>
      database
        .prepare(
          `INSERT INTO learner_access_grants (
             id, user_id, certification_id, feature, starts_at, expires_at,
             revoked_at, created_at, sku, source, operation_id, created_by_user_id
           ) VALUES (?, ?, ?, 'standard', ?, ?, NULL, ?, 'standard-3m', 'purchase', ?, NULL)`,
        )
        .bind(
          id,
          actor.userId,
          certificationId,
          clock,
          clock + 30 * day,
          clock,
          operationId,
        )
        .run();
    await insert(crypto.randomUUID());
    await expect(insert(crypto.randomUUID())).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
    expect(
      await count(
        "SELECT COUNT(*) AS rows FROM learner_access_grants WHERE operation_id = ?",
        operationId,
      ),
    ).toBe(1);
  });

  it("writes nothing when the signature, the body or the clock is wrong", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const checkout = await createCheckout(actor, certificationId, "standard-3m");
    const event = completedEvent(checkout);
    const before = await count(
      "SELECT COUNT(*) AS rows FROM commerce_provider_events",
    );
    const grantsBefore = await count(
      "SELECT COUNT(*) AS rows FROM learner_access_grants WHERE user_id = ?",
      actor.userId,
    );

    const tampered = await deliver(event, {
      rawBody: JSON.stringify({ ...event, amountMinor: 1 }),
    });
    expect(tampered.status).toBe(401);
    expect(tampered.body.error?.code).toBe("invalid_signature");

    const unsigned = await deliver(event, { headers: {} });
    expect(unsigned.status).toBe(401);

    const wrongSecret = await deliver(event, {
      headers: await createFakeProvider({
        secret: "a-different-secret-with-enough-bytes-in-it",
        now: () => clock,
        origin,
      }).signEvent(event, Math.floor(clock / 1000)),
    });
    expect(wrongSecret.status).toBe(401);

    const stale = await deliver(event, { signAt: clock - 301 * 1000 });
    expect(stale.status).toBe(401);

    const fresh299 = await deliver(event, { signAt: clock - 299 * 1000 });
    expect(fresh299.status).toBe(200);

    // `commerce_provider_events` gained exactly one row: the fresh delivery.
    expect(
      await count("SELECT COUNT(*) AS rows FROM commerce_provider_events"),
    ).toBe(before + 1);
    expect(
      await count(
        "SELECT COUNT(*) AS rows FROM learner_access_grants WHERE user_id = ?",
        actor.userId,
      ),
    ).toBe(grantsBefore + 1);
  });

  it("answers 400 malformed_event for a correctly signed but unusable body", async () => {
    const headers = await fakeProvider.signRawBody("not json", Math.floor(clock / 1000));
    const delivery = await deliver(completedEvent({
      checkoutId: "unused",
      sessionRef: "unused",
      totalMinor: 1,
    }), { rawBody: "not json", headers });
    expect(delivery.status).toBe(400);
    expect(delivery.body.error?.code).toBe("malformed_event");
  });

  it("answers 404 unknown_provider for a path segment the adapter does not own", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const checkout = await createCheckout(actor, certificationId, "standard-3m");
    const delivery = await deliver(completedEvent(checkout), {
      path: "/api/commerce/webhooks/stripe",
    });
    expect(delivery.status).toBe(404);
    expect(delivery.body.error?.code).toBe("unknown_provider");
  });

  it("answers 413 payload_too_large above 16 KiB and writes nothing", async () => {
    const before = await count(
      "SELECT COUNT(*) AS rows FROM commerce_provider_events",
    );
    const big = "x".repeat(16 * 1024 + 1);
    const oversized = await application.fetch(
      new Request(`${origin}/api/commerce/webhooks/fake`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CertPath-Signature": "t=1,v1=" + "0".repeat(64),
        },
        body: big,
      }),
      bindings,
    );
    expect(oversized.status).toBe(413);
    expect(
      ((await oversized.json()) as { error: { code: string } }).error.code,
    ).toBe("payload_too_large");
    expect(
      await count("SELECT COUNT(*) AS rows FROM commerce_provider_events"),
    ).toBe(before);
  });

  it("answers 503 commerce_disabled and writes nothing when the feature is off", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const checkout = await createCheckout(actor, certificationId, "standard-3m");
    const delivery = await deliver(completedEvent(checkout), {
      bindings: { ...bindings, COMMERCE_ENABLED: "false" },
    });
    expect(delivery.status).toBe(503);
    expect(delivery.body.error?.code).toBe("commerce_disabled");
    expect((await checkoutRow(checkout.checkoutId))?.status).toBe("pending");
    expect(await grantsFor(actor.userId)).toHaveLength(0);
  });
});

describe("what settlement refuses to do", () => {
  it("records an unknown checkout with an audit row and answers 200", async () => {
    const event = completedEvent({
      checkoutId: "chk_unknown",
      sessionRef: "fake_unknown",
      totalMinor: 5900,
    });
    const delivery = await deliver(event);
    expect(delivery.status).toBe(200);
    expect(delivery.body).toEqual({ received: true, duplicate: false });

    const row = await eventRow(event.eventId);
    expect(row?.outcome).toBe("ignored-unknown-checkout");
    expect(row?.checkout_id).toBeNull();
    const audit = await database
      .prepare(
        `SELECT actor_ref, action, subject_type, subject_id
         FROM audit_events WHERE operation_id = ?`,
      )
      .bind(`commerce-event:${event.eventId}`)
      .first<{
        actor_ref: string;
        action: string;
        subject_type: string;
        subject_id: string;
      }>();
    expect(audit).toEqual({
      actor_ref: "commerce-webhook",
      action: "commerce_event_unknown_checkout",
      subject_type: "commerce_provider_event",
      subject_id: event.eventId,
    });

    // A redelivery is a duplicate and writes no second audit row.
    const again = await deliver(event);
    expect(again.body).toEqual({ received: true, duplicate: true });
    expect(
      await count(
        "SELECT COUNT(*) AS rows FROM audit_events WHERE operation_id = ?",
        `commerce-event:${event.eventId}`,
      ),
    ).toBe(1);
  });

  it("moves a checkout to failed on checkout.failed and grants nothing", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const checkout = await createCheckout(actor, certificationId, "standard-3m");
    const event = completedEvent(checkout, {
      kind: "checkout.failed",
      amountMinor: 0,
    });
    const delivery = await deliver(event);
    expect(delivery.status).toBe(200);
    expect((await checkoutRow(checkout.checkoutId))?.status).toBe("failed");
    expect(await grantsFor(actor.userId)).toHaveLength(0);
    expect(await receiptFor(checkout.checkoutId)).toBeNull();
    expect((await eventRow(event.eventId))?.outcome).toBe("applied");
  });

  it("settles a late payment on a row our own expiry already closed", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const checkout = await createCheckout(actor, certificationId, "standard-3m");
    await database
      .prepare(
        "UPDATE commerce_checkouts SET status = 'expired', updated_at = ? WHERE id = ?",
      )
      .bind(clock, checkout.checkoutId)
      .run();
    expect((await checkoutRow(checkout.checkoutId))?.status).toBe("expired");

    const delivery = await deliver(completedEvent(checkout));
    expect(delivery.body).toEqual({ received: true, duplicate: false });
    expect((await checkoutRow(checkout.checkoutId))?.status).toBe("paid");
    expect((await grantsFor(actor.userId)).length).toBeGreaterThan(0);
  });

  it("parks an amount mismatch in needs_support and grants nothing", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const checkout = await createCheckout(actor, certificationId, "standard-3m");
    const event = completedEvent(checkout, {
      amountMinor: checkout.totalMinor + 1,
    });

    const delivery = await deliver(event);
    expect(delivery.status).toBe(200);
    expect((await checkoutRow(checkout.checkoutId))?.status).toBe(
      "needs_support",
    );
    expect(await grantsFor(actor.userId)).toHaveLength(0);
    expect(await receiptFor(checkout.checkoutId)).toBeNull();
    const row = await eventRow(event.eventId);
    expect(row?.outcome).toBe("ignored-inconsistent");
    expect(row?.checkout_id).toBe(checkout.checkoutId);
  });

  it("parks a second overlapping Pro window in needs_support, granting only the first", async () => {
    // Two products that each grant Pro, bought at the same moment: the bundle and
    // the Pro add-on have different fingerprints, so both may be open at once.
    const { actor, certificationId } = await purchaserOf(
      "bundle-standard-3m-pro",
    );
    await grantTestFeatureAccess(
      database,
      actor.userId,
      certificationId,
      "standard",
      { startsAt: clock, expiresAt: addTerm(clock, proTerm) },
    );
    const bundle = await createCheckout(
      actor,
      certificationId,
      "bundle-standard-3m-pro",
    );
    const addOn = await createCheckout(actor, certificationId, "pro-3m");

    expect((await deliver(completedEvent(bundle))).body.duplicate).toBe(false);
    const second = completedEvent(addOn);
    const delivery = await deliver(second);

    expect(delivery.status).toBe(200);
    expect((await checkoutRow(addOn.checkoutId))?.status).toBe("needs_support");
    expect((await eventRow(second.eventId))?.outcome).toBe(
      "ignored-inconsistent",
    );
    expect(await receiptFor(addOn.checkoutId)).toBeNull();
    const pro = (await grantsFor(actor.userId)).filter(
      (row) => row.feature === "pro",
    );
    expect(pro).toHaveLength(1);
    expect(pro[0]!.operation_id).toBe(
      grantOperationId(bundle.checkoutId, "pro"),
    );
  });

  it("does not resurrect a checkout the provider already failed", async () => {
    // `failed -> paid` is not an edge 0018 permits, and settlement must not be a
    // way around the transition guard: a later `checkout.completed` for the same
    // checkout cannot grant, and the event is recorded as inconsistent rather than
    // applied.
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const checkout = await createCheckout(actor, certificationId, "standard-3m");
    const failed = completedEvent(checkout, {
      kind: "checkout.failed",
      amountMinor: 0,
    });
    expect((await deliver(failed)).status).toBe(200);
    expect((await checkoutRow(checkout.checkoutId))?.status).toBe("failed");

    const late = completedEvent(checkout);
    const delivery = await deliver(late);
    expect(delivery.status).toBe(200);
    expect((await eventRow(late.eventId))?.outcome).toBe("ignored-inconsistent");
    expect((await checkoutRow(checkout.checkoutId))?.status).toBe("failed");
    expect(await grantsFor(actor.userId)).toHaveLength(0);
    expect(await receiptFor(checkout.checkoutId)).toBeNull();

    await expect(
      database
        .prepare(
          "UPDATE commerce_checkouts SET status = 'paid', paid_at = ? WHERE id = ?",
        )
        .bind(clock, checkout.checkoutId)
        .run(),
    ).rejects.toThrow(/illegal checkout status/);
  });
});

describe("the settlement guards", () => {
  it("writes nothing when the coverage compare-and-swap is stale", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const checkout = await createCheckout(actor, certificationId, "standard-3m");
    const event = completedEvent(checkout);

    const row = await readCheckoutForSession(database, "fake", checkout.sessionRef);
    expect(row).not.toBeNull();
    const lines = await readSnapshotLines(database, row!.id);
    const grants = await readAccountGrants(
      database,
      row!.user_id,
      row!.certification_id,
    );
    const plan = buildSettlementPlan(row!, lines, grants, event, clock);

    const witness = await applySettlement(database, {
      ...plan,
      // One millisecond of staleness is enough: the window arithmetic was
      // computed against a coverage end that no longer holds.
      casToken: plan.casToken - 1,
    });

    expect(witness.granted).toBe(0);
    expect(witness.transitioned).toBe(false);
    expect(witness.receiptIssued).toBe(false);
    // Zero rows written, including the event row: a lost CAS is not an
    // inconsistency, it is a retry.
    expect(witness.eventRecorded).toBe(false);
    expect((await checkoutRow(checkout.checkoutId))?.status).toBe("pending");
    expect(await grantsFor(actor.userId)).toHaveLength(0);
    expect(await receiptFor(checkout.checkoutId)).toBeNull();
    expect(
      await count(
        "SELECT COUNT(*) AS rows FROM commerce_provider_events WHERE provider_event_id = ?",
        event.eventId,
      ),
    ).toBe(0);
    expect(settlementAttempts).toBe(3);
  });

  it("never fails the batch when the same event is applied twice", async () => {
    // The handler's duplicate fast path answers a redelivery before any write, but
    // two deliveries of one event can both pass it before either commits. The
    // in-batch guards are the race-safe backstop, and their job is narrow and
    // absolute: the *second* application must write nothing and must not throw,
    // because a throw would abort the batch and answer the provider 5xx, pinning
    // it in a retry loop over an event that is already recorded.
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const checkout = await createCheckout(actor, certificationId, "standard-3m");
    const event = completedEvent(checkout);
    const row = await readCheckoutForSession(database, "fake", checkout.sessionRef);
    const plan = buildSettlementPlan(
      row!,
      await readSnapshotLines(database, row!.id),
      await readAccountGrants(database, row!.user_id, row!.certification_id),
      event,
      clock,
    );

    const first = await applySettlement(database, plan);
    expect(first.outcome).toBe("applied");
    const second = await applySettlement(database, plan);
    expect(second.eventRecorded).toBe(false);
    expect(second.granted).toBe(0);
    expect(second.transitioned).toBe(false);
    expect(second.receiptIssued).toBe(false);
    expect(await grantsFor(actor.userId)).toHaveLength(1);
  });

  it("counts inserted rows, not the audit row the trigger also writes", async () => {
    // The reason `meta.changes` may not be used as a witness: an audited insert
    // reports two changes for one grant. The settlement reads `RETURNING` instead,
    // which reports one row.
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const operationId = `${crypto.randomUUID()}:standard`;
    const result = await database
      .prepare(
        `INSERT INTO learner_access_grants (
           id, user_id, certification_id, feature, starts_at, expires_at,
           revoked_at, created_at, sku, source, operation_id, created_by_user_id
         ) VALUES (?, ?, ?, 'standard', ?, ?, NULL, ?, 'standard-3m', 'purchase', ?, NULL)
         RETURNING id`,
      )
      .bind(
        crypto.randomUUID(),
        actor.userId,
        certificationId,
        clock,
        clock + 30 * day,
        clock,
        operationId,
      )
      .run();
    expect(result.meta.changes).toBe(2);
    expect(result.results).toHaveLength(1);
    expect(
      await count(
        "SELECT COUNT(*) AS rows FROM audit_events WHERE operation_id = ?",
        operationId,
      ),
    ).toBe(1);
  });

  it("aborts the Pro insert when no covering Standard row exists (0013)", async () => {
    // The ordering in the batch is deliberate, and this is what it is for: a Pro
    // row inserted first has no cover and 0013 refuses it, rolling the batch back.
    const { actor, certificationId } = await purchaserOf("standard-3m");
    await expect(
      database
        .prepare(
          `INSERT INTO learner_access_grants (
             id, user_id, certification_id, feature, starts_at, expires_at,
             revoked_at, created_at, sku, source, operation_id, created_by_user_id
           ) VALUES (?, ?, ?, 'pro', ?, ?, NULL, ?, 'pro-3m', 'purchase', ?, NULL)`,
        )
        .bind(
          crypto.randomUUID(),
          actor.userId,
          certificationId,
          clock,
          addTerm(clock, proTerm),
          clock,
          `${crypto.randomUUID()}:pro`,
        )
        .run(),
    ).rejects.toThrow(/pro grant requires a standard grant covering the same window/);
    expect(await grantsFor(actor.userId)).toHaveLength(0);
  });

  it("refuses a second overlapping Pro window at the trigger (0019)", async () => {
    const { actor, certificationId } = await purchaserOf("pro-3m");
    await grantTestFeatureAccess(
      database,
      actor.userId,
      certificationId,
      "pro",
      { startsAt: clock, expiresAt: addTerm(clock, proTerm) },
    );
    await expect(
      database
        .prepare(
          `INSERT INTO learner_access_grants (
             id, user_id, certification_id, feature, starts_at, expires_at,
             revoked_at, created_at, sku, source, operation_id, created_by_user_id
           ) VALUES (?, ?, ?, 'pro', ?, ?, NULL, ?, 'pro-3m', 'purchase', ?, NULL)`,
        )
        .bind(
          crypto.randomUUID(),
          actor.userId,
          certificationId,
          clock,
          addTerm(clock, proTerm),
          clock,
          `${crypto.randomUUID()}:pro`,
        )
        .run(),
    ).rejects.toThrow(/a pro window is already live for this certification/);
  });

  it("refuses a future-dated Pro window at the trigger and at the gate (#75)", async () => {
    const { actor, certificationId } = await purchaserOf("pro-3m");
    // Cover the future Pro window, then insert a Pro grant that starts tomorrow:
    // not live at `now`, yet it overlaps the window a purchase made now would
    // write.
    await grantTestFeatureAccess(
      database,
      actor.userId,
      certificationId,
      "standard",
      { startsAt: clock, expiresAt: addTerm(clock + day, proTerm) + 100 * day },
    );
    await grantTestFeatureAccess(
      database,
      actor.userId,
      certificationId,
      "pro",
      { startsAt: clock + day, expiresAt: addTerm(clock + day, proTerm) },
    );
    await expect(
      database
        .prepare(
          `INSERT INTO learner_access_grants (
             id, user_id, certification_id, feature, starts_at, expires_at,
             revoked_at, created_at, sku, source, operation_id, created_by_user_id
           ) VALUES (?, ?, ?, 'pro', ?, ?, NULL, ?, 'pro-3m', 'purchase', ?, NULL)`,
        )
        .bind(
          crypto.randomUUID(),
          actor.userId,
          certificationId,
          clock,
          addTerm(clock, proTerm),
          clock,
          `${crypto.randomUUID()}:pro`,
        )
        .run(),
    ).rejects.toThrow(/a pro window is already live for this certification/);

    // The gate must refuse the same shape before money moves, rather than letting
    // the trigger abort a paid purchase.
    const offers = await call(
      `/api/commerce/offers?certificationId=${encodeURIComponent(certificationId)}`,
      { actor },
    );
    expect(offers.status).toBe(200);
    const body = (await offers.json()) as {
      offers: { sku: string; purchasable: boolean; reason: string | null }[];
    };
    expect(body.offers.find((offer) => offer.sku === "pro-3m")).toMatchObject({
      purchasable: false,
      reason: "pro_window_active",
    });
    const refused = await call("/api/commerce/checkouts", {
      actor,
      body: {
        certificationId,
        sku: "pro-3m",
        clientCheckoutKey: crypto.randomUUID(),
      },
    });
    expect(refused.status).toBe(409);
    expect(
      ((await refused.json()) as { error: { reason: string } }).error.reason,
    ).toBe("pro_window_active");
  });
});

describe("checkout storage guards folded into 0019", () => {
  it("makes paid_at write-once (#73)", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const checkout = await createCheckout(actor, certificationId, "standard-3m");
    expect((await deliver(completedEvent(checkout))).body.duplicate).toBe(false);
    const paidAt = (await checkoutRow(checkout.checkoutId))?.paid_at;
    expect(paidAt).toBe(clock);

    await expect(
      database
        .prepare(
          "UPDATE commerce_checkouts SET paid_at = ? WHERE id = ?",
        )
        .bind(clock + 1, checkout.checkoutId)
        .run(),
    ).rejects.toThrow(/immutable/);
  });

  it("makes the provider session write-once (#73)", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const checkout = await createCheckout(actor, certificationId, "standard-3m");
    await expect(
      database
        .prepare(
          "UPDATE commerce_checkouts SET provider_session_id = ? WHERE id = ?",
        )
        .bind("fake_someone_else", checkout.checkoutId)
        .run(),
    ).rejects.toThrow(/immutable/);
    // The first binding is still allowed to happen, and still idempotent: the
    // checkout route binds with `WHERE provider_session_id IS NULL`.
    expect((await checkoutRow(checkout.checkoutId))?.provider_session_id).toBe(
      checkout.sessionRef,
    );
  });

  it("allows one open checkout per (learner, certification, SKU) (#74)", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const first = await createCheckout(actor, certificationId, "standard-3m");

    // A second tab with its own client key is handed the live checkout instead of
    // opening a second provider session.
    const second = await call("/api/commerce/checkouts", {
      actor,
      body: {
        certificationId,
        sku: "standard-3m",
        clientCheckoutKey: crypto.randomUUID(),
      },
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as {
      error: { code: string; checkoutId: string };
    };
    expect(body.error.code).toBe("checkout_already_open");
    expect(body.error.checkoutId).toBe(first.checkoutId);
    expect(
      await count(
        "SELECT COUNT(*) AS rows FROM commerce_checkouts WHERE user_id = ?",
        actor.userId,
      ),
    ).toBe(1);

    // A different SKU is a different fingerprint, and stays open beside it.
    const other = await call("/api/commerce/checkouts", {
      actor,
      body: {
        certificationId,
        sku: "standard-6m",
        clientCheckoutKey: crypto.randomUUID(),
      },
    });
    expect(other.status).toBe(201);
  });

  it("frees the open slot when the expiry job closes a lapsed checkout (#74)", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const first = await createCheckout(actor, certificationId, "standard-3m");
    // The job is global, so the assertion is about *this* row rather than about a
    // count the rest of the file could move.
    const expiry = await expireStaleCheckouts(database, clock + 31 * 60 * 1000);
    expect(expiry.ok).toBe(true);
    expect((await checkoutRow(first.checkoutId))?.status).toBe("expired");

    const again = await call("/api/commerce/checkouts", {
      actor,
      body: {
        certificationId,
        sku: "standard-3m",
        clientCheckoutKey: crypto.randomUUID(),
      },
    });
    expect(again.status).toBe(201);
    expect(
      await count(
        "SELECT COUNT(*) AS rows FROM commerce_checkouts WHERE user_id = ?",
        actor.userId,
      ),
    ).toBe(2);
  });

  it("refuses a second pending row for one fingerprint at the index", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const first = await createCheckout(actor, certificationId, "standard-3m");
    const fingerprint = await database
      .prepare(
        "SELECT request_fingerprint FROM commerce_checkouts WHERE id = ?",
      )
      .bind(first.checkoutId)
      .first<{ request_fingerprint: string }>();
    await expect(
      database
        .prepare(
          `INSERT INTO commerce_checkouts (
             id, user_id, certification_id, sku, client_checkout_key,
             request_fingerprint, currency, total_minor, status, provider,
             provider_session_id, provider_redirect_url, created_at, updated_at,
             expires_at, paid_at
           ) VALUES (?, ?, ?, 'standard-3m', 'second-tab-key', ?, 'USD', 5900,
                     'pending', 'fake', NULL, NULL, ?, ?, ?, NULL)`,
        )
        .bind(
          `chk_${crypto.randomUUID()}`,
          actor.userId,
          certificationId,
          fingerprint!.request_fingerprint,
          clock,
          clock,
          clock + 30 * 60 * 1000,
        )
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });
});

describe("receipts", () => {
  it("is stored, carries no tax or card field, and cannot be changed", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const checkout = await createCheckout(actor, certificationId, "standard-3m");
    expect((await deliver(completedEvent(checkout))).body.duplicate).toBe(false);

    const columns = await database
      .prepare("PRAGMA table_info(commerce_receipts)")
      .all<{ name: string }>();
    for (const { name } of columns.results) {
      expect(name).not.toMatch(/card|pan|cvv|tax|vat|gst|invoice|email|name/i);
    }

    const receipt = await receiptFor(checkout.checkoutId);
    await expect(
      database
        .prepare("UPDATE commerce_receipts SET total_minor = 1 WHERE checkout_id = ?")
        .bind(checkout.checkoutId)
        .run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      database
        .prepare("DELETE FROM commerce_receipts WHERE checkout_id = ?")
        .bind(checkout.checkoutId)
        .run(),
    ).rejects.toThrow(/cannot be deleted/);
    // `delivery` has exactly one legal value: a receipt is stored, never sent.
    await expect(
      database
        .prepare("UPDATE commerce_receipts SET delivery = 'emailed' WHERE checkout_id = ?")
        .bind(checkout.checkoutId)
        .run(),
    ).rejects.toThrow(/append-only/);
    expect(receipt?.delivery).toBe("stored");
    expect(receipt?.provider_ref).toBe(checkout.sessionRef);
  });
});

describe("the dev seam", () => {
  it("does not exist unless the provider is fake and the local switch is on", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const checkout = await createCheckout(actor, certificationId, "standard-3m");

    for (const extra of [
      {},
      { LOCAL_COMMERCE_DEV_TOOLS: "false" },
      { LOCAL_COMMERCE_DEV_TOOLS: "TRUE" },
    ]) {
      const response = await call("/api/commerce/dev/fake-pay", {
        actor,
        body: { checkoutId: checkout.checkoutId },
        bindings: { ...bindings, ...extra },
      });
      expect(response.status).toBe(404);
    }
  });

  it("dispatches through the webhook handler and grants nothing by itself", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const checkout = await createCheckout(actor, certificationId, "standard-3m");

    const response = await call("/api/commerce/dev/fake-pay", {
      actor,
      body: { checkoutId: checkout.checkoutId },
      bindings: { ...bindings, LOCAL_COMMERCE_DEV_TOOLS: "true" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      received: true,
      duplicate: false,
    });
    expect((await checkoutRow(checkout.checkoutId))?.status).toBe("paid");
    expect(await grantsFor(actor.userId)).toHaveLength(1);

    // The same event id, so a second press is a duplicate rather than a second
    // settlement.
    const again = await call("/api/commerce/dev/fake-pay", {
      actor,
      body: { checkoutId: checkout.checkoutId },
      bindings: { ...bindings, LOCAL_COMMERCE_DEV_TOOLS: "true" },
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ received: true, duplicate: true });
    expect(await grantsFor(actor.userId)).toHaveLength(1);
  });

  it("answers 404 for another learner's checkout", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const checkout = await createCheckout(actor, certificationId, "standard-3m");
    const stranger = await learner();
    const response = await call("/api/commerce/dev/fake-pay", {
      actor: stranger,
      body: { checkoutId: checkout.checkoutId },
      bindings: { ...bindings, LOCAL_COMMERCE_DEV_TOOLS: "true" },
    });
    expect(response.status).toBe(404);
    expect((await checkoutRow(checkout.checkoutId))?.status).toBe("pending");
  });
});
