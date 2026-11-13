import type {
  BenchmarkRequest,
  BenchmarkResponse,
} from "../lambda/protocol.ts";
import { signLambdaRequest } from "./sigv4.ts";
import type { TemporaryCredentials } from "./sigv4.ts";
import { syntheticPassword, syntheticWrongPassword } from "./synthetic.ts";

export interface WorkerLambdaEnvironment {
  AWS_ACCESS_KEY_ID?: string;
  AWS_REGION?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
  LAMBDA_FUNCTION_URL?: string;
  TESTER_IP?: string;
}

export interface LambdaCall {
  body: BenchmarkResponse;
  httpStatus: number;
  roundTripMs: number;
}

export type LambdaInvoker = (request: BenchmarkRequest) => Promise<LambdaCall>;

export interface WorkerMeasurement {
  concurrency: number;
  httpStatus: number;
  lambda: {
    coldStart: boolean;
    cpuSystemMs: number;
    cpuUserMs: number;
    elapsedMs: number;
    memoryLimitMb: number | null;
    processPeakRssBytes: number;
    processRssBytes: number;
  };
  operation: "hash" | "verify";
  stage: string;
  verified?: boolean;
  workerRoundTripMs: number;
}

export interface WorkerBenchmarkReport {
  checks: {
    lambdaRejectedWrongPassword: true;
    lambdaVerifiedItsOwnHash: true;
    lambdaVerifiedLocalHash: true;
  };
  lambdaEncodedHash?: string;
  lambdaInvocationCount: number;
  maxInFlightRequests: number;
  measurements: WorkerMeasurement[];
}

export const maximumInvocations = 10;
export const maximumInFlightRequests = 4;
const callTimeoutMs = 10_000;
const maximumResponseCharacters = 8_192;
const maximumRequestCharacters = 512;
const storedHashPattern =
  /^\$scrypt\$ln=15,r=8,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;

export class LambdaCallError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Function URL returned HTTP ${status}`);
    this.name = "LambdaCallError";
    this.status = status;
  }
}

function assertCondition(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function validateFunctionUrl(functionUrl: string, region: string): URL {
  const endpoint = new URL(functionUrl);
  const suffix = `.lambda-url.${region}.on.aws`;
  if (
    endpoint.protocol !== "https:" ||
    !endpoint.hostname.endsWith(suffix) ||
    endpoint.hostname.length === suffix.length ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
    endpoint.port ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error("Function URL must be an HTTPS URL for the configured region");
  }
  return endpoint;
}

export function createLambdaInvoker(
  environment: WorkerLambdaEnvironment,
  fetcher: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): LambdaInvoker {
  const {
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_REGION: region,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
    AWS_SESSION_TOKEN: sessionToken,
    LAMBDA_FUNCTION_URL: functionUrl,
  } = environment;
  if (
    !accessKeyId ||
    !secretAccessKey ||
    !sessionToken ||
    !functionUrl ||
    !region
  ) {
    throw new Error("Benchmark is not configured");
  }
  const credentials: TemporaryCredentials = {
    accessKeyId,
    secretAccessKey,
    sessionToken,
  };
  const endpoint = validateFunctionUrl(functionUrl, region);

  return async (request) => {
    const url = new URL(endpoint);
    url.pathname = request.operation === "hash" ? "/hash" : "/verify";
    const body = JSON.stringify(request);
    const headers = await signLambdaRequest({
      body,
      credentials,
      now: now(),
      region,
      url,
    });
    const startedAt = performance.now();
    const response = await fetcher(url, {
      body,
      headers,
      method: "POST",
      // Workers does not implement redirect: "error"; any 3xx is treated as a failure below.
      redirect: "manual",
      signal: AbortSignal.timeout(callTimeoutMs),
    });
    const roundTripMs = performance.now() - startedAt;
    const text = await response.text();
    if (text.length > maximumResponseCharacters) {
      throw new Error("Function URL response exceeded the benchmark limit");
    }
    if (!response.ok) {
      throw new LambdaCallError(response.status);
    }
    let parsed: BenchmarkResponse;
    try {
      parsed = JSON.parse(text) as BenchmarkResponse;
    } catch {
      throw new Error("Function URL returned an invalid JSON response");
    }
    if (!parsed || typeof parsed !== "object" || !parsed.metrics) {
      throw new Error("Function URL returned an invalid benchmark response");
    }
    return { body: parsed, httpStatus: response.status, roundTripMs };
  };
}

export function parseRunRequest(
  text: string,
): { includeLambdaHash: boolean; localEncodedHash: string } | null {
  if (text.length > maximumRequestCharacters) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const { includeLambdaHash, localEncodedHash } = value as Record<
    string,
    unknown
  >;
  if (
    typeof localEncodedHash !== "string" ||
    !storedHashPattern.test(localEncodedHash) ||
    (includeLambdaHash !== undefined && typeof includeLambdaHash !== "boolean")
  ) {
    return null;
  }
  return { includeLambdaHash: includeLambdaHash === true, localEncodedHash };
}

/**
 * Runs exactly ten Lambda calls: four sequential, a wave of two, and a wave of
 * four. It never retries and never starts a higher wave after a failure.
 */
export async function runWorkerBenchmark(
  invoke: LambdaInvoker,
  input: { includeLambdaHash: boolean; localEncodedHash: string },
): Promise<WorkerBenchmarkReport> {
  const password = syntheticPassword();
  const wrongPassword = syntheticWrongPassword();
  const measurements: WorkerMeasurement[] = [];
  let lambdaInvocationCount = 0;
  let inFlight = 0;
  let maxInFlightRequests = 0;

  const call = async (
    stage: string,
    concurrency: number,
    request: BenchmarkRequest,
  ): Promise<BenchmarkResponse> => {
    assertCondition(
      lambdaInvocationCount < maximumInvocations,
      "Benchmark reached its invocation budget",
    );
    assertCondition(
      inFlight < maximumInFlightRequests,
      "Benchmark reached its in-flight limit",
    );
    lambdaInvocationCount += 1;
    inFlight += 1;
    maxInFlightRequests = Math.max(maxInFlightRequests, inFlight);
    try {
      const result = await invoke(request);
      assertCondition(
        result.body.operation === request.operation,
        "Lambda returned an unexpected operation",
      );
      const { metrics } = result.body;
      measurements.push({
        concurrency,
        httpStatus: result.httpStatus,
        lambda: {
          coldStart: metrics.coldStart,
          cpuSystemMs: metrics.cpuSystemMs,
          cpuUserMs: metrics.cpuUserMs,
          elapsedMs: metrics.elapsedMs,
          memoryLimitMb: metrics.memoryLimitMb,
          processPeakRssBytes: metrics.processPeakRssBytes,
          processRssBytes: metrics.processRssBytes,
        },
        operation: request.operation,
        stage,
        ...(result.body.operation === "verify"
          ? { verified: result.body.verified }
          : {}),
        workerRoundTripMs: result.roundTripMs,
      });
      return result.body;
    } finally {
      inFlight -= 1;
    }
  };
  const hashed = async (stage: string, concurrency: number) => {
    const response = await call(stage, concurrency, {
      operation: "hash",
      password,
    });
    assertCondition(response.operation === "hash", "Expected hash response");
    return response.encodedHash;
  };
  const verified = async (
    stage: string,
    concurrency: number,
    candidate: string,
    encodedHash: string,
  ) => {
    const response = await call(stage, concurrency, {
      encodedHash,
      operation: "verify",
      password: candidate,
    });
    assertCondition(response.operation === "verify", "Expected verify response");
    return response.verified;
  };

  const lambdaHash = await hashed("sequential-hash", 1);
  assertCondition(
    storedHashPattern.test(lambdaHash),
    "Lambda returned a hash outside the expected scrypt profile",
  );
  assertCondition(
    await verified("sequential-verify", 1, password, lambdaHash),
    "Lambda did not verify its own hash",
  );
  assertCondition(
    !(await verified("sequential-wrong-password", 1, wrongPassword, lambdaHash)),
    "Lambda accepted a wrong synthetic password",
  );
  assertCondition(
    await verified("sequential-local-hash", 1, password, input.localEncodedHash),
    "Lambda did not verify a locally generated hash",
  );

  for (const concurrency of [2, 4]) {
    const results = await Promise.allSettled(
      Array.from({ length: concurrency }, (_, index) =>
        index % 2 === 0
          ? hashed(`concurrency-${concurrency}`, concurrency)
          : verified(`concurrency-${concurrency}`, concurrency, password, lambdaHash),
      ),
    );
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected) {
      const throttled =
        rejected.reason instanceof LambdaCallError &&
        rejected.reason.status === 429;
      throw new Error(
        throttled
          ? `Lambda throttled a request at concurrency ${concurrency}; no higher concurrency was attempted`
          : `Lambda concurrency ${concurrency} wave failed; no higher concurrency was attempted`,
      );
    }
    assertCondition(
      results.every(
        (result) =>
          result.status === "fulfilled" && result.value !== false,
      ),
      `Lambda verification failed at concurrency ${concurrency}`,
    );
  }

  return {
    checks: {
      lambdaRejectedWrongPassword: true,
      lambdaVerifiedItsOwnHash: true,
      lambdaVerifiedLocalHash: true,
    },
    ...(input.includeLambdaHash ? { lambdaEncodedHash: lambdaHash } : {}),
    lambdaInvocationCount,
    maxInFlightRequests,
    measurements,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
    status,
  });
}

export function createWorkerLambdaBenchmark(
  fetcher: typeof fetch = fetch,
) {
  return {
    async fetch(
      request: Request,
      environment: WorkerLambdaEnvironment,
    ): Promise<Response> {
      // The tester check runs before routing, parsing, or any Lambda work.
      const testerIp = environment.TESTER_IP;
      if (!testerIp || request.headers.get("CF-Connecting-IP") !== testerIp) {
        return new Response("Forbidden", { status: 403 });
      }

      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/") {
        return jsonResponse({ ready: true });
      }
      if (request.method !== "POST" || url.pathname !== "/run") {
        return new Response("Not found", { status: 404 });
      }

      const input = parseRunRequest(await request.text());
      if (!input) {
        return jsonResponse({ error: "Invalid request" }, 400);
      }
      try {
        const invoke = createLambdaInvoker(environment, fetcher);
        return jsonResponse(await runWorkerBenchmark(invoke, input));
      } catch (error) {
        return jsonResponse(
          {
            error:
              error instanceof Error ? error.message : "Benchmark failed",
            kind: "failure",
          },
          502,
        );
      }
    },
  };
}

export default createWorkerLambdaBenchmark();
