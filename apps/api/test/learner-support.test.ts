import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/index.ts";
import { localPasswordIssuer } from "../src/local-learner-auth.ts";
import type { SecurityDatabase } from "../src/security/database.ts";
import { hashLearnerPassword } from "../src/security/password-hashing.ts";
import { createTestSessionCredentials } from "./factories.ts";
import { createTestIdentity, grantTestRole } from "./factories.ts";

const database: SecurityDatabase = env.DB;
const origin = "https://localhost";
const csrfSecret = "local-worker-test-csrf-secret-with-enough-entropy";
const rateLimitSecret =
  "local-worker-test-rate-limit-secret-with-enough-entropy";
const testerIps = Array.from({ length: 40 }, (_, index) => `203.0.113.${index + 10}`);
const testerIp = testerIps[0]!;

const clock = Date.now();
const application = createApi(fetch, () => clock);

const bindings = {
  DB: database,
  PUBLIC_SITE_ORIGIN: origin,
  CSRF_HMAC_SECRET: csrfSecret,
  LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET: rateLimitSecret,
  LOCAL_LEARNER_AUTH_ENABLED: "false",
  LOCAL_TEST_MAIL_ENABLED: "false",
  STAFF_MFA_MAX_AGE_MS: "900000",
  STAFF_MFA_ALLOWED_METHODS: "tester-gate",
  ADMIN_TESTER_IPS: testerIps.join(","),
  ADMIN_TESTER_ASSURANCE: "true",
};

function url(path: string): string {
  return `${origin}/api${path}`;
}

function uniqueEmail(label: string): string {
  return `${label}-${crypto.randomUUID()}@example.test`;
}

interface StaffActor {
  userId: string;
  cookie: string;
  token: string;
}

async function staffActor(role: "global_admin" | "manager"): Promise<StaffActor> {
  const identity = await createTestIdentity(database);
  await grantTestRole(database, identity.userId, role);
  const { rawToken } = await createTestSessionCredentials(
    database,
    identity.userId,
    {
      now: clock,
      expiresAt: clock + 6 * 60 * 60 * 1000,
      mfaMethod: "tester-gate",
    },
  );
  const response = await application.fetch(
    new Request(url("/admin/csrf"), {
      headers: { Cookie: `certpath_session=${rawToken}`, "CF-Connecting-IP": testerIp },
    }),
    bindings,
  );
  expect(response.status).toBe(200);
  const token = ((await response.json()) as { csrfToken: string }).csrfToken;
  return { userId: identity.userId, cookie: rawToken, token };
}

interface RequestOptions {
  cookie?: string;
  token?: string;
  body?: unknown;
  origin?: string | null;
  databaseOverride?: SecurityDatabase;
  ip?: string;
}

async function adminRequest(
  method: "GET" | "POST",
  path: string,
  options: RequestOptions = {},
) {
  const headers: Record<string, string> = {
    Origin: options.origin === undefined ? origin : (options.origin ?? ""),
    "CF-Connecting-IP": options.ip ?? testerIp,
  };
  if (options.cookie) headers.Cookie = `certpath_session=${options.cookie}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers["X-CSRF-Token"] = options.token;
  if (options.origin === null) delete headers.Origin;
  return application.fetch(
    new Request(url(path), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    options.databaseOverride
      ? { ...bindings, DB: options.databaseOverride }
      : bindings,
  );
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}

async function auditRows(learnerId: string, action?: string): Promise<number> {
  const row = await database
    .prepare(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE subject_type = 'user' AND subject_id = ?
       ${action ? "AND action = ?" : ""}`,
    )
    .bind(...(action ? [learnerId, action] : [learnerId]))
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function learnerCount(): Promise<number> {
  const row = await database
    .prepare("SELECT COUNT(*) AS count FROM users")
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function credentialCount(learnerId?: string): Promise<number> {
  const row = learnerId
    ? await database
        .prepare(
          "SELECT COUNT(*) AS count FROM learner_password_credentials WHERE user_id = ?",
        )
        .bind(learnerId)
        .first<{ count: number }>()
    : await database
        .prepare("SELECT COUNT(*) AS count FROM learner_password_credentials")
        .first<{ count: number }>();
  return row?.count ?? 0;
}

async function createLearner(
  options: { status?: "active" | "disabled" } = {},
): Promise<string> {
  const userId = crypto.randomUUID();
  await database
    .prepare("INSERT INTO users (id, status, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(userId, options.status ?? "active", clock, clock)
    .run();
  return userId;
}

async function createLedger(
  options: {
    status?: "active" | "disabled";
    email?: string;
    verified?: boolean;
  } = {},
): Promise<{ userId: string; email: string }> {
  const userId = await createLearner({ status: options.status });
  const email = (options.email ?? uniqueEmail("learner")).toLowerCase();
  await database
    .prepare(
      `INSERT INTO learner_password_credentials (
         user_id, email, email_normalized, subject, password_hash,
         email_verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      userId,
      email,
      email,
      crypto.randomUUID(),
      options.verified ? "b".repeat(90) : null,
      options.verified ? clock : null,
      clock,
      clock,
    )
    .run();
  return { userId, email };
}

async function createInviteOnly(
  options: {
    status?: "active" | "disabled";
    email?: string;
    revokedAt?: number | null;
  } = {},
): Promise<{ userId: string; email: string }> {
  const userId = await createLearner({ status: options.status });
  const email = (options.email ?? uniqueEmail("invite")).toLowerCase();
  await database
    .prepare(
      `INSERT INTO learner_email_sign_in_invites (
         email_normalized, user_id, created_at, revoked_at
       ) VALUES (?, ?, ?, ?)`,
    )
    .bind(email, userId, clock, options.revokedAt ?? null)
    .run();
  return { userId, email };
}

const unknownLearnerId = "00000000-0000-0000-0000-000000000000";

/** A live single-use link token for an existing invite, as issued by `0011`. */
async function createSignInToken(
  userId: string,
  inviteEmail: string,
): Promise<string> {
  const tokenDigest = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  await database
    .prepare(
      `INSERT INTO learner_email_sign_in_tokens (
         token_digest, invite_email, user_id, created_at, expires_at,
         consumed_at, consumed_operation_id
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .bind(tokenDigest, inviteEmail, userId, clock, clock + 15 * 60 * 1000)
    .run();
  return tokenDigest;
}

async function inviteState(
  userId: string,
): Promise<{ email: string; revokedAt: number | null } | null> {
  const row = await database
    .prepare(
      `SELECT email_normalized, revoked_at FROM learner_email_sign_in_invites
       WHERE user_id = ?`,
    )
    .bind(userId)
    .first<{ email_normalized: string; revoked_at: number | null }>();
  return row
    ? { email: row.email_normalized, revokedAt: row.revoked_at }
    : null;
}

async function tokenState(tokenDigest: string): Promise<number | null> {
  const row = await database
    .prepare(
      "SELECT consumed_at FROM learner_email_sign_in_tokens WHERE token_digest = ?",
    )
    .bind(tokenDigest)
    .first<{ consumed_at: number | null }>();
  return row?.consumed_at ?? null;
}

/**
 * A learner who can actually sign in with a password through the local proof:
 * a real scrypt hash, a verified address, and the local identity the sign-in
 * route joins on.
 */
async function createPasswordLearner(
  password: string,
): Promise<{ userId: string; email: string }> {
  const userId = await createLearner();
  const email = uniqueEmail("signin").toLowerCase();
  const subject = crypto.randomUUID();
  await database
    .prepare(
      "INSERT INTO auth_identities (issuer, subject, user_id, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(localPasswordIssuer, subject, userId, clock)
    .run();
  await database
    .prepare(
      `INSERT INTO learner_password_credentials (
         user_id, email, email_normalized, subject, password_hash,
         email_verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      userId,
      email,
      email,
      subject,
      await hashLearnerPassword(password),
      clock,
      clock,
      clock,
    )
    .run();
  return { userId, email };
}

function signIn(email: string, password: string, ip: string) {
  return application.fetch(
    new Request(url("/auth/local/sign-in"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "CF-Connecting-IP": ip,
      },
      body: JSON.stringify({ email, password }),
    }),
    {
      ...bindings,
      LOCAL_LEARNER_AUTH_ENABLED: "true",
      LOCAL_TEST_MAIL_ENABLED: "true",
    },
  );
}

function learnerRoutes(learnerId: string) {
  return [
    { method: "GET" as const, path: "/admin/csrf" },
    { method: "GET" as const, path: "/admin/capabilities" },
    {
      method: "POST" as const,
      path: "/admin/learners/lookup",
      body: { email: "someone@example.test" },
    },
    { method: "GET" as const, path: `/admin/learners/${learnerId}` },
    {
      method: "POST" as const,
      path: `/admin/learners/${learnerId}/contact-reveal`,
      body: {},
    },
    {
      method: "POST" as const,
      path: `/admin/learners/${learnerId}/deactivate`,
      body: { reason: "Support request" },
    },
    {
      method: "POST" as const,
      path: `/admin/learners/${learnerId}/contact`,
      body: { email: "new@example.test", reason: "Support request" },
    },
    {
      method: "POST" as const,
      path: `/admin/learners/${learnerId}/password-reset`,
      body: {},
    },
    {
      method: "POST" as const,
      path: `/admin/learners/${learnerId}/resend-verification`,
      body: {},
    },
    { method: "GET" as const, path: `/admin/learners/${learnerId}/support-history` },
  ];
}

describe("admin learner support", () => {
  it("refuses anonymous and learner sessions on every route", async () => {
    const learner = await createLedger();
    const { rawToken: learnerCookie } = await createTestSessionCredentials(
      database,
      learner.userId,
      { now: clock, expiresAt: clock + 6 * 60 * 60 * 1000 },
    );

    for (const route of learnerRoutes(learner.userId)) {
      const anonymous = await adminRequest(route.method, route.path, {
        body: route.body,
        token: "placeholder",
      });
      expect([route.path, anonymous.status]).toEqual([route.path, 401]);

      const asLearner = await adminRequest(route.method, route.path, {
        body: route.body,
        cookie: learnerCookie,
        token: "placeholder",
      });
      expect([route.path, asLearner.status]).toEqual([route.path, 401]);
      expect(await errorCode(asLearner)).toBe("unauthenticated");
    }
  });

  it("reports the capability list of the signed-in role", async () => {
    const manager = await staffActor("manager");
    const managerResponse = await adminRequest("GET", "/admin/capabilities", {
      cookie: manager.cookie,
    });
    expect(managerResponse.status).toBe(200);
    const managerBody = (await managerResponse.json()) as {
      role: string;
      capabilities: string[];
    };
    expect(managerBody.role).toBe("manager");
    expect(managerBody.capabilities).toContain("learner.lookup");
    for (const denied of [
      "commerce.read",
      "access.grant",
      "staff.manage",
      "security.manage",
      "audit.read",
    ]) {
      expect(managerBody.capabilities).not.toContain(denied);
    }

    const admin = await staffActor("global_admin");
    const adminResponse = await adminRequest("GET", "/admin/capabilities", {
      cookie: admin.cookie,
    });
    expect(adminResponse.status).toBe(200);
    const adminBody = (await adminResponse.json()) as {
      capabilities: string[];
    };
    expect(adminBody.capabilities).toContain("audit.read");
  });

  it("masks contact data and never returns the address for a lookup", async () => {
    const admin = await staffActor("global_admin");
    const learner = await createLedger();

    const byEmail = await adminRequest("POST", "/admin/learners/lookup", {
      cookie: admin.cookie,
      token: admin.token,
      body: { email: learner.email.toUpperCase() },
    });
    expect(byEmail.status).toBe(200);
    const byEmailBody = (await byEmail.json()) as {
      items: Array<{ userId: string; maskedContact: string; accountStatus: string }>;
    };
    expect(byEmailBody.items).toHaveLength(1);
    expect(byEmailBody.items[0]!.userId).toBe(learner.userId);
    expect(byEmailBody.items[0]!.maskedContact).toBe("l***@e***.test");
    expect(byEmailBody.items[0]!.accountStatus).toBe("active");
    expect(JSON.stringify(byEmailBody)).not.toContain(learner.email.toLowerCase());
    expect(JSON.stringify(byEmailBody)).not.toContain(
      learner.email.split("@")[0]!.toLowerCase(),
    );

    const byId = await adminRequest("POST", "/admin/learners/lookup", {
      cookie: admin.cookie,
      token: admin.token,
      body: { userId: learner.userId },
    });
    expect(byId.status).toBe(200);
    expect(
      ((await byId.json()) as { items: Array<{ userId: string }> }).items[0]!.userId,
    ).toBe(learner.userId);

    const manager = await staffActor("manager");
    const asManager = await adminRequest("POST", "/admin/learners/lookup", {
      cookie: manager.cookie,
      token: manager.token,
      body: { email: learner.email },
    });
    expect(asManager.status).toBe(200);
  });

  it("rejects ambiguous or malformed lookups without auditing", async () => {
    const admin = await staffActor("global_admin");
    const learner = await createLedger();

    for (const body of [
      { email: learner.email, userId: learner.userId },
      {},
      { email: "not-an-address" },
      { email: `${"x".repeat(250)}@example.test` },
      { unknown: true },
    ]) {
      const response = await adminRequest("POST", "/admin/learners/lookup", {
        cookie: admin.cookie,
        token: admin.token,
        body,
      });
      expect([JSON.stringify(body), response.status]).toEqual([
        JSON.stringify(body),
        400,
      ]);
    }
    expect(await auditRows(learner.userId)).toBe(0);
  });

  it("refuses a lookup without CSRF or with a foreign origin and writes nothing", async () => {
    const admin = await staffActor("global_admin");
    const learner = await createLedger();

    const noCsrf = await adminRequest("POST", "/admin/learners/lookup", {
      cookie: admin.cookie,
      body: { email: learner.email },
    });
    expect(noCsrf.status).toBe(400);
    expect(await errorCode(noCsrf)).toBe("invalid_csrf");

    const foreignOrigin = await adminRequest("POST", "/admin/learners/lookup", {
      cookie: admin.cookie,
      token: admin.token,
      origin: "https://attacker.example",
      body: { email: learner.email },
    });
    expect(foreignOrigin.status).toBe(400);
    expect(await errorCode(foreignOrigin)).toBe("invalid_origin");
    expect(await auditRows(learner.userId)).toBe(0);
  });

  it("audits every view and returns an empty list without an audit row", async () => {
    const admin = await staffActor("global_admin");
    const learner = await createLedger();

    const missing = await adminRequest("POST", "/admin/learners/lookup", {
      cookie: admin.cookie,
      token: admin.token,
      body: { email: uniqueEmail("nobody") },
    });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ items: [] });
    expect(await auditRows(learner.userId)).toBe(0);

    await adminRequest("POST", "/admin/learners/lookup", {
      cookie: admin.cookie,
      token: admin.token,
      body: { email: learner.email },
    });
    expect(await auditRows(learner.userId, "learner_record_viewed")).toBe(1);
    const record = await adminRequest("GET", `/admin/learners/${learner.userId}`, {
      cookie: admin.cookie,
    });
    expect(record.status).toBe(200);
    expect(await auditRows(learner.userId, "learner_record_viewed")).toBe(2);
  });

  it("returns 404 for a missing learner and for a staff subject", async () => {
    const admin = await staffActor("global_admin");
    const missing = await adminRequest("GET", `/admin/learners/${unknownLearnerId}`, {
      cookie: admin.cookie,
    });
    expect(missing.status).toBe(404);

    const staffSubject = await createLedger();
    await grantTestRole(database, staffSubject.userId, "manager");
    const asStaff = await adminRequest(
      "GET",
      `/admin/learners/${staffSubject.userId}`,
      { cookie: admin.cookie },
    );
    expect(asStaff.status).toBe(404);
    expect(await auditRows(staffSubject.userId)).toBe(0);
  }, 30_000);

  it("reveals the stored address exactly once and records field names only", async () => {
    const admin = await staffActor("global_admin");
    const learner = await createLedger();
    const revealed = await adminRequest(
      "POST",
      `/admin/learners/${learner.userId}/contact-reveal`,
      { cookie: admin.cookie, token: admin.token, body: {} },
    );
    expect(revealed.status).toBe(200);
    const body = (await revealed.json()) as {
      email: string;
      contactKind: string;
      operationId: string;
    };
    expect(body.email).toBe(learner.email);
    expect(body.contactKind).toBe("password-credential");

    const row = await database
      .prepare(
        `SELECT details_json, reason, actor_user_id, subject_id
         FROM audit_events WHERE operation_id = ?`,
      )
      .bind(body.operationId)
      .first<{
        details_json: string;
        reason: string;
        actor_user_id: string;
        subject_id: string;
      }>();
    expect(JSON.parse(row!.details_json)).toEqual({ fields: ["email"] });
    expect(row?.subject_id).toBe(learner.userId);
    expect(row?.actor_user_id).toBe(admin.userId);

    const serialised = await database
      .prepare(
        `SELECT COALESCE(operation_id, '') || '|' || COALESCE(actor_ref, '') ||
                '|' || COALESCE(action, '') || '|' ||
                COALESCE(subject_type, '') || '|' || COALESCE(subject_id, '') ||
                '|' || COALESCE(reason, '') || '|' ||
                COALESCE(details_json, '') AS joined
         FROM audit_events WHERE subject_id = ?`,
      )
      .bind(learner.userId)
      .all<{ joined: string }>();
    for (const entry of serialised.results) {
      expect(entry.joined).not.toContain(learner.email.toLowerCase());
    }
  });

  it("reveals an invite address and refuses a reveal with no contact", async () => {
    const admin = await staffActor("global_admin");
    const invited = await createInviteOnly();
    const revealInvite = await adminRequest(
      "POST",
      `/admin/learners/${invited.userId}/contact-reveal`,
      { cookie: admin.cookie, token: admin.token, body: {} },
    );
    expect(revealInvite.status).toBe(200);
    const inviteBody = (await revealInvite.json()) as {
      email: string;
      contactKind: string;
    };
    expect(inviteBody.email).toBe(invited.email);
    expect(inviteBody.contactKind).toBe("sign-in-invite");

    const noContact = await createLearner();
    const revealNothing = await adminRequest(
      "POST",
      `/admin/learners/${noContact}/contact-reveal`,
      { cookie: admin.cookie, token: admin.token, body: {} },
    );
    expect(revealNothing.status).toBe(409);
    expect(await errorCode(revealNothing)).toBe("contact_not_available");
    expect(await auditRows(noContact)).toBe(0);
  });

  it("refuses a reveal for a staff subject and without CSRF or a matching origin", async () => {
    const admin = await staffActor("global_admin");
    const staffSubject = await createLedger();
    await grantTestRole(database, staffSubject.userId, "global_admin");
    const asStaff = await adminRequest(
      "POST",
      `/admin/learners/${staffSubject.userId}/contact-reveal`,
      { cookie: admin.cookie, token: admin.token, body: {} },
    );
    expect(asStaff.status).toBe(404);
    expect(await auditRows(staffSubject.userId)).toBe(0);

    const learner = await createLedger();
    const noCsrf = await adminRequest(
      "POST",
      `/admin/learners/${learner.userId}/contact-reveal`,
      { cookie: admin.cookie, body: {} },
    );
    expect(noCsrf.status).toBe(400);
    expect(await errorCode(noCsrf)).toBe("invalid_csrf");

    const foreignOrigin = await adminRequest(
      "POST",
      `/admin/learners/${learner.userId}/contact-reveal`,
      {
        cookie: admin.cookie,
        token: admin.token,
        origin: "https://attacker.example",
        body: {},
      },
    );
    expect(foreignOrigin.status).toBe(400);
    expect(await errorCode(foreignOrigin)).toBe("invalid_origin");
    expect(await auditRows(learner.userId)).toBe(0);
  });

  it("deactivates once, audits once, and refuses a second attempt", async () => {
    const admin = await staffActor("global_admin");
    const learner = await createLedger();
    const { rawToken: learnerCookie } = await createTestSessionCredentials(
      database,
      learner.userId,
      { now: clock, expiresAt: clock + 6 * 60 * 60 * 1000 },
    );
    expect(
      (
        await application.fetch(
          new Request(url("/practice/dashboard"), {
            headers: { Cookie: `certpath_session=${learnerCookie}` },
          }),
          bindings,
        )
      ).status,
    ).toBe(200);

    const applied = await adminRequest(
      "POST",
      `/admin/learners/${learner.userId}/deactivate`,
      {
        cookie: admin.cookie,
        token: admin.token,
        body: { reason: "Learner asked to close the account" },
      },
    );
    expect(applied.status).toBe(200);
    const body = (await applied.json()) as {
      accountStatus: string;
      operationId: string;
    };
    expect(body.accountStatus).toBe("deactivated");

    const row = await database
      .prepare(
        "SELECT status, deactivation_operation_id FROM users WHERE id = ?",
      )
      .bind(learner.userId)
      .first<{ status: string; deactivation_operation_id: string }>();
    expect(row?.status).toBe("disabled");
    expect(row?.deactivation_operation_id).toBe(body.operationId);
    expect(await auditRows(learner.userId, "learner_deactivated")).toBe(1);

    const repeated = await adminRequest(
      "POST",
      `/admin/learners/${learner.userId}/deactivate`,
      {
        cookie: admin.cookie,
        token: admin.token,
        body: { reason: "Second attempt" },
      },
    );
    expect(repeated.status).toBe(409);
    expect(await errorCode(repeated)).toBe("already_deactivated");
    expect(await auditRows(learner.userId, "learner_deactivated")).toBe(1);

    expect(
      (
        await application.fetch(
          new Request(url("/practice/dashboard"), {
            headers: { Cookie: `certpath_session=${learnerCookie}` },
          }),
          bindings,
        )
      ).status,
    ).toBe(401);

    const credentialsBefore = await credentialCount();
    const usersBefore = await learnerCount();
    const registered = await adminRequest("POST", "/auth/local/register", {
      body: { email: learner.email },
      origin,
    });
    // Local auth is off in this fixture, so re-registration cannot create a row.
    expect([202, 503]).toContain(registered.status);
    expect(await credentialCount()).toBe(credentialsBefore);
    expect(await learnerCount()).toBe(usersBefore);
  });

  it("refuses a deactivation of a staff subject and a reason containing an address", async () => {
    const admin = await staffActor("global_admin");
    const staffSubject = await createLedger();
    await grantTestRole(database, staffSubject.userId, "manager");
    const asStaff = await adminRequest(
      "POST",
      `/admin/learners/${staffSubject.userId}/deactivate`,
      {
        cookie: admin.cookie,
        token: admin.token,
        body: { reason: "Support request" },
      },
    );
    expect(asStaff.status).toBe(404);
    expect(await auditRows(staffSubject.userId)).toBe(0);

    const learner = await createLedger();
    const withAddress = await adminRequest(
      "POST",
      `/admin/learners/${learner.userId}/deactivate`,
      {
        cookie: admin.cookie,
        token: admin.token,
        body: { reason: `Contact ${learner.email} for details` },
      },
    );
    expect(withAddress.status).toBe(400);
    expect(await auditRows(learner.userId)).toBe(0);
  });

  it("corrects a contact address and audits it once", async () => {
    const admin = await staffActor("manager");
    const learner = await createLedger();
    const replacement = uniqueEmail("corrected");

    const corrected = await adminRequest(
      "POST",
      `/admin/learners/${learner.userId}/contact`,
      {
        cookie: admin.cookie,
        token: admin.token,
        body: { email: replacement, reason: "Learner changed address" },
      },
    );
    expect(corrected.status).toBe(200);
    const body = (await corrected.json()) as {
      maskedContact: string;
      contactKind: string;
    };
    expect(body.contactKind).toBe("password-credential");
    expect(body.maskedContact).toBe("c***@e***.test");

    const stored = await database
      .prepare(
        "SELECT email_normalized FROM learner_password_credentials WHERE user_id = ?",
      )
      .bind(learner.userId)
      .first<{ email_normalized: string }>();
    expect(stored?.email_normalized).toBe(replacement.toLowerCase());
    expect(await auditRows(learner.userId, "learner_contact_corrected")).toBe(1);

    const unchanged = await adminRequest(
      "POST",
      `/admin/learners/${learner.userId}/contact`,
      {
        cookie: admin.cookie,
        token: admin.token,
        body: { email: replacement, reason: "Same address again" },
      },
    );
    expect(unchanged.status).toBe(409);
    expect(await errorCode(unchanged)).toBe("contact_unchanged");
    expect(await auditRows(learner.userId, "learner_contact_corrected")).toBe(1);
  });

  it("revokes the invite at the old address and its live tokens when a contact is corrected", async () => {
    const admin = await staffActor("global_admin");
    const learner = await createLedger();
    const oldAddress = learner.email;
    await database
      .prepare(
        `INSERT INTO learner_email_sign_in_invites (
           email_normalized, user_id, created_at, revoked_at
         ) VALUES (?, ?, ?, NULL)`,
      )
      .bind(oldAddress, learner.userId, clock)
      .run();
    const firstToken = await createSignInToken(learner.userId, oldAddress);
    const secondToken = await createSignInToken(learner.userId, oldAddress);

    const replacement = uniqueEmail("revoked-invite");
    const corrected = await adminRequest(
      "POST",
      `/admin/learners/${learner.userId}/contact`,
      {
        cookie: admin.cookie,
        token: admin.token,
        body: { email: replacement, reason: "Learner changed address" },
      },
    );
    expect(corrected.status).toBe(200);
    const { operationId } = (await corrected.json()) as { operationId: string };

    // The old address stays as a reserved (revoked) row so re-provisioning stays
    // idempotent, but it is no longer a live sign-in key and the links minted for
    // it are dead.
    const invite = await inviteState(learner.userId);
    expect(invite?.email).toBe(oldAddress);
    expect(invite?.revokedAt).not.toBeNull();
    expect(await tokenState(firstToken)).not.toBeNull();
    expect(await tokenState(secondToken)).not.toBeNull();

    const audit = await database
      .prepare("SELECT details_json FROM audit_events WHERE operation_id = ?")
      .bind(operationId)
      .first<{ details_json: string }>();
    expect(JSON.parse(audit!.details_json)).toEqual({
      fields: ["email"],
      // `learner_email_sign_in_invites.user_id` is unique, so a learner holds at
      // most one invite row and this count is 0 or 1.
      revokedInvites: 1,
    });
    expect(audit!.details_json).not.toContain(oldAddress);
    expect(audit!.details_json).not.toContain(replacement.toLowerCase());
  });

  it("leaves an invite the learner does not hold at the old address alone", async () => {
    const admin = await staffActor("global_admin");
    const learner = await createLedger();
    const bystander = await createInviteOnly();
    const bystanderToken = await createSignInToken(
      bystander.userId,
      bystander.email,
    );

    const corrected = await adminRequest(
      "POST",
      `/admin/learners/${learner.userId}/contact`,
      {
        cookie: admin.cookie,
        token: admin.token,
        body: {
          email: uniqueEmail("no-invite"),
          reason: "Learner changed address",
        },
      },
    );
    expect(corrected.status).toBe(200);
    const { operationId } = (await corrected.json()) as { operationId: string };

    expect(await inviteState(bystander.userId)).toEqual({
      email: bystander.email,
      revokedAt: null,
    });
    expect(await tokenState(bystanderToken)).toBeNull();
    const audit = await database
      .prepare("SELECT details_json FROM audit_events WHERE operation_id = ?")
      .bind(operationId)
      .first<{ details_json: string }>();
    expect(JSON.parse(audit!.details_json)).toEqual({
      fields: ["email"],
      revokedInvites: 0,
    });
  });

  it("refuses a correction onto another learner's invite address and leaves it live", async () => {
    const admin = await staffActor("global_admin");
    const learner = await createLedger();
    const holder = await createInviteOnly();
    const holderToken = await createSignInToken(holder.userId, holder.email);

    // The identity triggers make this address unrepresentable for a second
    // learner; the request must reject rather than silently succeed.
    const response = await adminRequest(
      "POST",
      `/admin/learners/${learner.userId}/contact`,
      {
        cookie: admin.cookie,
        token: admin.token,
        body: { email: holder.email, reason: "Support request" },
      },
    );
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("contact_taken");

    expect(await inviteState(holder.userId)).toEqual({
      email: holder.email,
      revokedAt: null,
    });
    expect(await tokenState(holderToken)).toBeNull();
    const stored = await database
      .prepare(
        "SELECT email_normalized FROM learner_password_credentials WHERE user_id = ?",
      )
      .bind(learner.userId)
      .first<{ email_normalized: string }>();
    expect(stored?.email_normalized).toBe(learner.email);
    expect(await auditRows(learner.userId, "learner_contact_corrected")).toBe(0);
  });

  it("keeps password sign-in working only at the corrected address", async () => {
    const admin = await staffActor("global_admin");
    const password = `synthetic-${crypto.randomUUID()}-learner-password`;
    const learner = await createPasswordLearner(password);
    await database
      .prepare(
        `INSERT INTO learner_email_sign_in_invites (
           email_normalized, user_id, created_at, revoked_at
         ) VALUES (?, ?, ?, NULL)`,
      )
      .bind(learner.email, learner.userId, clock)
      .run();
    const minted = await createSignInToken(learner.userId, learner.email);
    expect(
      (await signIn(learner.email, password, "198.51.100.201")).status,
    ).toBe(200);

    const replacement = uniqueEmail("moved").toLowerCase();
    const corrected = await adminRequest(
      "POST",
      `/admin/learners/${learner.userId}/contact`,
      {
        cookie: admin.cookie,
        token: admin.token,
        body: { email: replacement, reason: "Learner changed address" },
      },
    );
    expect(corrected.status).toBe(200);
    expect((await inviteState(learner.userId))?.revokedAt).not.toBeNull();
    expect(await tokenState(minted)).not.toBeNull();

    expect(
      (await signIn(learner.email, password, "198.51.100.202")).status,
    ).toBe(401);
    expect((await signIn(replacement, password, "198.51.100.203")).status).toBe(
      200,
    );
  }, 60_000);

  it("separates a lost race from a missing learner on both mutations", async () => {
    const admin = await staffActor("global_admin");

    const missingDeactivation = await adminRequest(
      "POST",
      `/admin/learners/${unknownLearnerId}/deactivate`,
      {
        cookie: admin.cookie,
        token: admin.token,
        body: { reason: "Support request" },
      },
    );
    expect(missingDeactivation.status).toBe(404);
    expect(await errorCode(missingDeactivation)).toBe("not_found");
    const missingCorrection = await adminRequest(
      "POST",
      `/admin/learners/${unknownLearnerId}/contact`,
      {
        cookie: admin.cookie,
        token: admin.token,
        body: {
          email: uniqueEmail("missing"),
          reason: "Support request",
        },
      },
    );
    expect(missingCorrection.status).toBe(404);
    expect(await errorCode(missingCorrection)).toBe("not_found");

    // Losing a deactivation race: the account is disabled between the route's
    // pre-check and its batch, so the guarded update matches no row.
    const racer = await createLedger();
    const deactivationRace: SecurityDatabase = {
      prepare: (query) => database.prepare(query),
      withSession: (constraint) => database.withSession(constraint),
      batch: async (statements) => {
        await database
          .prepare(
            `UPDATE users SET status = 'disabled', deactivation_operation_id = ?
             WHERE id = ?`,
          )
          .bind("race-probe", racer.userId)
          .run();
        return database.batch(statements);
      },
    };
    const racedDeactivation = await adminRequest(
      "POST",
      `/admin/learners/${racer.userId}/deactivate`,
      {
        cookie: admin.cookie,
        token: admin.token,
        body: { reason: "Support request" },
        databaseOverride: deactivationRace,
      },
    );
    expect(racedDeactivation.status).toBe(409);
    expect(await errorCode(racedDeactivation)).toBe("conflict");
    expect(await auditRows(racer.userId, "learner_deactivated")).toBe(0);

    // Losing a correction race: another writer already moved the address to the
    // requested value, so the guarded update matches no row and nothing is
    // revoked.
    const target = await createLedger();
    const replacement = uniqueEmail("raced").toLowerCase();
    const correctionRace: SecurityDatabase = {
      prepare: (query) => database.prepare(query),
      withSession: (constraint) => database.withSession(constraint),
      batch: async (statements) => {
        await database
          .prepare(
            `UPDATE learner_password_credentials
             SET email = ?, email_normalized = ?, updated_at = ?
             WHERE user_id = ?`,
          )
          .bind(replacement, replacement, clock, target.userId)
          .run();
        return database.batch(statements);
      },
    };
    const racedCorrection = await adminRequest(
      "POST",
      `/admin/learners/${target.userId}/contact`,
      {
        cookie: admin.cookie,
        token: admin.token,
        body: { email: replacement, reason: "Support request" },
        databaseOverride: correctionRace,
      },
    );
    expect(racedCorrection.status).toBe(409);
    expect(await errorCode(racedCorrection)).toBe("conflict");
    expect(await auditRows(target.userId, "learner_contact_corrected")).toBe(0);
  });

  it("returns the same 409 for every contact collision and writes nothing", async () => {
    const admin = await staffActor("global_admin");
    const target = await createLedger();
    const bodies: Array<{ label: string; address: string }> = [];

    const inviteHolder = await createInviteOnly();
    bodies.push({ label: "invite holder", address: inviteHolder.email });
    const credentialHolder = await createLedger();
    bodies.push({ label: "credential holder", address: credentialHolder.email });
    const disabledHolder = await createLedger({ status: "disabled" });
    bodies.push({ label: "disabled holder", address: disabledHolder.email });
    const revokedInvite = await createInviteOnly({ revokedAt: clock });
    bodies.push({ label: "revoked invite", address: revokedInvite.email });

    const serialised: string[] = [];
    for (const candidate of bodies) {
      const response = await adminRequest(
        "POST",
        `/admin/learners/${target.userId}/contact`,
        {
          cookie: admin.cookie,
          token: admin.token,
          body: { email: candidate.address, reason: "Support request" },
        },
      );
      expect([candidate.label, response.status]).toEqual([candidate.label, 409]);
      const parsed = (await response.json()) as {
        error: { code: string; requestId: string };
      };
      expect(parsed.error.code).toBe("contact_taken");
      // Destructure the per-request id out of the whole parsed body and compare
      // everything that remains. Serialising only the fields this test chose to
      // read would pass even if the response carried a distinguishing field.
      const { requestId: _requestId, ...rest } = parsed.error;
      expect(rest).toEqual({ code: "contact_taken" });
      serialised.push(JSON.stringify(rest));
    }
    expect(new Set(serialised).size).toBe(1);
    expect(await auditRows(target.userId, "learner_contact_corrected")).toBe(0);
  });

  it("allows one learner's own address in both tables and still corrects it", async () => {
    const admin = await staffActor("global_admin");
    const learner = await createLedger();
    await database
      .prepare(
        `INSERT INTO learner_email_sign_in_invites (
           email_normalized, user_id, created_at, revoked_at
         ) VALUES (?, ?, ?, NULL)`,
      )
      .bind(learner.email, learner.userId, clock)
      .run();

    const replacement = uniqueEmail("own-address");
    const corrected = await adminRequest(
      "POST",
      `/admin/learners/${learner.userId}/contact`,
      {
        cookie: admin.cookie,
        token: admin.token,
        body: { email: replacement, reason: "Learner changed address" },
      },
    );
    expect(corrected.status).toBe(200);
    expect(await auditRows(learner.userId, "learner_contact_corrected")).toBe(1);

    const invite = await database
      .prepare(
        "SELECT email_normalized FROM learner_email_sign_in_invites WHERE user_id = ?",
      )
      .bind(learner.userId)
      .first<{ email_normalized: string }>();
    expect(invite?.email_normalized).toBe(learner.email);
  });

  it("maps a storage rejection to 409 and any other D1 failure to 503", async () => {
    const admin = await staffActor("global_admin");
    const learner = await createLedger();
    const replacement = uniqueEmail("storage-map");

    const identityAbort: SecurityDatabase = {
      prepare: (query) => database.prepare(query),
      withSession: (constraint) => database.withSession(constraint),
      batch: async () => {
        throw new Error(
          "D1_ERROR: a contact address may identify only one learner",
        );
      },
    };
    const mapped = await adminRequest(
      "POST",
      `/admin/learners/${learner.userId}/contact`,
      {
        cookie: admin.cookie,
        token: admin.token,
        body: { email: replacement, reason: "Support request" },
        databaseOverride: identityAbort,
      },
    );
    expect(mapped.status).toBe(409);
    expect(await errorCode(mapped)).toBe("contact_taken");

    const otherFailure: SecurityDatabase = {
      prepare: (query) => database.prepare(query),
      withSession: (constraint) => database.withSession(constraint),
      batch: async () => {
        throw new Error("D1_ERROR: database is locked");
      },
    };
    const unavailable = await adminRequest(
      "POST",
      `/admin/learners/${learner.userId}/contact`,
      {
        cookie: admin.cookie,
        token: admin.token,
        body: { email: replacement, reason: "Support request" },
        databaseOverride: otherFailure,
      },
    );
    expect(unavailable.status).toBe(503);
    expect(await errorCode(unavailable)).toBe("service_unavailable");
    expect(await auditRows(learner.userId, "learner_contact_corrected")).toBe(0);
  });

  it("refuses contact correction for an invite-only account", async () => {
    const admin = await staffActor("global_admin");
    const invited = await createInviteOnly();
    const response = await adminRequest(
      "POST",
      `/admin/learners/${invited.userId}/contact`,
      {
        cookie: admin.cookie,
        token: admin.token,
        body: { email: uniqueEmail("invite-only"), reason: "Support request" },
      },
    );
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("contact_not_correctable");
    expect(await auditRows(invited.userId)).toBe(0);
  });

  it("answers the email actions honestly: verified resend is already_verified", async () => {
    const admin = await staffActor("global_admin");
    const verified = await createLedger({ verified: true });
    const unverified = await createLedger();
    const tokensBefore = await database
      .prepare("SELECT COUNT(*) AS count FROM learner_auth_tokens")
      .first<{ count: number }>();

    const asPost = (learnerId: string, action: string) =>
      adminRequest("POST", `/admin/learners/${learnerId}/${action}`, {
        cookie: admin.cookie,
        token: admin.token,
        body: {},
      });

    // A reset has no pre-condition on verification: the transport gate decides.
    const reset = await asPost(verified.userId, "password-reset");
    expect(reset.status).toBe(409);
    expect(await errorCode(reset)).toBe("email_unavailable");

    // A verified account needs no verification mail, and that refusal is decided
    // before the transport gate, so it is reachable while email is off.
    const resendVerified = await asPost(verified.userId, "resend-verification");
    expect(resendVerified.status).toBe(409);
    expect(await errorCode(resendVerified)).toBe("already_verified");

    const resendUnverified = await asPost(
      unverified.userId,
      "resend-verification",
    );
    expect(resendUnverified.status).toBe(409);
    expect(await errorCode(resendUnverified)).toBe("email_unavailable");

    const tokensAfter = await database
      .prepare("SELECT COUNT(*) AS count FROM learner_auth_tokens")
      .first<{ count: number }>();
    expect(tokensAfter?.count).toBe(tokensBefore?.count);
    expect(await auditRows(verified.userId)).toBe(0);
    expect(await auditRows(unverified.userId)).toBe(0);
  });

  it("shows support history by role only and audits its own read", async () => {
    const admin = await staffActor("global_admin");
    const learner = await createLedger();

    await adminRequest("POST", "/admin/learners/lookup", {
      cookie: admin.cookie,
      token: admin.token,
      body: { email: learner.email },
    });
    await adminRequest("POST", `/admin/learners/${learner.userId}/contact-reveal`, {
      cookie: admin.cookie,
      token: admin.token,
      body: {},
    });

    const history = await adminRequest(
      "GET",
      `/admin/learners/${learner.userId}/support-history`,
      { cookie: admin.cookie },
    );
    expect(history.status).toBe(200);
    const body = (await history.json()) as {
      items: Array<{
        action: string;
        actor: string;
        occurredAt: number;
        operationId: string;
      }>;
      nextCursor: string | null;
    };
    expect(body.items.map((item) => item.action)).toEqual([
      "learner_contact_revealed",
      "learner_record_viewed",
    ]);
    for (const item of body.items) {
      expect(item.actor).toBe("global_admin");
    }
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain(admin.userId);
    expect(serialised).not.toContain(learner.email.toLowerCase());
    expect(await auditRows(learner.userId, "learner_support_history_viewed")).toBe(1);

    const second = await adminRequest(
      "GET",
      `/admin/learners/${learner.userId}/support-history`,
      { cookie: admin.cookie },
    );
    const secondBody = (await second.json()) as {
      items: Array<{ action: string }>;
    };
    expect(secondBody.items.map((item) => item.action)).toContain(
      "learner_support_history_viewed",
    );
  });

  it("never returns an address from any learner endpoint except the reveal", async () => {
    const admin = await staffActor("manager");
    const learner = await createLedger();
    const local = learner.email.split("@")[0]!.toLowerCase();

    const responses = [
      {
        response: await adminRequest("GET", `/admin/learners/${learner.userId}`, {
          cookie: admin.cookie,
        }),
        status: 200,
      },
      {
        response: await adminRequest("POST", "/admin/learners/lookup", {
          cookie: admin.cookie,
          token: admin.token,
          body: { email: learner.email },
        }),
        status: 200,
      },
      {
        response: await adminRequest(
          "GET",
          `/admin/learners/${learner.userId}/support-history`,
          { cookie: admin.cookie },
        ),
        status: 200,
      },
      {
        // A Manager may deactivate a learner with no certification assignment at
        // all: learner support is platform-wide.
        response: await adminRequest(
          "POST",
          `/admin/learners/${learner.userId}/deactivate`,
          {
            cookie: admin.cookie,
            token: admin.token,
            body: { reason: "PII sweep" },
          },
        ),
        status: 200,
      },
      {
        response: await adminRequest(
          "POST",
          `/admin/learners/${learner.userId}/password-reset`,
          { cookie: admin.cookie, token: admin.token, body: {} },
        ),
        status: 409,
      },
    ];

    for (const entry of responses) {
      const text = await entry.response.text();
      expect(entry.response.status).toBe(entry.status);
      expect(text).not.toContain(learner.email.toLowerCase());
      expect(text).not.toContain(local);
    }
  });

  it("keeps a registration of an invited address silent and account-free", async () => {
    const invited = await createInviteOnly();
    const usersBefore = await learnerCount();
    const localBindings = {
      ...bindings,
      LOCAL_LEARNER_AUTH_ENABLED: "true",
      LOCAL_TEST_MAIL_ENABLED: "true",
    };

    const registered = await application.fetch(
      new Request(url("/auth/local/register"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          "CF-Connecting-IP": testerIp,
        },
        body: JSON.stringify({ email: invited.email }),
      }),
      localBindings,
    );
    expect(registered.status).toBe(202);
    expect(await credentialCount(invited.userId)).toBe(0);
    expect(await learnerCount()).toBe(usersBefore);

    const inbox = await application.fetch(
      new Request(
        `${url("/auth/local/test-inbox")}?${new URLSearchParams({
          email: invited.email,
        })}`,
      ),
      localBindings,
    );
    expect(inbox.status).toBe(200);
    expect((await inbox.json()) as { messages: unknown[] }).toEqual({
      messages: [],
    });
  });
});
