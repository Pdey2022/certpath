import { Hono, type Context } from "hono";
import {
  commerceCheckoutRequestSchema,
  commerceCheckoutResponseSchema,
  commerceOffersResponseSchema,
  commercePurchaseNotAllowedErrorSchema,
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
import {
  resolvePaymentProvider,
  type PaymentProvider,
} from "./provider.ts";

// Learner-facing commerce routes: the offers projection, checkout creation and
// the checkout read.
//
// Settlement, the webhook, refunds and receipts are not here. Nothing on this
// router can grant access, and no provider event is accepted: the only
// unauthenticated write surface in the application arrives with 0019.
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
    status as 400 | 401 | 404 | 409 | 413 | 415 | 503,
  );
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

  return api;
}
