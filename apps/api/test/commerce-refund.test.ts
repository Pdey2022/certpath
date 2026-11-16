import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  commerceCheckoutResponseSchema,
  commerceRefundResponseSchema,
} from "@certpath/contracts";
import { createApi } from "../src/index.ts";
import { addTerm } from "../src/calendar.ts";
import { can, evaluateAccess } from "../src/entitlements.ts";
import { refundWindowMs, termFor, type Sku } from "../src/pricing.ts";
import { createFakeProvider } from "../src/commerce/providers/fake.ts";
import type {
  FakePaymentProvider,
} from "../src/commerce/providers/fake.ts";
import type { RefundResult } from "../src/commerce/provider.ts";
import { readAccountGrants } from "../src/commerce/webhooks.ts";
import { createCsrfToken, sessionDigest } from "../src/security/http-session.ts";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  createProEnablement,
  createTestCertification,
  createTestIdentity,
  createTestLearnerUser,
  createTestSessionCredentials,
} from "./factories.ts";

// The refund route: decision, provider call, revocation.
//
// Every test here asserts the ledger *and* access, because the point of the
// change is that a learner has access because a grant row exists and a refund
// removes it. The negative twins matter as much as the happy paths: a refund must
// revoke what it refunded and nothing else, and a refusal must write nothing.

const database: SecurityDatabase = env.DB;
const origin = "https://localhost";
const csrfSecret = "local-worker-test-csrf-secret-with-enough-entropy";
const webhookSecret = "local-commerce-webhook-secret-with-enough-bytes";
const day = 86_400_000;
const baseClock = Date.parse("2026-02-01T00:00:00.000Z");

let now = baseClock;
let refundCalls = 0;
let refundBehaviour: "succeed" | "throw" | RefundResult = "succeed";

const fake = createFakeProvider({
  secret: webhookSecret,
  now: () => now,
  origin,
});

/**
 * The fake adapter with a refund seam: a test can make the provider decline or
 * time out, and count how many times money was asked for. `signEvent` is kept, so
 * the dev seam still recognises the adapter.
 */
const provider: FakePaymentProvider = {
  ...fake,
  async refund(input) {
    refundCalls += 1;
    if (refundBehaviour === "throw") throw new Error("provider timeout");
    if (refundBehaviour !== "succeed") return refundBehaviour;
    return { status: "succeeded", refundRef: `fake_refund_${input.refundId}` };
  },
};

const application = createApi(
  fetch,
  () => now,
  undefined,
  undefined,
  provider,
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

async function exam(options: { proEnabled?: boolean } = {}): Promise<string> {
  const ownerUserId = await createTestLearnerUser(database);
  const certificationId = await createTestCertification(database, ownerUserId);
  if (options.proEnabled) {
    await createProEnablement(database, certificationId, ownerUserId);
  }
  return certificationId;
}

interface CallOptions {
  method?: string;
  actor?: Learner;
  body?: unknown;
  headers?: Record<string, string>;
  bindings?: typeof bindings;
}

function call(path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.actor) headers.Cookie = `certpath_session=${options.actor.cookie}`;
  headers.Origin = headers.Origin ?? origin;
  if (options.actor && headers["X-CSRF-Token"] === undefined) {
    headers["X-CSRF-Token"] = options.actor.csrf;
  }
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

/**
 * Create `sku`'s checkout at `atMs` without paying it.
 */
async function openCheckout(
  actor: Learner,
  certificationId: string,
  sku: Sku,
  atMs: number = now,
): Promise<string> {
  const previous = now;
  now = atMs;
  try {
    const created = await call("/api/commerce/checkouts", {
      actor,
      body: {
        certificationId,
        sku,
        clientCheckoutKey: crypto.randomUUID(),
      },
    });
    expect(created.status, sku).toBe(201);
    return commerceCheckoutResponseSchema.parse(await created.json())
      .checkoutId;
  } finally {
    now = previous;
  }
}

/**
 * Buy `sku` at `atMs` and settle it through the real webhook path (the dev seam),
 * so the checkout, its grants and its receipt come from the shipped writers.
 */
async function buy(
  actor: Learner,
  certificationId: string,
  sku: Sku,
  atMs: number = now,
): Promise<string> {
  const previous = now;
  now = atMs;
  try {
    const checkoutId = await openCheckout(actor, certificationId, sku);
    const paid = await call("/api/commerce/dev/fake-pay", {
      actor,
      body: { checkoutId },
    });
    expect(paid.status, sku).toBe(200);
    expect((await paid.json()) as { duplicate: boolean }).toMatchObject({
      received: true,
      duplicate: false,
    });
    return checkoutId;
  } finally {
    now = previous;
  }
}

async function refund(
  actor: Learner,
  checkoutId: string,
  options: { reason?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return call(`/api/commerce/checkouts/${checkoutId}/refund`, {
    actor,
    body: { reason: options.reason ?? "Changed my mind" },
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
}

async function checkoutRow(checkoutId: string) {
  return database
    .prepare(
      `SELECT status, paid_at, total_minor FROM commerce_checkouts WHERE id = ?`,
    )
    .bind(checkoutId)
    .first<{ status: string; paid_at: number | null; total_minor: number }>();
}

async function grants(userId: string, certificationId: string) {
  return database
    .prepare(
      `SELECT id, feature, starts_at, expires_at, revoked_at, source,
              operation_id, revocation_operation_id
       FROM learner_access_grants
       WHERE user_id = ? AND certification_id = ?
       ORDER BY rowid`,
    )
    .bind(userId, certificationId)
    .all<{
      id: string;
      feature: string;
      starts_at: number;
      expires_at: number;
      revoked_at: number | null;
      source: string | null;
      operation_id: string | null;
      revocation_operation_id: string | null;
    }>();
}

/** Refunds written for one learner; the database is shared across this file. */
async function refundCount(userId: string): Promise<number> {
  const row = await database
    .prepare(
      "SELECT COUNT(*) AS rows FROM commerce_refunds WHERE user_id = ?",
    )
    .bind(userId)
    .first<{ rows: number }>();
  return row?.rows ?? -1;
}

describe("refunds", () => {
  beforeEach(() => {
    now = baseClock;
    refundCalls = 0;
    refundBehaviour = "succeed";
  });

  it("settles a Standard-only refund and ends access with no grace", async () => {
    const actor = await learner();
    const certificationId = await exam();
    const checkoutId = await buy(actor, certificationId, "standard-3m", now);
    const paidAt = (await checkoutRow(checkoutId))!.paid_at!;
    refundCalls = 0;

    const response = await refund(actor, checkoutId);
    expect(response.status).toBe(200);
    const body = commerceRefundResponseSchema.parse(await response.json());
    expect(body.status).toBe("settled");
    expect(body.amountMinor).toBe(5900);
    expect(body.checkouts).toEqual([
      {
        checkoutId,
        sku: "standard-3m",
        amountMinor: 5900,
        includedBecause: "requested",
      },
    ]);
    if (body.status !== "settled") throw new Error("unreachable");
    expect(body.revoked).toHaveLength(1);
    expect(body.revoked[0]!.feature).toBe("standard");
    expect(body.receipts).toHaveLength(1);
    expect(body.access).toBe("ended");
    expect(refundCalls).toBe(1);

    const checkout = await checkoutRow(checkoutId);
    expect(checkout!.status).toBe("refunded");
    expect(checkout!.paid_at).toBe(paidAt);

    const rows = await grants(actor.userId, certificationId);
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.revoked_at).not.toBeNull();
    expect(rows.results[0]!.revocation_operation_id).toBe(
      `refund:${body.refundId}:${rows.results[0]!.id}`,
    );

    // The refund receipt exists and carries no window.
    const receipt = await database
      .prepare(
        `SELECT kind, total_minor, refund_window_ends_at, refund_id
         FROM commerce_receipts WHERE checkout_id = ? AND kind = 'refund'`,
      )
      .bind(checkoutId)
      .first<{
        kind: string;
        total_minor: number;
        refund_window_ends_at: number | null;
        refund_id: string;
      }>();
    expect(receipt).toMatchObject({
      kind: "refund",
      total_minor: 5900,
      refund_window_ends_at: null,
      refund_id: body.refundId,
    });

    // Access is gone, and it is `expired` rather than `grace`: 0013's revoke
    // trigger writes the revocation, `evaluateAccess` filters it out, and grace is
    // only reachable from a grant that is still there.
    const records = await readAccountGrants(
      database,
      actor.userId,
      certificationId,
    );
    const access = evaluateAccess(records, now);
    expect(access.standard.state).toBe("expired");
    expect(access.pro.state).toBe("expired");
    expect(access.standard.graceEndsAt).toBeNull();
    expect(access.pro.graceEndsAt).toBeNull();
    expect(can(access, "results")).toBe(false);
    expect(can(access, "practice")).toBe(false);
    expect(can(access, "mock")).toBe(false);

    // The checkout read stops advertising a window once it has been used.
    const read = await call(`/api/commerce/checkouts/${checkoutId}`, { actor });
    expect(read.status).toBe(200);
    const readBody = commerceCheckoutResponseSchema.parse(await read.json());
    expect(readBody.status).toBe("refunded");
    expect(readBody.paidAt).toBe(paidAt);
    expect(readBody.refundWindowEndsAt).toBeNull();
    expect(readBody.redirectUrl).toBeNull();
  });

  it("settles a Pro-only refund and leaves Standard coverage alone", async () => {
    now = baseClock;
    const actor = await learner();
    const certificationId = await exam({ proEnabled: true });
    await buy(actor, certificationId, "standard-12m", now);
    const proCheckoutId = await buy(actor, certificationId, "pro-3m", now);
    refundCalls = 0;

    const response = await refund(actor, proCheckoutId);
    expect(response.status).toBe(200);
    const body = commerceRefundResponseSchema.parse(await response.json());
    if (body.status !== "settled") throw new Error("expected settled");
    expect(body.revoked.map((grant) => grant.feature)).toEqual(["pro"]);
    expect(refundCalls).toBe(1);

    const records = await readAccountGrants(
      database,
      actor.userId,
      certificationId,
    );
    const access = evaluateAccess(records, now);
    expect(access.standard.state).toBe("active");
    expect(access.pro.state).toBe("expired");
    expect(can(access, "practice")).toBe(true);
  });

  it("settles a bundle refund in one record, revoking Pro before Standard", async () => {
    now = baseClock;
    const actor = await learner();
    const certificationId = await exam({ proEnabled: true });
    const checkoutId = await buy(
      actor,
      certificationId,
      "bundle-standard-3m-pro",
      now,
    );

    const response = await refund(actor, checkoutId);
    expect(response.status).toBe(200);
    const body = commerceRefundResponseSchema.parse(await response.json());
    if (body.status !== "settled") throw new Error("expected settled");
    expect(body.amountMinor).toBe(9900);
    expect(body.revoked.map((grant) => grant.feature)).toEqual([
      "pro",
      "standard",
    ]);
    expect(body.receipts).toHaveLength(1);

    const records = await readAccountGrants(
      database,
      actor.userId,
      certificationId,
    );
    expect(records).toHaveLength(2);
    expect(records.every((grant) => grant.revokedAt !== null)).toBe(true);
  });

  it("settles on the last millisecond of the window and refuses a millisecond later", async () => {
    now = baseClock;
    const actor = await learner();
    const certificationId = await exam();
    const checkoutId = await buy(actor, certificationId, "standard-3m", now);
    const paidAt = (await checkoutRow(checkoutId))!.paid_at!;

    now = paidAt + refundWindowMs;
    const late = await refund(actor, checkoutId);
    expect(late.status).toBe(400);
    expect(((await late.json()) as { error: { code: string } }).error.code).toBe(
      "refund_window_closed",
    );
    expect(await refundCount(actor.userId)).toBe(0);
    expect((await checkoutRow(checkoutId))!.status).toBe("paid");

    now = paidAt + refundWindowMs - 1;
    const inside = await refund(actor, checkoutId);
    expect(inside.status).toBe(200);
  });

  it("expands to a dependent Pro purchase inside its own window", async () => {
    now = baseClock;
    const actor = await learner();
    const certificationId = await exam({ proEnabled: true });
    const standardCheckoutId = await buy(
      actor,
      certificationId,
      "standard-12m",
      now,
    );
    const proCheckoutId = await buy(actor, certificationId, "pro-3m", now + day);

    now = baseClock + 2 * day;
    const response = await refund(actor, standardCheckoutId);
    expect(response.status).toBe(200);
    const body = commerceRefundResponseSchema.parse(await response.json());
    if (body.status !== "settled") throw new Error("expected settled");
    expect(body.checkouts).toHaveLength(2);
    expect(body.checkouts[0]).toMatchObject({
      checkoutId: standardCheckoutId,
      sku: "standard-12m",
      includedBecause: "requested",
    });
    expect(body.checkouts[1]).toMatchObject({
      checkoutId: proCheckoutId,
      sku: "pro-3m",
      includedBecause: "dependent-pro",
    });
    expect(body.amountMinor).toBe(12_900 + 4_900);
    expect(body.revoked.map((grant) => grant.feature)).toEqual([
      "pro",
      "standard",
    ]);
    expect(body.receipts).toHaveLength(2);
    expect((await checkoutRow(standardCheckoutId))!.status).toBe("refunded");
    expect((await checkoutRow(proCheckoutId))!.status).toBe("refunded");
  });

  it("refuses to orphan a staff-granted Pro and writes nothing", async () => {
    // A Global Admin's commercial act: `source = 'grant'`, so nothing here can
    // give the money back. Both shapes are refused, and the second one isolates
    // the **provenance** check: its operation id resolves to this learner's own
    // paid, in-window checkout - the `:pro` leg a Standard-only SKU never wrote -
    // so without the `source` test the planner would refund that Standard
    // purchase as the "companion" of a grant it cannot pay for.
    const attempt = async (
      shape: "no-operation-id" | "paid-checkout-operation-id",
    ): Promise<{
      status: number;
      code: string | undefined;
      refunds: number;
      calls: number;
      checkoutStatus: string;
      allLive: boolean;
    }> => {
      const staffActor = await learner();
      const staffExam = await exam({ proEnabled: true });
      const checkoutId = await buy(
        staffActor,
        staffExam,
        "standard-12m",
        now,
      );
      const staffOwner = await createTestLearnerUser(database);
      await database
        .prepare(
          `INSERT INTO learner_access_grants (
             id, user_id, certification_id, feature, starts_at, expires_at,
             revoked_at, created_at, sku, source, operation_id, created_by_user_id
           ) VALUES (?, ?, ?, 'pro', ?, ?, NULL, ?, 'pro-3m', 'grant', ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          staffActor.userId,
          staffExam,
          now,
          addTerm(now, termFor("standard-3m")),
          now,
          shape === "no-operation-id" ? null : `${checkoutId}:pro`,
          staffOwner,
        )
        .run();
      refundCalls = 0;
      const response = await refund(staffActor, checkoutId);
      const body = (await response.json()) as { error?: { code: string } };
      const rows = await grants(staffActor.userId, staffExam);
      return {
        status: response.status,
        code: body.error?.code,
        refunds: await refundCount(staffActor.userId),
        calls: refundCalls,
        checkoutStatus: (await checkoutRow(checkoutId))!.status,
        allLive: rows.results.every((grant) => grant.revoked_at === null),
      };
    };

    for (const shape of [
      "no-operation-id",
      "paid-checkout-operation-id",
    ] as const) {
      const outcome = await attempt(shape);
      expect(outcome.status, shape).toBe(409);
      expect(outcome.code, shape).toBe("refund_requires_support");
      expect(outcome.refunds, shape).toBe(0);
      expect(outcome.calls, shape).toBe(0);
      expect(outcome.checkoutStatus, shape).toBe("paid");
      expect(outcome.allLive, shape).toBe(true);
    }
  });

  it("refuses a refund that would leave future-but-not-present coverage", async () => {
    now = baseClock;
    const actor = await learner();
    const certificationId = await exam();
    const first = await buy(actor, certificationId, "standard-3m", now);
    const second = await buy(actor, certificationId, "standard-3m", now + 3 * day);

    now = baseClock + 4 * day;
    const refused = await refund(actor, first);
    expect(refused.status).toBe(409);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe("refund_requires_support");
    expect(await refundCount(actor.userId)).toBe(0);
    expect((await checkoutRow(first))!.status).toBe("paid");

    // The later purchase is refundable, and the earlier one keeps the learner
    // inside their paid window: the refund takes away only what it refunded.
    const allowed = await refund(actor, second);
    expect(allowed.status).toBe(200);
    const records = await readAccountGrants(
      database,
      actor.userId,
      certificationId,
    );
    expect(evaluateAccess(records, now).standard.state).toBe("active");
  });

  it("replays a settled refund without calling the provider twice", async () => {
    now = baseClock;
    const actor = await learner();
    const certificationId = await exam();
    const checkoutId = await buy(actor, certificationId, "standard-3m", now);
    refundCalls = 0;

    const first = await refund(actor, checkoutId);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const replay = await refund(actor, checkoutId);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(refundCalls).toBe(1);
    expect(await refundCount(actor.userId)).toBe(1);
  });

  it("resumes a requested refund under the same refund id", async () => {
    now = baseClock;
    const actor = await learner();
    const certificationId = await exam();
    const checkoutId = await buy(actor, certificationId, "standard-3m", now);

    refundCalls = 0;
    refundBehaviour = "throw";
    const pending = await refund(actor, checkoutId);
    expect(pending.status).toBe(202);
    const pendingBody = commerceRefundResponseSchema.parse(
      await pending.json(),
    );
    expect(pendingBody.status).toBe("requested");
    expect(await refundCount(actor.userId)).toBe(1);
    // Nothing was revoked while the provider had not confirmed.
    const untouched = await grants(actor.userId, certificationId);
    expect(untouched.results[0]!.revoked_at).toBeNull();
    expect((await checkoutRow(checkoutId))!.status).toBe("paid");

    refundBehaviour = "succeed";
    const settled = await refund(actor, checkoutId);
    expect(settled.status).toBe(200);
    const settledBody = commerceRefundResponseSchema.parse(await settled.json());
    if (settledBody.status !== "settled") throw new Error("expected settled");
    expect(settledBody.refundId).toBe(pendingBody.refundId);
    expect(refundCalls).toBe(2);
    expect(await refundCount(actor.userId)).toBe(1);
  });

  it("reports a provider decline as 409 refund_rejected and does not consume the cap", async () => {
    now = baseClock;
    const actor = await learner();
    const certificationId = await exam();
    const checkoutId = await buy(actor, certificationId, "standard-3m", now);

    refundBehaviour = { status: "rejected", reason: "card_declined" };
    const rejected = await refund(actor, checkoutId);
    expect(rejected.status).toBe(409);
    expect(
      ((await rejected.json()) as { error: { code: string } }).error.code,
    ).toBe("refund_rejected");
    const row = await database
      .prepare("SELECT status FROM commerce_refunds WHERE user_id = ?")
      .bind(actor.userId)
      .first<{ status: string }>();
    expect(row?.status).toBe("failed");
    expect((await checkoutRow(checkoutId))!.status).toBe("paid");

    refundBehaviour = "succeed";
    const retried = await refund(actor, checkoutId);
    expect(retried.status).toBe(200);
  });

  it("reports a provider outage as 503 and keeps access live", async () => {
    now = baseClock;
    const actor = await learner();
    const certificationId = await exam();
    const checkoutId = await buy(actor, certificationId, "standard-3m", now);

    refundBehaviour = { status: "failed", reason: "provider_error" };
    const outage = await refund(actor, checkoutId);
    expect(outage.status).toBe(503);
    expect(
      ((await outage.json()) as { error: { code: string } }).error.code,
    ).toBe("provider_unavailable");
    const records = await readAccountGrants(
      database,
      actor.userId,
      certificationId,
    );
    expect(evaluateAccess(records, now).standard.state).toBe("active");
  });

  it("refuses a checkout that is not paid", async () => {
    for (const status of [
      "pending",
      "failed",
      "expired",
      "needs_support",
    ] as const) {
      const actor = await learner();
      const certificationId = await exam();
      const checkoutId = await openCheckout(
        actor,
        certificationId,
        "standard-3m",
      );
      if (status !== "pending") {
        await database
          .prepare(
            `UPDATE commerce_checkouts
             SET status = ?, paid_at = ?, updated_at = ?
             WHERE id = ? AND status = 'pending'`,
          )
          .bind(
            status,
            status === "needs_support" ? now : null,
            now,
            checkoutId,
          )
          .run();
      }
      const response = await refund(actor, checkoutId);
      expect(response.status, status).toBe(409);
      expect(
        ((await response.json()) as { error: { code: string } }).error.code,
        status,
      ).toBe("refund_not_allowed");
      expect(await refundCount(actor.userId)).toBe(0);
    }
  });

  it("refuses another learner's checkout, a missing session and a bad mutation", async () => {
    now = baseClock;
    const actor = await learner();
    const other = await learner();
    const certificationId = await exam();
    const checkoutId = await buy(actor, certificationId, "standard-3m", now);
    refundCalls = 0;

    const foreign = await refund(other, checkoutId);
    expect(foreign.status).toBe(404);
    expect(
      ((await foreign.json()) as { error: { code: string } }).error.code,
    ).toBe("checkout_not_found");

    const anonymous = await call(
      `/api/commerce/checkouts/${checkoutId}/refund`,
      { body: { reason: "no session" } },
    );
    expect(anonymous.status).toBe(401);

    const wrongOrigin = await refund(actor, checkoutId, {
      headers: { Origin: "https://evil.example" },
    });
    expect(wrongOrigin.status).toBe(400);
    const noCsrf = await call(`/api/commerce/checkouts/${checkoutId}/refund`, {
      actor,
      body: { reason: "no csrf" },
      headers: { "X-CSRF-Token": "" },
    });
    expect(noCsrf.status).toBe(400);

    expect(await refundCount(actor.userId)).toBe(0);
    expect(refundCalls).toBe(0);
    expect((await checkoutRow(checkoutId))!.status).toBe("paid");
  });

  it("keeps the learner's reason out of the audit trail", async () => {
    now = baseClock;
    const actor = await learner();
    const certificationId = await exam();
    const checkoutId = await buy(actor, certificationId, "standard-3m", now);
    const reason = "Refund please, my plans changed";

    const response = await refund(actor, checkoutId, { reason });
    expect(response.status).toBe(200);

    const audit = await database
      .prepare(
        `SELECT action, reason, operation_id FROM audit_events
         WHERE certification_id = ? ORDER BY occurred_at`,
      )
      .bind(certificationId)
      .all<{ action: string; reason: string; operation_id: string }>();
    const revoked = audit.results.filter(
      (row) => row.action === "access_revoked",
    );
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.reason).toBe("Access revoked");
    expect(audit.results.some((row) => row.reason.includes(reason))).toBe(false);
    expect(revoked[0]!.operation_id).toMatch(/^refund:rfd_.+:.+$/);

    const stored = await database
      .prepare("SELECT reason FROM commerce_refunds WHERE user_id = ?")
      .bind(actor.userId)
      .first<{ reason: string }>();
    expect(stored?.reason).toBe(reason);
  });

  it("answers 503 rather than a false 200 when a settled refund's ledger disagrees", async () => {
    // The batch writes the refund, the revocation and the receipt in one
    // transaction, so this state is unreachable from the shipped writer. If it is
    // reached anyway - a hand-written row, a future bug - the route must not
    // answer 200 with a body claiming access ended. Unknown state denies.
    const actor = await learner();
    const certificationId = await exam();
    const checkoutId = await buy(actor, certificationId, "standard-3m");
    const row = (await database
      .prepare(
        `SELECT user_id, certification_id, currency, total_minor, paid_at
         FROM commerce_checkouts WHERE id = ?`,
      )
      .bind(checkoutId)
      .first<{
        user_id: string;
        certification_id: string;
        currency: string;
        total_minor: number;
        paid_at: number;
      }>())!;
    const refundId = `rfd_${crypto.randomUUID()}`;
    await database
      .prepare(
        `INSERT INTO commerce_refunds (
           id, user_id, certification_id, requested_by_user_id, status, currency,
           amount_minor, reason, operation_id, provider, provider_refund_id,
           requested_at, settled_at)
         VALUES (?, ?, ?, ?, 'requested', ?, ?, 'Synthetic ledger fixture', ?,
                 'fake', NULL, ?, NULL)`,
      )
      .bind(
        refundId,
        row.user_id,
        row.certification_id,
        row.user_id,
        row.currency,
        row.total_minor,
        `refund:${refundId}`,
        now,
      )
      .run();
    await database
      .prepare(
        `INSERT INTO commerce_refund_lines (
           refund_id, position, checkout_id, amount_minor, window_ends_at)
         VALUES (?, 0, ?, ?, ?)`,
      )
      .bind(refundId, checkoutId, row.total_minor, row.paid_at + refundWindowMs)
      .run();
    await database
      .prepare(
        `UPDATE commerce_refunds SET status = 'settled', settled_at = ?,
                provider_refund_id = ?
         WHERE id = ? AND status = 'requested'`,
      )
      .bind(now, `fake_refund_${refundId}`, refundId)
      .run();

    const response = await refund(actor, checkoutId);
    expect(response.status).toBe(503);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("provider_unavailable");
  });

  it("never writes a purchase grant that starts before its checkout was paid", async () => {
    // The expansion lemma's premise, and nothing in storage enforces it: a
    // backdated grant would make a refund legal on a purchase outside its window.
    for (const sku of [
      "standard-3m",
      "standard-6m",
      "standard-12m",
      "bundle-standard-3m-pro",
      "pro-3m",
      "standard-topup-3m",
      "standard-extension-30d",
    ] as Sku[]) {
      now = baseClock;
      const actor = await learner();
      const certificationId = await exam({ proEnabled: true });
      switch (sku) {
        case "pro-3m":
          await buy(actor, certificationId, "standard-12m", baseClock);
          await buy(actor, certificationId, sku, baseClock + 3_600_000);
          break;
        case "standard-topup-3m":
        case "standard-extension-30d":
          await buy(actor, certificationId, "standard-3m", baseClock);
          await buy(actor, certificationId, sku, baseClock + day);
          break;
        default:
          await buy(actor, certificationId, sku, baseClock);
          break;
      }

      const rows = await database
        .prepare(
          `SELECT grant_record.starts_at, checkout.paid_at
           FROM learner_access_grants AS grant_record
           JOIN commerce_checkouts AS checkout
             ON grant_record.operation_id =
                checkout.id || CASE grant_record.feature
                                 WHEN 'pro' THEN ':pro' ELSE ':standard'
                               END
           WHERE grant_record.user_id = ?`,
        )
        .bind(actor.userId)
        .all<{ starts_at: number; paid_at: number }>();
      expect(rows.results.length, sku).toBeGreaterThan(0);
      for (const row of rows.results) {
        expect(row.starts_at, sku).toBeGreaterThanOrEqual(row.paid_at);
      }
    }
  });
});
