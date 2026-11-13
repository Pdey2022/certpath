import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  hashLearnerPassword,
  learnerPasswordHashParameters,
  verifyLearnerPassword,
} from "../../src/security/password-hashing.ts";
import {
  createSignedLambdaCaller,
  FunctionUrlCallError,
} from "./caller.ts";
import type {
  BenchmarkRequest,
  BenchmarkResponse,
} from "./protocol.ts";

const storedHashPattern =
  /^\$scrypt\$ln=15,r=8,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;
const maximumInvocations = 10;
const maximumInFlightRequests = 4;

interface Invoker {
  (request: BenchmarkRequest): Promise<{
    body: BenchmarkResponse;
    httpStatus: number;
    roundTripMs: number;
  }>;
}

export interface BenchmarkMeasurement {
  coldStart: boolean;
  concurrency: number;
  cpuSystemMs: number;
  cpuUserMs: number;
  elapsedMs: number;
  httpStatus: number;
  kind: "measurement";
  memoryLimitMb: number | null;
  operation: "hash" | "verify";
  processPeakRssBytes: number;
  processRssBytes: number;
  requestId: string;
  roundTripMs: number;
  stage: string;
  verified?: boolean;
}

export interface BenchmarkReport {
  checks: {
    lambdaHashVerifiedLocally: true;
    lambdaRejectedWrongPassword: true;
    localHashVerifiedByLambda: true;
  };
  lambdaInvocationCount: number;
  maxInFlightRequests: number;
  measurements: BenchmarkMeasurement[];
  profile: typeof learnerPasswordHashParameters;
}

function assertCondition(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function requireHashResponse(
  response: BenchmarkResponse,
): Extract<BenchmarkResponse, { operation: "hash" }> {
  assertCondition(response.operation === "hash", "Expected Lambda hash response");
  requireMetrics(response);
  return response;
}

function requireVerifyResponse(
  response: BenchmarkResponse,
): Extract<BenchmarkResponse, { operation: "verify" }> {
  assertCondition(
    response.operation === "verify",
    "Expected Lambda verify response",
  );
  requireMetrics(response);
  return response;
}

function requireMetrics(response: BenchmarkResponse): void {
  assertCondition(
    Number.isFinite(response.metrics.elapsedMs) &&
      Number.isFinite(response.metrics.cpuUserMs) &&
      Number.isFinite(response.metrics.cpuSystemMs),
    "Lambda returned invalid timing metrics",
  );
}

export async function runLambdaBenchmark(
  invoke: Invoker,
): Promise<BenchmarkReport> {
  const password = randomBytes(32).toString("base64url");
  const wrongPassword = randomBytes(32).toString("base64url");
  assertCondition(password !== wrongPassword, "Synthetic inputs collided");

  const measurements: BenchmarkMeasurement[] = [];
  let lambdaInvocationCount = 0;
  let inFlightRequests = 0;
  let maxInFlightRequests = 0;

  const runOperation = async (
    stage: string,
    concurrency: number,
    request: BenchmarkRequest,
  ): Promise<BenchmarkResponse> => {
    assertCondition(
      lambdaInvocationCount < maximumInvocations,
      `Benchmark reached its ${maximumInvocations}-invocation budget`,
    );
    assertCondition(
      inFlightRequests < maximumInFlightRequests,
      `Benchmark reached its ${maximumInFlightRequests}-request in-flight limit`,
    );
    lambdaInvocationCount += 1;
    inFlightRequests += 1;
    maxInFlightRequests = Math.max(maxInFlightRequests, inFlightRequests);

    try {
      const result = await invoke(request);
      const response =
        request.operation === "hash"
          ? requireHashResponse(result.body)
          : requireVerifyResponse(result.body);
      const measurement: BenchmarkMeasurement = {
        coldStart: response.metrics.coldStart,
        concurrency,
        cpuSystemMs: response.metrics.cpuSystemMs,
        cpuUserMs: response.metrics.cpuUserMs,
        elapsedMs: response.metrics.elapsedMs,
        httpStatus: result.httpStatus,
        kind: "measurement",
        memoryLimitMb: response.metrics.memoryLimitMb,
        operation: request.operation,
        processPeakRssBytes: response.metrics.processPeakRssBytes,
        processRssBytes: response.metrics.processRssBytes,
        requestId: response.metrics.requestId,
        roundTripMs: result.roundTripMs,
        stage,
      };

      if (response.operation === "hash") {
        assertCondition(
          storedHashPattern.test(response.encodedHash),
          "Lambda returned a hash in an unexpected format",
        );
      } else {
        measurement.verified = response.verified;
      }
      measurements.push(measurement);
      return result.body;
    } finally {
      inFlightRequests -= 1;
    }
  };

  const lambdaHashResponse = requireHashResponse(
    await runOperation("sequential-hash", 1, {
      operation: "hash",
      password,
    }),
  );
  const lambdaHashVerifiedLocally = await verifyLearnerPassword(
    password,
    lambdaHashResponse.encodedHash,
  );
  assertCondition(
    lambdaHashVerifiedLocally,
    "CloudShell's local Node runner did not verify the Lambda-generated hash",
  );

  const lambdaOwnVerification = requireVerifyResponse(
    await runOperation("sequential-verify", 1, {
      operation: "verify",
      password,
      encodedHash: lambdaHashResponse.encodedHash,
    }),
  );
  assertCondition(
    lambdaOwnVerification.verified,
    "Lambda did not verify its generated hash",
  );

  const localHash = await hashLearnerPassword(password);
  const localHashVerification = requireVerifyResponse(
    await runOperation(
      "sequential-runner-hash-verify",
      1,
      { operation: "verify", password, encodedHash: localHash },
    ),
  );
  assertCondition(
    localHashVerification.verified,
    "Lambda did not verify a runner-generated hash",
  );

  const wrongPasswordVerification = requireVerifyResponse(
    await runOperation(
      "sequential-wrong-password",
      1,
      { operation: "verify", password: wrongPassword, encodedHash: localHash },
    ),
  );
  assertCondition(
    !wrongPasswordVerification.verified,
    "Lambda accepted a wrong synthetic password",
  );

  for (const concurrency of [2, 4]) {
    const operations = Array.from({ length: concurrency }, (_, index) =>
      index % 2 === 0
        ? runOperation(`concurrency-${concurrency}`, concurrency, {
            operation: "hash",
            password,
          })
        : runOperation(`concurrency-${concurrency}`, concurrency, {
            operation: "verify",
            password,
            encodedHash: localHash,
          }),
    );
    const results = await Promise.allSettled(operations);
    const rejected = results.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    if (rejected) {
      const wasThrottled =
        rejected.reason instanceof FunctionUrlCallError &&
        rejected.reason.status === 429;
      throw new Error(
        wasThrottled
          ? `Lambda throttled a request at concurrency ${concurrency}; no higher concurrency was attempted`
          : `Lambda concurrency ${concurrency} wave failed; no higher concurrency was attempted`,
        { cause: rejected.reason },
      );
    }
    for (const result of results) {
      if (result.status !== "fulfilled") {
        continue;
      }
      const response = result.value;
      if (response.operation === "verify") {
        assertCondition(
          response.verified,
          `Lambda verification failed at concurrency ${concurrency}`,
        );
      }
    }
  }

  assertCondition(
    lambdaInvocationCount <= maximumInvocations,
    `Benchmark exceeded its ${maximumInvocations}-invocation budget`,
  );
  return {
    checks: {
      lambdaHashVerifiedLocally: true,
      lambdaRejectedWrongPassword: true,
      localHashVerifiedByLambda: true,
    },
    lambdaInvocationCount,
    maxInFlightRequests,
    measurements,
    profile: learnerPasswordHashParameters,
  };
}

async function main(): Promise<void> {
  const functionUrl = process.env.LAMBDA_FUNCTION_URL;
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!functionUrl || !region) {
    throw new Error("Set LAMBDA_FUNCTION_URL and AWS_REGION before running");
  }

  const report = await runLambdaBenchmark(
    createSignedLambdaCaller({ functionUrl, region }),
  );
  for (const measurement of report.measurements) {
    console.log(JSON.stringify(measurement));
  }
  console.log(
    JSON.stringify({
      checks: report.checks,
      kind: "summary",
      lambdaInvocationCount: report.lambdaInvocationCount,
      maxInFlightRequests: report.maxInFlightRequests,
      profile: report.profile,
      passed: true,
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown failure";
    console.error(JSON.stringify({ error: message, kind: "failure" }));
    process.exitCode = 1;
  });
}
