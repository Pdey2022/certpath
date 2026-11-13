import { describe, expect, it, vi } from "vitest";
import {
  createLambdaHandler,
  handler,
} from "./handler.ts";

const context = {
  memoryLimitInMB: "1769",
  requestId: "synthetic-request-id",
};

function requestEvent(
  rawPath: string,
  body: unknown,
  method = "POST",
): Parameters<typeof handler>[0] {
  return {
    body: JSON.stringify(body),
    rawPath,
    requestContext: {
      http: { method },
      requestId: context.requestId,
    },
  };
}

describe("Lambda scrypt benchmark handler", () => {
  it("rejects malformed or oversized input before hashing", async () => {
    const hashPassword = vi.fn(async () => "unused");
    const verifyPassword = vi.fn(async () => true);
    const testHandler = createLambdaHandler(hashPassword, verifyPassword);

    const malformed = await testHandler(
      {
        body: "{",
        rawPath: "/hash",
        requestContext: { http: { method: "POST" } },
      },
      context,
    );
    const oversized = await testHandler(
      {
        body: JSON.stringify({
          operation: "hash",
          password: "x".repeat(4_100),
        }),
        rawPath: "/hash",
        requestContext: { http: { method: "POST" } },
      },
      context,
    );

    expect(malformed.statusCode).toBe(400);
    expect(oversized.statusCode).toBe(400);
    expect(hashPassword).not.toHaveBeenCalled();
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("hashes and verifies synthetic credentials with the existing profile", async () => {
    const password = "synthetic-lambda-benchmark-password";
    const hashResponse = await handler(
      requestEvent("/hash", { operation: "hash", password }),
      context,
    );
    const hashBody = JSON.parse(hashResponse.body) as {
      encodedHash: string;
      metrics: {
        coldStart: boolean;
        cpuUserMs: number;
        cpuSystemMs: number;
        elapsedMs: number;
        memoryLimitMb: number | null;
        requestId: string;
      };
      operation: string;
    };

    expect(hashResponse.statusCode).toBe(200);
    expect(hashBody.operation).toBe("hash");
    expect(hashBody.encodedHash).toMatch(
      /^\$scrypt\$ln=15,r=8,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(hashBody.metrics).toMatchObject({
      memoryLimitMb: 1769,
      requestId: context.requestId,
    });
    expect(hashBody.metrics.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(hashBody.metrics.cpuUserMs).toBeGreaterThanOrEqual(0);
    expect(hashBody.metrics.cpuSystemMs).toBeGreaterThanOrEqual(0);

    const verifyResponse = await handler(
      requestEvent("/verify", {
        operation: "verify",
        password,
        encodedHash: hashBody.encodedHash,
      }),
      context,
    );
    const verifyBody = JSON.parse(verifyResponse.body) as {
      verified: boolean;
    };

    expect(verifyResponse.statusCode).toBe(200);
    expect(verifyBody.verified).toBe(true);
    expect(hashResponse.headers["Cache-Control"]).toBe("no-store");
  });

  it("does not accept a wrong password", async () => {
    const hashResponse = await handler(
      requestEvent("/hash", {
        operation: "hash",
        password: "synthetic-correct-password",
      }),
      context,
    );
    const { encodedHash } = JSON.parse(hashResponse.body) as {
      encodedHash: string;
    };
    const verifyResponse = await handler(
      requestEvent("/verify", {
        operation: "verify",
        password: "synthetic-wrong-password",
        encodedHash,
      }),
      context,
    );

    expect(verifyResponse.statusCode).toBe(200);
    expect(
      (JSON.parse(verifyResponse.body) as { verified: boolean }).verified,
    ).toBe(false);
  });
});
