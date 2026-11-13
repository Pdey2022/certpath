import { describe, expect, it, vi } from "vitest";
import {
  createSignedLambdaCaller,
  FunctionUrlCallError,
} from "./caller.ts";

const functionUrl =
  "https://example.lambda-url.eu-north-1.on.aws/";

describe("SigV4 Lambda Function URL caller", () => {
  it("signs a request using the supplied temporary credentials", async () => {
    const fetcher = vi.fn(
      async (_input: URL | RequestInfo, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            operation: "verify",
            verified: true,
            metrics: {
              coldStart: true,
              cpuSystemMs: 1,
              cpuUserMs: 2,
              elapsedMs: 3,
              memoryLimitMb: 1769,
              processPeakRssBytes: 4,
              processRssBytes: 4,
              requestId: "synthetic-request-id",
            },
          }),
          { status: 200 },
        ),
    );
    const caller = createSignedLambdaCaller({
      credentials: async () => ({
        accessKeyId: "EXAMPLEACCESSKEY",
        secretAccessKey: "synthetic-secret-not-a-real-credential",
        sessionToken: "synthetic-session-token",
      }),
      fetcher,
      functionUrl,
      region: "eu-north-1",
    });

    const result = await caller({
      operation: "verify",
      password: "synthetic-password",
      encodedHash: "synthetic-hash",
    });
    const [input, init] = fetcher.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);

    expect(input).toBeInstanceOf(URL);
    if (!(input instanceof URL)) {
      throw new Error("Expected a URL input");
    }
    expect(input.pathname).toBe("/verify");
    expect(result.body.operation).toBe("verify");
    expect(result.httpStatus).toBe(200);
    expect(headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=EXAMPLEACCESSKEY\//,
    );
    expect(headers.get("x-amz-security-token")).toBe(
      "synthetic-session-token",
    );
  });

  it("routes hash requests to the handler's hash path", async () => {
    const fetcher = vi.fn(
      async (_input: URL | RequestInfo, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            operation: "hash",
            encodedHash: "synthetic-hash",
            metrics: {
              coldStart: true,
              cpuSystemMs: 1,
              cpuUserMs: 2,
              elapsedMs: 3,
              memoryLimitMb: 1769,
              processPeakRssBytes: 4,
              processRssBytes: 4,
              requestId: "synthetic-request-id",
            },
          }),
          { status: 200 },
        ),
    );
    const caller = createSignedLambdaCaller({
      credentials: async () => ({
        accessKeyId: "EXAMPLEACCESSKEY",
        secretAccessKey: "synthetic-secret-not-a-real-credential",
      }),
      fetcher,
      functionUrl,
      region: "eu-north-1",
    });

    await caller({ operation: "hash", password: "synthetic-password" });
    const [input] = fetcher.mock.calls[0] ?? [];

    expect(input).toBeInstanceOf(URL);
    if (!(input instanceof URL)) {
      throw new Error("Expected a URL input");
    }
    expect(input.pathname).toBe("/hash");
  });

  it("does not include a denied response body in the error", async () => {
    const caller = createSignedLambdaCaller({
      credentials: async () => ({
        accessKeyId: "EXAMPLEACCESSKEY",
        secretAccessKey: "synthetic-secret-not-a-real-credential",
      }),
      fetcher: async () =>
        new Response("synthetic-body-must-not-leak", { status: 403 }),
      functionUrl,
      region: "eu-north-1",
    });

    await expect(
      caller({ operation: "hash", password: "synthetic-password" }),
    ).rejects.toMatchObject({
      name: FunctionUrlCallError.name,
      message: expect.stringContaining("lambda:InvokeFunctionUrl"),
    });
    await expect(
      caller({ operation: "hash", password: "synthetic-password" }),
    ).rejects.not.toThrow("synthetic-body-must-not-leak");
  });

  it("reports throttling without exposing the response body", async () => {
    const caller = createSignedLambdaCaller({
      credentials: async () => ({
        accessKeyId: "EXAMPLEACCESSKEY",
        secretAccessKey: "synthetic-secret-not-a-real-credential",
      }),
      fetcher: async () =>
        new Response("synthetic-throttle-body-must-not-leak", { status: 429 }),
      functionUrl,
      region: "eu-north-1",
    });

    await expect(
      caller({ operation: "hash", password: "synthetic-password" }),
    ).rejects.toMatchObject({
      name: FunctionUrlCallError.name,
      status: 429,
      message: "Function URL request was throttled (HTTP 429)",
    });
    await expect(
      caller({ operation: "hash", password: "synthetic-password" }),
    ).rejects.not.toThrow("synthetic-throttle-body-must-not-leak");
  });

  it("rejects endpoints outside the selected Lambda URL region", () => {
    expect(
      () =>
        createSignedLambdaCaller({
          credentials: async () => ({
            accessKeyId: "EXAMPLEACCESSKEY",
            secretAccessKey: "synthetic-secret-not-a-real-credential",
          }),
          functionUrl: "https://example.lambda-url.eu-west-1.on.aws/",
          region: "eu-north-1",
        }),
    ).toThrow("configured region");
  });
});
