import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";

/**
 * The validator's copy of the question-import contract.
 *
 * It is deliberately a copy, as the CISSP import driver's is: the tool is a
 * client of the public contract, and a server-side change must be a deliberate
 * change here too. `contract.test.ts` imports the real constants from
 * `apps/api/src/security/question-imports.ts` and fails if they drift.
 */
export const QUESTION_IMPORT_FORMAT = "certpath-question-v1";
export const QUESTION_IMPORT_MAX_ROWS = 10;
export const QUESTION_IMPORT_MAX_BYTES = 256 * 1024;

export const OPTION_SLOTS = 8;
export const OPTION_COUNT = 4;

export const PROFILE_FORMAT_VERSION = "certpath-question-profile-v1";
export const TAXONOMY_FORMAT_VERSION = "certpath-question-taxonomy-v1";
export const REPORT_FORMAT_VERSION = "certpath-question-check-report-v1";
export const FINDINGS_FORMAT_VERSION = "certpath-prof-findings-v1";
export const VERDICT_FORMAT_VERSION = "certpath-question-review-verdict-v1";

/** Mirrors `QUESTION_IMPORT_TEMPLATE_COLUMNS` (41 columns, this order). */
export const QUESTION_IMPORT_COLUMNS: readonly string[] = [
  "format_version",
  "question_key",
  "exam_version_id",
  "domain_id",
  "topic_id",
  "stem",
  "difficulty",
  "source_reference",
  "license_reference",
  ...Array.from({ length: OPTION_SLOTS }, (_, index) => {
    const option = index + 1;
    return [
      `option_${option}_key`,
      `option_${option}_text`,
      `option_${option}_correct`,
      `option_${option}_explanation`,
    ];
  }).flat(),
];

/** Caps from docs/question-bank-import-export.md, as the server applies them. */
export const LIMITS = {
  stem: { minimum: 5, maximum: 4000 },
  optionText: { minimum: 1, maximum: 1000 },
  explanation: { minimum: 1, maximum: 3000 },
  sourceReference: { minimum: 1, maximum: 1000 },
  licenseReference: { minimum: 1, maximum: 200 },
  questionKey: { minimum: 1, maximum: 120 },
  optionKey: { minimum: 1, maximum: 32 },
} as const;

export const MAX_CSV_RECORD_SIZE = 96 * 1024;

/** The server preview's parse options, asserted explicitly in contract.test.ts. */
export const CSV_PARSE_OPTIONS = {
  relax_column_count: true,
  skip_empty_lines: false,
  max_record_size: MAX_CSV_RECORD_SIZE,
} as const;

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Zero-based column indices of the four cells of one option slot, 1-based `option`. */
export function optionColumnIndices(option: number): {
  key: number;
  text: number;
  correct: number;
  explanation: number;
} {
  const base = 9 + (option - 1) * 4;
  return { key: base, text: base + 1, correct: base + 2, explanation: base + 3 };
}

/** Parses CSV with the exact options the server's preview validator uses. */
export function parseCsv(text: string): string[][] {
  return parse(text, CSV_PARSE_OPTIONS) as string[][];
}
