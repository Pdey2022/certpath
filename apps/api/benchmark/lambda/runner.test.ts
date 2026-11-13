import { describe, expect, it, vi } from "vitest";
import {
  hashLearnerPassword,
  verifyLearnerPassword,
} from "../../src/security/password-hashing.ts";
import { FunctionUrlCallError } from "./caller.ts";
import { runLambdaBenchmark } from "./runner.ts";
import type { BenchmarkRequest } from "./protocol.ts";

describe("Lambda scrypt benchmark runner", () => {
  it("cross-verifies the unchanged profile and stays within ten calls", async () => {
    let invocation = 0;
    let activeInvocations = 0;
    let maxActiveInvocations = 0;
    let syntheticPassword = "";
    let generatedHash = "";
    const invoke = vi.fn(async (request: BenchmarkRequest) => {
      invocation += 1;
      activeInvocations += 1;
      maxActiveInvocations = Math.max(maxActiveInvocations, activeInvocations);
      const metrics = {
        coldStart: invocation === 1,
        cpuSystemMs: 1,
        cpuUserMs: 2,
        elapsedMs: 3,
        memoryLimitMb: 1769,
        processPeakRssBytes: 4_000,
        processRssBytes: 4_000,
        requestId: `synthetic-request-${invocation}`,
      };

      try {
        if (request.operation === "hash") {
          syntheticPassword = request.password;
          generatedHash = await hashLearnerPassword(request.password);
          return {
            body: {
              operation: "hash" as const,
              encodedHash: generatedHash,
              metrics,
            },
            httpStatus: 200,
            roundTripMs: 5,
          };
        }

        return {
          body: {
            operation: "verify" as const,
            verified: await verifyLearnerPassword(
              request.password,
              request.encodedHash,
            ),
            metrics,
          },
          httpStatus: 200,
          roundTripMs: 5,
        };
      } finally {
        activeInvocations -= 1;
      }
    });

    const report = await runLambdaBenchmark(invoke);
    const serializedReport = JSON.stringify(report);

    expect(report.lambdaInvocationCount).toBe(10);
    expect(report.maxInFlightRequests).toBe(4);
    expect(maxActiveInvocations).toBe(4);
    expect(report.measurements).toHaveLength(10);
    expect(report.measurements.filter((item) => item.concurrency === 2))
      .toHaveLength(2);
    expect(report.measurements.filter((item) => item.concurrency === 4))
      .toHaveLength(4);
    expect(report.checks).toEqual({
      lambdaHashVerifiedLocally: true,
      lambdaRejectedWrongPassword: true,
      localHashVerifiedByLambda: true,
    });
    expect(serializedReport).not.toContain(syntheticPassword);
    expect(serializedReport).not.toContain(generatedHash);
  });

  it("stops after the first failed sequential call", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("synthetic transport failure");
    });

    await expect(runLambdaBenchmark(invoke)).rejects.toThrow(
      "synthetic transport failure",
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("stops immediately when a sequential request is throttled", async () => {
    const invoke = vi
      .fn()
      .mockImplementationOnce(async (request: BenchmarkRequest) => ({
        body: {
          operation: "hash" as const,
          encodedHash: await hashLearnerPassword(request.password),
          metrics: {
            coldStart: true,
            cpuSystemMs: 1,
            cpuUserMs: 2,
            elapsedMs: 3,
            memoryLimitMb: 1769,
            processPeakRssBytes: 4_000,
            processRssBytes: 4_000,
            requestId: "synthetic-request-1",
          },
        },
        httpStatus: 200,
        roundTripMs: 5,
      }))
      .mockRejectedValueOnce(new FunctionUrlCallError(429));

    await expect(runLambdaBenchmark(invoke)).rejects.toThrow(
      "Function URL request was throttled (HTTP 429)",
    );
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does not start the four-request wave after throttling at concurrency two", async () => {
    let invocation = 0;
    const invoke = vi.fn(async (request: BenchmarkRequest) => {
      invocation += 1;
      if (invocation === 5) {
        throw new FunctionUrlCallError(429);
      }

      const metrics = {
        coldStart: invocation === 1,
        cpuSystemMs: 1,
        cpuUserMs: 2,
        elapsedMs: 3,
        memoryLimitMb: 1769,
        processPeakRssBytes: 4_000,
        processRssBytes: 4_000,
        requestId: `synthetic-request-${invocation}`,
      };
      if (request.operation === "hash") {
        return {
          body: {
            operation: "hash" as const,
            encodedHash: await hashLearnerPassword(request.password),
            metrics,
          },
          httpStatus: 200,
          roundTripMs: 5,
        };
      }

      return {
        body: {
          operation: "verify" as const,
          verified: await verifyLearnerPassword(
            request.password,
            request.encodedHash,
          ),
          metrics,
        },
        httpStatus: 200,
        roundTripMs: 5,
      };
    });

    await expect(runLambdaBenchmark(invoke)).rejects.toThrow(
      "Lambda throttled a request at concurrency 2; no higher concurrency was attempted",
    );
    expect(invoke).toHaveBeenCalledTimes(6);
  });
});
