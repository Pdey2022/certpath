import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { localPasswordIssuer } from "../src/local-learner-auth.ts";
import {
  hashLearnerPassword,
  verifyLearnerPassword,
} from "../src/security/password-hashing.ts";
import worker, {
  type LearnerSignInD1Environment,
} from "../benchmark/learner-signin-d1/worker.ts";

const origin = "https://isolated.example.workers.dev";
const testerIp = "203.0.113.7";
const functionUrl = "https://abc123.lambda-url.eu-north-1.on.aws/";
const password = `synthetic-${crypto.randomUUID()}-password`;
const email = `learner-${crypto.randomUUID()}@example.test`;
const secret = (label: string) => `${label}-${crypto.randomUUID()}-padding-to-32`;

let environment: LearnerSignInD1Environment;
let lambdaRequests = 0;

function lambdaResponse(verified: boolean): Response {
  return Response.json({
    metrics: {
      coldStart: false,
      cpuSystemMs: 0,
      cpuUserMs: 1,
      elapsedMs: 1,
      memoryLimitMb: 1769,
      processPeakRssBytes: 1,
      processRssBytes: 1,
      requestId: "test",
    },
    operation: "verify",
    verified,
  });
}

function request(
  path: string,
  init: { body?: unknown; cookie?: string; csrf?: string; ip?: string; origin?: string; method?: string } = {},
): Request {
  const headers: Record<string, string> = {
    "CF-Connecting-IP": init.ip ?? testerIp,
    Origin: init.origin ?? origin,
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.cookie) headers.Cookie = init.cookie;
  if (init.csrf) headers["X-CSRF-Token"] = init.csrf;
  return new Request(`${origin}${path}`, {
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers,
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
  });
}

function signIn(emailAddress: string, pw: string, ip = testerIp) {
  return worker.fetch(
    request("/api/auth/local/sign-in", { body: { email: emailAddress, password: pw }, ip }),
    environment,
  );
}

async function rateRows(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM local_auth_rate_limit_windows",
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  const hash = await hashLearnerPassword(password);
  const now = Date.now();
  const userId = crypto.randomUUID();
  const subject = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)",
    ).bind(userId, now, now),
    env.DB.prepare(
      "INSERT INTO auth_identities (issuer, subject, user_id, created_at) VALUES (?, ?, ?, ?)",
    ).bind(localPasswordIssuer, subject, userId, now),
    env.DB.prepare(
      `INSERT INTO learner_password_credentials (
         user_id, email, email_normalized, subject, password_hash,
         email_verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(userId, email, email, subject, hash, now, now, now),
  ]);
  environment = {
    AWS_ACCESS_KEY_ID: "ASIAFIXTURE0000000",
    AWS_REGION: "eu-north-1",
    AWS_SECRET_ACCESS_KEY: "fixture-secret-not-real",
    AWS_SESSION_TOKEN: "fixture-session-token-not-real",
    CSRF_HMAC_SECRET: secret("csrf"),
    DB: env.DB,
    DECOY_HASH: await hashLearnerPassword(crypto.randomUUID()),
    LAMBDA_FUNCTION_URL: functionUrl,
    LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET: secret("rate"),
    TESTER_IP: testerIp,
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toContain(".lambda-url.eu-north-1.on.aws/verify");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toContain("/eu-north-1/lambda/aws4_request");
    expect(headers.get("x-amz-security-token")).toBeTruthy();
    lambdaRequests += 1;
    const body = JSON.parse(String(init?.body)) as { password: string; encodedHash: string };
    return lambdaResponse(await verifyLearnerPassword(body.password, body.encodedHash));
  });
});

afterEach(() => {
  lambdaRequests = 0;
});

describe("isolated learner sign-in Worker", () => {
  it("rejects an unauthorized caller before D1 or Lambda work", async () => {
    const before = await rateRows();
    const response = await signIn(email, password, "198.51.100.9");
    expect(response.status).toBe(403);
    expect(lambdaRequests).toBe(0);
    expect(await rateRows()).toBe(before);
    const unknown = await worker.fetch(request("/api/admin/content"), environment);
    expect(unknown.status).toBe(404);
  });

  it("makes one Lambda call per eligible attempt and none for rejected input", async () => {
    const wrong = await signIn(email, "wrong-password-value-123");
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("X-Bench-Lambda-Calls")).toBe("1");
    const unknown = await signIn(`nobody-${crypto.randomUUID()}@example.test`, password);
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get("X-Bench-Lambda-Calls")).toBe("1");
    const foreign = await worker.fetch(
      request("/api/auth/local/sign-in", {
        body: { email, password },
        origin: "https://evil.example",
      }),
      environment,
    );
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    const invalid = await worker.fetch(
      request("/api/auth/local/sign-in", { body: { email: "not-an-email" } }),
      environment,
    );
    expect(invalid.status).toBe(400);
    expect(lambdaRequests).toBe(2);
  });

  it("signs in, persists the session, serves the dashboard, and invalidates on logout", async () => {
    const response = await signIn(email, password, testerIp);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Bench-Lambda-Calls")).toBe("1");
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toMatch(/^certpath_session=/);

    const csrfResponse = await worker.fetch(
      request("/api/auth/session/csrf", { cookie }),
      environment,
    );
    expect(csrfResponse.status).toBe(200);
    const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };
    const dashboard = await worker.fetch(
      request("/api/practice/dashboard", { cookie }),
      environment,
    );
    expect(dashboard.status).toBe(200);
    expect(dashboard.headers.get("X-Bench-Lambda-Calls")).toBe("0");

    const logout = await worker.fetch(
      request("/api/auth/session/logout", { cookie, csrf: csrfToken, body: {} }),
      environment,
    );
    expect(logout.status).toBe(204);
    for (const path of ["/api/auth/session/csrf", "/api/practice/dashboard"]) {
      const after = await worker.fetch(request(path, { cookie }), environment);
      expect(after.status).toBe(401);
    }
  });

  it("rate limits an email before invoking Lambda", async () => {
    const limited = `limit-${crypto.randomUUID()}@example.test`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await signIn(limited, "wrong-password-value-123");
      expect(response.status).toBe(401);
    }
    lambdaRequests = 0;
    const blocked = await signIn(limited, "wrong-password-value-123");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("X-Bench-Lambda-Calls")).toBe("0");
    expect(lambdaRequests).toBe(0);
  }, 60_000);
});
