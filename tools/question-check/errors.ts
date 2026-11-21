/**
 * Named, fail-closed failure codes for the question-check validator.
 *
 * A message is printed to stderr after the code. It may carry a file name, a
 * row number, a column name, a question key, a finding code or a count. It must
 * never carry a question stem, an option text, an explanation or provenance
 * prose: item text is data, and the terminal is not a place for it.
 *
 * Exit mapping (docs/question-check.md §Exit codes):
 *   2 — the tool refused to judge anything (`refused`)
 *   3 — the tool failed after judging began (`incomplete`)
 */
export type QuestionCheckErrorCode =
  | "UNKNOWN_VERB"
  | "UNKNOWN_ARGUMENT"
  | "DUPLICATE_ARGUMENT"
  | "MISSING_ARGUMENT"
  | "INVALID_ARGUMENT"
  | "OUT_INSIDE_REPOSITORY"
  | "INPUT_INSIDE_REPOSITORY"
  | "OUT_NOT_EMPTY"
  | "BATCHES_UNREADABLE"
  | "BATCHES_EMPTY"
  | "IMPORTED_KEYS_UNREADABLE"
  | "PROFILE_UNREADABLE"
  | "PROFILE_INVALID_JSON"
  | "PROFILE_INVALID"
  | "TAXONOMY_UNREADABLE"
  | "TAXONOMY_INVALID_JSON"
  | "TAXONOMY_INVALID"
  | "TAXONOMY_TITLE_BLANK"
  | "TAXONOMY_MEANING_BLANK"
  | "TAXONOMY_DOMAIN_SET_MISMATCH"
  | "CANNOT_SUPPRESS_ERROR"
  | "SUPPRESSION_UNJUSTIFIED"
  | "REPORT_UNREADABLE"
  | "REPORT_INVALID_JSON"
  | "REPORT_INVALID"
  | "FINDINGS_UNREADABLE"
  | "FINDINGS_INVALID_JSON"
  | "FINDINGS_INVALID"
  | "STALE_REPORT"
  | "CANNOT_OVERRIDE_ERROR"
  | "IO_FAILED";

export interface QuestionCheckErrorExtras {
  info?: Record<string, string | number | boolean | null>;
}

export class QuestionCheckError extends Error {
  readonly code: QuestionCheckErrorCode;
  readonly info?: Record<string, string | number | boolean | null>;

  constructor(
    code: QuestionCheckErrorCode,
    detail: string,
    extras: QuestionCheckErrorExtras = {},
  ) {
    super(detail);
    this.name = "QuestionCheckError";
    this.code = code;
    this.info = extras.info;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof QuestionCheckError) {
    return `${error.code}: ${error.message}`;
  }
  return "UNEXPECTED";
}

/** Every thrown error except an explicit I/O failure means "nothing was judged". */
export function refusalExitCode(error: unknown): number {
  if (error instanceof QuestionCheckError && error.code === "IO_FAILED") return 3;
  return 2;
}
