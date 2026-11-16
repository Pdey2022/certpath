import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  commerceCheckoutResponseSchema,
  commerceRefundResponseSchema,
  learnerDashboardResponseSchema,
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
/**
 * A seam that runs *while* the provider call is in flight, which is the only
 * place a race with another request or another tab can be reproduced: a second
 * settlement, or a second submit that settles this refund first. Cleared before
 * it runs, so a hook that calls the refund route cannot recurse.
 */
let refundHook: (() => Promise<void>) | null = null;

const fake = createFakeProvider({
  secret: webhookSecret,
  now: () => now,
  origin,
});

/**
 * The fake adapter with a refund seam: a test can make the provider decline or
 * time out, count how many times money was asked for, and run a callback between
 * the request and the answer. `signEvent` is kept, so the dev seam still
 * recognises the adapter.
 */
const provider: FakePaymentProvider = {
  ...fake,
  async refund(input) {
    refundCalls += 1;
    const hook = refundHook;
    refundHook = null;
    if (hook) await hook();
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

/**
 * One exam version row, written directly.
 *
 * The practice routes resolve a version before they look at content, and the
 * dashboard joins one, so an exam with no version asserts nothing: a missing group
 * or a refused attempt would be true before the refund as well. This file tests
 * commerce, not content, so the version is a fixture rather than a published one.
 */
async function examVersion(certificationId: string): Promise<string> {
  const id = crypto.randomUUID();
  const createdByUserId = await createTestLearnerUser(database);
  await database
    .prepare(
      `INSERT INTO exam_versions (
         id, certification_id, version_key, title, syllabus_reference,
         effective_from, effective_until, created_by_user_id,
         created_operation_id, creation_reason, created_at)
       VALUES (?, ?, ?, 'Synthetic exam version', 'Synthetic syllabus', NULL,
               NULL, ?, ?, 'Synthetic test fixture', ?)`,
    )
    .bind(
      id,
      certificationId,
      `version-${id}`,
      createdByUserId,
      `fixture-exam-version:${id}`,
      now,
    )
    .run();
  return id;
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

/**
 * A practice attempt start. Its body is §8.4's business, not this PR's: the point
 * here is that after a refund the route refuses for want of access.
 */
function startPractice(
  actor: Learner,
  certificationId: string,
  examVersionId: string,
): Promise<Response> {
  return call("/api/practice/attempts", {
    actor,
    body: {
      certificationId,
      examVersionId,
      questionCount: 5,
      requestId: crypto.randomUUID(),
    },
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
    refundHook = null;
  });

  it("settles a Standard-only refund and ends access with no grace", async () => {
    // Real time, not the synthetic clock: the practice routes read the session and
    // the grants at `Date.now()`, so a fixture bought in February 2026 would look
    // expired to them before any refund ran, and §11 #12's two assertions would
    // pass for the wrong reason.
    now = Date.now();
    const actor = await learner();
    const certificationId = await exam();
    const examVersionId = await examVersion(certificationId);
    const checkoutId = await buy(actor, certificationId, "standard-3m", now);
    const paidAt = (await checkoutRow(checkoutId))!.paid_at!;

    // Before the refund: the exam is on the dashboard and an attempt is refused
    // only for want of content, which is what makes the "after" pair below about
    // the revocation rather than about an empty fixture.
    const dashboardBefore = await call("/api/practice/dashboard", { actor });
    expect(dashboardBefore.status).toBe(200);
    expect(
      learnerDashboardResponseSchema
        .parse(await dashboardBefore.json())
        .groups.map((group) => group.certificationId),
    ).toContain(certificationId);
    const attemptBefore = await startPractice(
      actor,
      certificationId,
      examVersionId,
    );
    expect(attemptBefore.status).toBe(409);

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

    // §11 #12's second half, at the routes the learner actually calls: the exam is
    // gone from the dashboard and a fresh attempt is refused. Neither is a
    // client-side decision - the dashboard query already selects `revoked_at IS
    // NULL`, so the refunded grant never reaches it.
    const dashboardAfter = await call("/api/practice/dashboard", { actor });
    expect(dashboardAfter.status).toBe(200);
    expect(
      learnerDashboardResponseSchema
        .parse(await dashboardAfter.json())
        .groups.filter((group) => group.certificationId === certificationId),
    ).toHaveLength(0);
    const attemptAfter = await startPractice(
      actor,
      certificationId,
      examVersionId,
    );
    expect(attemptAfter.status).toBe(403);
    expect(
      ((await attemptAfter.json()) as { error: { code: string } }).error.code,
    ).toBe("access_required");

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

  it("answers 503 and keeps access when a purchase lands during the provider call", async () => {
    // The coverage-gap guard's race (owner decision 1, §15 of the design), and the
    // one §4.3 originally got wrong. The learner owns live Standard `A` and asks to
    // refund it; the gap guard passes because `A` is the only grant. While the
    // provider is being called a second tab settles chained Standard `B`, whose
    // window starts where `A`'s ends. Revoking `A` now would leave *future but not
    // present* coverage - a locked-out learner with no purchasable route back - so
    // the settle must refuse.
    //
    // A retry cannot repair it by adding `B`: the lines are immutable and the
    // provider has already been told the amount. So the answer is 503 with the
    // refund `requested`: money returned, access retained, an operator resolves.
    now = baseClock;
    const actor = await learner();
    const certificationId = await exam();
    const live = await buy(actor, certificationId, "standard-3m", now);
    const chained = await openCheckout(actor, certificationId, "standard-3m");

    refundHook = async () => {
      const paid = await call("/api/commerce/dev/fake-pay", {
        actor,
        body: { checkoutId: chained },
      });
      expect(paid.status).toBe(200);
    };

    const response = await refund(actor, live);
    expect(response.status).toBe(503);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("provider_unavailable");

    // The race really happened: two Standard grants exist, so the guard was
    // exercised rather than skipped.
    const rows = await grants(actor.userId, certificationId);
    expect(rows.results).toHaveLength(2);
    expect(rows.results.every((grant) => grant.revoked_at === null)).toBe(true);
    expect((await checkoutRow(live))!.status).toBe("paid");

    // The ledger keeps the decision: `requested` is the work queue, and writing
    // `failed` for a refund the provider has already paid would be a lie.
    const refunds = await database
      .prepare(
        "SELECT status, settled_at FROM commerce_refunds WHERE user_id = ?",
      )
      .bind(actor.userId)
      .all<{ status: string; settled_at: number | null }>();
    expect(refunds.results).toHaveLength(1);
    expect(refunds.results[0]!.status).toBe("requested");
    expect(refunds.results[0]!.settled_at).toBeNull();

    const access = evaluateAccess(
      await readAccountGrants(database, actor.userId, certificationId),
      now,
    );
    expect(access.standard.state).toBe("active");
    expect(can(access, "practice")).toBe(true);
  });

  it("answers 503 when a Pro settlement lands during the provider call", async () => {
    // §10 and §4.3 state, as settled behaviour, that a concurrent Pro settlement
    // our Standard revocation would uncover "aborts at 0014 on every retry, so the
    // answer is the same 503 requested". That is only true if
    // `isConstraintFailure` - a substring match on D1's message - matches the text
    // of 0014's `RAISE(ABORT, 'revoking this standard grant would leave a pro grant
    // uncovered')`. This test decides the claim: if the classifier is wrong, the
    // error is rethrown as an undiagnosed failure and the route answers 500.
    now = baseClock;
    const actor = await learner();
    const certificationId = await exam({ proEnabled: true });
    const live = await buy(actor, certificationId, "standard-3m", now);
    const standard = await database
      .prepare(
        `SELECT starts_at, expires_at FROM learner_access_grants
         WHERE operation_id = ? AND revoked_at IS NULL`,
      )
      .bind(`${live}:standard`)
      .first<{ starts_at: number; expires_at: number }>();
    expect(standard).not.toBeNull();

    // A Pro grant written straight into storage, in the window the Standard grant
    // covers and under a purchase operation id that names a checkout outside this
    // refund's immutable line set - the shape a second checkout settling during our
    // provider call produces. Written directly because the refund has already been
    // planned and the provider already called by the time a hook can run.
    refundHook = async () => {
      await database
        .prepare(
          `INSERT INTO learner_access_grants (
             id, user_id, certification_id, feature, starts_at, expires_at,
             created_at, sku, source, operation_id)
           VALUES (?, ?, ?, 'pro', ?, ?, ?, 'pro-3m', 'purchase', ?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor.userId,
          certificationId,
          standard!.starts_at,
          standard!.expires_at,
          now,
          `chk_${crypto.randomUUID()}:pro`,
        )
        .run();
    };

    const response = await refund(actor, live);
    expect(response.status).toBe(503);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("provider_unavailable");

    // Money returned by the provider, nothing revoked, nothing settled: the same
    // fail-closed shape as the coverage-gap race, and for the same reason - the
    // lines are immutable, so the set cannot be expanded to swallow the Pro row.
    const rows = await grants(actor.userId, certificationId);
    expect(rows.results).toHaveLength(2);
    expect(rows.results.every((grant) => grant.revoked_at === null)).toBe(true);
    expect((await checkoutRow(live))!.status).toBe("paid");
    const refunds = await database
      .prepare(
        "SELECT status, settled_at FROM commerce_refunds WHERE user_id = ?",
      )
      .bind(actor.userId)
      .all<{ status: string; settled_at: number | null }>();
    expect(refunds.results).toHaveLength(1);
    expect(refunds.results[0]!.status).toBe("requested");
    expect(refunds.results[0]!.settled_at).toBeNull();

    const access = evaluateAccess(
      await readAccountGrants(database, actor.userId, certificationId),
      now,
    );
    expect(can(access, "practice")).toBe(true);
  });

  it("answers 200 for a refund a concurrent request settled first", async () => {
    // A double submit: both calls reach the provider, the *other* request wins the
    // settle, and ours then loses every compare-and-swap because the refund is
    // already `settled` - statement 3 cannot match a `requested` row. Answering
    // `503 provider_unavailable` there would report an outage for a refund that
    // succeeded, so the re-read decides.
    now = baseClock;
    const actor = await learner();
    const certificationId = await exam();
    const checkoutId = await buy(actor, certificationId, "standard-3m", now);

    let settledElsewhere: unknown = null;
    refundHook = async () => {
      const other = await refund(actor, checkoutId);
      expect(other.status).toBe(200);
      settledElsewhere = await other.json();
    };

    const response = await refund(actor, checkoutId);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(commerceRefundResponseSchema.parse(body).status).toBe("settled");

    // Identical to a plain replay, because the body is a projection of storage and
    // not of whichever request happened to do the writing.
    expect(body).toEqual(settledElsewhere);
    const replay = await refund(actor, checkoutId);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(body);
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

  it("answers 500 with the house envelope when a settle fails for a non-constraint reason", async () => {
    // The seam the route previously had none for: a provider that says `succeeded`
    // with no `refundRef`. That value is bound into the settle statement, so the
    // failure is a D1 type error whose message does not match `/constraint/i` - a
    // bug or an outage we have not diagnosed, not a lost race. It must reach the
    // client as the house envelope with a correlation id, not as a bare
    // `500 Internal Server Error` with the request id lost.
    now = baseClock;
    const actor = await learner();
    const certificationId = await exam();
    const checkoutId = await buy(actor, certificationId, "standard-3m", now);

    refundBehaviour = {
      status: "succeeded",
      refundRef: undefined,
    } as unknown as RefundResult;

    const response = await refund(actor, checkoutId);
    expect(response.status).toBe(500);
    const requestId = response.headers.get("X-Request-Id");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await response.json()).toEqual({
      error: { code: "internal_error", requestId },
    });
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    // Fail-closed: the bind threw before the batch ran, so nothing was written and
    // access is untouched.
    const refunds = await database
      .prepare("SELECT status, settled_at FROM commerce_refunds WHERE user_id = ?")
      .bind(actor.userId)
      .all<{ status: string; settled_at: number | null }>();
    expect(refunds.results).toHaveLength(1);
    expect(refunds.results[0]!.status).toBe("requested");
    expect(refunds.results[0]!.settled_at).toBeNull();
    expect((await checkoutRow(checkoutId))!.status).toBe("paid");
    const access = evaluateAccess(
      await readAccountGrants(database, actor.userId, certificationId),
      now,
    );
    expect(can(access, "practice")).toBe(true);
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
