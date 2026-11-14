import {
  csrfResponseSchema,
  learnerEmailSignInInspectResponseSchema,
  learnerEmailSignInRedeemResponseSchema,
  localLearnerAuthMessageResponseSchema,
  localLearnerAuthPreflightResponseSchema,
  localLearnerSignInResponseSchema,
  localTestInboxResponseSchema,
} from "@certpath/contracts";

const localAuthRoot = "/api/auth/local";
const stagingAuthRoot = "/api/auth/staging";
const googleAuthRoot = "/api/auth/google";
const emailLinkRoot = "/api/auth/email-link";
const stagingAuthOrigin =
  "https://learner-auth-staging.certpath.workers.dev";
const localStagingAuthOrigin =
  import.meta.env?.VITE_CERTPATH_STAGING_LOCAL_ORIGIN;
const pilotOrigin = import.meta.env?.VITE_CERTPATH_PILOT_ORIGIN;
const pilotOriginFallback = "https://certpath-pilot.certpath.workers.dev";

export function isStagingLearnerAuth(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.location.origin === stagingAuthOrigin ||
      window.location.origin === localStagingAuthOrigin)
  );
}

export function isPilotSite(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.location.origin === pilotOrigin ||
    window.location.origin === pilotOriginFallback
  );
}

/**
 * Google sign-in is offered on the staging origin and on the private pilot
 * origin, independently of whether password sign-in is configured.
 */
export function isGoogleSignInOrigin(): boolean {
  return isStagingLearnerAuth() || isPilotSite();
}

export function startGoogleSignIn(): void {
  if (typeof window !== "undefined") {
    window.location.assign("/api/auth/google/start");
  }
}

function authRoot(): string {
  return isStagingLearnerAuth() ? stagingAuthRoot : localAuthRoot;
}

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
  root: string = authRoot(),
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${root}${path}`, {
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

export function getGoogleSignInPreflight() {
  return requestJson(
    "/preflight",
    localLearnerAuthPreflightResponseSchema,
    {},
    googleAuthRoot,
  );
}

export function getLearnerEmailLinkPreflight() {
  return requestJson(
    "/preflight",
    localLearnerAuthPreflightResponseSchema,
    {},
    emailLinkRoot,
  );
}

export function registerLearner(email: string) {
  return requestJson(
    "/register",
    localLearnerAuthMessageResponseSchema,
    { method: "POST", body: JSON.stringify({ email }) },
  );
}

export async function signInLearner(email: string, password: string) {
  const headers = isStagingLearnerAuth()
    ? {
        "X-CSRF-Token": (await requestJson("/csrf", csrfResponseSchema))
          .csrfToken,
      }
    : undefined;
  return requestJson(
    "/sign-in",
    localLearnerSignInResponseSchema,
    {
      method: "POST",
      body: JSON.stringify({ email, password }),
      headers,
    },
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

export function requestLearnerSignInLink(email: string) {
  return requestJson(
    "/request",
    localLearnerAuthMessageResponseSchema,
    { method: "POST", body: JSON.stringify({ email }) },
    emailLinkRoot,
  );
}

export function inspectLearnerSignInLink(token: string) {
  return requestJson(
    "/inspect",
    learnerEmailSignInInspectResponseSchema,
    { method: "POST", body: JSON.stringify({ token }) },
    emailLinkRoot,
  );
}

export function redeemLearnerSignInLink(token: string) {
  return requestJson(
    "/redeem",
    learnerEmailSignInRedeemResponseSchema,
    { method: "POST", body: JSON.stringify({ token }) },
    emailLinkRoot,
  );
}

export async function readLocalTestInbox(email: string) {
  const path = `/test-inbox?${new URLSearchParams({ email })}`;
  try {
    return await requestJson(path, localTestInboxResponseSchema);
  } catch (error) {
    if (error instanceof LearnerAuthApiError && error.status === 503) {
      return requestJson(path, localTestInboxResponseSchema, {}, emailLinkRoot);
    }
    throw error;
  }
}