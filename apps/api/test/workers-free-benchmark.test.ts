import { describe, expect, it, vi } from "vitest";
import { createCloudflareFreeBenchmarkWorker } from "../benchmark/cloudflare-free-worker.ts";

describe("isolated Workers Free scrypt benchmark", () => {
  it("rejects an unlisted IP before hashing or verification", async () => {
    const hashPassword = vi.fn(async () => "unused-hash");
    const verifyPassword = vi.fn(async () => true);
    const worker = createCloudflareFreeBenchmarkWorker(
      hashPassword,
      verifyPassword,
    );

    const response = await worker.fetch(
      new Request("https://benchmark.test/hash", {
        method: "POST",
        headers: { "CF-Connecting-IP": "198.51.100.2" },
      }),
      { TESTER_IP: "198.51.100.1" },
    );

    expect(response.status).toBe(403);
    expect(hashPassword).not.toHaveBeenCalled();
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("allows the exact tester IP to reach the no-hash readiness route", async () => {
    const hashPassword = vi.fn(async () => "unused-hash");
    const worker = createCloudflareFreeBenchmarkWorker(hashPassword);

    const response = await worker.fetch(
      new Request("https://benchmark.test/", {
        headers: { "CF-Connecting-IP": "198.51.100.1" },
      }),
      { TESTER_IP: "198.51.100.1" },
    );

    expect(response.status).toBe(200);
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it("uses the generated synthetic password for separate hash and verify requests", async () => {
    const hashPassword = vi.fn(async (_password: string) => "synthetic-hash");
    const verifyPassword = vi.fn(async (_password: string, _hash: string) => true);
    const worker = createCloudflareFreeBenchmarkWorker(
      hashPassword,
      verifyPassword,
    );
    const environment = { TESTER_IP: "198.51.100.1" };
    const headers = { "CF-Connecting-IP": environment.TESTER_IP };

    const hashResponse = await worker.fetch(
      new Request("https://benchmark.test/hash", {
        method: "POST",
        headers,
      }),
      environment,
    );
    const hashResult = (await hashResponse.json()) as {
      operation: string;
      elapsedMs: number;
      encodedHash?: string;
    };

    const verifyResponse = await worker.fetch(
      new Request("https://benchmark.test/verify", {
        method: "POST",
        headers,
      }),
      environment,
    );
    const verifyResult = (await verifyResponse.json()) as {
      operation: string;
      elapsedMs: number;
      verified: boolean;
    };

    expect(hashResponse.status).toBe(200);
    expect(hashResult.operation).toBe("hash");
    expect(hashResult.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(hashResult.encodedHash).toBeUndefined();
    expect(verifyResponse.status).toBe(200);
    expect(verifyResult).toMatchObject({
      operation: "verify",
      verified: true,
    });
    expect(verifyResult.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(hashPassword).toHaveBeenCalledTimes(1);
    expect(verifyPassword).toHaveBeenCalledWith(
      hashPassword.mock.calls[0]?.[0],
      "synthetic-hash",
    );
  });
});
