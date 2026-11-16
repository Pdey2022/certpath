import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { commerceCheckoutResponseSchema } from "@certpath/contracts";
import { createApi } from "../src/index.ts";
import { refundWindowMs } from "../src/pricing.ts";
import { createFakeProvider } from "../src/commerce/providers/fake.ts";
import { applyRefundSettlement } from "../src/commerce/refunds.ts";
import { createCsrfToken, sessionDigest } from "../src/security/http-session.ts";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  createProEnablement,
  createTestCertification,
  createTestIdentity,
  createTestLearnerUser,
  createTestSessionCredentials,
} from "./factories.ts";

// The guards, proven at storage.
//
// Almost every case here is **direct SQL**, not a route call, because the point
// is that storage refuses what the route would have prevented: a future writer
// that forgets the rule still cannot break the invariant. The exceptions say so
// where they happen - case 10 drives the route to reach a genuinely refunded
// row, and case 12 calls the settle module so it can hand in a count that no
// route would produce. Each case names the exact SQLite message it expects, so a
// replacement trigger that renames or re-narrows a rule fails here.

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
    { now: clock, expiresAt: clock + 30 * day },
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
  const certificationId = await createTestCertification(database, ownerUserId);
  // Pro on, so a bundle can be bought here as well as a Standard SKU.
  await createProEnablement(database, certificationId, ownerUserId);
  return certificationId;
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

/** A settled purchase, written by the real checkout and settlement paths. */
async function buy(
  actor: Learner,
  certificationId: string,
  sku: string,
): Promise<string> {
  const checkoutId = await openCheckout(actor, certificationId, sku);
  const paid = await call("/api/commerce/dev/fake-pay", {
    actor,
    body: { checkoutId },
  });
  expect(paid.status, sku).toBe(200);
  return checkoutId;
}

/** A checkout that was created and never paid. */
async function openCheckout(
  actor: Learner,
  certificationId: string,
  sku: string,
): Promise<string> {
  const created = await call("/api/commerce/checkouts", {
    actor,
    body: { certificationId, sku, clientCheckoutKey: crypto.randomUUID() },
  });
  expect(created.status, sku).toBe(201);
  return commerceCheckoutResponseSchema.parse(await created.json()).checkoutId;
}

async function checkoutRow(checkoutId: string) {
  return database
    .prepare(
      `SELECT status, paid_at, user_id, certification_id, currency, total_minor
       FROM commerce_checkouts WHERE id = ?`,
    )
    .bind(checkoutId)
    .first<{
      status: string;
      paid_at: number | null;
      user_id: string;
      certification_id: string;
      currency: string;
      total_minor: number;
    }>();
}

async function grantIdFor(
  checkoutId: string,
  feature: "standard" | "pro",
): Promise<string> {
  const row = await database
    .prepare("SELECT id FROM learner_access_grants WHERE operation_id = ?")
    .bind(`${checkoutId}:${feature}`)
    .first<{ id: string }>();
  if (!row) throw new Error(`missing ${feature} grant for ${checkoutId}`);
  return row.id;
}

interface RefundInsert {
  userId: string;
  certificationId: string;
  currency?: string;
  amountMinor?: number;
  requestedBy?: string;
  status?: "requested" | "settled" | "failed";
  requestedAt?: number;
}

/** Insert a refund row directly, for the cases a route would refuse to reach. */
async function insertRefund(input: RefundInsert): Promise<string> {
  const id = `rfd_${crypto.randomUUID()}`;
  const status = input.status ?? "requested";
  await database
    .prepare(
      `INSERT INTO commerce_refunds (
         id, user_id, certification_id, requested_by_user_id, status, currency,
         amount_minor, reason, operation_id, provider, provider_refund_id,
         requested_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Synthetic guard fixture', ?, 'fake',
               ?, ?, ?)`,
    )
    .bind(
      id,
      input.userId,
      input.certificationId,
      input.requestedBy ?? input.userId,
      status,
      input.currency ?? "USD",
      input.amountMinor ?? 5900,
      `refund:${id}`,
      status === "settled" ? `fake_refund_${id}` : null,
      input.requestedAt ?? clock,
      status === "settled" ? clock : null,
    )
    .run();
  return id;
}

async function insertLine(input: {
  refundId: string;
  checkoutId: string;
  amountMinor?: number;
  windowEndsAt?: number;
  position?: number;
}): Promise<void> {
  await database
    .prepare(
      `INSERT INTO commerce_refund_lines (
         refund_id, position, checkout_id, amount_minor, window_ends_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      input.refundId,
      input.position ?? 0,
      input.checkoutId,
      input.amountMinor ?? 5900,
      input.windowEndsAt ?? clock + refundWindowMs,
    )
    .run();
}

async function settleRefundRow(refundId: string): Promise<void> {
  await database
    .prepare(
      `UPDATE commerce_refunds
       SET status = 'settled', settled_at = ?, provider_refund_id = ?
       WHERE id = ? AND status = 'requested'`,
    )
    .bind(clock, `fake_refund_${refundId}`, refundId)
    .run();
}

/** Assert the statement aborts, and that the message names the rule. */
async function abortWith(
  statement: Promise<unknown>,
  message: string,
): Promise<void> {
  await expect(statement).rejects.toThrow(message);
}

describe("refund guards", () => {
  let actor: Learner;
  let certificationId: string;

  beforeEach(async () => {
    actor = await learner();
    certificationId = await exam();
  });

  it("1. refuses to revoke a Standard grant that covers a live Pro grant", async () => {
    // `learner_access_grants_revoke_keeps_pro_covered` (0014) is the storage
    // statement of the Pro-before-Standard order. A refund that revoked in the
    // other order aborts here, which is why the batch orders it Pro first.
    const checkoutId = await buy(actor, certificationId, "bundle-standard-3m-pro");
    const standardGrantId = await grantIdFor(checkoutId, "standard");
    await abortWith(
      database
        .prepare(
          `UPDATE learner_access_grants
           SET revoked_at = ?, revocation_operation_id = ?, revoked_by_user_id = ?
           WHERE id = ? AND revoked_at IS NULL`,
        )
        .bind(clock, `refund:rfd_x:${standardGrantId}`, actor.userId, standardGrantId)
        .run(),
      "revoking this standard grant would leave a pro grant uncovered",
    );
  });

  it("2. refuses `refunded` without a settled refund naming the checkout", async () => {
    const checkoutId = await buy(actor, certificationId, "standard-3m");
    await abortWith(
      database
        .prepare(
          `UPDATE commerce_checkouts SET status = 'refunded', updated_at = ?
           WHERE id = ?`,
        )
        .bind(clock, checkoutId)
        .run(),
      "a refunded checkout requires a settled refund",
    );
    expect((await checkoutRow(checkoutId))!.status).toBe("paid");
  });

  it("3. refuses `refunded` on a checkout that could never have been paid", async () => {
    // The hole this closes: the settle batch's checkout statement filters
    // `status = 'paid'`, so a checkout that is `pending` or `needs_support` when
    // the batch runs matches 0 rows and fires no trigger - revocations and a
    // settled refund would commit with the checkout left exactly as it was.
    // Neither the settle compare-and-swap nor a trigger can see that row. Two
    // rules close it: this trigger for a writer that forces the transition, and
    // the checkout count `applyRefundSettlement` returns for the statement that
    // matched nothing.
    const pendingCheckoutId = await openCheckout(
      actor,
      certificationId,
      "standard-3m",
    );
    await abortWith(
      database
        .prepare(
          `UPDATE commerce_checkouts SET status = 'refunded', updated_at = ?
           WHERE id = ?`,
        )
        .bind(clock, pendingCheckoutId)
        .run(),
      "only a paid checkout can be refunded",
    );
    expect((await checkoutRow(pendingCheckoutId))!.status).toBe("pending");

    // `needs_support` is money we hold that could not be granted; refunding it is
    // #83's open policy, so a direct write must abort here as well.
    const parkedCheckoutId = await openCheckout(
      actor,
      certificationId,
      "standard-6m",
    );
    await database
      .prepare(
        `UPDATE commerce_checkouts SET status = 'needs_support', paid_at = ?,
                updated_at = ? WHERE id = ?`,
      )
      .bind(clock, clock, parkedCheckoutId)
      .run();
    await abortWith(
      database
        .prepare(
          `UPDATE commerce_checkouts SET status = 'refunded', updated_at = ?
           WHERE id = ?`,
        )
        .bind(clock, parkedCheckoutId)
        .run(),
      "only a paid checkout can be refunded",
    );
    expect((await checkoutRow(parkedCheckoutId))!.status).toBe("needs_support");
  });

  it("4. refuses a refund receipt for a requested refund or a mismatched total", async () => {
    const checkoutId = await buy(actor, certificationId, "standard-3m");
    const refundId = await insertRefund({
      userId: actor.userId,
      certificationId,
    });
    await insertLine({ refundId, checkoutId });

    const insertReceipt = (totalMinor: number) =>
      database
        .prepare(
          `INSERT INTO commerce_receipts (
             id, receipt_number, kind, checkout_id, refund_id, user_id,
             certification_id, currency, total_minor, lines_json, grants_json,
             provider, provider_ref, delivery, refund_window_ends_at, issued_at)
           VALUES (?, ?, 'refund', ?, ?, ?, ?, ?, ?, '[]', '[]', 'fake',
                   'fake_refund_x', 'stored', NULL, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          `CP20260201-${crypto.randomUUID().slice(0, 12).toUpperCase()}`,
          checkoutId,
          refundId,
          actor.userId,
          certificationId,
          "USD",
          totalMinor,
          clock,
        )
        .run();

    // (a) the refund is still `requested`
    await abortWith(
      insertReceipt(5900),
      "a refund receipt requires a settled refund for this checkout",
    );

    // (b) the refund is settled but the receipt's total disagrees with its line
    await settleRefundRow(refundId);
    await abortWith(
      insertReceipt(5901),
      "a refund receipt requires a settled refund for this checkout",
    );

    // (c) settled and agreeing: accepted
    await insertReceipt(5900);
  });

  it("5. enforces one self-serve refund per (account, exam) and exempts a staff requester", async () => {
    const capped = await learner();
    const cappedExam = await exam();
    const first = await insertRefund({
      userId: capped.userId,
      certificationId: cappedExam,
    });

    await abortWith(
      insertRefund({ userId: capped.userId, certificationId: cappedExam }),
      "UNIQUE constraint failed",
    );

    // A `failed` row moved no money, so it does not consume the cap: the partial
    // index's predicate excludes it, and a retry is a new refund row.
    await database
      .prepare("UPDATE commerce_refunds SET status = 'failed' WHERE id = ?")
      .bind(first)
      .run();
    await insertRefund({ userId: capped.userId, certificationId: cappedExam });

    // A different requester is a staff refund, outside the learner's cap.
    const checkoutId = await buy(actor, certificationId, "standard-3m");
    await insertRefund({ userId: actor.userId, certificationId });
    const staffUserId = await createTestLearnerUser(database);
    await insertRefund({
      userId: actor.userId,
      certificationId,
      requestedBy: staffUserId,
    });
    expect(checkoutId.length).toBeGreaterThan(0);
  });

  it("6. refuses a refund line for a pending checkout, a wrong amount or a closed window", async () => {
    const checkoutId = await buy(actor, certificationId, "standard-3m");
    const pendingCheckoutId = await (async () => {
      const created = await call("/api/commerce/checkouts", {
        actor,
        body: {
          certificationId,
          sku: "standard-6m",
          clientCheckoutKey: crypto.randomUUID(),
        },
      });
      return commerceCheckoutResponseSchema.parse(await created.json())
        .checkoutId;
    })();

    const forPending = await insertRefund({
      userId: actor.userId,
      certificationId,
    });
    await abortWith(
      insertLine({ refundId: forPending, checkoutId: pendingCheckoutId }),
      "a refund line requires a paid checkout of this refund and an open window",
    );

    const wrongAmount = await insertRefund({
      userId: actor.userId,
      certificationId,
      requestedBy: await createTestLearnerUser(database),
    });
    await abortWith(
      insertLine({ refundId: wrongAmount, checkoutId, amountMinor: 5800 }),
      "a refund line requires a paid checkout of this refund and an open window",
    );

    const paidAt = (await checkoutRow(checkoutId))!.paid_at!;
    const closed = await insertRefund({
      userId: actor.userId,
      certificationId,
      requestedBy: await createTestLearnerUser(database),
      requestedAt: paidAt + refundWindowMs,
    });
    await abortWith(
      insertLine({
        refundId: closed,
        checkoutId,
        windowEndsAt: paidAt + refundWindowMs,
      }),
      "a refund line requires a paid checkout of this refund and an open window",
    );
  });

  it("7. refuses a second line for a checkout already refunded", async () => {
    const checkoutId = await buy(actor, certificationId, "standard-3m");
    const first = await insertRefund({
      userId: actor.userId,
      certificationId,
    });
    await insertLine({ refundId: first, checkoutId });
    await settleRefundRow(first);

    // A staff-requested refund is outside the one-per-exam index, so only this
    // trigger stands between the same checkout and a second payout.
    const second = await insertRefund({
      userId: actor.userId,
      certificationId,
      requestedBy: await createTestLearnerUser(database),
    });
    await abortWith(
      insertLine({ refundId: second, checkoutId }),
      "this checkout has already been refunded",
    );
  });

  it("8. keeps a refund's terminal states terminal", async () => {
    const refundId = await insertRefund({ userId: actor.userId, certificationId });
    await database
      .prepare("UPDATE commerce_refunds SET status = 'failed' WHERE id = ?")
      .bind(refundId)
      .run();
    await abortWith(
      database
        .prepare("UPDATE commerce_refunds SET status = 'settled' WHERE id = ?")
        .bind(refundId)
        .run(),
      "illegal refund status transition",
    );
    await abortWith(
      database
        .prepare("DELETE FROM commerce_refunds WHERE id = ?")
        .bind(refundId)
        .run(),
      "refunds cannot be deleted",
    );
  });

  it("9. keeps the refund ledger append-only", async () => {
    // §11 #18: the set of checkouts a settled refund covered is not editable after
    // the money moved, and the decision record is frozen except for the provider's
    // answer. Direct SQL, because the point is that storage refuses what no route
    // would even try.
    const checkoutId = await buy(actor, certificationId, "standard-3m");
    const refundId = await insertRefund({
      userId: actor.userId,
      certificationId,
    });
    await insertLine({ refundId, checkoutId });

    await abortWith(
      database
        .prepare(
          "UPDATE commerce_refund_lines SET amount_minor = 5900 WHERE refund_id = ?",
        )
        .bind(refundId)
        .run(),
      "refund lines cannot change once recorded",
    );
    await abortWith(
      database
        .prepare("DELETE FROM commerce_refund_lines WHERE refund_id = ?")
        .bind(refundId)
        .run(),
      "refund lines cannot be deleted",
    );
    // The amount is the field a "helpful" retry would most like to edit: the
    // provider was told a number, and the ledger must not be re-priced under it.
    await abortWith(
      database
        .prepare("UPDATE commerce_refunds SET amount_minor = 1 WHERE id = ?")
        .bind(refundId)
        .run(),
      "refunds are immutable except the provider answer",
    );
  });

  it("10. refuses to resurrect a refunded checkout", async () => {
    // The only case here that drives the route: a genuinely refunded row can only
    // be produced by the settlement that the other cases test at storage, and the
    // assertion below is still direct SQL.
    const checkoutId = await buy(actor, certificationId, "standard-3m");
    const response = await call(
      `/api/commerce/checkouts/${checkoutId}/refund`,
      { actor, body: { reason: "guard fixture" } },
    );
    expect(response.status).toBe(200);
    await abortWith(
      database
        .prepare(
          "UPDATE commerce_checkouts SET status = 'paid' WHERE id = ?",
        )
        .bind(checkoutId)
        .run(),
      "illegal checkout status transition",
    );
  });

  it("11. re-asserts 0019's edges after the replacement", async () => {
    // The bug class this catches: a replacement trigger that silently drops an
    // edge 0019 added. `expired -> needs_support` is the one that would turn a
    // parked late payment back into a permanent 5xx with the money taken.
    //
    // These rows are `expired` because they were never paid: `paid_at` is
    // write-once (0019), so a paid checkout cannot be walked back into a
    // pre-payment state, which is itself part of the guarantee.
    const expiredToPark = await openCheckout(
      actor,
      certificationId,
      "standard-3m",
    );
    await database
      .prepare(
        "UPDATE commerce_checkouts SET status = 'expired', updated_at = ? WHERE id = ?",
      )
      .bind(clock, expiredToPark)
      .run();
    await expect(
      database
        .prepare(
          `UPDATE commerce_checkouts SET status = 'needs_support', paid_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(clock, clock, expiredToPark)
        .run(),
    ).resolves.toBeDefined();
    expect((await checkoutRow(expiredToPark))!.status).toBe("needs_support");

    const expiredToPaid = await openCheckout(
      actor,
      certificationId,
      "standard-6m",
    );
    await database
      .prepare(
        "UPDATE commerce_checkouts SET status = 'expired', updated_at = ? WHERE id = ?",
      )
      .bind(clock, expiredToPaid)
      .run();
    await expect(
      database
        .prepare(
          `UPDATE commerce_checkouts SET status = 'paid', paid_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(clock, clock, expiredToPaid)
        .run(),
    ).resolves.toBeDefined();
    expect((await checkoutRow(expiredToPaid))!.status).toBe("paid");

    const paidToPark = await buy(actor, certificationId, "standard-12m");
    await expect(
      database
        .prepare(
          "UPDATE commerce_checkouts SET status = 'needs_support', updated_at = ? WHERE id = ?",
        )
        .bind(clock, paidToPark)
        .run(),
    ).resolves.toBeDefined();
    expect((await checkoutRow(paidToPark))!.status).toBe("needs_support");

    // The two pre-payment edges, so the re-assertion is exhaustive rather than
    // only covering the edges the refund path happens to use: a replacement that
    // dropped `pending -> failed` would strand a `checkout.failed` event, and one
    // that dropped `pending -> expired` would leave `expireStaleCheckouts` unable
    // to record an expiry at all.
    const toFailed = await openCheckout(actor, certificationId, "standard-3m");
    await expect(
      database
        .prepare(
          "UPDATE commerce_checkouts SET status = 'failed', updated_at = ? WHERE id = ?",
        )
        .bind(clock, toFailed)
        .run(),
    ).resolves.toBeDefined();
    expect((await checkoutRow(toFailed))!.status).toBe("failed");

    const toExpired = await openCheckout(actor, certificationId, "standard-6m");
    await expect(
      database
        .prepare(
          "UPDATE commerce_checkouts SET status = 'expired', updated_at = ? WHERE id = ?",
        )
        .bind(clock, toExpired)
        .run(),
    ).resolves.toBeDefined();
    expect((await checkoutRow(toExpired))!.status).toBe("expired");
  });

  it("12. aborts the whole settle batch when the compare-and-swap is stale", async () => {
    const checkoutId = await buy(actor, certificationId, "standard-3m");
    const grantId = await grantIdFor(checkoutId, "standard");
    const checkout = (await checkoutRow(checkoutId))!;
    const refundId = await insertRefund({
      userId: actor.userId,
      certificationId,
    });
    await insertLine({ refundId, checkoutId });

    // One too many: the learner has no other Standard grant, so the true count is
    // zero. Statement 3 matches nothing, statement 4's witness trigger then
    // aborts the batch, and the transaction rolls back entirely.
    await abortWith(
      applyRefundSettlement(database, {
        refundId,
        userId: actor.userId,
        certificationId,
        settledAt: clock,
        providerRefundId: `fake_refund_${refundId}`,
        revocations: [
          {
            grantId,
            feature: "standard",
            checkoutId,
            startsAt: clock,
            expiresAt: clock + 90 * day,
          },
        ],
        remainingStandardCount: 1,
        checkouts: [checkoutId],
        receipts: [
          {
            checkout: {
              id: checkoutId,
              user_id: checkout.user_id,
              certification_id: checkout.certification_id,
              sku: "standard-3m",
              currency: checkout.currency,
              total_minor: checkout.total_minor,
              status: "paid",
              paid_at: checkout.paid_at,
              provider: "fake",
              provider_session_id: `fake_${checkoutId}`,
            },
            totalMinor: checkout.total_minor,
            linesJson: "[]",
            grantsJson: "[]",
          },
        ],
      }),
      "a refunded checkout requires a settled refund",
    );

    // Nothing was written: no revocation, no settle, no checkout change.
    const grant = await database
      .prepare("SELECT revoked_at FROM learner_access_grants WHERE id = ?")
      .bind(grantId)
      .first<{ revoked_at: number | null }>();
    expect(grant?.revoked_at).toBeNull();
    expect((await checkoutRow(checkoutId))!.status).toBe("paid");
    const refund = await database
      .prepare("SELECT status FROM commerce_refunds WHERE id = ?")
      .bind(refundId)
      .first<{ status: string }>();
    expect(refund?.status).toBe("requested");
  });
});
