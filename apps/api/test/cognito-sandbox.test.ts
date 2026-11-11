import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/index.ts";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  authorizeCertification,
  authorizeGlobalAdmin,
} from "../src/security/repository.ts";
import { sessionDigest } from "../src/security/http-session.ts";
import {
  assignTestCertification,
  createTestCertification,
  createTestIdentity,
  grantTestRole,
  grantTestLearnerAccess,
} from "./factories.ts";
import { createContentScope } from "./content-fixtures.ts";

const database: SecurityDatabase = env.DB;
const origin = "https://certpath.example.test";
const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_testpool";
const learnerClientId = "synthetic-learner-client";
const staffClientId = "synthetic-staff-client";
const allowedClientIp = "198.51.100.10";
const bindings = {
  DB: database,
  PUBLIC_SITE_ORIGIN: origin,
  CSRF_HMAC_SECRET: "synthetic-csrf-secret-for-worker-tests-only",
  STAFF_MFA_MAX_AGE_MS: "300000",
  STAFF_MFA_ALLOWED_METHODS: "totp",
  COGNITO_SANDBOX_ENABLED: "true",
  COGNITO_SANDBOX_ALLOWED_CLIENT_IPS: allowedClientIp,
  COGNITO_ISSUER: issuer,
  COGNITO_DOMAIN: "https://certpath-test.auth.us-east-1.amazoncognito.com",
  COGNITO_CALLBACK_URL: `${origin}/api/auth/cognito/callback`,
  COGNITO_LEARNER_CLIENT_ID: learnerClientId,
  COGNITO_STAFF_CLIENT_ID: staffClientId,
  COGNITO_TRANSACTION_ENCRYPTION_KEY:
    "synthetic-transaction-encryption-key-for-tests-only",
};

let signingKeys: CryptoKeyPair;
let signingJwk: JsonWebKey & { kid: string; use: string; alg: string };
let nextClaims: Record<string, unknown> | null = null;
let expectedCodeChallenge = "";
let tamperSignature = false;

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function signToken(claims: Record<string, unknown>): Promise<string> {
  const header = encodeBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ alg: "RS256", typ: "JWT", kid: "synthetic-key" }),
    ),
  );
  const payload = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const signingInput = new TextEncoder().encode(`${header}.${payload}`);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      signingKeys.privateKey,
      toArrayBuffer(signingInput),
    ),
  );
  let encodedSignature = encodeBase64Url(signature);
  if (tamperSignature) {
    encodedSignature =
      encodedSignature[0] === "A"
        ? `B${encodedSignature.slice(1)}`
        : `A${encodedSignature.slice(1)}`;
  }
  return `${header}.${payload}.${encodedSignature}`;
}

const fetcher: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/.well-known/jwks.json")) {
    return Response.json({ keys: [signingJwk] });
  }
  if (url.pathname === "/oauth2/token") {
    const form = new URLSearchParams(init?.body as URLSearchParams);
    const verifier = form.get("code_verifier") ?? "";
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        toArrayBuffer(new TextEncoder().encode(verifier)),
      ),
    );
    if (
      encodeBase64Url(digest) !== expectedCodeChallenge ||
      form.get("grant_type") !== "authorization_code"
    ) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (!nextClaims) {
      return Response.json({ error: "missing_test_claims" }, { status: 400 });
    }
    return Response.json({ id_token: await signToken(nextClaims) });
  }
  return new Response(null, { status: 404 });
};

const application = createApi(fetcher);

async function fetchApi(
  request: Request,
  clientIp = allowedClientIp,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set("CF-Connecting-IP", clientIp);
  return application.fetch(new Request(request, { headers }), bindings);
}

beforeAll(async () => {
  signingKeys = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("jwk", signingKeys.publicKey);
  signingJwk = {
    ...exported,
    kid: "synthetic-key",
    use: "sig",
    alg: "RS256",
  };
});

async function createIdentity(
  role?: "global_admin" | "manager",
): Promise<{ userId: string; subject: string }> {
  const identity = await createTestIdentity(database);
  const subject = crypto.randomUUID();
  await database
    .prepare(
      "UPDATE auth_identities SET issuer = ?, subject = ? WHERE issuer = ? AND subject = ?",
    )
    .bind(issuer, subject, identity.issuer, identity.subject)
    .run();
  if (role) await grantTestRole(database, identity.userId, role);
  return { userId: identity.userId, subject };
}

function defaultClaims(
  audience: "learner" | "staff",
  subject: string,
  nonce: string,
): Record<string, unknown> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    iss: issuer,
    sub: subject,
    aud: audience === "staff" ? staffClientId : learnerClientId,
    exp: nowSeconds + 900,
    iat: nowSeconds,
    auth_time: nowSeconds,
    token_use: "id",
    nonce,
    email_verified: true,
    ...(audience === "staff"
      ? {
          acr: "urn:cognito:loa:4",
          amr: ["pwd", "otp", "mfa"],
        }
      : {}),
  };
}

interface LoginResult {
  response: Response;
  authorizationUrl: URL;
  cookie: string;
  state: string;
  subject: string;
}

interface PendingLogin {
  authorizationUrl: URL;
  cookie: string;
  state: string;
  subject: string;
}

async function beginLogin(
  audience: "learner" | "staff",
  subject: string,
  claimOverrides: Record<string, unknown> = {},
  options: { invalidSignature?: boolean } = {},
): Promise<PendingLogin> {
  const start = await fetchApi(
    new Request(
      `${origin}/api/auth/cognito/start?audience=${audience}`,
    ),
  );
  const authorizationUrl = new URL(start.headers.get("Location") ?? origin);
  const state = authorizationUrl.searchParams.get("state") ?? "";
  const nonce = authorizationUrl.searchParams.get("nonce") ?? "";
  const cookie = (start.headers.get("Set-Cookie") ?? "").split(";")[0];
  expectedCodeChallenge =
    authorizationUrl.searchParams.get("code_challenge") ?? "";
  nextClaims = {
    ...defaultClaims(audience, subject, nonce),
    ...claimOverrides,
  };
  tamperSignature = options.invalidSignature ?? false;
  return { authorizationUrl, cookie, state, subject };
}

async function finishLogin(pending: PendingLogin): Promise<LoginResult> {
  const callbackUrl = new URL("/api/auth/cognito/callback", origin);
  callbackUrl.searchParams.set("code", "synthetic-authorization-code");
  callbackUrl.searchParams.set("state", pending.state);
  const response = await fetchApi(
    new Request(callbackUrl, { headers: { Cookie: pending.cookie } }),
  );
  tamperSignature = false;
  nextClaims = null;
  return { ...pending, response };
}

async function login(
  audience: "learner" | "staff",
  subject: string,
  claimOverrides: Record<string, unknown> = {},
  options: { invalidSignature?: boolean } = {},
): Promise<LoginResult> {
  return finishLogin(
    await beginLogin(audience, subject, claimOverrides, options),
  );
}

function sessionCookie(response: Response): string | null {
  const value = response.headers.get("Set-Cookie") ?? "";
  const match = /(?:^|,\s*)certpath_session=([^;,]+)/.exec(value);
  return match?.[1] ?? null;
}

async function sessionCount(userId: string): Promise<number> {
  const result = await database
    .prepare("SELECT COUNT(*) AS count FROM app_sessions WHERE user_id = ?")
    .bind(userId)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

async function loginTransactionCount(): Promise<number> {
  const result = await database
    .prepare("SELECT COUNT(*) AS count FROM cognito_login_transactions")
    .first<{ count: number }>();
  return result?.count ?? 0;
}

describe("Cognito sandbox authorization-code proof harness", () => {
  it("denies an unlisted client IP before writing a D1 login transaction", async () => {
    const before = await loginTransactionCount();
    const response = await fetchApi(
      new Request(`${origin}/api/auth/cognito/start?audience=learner`, {
        headers: { "X-Forwarded-For": allowedClientIp },
      }),
      "203.0.113.77",
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "sandbox_access_denied" },
    });
    expect(await loginTransactionCount()).toBe(before);
  });

  it("fails closed when the sandbox has no client IP allowlist", async () => {
    const before = await loginTransactionCount();
    const request = new Request(
      `${origin}/api/auth/cognito/start?audience=learner`,
      { headers: { "CF-Connecting-IP": allowedClientIp } },
    );
    const response = await application.fetch(request, {
      ...bindings,
      COGNITO_SANDBOX_ALLOWED_CLIENT_IPS: "",
    });

    expect(response.status).toBe(503);
    expect(await loginTransactionCount()).toBe(before);
  });

  it("preflights the tester restriction while sign-in is disabled", async () => {
    const before = await loginTransactionCount();
    const disabledBindings = {
      ...bindings,
      COGNITO_SANDBOX_ENABLED: "false",
    };
    const allowed = await application.fetch(
      new Request(`${origin}/api/auth/cognito/preflight`, {
        headers: { "CF-Connecting-IP": allowedClientIp },
      }),
      disabledBindings,
    );
    const denied = await application.fetch(
      new Request(`${origin}/api/auth/cognito/preflight`, {
        headers: {
          "CF-Connecting-IP": "203.0.113.77",
          "X-Forwarded-For": allowedClientIp,
        },
      }),
      disabledBindings,
    );
    const start = await application.fetch(
      new Request(`${origin}/api/auth/cognito/start?audience=staff`, {
        headers: { "CF-Connecting-IP": allowedClientIp },
      }),
      disabledBindings,
    );

    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({
      signInEnabled: false,
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: { code: "sandbox_access_denied" },
    });
    expect(start.status).toBe(503);
    expect(await loginTransactionCount()).toBe(before);
  });

  it("binds client, state, nonce and PKCE to one browser-bound transaction", async () => {
    const identity = await createIdentity("global_admin");
    const result = await login("staff", identity.subject);

    expect(result.authorizationUrl.searchParams.get("client_id")).toBe(
      staffClientId,
    );
    expect(result.authorizationUrl.searchParams.get("acr_values")).toBe(
      "urn:cognito:loa:4",
    );
    expect(result.authorizationUrl.searchParams.get("max_age")).toBe("300");
    expect(result.authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(result.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.response.status).toBe(303);
    expect(result.response.headers.get("Location")).toBe(
      `${origin}/admin/question-editor`,
    );
    expect(result.response.headers.get("Set-Cookie")).toContain(
      "certpath_session=",
    );
    expect(result.response.headers.get("Cache-Control")).toContain("no-store");
    expect(await sessionCount(identity.userId)).toBe(1);
  });

  it("rejects callback state from another browser and consumes a successful transaction once", async () => {
    const identity = await createIdentity("global_admin");
    const pending = await beginLogin("staff", identity.subject);
    const callback = new URL("/api/auth/cognito/callback", origin);
    callback.searchParams.set("code", "synthetic-authorization-code");
    callback.searchParams.set("state", pending.state);
    const wrongBrowser = await fetchApi(
      new Request(callback, {
        headers: { Cookie: "certpath_login_wrong=wrong" },
      }),
    );
    expect(wrongBrowser.status).toBe(400);
    expect(await sessionCount(identity.userId)).toBe(0);

    const successful = await finishLogin(pending);
    expect(successful.response.status).toBe(303);
    expect(await sessionCount(identity.userId)).toBe(1);
    const replay = await fetchApi(
      new Request(callback, { headers: { Cookie: pending.cookie } }),
    );
    expect(replay.status).toBe(400);
    expect(await sessionCount(identity.userId)).toBe(1);
  });

  it("requires signed level-4 TOTP evidence for both D1 staff roles", async () => {
    for (const role of ["global_admin", "manager"] as const) {
      const identity = await createIdentity(role);
      const result = await login("staff", identity.subject);
      const rawCookie = sessionCookie(result.response);
      expect(result.response.status).toBe(303);
      expect(rawCookie).not.toBeNull();
      const tokenDigest = await sessionDigest(rawCookie!);
      const authorization = await authorizeGlobalAdmin(
        database,
        tokenDigest,
        Date.now(),
        { maxAgeMs: 300_000, allowedMethods: ["totp"] },
      );
      if (role === "global_admin") {
        expect(authorization.allowed).toBe(true);
      } else {
        expect(authorization).toEqual({
          allowed: false,
          reason: "insufficient-role",
        });
      }
      const stored = await database
        .prepare(
          "SELECT mfa_method, mfa_verified_at FROM app_sessions WHERE token_digest = ?",
        )
        .bind(tokenDigest)
        .first<{ mfa_method: string | null; mfa_verified_at: number | null }>();
      expect(stored?.mfa_method).toBe("totp");
      expect(stored?.mfa_verified_at).not.toBeNull();
    }
  });

  it("denies enrollment-only staff authentication then accepts a fresh returning login", async () => {
    const identity = await createIdentity("global_admin");
    const enrollment = await login("staff", identity.subject, {
      acr: "urn:cognito:loa:1",
      amr: ["pwd"],
    });
    expect(enrollment.response.status).toBe(401);
    expect(await sessionCount(identity.userId)).toBe(0);

    const returning = await login("staff", identity.subject);
    expect(returning.response.status).toBe(303);
    expect(await sessionCount(identity.userId)).toBe(1);
  });

  it("keeps Manager certification access governed by current D1 assignments", async () => {
    const identity = await createIdentity("manager");
    const assigned = await createTestCertification(database, identity.userId);
    const unassigned = await createTestCertification(database, identity.userId);
    await assignTestCertification(database, identity.userId, assigned);
    const result = await login("staff", identity.subject);
    const rawCookie = sessionCookie(result.response);
    expect(rawCookie).not.toBeNull();
    const tokenDigest = await sessionDigest(rawCookie!);
    const policy = { maxAgeMs: 300_000, allowedMethods: ["totp"] as const };
    expect(
      await authorizeCertification(
        database,
        tokenDigest,
        assigned,
        Date.now(),
        policy,
      ),
    ).toEqual({ allowed: true, userId: identity.userId, role: "manager" });
    expect(
      await authorizeCertification(
        database,
        tokenDigest,
        unassigned,
        Date.now(),
        policy,
      ),
    ).toEqual({ allowed: false, reason: "certification-unassigned" });

    const response = await fetchApi(
      new Request(`${origin}/api/admin/content/certifications`, {
        headers: { Cookie: `certpath_session=${rawCookie}` },
      }),
    );
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(assigned);
    expect(body).not.toContain(unassigned);
  });

  it("does not create staff sessions from missing, stale, enrollment-only or invalid claims", async () => {
    const cases: Array<{
      name: string;
      overrides: Record<string, unknown>;
      invalidSignature?: boolean;
    }> = [
      { name: "wrong nonce", overrides: { nonce: "different-nonce" } },
      { name: "wrong issuer", overrides: { iss: `${issuer}-wrong` } },
      { name: "learner audience", overrides: { aud: learnerClientId } },
      { name: "wrong token type", overrides: { token_use: "access" } },
      { name: "expired token", overrides: { exp: Math.floor(Date.now() / 1000) - 1 } },
      { name: "missing ACR", overrides: { acr: undefined } },
      { name: "missing AMR", overrides: { amr: undefined } },
      { name: "password-only enrollment", overrides: { acr: "urn:cognito:loa:1", amr: ["pwd"] } },
      { name: "stale auth_time", overrides: { auth_time: Math.floor(Date.now() / 1000) - 400 } },
      { name: "auth_time after token issue", overrides: { auth_time: Math.floor(Date.now() / 1000) + 60 } },
      { name: "refreshed token with original auth_time", overrides: { auth_time: Math.floor(Date.now() / 1000) - 400 } },
      { name: "invalid signature", overrides: {}, invalidSignature: true },
    ];
    for (const testCase of cases) {
      const identity = await createIdentity("global_admin");
      const result = await login(
        "staff",
        identity.subject,
        testCase.overrides,
        { invalidSignature: testCase.invalidSignature },
      );
      expect(result.response.status, testCase.name).toBe(401);
      expect(await sessionCount(identity.userId), testCase.name).toBe(0);
    }
  });

  it("creates a learner session only from the learner client and reaches the protected dashboard API", async () => {
    const allowedScope = await createContentScope(database);
    const deniedScope = await createContentScope(database);
    const subject = crypto.randomUUID();
    const result = await login("learner", subject);
    const rawCookie = sessionCookie(result.response);
    expect(result.response.status).toBe(303);
    expect(result.authorizationUrl.searchParams.get("client_id")).toBe(
      learnerClientId,
    );
    expect(result.authorizationUrl.searchParams.has("acr_values")).toBe(false);
    expect(rawCookie).not.toBeNull();
    const dashboard = await fetchApi(
      new Request(`${origin}/api/practice/dashboard`, {
        headers: { Cookie: `certpath_session=${rawCookie}` },
      }),
    );
    expect(dashboard.status).toBe(200);
    const newIdentity = await database
      .prepare("SELECT user_id FROM auth_identities WHERE issuer = ? AND subject = ?")
      .bind(issuer, subject)
      .first<{ user_id: string }>();
    expect(newIdentity?.user_id).toBeTruthy();
    const userId = newIdentity?.user_id ?? "";
    await grantTestLearnerAccess(database, userId, allowedScope.certificationId);
    const authorizedDashboard = await fetchApi(
      new Request(`${origin}/api/practice/dashboard`, {
        headers: { Cookie: `certpath_session=${rawCookie}` },
      }),
    );
    expect(authorizedDashboard.status).toBe(200);
    expect(await authorizedDashboard.json()).toMatchObject({
      groups: [
        {
          certificationId: allowedScope.certificationId,
          examVersionId: allowedScope.examVersionId,
        },
      ],
    });
    const deniedExamAttempts = await fetchApi(
      new Request(
        `${origin}/api/practice/attempts?certificationId=${deniedScope.certificationId}&examVersionId=${deniedScope.examVersionId}`,
        { headers: { Cookie: `certpath_session=${rawCookie}` } },
      ),
    );
    expect(deniedExamAttempts.status).toBe(403);
    const role = await database
      .prepare("SELECT 1 AS present FROM staff_roles WHERE user_id = ? AND active = 1")
      .bind(userId)
      .first<{ present: number }>();
    expect(role).toBeNull();
  });

  it("does not create a learner identity before email verification", async () => {
    const subject = crypto.randomUUID();
    const result = await login("learner", subject, { email_verified: false });
    expect(result.response.status).toBe(401);
    const identity = await database
      .prepare("SELECT 1 AS present FROM auth_identities WHERE issuer = ? AND subject = ?")
      .bind(issuer, subject)
      .first<{ present: number }>();
    expect(identity).toBeNull();
  });

  it("revokes its D1 session on CertPath logout", async () => {
    const identity = await createIdentity("global_admin");
    const result = await login("staff", identity.subject);
    const rawCookie = sessionCookie(result.response);
    expect(rawCookie).not.toBeNull();
    const cookie = `certpath_session=${rawCookie}`;
    const csrfResponse = await fetchApi(
      new Request(`${origin}/api/auth/cognito/csrf`, {
        headers: { Cookie: cookie },
      }),
    );
    const csrf = (await csrfResponse.json()) as { csrfToken: string };
    const logout = await fetchApi(
      new Request(`${origin}/api/auth/cognito/logout`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "X-CSRF-Token": csrf.csrfToken,
        },
      }),
    );
    expect(logout.status).toBe(204);
    const protectedResponse = await fetchApi(
      new Request(`${origin}/api/admin/content/certifications`, {
        headers: { Cookie: cookie },
      }),
    );
    expect(protectedResponse.status).toBe(401);
  });
});
