import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/index.ts";
import { adminTesterGate } from "../src/security/admin-gate.ts";
import type { SecurityDatabase } from "../src/security/database.ts";
import { hashLearnerPassword } from "../src/security/password-hashing.ts";
import { createTotpSeed, readSealKey, sealTotpSeed, totpCodeAt, totpStepAt } from "../src/security/totp.ts";
import { createContentScope, validQuestionContent } from "./content-fixtures.ts";
import { createTestIdentity, grantTestRole } from "./factories.ts";

const database: SecurityDatabase = env.DB;
const origin = "https://localhost";
const csrfSecret = "local-worker-test-csrf-secret-with-enough-entropy";
const staffRateSecret =
  "local-worker-test-staff-rate-limit-secret-with-enough-entropy";
const sealKey = "local-worker-test-staff-mfa-seal-key-with-enough-entropy";
const testerIps = Array.from({ length: 200 }, (_, index) => `203.0.113.${index + 10}`);
const testerIp = testerIps[0]!;
let ipIndex = 0;

function nextIp(): string {
  const ip = testerIps[ipIndex % testerIps.length]!;
  ipIndex += 1;
  return ip;
}
const staffPassword = "synthetic-tester-password-with-enough-length";

let clock = Date.now();
const application = createApi(fetch, () => clock);

const bindings = {
  DB: database,
  PUBLIC_SITE_ORIGIN: origin,
  CSRF_HMAC_SECRET: csrfSecret,
  STAFF_RATE_LIMIT_HMAC_SECRET: staffRateSecret,
  // Owner decision, 18 November 2026: one verification per session, 8 h.
  STAFF_MFA_MAX_AGE_MS: String(8 * 60 * 60 * 1000),
  STAFF_MFA_ALLOWED_METHODS: "totp",
  STAFF_MFA_SEAL_KEY: sealKey,
  ADMIN_TESTER_IPS: testerIps.join(","),
};

let passwordHash = "";

beforeAll(async () => {
  passwordHash = await hashLearnerPassword(staffPassword);
});

function url(path: string): string {
  return `${origin}/api${path}`;
}

async function provisionStaff(
  role: "global_admin" | "manager",
  email: string,
): Promise<string> {
  const identity = await createTestIdentity(database);
  await grantTestRole(database, identity.userId, role);
  await database
    .prepare(
      `INSERT INTO staff_password_credentials (
         user_id, email, email_normalized, password_hash, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(identity.userId, email, email, passwordHash, clock, clock)
    .run();
  return identity.userId;
}

async function signIn(
  email: string,
  options: {
    password?: string;
    ip?: string;
    bindingsOverride?: Record<string, unknown>;
    originHeader?: string | null;
  } = {},
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "CF-Connecting-IP": options.ip ?? nextIp(),
  };
  const requestOrigin =
    options.originHeader === undefined ? origin : options.originHeader;
  if (requestOrigin !== null) headers.Origin = requestOrigin;
  return application.fetch(
    new Request(url("/admin/auth/sign-in"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        email,
        password: options.password ?? staffPassword,
      }),
    }),
    { ...bindings, ...options.bindingsOverride },
  );
}

function sessionToken(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  const token = cookie?.match(/certpath_session=([A-Za-z0-9_-]{43})/)?.[1];
  if (!token) throw new Error("Staff sign-in response omitted its session cookie");
  return token;
}

/**
 * A confirmed TOTP credential written straight to storage, so the HTTP tests do
 * not have to drive enrolment to test everything else. The seed is sealed with
 * the same key and primitive the route uses, so `verify` exercises the real
 * AES-256-GCM open path.
 */
async function enrolTotpCredential(userId: string): Promise<Uint8Array> {
  const key = await readSealKey(sealKey);
  if (!key) throw new Error("The test seal key is unusable");
  const seed = createTotpSeed();
  const sealed = await sealTotpSeed(key, seed);
  await database
    .prepare(
      `INSERT INTO staff_totp_credentials (
         credential_id, user_id, secret_ciphertext, secret_iv, key_version,
         digits, period_seconds, algorithm, last_used_step, created_at,
         confirmed_at, created_operation_id, revoked_at, revoked_operation_id
       ) VALUES (?, ?, ?, ?, 1, 6, 30, 'SHA1', 0, ?, ?, ?, NULL, NULL)`,
    )
    .bind(
      crypto.randomUUID(),
      userId,
      sealed.ciphertext,
      sealed.iv,
      clock,
      clock,
      `test-mfa-enrol:${crypto.randomUUID()}`,
    )
    .run();
  return seed;
}

async function adminCsrfToken(cookie: string): Promise<string> {
  const response = await application.fetch(
    new Request(url("/admin/csrf"), {
      headers: {
        Cookie: `certpath_session=${cookie}`,
        "CF-Connecting-IP": nextIp(),
      },
    }),
    bindings,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { csrfToken: string }).csrfToken;
}

async function verifySecondFactor(
  cookie: string,
  seed: Uint8Array,
  options: { at?: number; ip?: string } = {},
) {
  const at = options.at ?? clock;
  const token = await adminCsrfToken(cookie);
  return application.fetch(
    new Request(url("/admin/auth/mfa/verify"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "CF-Connecting-IP": options.ip ?? nextIp(),
        Cookie: `certpath_session=${cookie}`,
        "X-CSRF-Token": token,
      },
      body: JSON.stringify({ code: await totpCodeAt(seed, totpStepAt(at)) }),
    }),
    bindings,
  );
}

/** Sign in, then finish the second factor: the only way to an assured session. */
async function staffSession(email: string, userId: string): Promise<string> {
  const response = await signIn(email);
  expect(response.status).toBe(200);
  const cookie = sessionToken(response);
  const seed = await enrolTotpCredential(userId);
  const verified = await verifySecondFactor(cookie, seed);
  expect(verified.status).toBe(200);
  return cookie;
}

async function csrfToken(cookie: string): Promise<string> {
  const response = await application.fetch(
    new Request(url("/admin/content/csrf"), {
      headers: { Cookie: `certpath_session=${cookie}` },
    }),
    bindings,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { csrfToken: string }).csrfToken;
}

async function contentRequest(
  method: "GET" | "POST",
  path: string,
  options: {
    cookie?: string;
    token?: string;
    body?: unknown;
    ip?: string;
    bindingsOverride?: Record<string, unknown>;
  } = {},
) {
  const headers: Record<string, string> = {
    "CF-Connecting-IP": options.ip ?? testerIp,
    Origin: origin,
  };
  if (options.cookie) {
    headers.Cookie = `certpath_session=${options.cookie}`;
  }
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers["X-CSRF-Token"] = options.token;
  return application.fetch(
    new Request(url(path), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    { ...bindings, ...options.bindingsOverride },
  );
}

function uniqueEmail(label: string): string {
  return `${label}-${crypto.randomUUID()}@example.test`;
}

describe("tester-only admin access", () => {
  it("closes the admin surface when no tester allowlist is configured", async () => {
    const email = uniqueEmail("admin-gate-closed");
    await provisionStaff("global_admin", email);

    const response = await signIn(email, {
      bindingsOverride: { ADMIN_TESTER_IPS: "" },
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
  });

  it("rejects a client outside the allowlist before any session is created", async () => {
    const email = uniqueEmail("admin-gate-denied");
    const userId = await provisionStaff("global_admin", email);

    const response = await signIn(email, { ip: "198.51.100.99" });
    expect(response.status).toBe(403);
    const sessions = await database
      .prepare("SELECT COUNT(*) AS count FROM app_sessions WHERE user_id = ?")
      .bind(userId)
      .first<{ count: number }>();
    expect(sessions?.count).toBe(0);
    const audits = await database
      .prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'staff_signed_in' AND subject_id = ?",
      )
      .bind(userId)
      .first<{ count: number }>();
    expect(audits?.count).toBe(0);
  });

  it("refuses a tester-gate configuration with 503 and writes nothing", async () => {
    const email = uniqueEmail("admin-tester-gate-refused");
    const userId = await provisionStaff("global_admin", email);

    const response = await signIn(email, {
      bindingsOverride: { STAFF_MFA_ALLOWED_METHODS: "tester-gate" },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "service_unavailable" },
    });

    const preflight = await application.fetch(
      new Request(url("/admin/auth/preflight"), {
        headers: { "CF-Connecting-IP": testerIp },
      }),
      { ...bindings, STAFF_MFA_ALLOWED_METHODS: "tester-gate" },
    );
    expect(preflight.status).toBe(200);
    expect(await preflight.json()).toEqual({
      signInEnabled: false,
      mfaMethods: [],
      testerAssuranceEnabled: false,
    });

    const sessions = await database
      .prepare("SELECT COUNT(*) AS count FROM app_sessions WHERE user_id = ?")
      .bind(userId)
      .first<{ count: number }>();
    expect(sessions?.count).toBe(0);
  });

  it("reports the retired tester assurance as permanently off", async () => {
    const email = uniqueEmail("admin-preflight");
    await provisionStaff("global_admin", email);

    const preflight = await application.fetch(
      new Request(url("/admin/auth/preflight"), {
        headers: { "CF-Connecting-IP": testerIp },
      }),
      bindings,
    );
    expect(preflight.status).toBe(200);
    expect(await preflight.json()).toEqual({
      signInEnabled: true,
      mfaMethods: ["totp"],
      testerAssuranceEnabled: false,
    });
  });

  it("cannot reach the tester gate once TOTP is enabled", async () => {
    const email = uniqueEmail("admin-gate-retired");
    const userId = await provisionStaff("global_admin", email);
    const cookie = await staffSession(email, userId);

    // The allowlist is still the first thing that runs. Clearing it closes the
    // surface for a fully verified session, exactly as it did before 5F.
    for (const path of [
      "/api/admin/auth/session",
      "/api/admin/csrf",
      "/api/admin/content/certifications",
      "/api/admin/learners/lookup",
    ]) {
      const gated = adminTesterGate(
        new Request(url(path), {
          headers: { "CF-Connecting-IP": testerIp },
        }),
        { ADMIN_TESTER_IPS: "" },
      );
      expect(gated?.status).toBe(503);
    }

    const session = await application.fetch(
      new Request(url("/admin/auth/session"), {
        headers: {
          Cookie: `certpath_session=${cookie}`,
          "CF-Connecting-IP": testerIp,
        },
      }),
      { ...bindings, ADMIN_TESTER_IPS: "" },
    );
    expect(session.status).toBe(503);
  });

  it("signs a provisioned staff account in with a password only", async () => {
    const email = uniqueEmail("admin-sign-in");
    const userId = await provisionStaff("global_admin", email);

    const response = await signIn(email);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      redirectTo: "/admin/mfa/verify",
    });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");

    const session = await database
      .prepare(
        `SELECT mfa_method, mfa_verified_at FROM app_sessions
         WHERE user_id = ?`,
      )
      .bind(userId)
      .first<{ mfa_method: string | null; mfa_verified_at: number | null }>();
    expect(session?.mfa_method).toBeNull();
    expect(session?.mfa_verified_at).toBeNull();

    const audit = await database
      .prepare(
        `SELECT reason FROM audit_events
         WHERE action = 'staff_signed_in' AND subject_id = ?`,
      )
      .bind(userId)
      .first<{ reason: string }>();
    expect(audit?.reason).toBe(
      "Staff signed in with a password; second factor pending",
    );

    // A password-only session is signed in but not assured: the session read
    // answers 403 with the precise reason, and the route guard refuses.
    const sessionResponse = await application.fetch(
      new Request(url("/admin/auth/session"), {
        headers: {
          Cookie: `certpath_session=${sessionToken(response)}`,
          "CF-Connecting-IP": testerIp,
        },
      }),
      bindings,
    );
    expect(sessionResponse.status).toBe(403);
    expect(await sessionResponse.json()).toMatchObject({
      error: { code: "mfa-assurance-missing" },
    });
  });

  it("rejects a wrong password and the wrong origin without minting a session", async () => {
    const email = uniqueEmail("admin-wrong-password");
    const userId = await provisionStaff("global_admin", email);

    const wrongPassword = await signIn(email, { password: "not-the-password" });
    expect(wrongPassword.status).toBe(401);
    expect(await wrongPassword.json()).toMatchObject({
      error: { code: "invalid_credentials" },
    });

    const wrongOrigin = await signIn(email, {
      originHeader: "https://attacker.example",
    });
    expect(wrongOrigin.status).toBe(400);

    const unknownAccount = await signIn(uniqueEmail("admin-unknown"));
    expect(unknownAccount.status).toBe(401);

    const sessions = await database
      .prepare("SELECT COUNT(*) AS count FROM app_sessions WHERE user_id = ?")
      .bind(userId)
      .first<{ count: number }>();
    expect(sessions?.count).toBe(0);
  }, 30_000);

  it("requires a staff role even when the password is correct", async () => {
    const identity = await createTestIdentity(database);
    const email = uniqueEmail("admin-not-staff");
    await database
      .prepare(
        `INSERT INTO staff_password_credentials (
           user_id, email, email_normalized, password_hash, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(identity.userId, email, email, passwordHash, clock, clock)
      .run();

    expect((await signIn(email)).status).toBe(401);
  });

  it("rate limits repeated staff sign-in attempts", async () => {
    const email = uniqueEmail("admin-rate-limit");
    await provisionStaff("global_admin", email);

    for (const _ of [0, 1, 2, 3, 4]) {
      expect((await signIn(email, { password: "wrong-password" })).status).toBe(
        401,
      );
    }
    const limited = await signIn(email, { password: "wrong-password" });
    expect(limited.status).toBe(429);
  }, 30_000);

  it("lets both Global Admins manage the same synthetic exam", async () => {
    const scope = await createContentScope(database);
    const firstAdmin = uniqueEmail("admin-one");
    const secondAdmin = uniqueEmail("admin-two");
    const firstId = await provisionStaff("global_admin", firstAdmin);
    const secondId = await provisionStaff("global_admin", secondAdmin);

    const firstCookie = await staffSession(firstAdmin, firstId);
    const firstToken = await csrfToken(firstCookie);
    const created = await contentRequest(
      "POST",
      `/admin/content/certifications/${scope.certificationId}/exam-versions/${scope.examVersionId}/domains`,
      {
        cookie: firstCookie,
        token: firstToken,
        body: {
          domainKey: `domain-${crypto.randomUUID()}`,
          title: "Global Admin one domain",
          meaning: "A synthetic domain created by the first Global Admin.",
          order: 1,
        },
      },
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: string };

    const secondCookie = await staffSession(secondAdmin, secondId);
    const secondToken = await csrfToken(secondCookie);

    const domains = await contentRequest(
      "GET",
      `/admin/content/certifications/${scope.certificationId}/exam-versions/${scope.examVersionId}/domains?limit=50`,
      { cookie: secondCookie },
    );
    expect(domains.status).toBe(200);
    const domainList = (await domains.json()) as {
      items: Array<{ id: string; title: string }>;
    };
    expect(domainList.items.map((item) => item.id)).toContain(createdBody.id);

    const topic = await contentRequest(
      "POST",
      `/admin/content/certifications/${scope.certificationId}/exam-versions/${scope.examVersionId}/domains/${createdBody.id}/topics`,
      {
        cookie: secondCookie,
        token: secondToken,
        body: {
          topicKey: `topic-${crypto.randomUUID()}`,
          title: "Global Admin two topic",
          meaning: "A synthetic topic created by the second Global Admin.",
          order: 1,
        },
      },
    );
    expect(topic.status).toBe(201);
    const topicBody = (await topic.json()) as { id: string };

    const question = await contentRequest(
      "POST",
      `/admin/content/certifications/${scope.certificationId}/exam-versions/${scope.examVersionId}/questions`,
      {
        cookie: secondCookie,
        token: secondToken,
        body: {
          questionKey: `question-${crypto.randomUUID()}`,
          domainId: createdBody.id,
          topicId: topicBody.id,
          content: validQuestionContent,
        },
      },
    );
    expect(question.status).toBe(201);
    const questionBody = (await question.json()) as {
      questionId: string;
      revisionId: string;
    };

    const revision = await contentRequest(
      "GET",
      `/admin/content/certifications/${scope.certificationId}/exam-versions/${scope.examVersionId}/questions/${questionBody.questionId}/revisions/${questionBody.revisionId}`,
      { cookie: firstCookie },
    );
    expect(revision.status).toBe(200);
    expect(await revision.json()).toMatchObject({
      revisionId: questionBody.revisionId,
      stem: validQuestionContent.stem,
    });
  }, 30_000);

  it("keeps a Manager inside the one assigned synthetic exam", async () => {
    const assigned = await createContentScope(database);
    const other = await createContentScope(database);
    const managerEmail = uniqueEmail("manager");
    const managerUserId = await provisionStaff("manager", managerEmail);
    await database
      .prepare(
        `INSERT INTO manager_certification_assignments (
           manager_user_id, certification_id, active, changed_by_user_id,
           operation_id, reason, changed_at
         ) VALUES (?, ?, 1, ?, ?, 'Tester scoped to one synthetic exam', ?)`,
      )
      .bind(
        managerUserId,
        assigned.certificationId,
        managerUserId,
        `test-assignment:${crypto.randomUUID()}`,
        clock,
      )
      .run();

    const cookie = await staffSession(managerEmail, managerUserId);
    const token = await csrfToken(cookie);

    const certifications = await contentRequest(
      "GET",
      "/admin/content/certifications?limit=50",
      { cookie },
    );
    expect(certifications.status).toBe(200);
    const listing = (await certifications.json()) as {
      items: Array<{ id: string }>;
    };
    expect(listing.items.map((item) => item.id)).toEqual([
      assigned.certificationId,
    ]);

    const allowed = await contentRequest(
      "POST",
      `/admin/content/certifications/${assigned.certificationId}/exam-versions/${assigned.examVersionId}/domains`,
      {
        cookie,
        token,
        body: {
          domainKey: `domain-${crypto.randomUUID()}`,
          title: "Manager domain on the assigned exam",
          meaning: "Synthetic domain inside the assignment.",
          order: 2,
        },
      },
    );
    expect(allowed.status).toBe(201);

    // Assignment denial is reported as not_found so the response never confirms
    // that another certification exists.
    const otherVersions = await contentRequest(
      "GET",
      `/admin/content/certifications/${other.certificationId}/exam-versions?limit=50`,
      { cookie },
    );
    expect(otherVersions.status).toBe(404);

    const otherDomain = await contentRequest(
      "POST",
      `/admin/content/certifications/${other.certificationId}/exam-versions/${other.examVersionId}/domains`,
      {
        cookie,
        token,
        body: {
          domainKey: `domain-${crypto.randomUUID()}`,
          title: "Manager domain on an unassigned exam",
          meaning: "This must be refused.",
          order: 3,
        },
      },
    );
    expect(otherDomain.status).toBe(404);

    const otherQuestions = await contentRequest(
      "GET",
      `/admin/content/certifications/${other.certificationId}/exam-versions/${other.examVersionId}/questions?limit=50&domainId=${other.domainId}&topicId=${other.topicId}`,
      { cookie },
    );
    expect(otherQuestions.status).toBe(404);
  });

  it("exposes no staff-management or billing surface to any staff role", async () => {
    const email = uniqueEmail("admin-absent-routes");
    const userId = await provisionStaff("global_admin", email);
    const cookie = await staffSession(email, userId);

    for (const path of [
      "/admin/content/staff",
      "/admin/staff",
      "/admin/payments",
      "/admin/billing",
      "/admin/security",
    ]) {
      const response = await contentRequest("GET", path, { cookie });
      expect(response.status).toBe(404);
    }
  });

  it("refuses admin APIs without a session and with a stale assurance", async () => {
    expect(
      (
        await contentRequest("GET", "/admin/content/certifications?limit=50")
      ).status,
    ).toBe(401);

    const email = uniqueEmail("admin-stale-assurance");
    const userId = await provisionStaff("global_admin", email);
    const cookie = await staffSession(email, userId);
    await database
      .prepare("UPDATE app_sessions SET mfa_verified_at = ? WHERE user_id = ?")
      .bind(clock - 9 * 60 * 60 * 1000, userId)
      .run();

    const stale = await contentRequest(
      "GET",
      "/admin/content/certifications?limit=50",
      { cookie },
    );
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({
      error: { code: "forbidden" },
    });
  });
}, 30_000);
