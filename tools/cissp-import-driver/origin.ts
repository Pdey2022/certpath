import { DriverError } from "./errors.ts";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Normalises a bare origin and refuses anything that is not one. `flag` is
 * required and names the argument in every failure message: only the caller
 * knows whether the value came from `--origin` or `--remote-confirm`.
 */
export function normalizeOrigin(value: string, flag: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new DriverError(
      "ORIGIN_INVALID",
      `${flag} must be a bare origin including the scheme, e.g. https://example.workers.dev`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DriverError("ORIGIN_INVALID", `${flag} must use http or https`);
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new DriverError("ORIGIN_INVALID", `${flag} must be a bare origin`);
  }
  if (url.pathname !== "/") {
    throw new DriverError("ORIGIN_INVALID", `${flag} must be a bare origin with no path`);
  }
  return url.origin;
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export interface OriginPolicyOptions {
  origin: string;
  allowRemote: boolean;
  remoteConfirm: string | null;
  approval: string | null;
}

/**
 * Loopback unless the operator supplied both remote flags *and* a recorded
 * owner approval naming the exact origin. Nothing in this slice runs remotely.
 */
export function assertOriginPolicy(options: OriginPolicyOptions): void {
  const origin = normalizeOrigin(options.origin, "--origin");
  if (isLoopbackOrigin(origin)) {
    if (options.allowRemote || options.remoteConfirm !== null) {
      throw new DriverError(
        "ORIGIN_INVALID",
        "the remote flags are meaningless for a loopback origin",
      );
    }
    return;
  }
  if (!options.allowRemote || options.remoteConfirm === null) {
    throw new DriverError(
      "ORIGIN_NOT_LOOPBACK",
      "a non-loopback origin requires --allow-remote and --remote-confirm",
    );
  }
  if (normalizeOrigin(options.remoteConfirm, "--remote-confirm") !== origin) {
    throw new DriverError(
      "REMOTE_CONFIRM_MISMATCH",
      "--remote-confirm must equal --origin exactly",
    );
  }
  if (options.approval === null || options.approval.trim().length === 0) {
    throw new DriverError(
      "REMOTE_APPROVAL_MISSING",
      "a non-loopback origin also requires --approval naming the recorded owner approval",
    );
  }
  // All three conditions hold. No run in this slice uses it; the gate exists so
  // that a future, separately approved run passes through one auditable check.
}
