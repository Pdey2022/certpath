import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { DriverError } from "./errors.ts";
import { csvCell, csvLine } from "../cissp-convert/cli.ts";

/**
 * The driver's copy of the question-import contract.
 *
 * It is deliberately a copy: the tool is a client of the public contract, and a
 * server-side change must be a deliberate change here too. `contract.test.ts`
 * imports the real constants and fails if they drift.
 */
export const QUESTION_IMPORT_FORMAT = "certpath-question-v1";
export const QUESTION_IMPORT_MAX_ROWS = 10;
export const QUESTION_IMPORT_MAX_BYTES = 256 * 1024;
export const QUESTION_IMPORT_TTL_MS = 10 * 60 * 1000;

export const TAXONOMY_FORMAT_VERSION = "certpath-cissp-taxonomy-v1";
export const PROSE_FORMAT_VERSION = "certpath-cissp-taxonomy-prose-v1";
export const CONVERTER_MANIFEST_FORMAT_VERSION =
  "certpath-cissp-convert-manifest-v1";
export const TAXONOMY_REPORT_FORMAT_VERSION =
  "certpath-cissp-convert-taxonomy-report-v1";
export const UPLOAD_MANIFEST_FORMAT_VERSION =
  "certpath-cissp-upload-manifest-v1";
export const CHECKPOINT_FORMAT_VERSION = "certpath-cissp-import-checkpoint-v1";

/** Stage 3's approved default. Ten is the contract's ceiling, not the driver's. */
export const DRIVER_BATCH_SIZE_DEFAULT = 5;
export const DRIVER_BATCH_SIZE_MIN = 1;
export const DRIVER_BATCH_SIZE_MAX = 10;

/** The confirm/preview TTL margin: never confirm inside the last minute. */
export const PREVIEW_EXPIRY_MARGIN_MS = 60 * 1000;

export const OPTION_SLOTS = 8;
export const OPTION_COUNT = 4;

/** Mirrors `QUESTION_IMPORT_TEMPLATE_COLUMNS` (41 columns). */
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

/** Zero-based indices of the three cells stage 2 rewrites. */
export const COLUMN_EXAM_VERSION_ID = 2;
export const COLUMN_DOMAIN_ID = 3;
export const COLUMN_TOPIC_ID = 4;

/** Column indices of the four cells of one option slot, 1-based `option`. */
export function optionColumnIndices(option: number): {
  key: number;
  text: number;
  correct: number;
  explanation: number;
} {
  const base = 9 + (option - 1) * 4;
  return { key: base, text: base + 1, correct: base + 2, explanation: base + 3 };
}

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

export const QUESTION_KEY_PATTERN = /^cissp-[1-9][0-9]*$/;
export const SERVER_QUESTION_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const MAX_CSV_RECORD_SIZE = 96 * 1024;

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Parses CSV with the exact options the server's preview validator uses, so a
 * body the driver considers well-formed is one the server can read.
 */
export function parseCsv(text: string): string[][] {
  try {
    return parse(text, {
      relax_column_count: true,
      skip_empty_lines: false,
      max_record_size: MAX_CSV_RECORD_SIZE,
    }) as string[][];
  } catch {
    throw new DriverError("CSV_UNPARSEABLE", "the CSV could not be parsed");
  }
}

/** Serialises rows with the converter's producing rule and `\n` line endings. */
export function serializeCsv(rows: readonly (readonly string[])[]): string {
  return `${rows.map((row) => csvLine(row)).join("\n")}\n`;
}

export { csvCell, csvLine };

export function assertBatchSize(value: number): number {
  if (!Number.isInteger(value) || value < DRIVER_BATCH_SIZE_MIN || value > DRIVER_BATCH_SIZE_MAX) {
    throw new DriverError(
      "BATCH_SIZE_INVALID",
      `batch size must be an integer from ${DRIVER_BATCH_SIZE_MIN} to ${DRIVER_BATCH_SIZE_MAX}`,
      { info: { batchSize: value } },
    );
  }
  return value;
}

export type StageName = "taxonomy" | "transform" | "upload" | "publish" | "verify";

export const STAGE_ORDER: readonly StageName[] = [
  "taxonomy",
  "transform",
  "upload",
  "publish",
  "verify",
];
