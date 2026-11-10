export type SupportedMfaMethod = "totp" | "webauthn" | "sms";

export interface StaffMfaPolicy {
  maxAgeMs: number;
  allowedMethods: readonly SupportedMfaMethod[];
}

export interface MfaAssurance {
  method: string | null;
  verifiedAt: number | null;
}

export type MfaFailure =
  | "policy-unconfigured"
  | "policy-invalid"
  | "assurance-missing"
  | "assurance-unsupported"
  | "assurance-stale";

const supportedMethods: readonly string[] = ["totp", "webauthn", "sms"];

export function getMfaFailure(
  assurance: MfaAssurance,
  now: number,
  policy: StaffMfaPolicy | undefined,
): MfaFailure | null {
  if (!policy) return "policy-unconfigured";
  if (
    !Number.isSafeInteger(policy.maxAgeMs) ||
    policy.maxAgeMs <= 0 ||
    policy.allowedMethods.length === 0 ||
    policy.allowedMethods.some((method) => !supportedMethods.includes(method))
  ) {
    return "policy-invalid";
  }
  if (assurance.method === null || assurance.verifiedAt === null) {
    return "assurance-missing";
  }
  if (!policy.allowedMethods.includes(assurance.method as SupportedMfaMethod)) {
    return "assurance-unsupported";
  }
  if (
    !Number.isSafeInteger(assurance.verifiedAt) ||
    assurance.verifiedAt > now ||
    assurance.verifiedAt < now - policy.maxAgeMs
  ) {
    return "assurance-stale";
  }
  return null;
}

export function isConfiguredMfaPolicy(
  policy: StaffMfaPolicy | undefined,
): policy is StaffMfaPolicy {
  return (
    policy !== undefined &&
    Number.isSafeInteger(policy.maxAgeMs) &&
    policy.maxAgeMs > 0 &&
    policy.allowedMethods.length > 0 &&
    policy.allowedMethods.every((method) => supportedMethods.includes(method))
  );
}
