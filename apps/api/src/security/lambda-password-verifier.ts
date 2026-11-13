import { signLambdaRequest } from "./sigv4.ts";
import type { TemporaryCredentials } from "./sigv4.ts";

export interface LambdaPasswordVerifierBindings {
  AWS_ACCESS_KEY_ID?: string;
  AWS_REGION?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
  LAMBDA_FUNCTION_URL?: string;
}

export class LambdaPasswordVerificationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "LambdaPasswordVerificationError";
  }
}

const region = "eu-north-1";
const maximumResponseCharacters = 8_192;
const requestTimeoutMs = 10_000;

function validateFunctionUrl(value: string, configuredRegion: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new LambdaPasswordVerificationError(
      "Staging Lambda verification is not configured",
      error,
    );
  }
  const expectedSuffix = `.lambda-url.${region}.on.aws`;
  if (
    configuredRegion !== region ||
    url.protocol !== "https:" ||
    !url.hostname.endsWith(expectedSuffix) ||
    url.hostname.length === expectedSuffix.length ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.port ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new LambdaPasswordVerificationError(
      "Staging Lambda verification endpoint is invalid",
    );
  }
  url.pathname = "/verify";
  return url;
}

export function createLambdaPasswordVerifier(
  fetcher: typeof fetch = fetch,
  now: () => Date = () => new Date(),
) {
  return async (
    password: string,
    encodedHash: string,
    bindings: LambdaPasswordVerifierBindings,
  ): Promise<boolean> => {
    const {
      AWS_ACCESS_KEY_ID: accessKeyId,
      AWS_REGION: configuredRegion,
      AWS_SECRET_ACCESS_KEY: secretAccessKey,
      AWS_SESSION_TOKEN: sessionToken,
      LAMBDA_FUNCTION_URL: functionUrl,
    } = bindings;
    if (
      !accessKeyId ||
      !secretAccessKey ||
      !sessionToken ||
      !configuredRegion ||
      !functionUrl
    ) {
      throw new LambdaPasswordVerificationError(
        "Staging Lambda verification is not configured",
      );
    }

    const credentials: TemporaryCredentials = {
      accessKeyId,
      secretAccessKey,
      sessionToken,
    };
    const url = validateFunctionUrl(functionUrl, configuredRegion);
    const body = JSON.stringify({
      encodedHash,
      operation: "verify",
      password,
    });
    const headers = await signLambdaRequest({
      body,
      credentials,
      now: now(),
      region,
      url,
    });

    let response: Response;
    try {
      response = await fetcher(url, {
        body,
        headers,
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      throw new LambdaPasswordVerificationError(
        "Staging Lambda verification request failed",
        error,
      );
    }
    if (!response.ok) {
      throw new LambdaPasswordVerificationError(
        `Staging Lambda verification returned HTTP ${response.status}`,
      );
    }

    const responseText = await response.text();
    if (responseText.length > maximumResponseCharacters) {
      throw new LambdaPasswordVerificationError(
        "Staging Lambda verification response exceeded its limit",
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(responseText);
    } catch (error) {
      throw new LambdaPasswordVerificationError(
        "Staging Lambda verification returned invalid JSON",
        error,
      );
    }
    if (
      !value ||
      typeof value !== "object" ||
      !("operation" in value) ||
      value.operation !== "verify" ||
      !("verified" in value) ||
      typeof value.verified !== "boolean"
    ) {
      throw new LambdaPasswordVerificationError(
        "Staging Lambda verification returned an invalid response",
      );
    }
    return value.verified;
  };
}
