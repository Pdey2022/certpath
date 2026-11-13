import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/index.ts";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  googleIssuer,
  googleTokenEndpoint,
} from "../src/learner-google-oidc.ts";
import { grantTestLearnerAccess } from "./factories.ts";
import { createContentScope } from "./content-fixtures.ts";

const database: SecurityDatabase = env.DB;
const origin = "https://learner-auth-staging.certpath.workers.dev";
const clientId = "synthetic-google-client.apps.googleusercontent.com";
const clientSecret = "synthetic-google-client-secret-value";
const testerIps = Array.from({ length: 30 }, (_, index) => `198.51.100.${100 + index}`);
const blockedIp = "203.0.113.9";
const rateLimitIp = "198.51.100.199";
const jwksUrl = "https://www.googleapis.com/oauth2/v3/certs";

const bindings = {
  DB: database,
  PUBLIC_SITE_ORIGIN: origin,
  CSRF_HMAC_SECRET: "synthetic-google-csrf-secret-for-tests-only",
  STAGING_TESTER_IPS: [...testerIps, rateLimitIp].join(","),
  STAGING_AUTH_RATE_LIMIT_HMAC_SECRET:
    "synthetic-google-rate-limit-secret-for-tests-only",
  LEARNER_GOOGLE_OIDC_ENABLED: "true",
  GOOGLE_OIDC_CLIENT_ID: clientId,
  GOOGLE_OIDC_CLIENT_SECRET: clientSecret,
  GOOGLE_OIDC_REDIRECT_URI: `${origin}/api/auth/google/callback`,
  GOOGLE_OIDC_TRANSACTION_KEY:
    "synthetic-google-transaction-key-for-tests-only",
};

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

async function signIdToken(
  claims: Record<string, unknown>,
  options: { invalidSignature?: boolean } = {},
): Promise<string> {
  const header = encodeBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ alg: "RS256", typ: "JWT", kid: "synthetic-key" }),
    ),
  );
  const payload = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      signingKeys.privateKey,
      toArrayBuffer(new TextEncoder().encode(`${header}.${payload}`)),
    ),
  );
  let encoded = encodeBase64Url(signature);
  if (options.invalidSignature) {
    encoded = encoded[0] === "A" ? `B${encoded.slice(1)}` : `A${encoded.slice(1)}`;
  }
  return `${header}.${payload}.${encoded}`;
}

interface PendingCode {
  claims: Record<string, unknown>;
  invalidSignature: boolean;
}

class MockGoogleProvider {
  private readonly codes = new Map<string, PendingCode>();
  readonly calls: string[] = [];

  authorize(
    authorizationUrl: URL,
    subject: string,
    options: {
      claims?: Record<string, unknown>;
      invalidSignature?: boolean;
      invalidCode?: boolean;
    } = {},
  ): string {
    const code = crypto.randomUUID();
    this.calls.push("authorize");
    const nonce = authorizationUrl.searchParams.get("nonce") ?? "";
    const challenge = authorizationUrl.searchParams.get("code_challenge") ?? "";
    const nowSeconds = Math.floor(Date.now() / 1000);
    this.codes.set(code, {
      invalidSignature: options.invalidSignature ?? false,
      claims: {
        iss: googleIssuer,
        sub: subject,
        aud: clientId,
        azp: clientId,
        exp: nowSeconds + 900,
        iat: nowSeconds,
        nonce,
        email: "learner@example.test",
        email_verified: true,
        challenge,
        ...options.claims,
      },
    });
    return options.invalidCode ? `${code}-wrong` : code;
  }

  readonly fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.href === jwksUrl) {
      this.calls.push("jwks");
      return Response.json({ keys: [signingJwk] });
    }
    if (url.href !== googleTokenEndpoint) {
      this.calls.push(`unexpected:${url.href}`);
      return Response.json({ error: "unexpected_endpoint" }, { status: 404 });
    }
    this.calls.push("token");
    const form = new URLSearchParams(String(init?.body));
    const code = form.get("code") ?? "";
    const pending = this.codes.get(code);
    if (!pending) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    const challenge = encodeBase64Url(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          toArrayBuffer(
            new TextEncoder().encode(form.get("code_verifier") ?? ""),
          ),
        ),
      ),
    );
    if (
      form.get("grant_type") !== "authorization_code" ||
      form.get("client_id") !== clientId ||
      form.get("client_secret") !== clientSecret ||
      form.get("redirect_uri") !== `${origin}/api/auth/google/callback` ||
      challenge !== pending.claims.challenge
    ) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    this.codes.delete(code);
    const { challenge: _challenge, ...claims } = pending.claims;
    return Response.json({
      id_token: await signIdToken(claims, {
        invalidSignature: pending.invalidSignature,
      }),
    });
  }) as unknown as typeof fetch;
}

const provider = new MockGoogleProvider();
const application = createApi(provider.fetch);

let ipCursor = 0;
function nextIp(): string {
  ipCursor += 1;
  return testerIps[ipCursor % testerIps.length];
}

async function fetchApi(
  request: Request,
  clientIp: string,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set("CF-Connecting-IP", clientIp);
  return application.fetch(
    new Request(request, { headers }),
    bindings,
  );
}

interface PendingLogin {
  authorizationUrl: URL;
  cookie: string;
  state: string;
}

async function beginLogin(ip: string, path = "/api/auth/google/start") {
  const response = await fetchApi(new Request(`${origin}${path}`), ip);
  const authorizationUrl = new URL(
    response.headers.get("Location") ?? "https://invalid.example/",
  );
  return {
    status: response.status,
    authorizationUrl,
    state: authorizationUrl.searchParams.get("state") ?? "",
    nonce: authorizationUrl.searchParams.get("nonce") ?? "",
    cookie: (response.headers.get("Set-Cookie") ?? "").split(";")[0],
  };
}

function callbackRequest(state: string, code: string, cookie: string | null) {
  const headers = new Headers();
  if (cookie) headers.set("Cookie", cookie);
  return new Request(
    `${origin}/api/auth/google/callback?${new URLSearchParams({ state, code })}`,
    { headers },
  );
}

async function invitedLearner(subject: string) {
  const userId = crypto.randomUUID();
  const now = Date.now();
  await database
    .prepare(
      "INSERT INTO users (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)",
    )
    .bind(userId, now, now)
    .run();
  await database
    .prepare(
      "INSERT INTO auth_identities (issuer, subject, user_id, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(googleIssuer, subject, userId, now)
    .run();
  const scope = await createContentScope(database);
  await grantTestLearnerAccess(database, userId, scope.certificationId);
  return { userId, scope };
}

function sessionCookie(response: Response): string {
  const cookies = response.headers.getSetCookie?.() ?? [];
  const header = response.headers.get("Set-Cookie") ?? "";
  const match = (cookies.length ? cookies.join("\n") : header).match(
    /__Host-certpath_session=[A-Za-z0-9_-]{43}/,
  );
  return match?.[0] ?? "";
}

async function sessionCount(userId: string): Promise<number> {
  const row = await database
    .prepare("SELECT COUNT(*) AS total FROM app_sessions WHERE user_id = ?")
    .bind(userId)
    .first<{ total: number }>();
  return row?.total ?? 0;
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
  signingJwk = { ...exported, kid: "synthetic-key", use: "sig", alg: "RS256" };
});

describe("invite-only Google sign-in", () => {
  it("starts an authorization request bound to state, nonce and PKCE", async () => {
    const pending = await beginLogin(nextIp());
    expect(pending.status).toBe(302);
    expect(pending.authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(pending.authorizationUrl.searchParams.get("response_type")).toBe("code");
    expect(pending.authorizationUrl.searchParams.get("client_id")).toBe(clientId);
    expect(pending.authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${origin}/api/auth/google/callback`,
    );
    expect(pending.authorizationUrl.searchParams.get("scope")).toBe("openid email");
    expect(pending.authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(pending.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pending.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pending.cookie).toMatch(/^__Host-certpath_google_login=[A-Za-z0-9_-]{43}$/);
  });

  it("stays enabled while password sign-in and the Lambda verifier are unconfigured", async () => {
    const passwordlessBindings = {
      DB: database,
      PUBLIC_SITE_ORIGIN: origin,
      CSRF_HMAC_SECRET: "synthetic-google-csrf-secret-for-tests-only",
      STAGING_LEARNER_AUTH_ENABLED: "true",
      STAGING_LEARNER_EMAIL: "learner@example.test",
      STAGING_AUTH_RATE_LIMIT_HMAC_SECRET:
        "synthetic-google-rate-limit-secret-for-tests-only",
      LEARNER_GOOGLE_OIDC_ENABLED: "true",
      GOOGLE_OIDC_CLIENT_ID: clientId,
      GOOGLE_OIDC_CLIENT_SECRET: clientSecret,
      GOOGLE_OIDC_REDIRECT_URI: `${origin}/api/auth/google/callback`,
      GOOGLE_OIDC_TRANSACTION_KEY:
        "synthetic-google-transaction-key-for-tests-only",
    };
    const ip = nextIp();
    const allowed = { ...passwordlessBindings, STAGING_TESTER_IPS: ip };
    const send = (path: string) =>
      application.fetch(
        new Request(`${origin}${path}`, {
          headers: { "CF-Connecting-IP": ip },
        }),
        allowed,
      );

    const passwordPreflight = await send("/api/auth/staging/preflight");
    expect(passwordPreflight.status).toBe(200);
    expect(await passwordPreflight.json()).toMatchObject({
      signInEnabled: false,
    });

    const googlePreflight = await send("/api/auth/google/preflight");
    expect(googlePreflight.status).toBe(200);
    expect(await googlePreflight.json()).toEqual({
      signInEnabled: true,
      localMailboxEnabled: false,
    });

    const start = await send("/api/auth/google/start");
    expect(start.status).toBe(302);
    const authorizeUrl = new URL(start.headers.get("Location") ?? "");
    expect(authorizeUrl.origin).toBe("https://accounts.google.com");
    expect(authorizeUrl.searchParams.get("client_id")).toBe(clientId);
    expect(authorizeUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(start.headers.get("Set-Cookie")).toContain(
      "__Host-certpath_google_login=",
    );
  });

  it("signs in the invited learner and authorizes only the granted exam", async () => {
    const subject = `google-${crypto.randomUUID()}`;
    const { userId } = await invitedLearner(subject);
    const pending = await beginLogin(nextIp());
    const code = provider.authorize(pending.authorizationUrl, subject);

    const callback = await fetchApi(
      callbackRequest(pending.state, code, pending.cookie),
      nextIp(),
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("Location")).toBe(`${origin}/app/home`);
    const cookie = sessionCookie(callback);
    expect(cookie).toContain("__Host-certpath_session=");
    expect(callback.headers.get("Set-Cookie")).toContain("Secure");
    expect(callback.headers.get("Set-Cookie")).toContain("HttpOnly");

    const dashboard = await fetchApi(
      new Request(`${origin}/api/practice/dashboard`, {
        headers: { Cookie: cookie },
      }),
      nextIp(),
    );
    expect(dashboard.status).toBe(200);
    expect(await dashboard.json()).toMatchObject({ groups: [{ certificationId: expect.any(String) }] });
    expect(await sessionCount(userId)).toBe(1);

    const consumed = await database
      .prepare(
        "SELECT COUNT(*) AS total FROM learner_google_login_transactions WHERE consumed_at IS NOT NULL",
      )
      .first<{ total: number }>();
    expect(consumed?.total).toBe(0);
  });

  it("denies an uninvited Google identity without creating an account", async () => {
    const before = await database
      .prepare("SELECT COUNT(*) AS total FROM auth_identities")
      .first<{ total: number }>();
    const pending = await beginLogin(nextIp());
    const code = provider.authorize(
      pending.authorizationUrl,
      `stranger-${crypto.randomUUID()}`,
    );
    const callback = await fetchApi(
      callbackRequest(pending.state, code, pending.cookie),
      nextIp(),
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("Location")).toBe(
      `${origin}/sign-in?error=not_invited`,
    );
    expect(sessionCookie(callback)).toBe("");
    const after = await database
      .prepare("SELECT COUNT(*) AS total FROM auth_identities")
      .first<{ total: number }>();
    expect(after?.total).toBe(before?.total);
  });

  it("does not link by email when the subject is not invited", async () => {
    const subject = `google-${crypto.randomUUID()}`;
    const { userId } = await invitedLearner(subject);
    const pending = await beginLogin(nextIp());
    const code = provider.authorize(
      pending.authorizationUrl,
      `other-${crypto.randomUUID()}`,
      { claims: { email: "learner@example.test" } },
    );
    const callback = await fetchApi(
      callbackRequest(pending.state, code, pending.cookie),
      nextIp(),
    );
    expect(callback.headers.get("Location")).toBe(
      `${origin}/sign-in?error=not_invited`,
    );
    expect(await sessionCount(userId)).toBe(0);
  });

  it("rejects an unknown state before any token exchange", async () => {
    const tokenCallsBefore = provider.calls.filter((call) => call === "token").length;
    const response = await fetchApi(
      callbackRequest("A".repeat(43), "synthetic-code", null),
      nextIp(),
    );
    expect(response.status).toBe(400);
    expect(
      provider.calls.filter((call) => call === "token").length,
    ).toBe(tokenCallsBefore);
  });

  it("rejects a callback without the browser binding cookie", async () => {
    const subject = `google-${crypto.randomUUID()}`;
    await invitedLearner(subject);
    const pending = await beginLogin(nextIp());
    const code = provider.authorize(pending.authorizationUrl, subject);
    const response = await fetchApi(
      callbackRequest(pending.state, code, null),
      nextIp(),
    );
    expect(response.status).toBe(400);
  });

  it("consumes the callback once and rejects a replay", async () => {
    const subject = `google-${crypto.randomUUID()}`;
    const { userId } = await invitedLearner(subject);
    const pending = await beginLogin(nextIp());
    const code = provider.authorize(pending.authorizationUrl, subject);
    const first = await fetchApi(
      callbackRequest(pending.state, code, pending.cookie),
      nextIp(),
    );
    expect(first.status).toBe(303);
    const replay = await fetchApi(
      callbackRequest(pending.state, code, pending.cookie),
      nextIp(),
    );
    expect(replay.status).toBe(400);
    expect(await sessionCount(userId)).toBe(1);
  });

  it("consumes concurrent callbacks atomically", async () => {
    const subject = `google-${crypto.randomUUID()}`;
    const { userId } = await invitedLearner(subject);
    const pending = await beginLogin(nextIp());
    const firstCode = provider.authorize(pending.authorizationUrl, subject);
    const secondCode = provider.authorize(pending.authorizationUrl, subject);
    const [a, b] = await Promise.all([
      fetchApi(callbackRequest(pending.state, firstCode, pending.cookie), nextIp()),
      fetchApi(callbackRequest(pending.state, secondCode, pending.cookie), nextIp()),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([303, 400]);
    expect(await sessionCount(userId)).toBe(1);
  });

  const invalidClaimCases: Array<[string, (claims: Record<string, unknown>) => Record<string, unknown>]> = [
    ["wrong issuer", (claims) => ({ ...claims, iss: "https://evil.example" })],
    ["wrong audience", (claims) => ({ ...claims, aud: "someone-else.apps.googleusercontent.com" })],
    ["wrong azp", (claims) => ({ ...claims, azp: "someone-else.apps.googleusercontent.com" })],
    ["expired", (claims) => ({ ...claims, exp: Math.floor(Date.now() / 1000) - 5 })],
    ["unverified email", (claims) => ({ ...claims, email_verified: false })],
    ["wrong nonce", (claims) => ({ ...claims, nonce: "A".repeat(43) })],
  ];

  for (const [label, mutate] of invalidClaimCases) {
    it(`rejects an ID token with ${label}`, async () => {
      const subject = `google-${crypto.randomUUID()}`;
      const { userId } = await invitedLearner(subject);
      const pending = await beginLogin(nextIp());
      const code = provider.authorize(pending.authorizationUrl, subject, {
        claims: mutate({
          iss: googleIssuer,
          sub: subject,
          aud: clientId,
          azp: clientId,
          exp: Math.floor(Date.now() / 1000) + 900,
          iat: Math.floor(Date.now() / 1000),
          nonce: pending.nonce,
          email_verified: true,
        }),
      });
      const callback = await fetchApi(
        callbackRequest(pending.state, code, pending.cookie),
        nextIp(),
      );
      expect(callback.headers.get("Location")).toBe(
        `${origin}/sign-in?error=invalid_identity_token`,
      );
      expect(sessionCookie(callback)).toBe("");
      expect(await sessionCount(userId)).toBe(0);
    });
  }

  it("rejects an ID token with an invalid signature", async () => {
    const subject = `google-${crypto.randomUUID()}`;
    const { userId } = await invitedLearner(subject);
    const pending = await beginLogin(nextIp());
    const code = provider.authorize(pending.authorizationUrl, subject, {
      invalidSignature: true,
    });
    const callback = await fetchApi(
      callbackRequest(pending.state, code, pending.cookie),
      nextIp(),
    );
    expect(callback.headers.get("Location")).toBe(
      `${origin}/sign-in?error=invalid_identity_token`,
    );
    expect(await sessionCount(userId)).toBe(0);
  });

  it("blocks an unlisted tester before D1 or Google work", async () => {
    const callsBefore = provider.calls.length;
    const transactionsBefore = await database
      .prepare("SELECT COUNT(*) AS total FROM learner_google_login_transactions")
      .first<{ total: number }>();
    const start = await fetchApi(
      new Request(`${origin}/api/auth/google/start`),
      blockedIp,
    );
    expect(start.status).toBe(403);
    const callback = await fetchApi(
      callbackRequest("A".repeat(43), "synthetic-code", null),
      blockedIp,
    );
    expect(callback.status).toBe(403);
    expect(provider.calls.length).toBe(callsBefore);
    const transactionsAfter = await database
      .prepare("SELECT COUNT(*) AS total FROM learner_google_login_transactions")
      .first<{ total: number }>();
    expect(transactionsAfter?.total).toBe(transactionsBefore?.total);
  });

  it("rate limits sign-in starts per client", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await fetchApi(
        new Request(`${origin}/api/auth/google/start`),
        rateLimitIp,
      );
      expect(response.status).toBe(302);
    }
    const limited = await fetchApi(
      new Request(`${origin}/api/auth/google/start`),
      rateLimitIp,
    );
    expect(limited.status).toBe(429);
  });

  it("revokes the session and clears the cookie on logout", async () => {
    const subject = `google-${crypto.randomUUID()}`;
    const { userId } = await invitedLearner(subject);
    const pending = await beginLogin(nextIp());
    const code = provider.authorize(pending.authorizationUrl, subject);
    const callback = await fetchApi(
      callbackRequest(pending.state, code, pending.cookie),
      nextIp(),
    );
    expect(callback.status).toBe(303);
    const cookie = sessionCookie(callback);

    const csrfResponse = await fetchApi(
      new Request(`${origin}/api/auth/session/csrf`, {
        headers: { Cookie: cookie },
      }),
      nextIp(),
    );
    expect(csrfResponse.status).toBe(200);
    const csrf = (await csrfResponse.json()) as { csrfToken: string };

    const logout = await fetchApi(
      new Request(`${origin}/api/auth/session/logout`, {
        body: undefined,
        headers: {
          Cookie: cookie,
          Origin: origin,
          "X-CSRF-Token": csrf.csrfToken,
        },
        method: "POST",
      }),
      nextIp(),
    );
    expect(logout.status).toBe(204);
    expect(logout.headers.get("Set-Cookie")).toContain(
      "__Host-certpath_session=; Path=/; Max-Age=0; HttpOnly; Secure;",
    );

    const dashboard = await fetchApi(
      new Request(`${origin}/api/practice/dashboard`, {
        headers: { Cookie: cookie },
      }),
      nextIp(),
    );
    expect(dashboard.status).toBe(401);

    const stored = await database
      .prepare(
        "SELECT revoked_at FROM app_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .bind(userId)
      .first<{ revoked_at: number | null }>();
    expect(stored?.revoked_at).not.toBeNull();
  }, 30_000);
});
