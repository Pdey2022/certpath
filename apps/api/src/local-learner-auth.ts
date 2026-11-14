import { Hono, type Context } from "hono";
import {
  learnerEmailRequestSchema,
  learnerEmailVerificationRequestSchema,
  learnerPasswordResetRequestSchema,
  learnerRegistrationRequestSchema,
  learnerSignInRequestSchema,
  localLearnerAuthMessageResponseSchema,
  localLearnerAuthPreflightResponseSchema,
  localTestInboxResponseSchema,
} from "@certpath/contracts";
import { LocalTestMailAdapter } from "./local-test-mail.ts";
import {
  hashLearnerPassword,
  PasswordHashUnavailableError,
  verifyLearnerPassword,
} from "./security/password-hashing.ts";
import type { SecurityDatabase } from "./security/database.ts";
import {
  clearSessionCookie,
  constantTimeEqual,
  createCsrfToken,
  LEGACY_SESSION_COOKIE,
  opaqueCookieToken,
  sessionCookie,
  sessionCookieToken,
  sessionCookieName,
  sessionDigest,
  STAGING_SESSION_COOKIE,
  type SessionCookieName,
} from "./security/http-session.ts";
import {
  consumeLocalRateLimit,
  createOpaqueToken,
  isLocalOrigin,
  isSyntheticEmail,
  normalizeEmail,
  readJsonBody,
  validRequestOrigin,
} from "./security/local-learner-request.ts";
import {
  findActiveApplicationSession,
} from "./security/repository.ts";
import { isContactIdentityAbort } from "./security/learner-access.ts";
import { revokeOwnApplicationSession } from "./security/mutations.ts";
import {
  createLambdaPasswordVerifier,
  LambdaPasswordVerificationError,
  type LambdaPasswordVerifierBindings,
} from "./security/lambda-password-verifier.ts";
import { isStagingLocalTestOrigin } from "./security/staging-gate.ts";

type LocalAuthBindings = {
  DB: SecurityDatabase;
  PUBLIC_SITE_ORIGIN?: string;
  CSRF_HMAC_SECRET?: string;
  LOCAL_LEARNER_AUTH_ENABLED?: string;
  LOCAL_TEST_MAIL_ENABLED?: string;
  LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET?: string;
  STAGING_LEARNER_AUTH_ENABLED?: string;
  STAGING_TESTER_IPS?: string;
  STAGING_AUTH_RATE_LIMIT_HMAC_SECRET?: string;
  STAGING_LEARNER_EMAIL?: string;
  STAGING_LOCAL_TEST?: string;
  STAGING_LAMBDA_TEST_STUB?: LambdaPasswordVerifierBindings["STAGING_LAMBDA_TEST_STUB"];
  AWS_ACCESS_KEY_ID?: string;
  AWS_REGION?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
  LAMBDA_FUNCTION_URL?: string;
};
type LocalAuthContext = Context<{ Bindings: LocalAuthBindings }>;
export type StagingPasswordVerifier = (
  password: string,
  encodedHash: string,
  bindings: LambdaPasswordVerifierBindings,
) => Promise<boolean>;


export const localPasswordIssuer = "https://local-password.certpath.invalid";
export const stagingPasswordIssuer = "https://staging-password.certpath.invalid";
export const stagingLearnerAuthOrigin =
  "https://learner-auth-staging.certpath.workers.dev";
const verificationLifetimeMs = 24 * 60 * 60 * 1000;
const passwordResetLifetimeMs = 30 * 60 * 1000;
const learnerSessionLifetimeMs = 8 * 60 * 60 * 1000;

const stagingSignInCsrfCookie = "__Host-certpath_signin_csrf";


const responseMessages = {
  accepted: "If the address is eligible, check the local test inbox.",
  verified: "Email verified. You can now sign in.",
  passwordReset: "Password updated. Sign in with the new password.",
  signedOut: "Signed out.",
} as const;


function responseMessage(message: string) {
  return localLearnerAuthMessageResponseSchema.parse({ message });
}

function jsonResponseError(
  context: LocalAuthContext,
  status: 400 | 401 | 403 | 413 | 415 | 429 | 503,
  code: string,
) {
  return context.json({ error: { code } }, status);
}


function localAuthIsConfigured(
  origin: string | undefined,
  enabled: string | undefined,
  mailEnabled: string | undefined,
  rateSecret: string | undefined,
  csrfSecret: string | undefined,
): origin is string {
  return (
    enabled === "true" &&
    mailEnabled === "true" &&
    Boolean(origin && isLocalOrigin(origin)) &&
    Boolean(rateSecret && new TextEncoder().encode(rateSecret).byteLength >= 32) &&
    Boolean(csrfSecret && new TextEncoder().encode(csrfSecret).byteLength >= 32)
  );
}

function stagingAuthIsConfigured(bindings: LocalAuthBindings): boolean {
  const csrfSecret = bindings.CSRF_HMAC_SECRET;
  const rateSecret = bindings.STAGING_AUTH_RATE_LIMIT_HMAC_SECRET;
  const learnerEmail = normalizeEmail(bindings.STAGING_LEARNER_EMAIL ?? "");
  const testerIps = bindings.STAGING_TESTER_IPS
    ?.split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);
  const allowedOrigin =
    bindings.PUBLIC_SITE_ORIGIN === stagingLearnerAuthOrigin ||
    (bindings.STAGING_LOCAL_TEST === "true" &&
      isStagingLocalTestOrigin(bindings.PUBLIC_SITE_ORIGIN));
  const localStubConfigured =
    bindings.STAGING_LOCAL_TEST !== "true" ||
    Boolean(bindings.STAGING_LAMBDA_TEST_STUB);
  return (
    bindings.STAGING_LEARNER_AUTH_ENABLED === "true" &&
    allowedOrigin &&
    learnerEmail.endsWith("@example.test") &&
    Boolean(testerIps?.length) &&
    Boolean(rateSecret && new TextEncoder().encode(rateSecret).byteLength >= 32) &&
    Boolean(csrfSecret && new TextEncoder().encode(csrfSecret).byteLength >= 32) &&
    localStubConfigured &&
    Boolean(
      bindings.AWS_ACCESS_KEY_ID &&
        bindings.AWS_SECRET_ACCESS_KEY &&
        bindings.AWS_SESSION_TOKEN &&
        bindings.AWS_REGION === "eu-north-1" &&
        bindings.LAMBDA_FUNCTION_URL,
    )
  );
}



async function pruneExpiredActionTokens(
  database: SecurityDatabase,
  timestamp: number,
): Promise<void> {
  await database
    .prepare(
      `DELETE FROM learner_auth_tokens
       WHERE expires_at <= ? OR consumed_at IS NOT NULL`,
    )
    .bind(timestamp)
    .run();
}

async function readValidatedBody<T>(
  context: LocalAuthContext,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<T | Response> {
  const body = await readJsonBody(context.req.raw);
  if (!body.ok) return jsonResponseError(context, body.status, "invalid_request");
  const parsed = schema.safeParse(body.value);
  if (!parsed.success) return jsonResponseError(context, 400, "invalid_request");
  return parsed.data;
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}


function signInCsrfCookie(value: string): string {
  return `${stagingSignInCsrfCookie}=${value}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Strict`;
}

function clearSignInCsrfCookie(): string {
  return `${stagingSignInCsrfCookie}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

function registerSignInRoute(
  router: Hono<{ Bindings: LocalAuthBindings }>,
  now: () => number,
  mode: "local" | "staging",
  stagingVerifier?: StagingPasswordVerifier,
): void {
  let dummyHash: Promise<string> | null = null;
  const isStaging = mode === "staging";

  router.post("/sign-in", async (context) => {
    const origin = context.env.PUBLIC_SITE_ORIGIN;
    const rateSecret = isStaging
      ? context.env.STAGING_AUTH_RATE_LIMIT_HMAC_SECRET
      : context.env.LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET;
    const configured = isStaging
      ? stagingAuthIsConfigured(context.env)
      : localAuthIsConfigured(
          origin,
          context.env.LOCAL_LEARNER_AUTH_ENABLED,
          context.env.LOCAL_TEST_MAIL_ENABLED,
          rateSecret,
          context.env.CSRF_HMAC_SECRET,
        );
    if (!configured || !origin || !rateSecret) {
      return jsonResponseError(context, 503, "service_unavailable");
    }
    if (!validRequestOrigin(context.req.raw, origin, true)) {
      return jsonResponseError(context, 403, "invalid_origin");
    }

    if (isStaging) {
      const csrfSecret = context.env.CSRF_HMAC_SECRET;
      const cookieHeader = context.req.header("Cookie") ?? null;
      const nonce = opaqueCookieToken(cookieHeader, stagingSignInCsrfCookie);
      const supplied = context.req.header("X-CSRF-Token");
      if (!csrfSecret || !nonce || !supplied) {
        return jsonResponseError(context, 400, "invalid_csrf");
      }
      const expected = await createCsrfToken(
        origin,
        await sessionDigest(nonce),
        new TextEncoder().encode(csrfSecret),
      );
      if (!constantTimeEqual(supplied, expected)) {
        return jsonResponseError(context, 400, "invalid_csrf");
      }
    }

    const input = await readValidatedBody(context, learnerSignInRequestSchema);
    if (isResponse(input)) return input;
    const email = normalizeEmail(input.email);
    const lookupEmail = isStaging
      ? normalizeEmail(context.env.STAGING_LEARNER_EMAIL ?? "")
      : isSyntheticEmail(email)
        ? email
        : null;
    const timestamp = now();
    if (
      !(await consumeLocalRateLimit(
        context.env.DB,
        rateSecret,
        "sign_in",
        context.req.raw,
        isSyntheticEmail(email) ? email : null,
        timestamp,
      ))
    ) {
      return jsonResponseError(context, 429, "rate_limited");
    }

    const issuer = isStaging ? stagingPasswordIssuer : localPasswordIssuer;
    const row = lookupEmail
      ? await context.env.DB
          .prepare(
            `SELECT c.user_id, c.password_hash, c.updated_at,
                    c.email_verified_at, u.status,
                    EXISTS (
                      SELECT 1 FROM staff_roles
                      WHERE user_id = c.user_id AND active = 1
                    ) AS has_active_staff_role
             FROM learner_password_credentials AS c
             JOIN auth_identities AS identity
               ON identity.issuer = ?
              AND identity.subject = c.subject
              AND identity.user_id = c.user_id
             JOIN users AS u ON u.id = c.user_id
             WHERE c.email_normalized = ?`,
          )
          .bind(issuer, lookupEmail)
          .first<{
            user_id: string;
            password_hash: string | null;
            updated_at: number;
            email_verified_at: number | null;
            status: "active" | "disabled";
            has_active_staff_role: number;
          }>()
      : null;

    if (isStaging && (!row?.password_hash || !stagingVerifier)) {
      return jsonResponseError(context, 503, "service_unavailable");
    }

    let passwordMatches = false;
    try {
      if (isStaging) {
        passwordMatches = await stagingVerifier!(
          input.password,
          row!.password_hash!,
          context.env,
        );
      } else if (row?.password_hash) {
        passwordMatches = await verifyLearnerPassword(
          input.password,
          row.password_hash,
        );
      } else {
        dummyHash ??= hashLearnerPassword(crypto.randomUUID());
        passwordMatches = await verifyLearnerPassword(
          input.password,
          await dummyHash,
        );
      }
    } catch (error) {
      if (
        error instanceof PasswordHashUnavailableError ||
        error instanceof LambdaPasswordVerificationError
      ) {
        return jsonResponseError(context, 503, "service_unavailable");
      }
      throw error;
    }

    const accountMatches = !isStaging || email === lookupEmail;
    if (
      !row ||
      !accountMatches ||
      row.password_hash === null ||
      !passwordMatches ||
      row.status !== "active" ||
      row.email_verified_at === null ||
      row.has_active_staff_role !== 0
    ) {
      return jsonResponseError(context, 401, "invalid_credentials");
    }

    const rawSessionToken = createOpaqueToken();
    const tokenDigest = await sessionDigest(rawSessionToken);
    const operationId = `sign-in:${crypto.randomUUID()}`;
    const expiry = timestamp + learnerSessionLifetimeMs;
    const results = await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO app_sessions (
           token_digest, user_id, created_at, expires_at, revoked_at,
           revocation_operation_id, revoked_by_user_id, mfa_method,
           mfa_verified_at
         )
         SELECT ?, c.user_id, ?, ?, NULL, NULL, NULL, NULL, NULL
         FROM learner_password_credentials AS c
         JOIN users AS u ON u.id = c.user_id
         WHERE c.user_id = ?
           AND c.password_hash = ?
           AND c.updated_at = ?
           AND c.email_verified_at IS NOT NULL
           AND u.status = 'active'
           AND EXISTS (
             SELECT 1 FROM auth_identities
             WHERE issuer = ? AND subject = c.subject AND user_id = c.user_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM staff_roles
             WHERE user_id = c.user_id AND active = 1
           )
         RETURNING token_digest`,
      ).bind(
        tokenDigest,
        timestamp,
        expiry,
        row.user_id,
        row.password_hash,
        row.updated_at,
        issuer,
      ),
      context.env.DB.prepare(
        `INSERT INTO audit_events (
           operation_id, actor_user_id, actor_ref, action, subject_type,
           subject_id, certification_id, reason, occurred_at
         )
         SELECT ?, user_id, NULL, 'learner_signed_in', 'user',
                user_id, NULL, 'Learner signed in', ?
         FROM app_sessions
         WHERE token_digest = ?
         RETURNING operation_id`,
      ).bind(operationId, timestamp, tokenDigest),
    ]);
    if (!results.every((result) => result.meta.changes === 1)) {
      return jsonResponseError(context, 401, "invalid_credentials");
    }
    context.header(
      "Set-Cookie",
      sessionCookie(
        rawSessionToken,
        8 * 60 * 60,
        isStaging || new URL(context.req.url).protocol === "https:",
        isStaging ? STAGING_SESSION_COOKIE : LEGACY_SESSION_COOKIE,
      ),
    );
    if (isStaging) {
      context.header("Set-Cookie", clearSignInCsrfCookie(), { append: true });
    }
    return context.json({ redirectTo: "/app/home" });
  });
}

function actionLink(origin: string, path: string, token: string): string {
  return `${origin}/${path}#token=${encodeURIComponent(token)}`;
}

export function createLocalLearnerAuthApi(
  now: () => number = Date.now,
  mail: LocalTestMailAdapter = new LocalTestMailAdapter(),
) {
  const router = new Hono<{ Bindings: LocalAuthBindings }>();

  router.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Content-Type-Options", "nosniff");
    await next();
  });

  router.get("/preflight", (context) => {
    const enabled = localAuthIsConfigured(
      context.env.PUBLIC_SITE_ORIGIN,
      context.env.LOCAL_LEARNER_AUTH_ENABLED,
      context.env.LOCAL_TEST_MAIL_ENABLED,
      context.env.LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET,
      context.env.CSRF_HMAC_SECRET,
    );
    return context.json(
      localLearnerAuthPreflightResponseSchema.parse({
        signInEnabled: enabled,
        localMailboxEnabled: enabled,
      }),
    );
  });

  router.post("/register", async (context) => {
    const origin = context.env.PUBLIC_SITE_ORIGIN;
    const secret = context.env.LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET;
    if (
      !localAuthIsConfigured(
        origin,
        context.env.LOCAL_LEARNER_AUTH_ENABLED,
        context.env.LOCAL_TEST_MAIL_ENABLED,
        secret,
        context.env.CSRF_HMAC_SECRET,
      ) ||
      !secret
    ) {
      return jsonResponseError(context, 503, "service_unavailable");
    }
    if (!validRequestOrigin(context.req.raw, origin, true)) {
      return jsonResponseError(context, 403, "invalid_origin");
    }
    const input = await readValidatedBody(
      context,
      learnerRegistrationRequestSchema,
    );
    if (isResponse(input)) return input;
    const email = normalizeEmail(input.email);
    if (!(email.includes("@") && isSyntheticEmail(email))) {
      return jsonResponseError(context, 400, "synthetic_email_required");
    }
    const timestamp = now();
    if (
      !(await consumeLocalRateLimit(
        context.env.DB,
        secret,
        "registration",
        context.req.raw,
        email,
        timestamp,
      ))
    ) {
      return jsonResponseError(context, 429, "rate_limited");
    }
    await pruneExpiredActionTokens(context.env.DB, timestamp);

    const userId = crypto.randomUUID();
    const subject = crypto.randomUUID();
    const token = createOpaqueToken();
    const tokenDigest = await sessionDigest(token);
    const operationId = `register:${crypto.randomUUID()}`;
    const expiry = timestamp + verificationLifetimeMs;
    let results: Array<{ meta: { changes: number } }>;
    try {
      results = await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO users (id, status, created_at, updated_at)
           SELECT ?, 'active', ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM learner_password_credentials
             WHERE email_normalized = ?
           )
             AND NOT EXISTS (
               SELECT 1 FROM learner_email_sign_in_invites
               WHERE email_normalized = ?
             )
           RETURNING id`,
        ).bind(userId, timestamp, timestamp, email, email),
        context.env.DB.prepare(
          `INSERT INTO learner_password_credentials (
             user_id, email, email_normalized, subject, password_hash,
             email_verified_at, created_at, updated_at
           )
          SELECT ?, ?, ?, ?, NULL, NULL, ?, ?
           WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)
             AND NOT EXISTS (
               SELECT 1 FROM learner_password_credentials
               WHERE email_normalized = ?
             )
             AND NOT EXISTS (
               SELECT 1 FROM learner_email_sign_in_invites
               WHERE email_normalized = ?
             )
           ON CONFLICT(email_normalized) DO NOTHING
           RETURNING user_id`,
        ).bind(
          userId,
          input.email.trim(),
          email,
          subject,
          timestamp,
          timestamp,
          userId,
          email,
          email,
        ),
        context.env.DB.prepare(
          `INSERT INTO learner_auth_tokens (
             token_digest, user_id, purpose, created_at, expires_at
           )
           SELECT ?, user_id, 'verify_email', ?, ?
           FROM learner_password_credentials
           WHERE user_id = ? AND email_verified_at IS NULL
           RETURNING user_id`,
        ).bind(tokenDigest, timestamp, expiry, userId),
        context.env.DB.prepare(
          `INSERT INTO audit_events (
             operation_id, actor_user_id, actor_ref, action, subject_type,
             subject_id, certification_id, reason, occurred_at
           )
           SELECT ?, NULL, 'learner-self-registration', 'learner_registered',
                  'user', user_id, NULL, 'Learner self-registration', ?
           FROM learner_password_credentials
           WHERE user_id = ?
           RETURNING operation_id`,
        ).bind(operationId, timestamp, userId),
      ]);
    } catch (error) {
      // An address that is already provisioned as a sign-in invite must be
      // indistinguishable from a fresh one: the storage trigger's residual abort
      // answers with the same accepted body, and writes nothing.
      if (isContactIdentityAbort(error)) {
        return context.json(responseMessage(responseMessages.accepted), 202);
      }
      throw error;
    }
    if (!results.every((result) => result.meta.changes === 1)) {
      if (results.every((result) => result.meta.changes === 0)) {
        return context.json(responseMessage(responseMessages.accepted), 202);
      }
      return jsonResponseError(context, 503, "registration_failed");
    }
    mail.send(
      email,
      "verify_email",
      actionLink(origin, "verify-email", token),
      timestamp,
    );
    return context.json(responseMessage(responseMessages.accepted), 202);
  });

  router.post("/verify-email", async (context) => {
    const origin = context.env.PUBLIC_SITE_ORIGIN;
    const secret = context.env.LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET;
    if (
      !localAuthIsConfigured(
        origin,
        context.env.LOCAL_LEARNER_AUTH_ENABLED,
        context.env.LOCAL_TEST_MAIL_ENABLED,
        secret,
        context.env.CSRF_HMAC_SECRET,
      ) ||
      !secret
    ) {
      return jsonResponseError(context, 503, "service_unavailable");
    }
    if (!validRequestOrigin(context.req.raw, origin, true)) {
      return jsonResponseError(context, 403, "invalid_origin");
    }
    const input = await readValidatedBody(
      context,
      learnerEmailVerificationRequestSchema,
    );
    if (isResponse(input)) return input;
    const timestamp = now();
    if (
      !(await consumeLocalRateLimit(
        context.env.DB,
        secret,
        "verification",
        context.req.raw,
        null,
        timestamp,
      ))
    ) {
      return jsonResponseError(context, 429, "rate_limited");
    }
    let passwordHash: string;
    try {
      passwordHash = await hashLearnerPassword(input.password);
    } catch (error) {
      if (error instanceof PasswordHashUnavailableError) {
        return jsonResponseError(context, 503, "service_unavailable");
      }
      throw error;
    }
    const tokenDigest = await sessionDigest(input.token);
    const operationId = `verify:${crypto.randomUUID()}`;
    const results = await context.env.DB.batch([
      context.env.DB.prepare(
        `UPDATE learner_auth_tokens
         SET consumed_at = ?, consumed_operation_id = ?
         WHERE token_digest = ?
           AND purpose = 'verify_email'
           AND expires_at > ?
           AND consumed_at IS NULL
           AND EXISTS (
             SELECT 1 FROM learner_password_credentials
             WHERE user_id = learner_auth_tokens.user_id
               AND email_verified_at IS NULL
               AND password_hash IS NULL
           )
         RETURNING user_id`,
      ).bind(timestamp, operationId, tokenDigest, timestamp),
      context.env.DB.prepare(
        `INSERT INTO auth_identities (issuer, subject, user_id, created_at)
         SELECT ?, c.subject, c.user_id, ?
         FROM learner_password_credentials AS c
         JOIN learner_auth_tokens AS t ON t.user_id = c.user_id
         WHERE t.consumed_operation_id = ?
           AND t.purpose = 'verify_email'
           AND c.email_verified_at IS NULL
           AND c.password_hash IS NULL
         RETURNING user_id`,
      ).bind(localPasswordIssuer, timestamp, operationId),
      context.env.DB.prepare(
        `UPDATE learner_password_credentials
         SET password_hash = ?, email_verified_at = ?, updated_at = ?
         WHERE user_id = (
           SELECT user_id FROM learner_auth_tokens
           WHERE consumed_operation_id = ? AND purpose = 'verify_email'
         )
           AND email_verified_at IS NULL
           AND password_hash IS NULL
         RETURNING user_id`,
      ).bind(passwordHash, timestamp, timestamp, operationId),
      context.env.DB.prepare(
        `INSERT INTO audit_events (
           operation_id, actor_user_id, actor_ref, action, subject_type,
           subject_id, certification_id, reason, occurred_at
         )
         SELECT ?, user_id, NULL, 'learner_email_verified', 'user',
                user_id, NULL, 'Learner email verified', ?
         FROM learner_auth_tokens
         WHERE consumed_operation_id = ? AND purpose = 'verify_email'
           AND EXISTS (
             SELECT 1 FROM learner_password_credentials
             WHERE user_id = learner_auth_tokens.user_id
               AND email_verified_at = ?
           )
         RETURNING operation_id`,
      ).bind(operationId, timestamp, operationId, timestamp),
    ]);
    if (!results.every((result) => result.meta.changes === 1)) {
      return jsonResponseError(context, 400, "invalid_or_expired_link");
    }
    mail.discardToken(input.token);
    return context.json(responseMessage(responseMessages.verified));
  });

  router.post("/recover", async (context) => {
    const origin = context.env.PUBLIC_SITE_ORIGIN;
    const secret = context.env.LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET;
    if (
      !localAuthIsConfigured(
        origin,
        context.env.LOCAL_LEARNER_AUTH_ENABLED,
        context.env.LOCAL_TEST_MAIL_ENABLED,
        secret,
        context.env.CSRF_HMAC_SECRET,
      ) ||
      !secret
    ) {
      return jsonResponseError(context, 503, "service_unavailable");
    }
    if (!validRequestOrigin(context.req.raw, origin, true)) {
      return jsonResponseError(context, 403, "invalid_origin");
    }
    const input = await readValidatedBody(context, learnerEmailRequestSchema);
    if (isResponse(input)) return input;
    const email = normalizeEmail(input.email);
    const timestamp = now();
    if (
      !(await consumeLocalRateLimit(
        context.env.DB,
        secret,
        "recovery",
        context.req.raw,
        isSyntheticEmail(email) ? email : null,
        timestamp,
      ))
    ) {
      return jsonResponseError(context, 429, "rate_limited");
    }
    await pruneExpiredActionTokens(context.env.DB, timestamp);
    if (isSyntheticEmail(email)) {
      const token = createOpaqueToken();
      const tokenDigest = await sessionDigest(token);
      const expiry = timestamp + passwordResetLifetimeMs;
      const result = await context.env.DB.prepare(
        `INSERT INTO learner_auth_tokens (
           token_digest, user_id, purpose, created_at, expires_at
         )
         SELECT ?, c.user_id, 'password_reset', ?, ?
         FROM learner_password_credentials AS c
         JOIN users AS u ON u.id = c.user_id
         WHERE c.email_normalized = ?
           AND c.email_verified_at IS NOT NULL
           AND u.status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM staff_roles
             WHERE user_id = c.user_id AND active = 1
           )
         RETURNING user_id`,
      )
        .bind(tokenDigest, timestamp, expiry, email)
        .all<{ user_id: string }>();
      if (result.results.length === 1) {
        mail.send(
          email,
          "password_reset",
          actionLink(origin, "reset-password", token),
          timestamp,
        );
      }
    }
    return context.json(responseMessage(responseMessages.accepted), 202);
  });

  router.post("/reset-password", async (context) => {
    const origin = context.env.PUBLIC_SITE_ORIGIN;
    const secret = context.env.LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET;
    if (
      !localAuthIsConfigured(
        origin,
        context.env.LOCAL_LEARNER_AUTH_ENABLED,
        context.env.LOCAL_TEST_MAIL_ENABLED,
        secret,
        context.env.CSRF_HMAC_SECRET,
      ) ||
      !secret
    ) {
      return jsonResponseError(context, 503, "service_unavailable");
    }
    if (!validRequestOrigin(context.req.raw, origin, true)) {
      return jsonResponseError(context, 403, "invalid_origin");
    }
    const input = await readValidatedBody(
      context,
      learnerPasswordResetRequestSchema,
    );
    if (isResponse(input)) return input;
    const timestamp = now();
    if (
      !(await consumeLocalRateLimit(
        context.env.DB,
        secret,
        "password_reset",
        context.req.raw,
        null,
        timestamp,
      ))
    ) {
      return jsonResponseError(context, 429, "rate_limited");
    }
    const tokenDigest = await sessionDigest(input.token);
    const eligibleToken = await context.env.DB.prepare(
      `SELECT 1 AS eligible
       FROM learner_auth_tokens AS t
       JOIN learner_password_credentials AS c ON c.user_id = t.user_id
       JOIN users AS u ON u.id = c.user_id
       WHERE t.token_digest = ?
         AND t.purpose = 'password_reset'
         AND t.expires_at > ?
         AND t.consumed_at IS NULL
         AND c.email_verified_at IS NOT NULL
         AND u.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM staff_roles
           WHERE user_id = c.user_id AND active = 1
         )`,
    )
      .bind(tokenDigest, timestamp)
      .first<{ eligible: number }>();
    if (!eligibleToken) {
      return jsonResponseError(context, 400, "invalid_or_expired_link");
    }
    let passwordHash: string;
    try {
      passwordHash = await hashLearnerPassword(input.password);
    } catch (error) {
      if (error instanceof PasswordHashUnavailableError) {
        return jsonResponseError(context, 503, "service_unavailable");
      }
      throw error;
    }
    const operationId = `password-reset:${crypto.randomUUID()}`;
    const results = await context.env.DB.batch([
      context.env.DB.prepare(
        `UPDATE learner_auth_tokens
         SET consumed_at = ?, consumed_operation_id = ?
         WHERE token_digest = ?
           AND purpose = 'password_reset'
           AND expires_at > ?
           AND consumed_at IS NULL
           AND EXISTS (
             SELECT 1 FROM learner_password_credentials
             WHERE user_id = learner_auth_tokens.user_id
               AND email_verified_at IS NOT NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM staff_roles
             WHERE user_id = learner_auth_tokens.user_id AND active = 1
           )
         RETURNING user_id`,
      ).bind(timestamp, operationId, tokenDigest, timestamp),
      context.env.DB.prepare(
        `UPDATE learner_password_credentials
         SET password_hash = ?, updated_at = ?
         WHERE user_id = (
           SELECT user_id FROM learner_auth_tokens
           WHERE consumed_operation_id = ? AND purpose = 'password_reset'
         )
           AND email_verified_at IS NOT NULL
         RETURNING user_id`,
      ).bind(passwordHash, timestamp, operationId),
      context.env.DB.prepare(
        `UPDATE app_sessions
         SET revoked_at = ?,
             revocation_operation_id = 'password-reset:' || lower(hex(randomblob(16))),
             revoked_by_user_id = user_id
         WHERE user_id = (
           SELECT user_id FROM learner_auth_tokens
           WHERE consumed_operation_id = ? AND purpose = 'password_reset'
         )
           AND revoked_at IS NULL
         RETURNING token_digest`,
      ).bind(timestamp, operationId),
      context.env.DB.prepare(
        `INSERT INTO audit_events (
           operation_id, actor_user_id, actor_ref, action, subject_type,
           subject_id, certification_id, reason, occurred_at
         )
         SELECT ?, user_id, NULL, 'learner_password_reset', 'user',
                user_id, NULL, 'Learner password reset', ?
         FROM learner_auth_tokens
         WHERE consumed_operation_id = ? AND purpose = 'password_reset'
           AND EXISTS (
             SELECT 1 FROM learner_password_credentials
             WHERE user_id = learner_auth_tokens.user_id
               AND updated_at = ?
           )
         RETURNING operation_id`,
      ).bind(operationId, timestamp, operationId, timestamp),
    ]);
    if (
      results[0]?.meta.changes !== 1 ||
      results[1]?.meta.changes !== 1 ||
      results[3]?.meta.changes !== 1
    ) {
      return jsonResponseError(context, 400, "invalid_or_expired_link");
    }
    mail.discardToken(input.token);
    return context.json(responseMessage(responseMessages.passwordReset));
  });

  registerSignInRoute(router, now, "local");

  router.get("/test-inbox", (context) => {
    const origin = context.env.PUBLIC_SITE_ORIGIN;
    if (
      !origin ||
      !localAuthIsConfigured(
        origin,
        context.env.LOCAL_LEARNER_AUTH_ENABLED,
        context.env.LOCAL_TEST_MAIL_ENABLED,
        context.env.LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET,
        context.env.CSRF_HMAC_SECRET,
      ) ||
      !validRequestOrigin(context.req.raw, origin, false)
    ) {
      return jsonResponseError(context, 503, "service_unavailable");
    }
    const email = normalizeEmail(context.req.query("email") ?? "");
    if (!isSyntheticEmail(email)) {
      return jsonResponseError(context, 400, "synthetic_email_required");
    }
    return context.json(
      localTestInboxResponseSchema.parse({
        messages: mail.list(email, now()),
      }),
    );
  });

  return router;
}

export function createStagingLearnerAuthApi(
  now: () => number = Date.now,
  verifyPassword: StagingPasswordVerifier = createLambdaPasswordVerifier(),
) {
  const router = new Hono<{ Bindings: LocalAuthBindings }>();

  router.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Content-Type-Options", "nosniff");
    await next();
  });

  router.get("/preflight", (context) => {
    const enabled = stagingAuthIsConfigured(context.env);
    return context.json(
      localLearnerAuthPreflightResponseSchema.parse({
        signInEnabled: enabled,
        localMailboxEnabled: false,
      }),
    );
  });

  router.get("/csrf", async (context) => {
    const origin = context.env.PUBLIC_SITE_ORIGIN;
    const secret = context.env.CSRF_HMAC_SECRET;
    if (
      !stagingAuthIsConfigured(context.env) ||
      !origin ||
      !secret ||
      !validRequestOrigin(context.req.raw, origin, false)
    ) {
      return jsonResponseError(context, 503, "service_unavailable");
    }

    const nonce = createOpaqueToken();
    const csrfToken = await createCsrfToken(
      origin,
      await sessionDigest(nonce),
      new TextEncoder().encode(secret),
    );
    context.header("Set-Cookie", signInCsrfCookie(nonce));
    return context.json({ csrfToken });
  });

  registerSignInRoute(router, now, "staging", verifyPassword);
  return router;
}

export function createApplicationSessionApi(now: () => number = Date.now) {
  const router = new Hono<{ Bindings: LocalAuthBindings }>();

  router.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Content-Type-Options", "nosniff");
    await next();
  });

  router.get("/csrf", async (context) => {
    const origin = context.env.PUBLIC_SITE_ORIGIN;
    const secret = context.env.CSRF_HMAC_SECRET;
    if (!origin || !secret || new TextEncoder().encode(secret).byteLength < 32) {
      return context.json({ error: { code: "service_unavailable" } }, 503);
    }
    if (!validRequestOrigin(context.req.raw, origin, false)) {
      return context.json({ error: { code: "invalid_origin" } }, 403);
    }
    const rawToken = sessionCookieToken(context.req.header("Cookie") ?? null);
    if (!rawToken) {
      return context.json({ error: { code: "unauthenticated" } }, 401);
    }
    const tokenDigest = await sessionDigest(rawToken);
    const session = await findActiveApplicationSession(
      context.env.DB,
      tokenDigest,
      now(),
    );
    if (!session) {
      return context.json({ error: { code: "unauthenticated" } }, 401);
    }
    return context.json({
      csrfToken: await createCsrfToken(
        origin,
        tokenDigest,
        new TextEncoder().encode(secret),
      ),
    });
  });

  router.post("/logout", async (context) => {
    const origin = context.env.PUBLIC_SITE_ORIGIN;
    const secret = context.env.CSRF_HMAC_SECRET;
    const cookieHeader = context.req.header("Cookie") ?? null;
    const cookieName =
      sessionCookieName(cookieHeader) ??
      (context.env.STAGING_LEARNER_AUTH_ENABLED === "true"
        ? STAGING_SESSION_COOKIE
        : LEGACY_SESSION_COOKIE);
    const secure =
      context.env.STAGING_LEARNER_AUTH_ENABLED === "true" ||
      new URL(context.req.url).protocol === "https:";
    if (!origin || !secret || new TextEncoder().encode(secret).byteLength < 32) {
      return context.json({ error: { code: "service_unavailable" } }, 503);
    }
    const rawToken = sessionCookieToken(cookieHeader);
    if (!rawToken) {
      context.header(
        "Set-Cookie",
        clearSessionCookie(secure, cookieName),
      );
      return context.body(null, 204);
    }
    const tokenDigest = await sessionDigest(rawToken);
    const session = await findActiveApplicationSession(
      context.env.DB,
      tokenDigest,
      now(),
    );
    if (!session) {
      context.header(
        "Set-Cookie",
        clearSessionCookie(secure, cookieName),
      );
      return context.body(null, 204);
    }
    if (!validRequestOrigin(context.req.raw, origin, true)) {
      return context.json({ error: { code: "invalid_origin" } }, 400);
    }
    const supplied = context.req.header("X-CSRF-Token");
    const expected = await createCsrfToken(
      origin,
      tokenDigest,
      new TextEncoder().encode(secret),
    );
    if (!supplied || !constantTimeEqual(supplied, expected)) {
      return context.json({ error: { code: "invalid_csrf" } }, 400);
    }
    const revoked = await revokeOwnApplicationSession(
      context.env.DB,
      tokenDigest,
      now(),
      `logout:${crypto.randomUUID()}`,
    );
    if (
      !revoked &&
      (await findActiveApplicationSession(context.env.DB, tokenDigest, now()))
    ) {
      return context.json({ error: { code: "logout_failed" } }, 503);
    }
    context.header(
      "Set-Cookie",
      clearSessionCookie(secure, cookieName),
    );
    return context.body(null, 204);
  });

  return router;
}
