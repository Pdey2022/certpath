import { describe, expect, it, vi } from "vitest";
import { hashLearnerPassword } from "../../src/security/password-hashing.ts";
import { createLambdaHandler } from "../lambda/handler.ts";
import {
  createSignInBenchmark,
  type SignInEnvironment,
} from "./signin-worker.ts";
import {
  syntheticAccounts,
  syntheticUnknownEmail,
  syntheticWrongSignInPassword,
} from "./signin-synthetic.ts";

const origin = "https://signin.test";
const testerHeaders = {
  "CF-Connecting-IP": "198.51.100.1",
  "content-type": "application/json",
  origin,
};
const [accountA] = syntheticAccounts;

async function setup() {
  const handler = createLambdaHandler();
  const calls: Array<{ headers: Headers; path: string }> = [];
  const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ headers: new Headers(init?.headers), path: url.pathname });
    const result = await handler(
      {
        body: String(init?.body),
        rawPath: url.pathname,
        requestContext: { http: { method: init?.method } },
      },
      { memoryLimitInMB: "1769", requestId: "synthetic" },
    );
    return new Response(result.body, { status: result.statusCode });
  });
  const environment: SignInEnvironment = {
    AWS_ACCESS_KEY_ID: "AKIAFIXTUREACCESS00",
    AWS_REGION: "eu-north-1",
    AWS_SECRET_ACCESS_KEY: "fixture-secret-access-key-not-real",
    AWS_SESSION_TOKEN: "fixture-session-token-not-real",
    LAMBDA_FUNCTION_URL: "https://synthetic-url.lambda-url.eu-north-1.on.aws/",
    RATE_LIMIT_HMAC_SECRET: "fixture-hmac-secret",
    SYNTHETIC_ACCOUNTS: JSON.stringify({
      [accountA.email]: await hashLearnerPassword(accountA.password),
      decoy: await hashLearnerPassword("decoy-synthetic-password"),
    }),
    TESTER_IP: "198.51.100.1",
  };
  const worker = createSignInBenchmark(fetcher as unknown as typeof fetch);
  const send = (
    path: string,
    body: unknown,
    headers: Record<string, string> = testerHeaders,
  ) =>
    worker.fetch(
      new Request(`${origin}${path}`, {
        body: typeof body === "string" ? body : JSON.stringify(body),
        headers,
        method: "POST",
      }),
      environment,
    );
  return { calls, fetcher, send };
}

describe("sign-in-shaped Worker benchmark", () => {
  it("rejects an unauthorized caller before any Lambda call", async () => {
    const { fetcher, send } = await setup();
    const response = await send(
      "/sign-in",
      { email: accountA.email, password: accountA.password },
      { ...testerHeaders, "CF-Connecting-IP": "203.0.113.9" },
    );
    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("signs one IAM-scoped Lambda call per sign-in and decides by verification", async () => {
    const { calls, fetcher, send } = await setup();

    const ok = await send("/sign-in", {
      email: ` ${accountA.email.toUpperCase()} `,
      password: accountA.password,
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("certpath_session=");
    expect(await ok.json()).toEqual({ redirectTo: "/app/home" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const authorization = calls[0].headers.get("authorization") ?? "";
    expect(authorization).toMatch(/\/eu-north-1\/lambda\/aws4_request/);
    expect(calls[0].headers.get("x-amz-security-token")).toBeTruthy();
    expect(calls[0].path).toBe("/verify");

    const wrong = await send("/sign-in", {
      email: accountA.email,
      password: syntheticWrongSignInPassword(),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);

    const unknown = await send("/sign-in", {
      email: syntheticUnknownEmail,
      password: accountA.password,
    });
    expect(unknown.status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid input and foreign origins without calling Lambda", async () => {
    const { fetcher, send } = await setup();
    expect((await send("/sign-in", { email: "nope", password: "" })).status).toBe(400);
    expect((await send("/sign-in", "{not json")).status).toBe(400);
    expect(
      (
        await send(
          "/sign-in",
          { email: accountA.email, password: accountA.password },
          { ...testerHeaders, origin: "https://other.test" },
        )
      ).status,
    ).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("serves the zero-Lambda probe without any network call", async () => {
    const { fetcher, send } = await setup();
    const response = await send("/probe", {
      email: accountA.email,
      password: accountA.password,
    });
    expect(response.status).toBe(200);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
