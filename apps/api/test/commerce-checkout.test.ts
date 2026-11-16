import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  commerceCheckoutResponseSchema,
  commerceOfferSchema,
  commerceOffersResponseSchema,
  commerceSkuSchema,
  type CommerceOffersResponse,
} from "@certpath/contracts";
import { createApi } from "../src/index.ts";
import { addTerm } from "../src/calendar.ts";
import { currency, priceList, proTerm, termFor, type Sku } from "../src/pricing.ts";
import {
  checkoutSessionTtlMs,
  grantOperationId,
  linesForSku,
  maxCheckoutIdLength,
  requestFingerprint,
} from "../src/commerce/checkouts.ts";
import { expireStaleCheckouts } from "../src/commerce/expire.ts";
import type {
  CreateCheckoutInput,
  PaymentProvider,
} from "../src/commerce/provider.ts";
import { createFakeProvider } from "../src/commerce/providers/fake.ts";
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

// The learner-facing commerce routes: offers, checkout creation and the checkout
// read. Settlement, the webhook, refunds and receipts are not part of this
// phase, so nothing here asserts a grant.

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

/** Standard coverage that is live at `clock` and runs to `days` from now. */
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

/**
 * Counts the grant rows a checkout could have written. Settlement's operation
 * ids are `"<checkoutId>:<feature>"` (0019, `grantOperationId`); nothing else in
 * these tests writes a colon-bearing operation id, so any match is a grant that
 * checkout creation had no business writing.
 */
async function checkoutGrantRows(userId: string): Promise<number> {
  const row = await database
    .prepare(
      `SELECT COUNT(*) AS rows FROM learner_access_grants
       WHERE user_id = ? AND operation_id LIKE '%:%'`,
    )
    .bind(userId)
    .first<{ rows: number }>();
  return row?.rows ?? -1;
}

interface RequestOptions {
  method?: string;
  actor?: Learner;
  body?: unknown;
  contentType?: string;
  origin?: string | null;
  csrf?: string | null;
  bindings?: TestBindings;
  headers?: Record<string, string>;
}

function call(path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.actor) headers.Cookie = `certpath_session=${options.actor.cookie}`;
  const requestOrigin =
    options.origin === undefined ? origin : options.origin;
  if (requestOrigin !== null) headers.Origin = requestOrigin;
  if (options.body !== undefined) {
    headers["Content-Type"] = options.contentType ?? "application/json";
  }
  const token =
    options.csrf === undefined ? options.actor?.csrf : options.csrf;
  if (token) headers["X-CSRF-Token"] = token;
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

interface ErrorBody {
  error: {
    code: string;
    requestId?: string;
    reason?: string;
    requiresBundle?: boolean;
  };
}

async function errorBody(response: Response): Promise<ErrorBody> {
  return (await response.json()) as ErrorBody;
}

async function offers(
  actor: Learner,
  certificationId: string,
): Promise<CommerceOffersResponse> {
  const response = await call(
    `/api/commerce/offers?certificationId=${encodeURIComponent(certificationId)}`,
    { actor },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  expect(response.headers.get("X-Request-Id")).toBeTruthy();
  return commerceOffersResponseSchema.parse(await response.json());
}

function offerFor(response: CommerceOffersResponse, sku: string) {
  const offer = response.offers.find((candidate) => candidate.sku === sku);
  if (!offer) throw new Error(`no offer for ${sku}`);
  return offer;
}

async function createCheckoutRequest(
  actor: Learner,
  body: { certificationId: string; sku: string; clientCheckoutKey: string },
  options: Omit<RequestOptions, "actor" | "body"> = {},
): Promise<Response> {
  return call("/api/commerce/checkouts", { ...options, actor, body });
}

/**
 * A learner who can buy `sku`, with the fixtures that make the rule allow it.
 */
async function purchaserOf(sku: Sku): Promise<{
  actor: Learner;
  certificationId: string;
}> {
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
      await liveStandard(actor.userId, certificationId, 40);
      break;
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

describe("offers projection", () => {
  it("lists all seven SKUs in price-list order, priced from the price list", async () => {
    const actor = await learner();
    const certificationId = await exam();
    const response = await offers(actor, certificationId);

    expect(response.currency).toBe(currency);
    expect(response.certificationId).toBe(certificationId);
    expect(response.offers.map((offer) => offer.sku)).toEqual(
      Object.keys(priceList),
    );
    for (const offer of response.offers) {
      const entry = priceList[offer.sku];
      expect(offer.amountMinor).toBe(entry.amountMinor);
      expect(offer.label).toBe(entry.label);
      expect(offer.reason === null).toBe(offer.purchasable);
    }
  });

  it("refuses Pro everywhere on an exam Pro is not sold on", async () => {
    const actor = await learner();
    const certificationId = await exam();
    await liveStandard(actor.userId, certificationId, 200);
    const response = await offers(actor, certificationId);

    expect(response.proOffered).toBe(false);
    expect(response.standardRemainingDays).toBe(200);
    expect(offerFor(response, "pro-3m")).toMatchObject({
      purchasable: false,
      reason: "pro_not_offered",
    });
    expect(offerFor(response, "bundle-standard-3m-pro")).toMatchObject({
      purchasable: false,
      reason: "pro_not_offered",
    });
    // The top-up exists to enable a Pro purchase, and Pro is not sold here.
    expect(offerFor(response, "standard-topup-3m")).toMatchObject({
      purchasable: false,
      reason: "topup_not_applicable",
    });
  });

  it("offers Pro and the bundle when one Standard grant covers a full Pro term", async () => {
    const actor = await learner();
    const certificationId = await exam({ proEnabled: true });
    await grantTestFeatureAccess(
      database,
      actor.userId,
      certificationId,
      "standard",
      { startsAt: clock, expiresAt: addTerm(clock, proTerm) },
    );
    const response = await offers(actor, certificationId);

    expect(response.proOffered).toBe(true);
    expect(offerFor(response, "pro-3m")).toMatchObject({
      purchasable: true,
      reason: null,
    });
    expect(offerFor(response, "bundle-standard-3m-pro")).toMatchObject({
      purchasable: true,
      reason: null,
    });
    // Coverage already spans a full Pro term, so a top-up adds nothing.
    expect(offerFor(response, "standard-topup-3m")).toMatchObject({
      purchasable: false,
      reason: "topup_not_applicable",
    });
    expect(offerFor(response, "standard-extension-30d")).toMatchObject({
      purchasable: true,
      reason: null,
    });
  });

  it("refuses the Pro add-on but offers the bundle and the top-up when coverage is short", async () => {
    const actor = await learner();
    const certificationId = await exam({ proEnabled: true });
    await liveStandard(actor.userId, certificationId, 40);
    const response = await offers(actor, certificationId);

    expect(offerFor(response, "pro-3m")).toMatchObject({
      purchasable: false,
      reason: "standard_too_short",
    });
    expect(offerFor(response, "bundle-standard-3m-pro")).toMatchObject({
      purchasable: true,
      reason: null,
    });
    expect(offerFor(response, "standard-topup-3m")).toMatchObject({
      purchasable: true,
      reason: null,
    });
  });

  it("refuses Pro while a Pro window is live", async () => {
    const actor = await learner();
    const certificationId = await exam({ proEnabled: true });
    await liveStandard(actor.userId, certificationId, 200);
    await grantTestFeatureAccess(database, actor.userId, certificationId, "pro", {
      startsAt: clock,
      expiresAt: addTerm(clock, proTerm),
    });
    const response = await offers(actor, certificationId);

    expect(offerFor(response, "pro-3m")).toMatchObject({
      purchasable: false,
      reason: "pro_window_active",
    });
    expect(offerFor(response, "bundle-standard-3m-pro")).toMatchObject({
      purchasable: false,
      reason: "pro_window_active",
    });
  });

  it("reports zero remaining days with no coverage and refuses the extension", async () => {
    const actor = await learner();
    const certificationId = await exam({ proEnabled: true });
    const response = await offers(actor, certificationId);

    expect(response.standardRemainingDays).toBe(0);
    expect(offerFor(response, "standard-extension-30d")).toMatchObject({
      purchasable: false,
      reason: "extension_not_applicable",
    });
    expect(offerFor(response, "standard-3m")).toMatchObject({
      purchasable: true,
      reason: null,
    });
  });

  it("answers 404 for an unknown certification and 401 without a session", async () => {
    const actor = await learner();
    const unknown = await call(
      `/api/commerce/offers?certificationId=${crypto.randomUUID()}`,
      { actor },
    );
    expect(unknown.status).toBe(404);
    expect((await errorBody(unknown)).error.code).toBe("certification_not_found");

    const anonymous = await call(
      `/api/commerce/offers?certificationId=${crypto.randomUUID()}`,
      { origin: null },
    );
    expect(anonymous.status).toBe(401);
    expect((await errorBody(anonymous)).error.code).toBe("unauthenticated");
    expect(anonymous.headers.get("X-Request-Id")).toBeTruthy();
  });

  it("rejects a malformed query", async () => {
    const actor = await learner();
    for (const query of [
      "",
      "?certificationId=",
      "?certificationId=a&certificationId=b",
      "?certificationId=%20%20",
      "?other=1",
    ]) {
      const response = await call(`/api/commerce/offers${query}`, { actor });
      expect(response.status).toBe(400);
      expect((await errorBody(response)).error.code).toBe("validation_error");
    }
  });
});

describe("checkout creation", () => {
  const skus = Object.keys(priceList) as Sku[];

  it("creates one priced checkout for each of the seven SKUs", async () => {
    for (const sku of skus) {
      const { actor, certificationId } = await purchaserOf(sku);
      const response = await createCheckoutRequest(actor, {
        certificationId,
        sku,
        clientCheckoutKey: `buy-${sku}-${crypto.randomUUID()}`,
      });
      expect(response.status, sku).toBe(201);
      const body = commerceCheckoutResponseSchema.parse(await response.json());

      expect(body.status).toBe("pending");
      expect(body.sku).toBe(sku);
      expect(body.currency).toBe(currency);
      expect(body.totalMinor).toBe(priceList[sku].amountMinor);
      expect(body.totalMinor).toBe(
        body.lines.reduce((sum, line) => sum + line.amountMinor, 0),
      );
      expect(body.redirectUrl).toContain("/commerce/fake-pay");
      expect(body.paidAt).toBeNull();
      expect(body.refundWindowEndsAt).toBeNull();
      expect(body.expiresAt).toBe(clock + checkoutSessionTtlMs);

      const expected = linesForSku(sku);
      expect(body.lines).toHaveLength(expected.length);
      body.lines.forEach((line, index) => {
        const snapshot = expected[index]!;
        expect(line.sku).toBe(snapshot.sku);
        expect(line.amountMinor).toBe(snapshot.amountMinor);
        expect(line.feature).toBe(snapshot.feature);
        expect(line.term).toEqual(snapshot.term);
        expect(line.priceSource).toBe(snapshot.priceSource);
      });

      const stored = await database
        .prepare(
          `SELECT COUNT(*) AS rows FROM commerce_checkouts
           WHERE user_id = ? AND certification_id = ?`,
        )
        .bind(actor.userId, certificationId)
        .first<{ rows: number }>();
      expect(stored?.rows, sku).toBe(1);

      // A checkout grants nothing. Settlement writes grants from the price
      // snapshot, and its operation ids are `<checkoutId>:<feature>`; the
      // fixtures above carry no `operation_id` and this route writes none, so
      // any row matching that shape here is a settlement leak into creation.
      expect(await checkoutGrantRows(actor.userId), sku).toBe(0);
    }
  });

  it("stores the purchased SKU on the checkout and returns it", async () => {
    // The bundle's lines are `standard-3m` and `pro-3m` - the same feature pair a
    // Pro purchase made on top of Standard coverage describes - so the line set
    // cannot say which product was sold; only the row can. Settlement branches on
    // this field, so it has to survive the round trip through storage, the replay
    // and the read.
    const { actor, certificationId } = await purchaserOf(
      "bundle-standard-3m-pro",
    );
    const body = {
      certificationId,
      sku: "bundle-standard-3m-pro",
      clientCheckoutKey: `sku-${crypto.randomUUID()}`,
    };
    const created = await createCheckoutRequest(actor, body);
    expect(created.status).toBe(201);
    const checkout = commerceCheckoutResponseSchema.parse(await created.json());
    expect(checkout.sku).toBe("bundle-standard-3m-pro");
    expect(checkout.lines.map((line) => line.sku)).toEqual([
      "standard-3m",
      "pro-3m",
    ]);

    const stored = await database
      .prepare("SELECT sku FROM commerce_checkouts WHERE id = ?")
      .bind(checkout.checkoutId)
      .first<{ sku: string }>();
    expect(stored?.sku).toBe("bundle-standard-3m-pro");

    const replayed = commerceCheckoutResponseSchema.parse(
      await (await createCheckoutRequest(actor, body)).json(),
    );
    expect(replayed.sku).toBe("bundle-standard-3m-pro");

    const read = await call(
      `/api/commerce/checkouts/${encodeURIComponent(checkout.checkoutId)}`,
      { actor },
    );
    expect(read.status).toBe(200);
    expect(commerceCheckoutResponseSchema.parse(await read.json()).sku).toBe(
      "bundle-standard-3m-pro",
    );
  });

  it("splits the bundle into a Standard line and a residual Pro line", async () => {
    const { actor, certificationId } = await purchaserOf(
      "bundle-standard-3m-pro",
    );
    const response = await createCheckoutRequest(actor, {
      certificationId,
      sku: "bundle-standard-3m-pro",
      clientCheckoutKey: crypto.randomUUID(),
    });
    expect(response.status).toBe(201);
    const body = commerceCheckoutResponseSchema.parse(await response.json());

    expect(body.lines[0]).toMatchObject({
      sku: "standard-3m",
      feature: "standard",
      amountMinor: priceList["standard-3m"].amountMinor,
      priceSource: "price-list",
    });
    expect(body.lines[1]).toMatchObject({
      sku: "pro-3m",
      feature: "pro",
      amountMinor:
        priceList["bundle-standard-3m-pro"].amountMinor -
        priceList["standard-3m"].amountMinor,
      priceSource: "bundle-residual",
    });
    expect(body.totalMinor).toBe(priceList["bundle-standard-3m-pro"].amountMinor);
  });

  it("replays a request byte-identically and writes one row", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const body = {
      certificationId,
      sku: "standard-3m",
      clientCheckoutKey: `replay-${crypto.randomUUID()}`,
    };
    const first = await createCheckoutRequest(actor, body);
    expect(first.status).toBe(201);
    const firstText = await first.text();

    const second = await createCheckoutRequest(actor, body);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(firstText);

    const third = await createCheckoutRequest(actor, body);
    expect(third.status).toBe(200);
    expect(await third.text()).toBe(firstText);

    const stored = await database
      .prepare(
        `SELECT COUNT(*) AS rows FROM commerce_checkouts WHERE user_id = ?`,
      )
      .bind(actor.userId)
      .first<{ rows: number }>();
    expect(stored?.rows).toBe(1);
    const lines = await database
      .prepare(
        `SELECT COUNT(*) AS rows FROM commerce_checkout_lines
         WHERE checkout_id = ?`,
      )
      .bind(commerceCheckoutResponseSchema.parse(JSON.parse(firstText)).checkoutId)
      .first<{ rows: number }>();
    expect(lines?.rows).toBe(1);
  });

  it("answers 409 idempotency_conflict for the same key and a different SKU", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const key = `conflict-${crypto.randomUUID()}`;
    const first = await createCheckoutRequest(actor, {
      certificationId,
      sku: "standard-3m",
      clientCheckoutKey: key,
    });
    expect(first.status).toBe(201);

    const second = await createCheckoutRequest(actor, {
      certificationId,
      sku: "standard-6m",
      clientCheckoutKey: key,
    });
    expect(second.status).toBe(409);
    expect((await errorBody(second)).error.code).toBe("idempotency_conflict");

    const stored = await database
      .prepare(
        `SELECT COUNT(*) AS rows FROM commerce_checkouts WHERE user_id = ?`,
      )
      .bind(actor.userId)
      .first<{ rows: number }>();
    expect(stored?.rows).toBe(1);
  });

  it("refuses a Pro add-on with the rule it hit and the bundle pointer", async () => {
    const actor = await learner();
    const certificationId = await exam({ proEnabled: true });
    await liveStandard(actor.userId, certificationId, 40);
    const response = await createCheckoutRequest(actor, {
      certificationId,
      sku: "pro-3m",
      clientCheckoutKey: crypto.randomUUID(),
    });
    expect(response.status).toBe(409);
    expect(await errorBody(response)).toMatchObject({
      error: {
        code: "purchase_not_allowed",
        reason: "standard_too_short",
        requiresBundle: true,
      },
    });
    const stored = await database
      .prepare(
        `SELECT COUNT(*) AS rows FROM commerce_checkouts WHERE user_id = ?`,
      )
      .bind(actor.userId)
      .first<{ rows: number }>();
    expect(stored?.rows).toBe(0);
  });

  it("refuses Pro on an exam Pro is not sold on", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    await liveStandard(actor.userId, certificationId, 200);
    const response = await createCheckoutRequest(actor, {
      certificationId,
      sku: "pro-3m",
      clientCheckoutKey: crypto.randomUUID(),
    });
    expect(response.status).toBe(409);
    expect(await errorBody(response)).toMatchObject({
      error: {
        code: "purchase_not_allowed",
        reason: "pro_not_offered",
        requiresBundle: false,
      },
    });
  });

  it("refuses a second Pro while one is live", async () => {
    const actor = await learner();
    const certificationId = await exam({ proEnabled: true });
    await liveStandard(actor.userId, certificationId, 200);
    await grantTestFeatureAccess(database, actor.userId, certificationId, "pro", {
      startsAt: clock,
      expiresAt: addTerm(clock, proTerm),
    });
    const response = await createCheckoutRequest(actor, {
      certificationId,
      sku: "pro-3m",
      clientCheckoutKey: crypto.randomUUID(),
    });
    expect(response.status).toBe(409);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "purchase_not_allowed", reason: "pro_window_active" },
    });
  });

  it("does not point at the bundle when the bundle is refused too (G2)", async () => {
    // Short Standard and an overlapping Pro window is a real state: a learner who
    // bought the bundle 60 days ago has 30 days of each left, and Pro is short
    // because the Standard leg does not reach a full Pro term. `standard_too_short`
    // used to win, answering `requiresBundle: true` - a pointer at an offer
    // `bundleDecision` refuses for `pro_window_active`. A refusal's way through
    // has to be a way through.
    const actor = await learner();
    const certificationId = await exam({ proEnabled: true });
    const window = { startsAt: clock - 60 * day, expiresAt: clock + 30 * day };
    await grantTestFeatureAccess(
      database,
      actor.userId,
      certificationId,
      "standard",
      window,
    );
    await grantTestFeatureAccess(
      database,
      actor.userId,
      certificationId,
      "pro",
      window,
    );

    const response = await offers(actor, certificationId);
    expect(offerFor(response, "pro-3m")).toMatchObject({
      purchasable: false,
      reason: "pro_window_active",
    });
    // The offer the refusal used to point at is refused in the same projection.
    expect(offerFor(response, "bundle-standard-3m-pro")).toMatchObject({
      purchasable: false,
      reason: "pro_window_active",
    });
    // A top-up is still a way through, and it is the one the learner needs.
    expect(offerFor(response, "standard-topup-3m")).toMatchObject({
      purchasable: true,
      reason: null,
    });

    const refused = await createCheckoutRequest(actor, {
      certificationId,
      sku: "pro-3m",
      clientCheckoutKey: crypto.randomUUID(),
    });
    expect(refused.status).toBe(409);
    expect(await errorBody(refused)).toMatchObject({
      error: {
        code: "purchase_not_allowed",
        reason: "pro_window_active",
        requiresBundle: false,
      },
    });
    expect(
      await database
        .prepare(
          "SELECT COUNT(*) AS rows FROM commerce_checkouts WHERE user_id = ?",
        )
        .bind(actor.userId)
        .first<{ rows: number }>(),
    ).toEqual({ rows: 0 });
  });

  it("refuses a top-up and an extension that do not apply", async () => {
    const actor = await learner();
    const certificationId = await exam({ proEnabled: true });
    for (const [sku, reason] of [
      ["standard-topup-3m", "topup_not_applicable"],
      ["standard-extension-30d", "extension_not_applicable"],
    ] as const) {
      const response = await createCheckoutRequest(actor, {
        certificationId,
        sku,
        clientCheckoutKey: crypto.randomUUID(),
      });
      expect(response.status, sku).toBe(409);
      expect(await errorBody(response)).toMatchObject({
        error: { code: "purchase_not_allowed", reason },
      });
    }
  });

  it("answers 400 unknown_sku for a SKU that is not in the price list", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const response = await createCheckoutRequest(actor, {
      certificationId,
      sku: "standard-1m",
      clientCheckoutKey: crypto.randomUUID(),
    });
    expect(response.status).toBe(400);
    expect((await errorBody(response)).error.code).toBe("unknown_sku");
  });

  it("answers 404 certification_not_found for an unknown exam", async () => {
    const actor = await learner();
    const response = await createCheckoutRequest(actor, {
      certificationId: crypto.randomUUID(),
      sku: "standard-3m",
      clientCheckoutKey: crypto.randomUUID(),
    });
    expect(response.status).toBe(404);
    expect((await errorBody(response)).error.code).toBe("certification_not_found");
  });

  it("validates the body, the media type and the size", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const missingField = await call("/api/commerce/checkouts", {
      actor,
      body: { certificationId, sku: "standard-3m" },
    });
    expect(missingField.status).toBe(400);
    expect((await errorBody(missingField)).error.code).toBe("validation_error");

    const shortKey = await createCheckoutRequest(actor, {
      certificationId,
      sku: "standard-3m",
      clientCheckoutKey: "short",
    });
    expect(shortKey.status).toBe(400);

    const extraField = await call("/api/commerce/checkouts", {
      actor,
      body: {
        certificationId,
        sku: "standard-3m",
        clientCheckoutKey: crypto.randomUUID(),
        amountMinor: 1,
      },
    });
    expect(extraField.status).toBe(400);

    const wrongType = await createCheckoutRequest(
      actor,
      {
        certificationId,
        sku: "standard-3m",
        clientCheckoutKey: crypto.randomUUID(),
      },
      { contentType: "text/plain" },
    );
    expect(wrongType.status).toBe(415);

    const oversized = await call("/api/commerce/checkouts", {
      actor,
      body: {
        certificationId,
        sku: "standard-3m",
        clientCheckoutKey: crypto.randomUUID(),
        padding: "x".repeat(9 * 1024),
      },
    });
    expect(oversized.status).toBe(413);
    expect((await errorBody(oversized)).error.code).toBe("payload_too_large");
  });

  it("requires a session, the site origin and a CSRF token", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const body = {
      certificationId,
      sku: "standard-3m",
      clientCheckoutKey: crypto.randomUUID(),
    };

    const anonymous = await call("/api/commerce/checkouts", {
      body,
      origin: null,
    });
    expect(anonymous.status).toBe(401);

    const wrongOrigin = await createCheckoutRequest(actor, body, {
      origin: "https://evil.example",
    });
    expect(wrongOrigin.status).toBe(400);
    expect((await errorBody(wrongOrigin)).error.code).toBe("invalid_origin");

    const noCsrf = await createCheckoutRequest(actor, body, { csrf: null });
    expect(noCsrf.status).toBe(400);
    expect((await errorBody(noCsrf)).error.code).toBe("invalid_csrf");

    const wrongCsrf = await createCheckoutRequest(actor, body, {
      csrf: "v1.not-a-real-token",
    });
    expect(wrongCsrf.status).toBe(400);
    expect((await errorBody(wrongCsrf)).error.code).toBe("invalid_csrf");

    const stored = await database
      .prepare(
        `SELECT COUNT(*) AS rows FROM commerce_checkouts WHERE user_id = ?`,
      )
      .bind(actor.userId)
      .first<{ rows: number }>();
    expect(stored?.rows).toBe(0);
  });
});

describe("checkout read", () => {
  it("returns the owner's checkout and hides another learner's", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const created = await createCheckoutRequest(actor, {
      certificationId,
      sku: "standard-3m",
      clientCheckoutKey: crypto.randomUUID(),
    });
    const checkout = commerceCheckoutResponseSchema.parse(
      await created.json(),
    );

    const own = await call(`/api/commerce/checkouts/${checkout.checkoutId}`, {
      actor,
    });
    expect(own.status).toBe(200);
    expect(commerceCheckoutResponseSchema.parse(await own.json())).toEqual(
      checkout,
    );
    expect(own.headers.get("Cache-Control")).toContain("no-store");

    const other = await learner();
    const foreign = await call(`/api/commerce/checkouts/${checkout.checkoutId}`, {
      actor: other,
    });
    expect(foreign.status).toBe(404);
    expect((await errorBody(foreign)).error.code).toBe("checkout_not_found");

    const missing = await call(
      `/api/commerce/checkouts/${crypto.randomUUID()}`,
      { actor },
    );
    expect(missing.status).toBe(404);
    // Indistinguishable from a checkout that belongs to someone else.
    expect((await errorBody(missing)).error.code).toBe("checkout_not_found");

    const anonymous = await call(
      `/api/commerce/checkouts/${checkout.checkoutId}`,
      { origin: null },
    );
    expect(anonymous.status).toBe(401);
  });
});

describe("commerce disabled", () => {
  it("answers 503 and writes nothing when COMMERCE_ENABLED is not true", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const before = await database
      .prepare("SELECT COUNT(*) AS rows FROM commerce_checkouts")
      .first<{ rows: number }>();

    for (const enabled of [undefined, "false", "TRUE", "1", "yes"]) {
      const offBindings = {
        ...bindings,
        COMMERCE_ENABLED: enabled,
      } as unknown as TestBindings;
      const response = await createCheckoutRequest(
        actor,
        {
          certificationId,
          sku: "standard-3m",
          clientCheckoutKey: crypto.randomUUID(),
        },
        { bindings: offBindings },
      );
      expect(response.status, String(enabled)).toBe(503);
      expect((await errorBody(response)).error.code).toBe("commerce_disabled");
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }

    const offersWhenOff = await call(
      `/api/commerce/offers?certificationId=${certificationId}`,
      { actor, bindings: { ...bindings, COMMERCE_ENABLED: "false" } },
    );
    expect(offersWhenOff.status).toBe(503);

    const after = await database
      .prepare("SELECT COUNT(*) AS rows FROM commerce_checkouts")
      .first<{ rows: number }>();
    expect(after?.rows).toBe(before?.rows);
  });

  it("answers 503 commerce_disabled when no provider resolves", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    // A binding-resolved route, not an injected adapter, so the typo and the
    // "none" value are exercised exactly as a deployment would hit them.
    const bindingApplication = createApi(fetch, () => clock);
    for (const provider of ["none", "stripe", "FAKE", ""]) {
      const response = await bindingApplication.fetch(
        new Request(`${origin}/api/commerce/offers?certificationId=${certificationId}`, {
          headers: {
            Cookie: `certpath_session=${actor.cookie}`,
            Origin: origin,
          },
        }),
        { ...bindings, PAYMENT_PROVIDER: provider },
      );
      expect(response.status, provider).toBe(503);
      expect(((await response.json()) as ErrorBody).error.code).toBe(
        "commerce_disabled",
      );
    }
  });
});

describe("provider outage", () => {
  /** A provider whose first `createCheckout` throws, then behaves. */
  function flakyProvider(): PaymentProvider & { calls: number } {
    let calls = 0;
    return {
      name: "fake",
      live: false,
      get calls() {
        return calls;
      },
      async createCheckout(
        input: CreateCheckoutInput,
      ): Promise<{ sessionRef: string; redirectUrl: string; expiresAt: number }> {
        calls += 1;
        if (calls === 1) throw new Error("provider is down");
        return fakeProvider.createCheckout(input);
      },
      verifyEvent: fakeProvider.verifyEvent.bind(fakeProvider),
      refund: fakeProvider.refund.bind(fakeProvider),
    };
  }

  it("leaves the row pending and answers 503, then succeeds on retry", async () => {
    const provider = flakyProvider();
    const flakyApplication = createApi(
      fetch,
      () => clock,
      undefined,
      undefined,
      provider,
    );
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const key = `outage-${crypto.randomUUID()}`;
    const body = { certificationId, sku: "standard-3m", clientCheckoutKey: key };
    const headers = {
      Cookie: `certpath_session=${actor.cookie}`,
      Origin: origin,
      "X-CSRF-Token": actor.csrf,
      "Content-Type": "application/json",
    };

    const first = await flakyApplication.fetch(
      new Request(`${origin}/api/commerce/checkouts`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      bindings,
    );
    expect(first.status).toBe(503);
    expect(((await first.json()) as ErrorBody).error.code).toBe(
      "provider_unavailable",
    );

    const stranded = await database
      .prepare(
        `SELECT status, provider_session_id, provider_redirect_url
         FROM commerce_checkouts WHERE user_id = ? AND client_checkout_key = ?`,
      )
      .bind(actor.userId, key)
      .first<{
        status: string;
        provider_session_id: string | null;
        provider_redirect_url: string | null;
      }>();
    expect(stranded).toMatchObject({
      status: "pending",
      provider_session_id: null,
      provider_redirect_url: null,
    });

    const retry = await flakyApplication.fetch(
      new Request(`${origin}/api/commerce/checkouts`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      bindings,
    );
    expect(retry.status).toBe(200);
    const retried = commerceCheckoutResponseSchema.parse(await retry.json());
    expect(retried.status).toBe("pending");
    expect(retried.redirectUrl).toContain("/commerce/fake-pay");
    expect(provider.calls).toBe(2);

    const bound = await database
      .prepare(
        `SELECT provider_session_id FROM commerce_checkouts
         WHERE user_id = ? AND client_checkout_key = ?`,
      )
      .bind(actor.userId, key)
      .first<{ provider_session_id: string | null }>();
    expect(bound?.provider_session_id).toBe(`fake_${retried.checkoutId}`);

    const rows = await database
      .prepare(
        `SELECT COUNT(*) AS rows FROM commerce_checkouts WHERE user_id = ?`,
      )
      .bind(actor.userId)
      .first<{ rows: number }>();
    expect(rows?.rows).toBe(1);

    // A provider outage and the retry that follows it move no entitlement: the
    // first attempt wrote a priced row before the throw, the second re-bound a
    // session, and neither wrote a grant.
    expect(await checkoutGrantRows(actor.userId)).toBe(0);
  });
});

describe("checkout ids and grant operation ids", () => {
  it("mints ids short enough for the grant operation id bound", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const response = await createCheckoutRequest(actor, {
      certificationId,
      sku: "standard-3m",
      clientCheckoutKey: crypto.randomUUID(),
    });
    const body = commerceCheckoutResponseSchema.parse(await response.json());
    expect(maxCheckoutIdLength).toBe(118);
    expect(body.checkoutId.length).toBeLessThanOrEqual(maxCheckoutIdLength);
    // 0019 writes these ids; the contracts cap an operation id at 128.
    expect(grantOperationId(body.checkoutId, "standard").length).toBeLessThanOrEqual(
      128,
    );
    expect(grantOperationId(body.checkoutId, "pro").length).toBeLessThanOrEqual(
      128,
    );
    expect(grantOperationId(body.checkoutId, "standard")).toBe(
      `${body.checkoutId}:standard`,
    );
  });

  it("derives the fingerprint from certification and SKU only", async () => {
    const first = await requestFingerprint("cissp", "standard-3m");
    const second = await requestFingerprint("cissp", "standard-3m");
    const other = await requestFingerprint("cissp", "standard-6m");
    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    // The separator stops ("a", "bc") colliding with ("ab", "c").
    expect(await requestFingerprint("a", "bc")).not.toBe(
      await requestFingerprint("ab", "c"),
    );
  });
});

describe("checkout expiry", () => {
  it("expires only stale pending checkouts, idempotently", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const response = await createCheckoutRequest(actor, {
      certificationId,
      sku: "standard-3m",
      clientCheckoutKey: crypto.randomUUID(),
    });
    const checkout = commerceCheckoutResponseSchema.parse(
      await response.json(),
    );

    const early = await expireStaleCheckouts(database, clock);
    expect(early.ok).toBe(true);

    const atDeadline = await expireStaleCheckouts(database, checkout.expiresAt);
    expect(atDeadline.ok).toBe(true);
    if (!atDeadline.ok) throw new Error("expiry refused valid input");
    expect(atDeadline.value.expired).toBeGreaterThanOrEqual(1);

    const first = await database
      .prepare("SELECT status FROM commerce_checkouts WHERE id = ?")
      .bind(checkout.checkoutId)
      .first<{ status: string }>();
    expect(first?.status).toBe("expired");

    // A second run at the same instant has nothing left to do: the status is
    // already expired, so the `pending` predicate matches no row.
    const repeated = await expireStaleCheckouts(database, checkout.expiresAt);
    expect(repeated).toEqual({ ok: true, value: { expired: 0 } });
    const again = await database
      .prepare("SELECT status FROM commerce_checkouts WHERE id = ?")
      .bind(checkout.checkoutId)
      .first<{ status: string }>();
    expect(again?.status).toBe("expired");

    // The read model reports the expired status and withdraws the redirect once
    // the session is past its own deadline.
    const read = await call(
      `/api/commerce/checkouts/${checkout.checkoutId}`,
      { actor },
    );
    const after = commerceCheckoutResponseSchema.parse(await read.json());
    expect(after.status).toBe("expired");
  });

  it("refuses invalid input", async () => {
    expect(await expireStaleCheckouts(database, Number.NaN)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(await expireStaleCheckouts(database, clock, 0)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(await expireStaleCheckouts(database, clock, 10_000)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
  });
});

describe("storage invariants", () => {
  async function checkoutRow(): Promise<{ actor: Learner; checkoutId: string }> {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const response = await createCheckoutRequest(actor, {
      certificationId,
      sku: "standard-3m",
      clientCheckoutKey: crypto.randomUUID(),
    });
    expect(response.status).toBe(201);
    const body = commerceCheckoutResponseSchema.parse(await response.json());
    return { actor, checkoutId: body.checkoutId };
  }

  it("refuses edits to the identifying and amount columns", async () => {
    const { checkoutId } = await checkoutRow();
    for (const [column, value] of [
      ["total_minor", 1],
      ["currency", "EUR"],
      ["sku", "standard-6m"],
      ["client_checkout_key", "different-key"],
      ["request_fingerprint", "0".repeat(64)],
      ["provider", "other"],
    ] as const) {
      await expect(
        database
          .prepare(
            `UPDATE commerce_checkouts SET ${column} = ? WHERE id = ?`,
          )
          .bind(value, checkoutId)
          .run(),
        column,
      ).rejects.toThrow(/immutable/);
    }
  });

  it("allows only the documented status edges", async () => {
    const { checkoutId } = await checkoutRow();
    // pending -> paid -> needs_support is the settlement path.
    await database
      .prepare(
        "UPDATE commerce_checkouts SET status = 'paid', paid_at = ? WHERE id = ?",
      )
      .bind(clock, checkoutId)
      .run();
    await database
      .prepare("UPDATE commerce_checkouts SET status = 'needs_support' WHERE id = ?")
      .bind(checkoutId)
      .run();

    for (const status of ["pending", "refunded", "expired", "failed"]) {
      await expect(
        database
          .prepare("UPDATE commerce_checkouts SET status = ? WHERE id = ?")
          .bind(status, checkoutId)
          .run(),
        status,
      ).rejects.toThrow(/illegal checkout status/);
    }
  });

  it("accepts expired -> paid, because money is money", async () => {
    const { checkoutId } = await checkoutRow();
    await database
      .prepare("UPDATE commerce_checkouts SET status = 'expired' WHERE id = ?")
      .bind(checkoutId)
      .run();
    await expect(
      database
        .prepare(
          "UPDATE commerce_checkouts SET status = 'paid', paid_at = ? WHERE id = ?",
        )
        .bind(clock, checkoutId)
        .run(),
    ).resolves.toBeDefined();
  });

  it("refuses a failed checkout that later reports money", async () => {
    const { checkoutId } = await checkoutRow();
    await database
      .prepare("UPDATE commerce_checkouts SET status = 'failed' WHERE id = ?")
      .bind(checkoutId)
      .run();
    await expect(
      database
        .prepare(
          "UPDATE commerce_checkouts SET status = 'paid', paid_at = ? WHERE id = ?",
        )
        .bind(clock, checkoutId)
        .run(),
    ).rejects.toThrow(/illegal checkout status/);
  });

  it("refuses a status that claims money without a paid_at, and vice versa", async () => {
    const { checkoutId } = await checkoutRow();
    await expect(
      database
        .prepare("UPDATE commerce_checkouts SET status = 'paid' WHERE id = ?")
        .bind(checkoutId)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      database
        .prepare(
          "UPDATE commerce_checkouts SET status = 'failed', paid_at = ? WHERE id = ?",
        )
        .bind(clock, checkoutId)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("refuses lines that exceed the checkout total", async () => {
    const { checkoutId } = await checkoutRow();
    await expect(
      database
        .prepare(
          `INSERT INTO commerce_checkout_lines (
             checkout_id, position, sku, label, amount_minor, grants_feature,
             grants_unit, grants_months, grants_days, price_source
           ) VALUES (?, 1, 'pro-3m', 'Pro, 3 months', ?, 'pro',
                     'calendar_months', 3, NULL, 'price-list')`,
        )
        .bind(checkoutId, priceList["pro-3m"].amountMinor)
        .run(),
    ).rejects.toThrow(/exceed the checkout total/);
  });

  it("keeps lines and checkouts undeletable and unsnapshottable", async () => {
    const { checkoutId } = await checkoutRow();
    await expect(
      database
        .prepare(
          "UPDATE commerce_checkout_lines SET amount_minor = 1 WHERE checkout_id = ?",
        )
        .bind(checkoutId)
        .run(),
    ).rejects.toThrow(/price snapshot/);
    await expect(
      database
        .prepare("DELETE FROM commerce_checkout_lines WHERE checkout_id = ?")
        .bind(checkoutId)
        .run(),
    ).rejects.toThrow(/cannot be deleted/);
    await expect(
      database
        .prepare("DELETE FROM commerce_checkouts WHERE id = ?")
        .bind(checkoutId)
        .run(),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it("refuses a line whose term does not match its unit", async () => {
    // A checkout with room in its total, inserted directly: the API's own
    // checkouts sum exactly to their total, so a malformed *line* would
    // otherwise be refused by the within-total guard first and this CHECK would
    // never be reached.
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const checkoutId = `chk_${crypto.randomUUID()}`;
    await database
      .prepare(
        `INSERT INTO commerce_checkouts (
           id, user_id, certification_id, sku, client_checkout_key,
           request_fingerprint, currency, total_minor, status, provider,
           provider_session_id, provider_redirect_url, created_at, updated_at,
           expires_at, paid_at
         ) VALUES (?, ?, ?, 'standard-3m', 'term-shape-fixture', ?, ?, 100000,
                   'pending', 'fake', NULL, NULL, ?, ?, ?, NULL)`,
      )
      .bind(
        checkoutId,
        actor.userId,
        certificationId,
        "f".repeat(64),
        currency,
        clock,
        clock,
        clock + checkoutSessionTtlMs,
      )
      .run();
    await expect(
      database
        .prepare(
          `INSERT INTO commerce_checkout_lines (
             checkout_id, position, sku, label, amount_minor, grants_feature,
             grants_unit, grants_months, grants_days, price_source
           ) VALUES (?, 0, 'standard-3m', 'Standard, 3 months', 1, 'standard',
                     'calendar_months', 3, 30, 'price-list')`,
        )
        .bind(checkoutId)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("keeps provider events append-only", async () => {
    await database
      .prepare(
        `INSERT INTO commerce_provider_events (
           provider_event_id, provider, kind, checkout_id, amount_minor,
           currency, occurred_at, received_at, outcome
         ) VALUES (?, 'fake', 'checkout.completed', NULL, NULL, NULL, ?, ?, 'ignored-unknown-checkout')`,
      )
      .bind(`evt_${crypto.randomUUID()}`, clock, clock)
      .run();
    const event = await database
      .prepare(
        "SELECT provider_event_id FROM commerce_provider_events ORDER BY received_at DESC LIMIT 1",
      )
      .first<{ provider_event_id: string }>();
    await expect(
      database
        .prepare(
          "UPDATE commerce_provider_events SET outcome = 'applied' WHERE provider_event_id = ?",
        )
        .bind(event!.provider_event_id)
        .run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      database
        .prepare(
          "DELETE FROM commerce_provider_events WHERE provider_event_id = ?",
        )
        .bind(event!.provider_event_id)
        .run(),
    ).rejects.toThrow(/cannot be deleted/);
  });
});

describe("contracts", () => {
  it("rejects an offer whose reason disagrees with purchasable", () => {
    const base = {
      sku: "pro-3m",
      label: "Pro, 3 months",
      amountMinor: priceList["pro-3m"].amountMinor,
    };
    expect(
      commerceOfferSchema.safeParse({
        ...base,
        purchasable: true,
        reason: "pro_not_offered",
      }).success,
    ).toBe(false);
    expect(
      commerceOfferSchema.safeParse({ ...base, purchasable: false, reason: null })
        .success,
    ).toBe(false);
    expect(
      commerceOfferSchema.safeParse({ ...base, purchasable: true, reason: null })
        .success,
    ).toBe(true);
  });

  it("keeps the SKU enum and the price list in step", () => {
    expect([...commerceSkuSchema.options]).toEqual(Object.keys(priceList));
  });

  it("rejects unknown fields on the checkout request", async () => {
    const { actor, certificationId } = await purchaserOf("standard-3m");
    const response = await call("/api/commerce/checkouts", {
      actor,
      body: {
        certificationId,
        sku: "standard-3m",
        clientCheckoutKey: crypto.randomUUID(),
        unexpected: true,
      },
    });
    expect(response.status).toBe(400);
  });
});
