import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Hash } from "@smithy/hash-node";
import { describe, expect, it, vi } from "vitest";
import {
  hashLearnerPassword,
  verifyLearnerPassword,
} from "../../src/security/password-hashing.ts";
import { createLambdaHandler } from "../lambda/handler.ts";
import { signLambdaRequest } from "./sigv4.ts";
import { syntheticPassword } from "./synthetic.ts";
import {
  createWorkerLambdaBenchmark,
  type WorkerLambdaEnvironment,
} from "./worker.ts";

const credentials = {
  accessKeyId: "AKIAFIXTUREACCESS00",
  secretAccessKey: "fixture-secret-access-key-not-real",
  sessionToken: "fixture-session-token-not-real",
};
const functionUrl = "https://synthetic-url.lambda-url.eu-north-1.on.aws/";
const environment: WorkerLambdaEnvironment = {
  AWS_ACCESS_KEY_ID: credentials.accessKeyId,
  AWS_REGION: "eu-north-1",
  AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
  AWS_SESSION_TOKEN: credentials.sessionToken,
  LAMBDA_FUNCTION_URL: functionUrl,
  TESTER_IP: "198.51.100.1",
};
const testerHeaders = { "CF-Connecting-IP": "198.51.100.1" };

function runRequest(localEncodedHash: string, headers = testerHeaders) {
  return new Request("https://benchmark.test/run", {
    body: JSON.stringify({ includeLambdaHash: true, localEncodedHash }),
    headers,
    method: "POST",
  });
}

// Routes Worker fetches to the real Lambda handler, standing in for Lambda.
function fakeLambda(delayMs = 5) {
  const handler = createLambdaHandler();
  const stats = { calls: 0, inFlight: 0, maxInFlight: 0, urls: [] as string[] };
  const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    stats.urls.push(url.href);
    stats.calls += 1;
    stats.inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    try {
      await new Promise((done) => setTimeout(done, delayMs));
      const result = await handler(
        {
          body: String(init?.body),
          rawPath: url.pathname,
          requestContext: { http: { method: init?.method } },
        },
        { memoryLimitInMB: "1769", requestId: "synthetic" },
      );
      return new Response(result.body, { status: result.statusCode });
    } finally {
      stats.inFlight -= 1;
    }
  });
  return { fetcher: fetcher as unknown as typeof fetch, mock: fetcher, stats };
}

describe("Worker-compatible SigV4 signing", () => {
  it("matches the reference SigV4 signer for Lambda in eu-north-1", async () => {
    const now = new Date("2026-11-13T14:00:00.000Z");
    const body = JSON.stringify({ operation: "hash", password: "synthetic" });
    const url = new URL("/hash", functionUrl);

    const headers = await signLambdaRequest({
      body,
      credentials,
      now,
      region: "eu-north-1",
      url,
    });
    const reference = await new SignatureV4({
      credentials,
      region: "eu-north-1",
      service: "lambda",
      sha256: Hash.bind(null, "sha256"),
    }).sign(
      new HttpRequest({
        body,
        headers: { "content-type": "application/json", host: url.host },
        hostname: url.hostname,
        method: "POST",
        path: url.pathname,
        protocol: url.protocol,
      }),
      { signingDate: now },
    );

    expect(headers.get("authorization") === reference.headers.authorization).toBe(
      true,
    );
    expect(
      headers.get("x-amz-security-token") === credentials.sessionToken,
    ).toBe(true);
    expect(headers.get("x-amz-date")).toBe("20261113T140000Z");
    expect(headers.has("host")).toBe(false);
  });
});

describe("Worker-to-Lambda scrypt benchmark", () => {
  it("rejects an unauthorized tester before invoking Lambda", async () => {
    const { fetcher } = fakeLambda();
    const worker = createWorkerLambdaBenchmark(fetcher);

    for (const testerIp of [environment.TESTER_IP, undefined]) {
      const response = await worker.fetch(
        runRequest("unused", { "CF-Connecting-IP": "198.51.100.2" }),
        { ...environment, TESTER_IP: testerIp },
      );
      expect(response.status).toBe(403);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed run requests before invoking Lambda", async () => {
    const { fetcher } = fakeLambda();
    const response = await createWorkerLambdaBenchmark(fetcher).fetch(
      runRequest("not-a-scrypt-hash"),
      environment,
    );
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("runs ten signed calls to the fixed destination without leaking secrets", async () => {
    const { fetcher, mock, stats } = fakeLambda();
    const localHash = await hashLearnerPassword(syntheticPassword());

    const response = await createWorkerLambdaBenchmark(fetcher).fetch(
      runRequest(localHash),
      environment,
    );
    const text = await response.text();
    const report = JSON.parse(text);

    expect(response.status).toBe(200);
    expect(stats.calls).toBe(10);
    expect(stats.maxInFlight).toBeLessThanOrEqual(4);
    expect(report.lambdaInvocationCount).toBe(10);
    expect(report.measurements).toHaveLength(10);
    expect(
      stats.urls.every((url) =>
        /^https:\/\/synthetic-url\.lambda-url\.eu-north-1\.on\.aws\/(hash|verify)$/.test(
          url,
        ),
      ),
    ).toBe(true);
    for (const call of mock.mock.calls) {
      const headers = call[1]?.headers as Headers;
      expect(call[1]?.redirect).toBe("manual");
      expect(
        /^AWS4-HMAC-SHA256 Credential=[^/]+\/\d{8}\/eu-north-1\/lambda\/aws4_request, /.test(
          headers.get("authorization") ?? "",
        ),
      ).toBe(true);
      expect(headers.get("x-amz-security-token") === credentials.sessionToken).toBe(
        true,
      );
    }
    expect(report.checks).toEqual({
      lambdaRejectedWrongPassword: true,
      lambdaVerifiedItsOwnHash: true,
      lambdaVerifiedLocalHash: true,
    });
    expect(
      await verifyLearnerPassword(syntheticPassword(), report.lambdaEncodedHash),
    ).toBe(true);
    for (const secret of Object.values(credentials)) {
      expect(text.includes(secret)).toBe(false);
    }
    expect(text.includes(syntheticPassword())).toBe(false);
  }, 60_000);

  it("stops without retrying or escalating when Lambda rejects a request", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 403 }));
    const response = await createWorkerLambdaBenchmark(
      fetcher as unknown as typeof fetch,
    ).fetch(
      runRequest(await hashLearnerPassword(syntheticPassword())),
      environment,
    );

    expect(response.status).toBe(502);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await response.text()).not.toContain(credentials.sessionToken);
  });

  it("refuses a Function URL outside the configured region", async () => {
    const { fetcher } = fakeLambda();
    const response = await createWorkerLambdaBenchmark(fetcher).fetch(
      runRequest(await hashLearnerPassword(syntheticPassword())),
      {
        ...environment,
        LAMBDA_FUNCTION_URL: "https://evil.example.com/",
      },
    );
    expect(response.status).toBe(502);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
