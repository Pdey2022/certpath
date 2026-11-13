import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/index.ts";
import { localPasswordIssuer } from "../src/local-learner-auth.ts";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  authorizeCertification,
  authorizeGlobalAdmin,
} from "../src/security/repository.ts";
import {
  hashLearnerPassword,
  learnerPasswordHashParameters,
  PasswordHashUnavailableError,
} from "../src/security/password-hashing.ts";
import {
  createTestCertification,
  createTestIdentity,
  createTestSessionCredentials,
  grantTestLearnerAccess,
  grantTestRole,
} from "./factories.ts";
import { contentMfaPolicy, createContentScope } from "./content-fixtures.ts";

const database: SecurityDatabase = env.DB;
const origin = "https://localhost";
const csrfSecret = "local-worker-test-csrf-secret-with-enough-entropy";
const rateLimitSecret =
  "local-worker-test-rate-limit-secret-with-enough-entropy";
const startPassword = `synthetic-${crypto.randomUUID()}-learner-password`;
const nextPassword = `synthetic-${crypto.randomUUID()}-updated-password`;

let clock = Date.now();
const application = createApi(fetch, () => clock);

const bindings = {
  DB: database,
  PUBLIC_SITE_ORIGIN: origin,
  CSRF_HMAC_SECRET: csrfSecret,
  LOCAL_LEARNER_AUTH_ENABLED: "true",
  LOCAL_TEST_MAIL_ENABLED: "true",
  LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET: rateLimitSecret,
  STAFF_MFA_MAX_AGE_MS: "120000",
  STAFF_MFA_ALLOWED_METHODS: "totp",
};

function url(path: string): string {
  return `${origin}/api${path}`;
}

function email(label: string): string {
  return `${label}-${crypto.randomUUID()}@example.test`;
}

async function post(path: string, body: unknown, ip = "198.51.100.40") {
  return application.fetch(
    new Request(url(path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "CF-Connecting-IP": ip,
      },
      body: JSON.stringify(body),
    }),
    bindings,
  );
}

async function inbox(address: string) {
  const response = await application.fetch(
    new Request(
      `${url("/auth/local/test-inbox")}?${new URLSearchParams({ email: address })}`,
    ),
    bindings,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    messages: Array<{ kind: "verify_email" | "password_reset"; link: string }>;
  };
}

function tokenFromLink(link: string): string {
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token");
  if (!token) throw new Error("Synthetic inbox link omitted its token fragment");
  return token;
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  const token = cookie?.match(/certpath_session=([A-Za-z0-9_-]{43})/)?.[1];
  if (!token) throw new Error("Sign-in response omitted its opaque session cookie");
  return token;
}

async function dashboard(rawToken: string) {
  return application.fetch(
    new Request(url("/practice/dashboard"), {
      headers: { Cookie: `certpath_session=${rawToken}` },
    }),
    bindings,
  );
}

async function registerAndVerify(address: string, password = startPassword) {
  const registered = await post("/auth/local/register", {
    email: address,
  });
  expect(registered.status).toBe(202);
  const verification = (await inbox(address)).messages.find(
    (message) => message.kind === "verify_email",
  );
  expect(verification).toBeTruthy();
  const token = tokenFromLink(verification!.link);
  const verified = await post("/auth/local/verify-email", { token, password });
  expect(verified.status).toBe(200);
  return token;
}

describe("CertPath-owned local learner authentication", () => {
  it("keeps sign-in disabled unless local-only bindings are explicitly enabled", async () => {
    const response = await application.fetch(
      new Request(url("/auth/local/preflight")),
      { DB: database },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      signInEnabled: false,
      localMailboxEnabled: false,
    });
  });

  it("refuses to enable the proof on a non-loopback origin", async () => {
    const remoteOrigin = "https://certpath.example.test";
    const response = await application.fetch(
      new Request(`${remoteOrigin}/api/auth/local/preflight`),
      {
        ...bindings,
        PUBLIC_SITE_ORIGIN: remoteOrigin,
      },
    );
    expect(await response.json()).toEqual({
      signInEnabled: false,
      localMailboxEnabled: false,
    });
    const registration = await application.fetch(
      new Request(`${remoteOrigin}/api/auth/local/register`, {
        method: "POST",
        headers: {
          Origin: remoteOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: email("remote"),
          password: startPassword,
        }),
      }),
      { ...bindings, PUBLIC_SITE_ORIGIN: remoteOrigin },
    );
    expect(registration.status).toBe(503);
  });

  it("uses the scrypt profile in the actual Worker runtime", async () => {
    expect(learnerPasswordHashParameters).toEqual({
      algorithm: "scrypt",
      cost: 32_768,
      blockSize: 8,
      parallelism: 1,
      keyBytes: 32,
      saltBytes: 16,
      maxMemoryBytes: 64 * 1024 * 1024,
    });
    let encoded = "";
    const runtimeSamplePassword = crypto.randomUUID();
    try {
      encoded = await hashLearnerPassword(runtimeSamplePassword);
    } catch (error) {
      const cause =
        error instanceof PasswordHashUnavailableError ? error.cause : error;
      expect.fail(
        `scrypt Worker runtime failure: ${
          cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown"
        }`,
      );
    }
    expect(encoded).toMatch(
      /^\$scrypt\$ln=15,r=8,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(encoded).not.toContain(runtimeSamplePassword);
  });

  it("requires verified email, issues learner-only sessions, and revokes sessions on reset and sign-out", async () => {
    const address = email("flow");
    const registration = await post("/auth/local/register", {
      email: address,
    });
    expect(registration.status).toBe(202);
    const accountState = await database
      .prepare(
        `SELECT c.user_id, c.password_hash, c.email_verified_at,
                (SELECT COUNT(*) FROM staff_roles WHERE user_id = c.user_id) AS staff_roles,
                (SELECT COUNT(*) FROM learner_access_grants WHERE user_id = c.user_id) AS grants,
                (SELECT COUNT(*) FROM auth_identities
                 WHERE user_id = c.user_id AND issuer = ?) AS local_identities
         FROM learner_password_credentials AS c
         WHERE c.email_normalized = ?`,
      )
      .bind(localPasswordIssuer, address)
      .first<{
        user_id: string;
        password_hash: string | null;
        email_verified_at: number | null;
        staff_roles: number;
        grants: number;
        local_identities: number;
      }>();
    expect(accountState?.staff_roles).toBe(0);
    expect(accountState?.grants).toBe(0);
    expect(accountState?.local_identities).toBe(0);
    expect(accountState?.password_hash).toBeNull();
    expect(accountState?.email_verified_at).toBeNull();

    const unverifiedSignIn = await post(
      "/auth/local/sign-in",
      { email: address, password: startPassword },
      "198.51.100.41",
    );
    expect(unverifiedSignIn.status).toBe(401);
    const unverifiedSessions = await database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM app_sessions AS s
         JOIN learner_password_credentials AS c ON c.user_id = s.user_id
         WHERE c.email_normalized = ?`,
      )
      .bind(address)
      .first<{ count: number }>();
    expect(unverifiedSessions?.count).toBe(0);

    const verification = (await inbox(address)).messages[0];
    expect(verification?.kind).toBe("verify_email");
    expect(new URL(verification!.link).search).toBe("");
    const verificationToken = tokenFromLink(verification!.link);
    expect(
      (
        await post("/auth/local/verify-email", {
          token: verificationToken,
          password: startPassword,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post("/auth/local/verify-email", {
          token: verificationToken,
          password: nextPassword,
        })
      ).status,
    ).toBe(400);
    const verifiedIdentity = await database
      .prepare(
        `SELECT subject FROM auth_identities
         WHERE user_id = ? AND issuer = ?`,
      )
      .bind(accountState!.user_id, localPasswordIssuer)
      .first<{ subject: string }>();
    expect(verifiedIdentity?.subject).toMatch(/^[0-9a-f-]{36}$/);
    expect(verifiedIdentity?.subject).not.toContain(address);

    const initialHash = await database
      .prepare(
        "SELECT password_hash FROM learner_password_credentials WHERE email_normalized = ?",
      )
      .bind(address)
      .first<{ password_hash: string | null }>();
    expect(initialHash?.password_hash).toMatch(/^\$scrypt\$/);
    expect(initialHash?.password_hash).not.toContain(startPassword);

    const firstSignIn = await post(
      "/auth/local/sign-in",
      { email: address, password: startPassword },
      "198.51.100.42",
    );
    expect(firstSignIn.status).toBe(200);
    const firstSessionToken = sessionCookie(firstSignIn);
    const firstSession = await database
      .prepare(
        `        SELECT s.token_digest, s.user_id, s.mfa_method, s.mfa_verified_at
         FROM app_sessions AS s
         JOIN learner_password_credentials AS c ON c.user_id = s.user_id
         WHERE c.email_normalized = ?`,
      )
      .bind(address)
      .first<{
        token_digest: string;
        user_id: string;
        mfa_method: string | null;
        mfa_verified_at: number | null;
      }>();
    expect(firstSession?.mfa_method).toBeNull();
    expect(firstSession?.mfa_verified_at).toBeNull();
    expect(firstSession?.token_digest).not.toBe(firstSessionToken);

    const firstScope = await createContentScope(database);
    const secondScope = await createContentScope(database);
    const beforeGrant = await dashboard(firstSessionToken);
    expect(beforeGrant.status).toBe(200);
    expect((await beforeGrant.json()).groups).toEqual([]);

    await grantTestLearnerAccess(database, firstSession!.user_id, firstScope.certificationId);
    const afterGrant = await dashboard(firstSessionToken);
    expect(afterGrant.status).toBe(200);
    const grantedDashboard = (await afterGrant.json()) as {
      groups: Array<{ certificationId: string; examVersionId: string }>;
    };
    expect(grantedDashboard.groups).toHaveLength(1);
    expect(grantedDashboard.groups[0]).toMatchObject({
      certificationId: firstScope.certificationId,
      examVersionId: firstScope.examVersionId,
    });
    expect(
      grantedDashboard.groups.some(
        (group) => group.certificationId === secondScope.certificationId,
      ),
    ).toBe(false);

    const recovery = await post(
      "/auth/local/recover",
      { email: address },
      "198.51.100.43",
    );
    expect(recovery.status).toBe(202);
    const resetMessage = (await inbox(address)).messages.find(
      (message) => message.kind === "password_reset",
    );
    expect(resetMessage).toBeTruthy();
    const resetToken = tokenFromLink(resetMessage!.link);
    expect(
      (await post("/auth/local/reset-password", {
        token: resetToken,
        password: nextPassword,
      })).status,
    ).toBe(200);

    const revokedSession = await database
      .prepare("SELECT revoked_at FROM app_sessions WHERE token_digest = ?")
      .bind(firstSession!.token_digest)
      .first<{ revoked_at: number | null }>();
    expect(revokedSession?.revoked_at).not.toBeNull();
    expect((await dashboard(firstSessionToken)).status).toBe(401);
    expect(
      (await post(
        "/auth/local/reset-password",
        { token: resetToken, password: nextPassword },
        "198.51.100.44",
      )).status,
    ).toBe(400);
    expect(
      (await post(
        "/auth/local/sign-in",
        { email: address, password: startPassword },
        "198.51.100.45",
      )).status,
    ).toBe(401);

    const secondSignIn = await post(
      "/auth/local/sign-in",
      { email: address, password: nextPassword },
      "198.51.100.46",
    );
    expect(secondSignIn.status).toBe(200);
    const secondSessionToken = sessionCookie(secondSignIn);
    const secondDigest = await database
      .prepare(
        `SELECT token_digest
         FROM app_sessions
         WHERE token_digest != ? AND user_id = (
           SELECT user_id FROM learner_password_credentials
           WHERE email_normalized = ?
         )
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(firstSession!.token_digest, address)
      .first<{ token_digest: string }>();
    expect(secondDigest?.token_digest).toBeTruthy();

    const csrfResponse = await application.fetch(
      new Request(url("/auth/session/csrf"), {
        headers: { Cookie: `certpath_session=${secondSessionToken}` },
      }),
      bindings,
    );
    expect(csrfResponse.status).toBe(200);
    const csrf = (await csrfResponse.json()) as { csrfToken: string };
    const logout = await application.fetch(
      new Request(url("/auth/session/logout"), {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: `certpath_session=${secondSessionToken}`,
          "X-CSRF-Token": csrf.csrfToken,
        },
      }),
      bindings,
    );
    expect(logout.status).toBe(204);
    expect((await dashboard(secondSessionToken)).status).toBe(401);
    const signedOutSession = await database
      .prepare("SELECT revoked_at FROM app_sessions WHERE token_digest = ?")
      .bind(secondDigest!.token_digest)
      .first<{ revoked_at: number | null }>();
    expect(signedOutSession?.revoked_at).not.toBeNull();
  }, 30_000);

  it("does not activate a password supplied before email verification or change one on repeated registration", async () => {
    const address = email("password-after-verification");
    const preVerificationPassword = `synthetic-${crypto.randomUUID()}-early-password`;
    const chosenPassword = `synthetic-${crypto.randomUUID()}-verified-password`;
    const rejectedRegistration = await post("/auth/local/register", {
      email: address,
      password: preVerificationPassword,
    });
    expect(rejectedRegistration.status).toBe(400);
    expect((await inbox(address)).messages).toHaveLength(0);

    expect(
      (
        await database
          .prepare(
            "SELECT COUNT(*) AS count FROM learner_password_credentials WHERE email_normalized = ?",
          )
          .bind(address)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);

    expect(
      (await post("/auth/local/register", { email: address })).status,
    ).toBe(202);
    const pending = await database
      .prepare(
        "SELECT password_hash, email_verified_at FROM learner_password_credentials WHERE email_normalized = ?",
      )
      .bind(address)
      .first<{ password_hash: string | null; email_verified_at: number | null }>();
    expect(pending).toEqual({ password_hash: null, email_verified_at: null });
    expect(
      (
        await post(
          "/auth/local/sign-in",
          { email: address, password: preVerificationPassword },
          "198.51.100.71",
        )
      ).status,
    ).toBe(401);

    const verification = (await inbox(address)).messages.find(
      (message) => message.kind === "verify_email",
    );
    expect(verification).toBeTruthy();
    const token = tokenFromLink(verification!.link);
    expect(
      (
        await post("/auth/local/verify-email", {
          token,
          password: chosenPassword,
        })
      ).status,
    ).toBe(200);
    const activeHash = await database
      .prepare(
        "SELECT password_hash FROM learner_password_credentials WHERE email_normalized = ?",
      )
      .bind(address)
      .first<{ password_hash: string | null }>();
    expect(activeHash?.password_hash).toMatch(/^\$scrypt\$/);

    expect((await post("/auth/local/register", { email: address })).status).toBe(
      202,
    );
    expect(
      (
        await post("/auth/local/register", {
          email: address,
          password: preVerificationPassword,
        })
      ).status,
    ).toBe(400);
    const hashAfterRepeatedRegistration = await database
      .prepare(
        "SELECT password_hash FROM learner_password_credentials WHERE email_normalized = ?",
      )
      .bind(address)
      .first<{ password_hash: string | null }>();
    expect(hashAfterRepeatedRegistration?.password_hash).toBe(
      activeHash?.password_hash,
    );
    expect(
      (
        await post(
          "/auth/local/sign-in",
          { email: address, password: preVerificationPassword },
          "198.51.100.72",
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await post(
          "/auth/local/sign-in",
          { email: address, password: chosenPassword },
          "198.51.100.73",
        )
      ).status,
    ).toBe(200);
  }, 30_000);

  it("rejects duplicate registration, expired links, and repeated recovery attempts", async () => {
    const address = email("expiry");
    const registered = await post("/auth/local/register", { email: address });
    expect(registered.status).toBe(202);
    const duplicate = await post(
      "/auth/local/register",
      { email: address },
      "198.51.100.51",
    );
    expect(duplicate.status).toBe(202);
    expect(
      (
        await post(
          "/auth/local/register",
          { email: address },
          "198.51.100.53",
        )
      ).status,
    ).toBe(202);
    expect(
      (
        await post(
          "/auth/local/register",
          { email: address },
          "198.51.100.54",
        )
      ).status,
    ).toBe(429);
    const messages = await inbox(address);
    expect(messages.messages).toHaveLength(1);
    const token = tokenFromLink(messages.messages[0]!.link);

    clock = Date.now() + 24 * 60 * 60 * 1000 + 1;
    expect(
      (await post("/auth/local/verify-email", { token, password: startPassword }))
        .status,
    ).toBe(400);

    const resetAddress = email("reset-expiry");
    await registerAndVerify(resetAddress);
    const recoveryRequests = await Promise.all(
      Array.from({ length: 4 }, () =>
        post(
          "/auth/local/recover",
          { email: resetAddress },
          "198.51.100.52",
        ),
      ),
    );
    expect(recoveryRequests.slice(0, 3).every((response) => response.status === 202))
      .toBe(true);
    expect(recoveryRequests[3]?.status).toBe(429);
    const resetMessage = (await inbox(resetAddress)).messages.find(
      (message) => message.kind === "password_reset",
    );
    expect(resetMessage).toBeTruthy();
    const resetToken = tokenFromLink(resetMessage!.link);
    clock += 30 * 60 * 1000 + 1;
    expect(
      (
        await post("/auth/local/reset-password", {
          token: resetToken,
          password: nextPassword,
        })
      ).status,
    ).toBe(400);
  }, 30_000);

  it("limits repeated failed sign-in attempts by IP and email", async () => {
    const address = email("failure-limit");
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        post(
          "/auth/local/sign-in",
          { email: address, password: crypto.randomUUID() },
          ip,
        ),
      ),
    );
    expect(attempts.slice(0, 5).every((response) => response.status === 401)).toBe(true);
    expect(attempts[5]?.status).toBe(429);
  }, 20_000);

  it("never issues password-only sessions to staff or allows learner sessions through staff guards", async () => {
    const hash = await hashLearnerPassword(startPassword);
    const staff = [
      { role: "global_admin" as const, label: "admin" },
      { role: "manager" as const, label: "manager" },
    ];
    const staffUsers: string[] = [];
    for (const entry of staff) {
      const identity = await createTestIdentity(database);
      await grantTestRole(database, identity.userId, entry.role);
      const address = email(entry.label);
      const subject = crypto.randomUUID();
      await database
        .prepare(
          "INSERT INTO auth_identities (issuer, subject, user_id, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(localPasswordIssuer, subject, identity.userId, clock)
        .run();
      await database
        .prepare(
          `INSERT INTO learner_password_credentials (
             user_id, email, email_normalized, subject, password_hash,
             email_verified_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          identity.userId,
          address,
          address,
          subject,
          hash,
          clock,
          clock,
          clock,
        )
        .run();
      staffUsers.push(identity.userId);
      expect(
        (
          await post(
            "/auth/local/sign-in",
            { email: address, password: startPassword },
            `198.51.100.${entry.role === "global_admin" ? "61" : "62"}`,
          )
        ).status,
      ).toBe(401);
    }

    const learner = await createTestIdentity(database);
    const credentials = await createTestSessionCredentials(
      database,
      learner.userId,
      { now: clock, expiresAt: clock + 60 * 60 * 1000 },
    );
    const certificationId = await createTestCertification(database, learner.userId);
    const globalAdmin = await authorizeGlobalAdmin(
      database,
      credentials.tokenDigest,
      clock,
      contentMfaPolicy,
    );
    expect(globalAdmin).toEqual({ allowed: false, reason: "not-staff" });
    const managerGuard = await authorizeCertification(
      database,
      credentials.tokenDigest,
      certificationId,
      clock,
      contentMfaPolicy,
    );
    expect(managerGuard).toEqual({ allowed: false, reason: "not-staff" });

    const globalAdminResponse = await application.fetch(
      new Request(url("/admin/content/certifications"), {
        headers: { Cookie: `certpath_session=${credentials.rawToken}` },
      }),
      bindings,
    );
    expect(globalAdminResponse.status).toBe(403);
    const managerResponse = await application.fetch(
      new Request(
        url(`/admin/content/certifications/${certificationId}/exam-versions`),
        { headers: { Cookie: `certpath_session=${credentials.rawToken}` } },
      ),
      bindings,
    );
    expect(managerResponse.status).toBe(403);

    const counts = await database
      .prepare(
        "SELECT COUNT(*) AS count FROM app_sessions WHERE user_id IN (?, ?)",
      )
      .bind(...staffUsers)
      .first<{ count: number }>();
    expect(counts?.count).toBe(0);
  }, 20_000);
});
