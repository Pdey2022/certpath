import {
  localLearnerAuthMessageResponseSchema,
  localLearnerAuthPreflightResponseSchema,
  localLearnerSignInResponseSchema,
  localTestInboxResponseSchema,
} from "@certpath/contracts";

const authRoot = "/api/auth/local";

export class LearnerAuthApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function requestJson<T>(
  path: string,
  schema: { parse(value: unknown): T },
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${authRoot}${path}`, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(init.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new LearnerAuthApiError(0, "network_error");
  }

  let body: unknown;
  try {
    body = response.status === 204 ? null : await response.json();
  } catch {
    throw new LearnerAuthApiError(503, "service_unavailable");
  }
  if (!response.ok) {
    const error = body as { error?: { code?: unknown } } | null;
    throw new LearnerAuthApiError(
      response.status,
      typeof error?.error?.code === "string"
        ? error.error.code
        : "service_unavailable",
    );
  }
  try {
    return schema.parse(body);
  } catch {
    throw new LearnerAuthApiError(503, "service_unavailable");
  }
}

export function getLearnerAuthPreflight() {
  return requestJson("/preflight", localLearnerAuthPreflightResponseSchema);
}

export function registerLearner(email: string) {
  return requestJson(
    "/register",
    localLearnerAuthMessageResponseSchema,
    { method: "POST", body: JSON.stringify({ email }) },
  );
}

export function signInLearner(email: string, password: string) {
  return requestJson(
    "/sign-in",
    localLearnerSignInResponseSchema,
    { method: "POST", body: JSON.stringify({ email, password }) },
  );
}

export function verifyLearnerEmail(token: string, password: string) {
  return requestJson(
    "/verify-email",
    localLearnerAuthMessageResponseSchema,
    { method: "POST", body: JSON.stringify({ token, password }) },
  );
}

export function requestLearnerPasswordReset(email: string) {
  return requestJson(
    "/recover",
    localLearnerAuthMessageResponseSchema,
    { method: "POST", body: JSON.stringify({ email }) },
  );
}

export function resetLearnerPassword(token: string, password: string) {
  return requestJson(
    "/reset-password",
    localLearnerAuthMessageResponseSchema,
    { method: "POST", body: JSON.stringify({ token, password }) },
  );
}

export function readLocalTestInbox(email: string) {
  return requestJson(
    `/test-inbox?${new URLSearchParams({ email })}`,
    localTestInboxResponseSchema,
  );
}
