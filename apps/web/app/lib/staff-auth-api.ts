import {
  csrfResponseSchema,
  staffAdminPreflightResponseSchema,
  staffSessionResponseSchema,
  staffSignInResponseSchema,
} from "@certpath/contracts";

const adminAuthRoot = "/api/admin/auth";
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