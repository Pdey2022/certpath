import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../src/index.ts";
import {
  stagingLearnerAuthOrigin,
  stagingPasswordIssuer,
} from "../src/local-learner-auth.ts";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  createLambdaPasswordVerifier,
} from "../src/security/lambda-password-verifier.ts";
import { hashLearnerPassword } from "../src/security/password-hashing.ts";
import { grantTestLearnerAccess } from "./factories.ts";
import { createContentScope } from "./content-fixtures.ts";

const database: SecurityDatabase = env.DB;
const testerIp = "198.51.100.57";
const functionUrl = "https://staging-test.lambda-url.eu-north-1.on.aws/";

describe("staging learner authentication", () => {
  it("gates early, signs in one synthetic learner, limits attempts, and revokes logout", async () => {
    const now = Date.now();
    const address = `staging-${crypto.randomUUID()}@example.test`;
    const password = `synthetic-${crypto.randomUUID()}-password`;
    const passwordHash = await hashLearnerPassword(password);
    const userId = crypto.randomUUID();
    const subject = crypto.randomUUID();
    await database
      .prepare(
        "INSERT INTO users (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)",
      )
      .bind(userId, now, now)
      .run();
    await database
      .prepare(
        `INSERT INTO auth_identities (issuer, subject, user_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(stagingPasswordIssuer, subject, userId, now)
      .run();
    await database
      .prepare(
        `INSERT INTO learner_password_credentials (
           user_id, email, email_normalized, subject, password_hash,
           email_verified_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(userId, address, address, subject, passwordHash, now, now, now)
      .run();

    const scope = await createContentScope(database);
    await grantTestLearnerAccess(database, userId, scope.certificationId);

    const verifier = vi.fn(
      async (submittedPassword: string, encodedHash: string) =>
        submittedPassword === password && encodedHash === passwordHash,
    );
    const application = createApi(fetch, () => now, verifier);
    const bindings = {
      DB: database,
      PUBLIC_SITE_ORIGIN: stagingLearnerAuthOrigin,
      CSRF_HMAC_SECRET: "staging-test-csrf-secret-with-enough-entropy",
      STAGING_LEARNER_AUTH_ENABLED: "true",
      STAGING_TESTER_IPS: testerIp,
      STAGING_AUTH_RATE_LIMIT_HMAC_SECRET:
        "staging-test-rate-limit-secret-with-enough-entropy",
      STAGING_LEARNER_EMAIL: address,
      AWS_ACCESS_KEY_ID: "AKIAFIXTUREACCESS00",
      AWS_REGION: "eu-north-1",
      AWS_SECRET_ACCESS_KEY: "fixture-secret-access-key-not-real",
      AWS_SESSION_TOKEN: "fixture-session-token-not-real",
      LAMBDA_FUNCTION_URL: functionUrl,
    };

    async function request(
      path: string,
      options: {
        body?: unknown;
        headers?: Record<string, string>;
        method?: string;
      } = {},
    ) {
      const headers = new Headers(options.headers);
      headers.set("CF-Connecting-IP", testerIp);
      if (options.body !== undefined) {
        headers.set("Content-Type", "application/json");
      }
      return application.fetch(
        new Request(`${stagingLearnerAuthOrigin}/api${path}`, {
          body:
            options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
          headers,
          method: options.method ?? "GET",
        }),
        bindings,
      );
    }

    const unauthorized = await application.fetch(
      new Request(`${stagingLearnerAuthOrigin}/api/auth/staging/preflight`, {
        headers: { "CF-Connecting-IP": "198.51.100.58" },
      }),
      bindings,
    );
    expect(unauthorized.status).toBe(403);
    expect(verifier.mock.calls.length).toBe(0);

    const invalidOrigin = await request("/auth/staging/sign-in", {
      body: { email: address, password },
      headers: { Origin: "https://untrusted.example" },
      method: "POST",
    });
    expect(invalidOrigin.status).toBe(403);
    expect(verifier.mock.calls.length).toBe(0);

    const missingCsrf = await request("/auth/staging/sign-in", {
      body: { email: address, password },
      headers: { Origin: stagingLearnerAuthOrigin },
      method: "POST",
    });
    expect(missingCsrf.status).toBe(400);
    expect(verifier.mock.calls.length).toBe(0);

    const csrfResponse = await request("/auth/staging/csrf", {
      headers: { Origin: stagingLearnerAuthOrigin },
    });
    expect(csrfResponse.status).toBe(200);
    const csrf = (await csrfResponse.json()) as { csrfToken: string };
    const csrfCookie = csrfResponse.headers
      .get("set-cookie")
      ?.match(/__Host-certpath_signin_csrf=([A-Za-z0-9_-]{43})/)?.[0];
    expect(Boolean(csrfCookie)).toBe(true);

    const signInHeaders = {
      Cookie: csrfCookie!,
      Origin: stagingLearnerAuthOrigin,
      "X-CSRF-Token": csrf.csrfToken,
    };
    const signedIn = await request("/auth/staging/sign-in", {
      body: { email: address, password },
      headers: signInHeaders,
      method: "POST",
    });
    expect(signedIn.status).toBe(200);
    expect(verifier.mock.calls.length).toBe(1);
    const sessionCookie = signedIn.headers
      .get("set-cookie")
      ?.match(/__Host-certpath_session=([A-Za-z0-9_-]{43})/)?.[0];
    expect(Boolean(sessionCookie)).toBe(true);
    expect(
      signedIn.headers.get("set-cookie")?.includes("Secure") ?? false,
    ).toBe(true);

    const dashboard = await request("/practice/dashboard", {
      headers: { Cookie: sessionCookie! },
    });
    expect(dashboard.status).toBe(200);
    expect(await dashboard.json()).toMatchObject({
      groups: [
        {
          certificationId: scope.certificationId,
          examVersionId: scope.examVersionId,
        },
      ],
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const wrongPassword = await request("/auth/staging/sign-in", {
        body: { email: address, password: `${password}-wrong` },
        headers: signInHeaders,
        method: "POST",
      });
      expect(wrongPassword.status).toBe(401);
    }
    expect(verifier.mock.calls.length).toBe(5);

    const rateLimited = await request("/auth/staging/sign-in", {
      body: { email: address, password },
      headers: signInHeaders,
      method: "POST",
    });
    expect(rateLimited.status).toBe(429);
    expect(verifier.mock.calls.length).toBe(5);

    const sessionCsrfResponse = await request("/auth/session/csrf", {
      headers: { Cookie: sessionCookie! },
    });
    expect(sessionCsrfResponse.status).toBe(200);
    const sessionCsrf = (await sessionCsrfResponse.json()) as {
      csrfToken: string;
    };
    const logout = await request("/auth/session/logout", {
      headers: {
        Cookie: sessionCookie!,
        Origin: stagingLearnerAuthOrigin,
        "X-CSRF-Token": sessionCsrf.csrfToken,
      },
      method: "POST",
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain(
      "__Host-certpath_session=; Path=/; Max-Age=0; HttpOnly; Secure;",
    );
    expect((await request("/practice/dashboard", {
      headers: { Cookie: sessionCookie! },
    })).status).toBe(401);
    const storedSession = await database
      .prepare(
        "SELECT revoked_at FROM app_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .bind(userId)
      .first<{ revoked_at: number | null }>();
    expect(storedSession?.revoked_at).not.toBeNull();
    expect(verifier.mock.calls.length).toBe(5);
  }, 30_000);
});

describe("staging Lambda password verifier", () => {
  it("uses only the explicitly supplied local Worker stub in local-test mode", async () => {
    let capturedHeaders: Headers | undefined;
    const stub = vi.fn<typeof fetch>(async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return Response.json({ operation: "verify", verified: true });
    });
    const outboundFetch = vi.fn<typeof fetch>(async () => {
      throw new Error("Local test must not make an outbound request");
    });
    const verifier = createLambdaPasswordVerifier(outboundFetch);
    const result = await verifier(
      "synthetic-only-password",
      "$scrypt$synthetic-encoded-hash",
      {
        AWS_ACCESS_KEY_ID: "AKIAFIXTUREACCESS00",
        AWS_REGION: "eu-north-1",
        AWS_SECRET_ACCESS_KEY: "fixture-secret-access-key-not-real",
        AWS_SESSION_TOKEN: "fixture-session-token-not-real",
        LAMBDA_FUNCTION_URL: functionUrl,
        STAGING_LOCAL_TEST: "true",
        STAGING_LAMBDA_TEST_STUB: {
          fetch: stub,
        },
      },
    );

    expect(result).toBe(true);
    expect(stub.mock.calls.length).toBe(1);
    expect(outboundFetch.mock.calls.length).toBe(0);
    expect(
      /^AWS4-HMAC-SHA256 Credential=AKIAFIXTUREACCESS00\/\d{8}\/eu-north-1\/lambda\/aws4_request,/.test(
        capturedHeaders?.get("authorization") ?? "",
      ),
    ).toBe(true);
    expect(
      capturedHeaders?.get("x-amz-security-token") ===
        "fixture-session-token-not-real",
    ).toBe(true);
  });

  it("sends one SigV4-signed Lambda request with temporary session credentials", async () => {
    const credentials = {
      AWS_ACCESS_KEY_ID: "AKIAFIXTUREACCESS00",
      AWS_REGION: "eu-north-1",
      AWS_SECRET_ACCESS_KEY: "fixture-secret-access-key-not-real",
      AWS_SESSION_TOKEN: "fixture-session-token-not-real",
      LAMBDA_FUNCTION_URL: functionUrl,
    };
    let capturedUrl: URL | undefined;
    let capturedInit: RequestInit | undefined;
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      capturedUrl = new URL(input instanceof Request ? input.url : String(input));
      capturedInit = init;
      return new Response(
        JSON.stringify({ operation: "verify", verified: true }),
        { status: 200 },
      );
    });
    const verifier = createLambdaPasswordVerifier(
      fetcher as unknown as typeof fetch,
      () => new Date("2026-11-13T14:00:00.000Z"),
    );
    const verified = await verifier(
      "synthetic-only-password",
      "$scrypt$synthetic-encoded-hash",
      credentials,
    );

    expect(verified).toBe(true);
    expect(fetcher.mock.calls.length).toBe(1);
    expect(capturedUrl?.href).toBe(
      "https://staging-test.lambda-url.eu-north-1.on.aws/verify",
    );
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.redirect).toBe("manual");
    const headers = new Headers(capturedInit?.headers);
    expect(
      headers.get("x-amz-security-token") === credentials.AWS_SESSION_TOKEN,
    ).toBe(true);
    expect(
      /^AWS4-HMAC-SHA256 Credential=AKIAFIXTUREACCESS00\/20261113\/eu-north-1\/lambda\/aws4_request,/.test(
        headers.get("authorization") ?? "",
      ),
    ).toBe(true);
    const body = JSON.parse(String(capturedInit?.body)) as {
      encodedHash?: string;
      operation?: string;
      password?: string;
    };
    expect(
      body.operation === "verify" &&
        body.password === "synthetic-only-password" &&
        body.encodedHash === "$scrypt$synthetic-encoded-hash",
    ).toBe(true);
  });
});
