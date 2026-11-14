import type { StaffMfaPolicy } from "./mfa.ts";

export interface StaffSecurityBindings {
  PUBLIC_SITE_ORIGIN?: string;
  STAFF_MFA_MAX_AGE_MS?: string;
  STAFF_MFA_ALLOWED_METHODS?: string;
  CSRF_HMAC_SECRET?: string;
  ADMIN_TESTER_IPS?: string;
  ADMIN_TESTER_ASSURANCE?: string;
  ADMIN_TESTER_LOCAL?: string;
}

export interface StaffSecurityConfiguration {
  origin: string;
  policy: StaffMfaPolicy;
  csrfSecret: Uint8Array;
}

const supportedMfaMethods = new Set([
  "totp",
  "webauthn",
  "sms",
  "tester-gate",
]);

function safeHostname(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

/**
 * Parses the staff security configuration. The tester-gate assurance is only
 * accepted when an admin tester allowlist exists and the owner has explicitly
 * enabled it, so a production configuration cannot quietly allow it.
 */
export function readStaffSecurityConfiguration(
  bindings: StaffSecurityBindings,
): StaffSecurityConfiguration | null {
  const originValue = bindings.PUBLIC_SITE_ORIGIN;
  const ageValue = bindings.STAFF_MFA_MAX_AGE_MS;
  const methodsValue = bindings.STAFF_MFA_ALLOWED_METHODS;
  const secretValue = bindings.CSRF_HMAC_SECRET;
  if (!originValue || !ageValue || !methodsValue || !secretValue) return null;

  const localTesterOrigin =
    bindings.ADMIN_TESTER_LOCAL === "true" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(
      safeHostname(originValue) ?? "",
    );

  let origin: URL;
  try {
    origin = new URL(originValue);
  } catch {
    return null;
  }
  const httpsOrigin = origin.protocol === "https:";
  const allowedOrigin =
    httpsOrigin || (localTesterOrigin && origin.protocol === "http:");
  if (
    !allowedOrigin ||
    origin.origin !== originValue ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    return null;
  }
  if (!/^[1-9]\d*$/.test(ageValue)) return null;
  const maxAgeMs = Number(ageValue);
  if (!Number.isSafeInteger(maxAgeMs)) return null;

  const methodValues = methodsValue.split(",").map((method) => method.trim());
  if (
    methodValues.length === 0 ||
    methodValues.some((method) => !supportedMfaMethods.has(method)) ||
    new Set(methodValues).size !== methodValues.length
  ) {
    return null;
  }
  if (methodValues.includes("tester-gate")) {
    const allowlist = bindings.ADMIN_TESTER_IPS?.split(",")
      .map((ip) => ip.trim())
      .filter(Boolean);
    if (
      bindings.ADMIN_TESTER_ASSURANCE !== "true" ||
      !allowlist?.length
    ) {
      return null;
    }
  }

  const csrfSecret = new TextEncoder().encode(secretValue);
  if (csrfSecret.byteLength < 32) return null;
  return {
    origin: originValue,
    policy: {
      maxAgeMs,
      allowedMethods: methodValues as StaffMfaPolicy["allowedMethods"],
    },
    csrfSecret,
  };
}
