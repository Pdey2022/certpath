import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/index.ts";
import type { SecurityDatabase } from "../src/security/database.ts";
import { sessionDigest } from "../src/security/http-session.ts";
import {
  createTestIdentity,
  grantTestRole,
  grantTestLearnerAccess,
} from "./factories.ts";
import { createContentScope } from "./content-fixtures.ts";

const database: SecurityDatabase = env.DB;
const origin = "https://certpath.example.test";
const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_testpool";
const domain = "https://certpath-test.auth.us-east-1.amazoncognito.com";
const learnerClientId = "synthetic-learner-client";
const allowedClientIp = "198.51.100.10";
const bindings = {
  DB: database,
  PUBLIC_SITE_ORIGIN: origin,
  CSRF_HMAC_SECRET: "synthetic-csrf-secret-for-worker-tests-only",
  COGNITO_LEARNER_SANDBOX_ENABLED: "true",
  COGNITO_LEARNER_ALLOWED_CLIENT_IPS: allowedClientIp,
  COGNITO_LEARNER_ISSUER: issuer,
  COGNITO_LEARNER_DOMAIN: domain,
  COGNITO_LEARNER_CALLBACK_URL: `${origin}/api/auth/cognito/callback`,
  COGNITO_LEARNER_CLIENT_ID: learnerClientId,
  COGNITO_LEARNER_TRANSACTION_ENCRYPTION_KEY:
    "synthetic-transaction-encryption-key-for-tests-only",
};

interface SimulatedAccount {
  email: string;
  password: string;
  subject: string;
  emailVerified: boolean;
  resetRequested: boolean;
}

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  claims: Record<string, unknown>;
  invalidSignature: boolean;
}

let signingKeys: CryptoKeyPair;
let signingJwk: JsonWebKey & { kid: string; use: string; alg: string };

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

async function signToken(
  claims: Record<string, unknown>,
  invalidSignature: boolean,
): Promise<string> {
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
  if (invalidSignature) {
    encodedSignature =
      encodedSignature[0] === "A"
        ? `B${encodedSignature.slice(1)}`
        : `A${encodedSignature.slice(1)}`;
  }
  return `${header}.${payload}.${encodedSignature}`;
}

class SimulatedHostedProvider {
  private readonly accounts = new Map<string, SimulatedAccount>();
  private readonly authorizationCodes = new Map<string, AuthorizationCode>();

  register(email: string, password: string, subject?: string) {
    const identitySubject = subject ?? crypto.randomUUID();
    this.accounts.set(identitySubject, {
      email,
      password,
      subject: identitySubject,
      emailVerified: false,
      resetRequested: false,
    });
    return identitySubject;
  }

  verifyEmail(subject: string): void {
    const account = this.requireAccount(subject);
    account.emailVerified = true;
  }

  requestPasswordReset(subject: string): void {
    const account = this.requireAccount(subject);
    if (!account.emailVerified) throw new Error("email_not_verified");
    account.resetRequested = true;
  }

  completePasswordReset(subject: string, newPassword: string): void {
    const account = this.requireAccount(subject);
    if (!account.resetRequested) throw new Error("reset_not_requested");
    account.password = newPassword;
    account.resetRequested = false;
  }

  authenticate(subject: string, password: string): boolean {
    const account = this.accounts.get(subject);
    return Boolean(
      account &&
        account.emailVerified &&
        account.password === password,
    );
  }

  authorize(
    authorizationUrl: URL,
    subject: string,
    password: string,
    options: {
      claims?: Record<string, unknown>;
      invalidSignature?: boolean;
      allowUnverifiedForGuardTest?: boolean;
    } = {},
  ): string {
    const account = this.requireAccount(subject);
    if (!this.authenticate(subject, password)) {
      if (
        !options.allowUnverifiedForGuardTest ||
        account.password !== password
      ) {
        throw new Error("provider_authentication_failed");
      }
    }

    const clientId = authorizationUrl.searchParams.get("client_id") ?? "";
    const nonce = authorizationUrl.searchParams.get("nonce") ?? "";
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri") ?? "";
    const codeChallenge = authorizationUrl.searchParams.get("code_challenge") ?? "";
    if (
      authorizationUrl.origin !== domain ||
      authorizationUrl.pathname !== "/oauth2/authorize" ||
      authorizationUrl.searchParams.get("response_type") !== "code" ||
      clientId !== learnerClientId ||
      !nonce ||
      redirectUri !== `${origin}/api/auth/cognito/callback` ||
      authorizationUrl.searchParams.get("code_challenge_method") !== "S256" ||
      !codeChallenge
    ) {
      throw new Error("invalid_hosted_authorization_request");
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const code = crypto.randomUUID();
    this.authorizationCodes.set(code, {
      clientId,
      redirectUri,
      codeChallenge,
      invalidSignature: options.invalidSignature ?? false,
      claims: {
        iss: issuer,
        sub: account.subject,
        aud: learnerClientId,
        exp: nowSeconds + 900,
        iat: nowSeconds,
        token_use: "id",
        nonce,
        email: account.email,
        email_verified: account.emailVerified,
        ...options.claims,
      },
    });
    return code;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.href === `${issuer}/.well-known/jwks.json`) {
      return Response.json({ keys: [signingJwk] });
    }
    if (url.origin !== domain || url.pathname !== "/oauth2/token") {
      return Response.json({ error: "unexpected_provider_endpoint" }, { status: 404 });
    }

    const form = new URLSearchParams(init?.body as URLSearchParams);
    const code = form.get("code") ?? "";
    const authorization = this.authorizationCodes.get(code);
    if (!authorization) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    const verifier = form.get("code_verifier") ?? "";
    const challenge = encodeBase64Url(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          toArrayBuffer(new TextEncoder().encode(verifier)),
        ),
      ),
    );
    if (
      form.get("grant_type") !== "authorization_code" ||
      form.get("client_id") !== authorization.clientId ||
      form.get("redirect_uri") !== authorization.redirectUri ||
      challenge !== authorization.codeChallenge
    ) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    this.authorizationCodes.delete(code);
    return Response.json({
      id_token: await signToken(
        authorization.claims,
        authorization.invalidSignature,
      ),
    });
  };

  private requireAccount(subject: string): SimulatedAccount {
    const account = this.accounts.get(subject);
    if (!account) throw new Error("account_not_found");
    return account;
  }
}

const provider = new SimulatedHostedProvider();
const application = createApi(provider.fetch);

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

interface PendingLogin {
  authorizationUrl: URL;
  cookie: string;
  state: string;
}

async function beginLogin(): Promise<PendingLogin> {
  const response = await fetchApi(
    new Request(`${origin}/api/auth/cognito/start`),
  );
  const authorizationUrl = new URL(response.headers.get("Location") ?? origin);
  const state = authorizationUrl.searchParams.get("state") ?? "";
  const cookie = (response.headers.get("Set-Cookie") ?? "").split(";")[0];
  return { authorizationUrl, cookie, state };
}

async function finishLogin(
  pending: PendingLogin,
  code: string,
  cookie = pending.cookie,
): Promise<Response> {
  const callbackUrl = new URL("/api/auth/cognito/callback", origin);
  callbackUrl.searchParams.set("code", code);
  callbackUrl.searchParams.set("state", pending.state);
  return fetchApi(new Request(callbackUrl, { headers: { Cookie: cookie } }));
}

async function login(
  subject: string,
  password: string,
  options: Parameters<SimulatedHostedProvider["authorize"]>[3] = {},
): Promise<Response> {
  const pending = await beginLogin();
  const code = provider.authorize(
    pending.authorizationUrl,
    subject,
    password,
    options,
  );
  return finishLogin(pending, code);
}

function sessionCookie(response: Response): string | null {
  const value = response.headers.get("Set-Cookie") ?? "";
  const match = /(?:^|,\s*)certpath_session=([^;,]+)/.exec(value);
  return match?.[1] ?? null;
}

async function userIdFor(subject: string): Promise<string | null> {
  const identity = await database
    .prepare("SELECT user_id FROM auth_identities WHERE issuer = ? AND subject = ?")
    .bind(issuer, subject)
    .first<{ user_id: string }>();
  return identity?.user_id ?? null;
}

async function sessionCountForSubject(subject: string): Promise<number> {
  const result = await database
    .prepare(
      `SELECT COUNT(*) AS count
       FROM app_sessions AS session
       JOIN auth_identities AS identity ON identity.user_id = session.user_id
       WHERE identity.issuer = ? AND identity.subject = ?`,
    )
    .bind(issuer, subject)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

async function loginTransactionCount(): Promise<number> {
  const result = await database
    .prepare("SELECT COUNT(*) AS count FROM cognito_learner_login_transactions")
    .first<{ count: number }>();
  return result?.count ?? 0;
}

describe("learner-only hosted email sign-in", () => {
  it("starts only the learner-client flow and binds state, nonce and PKCE", async () => {
    const pending = await beginLogin();
    expect(pending.authorizationUrl.origin).toBe(domain);
    expect(pending.authorizationUrl.pathname).toBe("/oauth2/authorize");
    expect(pending.authorizationUrl.searchParams.get("client_id")).toBe(
      learnerClientId,
    );
    expect(pending.authorizationUrl.searchParams.get("response_type")).toBe("code");
    expect(pending.authorizationUrl.searchParams.get("scope")).toBe("openid email");
    expect(pending.authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(pending.authorizationUrl.searchParams.get("state")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(pending.authorizationUrl.searchParams.get("nonce")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(pending.authorizationUrl.searchParams.has("audience")).toBe(false);
    expect(pending.cookie).toContain("certpath_learner_login_");
    expect(await loginTransactionCount()).toBeGreaterThan(0);
  });

  it("rejects a staff login intent before writing a transaction", async () => {
    const before = await loginTransactionCount();
    const response = await fetchApi(
      new Request(`${origin}/api/auth/cognito/start?audience=staff`),
    );
    expect(response.status).toBe(400);
    expect(await loginTransactionCount()).toBe(before);
  });

  it("denies unlisted IPs before D1 writes and ignores forwarded headers", async () => {
    const before = await loginTransactionCount();
    const response = await fetchApi(
      new Request(`${origin}/api/auth/cognito/start`, {
        headers: { "X-Forwarded-For": allowedClientIp },
      }),
      "203.0.113.77",
    );
    expect(response.status).toBe(403);
    expect(await loginTransactionCount()).toBe(before);
  });

  it("rejects an unverified email before creating an identity or session", async () => {
    const subject = provider.register("learner-one@example.test", "synthetic-pass");
    const pending = await beginLogin();
    const code = provider.authorize(
      pending.authorizationUrl,
      subject,
      "synthetic-pass",
      { allowUnverifiedForGuardTest: true },
    );
    const response = await finishLogin(pending, code);

    expect(response.status).toBe(401);
    expect(await userIdFor(subject)).toBeNull();
    expect(await sessionCountForSubject(subject)).toBe(0);
  });

  it("signs in a verified learner, enforces exam grants, and creates no staff role", async () => {
    const subject = provider.register("learner-two@example.test", "synthetic-pass");
    provider.verifyEmail(subject);
    expect(provider.authenticate(subject, "synthetic-pass")).toBe(true);

    const response = await login(subject, "synthetic-pass");
    expect(response.status, await response.clone().text()).toBe(303);
    expect(response.headers.get("Location")).toBe(`${origin}/app/home`);
    const rawCookie = sessionCookie(response);
    expect(rawCookie).not.toBeNull();

    const userId = await userIdFor(subject);
    expect(userId).not.toBeNull();
    const staffRole = await database
      .prepare("SELECT 1 AS present FROM staff_roles WHERE user_id = ?")
      .bind(userId)
      .first<{ present: number }>();
    expect(staffRole).toBeNull();

    const cookie = `certpath_session=${rawCookie}`;
    const dashboardUrl = `${origin}/api/practice/dashboard`;
    const noAccess = await fetchApi(
      new Request(dashboardUrl, { headers: { Cookie: cookie } }),
    );
    expect(noAccess.status).toBe(200);
    expect(await noAccess.json()).toMatchObject({ groups: [] });

    const grantedScope = await createContentScope(database);
    const deniedScope = await createContentScope(database);
    await grantTestLearnerAccess(
      database,
      userId!,
      grantedScope.certificationId,
    );
    const granted = await fetchApi(
      new Request(dashboardUrl, { headers: { Cookie: cookie } }),
    );
    expect(granted.status).toBe(200);
    expect(await granted.json()).toMatchObject({
      groups: [
        {
          certificationId: grantedScope.certificationId,
          examVersionId: grantedScope.examVersionId,
        },
      ],
    });

    const denied = await fetchApi(
      new Request(
        `${origin}/api/practice/attempts?certificationId=${deniedScope.certificationId}&examVersionId=${deniedScope.examVersionId}`,
        { headers: { Cookie: cookie } },
      ),
    );
    expect(denied.status).toBe(403);
  });

  it("uses the provider's reset flow before signing in with the new password", async () => {
    const subject = provider.register("learner-reset@example.test", "old-synthetic-pass");
    provider.verifyEmail(subject);
    provider.requestPasswordReset(subject);
    provider.completePasswordReset(subject, "new-synthetic-pass");
    expect(provider.authenticate(subject, "old-synthetic-pass")).toBe(false);
    expect(provider.authenticate(subject, "new-synthetic-pass")).toBe(true);

    const response = await login(subject, "new-synthetic-pass");
    expect(response.status).toBe(303);
    expect(await userIdFor(subject)).not.toBeNull();
  });

  it("rejects wrong issuer, client, expiry, token use, nonce and signature", async () => {
    const invalidTokens: Array<{
      name: string;
      claims?: Record<string, unknown>;
      invalidSignature?: boolean;
    }> = [
      { name: "issuer", claims: { iss: `${issuer}-wrong` } },
      { name: "client", claims: { aud: "synthetic-staff-client" } },
      { name: "expiry", claims: { exp: Math.floor(Date.now() / 1000) - 1 } },
      { name: "token use", claims: { token_use: "access" } },
      { name: "nonce", claims: { nonce: "different-transaction-nonce" } },
      { name: "signature", invalidSignature: true },
    ];

    for (const invalid of invalidTokens) {
      const subject = provider.register(
        `invalid-${invalid.name}@example.test`,
        "synthetic-pass",
      );
      provider.verifyEmail(subject);
      const response = await login(subject, "synthetic-pass", {
        claims: invalid.claims,
        invalidSignature: invalid.invalidSignature,
      });
      expect(response.status, invalid.name).toBe(401);
      expect(await userIdFor(subject), invalid.name).toBeNull();
      expect(await sessionCountForSubject(subject), invalid.name).toBe(0);
    }
  });

  it("consumes callbacks once and does not link different subjects by email", async () => {
    const sharedEmail = "same-email@example.test";
    const firstSubject = provider.register(sharedEmail, "synthetic-pass");
    const secondSubject = provider.register(sharedEmail, "synthetic-pass");
    provider.verifyEmail(firstSubject);
    provider.verifyEmail(secondSubject);

    const pending = await beginLogin();
    const code = provider.authorize(
      pending.authorizationUrl,
      firstSubject,
      "synthetic-pass",
    );
    const successful = await finishLogin(pending, code);
    expect(successful.status).toBe(303);
    const replay = await finishLogin(pending, code);
    expect(replay.status).toBe(400);

    const secondLogin = await login(secondSubject, "synthetic-pass");
    expect(secondLogin.status).toBe(303);
    const firstUserId = await userIdFor(firstSubject);
    const secondUserId = await userIdFor(secondSubject);
    expect(firstUserId).not.toBeNull();
    expect(secondUserId).not.toBeNull();
    expect(secondUserId).not.toBe(firstUserId);
  });

  it("does not issue a learner session for an identity with a staff role", async () => {
    const identity = await createTestIdentity(database);
    await database
      .prepare(
        "UPDATE auth_identities SET issuer = ?, subject = ? WHERE issuer = ? AND subject = ?",
      )
      .bind(issuer, identity.subject, identity.issuer, identity.subject)
      .run();
    await grantTestRole(database, identity.userId, "manager");
    const subject = provider.register(
      "staff-alias@example.test",
      "synthetic-pass",
      identity.subject,
    );
    provider.verifyEmail(subject);

    const response = await login(subject, "synthetic-pass");
    expect(response.status).toBe(403);
    expect(await sessionCountForSubject(subject)).toBe(0);
  });

  it("revokes the D1 session on CertPath logout", async () => {
    const subject = provider.register("learner-logout@example.test", "synthetic-pass");
    provider.verifyEmail(subject);
    const response = await login(subject, "synthetic-pass");
    const rawCookie = sessionCookie(response);
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

    const dashboard = await fetchApi(
      new Request(`${origin}/api/practice/dashboard`, {
        headers: { Cookie: cookie },
      }),
    );
    expect(dashboard.status).toBe(401);
    const identityUserId = await userIdFor(subject);
    expect(identityUserId).not.toBeNull();
    const digest = await sessionDigest(rawCookie!);
    const stored = await database
      .prepare("SELECT revoked_at FROM app_sessions WHERE token_digest = ?")
      .bind(digest)
      .first<{ revoked_at: number | null }>();
    expect(stored?.revoked_at).not.toBeNull();
  });
});
