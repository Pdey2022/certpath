/**
 * Named, fail-closed failure codes for the CISSP import driver.
 *
 * An error message is printed to stderr after the code. It may carry an HTTP
 * status, a server `requestId`, a row number or a column name, and it must
 * never carry a password, TOTP code or seed, a session cookie, a CSRF token, a
 * question stem, an option, an explanation or provenance prose.
 */
export type DriverErrorCode =
  | "UNKNOWN_ARGUMENT"
  | "DUPLICATE_ARGUMENT"
  | "MISSING_ARGUMENT"
  | "INVALID_ARGUMENT"
  | "PASSWORD_ON_ARGV"
  | "ORIGIN_INVALID"
  | "ORIGIN_NOT_LOOPBACK"
  | "REMOTE_FLAGS_INCOMPLETE"
  | "REMOTE_CONFIRM_MISMATCH"
  | "REMOTE_APPROVAL_MISSING"
  | "STATE_INSIDE_REPOSITORY"
  | "STATE_PATH_INVALID"
  | "SECRET_UNAVAILABLE"
  | "PROSE_UNREADABLE"
  | "PROSE_INVALID_JSON"
  | "PROSE_FORMAT_INVALID"
  | "PROSE_UNKNOWN_KEY"
  | "PROSE_MISSING"
  | "PROSE_TAXONOMY_DIGEST_MISMATCH"
  | "PROSE_IDENTITY_INVALID"
  | "PROSE_MEANING_BLANK"
  | "PROSE_MEANING_OVER_LIMIT"
  | "PROSE_MEANING_CONTROL_CHARACTER"
  | "PROSE_DOMAIN_SET_MISMATCH"
  | "PROSE_TOPIC_SET_MISMATCH"
  | "TAXONOMY_UNREADABLE"
  | "TAXONOMY_INVALID"
  | "CONVERTER_MANIFEST_UNREADABLE"
  | "CONVERTER_MANIFEST_INVALID"
  | "CONVERTER_FILE_MISSING"
  | "CONVERTER_DIGEST_MISMATCH"
  | "CONVERTER_COUNT_MISMATCH"
  | "TAXONOMY_REPORT_UNREADABLE"
  | "TAXONOMY_REPORT_MISMATCH"
  | "CSV_NOT_UTF8"
  | "CSV_UNPARSEABLE"
  | "CSV_HEADER_MISMATCH"
  | "CSV_COLUMN_COUNT"
  | "CSV_VALUE_INVALID"
  | "DUPLICATE_QUESTION_KEY"
  | "QUESTION_KEY_INVALID"
  | "UNKNOWN_TAXONOMY_ID"
  | "BATCH_SIZE_INVALID"
  | "UNIT_TOO_LARGE"
  | "UNIT_LIMIT_INVALID"
  | "CHECKPOINT_UNREADABLE"
  | "CHECKPOINT_INVALID"
  | "CHECKPOINT_MISMATCH"
  | "STAGE_ORDER"
  | "TRANSITION_INVALID"
  | "AUTH_FAILED"
  | "SESSION_LOST"
  | "RATE_LIMITED"
  | "ACTOR_CHANGED"
  | "CERTIFICATION_CREATE_FORBIDDEN"
  | "CERTIFICATION_NOT_FOUND"
  | "KEY_COLLISION"
  | "TAXONOMY_PROSE_MISMATCH"
  | "PROSE_TAXONOMY_DIGEST_MISSING"
  | "PREVIEW_REJECTED"
  | "EXISTING_KEYS"
  | "CONFIRM_FAILED"
  | "PARTIAL_IMPORT"
  | "WORKFLOW_CONFLICT"
  | "PUBLICATION_CONFLICT"
  | "CONSECUTIVE_FAILURES"
  | "VERIFY_COUNT_MISMATCH"
  | "VERIFY_KEY_MISMATCH"
  | "PROTOCOL_ERROR"
  | "UNEXPECTED";

export interface DriverErrorExtras {
  status?: number;
  requestId?: string;
  info?: Record<string, string | number | boolean | null>;
}

export class DriverError extends Error {
  readonly code: DriverErrorCode;
  readonly status?: number;
  readonly requestId?: string;
  readonly info?: Record<string, string | number | boolean | null>;

  constructor(code: DriverErrorCode, detail: string, extras: DriverErrorExtras = {}) {
    super(detail);
    this.name = "DriverError";
    this.code = code;
    this.status = extras.status;
    this.requestId = extras.requestId;
    this.info = extras.info;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof DriverError) {
    const parts = [error.message];
    if (error.status !== undefined) parts.push(`status=${error.status}`);
    if (error.requestId !== undefined) parts.push(`requestId=${error.requestId}`);
    return `${error.code}: ${parts.join(" ")}`;
  }
  return "UNEXPECTED";
}
