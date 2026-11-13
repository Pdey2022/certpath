import {
  PasswordHashUnavailableError,
  hashLearnerPassword,
  verifyLearnerPassword,
} from "../../src/security/password-hashing.ts";
import type {
  BenchmarkMetrics,
  BenchmarkRequest,
  BenchmarkResponse,
} from "./protocol.ts";

interface FunctionUrlEvent {
  body?: string | null;
  isBase64Encoded?: boolean;
  rawPath?: string;
  requestContext?: {
    http?: { method?: string };
    requestId?: string;
  };
}

interface LambdaContext {
  memoryLimitInMB?: string;
  requestId?: string;
}

interface FunctionUrlResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

type HashPassword = typeof hashLearnerPassword;
type VerifyPassword = typeof verifyLearnerPassword;

const maximumBodyBytes = 4_096;
const maximumPasswordBytes = 1_024;
const maximumEncodedHashCharacters = 128;
let hasHandledInvocation = false;

function jsonResponse(
  statusCode: number,
  body: unknown,
): FunctionUrlResponse {
  return {
    statusCode,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  };
}

function validPassword(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumPasswordBytes
  );
}

function parseRequestBody(event: FunctionUrlEvent): unknown | null {
  const rawBody = event.body ?? "";
  if (rawBody.length > maximumBodyBytes * 2) {
    return null;
  }

  const body = event.isBase64Encoded
    ? Buffer.from(rawBody, "base64").toString("utf8")
    : rawBody;
  if (Buffer.byteLength(body, "utf8") > maximumBodyBytes) {
    return null;
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function validRequest(value: unknown): value is BenchmarkRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const request = value as Record<string, unknown>;
  if (!validPassword(request.password)) {
    return false;
  }
  if (request.operation === "hash") {
    return Object.keys(request).length === 2;
  }
  return (
    request.operation === "verify" &&
    typeof request.encodedHash === "string" &&
    request.encodedHash.length > 0 &&
    request.encodedHash.length <= maximumEncodedHashCharacters &&
    Object.keys(request).length === 3
  );
}

function currentProcessPeakRssBytes(): number {
  const maximumRss = process.resourceUsage().maxRSS;
  return process.platform === "win32" ? maximumRss : maximumRss * 1_024;
}

function collectMetrics(
  startedAt: number,
  cpuStarted: NodeJS.CpuUsage,
  context: LambdaContext,
  coldStart: boolean,
): BenchmarkMetrics {
  const cpu = process.cpuUsage(cpuStarted);
  return {
    coldStart,
    cpuSystemMs: cpu.system / 1_000,
    cpuUserMs: cpu.user / 1_000,
    elapsedMs: performance.now() - startedAt,
    memoryLimitMb: context.memoryLimitInMB
      ? Number(context.memoryLimitInMB)
      : null,
    processPeakRssBytes: currentProcessPeakRssBytes(),
    processRssBytes: process.memoryUsage().rss,
    requestId: context.requestId ?? "local-test",
  };
}

export function createLambdaHandler(
  hashPassword: HashPassword = hashLearnerPassword,
  verifyPassword: VerifyPassword = verifyLearnerPassword,
) {
  return async (
    event: FunctionUrlEvent,
    context: LambdaContext,
  ): Promise<FunctionUrlResponse> => {
    const coldStart = !hasHandledInvocation;
    hasHandledInvocation = true;

    const method = event.requestContext?.http?.method ?? "GET";
    if (method !== "POST") {
      return jsonResponse(405, { error: "Method not allowed" });
    }

    const path = event.rawPath ?? "/";
    if (path !== "/hash" && path !== "/verify") {
      return jsonResponse(404, { error: "Not found" });
    }

    const request = parseRequestBody(event);
    if (!request || !validRequest(request)) {
      return jsonResponse(400, { error: "Invalid benchmark request" });
    }
    if (
      (path === "/hash" && request.operation !== "hash") ||
      (path === "/verify" && request.operation !== "verify")
    ) {
      return jsonResponse(400, { error: "Operation does not match route" });
    }

    const startedAt = performance.now();
    const cpuStarted = process.cpuUsage();
    try {
      if (request.operation === "hash") {
        const encodedHash = await hashPassword(request.password);
        const response: BenchmarkResponse = {
          operation: "hash",
          encodedHash,
          metrics: collectMetrics(
            startedAt,
            cpuStarted,
            context,
            coldStart,
          ),
        };
        return jsonResponse(200, response);
      }

      const verified = await verifyPassword(
        request.password,
        request.encodedHash,
      );
      const response: BenchmarkResponse = {
        operation: "verify",
        verified,
        metrics: collectMetrics(
          startedAt,
          cpuStarted,
          context,
          coldStart,
        ),
      };
      return jsonResponse(200, response);
    } catch (error) {
      if (error instanceof PasswordHashUnavailableError) {
        return jsonResponse(500, { error: "Hashing operation failed" });
      }
      throw error;
    }
  };
}

export const handler = createLambdaHandler();
