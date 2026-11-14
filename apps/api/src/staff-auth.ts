import { Hono, type Context } from "hono";
import {
  staffAdminPreflightResponseSchema,
  staffSessionResponseSchema,
  staffSignInRequestSchema,
  staffSignInResponseSchema,
} from "@certpath/contracts";
import { adminTesterGate } from "./security/admin-gate.ts";
import type { SecurityDatabase } from "./security/database.ts";
import {
  LEGACY_SESSION_COOKIE,
  STAGING_SESSION_COOKIE,
  sessionCookie,
  sessionCookieToken,
  sessionDigest,
} from "./security/http-session.ts";
import {
  consumeLocalRateLimit,
  createOpaqueToken,
  normalizeEmail,
  readJsonBody,
  validRequestOrigin,
} from "./security/local-learner-request.ts";
import {
  hashLearnerPassword,
  PasswordHashUnavailableError,
  verifyLearnerPassword,
} from "./security/password-hashing.ts";
import { authorizeStaffSession } from "./security/repository.ts";
import {
  readStaffSecurityConfiguration,
  type StaffSecurityBindings,
} from "./security/staff-configuration.ts";

export type StaffPasswordVerifier = (
  password: string,
  encodedHash: string,
) => Promise<boolean>;

type StaffAuthBindings = StaffSecurityBindings & {
  DB: SecurityDatabase;
  STAFF_RATE_LIMIT_HMAC_SECRET?: string;
};

type StaffAuthContext = Context<{
  Bindings: StaffAuthBindings;
  Variables: { requestId: string };
}>;

const staffSessionLifetimeMs = 8 * 60 * 60 * 1000;
const testerAssuranceMethod = "tester-gate";

interface StaffSignInRow {
  user_id: string;
  password_hash: string;
  role: "global_admin" | "manager";
  status: "active" | "disabled";
}

function errorResponse(
  context: StaffAuthContext,
  status: 400 | 401 | 403 | 413 | 415 | 429 | 503,
  code: string,
) {
  return context.json(
    { error: { code, requestId: context.get("requestId") } },
    status,
  );
}

function readConfiguration(env: StaffAuthBindings) {
  const security = readStaffSecurityConfiguration(env);
  const rateSecret = env.STAFF_RATE_LIMIT_HMAC_SECRET;
  if (
    !security ||
    !rateSecret ||
    new TextEncoder().encode(rateSecret).byteLength < 32
  ) {
    return null;
  }
  const testerAssurance =
    env.ADMIN_TESTER_ASSURANCE === "true" &&
    security.policy.allowedMethods.includes(testerAssuranceMethod);
  return { ...security, rateSecret, testerAssurance };
}

async function listStaffCertifications(
  database: SecurityDatabase,
  userId: string,
  role: "global_admin" | "manager",
): Promise<Array<{ id: string; displayName: string }>> {
  const primary = database.withSession("first-primary");
  const rows =
    role === "global_admin"
      ? await primary
          .prepare(
            `SELECT id, display_name FROM certifications
             ORDER BY display_name, id LIMIT 200`,
          )
          .all<{ id: string; display_name: string }>()
      : await primary
          .prepare(
            `SELECT certification.id, certification.display_name
             FROM manager_certification_assignments AS assignment
             JOIN certifications AS certification
               ON certification.id = assignment.certification_id
             WHERE assignment.manager_user_id = ?
               AND assignment.active = 1
             ORDER BY certification.display_name, certification.id
             LIMIT 200`,
          )
          .bind(userId)
          .all<{ id: string; display_name: string }>();
  return rows.results.map((row) => ({
    id: row.id,
    displayName: row.display_name,
  }));
}

export function createStaffAuthApi(
  now: () => number = Date.now,
  verifyPassword: StaffPasswordVerifier = verifyLearnerPassword,
) {
  const api = new Hono<{
    Bindings: StaffAuthBindings;
    Variables: { requestId: string };
  }>();
  let dummyHash: Promise<string> | null = null;

  api.use("*", async (context, next) => {
    context.set("requestId", crypto.randomUUID());
    context.header("Cache-Control", "private, no-store, max-age=0");
    context.header("Pragma", "no-cache");
    context.header("X-Robots-Tag", "noindex, nofollow");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("X-Request-Id", context.get("requestId"));
    const rejected = adminTesterGate(context.req.raw, context.env);
    if (rejected) return rejected;
    await next();
  });

  api.get("/preflight", (context) => {
    const configuration = readConfiguration(context.env);
    return context.json(
      staffAdminPreflightResponseSchema.parse({
        signInEnabled: configuration?.testerAssurance === true,
        testerAssuranceEnabled: configuration?.testerAssurance === true,
      }),
    );
  });

  api.post("/sign-in", async (context) => {
    const configuration = readConfiguration(context.env);
    if (!configuration) return errorResponse(context, 503, "service_unavailable");
    if (!validRequestOrigin(context.req.raw, configuration.origin, true)) {
      return errorResponse(context, 400, "invalid_origin");
    }
    if (!configuration.testerAssurance) {
      return errorResponse(context, 503, "staff_mfa_unavailable");
    }
    const body = await readJsonBody(context.req.raw);
    if (!body.ok) return errorResponse(context, body.status, "invalid_request");
    const parsed = staffSignInRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(context, 400, "invalid_request");

    const timestamp = now();
    const email = normalizeEmail(parsed.data.email);
    if (
      !(await consumeLocalRateLimit(
        context.env.DB,
        configuration.rateSecret,
        "staff_sign_in",
        context.req.raw,
        email,
        timestamp,
      ))
    ) {
      return errorResponse(context, 429, "rate_limited");
    }

    const row = await context.env.DB.withSession("first-primary")
      .prepare(
        `SELECT credentials.user_id, credentials.password_hash,
                staff.role, account.status
         FROM staff_password_credentials AS credentials
         JOIN users AS account ON account.id = credentials.user_id
         JOIN staff_roles AS staff
           ON staff.user_id = credentials.user_id AND staff.active = 1
         WHERE credentials.email_normalized = ?`,
      )
      .bind(email)
      .first<StaffSignInRow>();

    let passwordMatches = false;
    try {
      if (row) {
        passwordMatches = await verifyPassword(
          parsed.data.password,
          row.password_hash,
        );
      } else {
        dummyHash ??= hashLearnerPassword(crypto.randomUUID());
        await verifyPassword(parsed.data.password, await dummyHash);
      }
    } catch (error) {
      if (error instanceof PasswordHashUnavailableError) {
        return errorResponse(context, 503, "service_unavailable");
      }
      throw error;
    }
    if (!row || !passwordMatches || row.status !== "active") {
      return errorResponse(context, 401, "invalid_credentials");
    }

    const rawSessionToken = createOpaqueToken();
    const sessionTokenDigest = await sessionDigest(rawSessionToken);
    const operationId = `staff-sign-in:${crypto.randomUUID()}`;
    const expiresAt = timestamp + staffSessionLifetimeMs;
    const results = await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO app_sessions (
           token_digest, user_id, created_at, expires_at, revoked_at,
           revocation_operation_id, revoked_by_user_id, mfa_method,
           mfa_verified_at
         )
         SELECT ?, credentials.user_id, ?, ?, NULL, NULL, NULL, ?, ?
         FROM staff_password_credentials AS credentials
         JOIN users AS account ON account.id = credentials.user_id
         JOIN staff_roles AS staff
           ON staff.user_id = credentials.user_id AND staff.active = 1
         WHERE credentials.user_id = ?
           AND credentials.password_hash = ?
           AND account.status = 'active'
         RETURNING token_digest`,
      ).bind(
        sessionTokenDigest,
        timestamp,
        expiresAt,
        testerAssuranceMethod,
        timestamp,
        row.user_id,
        row.password_hash,
      ),
      context.env.DB.prepare(
        `INSERT INTO audit_events (
           operation_id, actor_user_id, actor_ref, action, subject_type,
           subject_id, certification_id, reason, occurred_at
         )
         SELECT ?, user_id, NULL, 'staff_signed_in', 'user', user_id, NULL,
                'Staff signed in through the tester gate', ?
         FROM app_sessions
         WHERE token_digest = ?
         RETURNING operation_id`,
      ).bind(operationId, timestamp, sessionTokenDigest),
    ]);
    if (!results.every((result) => result.meta.changes === 1)) {
      return errorResponse(context, 401, "invalid_credentials");
    }

    const secure = new URL(context.req.url).protocol === "https:";
    context.header(
      "Set-Cookie",
      sessionCookie(
        rawSessionToken,
        staffSessionLifetimeMs / 1000,
        secure,
        secure ? STAGING_SESSION_COOKIE : LEGACY_SESSION_COOKIE,
      ),
    );
    return context.json(
      staffSignInResponseSchema.parse({ redirectTo: "/admin/question-editor" }),
    );
  });

  api.get("/session", async (context) => {
    const configuration = readConfiguration(context.env);
    if (!configuration) return errorResponse(context, 503, "service_unavailable");
    const rawToken = sessionCookieToken(context.req.header("Cookie") ?? null);
    if (!rawToken) return errorResponse(context, 401, "unauthenticated");
    const tokenDigest = await sessionDigest(rawToken);
    const authorization = await authorizeStaffSession(
      context.env.DB,
      tokenDigest,
      now(),
      configuration.policy,
    );
    if (!authorization.allowed) {
      return errorResponse(context, 403, authorization.reason);
    }
    return context.json(
      staffSessionResponseSchema.parse({
        userId: authorization.userId,
        role: authorization.role,
        certifications: await listStaffCertifications(
          context.env.DB,
          authorization.userId,
          authorization.role,
        ),
      }),
    );
  });

  return api;
}
