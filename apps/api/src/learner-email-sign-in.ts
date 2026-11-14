import { Hono, type Context } from "hono";
import {
  learnerEmailRequestSchema,
  learnerEmailSignInInspectResponseSchema,
  learnerEmailSignInLinkTokenSchema,
  learnerEmailSignInRedeemResponseSchema,
  localLearnerAuthMessageResponseSchema,
  localLearnerAuthPreflightResponseSchema,
  localTestInboxResponseSchema,
} from "@certpath/contracts";
import { LocalTestMailAdapter } from "./local-test-mail.ts";
import {
  isEmailSignInTokenUsable,
  issueEmailSignInToken,
  learnerSessionLifetimeMs,
  redeemEmailSignInToken,
} from "./security/email-sign-in-links.ts";
import type { SecurityDatabase } from "./security/database.ts";
import { sessionCookie } from "./security/http-session.ts";
import {
  consumeLocalRateLimit,
  isLocalOrigin,
  isSyntheticEmail,
  normalizeEmail,
  readJsonBody,
  validRequestOrigin,
} from "./security/local-learner-request.ts";

type EmailSignInBindings = {
  DB: SecurityDatabase;
  PUBLIC_SITE_ORIGIN?: string;
  CSRF_HMAC_SECRET?: string;
  LOCAL_LEARNER_EMAIL_LINK_ENABLED?: string;
  LOCAL_TEST_MAIL_ENABLED?: string;
  LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET?: string;
};
type EmailSignInContext = Context<{ Bindings: EmailSignInBindings }>;

const acceptedMessage =
  "If the address is eligible, check the local test inbox.";

function hasSecret(value: string | undefined): value is string {
  return Boolean(value && new TextEncoder().encode(value).byteLength >= 32);
}

function emailSignInIsConfigured(
  bindings: EmailSignInBindings,
): bindings is EmailSignInBindings & {
  PUBLIC_SITE_ORIGIN: string;
  LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET: string;
} {
  return (
    bindings.LOCAL_LEARNER_EMAIL_LINK_ENABLED === "true" &&
    bindings.LOCAL_TEST_MAIL_ENABLED === "true" &&
    Boolean(bindings.PUBLIC_SITE_ORIGIN && isLocalOrigin(bindings.PUBLIC_SITE_ORIGIN)) &&
    hasSecret(bindings.LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET) &&
    hasSecret(bindings.CSRF_HMAC_SECRET)
  );
}

function errorResponse(
  context: EmailSignInContext,
  status: 400 | 403 | 413 | 415 | 429 | 503,
  code: string,
) {
  return context.json({ error: { code } }, status);
}

async function readValidatedBody<T>(
  context: EmailSignInContext,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<T | Response> {
  const body = await readJsonBody(context.req.raw);
  if (!body.ok) return errorResponse(context, body.status, "invalid_request");
  const parsed = schema.safeParse(body.value);
  if (!parsed.success) return errorResponse(context, 400, "invalid_request");
  return parsed.data;
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

function signInLink(origin: string, token: string): string {
  return `${origin}/sign-in/link#token=${encodeURIComponent(token)}`;
}

export function createLearnerEmailSignInApi(
  mail: LocalTestMailAdapter,
  now: () => number = Date.now,
) {
  const router = new Hono<{ Bindings: EmailSignInBindings }>();

  router.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Content-Type-Options", "nosniff");
    await next();
  });

  router.get("/preflight", (context) => {
    const enabled = emailSignInIsConfigured(context.env);
    return context.json(
      localLearnerAuthPreflightResponseSchema.parse({
        signInEnabled: enabled,
        localMailboxEnabled: enabled,
      }),
    );
  });

  router.post("/request", async (context) => {
    if (!emailSignInIsConfigured(context.env)) {
      return errorResponse(context, 503, "service_unavailable");
    }
    const origin = context.env.PUBLIC_SITE_ORIGIN;
    if (!validRequestOrigin(context.req.raw, origin, true)) {
      return errorResponse(context, 403, "invalid_origin");
    }
    const input = await readValidatedBody(context, learnerEmailRequestSchema);
    if (isResponse(input)) return input;
    const address = normalizeEmail(input.email);
    const timestamp = now();
    if (
      !(await consumeLocalRateLimit(
        context.env.DB,
        context.env.LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET,
        "sign_in_link_request",
        context.req.raw,
        isSyntheticEmail(address) ? address : null,
        timestamp,
      ))
    ) {
      return errorResponse(context, 429, "rate_limited");
    }
    if (!isSyntheticEmail(address)) {
      return errorResponse(context, 400, "synthetic_email_required");
    }
    const issued = await issueEmailSignInToken(
      context.env.DB,
      address,
      timestamp,
    );
    if (issued) {
      mail.send(address, "sign_in_link", signInLink(origin, issued.token), timestamp);
    }
    return context.json(
      localLearnerAuthMessageResponseSchema.parse({ message: acceptedMessage }),
      202,
    );
  });

  router.post("/inspect", async (context) => {
    if (!emailSignInIsConfigured(context.env)) {
      return errorResponse(context, 503, "service_unavailable");
    }
    const origin = context.env.PUBLIC_SITE_ORIGIN;
    if (!validRequestOrigin(context.req.raw, origin, true)) {
      return errorResponse(context, 403, "invalid_origin");
    }
    const input = await readValidatedBody(
      context,
      learnerEmailSignInLinkTokenSchema,
    );
    if (isResponse(input)) return input;
    const timestamp = now();
    if (
      !(await consumeLocalRateLimit(
        context.env.DB,
        context.env.LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET,
        "sign_in_link_inspect",
        context.req.raw,
        null,
        timestamp,
      ))
    ) {
      return errorResponse(context, 429, "rate_limited");
    }
    const usable = await isEmailSignInTokenUsable(
      context.env.DB,
      input.token,
      timestamp,
    );
    return context.json(
      learnerEmailSignInInspectResponseSchema.parse({
        status: usable ? "valid" : "invalid",
      }),
    );
  });

  router.post("/redeem", async (context) => {
    if (!emailSignInIsConfigured(context.env)) {
      return errorResponse(context, 503, "service_unavailable");
    }
    const origin = context.env.PUBLIC_SITE_ORIGIN;
    if (!validRequestOrigin(context.req.raw, origin, true)) {
      return errorResponse(context, 403, "invalid_origin");
    }
    const input = await readValidatedBody(
      context,
      learnerEmailSignInLinkTokenSchema,
    );
    if (isResponse(input)) return input;
    const timestamp = now();
    if (
      !(await consumeLocalRateLimit(
        context.env.DB,
        context.env.LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET,
        "sign_in_link_redeem",
        context.req.raw,
        null,
        timestamp,
      ))
    ) {
      return errorResponse(context, 429, "rate_limited");
    }
    const redeemed = await redeemEmailSignInToken(
      context.env.DB,
      input.token,
      timestamp,
    );
    if (!redeemed) {
      return errorResponse(context, 400, "invalid_or_expired_link");
    }
    mail.discardToken(input.token);
    context.header(
      "Set-Cookie",
      sessionCookie(
        redeemed.rawSessionToken,
        learnerSessionLifetimeMs / 1000,
        new URL(context.req.url).protocol === "https:",
      ),
    );
    return context.json(
      learnerEmailSignInRedeemResponseSchema.parse({ redirectTo: "/app/home" }),
    );
  });

  router.get("/test-inbox", (context) => {
    if (
      !emailSignInIsConfigured(context.env) ||
      !validRequestOrigin(
        context.req.raw,
        context.env.PUBLIC_SITE_ORIGIN,
        false,
      )
    ) {
      return errorResponse(context, 503, "service_unavailable");
    }
    const address = normalizeEmail(context.req.query("email") ?? "");
    if (!isSyntheticEmail(address)) {
      return errorResponse(context, 400, "synthetic_email_required");
    }
    return context.json(
      localTestInboxResponseSchema.parse({
        messages: mail.list(address, now()),
      }),
    );
  });

  return router;
}
