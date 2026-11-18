import {
  csrfResponseSchema,
  staffAdminPreflightResponseSchema,
  staffMfaConfirmResponseSchema,
  staffMfaEnrolResponseSchema,
  staffMfaRecoveryResponseSchema,
  staffSessionResponseSchema,
  staffSignInResponseSchema,
  staffMfaVerifyResponseSchema,
} from "@certpath/contracts";

const adminAuthRoot = "/api/admin/auth";
const adminRoot = "/api/admin";
const sessionRoot = "/api/auth/session";

export class StaffAuthApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function requestJson<T>(
  root: string,
  path: string,
  schema: { parse(value: unknown): T },
  init: RequestInit = {},
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
    throw new StaffAuthApiError(0, "network_error");
  }

  let body: unknown;
  try {
    body = response.status === 204 ? null : await response.json();
  } catch {
    throw new StaffAuthApiError(503, "service_unavailable");
  }
  if (!response.ok) {
    const error = body as { error?: { code?: unknown } } | null;
    throw new StaffAuthApiError(
      response.status,
      typeof error?.error?.code === "string"
        ? error.error.code
        : "service_unavailable",
    );
  }
  try {
    return schema.parse(body);
  } catch {
    throw new StaffAuthApiError(503, "service_unavailable");
  }
}

export function getStaffAuthPreflight() {
  return requestJson(
    adminAuthRoot,
    "/preflight",
    staffAdminPreflightResponseSchema,
  );
}

export function getStaffSession() {
  return requestJson(adminAuthRoot, "/session", staffSessionResponseSchema);
}

export function signInStaff(email: string, password: string) {
  return requestJson(adminAuthRoot, "/sign-in", staffSignInResponseSchema, {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function signOutStaff() {
  const { csrfToken } = await requestJson(
    sessionRoot,
    "/csrf",
    csrfResponseSchema,
  );
  let response: Response;
  try {
    response = await fetch(`${sessionRoot}/logout`, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "X-CSRF-Token": csrfToken },
    });
  } catch {
    throw new StaffAuthApiError(0, "network_error");
  }
  if (response.status !== 204) {
    throw new StaffAuthApiError(response.status, "sign_out_failed");
  }
}

/**
 * The second-factor calls. Every one is a POST from the same origin, so each
 * fetches the admin CSRF token first - the token is minted for a live staff
 * session, and a password-only session holds one.
 */
async function adminCsrfToken(): Promise<string> {
  const { csrfToken } = await requestJson(
    adminRoot,
    "/csrf",
    csrfResponseSchema,
  );
  return csrfToken;
}

async function postWithCsrf<T>(
  path: string,
  body: unknown,
  schema: { parse(value: unknown): T },
): Promise<T> {
  const csrfToken = await adminCsrfToken();
  return requestJson(adminAuthRoot, path, schema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(body),
  });
}

export function enrolStaffMfa(ticket: string) {
  return postWithCsrf(
    "/mfa/enrol",
    { ticket },
    staffMfaEnrolResponseSchema,
  );
}

export function confirmStaffMfaEnrolment(code: string) {
  return postWithCsrf(
    "/mfa/enrol/confirm",
    { code },
    staffMfaConfirmResponseSchema,
  );
}

export function verifyStaffMfa(code: string) {
  return postWithCsrf("/mfa/verify", { code }, staffMfaVerifyResponseSchema);
}

export function redeemStaffMfaRecoveryCode(recoveryCode: string) {
  return postWithCsrf(
    "/mfa/recovery",
    { recoveryCode },
    staffMfaRecoveryResponseSchema,
  );
}