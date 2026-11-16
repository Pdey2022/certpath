import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  commerceCheckoutResponseSchema,
  commerceReceiptListResponseSchema,
  commerceReceiptSchema,
  commerceRefundResponseSchema,
} from "@certpath/contracts";
import { createApi } from "../src/index.ts";
import { refundWindowMs } from "../src/pricing.ts";
import { createFakeProvider } from "../src/commerce/providers/fake.ts";
import { createCsrfToken, sessionDigest } from "../src/security/http-session.ts";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  createTestCertification,
  createTestIdentity,
  createTestLearnerUser,
  createTestSessionCredentials,
} from "./factories.ts";

// The receipts read: owner-scoped, ordered, bounded, and free of anything that
// would imply a tax statement, a card or an identity.

const database: SecurityDatabase = env.DB;
const origin = "https://localhost";
const csrfSecret = "local-worker-test-csrf-secret-with-enough-entropy";
const webhookSecret = "local-commerce-webhook-secret-with-enough-bytes";
const day = 86_400_000;
const clock = Date.parse("2026-02-01T00:00:00.000Z");
let now = clock;

const fakeProvider = createFakeProvider({
  secret: webhookSecret,
  now: () => now,
  origin,
});

const application = createApi(
  fetch,
  () => now,
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
  LOCAL_COMMERCE_DEV_TOOLS: "true",
};

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
    { now, expiresAt: now + 30 * day },
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

async function exam(): Promise<string> {
  const ownerUserId = await createTestLearnerUser(database);
  return createTestCertification(database, ownerUserId);
}

function call(
  path: string,
  options: { actor?: Learner; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { Origin: origin };
  if (options.actor) {
    headers.Cookie = `certpath_session=${options.actor.cookie}`;
    headers["X-CSRF-Token"] = options.actor.csrf;
  }
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  return Promise.resolve(
    application.fetch(
      new Request(`${origin}${path}`, {
        method: options.body === undefined ? "GET" : "POST",
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      }),
      bindings,
    ),
  );
}

async function buy(
  actor: Learner,
  certificationId: string,
  sku: string,
): Promise<string> {
  const created = await call("/api/commerce/checkouts", {
    actor,
    body: { certificationId, sku, clientCheckoutKey: crypto.randomUUID() },
  });
  expect(created.status, sku).toBe(201);
  const checkoutId = commerceCheckoutResponseSchema.parse(
    await created.json(),
  ).checkoutId;
  const paid = await call("/api/commerce/dev/fake-pay", {
    actor,
    body: { checkoutId },
  });
  expect(paid.status, sku).toBe(200);
  return checkoutId;
}

async function list(actor: Learner, certificationId: string, extra = "") {
  return call(
    `/api/commerce/receipts?certificationId=${encodeURIComponent(certificationId)}${extra}`,
    { actor },
  );
}

describe("receipt reads", () => {
  beforeEach(() => {
    now = clock;
  });

  it("lists the purchase receipt of a bought checkout", async () => {
    const actor = await learner();
    const certificationId = await exam();
    const checkoutId = await buy(actor, certificationId, "standard-3m");
    const paidAt = (
      await database
        .prepare("SELECT paid_at FROM commerce_checkouts WHERE id = ?")
        .bind(checkoutId)
        .first<{ paid_at: number }>()
    )!.paid_at;

    const response = await list(actor, certificationId);
    expect(response.status).toBe(200);
    const body = commerceReceiptListResponseSchema.parse(await response.json());
    expect(body.certificationId).toBe(certificationId);
    expect(body.receipts).toHaveLength(1);
    const receipt = body.receipts[0]!;
    expect(receipt).toMatchObject({
      kind: "purchase",
      checkoutId,
      refundId: null,
      certificationId,
      currency: "USD",
      totalMinor: 5900,
      provider: "fake",
      providerRef: `fake_${checkoutId}`,
      delivery: "stored",
      refundWindowEndsAt: paidAt + refundWindowMs,
    });
    expect(receipt.receiptNumber).toMatch(/^CP\d{8}-[0-9A-F]{12}$/);
    expect(receipt.lines).toEqual([
      {
        sku: "standard-3m",
        label: "Standard, 3 months",
        amountMinor: 5900,
        feature: "standard",
        term: { unit: "calendar_months", months: 3 },
      },
    ]);
    // A purchase receipt names the grant by its deterministic operation id; the
    // row id is not recorded by the shipped writer, and the contract says so.
    expect(receipt.grants).toEqual([
      {
        feature: "standard",
        startsAt: paidAt,
        expiresAt: receipt.grants[0]!.expiresAt,
        operationId: `${checkoutId}:standard`,
        grantId: null,
      },
    ]);
  });

  it("lists the refund receipt beside the purchase receipt, newest first", async () => {
    const actor = await learner();
    const certificationId = await exam();
    const checkoutId = await buy(actor, certificationId, "standard-3m");
    now = clock + day;
    const refunded = await call(
      `/api/commerce/checkouts/${checkoutId}/refund`,
      { actor, body: { reason: "receipt fixture" } },
    );
    expect(refunded.status).toBe(200);
    const refundBody = commerceRefundResponseSchema.parse(await refunded.json());

    const response = await list(actor, certificationId);
    const body = commerceReceiptListResponseSchema.parse(await response.json());
    expect(body.receipts).toHaveLength(2);
    const [refundReceipt, purchaseReceipt] = body.receipts;
    expect(refundReceipt!.kind).toBe("refund");
    expect(purchaseReceipt!.kind).toBe("purchase");
    expect(refundReceipt!.refundId).toBe(refundBody.refundId);
    expect(refundReceipt!.refundWindowEndsAt).toBeNull();
    expect(purchaseReceipt!.refundId).toBeNull();
    expect(refundReceipt!.totalMinor).toBe(5900);
    // The refund receipt names the row it revoked; that is the only shape that
    // carries a `grantId`.
    expect(refundReceipt!.grants).toHaveLength(1);
    expect(refundReceipt!.grants[0]!.grantId).not.toBeNull();
    expect(refundReceipt!.grants[0]!.operationId).toBe(`${checkoutId}:standard`);
    expect(refundReceipt!.receiptNumber).not.toBe(purchaseReceipt!.receiptNumber);
    expect(refundBody.status).toBe("settled");
  });

  it("caps the list at fifty and refuses a malformed limit", async () => {
    const actor = await learner();
    const certificationId = await exam();
    await buy(actor, certificationId, "standard-3m");

    const limited = await list(actor, certificationId, "&limit=1");
    expect(limited.status).toBe(200);
    expect(
      commerceReceiptListResponseSchema.parse(await limited.json()).receipts,
    ).toHaveLength(1);

    for (const extra of ["&limit=0", "&limit=51", "&limit=abc", "&cursor=x"]) {
      const response = await list(actor, certificationId, extra);
      expect(response.status, extra).toBe(400);
    }
    const missing = await call("/api/commerce/receipts", { actor });
    expect(missing.status).toBe(400);
    const duplicated = await call(
      `/api/commerce/receipts?certificationId=${certificationId}&certificationId=${certificationId}`,
      { actor },
    );
    expect(duplicated.status).toBe(400);
  });

  it("serves one receipt to its owner only", async () => {
    const actor = await learner();
    const other = await learner();
    const certificationId = await exam();
    const checkoutId = await buy(actor, certificationId, "standard-3m");
    const listed = commerceReceiptListResponseSchema.parse(
      await (await list(actor, certificationId)).json(),
    );
    const receiptId = listed.receipts[0]!.receiptId;

    const own = await call(`/api/commerce/receipts/${receiptId}`, { actor });
    expect(own.status).toBe(200);
    const body = commerceReceiptSchema.parse(await own.json());
    expect(body).toEqual(listed.receipts[0]);

    const foreign = await call(`/api/commerce/receipts/${receiptId}`, {
      actor: other,
    });
    expect(foreign.status).toBe(404);
    const missing = await call("/api/commerce/receipts/does-not-exist", {
      actor,
    });
    expect(missing.status).toBe(404);
    expect(checkoutId.length).toBeGreaterThan(0);
  });

  it("does not list another learner's receipts for the same exam", async () => {
    const actor = await learner();
    const other = await learner();
    const certificationId = await exam();
    await buy(actor, certificationId, "standard-3m");
    await buy(other, certificationId, "standard-6m");

    const mine = commerceReceiptListResponseSchema.parse(
      await (await list(actor, certificationId)).json(),
    );
    expect(mine.receipts).toHaveLength(1);
    expect(mine.receipts[0]!.totalMinor).toBe(5900);
    const theirs = commerceReceiptListResponseSchema.parse(
      await (await list(other, certificationId)).json(),
    );
    expect(theirs.receipts).toHaveLength(1);
    expect(theirs.receipts[0]!.totalMinor).toBe(8900);
  });

  it("answers 404 for an exam that does not exist", async () => {
    const actor = await learner();
    const response = await call(
      "/api/commerce/receipts?certificationId=not-an-exam",
      { actor },
    );
    expect(response.status).toBe(404);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("certification_not_found");
  });

  it("answers 503 when commerce is off and 401 without a session", async () => {
    const actor = await learner();
    const certificationId = await exam();
    const checkoutId = await buy(actor, certificationId, "standard-3m");

    const disabled = { ...bindings, COMMERCE_ENABLED: "false" };
    const disabledResponse = await application.fetch(
      new Request(`${origin}/api/commerce/receipts?certificationId=${certificationId}`),
      disabled as typeof bindings,
    );
    expect(disabledResponse.status).toBe(503);
    expect(
      ((await disabledResponse.json()) as { error: { code: string } }).error.code,
    ).toBe("commerce_disabled");

    const anonymous = await call(
      `/api/commerce/receipts?certificationId=${certificationId}`,
    );
    expect(anonymous.status).toBe(401);
    const anonymousRefund = await call(
      `/api/commerce/checkouts/${checkoutId}/refund`,
      { body: { reason: "no session" } },
    );
    expect(anonymousRefund.status).toBe(401);
  });

  it("carries no key that would imply a card, a tax statement or an identity", async () => {
    // No tax is computed and no column exists for one; no card datum exists; no
    // identity is stored. This test is the contract-level statement of that.
    const forbidden = /card|pan|cvv|tax|vat|gst|invoice|email|ip_?address|name/i;
    const actor = await learner();
    const certificationId = await exam();
    const checkoutId = await buy(actor, certificationId, "standard-3m");
    now = clock + day;
    expect(
      (
        await call(`/api/commerce/checkouts/${checkoutId}/refund`, {
          actor,
          body: { reason: "key fixture" },
        })
      ).status,
    ).toBe(200);

    const response = await list(actor, certificationId);
    const payload = (await response.json()) as unknown;
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      for (const [key, child] of Object.entries(value)) {
        keys.push(key);
        walk(child);
      }
    };
    walk(payload);
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.filter((key) => forbidden.test(key))).toEqual([]);

    const columns = await database
      .prepare("SELECT name FROM pragma_table_info('commerce_receipts')")
      .all<{ name: string }>();
    expect(
      columns.results.map((row) => row.name).filter((name) => forbidden.test(name)),
    ).toEqual([]);
  });
});
