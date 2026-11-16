import { Hono, type Context } from "hono";
import {
  commerceCheckoutAlreadyOpenErrorSchema,
  commerceCheckoutRequestSchema,
  commerceCheckoutResponseSchema,
  commerceFakePayRequestSchema,
  commerceOffersResponseSchema,
  commercePurchaseNotAllowedErrorSchema,
  commerceReceiptListResponseSchema,
  commerceReceiptSchema,
  commerceRefundRequestSchema,
  commerceRefundResponseSchema,
  commerceWebhookResponseSchema,
} from "@certpath/contracts";
import type { SecurityDatabase } from "../security/database.ts";
import {
  constantTimeEqual,
  createCsrfToken,
  sessionCookieToken,
  sessionDigest,
} from "../security/http-session.ts";
import { findActiveApplicationSession } from "../security/repository.ts";
import {
  createCheckout,
  isSku,
  projectOffers,
  readCheckout,
  type CheckoutResult,
} from "./checkouts.ts";
import { listReceipts, maxReceiptsPerExam, readReceipt } from "./receipts.ts";
import { requestRefund, type RefundRequestResult } from "./refunds.ts";
import {
  resolvePaymentProvider,
  type PaymentProvider,
} from "./provider.ts";
import { isFakeProvider } from "./providers/fake.ts";
import {
  buildFakeCompletedEvent,
  handleProviderWebhook,
  maxWebhookBodyBytes,
  type WebhookResult,
} from "./webhooks.ts";

// The commerce routes: the learner-facing app (offers projection, checkout
// creation, the checkout read and the local dev seam) and the provider webhook
// router.
//
// Two Hono apps live in one module because they are the two halves of the
// boundary the design turns on. `createCommerceApi` reads a session cookie and,
// for a mutation, requires the site origin and a CSRF token;
// `createCommerceWebhookApi` reads none of those and is authenticated by the
// provider's signature alone. Separate apps are what makes "no session on the
// webhook" structural rather than a branch inside one middleware.
//
// What this file may **not** claim is that nothing here can grant access.
// `createCommerceWebhookApi` and `POST /dev/fake-pay` both reach
// `handleProviderWebhook`, which is the one settlement path in the application;
// the dev seam exists only when the provider is the fake and
// `LOCAL_COMMERCE_DEV_TOOLS` is the exact string "true", and it signs a body and
// dispatches it rather than writing anything itself. The narrower, true claim is
// that no route here grants anything on its own, and that access still exists
// only because a row in `learner_access_grants` does.
//
// The refund route is the first place the application **removes** an entitlement
// on a learner's own instruction, and it is shaped so every removal is named by a
// refund row created before the provider call, audited by 0013's revocation
// trigger, counted by the settle statement and irreversible.
//
// The gate order is deliberate and fail-closed: `COMMERCE_ENABLED` must be the
// exact string "true", the site origin and CSRF secret must be usable, and a
// provider must resolve. Any of the three missing answers `503` before a session
// is read, so an environment with commerce off cannot write a checkout row.
//
// Rules: docs/commerce.md.

type Bindings = {
  DB: SecurityDatabase;
  PUBLIC_SITE_ORIGIN?: string;
  CSRF_HMAC_SECRET?: string;
  COMMERCE_ENABLED?: string;
  PAYMENT_PROVIDER?: string;
  COMMERCE_WEBHOOK_SECRET?: string;
  /**
   * The dev seam's switch. Absent means off: only the exact string "true" with
   * `PAYMENT_PROVIDER=fake` makes `POST /dev/fake-pay` exist at all, and every
   * other value answers `404` as if the route had never been written.
   */
  LOCAL_COMMERCE_DEV_TOOLS?: string;
};

interface Principal {
  userId: string;
  tokenDigest: string;
  origin: string;
  csrfSecret: Uint8Array;
}

interface Variables {
  principal: Principal;
  requestId: string;
  provider: PaymentProvider;
}

type CommerceContext = Context<{ Bindings: Bindings; Variables: Variables }>;

const maxJsonBytes = 8 * 1024;
const pathIdSchema = /^[a-zA-Z0-9:_-]{1,128}$/;

function response(
  context: CommerceContext,
  status: number,
  code: string,
): Response {
  return context.json(
    { error: { code, requestId: context.get("requestId") } },
    status as 400 | 401 | 404 | 409 | 413 | 415 | 500 | 503,
  );
}

function refundFailure(
  context: CommerceContext,
  result: Extract<RefundRequestResult, { ok: false }>,
): Response {
  switch (result.failure.code) {
    case "checkout-not-found":
      return response(context, 404, "checkout_not_found");
    case "refund-not-allowed":
      return response(context, 409, "refund_not_allowed");
    case "refund-window-closed":
      return response(context, 400, "refund_window_closed");
    case "refund-already-used":
      return response(context, 409, "refund_already_used");
    case "refund-requires-support":
      // A staff-granted Pro in the way, a dependent checkout outside its window,
      // or a refund that would leave future-but-not-present coverage: nothing
      // moves and the case is support's. The code carries no detail on purpose.
      return response(context, 409, "refund_requires_support");
    case "refund-rejected":
      // A definitive decline is not an outage: answering 503 would invite a
      // retry of a decision that will not change.
      return response(context, 409, "refund_rejected");
    case "provider-unavailable":
      return response(context, 503, "provider_unavailable");
  }
}

function readConfiguration(bindings: Bindings): {
  origin: string;
  csrfSecret: Uint8Array;
} | null {
  if (!bindings.PUBLIC_SITE_ORIGIN || !bindings.CSRF_HMAC_SECRET) return null;
  let url: URL;
  try {
    url = new URL(bindings.PUBLIC_SITE_ORIGIN);
  } catch {
    return null;
  }
  const secret = new TextEncoder().encode(bindings.CSRF_HMAC_SECRET);
  if (
    url.protocol !== "https:" ||
    url.origin !== bindings.PUBLIC_SITE_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    secret.byteLength < 32
  ) {
    return null;
  }
  return { origin: bindings.PUBLIC_SITE_ORIGIN, csrfSecret: secret };
}

function setPrivateHeaders(context: CommerceContext): void {
  context.header("Cache-Control", "private, no-store, max-age=0");
  context.header("Pragma", "no-cache");
  context.header("X-Robots-Tag", "noindex, nofollow");
  context.header("X-Request-Id", context.get("requestId"));
}

export function createCommerceApi(
  now: () => number = Date.now,
  /**
   * Test seam, exactly like the `stagingVerifier`/`staffVerifier` arguments to
   * `createApi`: an adapter injected here replaces binding resolution so a test
   * can drive a provider outage without a binding. `COMMERCE_ENABLED` still
   * gates every route, so an injected adapter cannot switch commerce on.
   */
  injectedProvider?: PaymentProvider,
) {
  const api = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  api.use("*", async (context, next) => {
    context.set("requestId", crypto.randomUUID());
    setPrivateHeaders(context);

    if (context.env.COMMERCE_ENABLED !== "true") {
      return response(context, 503, "commerce_disabled");
    }
    const configuration = readConfiguration(context.env);
    if (!configuration) {
      return response(context, 503, "service_unavailable");
    }
    // Resolved per request from bindings, never injected from a route: an
    // unknown or misspelled provider is "commerce is off", not "fake".
    const provider =
      injectedProvider ??
      resolvePaymentProvider(
        {
          PAYMENT_PROVIDER: context.env.PAYMENT_PROVIDER,
          COMMERCE_WEBHOOK_SECRET: context.env.COMMERCE_WEBHOOK_SECRET,
          PUBLIC_SITE_ORIGIN: configuration.origin,
        },
        now,
      );
    if (!provider) return response(context, 503, "commerce_disabled");

    const rawToken = sessionCookieToken(context.req.header("Cookie") ?? null);
    if (!rawToken) return response(context, 401, "unauthenticated");
    const tokenDigest = await sessionDigest(rawToken);
    const session = await findActiveApplicationSession(
      context.env.DB,
      tokenDigest,
      now(),
    );
    if (!session) return response(context, 401, "unauthenticated");

    context.set("principal", {
      userId: session.userId,
      tokenDigest,
      ...configuration,
    });
    context.set("provider", provider);
    await next();
  });

  async function protectMutation(
    context: CommerceContext,
  ): Promise<Response | null> {
    const principal = context.get("principal");
    if (
      context.req.header("Origin") !== principal.origin ||
      new URL(context.req.url).origin !== principal.origin
    ) {
      return response(context, 400, "invalid_origin");
    }
    const supplied = context.req.header("X-CSRF-Token");
    if (!supplied || supplied.length > 64) {
      return response(context, 400, "invalid_csrf");
    }
    const expected = await createCsrfToken(
      principal.origin,
      principal.tokenDigest,
      principal.csrfSecret,
    );
    return constantTimeEqual(supplied, expected)
      ? null
      : response(context, 400, "invalid_csrf");
  }

  async function readJson<T>(
    context: CommerceContext,
    schema: {
      safeParse(
        value: unknown,
      ): { success: true; data: T } | { success: false };
    },
  ): Promise<{ value: T } | { response: Response }> {
    const contentType = context.req.header("Content-Type")?.trim().toLowerCase();
    if (
      contentType !== "application/json" &&
      contentType !== "application/json; charset=utf-8"
    ) {
      return { response: response(context, 415, "unsupported_media_type") };
    }
    const length = context.req.header("Content-Length");
    if (length !== undefined) {
      if (!/^\d+$/.test(length)) {
        return { response: response(context, 400, "validation_error") };
      }
      if (Number(length) > maxJsonBytes) {
        return { response: response(context, 413, "payload_too_large") };
      }
    }
    const body = context.req.raw.body;
    if (!body) return { response: response(context, 400, "validation_error") };
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxJsonBytes) {
        await reader.cancel();
        return { response: response(context, 413, "payload_too_large") };
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return { response: response(context, 400, "validation_error") };
    }
    const parsed = schema.safeParse(value);
    return parsed.success
      ? { value: parsed.data }
      : { response: response(context, 400, "validation_error") };
  }

  function checkoutFailure(
    context: CommerceContext,
    result: Extract<CheckoutResult, { ok: false }>,
  ): Response {
    const failure = result.failure;
    switch (failure.code) {
      case "certification-not-found":
        return response(context, 404, "certification_not_found");
      case "checkout-not-found":
        return response(context, 404, "checkout_not_found");
      case "idempotency-conflict":
        return response(context, 409, "idempotency_conflict");
      case "checkout-already-open":
        // The existing id travels, so the second tab can be handed the live
        // provider session instead of opening a second one.
        return context.json(
          commerceCheckoutAlreadyOpenErrorSchema.parse({
            error: {
              code: "checkout_already_open",
              requestId: context.get("requestId"),
              checkoutId: failure.checkoutId,
            },
          }),
          409,
        );
      case "provider-unavailable":
        return response(context, 503, "provider_unavailable");
      case "purchase-not-allowed":
        // The refusal carries the rule it hit and, for `standard_too_short`,
        // the fact that the bundle is the way through. The rule is not hidden
        // behind a bare 409.
        return context.json(
          commercePurchaseNotAllowedErrorSchema.parse({
            error: {
              code: "purchase_not_allowed",
              requestId: context.get("requestId"),
              reason: failure.reason,
              requiresBundle: failure.requiresBundle,
            },
          }),
          409,
        );
    }
  }

  api.get("/offers", async (context) => {
    const entries = [...new URL(context.req.url).searchParams.entries()];
    if (
      entries.length !== 1 ||
      entries[0]![0] !== "certificationId" ||
      !pathIdSchema.test(entries[0]![1])
    ) {
      return response(context, 400, "validation_error");
    }
    const principal = context.get("principal");
    const result = await projectOffers(context.env.DB, {
      userId: principal.userId,
      certificationId: entries[0]![1],
      now: now(),
    });
    if (!result.ok) return response(context, 404, "certification_not_found");
    return context.json(commerceOffersResponseSchema.parse(result.value));
  });

  api.post("/checkouts", async (context) => {
    const denied = await protectMutation(context);
    if (denied) return denied;
    const parsed = await readJson(context, commerceCheckoutRequestSchema);
    if ("response" in parsed) return parsed.response;
    if (!isSku(parsed.value.sku)) {
      return response(context, 400, "unknown_sku");
    }
    const principal = context.get("principal");
    const result = await createCheckout(
      context.env.DB,
      context.get("provider"),
      {
        userId: principal.userId,
        certificationId: parsed.value.certificationId,
        sku: parsed.value.sku,
        clientCheckoutKey: parsed.value.clientCheckoutKey,
        origin: principal.origin,
        now: now(),
      },
    );
    if (!result.ok) return checkoutFailure(context, result);
    return context.json(
      commerceCheckoutResponseSchema.parse(result.value),
      result.created ? 201 : 200,
    );
  });

  api.get("/checkouts/:checkoutId", async (context) => {
    const checkoutId = context.req.param("checkoutId");
    if (!pathIdSchema.test(checkoutId)) {
      return response(context, 404, "checkout_not_found");
    }
    const principal = context.get("principal");
    const result = await readCheckout(context.env.DB, {
      userId: principal.userId,
      checkoutId,
      now: now(),
    });
    if (!result.ok) return checkoutFailure(context, result);
    return context.json(commerceCheckoutResponseSchema.parse(result.value));
  });

  // The refund: two transactions with a provider call between them, and the
  // ledger decides, not the provider. Batch 1 records the decision, the provider
  // is called with our refund id as its idempotency key, batch 2 revokes and
  // settles. Nothing about the set, the amount or the window is read from the
  // request body beyond the learner's own reason text.
  api.post("/checkouts/:checkoutId/refund", async (context) => {
    const denied = await protectMutation(context);
    if (denied) return denied;
    const checkoutId = context.req.param("checkoutId");
    if (!pathIdSchema.test(checkoutId)) {
      return response(context, 404, "checkout_not_found");
    }
    const parsed = await readJson(context, commerceRefundRequestSchema);
    if ("response" in parsed) return parsed.response;
    const principal = context.get("principal");
    const result = await requestRefund(
      context.env.DB,
      context.get("provider"),
      {
        userId: principal.userId,
        checkoutId,
        reason: parsed.value.reason,
        now: now(),
      },
    );
    if (!result.ok) return refundFailure(context, result);
    return context.json(
      commerceRefundResponseSchema.parse(result.value),
      result.status,
    );
  });

  // The receipts read. Owner-scoped in the `WHERE`, newest first, capped at 50
  // with no cursor: a learner's receipts for one exam are bounded by their
  // purchases, and `GET /receipts/:receiptId` serves any single one.
  api.get("/receipts", async (context) => {
    const entries = [...new URL(context.req.url).searchParams.entries()];
    const certifications = entries.filter(
      ([name]) => name === "certificationId",
    );
    const limits = entries.filter(([name]) => name === "limit");
    if (
      entries.length !== certifications.length + limits.length ||
      certifications.length !== 1 ||
      limits.length > 1
    ) {
      return response(context, 400, "validation_error");
    }
    const certificationId = certifications[0]![1];
    if (!pathIdSchema.test(certificationId)) {
      return response(context, 400, "validation_error");
    }
    let limit = maxReceiptsPerExam;
    if (limits.length === 1) {
      const raw = limits[0]![1];
      if (
        !/^\d+$/.test(raw) ||
        Number(raw) < 1 ||
        Number(raw) > maxReceiptsPerExam
      ) {
        return response(context, 400, "validation_error");
      }
      limit = Number(raw);
    }
    const principal = context.get("principal");
    const result = await listReceipts(context.env.DB, {
      userId: principal.userId,
      certificationId,
      limit,
    });
    if (!result.ok) return response(context, 404, "certification_not_found");
    return context.json(commerceReceiptListResponseSchema.parse(result.value));
  });

  api.get("/receipts/:receiptId", async (context) => {
    const receiptId = context.req.param("receiptId");
    if (!pathIdSchema.test(receiptId)) {
      return response(context, 404, "receipt_not_found");
    }
    const principal = context.get("principal");
    const receipt = await readReceipt(context.env.DB, {
      userId: principal.userId,
      receiptId,
    });
    if (!receipt) return response(context, 404, "receipt_not_found");
    return context.json(commerceReceiptSchema.parse(receipt));
  });

  // The dev seam. It exists only when the provider is the fake **and** the local
  // switch is the exact string "true"; every other combination answers 404
  // `not_found`, exactly as an unwritten route would, so a deployed Worker can
  // never be probed for it. It takes a learner session and a CSRF token because
  // it is a learner route, and it grants nothing on its own: it signs a body and
  // dispatches it through `handleProviderWebhook`, the same function the webhook
  // route calls. One write path, no second door.
  api.post("/dev/fake-pay", async (context) => {
    const provider = context.get("provider");
    if (
      context.env.LOCAL_COMMERCE_DEV_TOOLS !== "true" ||
      !isFakeProvider(provider)
    ) {
      return response(context, 404, "not_found");
    }
    const denied = await protectMutation(context);
    if (denied) return denied;
    const parsed = await readJson(context, commerceFakePayRequestSchema);
    if ("response" in parsed) return parsed.response;
    const principal = context.get("principal");
    const built = await buildFakeCompletedEvent(context.env.DB, provider, {
      userId: principal.userId,
      checkoutId: parsed.value.checkoutId,
      now: now(),
    });
    // Another learner's checkout, a nonexistent one, or one whose provider
    // session was never bound: the same answer in every case.
    if (!built) return response(context, 404, "checkout_not_found");
    const result = await handleProviderWebhook(context.env.DB, provider, {
      providerName: provider.name,
      rawBody: built.rawBody,
      headers: built.headers,
      now: now(),
    });
    return webhookResponse(context, result, context.get("requestId"));
  });

  // The one path that is an undiagnosed bug or an outage, given the same shape as
  // every other refusal. Without this, Hono's default handler answers a bare
  // `500 Internal Server Error` with no body and no request id - so the refund
  // route, the only commerce path that deliberately throws for a non-constraint
  // error, would be the one path on which an operator has no correlation id.
  //
  // What is logged is `{requestId, route, error.name, error.message}` and nothing
  // else: never the request body, never the learner's `reason` text, never a
  // token or a signature. The learner gets the code, not the diagnosis.
  api.onError((error, context) => {
    const requestId = context.get("requestId") || crypto.randomUUID();
    context.set("requestId", requestId);
    setPrivateHeaders(context);
    console.error("Commerce request failed", {
      requestId,
      route: `${context.req.method} ${new URL(context.req.url).pathname}`,
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
    });
    return response(context, 500, "internal_error");
  });

  return api;
}

function webhookResponse(
  context: {
    json: (body: unknown, status?: 400 | 401 | 404 | 413 | 503) => Response;
  },
  result: WebhookResult,
  requestId: string,
): Response {
  if (!result.ok) {
    return context.json({ error: { code: result.code, requestId } }, result.status);
  }
  return context.json(
    commerceWebhookResponseSchema.parse({
      received: true,
      duplicate: result.duplicate,
    }),
  );
}

/**
 * The webhook router.
 *
 * Mounted at `/api/commerce/webhooks`, ahead of the learner router, and
 * deliberately a separate Hono app: the learner router's middleware reads a
 * session cookie on every path it owns, and the webhook must not. Keeping them in
 * separate apps is what makes "no session, no CSRF, no IP allowlist" structural
 * rather than a promise about a conditional inside a middleware.
 *
 * What is left as the door: `provider.verifyEvent` (HMAC + replay window), the
 * event id's primary key, and the deterministic grant operation id.
 */
export function createCommerceWebhookApi(
  now: () => number = Date.now,
  injectedProvider?: PaymentProvider,
) {
  const api = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  api.post("/:provider", async (context) => {
    const requestId = crypto.randomUUID();
    context.header("Cache-Control", "private, no-store, max-age=0");
    context.header("Pragma", "no-cache");
    context.header("X-Request-Id", requestId);
    context.set("requestId", requestId);
    // A provider's own URL is not indexable content, but the header costs
    // nothing and stops an accidental crawl answer from being cached.
    context.header("X-Robots-Tag", "noindex, nofollow");

    if (context.env.COMMERCE_ENABLED !== "true") {
      return webhookResponse(context, { ok: false, status: 503, code: "commerce_disabled" }, requestId);
    }
    if (!context.env.PUBLIC_SITE_ORIGIN) {
      return webhookResponse(context, { ok: false, status: 503, code: "commerce_disabled" }, requestId);
    }
    const provider =
      injectedProvider ??
      resolvePaymentProvider(
        {
          PAYMENT_PROVIDER: context.env.PAYMENT_PROVIDER,
          COMMERCE_WEBHOOK_SECRET: context.env.COMMERCE_WEBHOOK_SECRET,
          PUBLIC_SITE_ORIGIN: context.env.PUBLIC_SITE_ORIGIN,
        },
        now,
      );
    if (!provider) {
      return webhookResponse(context, { ok: false, status: 503, code: "commerce_disabled" }, requestId);
    }

    const read = await readRawBody(context.req.raw, maxWebhookBodyBytes);
    if ("failure" in read) {
      return webhookResponse(
        context,
        {
          ok: false,
          status: read.failure === "payload_too_large" ? 413 : 400,
          code: read.failure,
        },
        requestId,
      );
    }
    const result = await handleProviderWebhook(context.env.DB, provider, {
      providerName: context.req.param("provider"),
      rawBody: read.body,
      // The signature header is read by the adapter and by nothing else, and it
      // is never logged.
      headers: context.req.raw.headers,
      now: now(),
    });
    return webhookResponse(context, result, requestId);
  });

  return api;
}

/**
 * Read a request body as text with a byte cap, before anything parses it.
 *
 * `payload_too_large` means the cap was exceeded. `Content-Length` is checked
 * first so an oversized body is refused without reading it, and the stream count
 * is the real bound because a client can lie about the header.
 *
 * `malformed_event` means the bytes are not valid UTF-8. These bytes come from an
 * unauthenticated client and this runs before any signature is checked, so the
 * decoder's failure has to be an answer rather than a thrown 500: `fatal: true`
 * throws on the first invalid sequence, and an unhandled throw here would let
 * anyone produce 5xx responses without knowing the webhook secret.
 */
async function readRawBody(
  request: Request,
  maxBytes: number,
): Promise<{ body: string } | { failure: "payload_too_large" | "malformed_event" }> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    return { failure: "payload_too_large" };
  }
  const body = request.body;
  if (!body) return { body: "" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return { failure: "payload_too_large" };
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { body: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { failure: "malformed_event" };
  }
}
