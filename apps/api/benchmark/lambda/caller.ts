import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Hash } from "@smithy/hash-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import type {
  BenchmarkRequest,
  BenchmarkResponse,
} from "./protocol.ts";

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignedCallResult {
  body: BenchmarkResponse;
  httpStatus: number;
  roundTripMs: number;
}

interface SignedCallerOptions {
  credentials?: () => Promise<AwsCredentials>;
  fetcher?: typeof fetch;
  functionUrl: string;
  region: string;
  timeoutMs?: number;
}

export class FunctionUrlCallError extends Error {
  readonly status: number;

  constructor(status: number) {
    const permissionHint =
      status === 403
        ? "; check lambda:InvokeFunctionUrl and lambda:InvokeFunction"
        : "";
    const responseMessage =
      status === 429
        ? "Function URL request was throttled (HTTP 429)"
        : `Function URL returned HTTP ${status}${permissionHint}`;
    super(responseMessage);
    this.name = "FunctionUrlCallError";
    this.status = status;
  }
}

function validateEndpoint(functionUrl: string, region: string): URL {
  const endpoint = new URL(functionUrl);
  const expectedSuffix = `.lambda-url.${region}.on.aws`;
  if (
    endpoint.protocol !== "https:" ||
    !endpoint.hostname.endsWith(expectedSuffix) ||
    endpoint.hostname.length === expectedSuffix.length ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error("Function URL must be an HTTPS URL for the configured region");
  }
  return endpoint;
}

function parseResponse(body: string): BenchmarkResponse {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Function URL returned an invalid JSON response");
    }
    throw error;
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("operation" in value) ||
    !("metrics" in value)
  ) {
    throw new Error("Function URL returned an invalid benchmark response");
  }
  return value as BenchmarkResponse;
}

export function createSignedLambdaCaller(options: SignedCallerOptions) {
  const endpoint = validateEndpoint(options.functionUrl, options.region);
  const signer = new SignatureV4({
    credentials: options.credentials ?? defaultProvider(),
    region: options.region,
    service: "lambda",
    sha256: Hash.bind(null, "sha256"),
  });
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return async (requestBody: BenchmarkRequest): Promise<SignedCallResult> => {
    const body = JSON.stringify(requestBody);
    const requestUrl = new URL(endpoint);
    requestUrl.pathname =
      requestBody.operation === "hash" ? "/hash" : "/verify";
    const signedRequest = await signer.sign(
      new HttpRequest({
        body,
        headers: {
          "content-type": "application/json",
          host: endpoint.host,
        },
        hostname: endpoint.hostname,
        method: "POST",
        path: requestUrl.pathname,
        protocol: endpoint.protocol,
        port: endpoint.port ? Number(endpoint.port) : undefined,
      }),
    );
    const headers = new Headers();
    for (const [name, value] of Object.entries(signedRequest.headers)) {
      if (name.toLowerCase() !== "host") {
        headers.set(name, value);
      }
    }

    const startedAt = performance.now();
    const response = await fetcher(requestUrl, {
      body,
      headers,
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const roundTripMs = performance.now() - startedAt;
    const responseBody = await response.text();
    if (responseBody.length > 8_192) {
      throw new Error("Function URL response exceeded the benchmark limit");
    }
    if (!response.ok) {
      throw new FunctionUrlCallError(response.status);
    }

    return {
      body: parseResponse(responseBody),
      httpStatus: response.status,
      roundTripMs,
    };
  };
}
