import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import {
  CSV_PARSE_OPTIONS,
  OPTION_SLOTS,
  QUESTION_IMPORT_COLUMNS,
  QUESTION_IMPORT_FORMAT,
  QUESTION_IMPORT_MAX_BYTES,
  QUESTION_IMPORT_MAX_ROWS,
  optionColumnIndices,
  parseCsv,
  sha256,
} from "./contract.ts";
import type { Finding } from "./report.ts";

export interface ItemOption {
  slot: number;
  key: string;
  text: string;
  correct: string;
  explanation: string;
  populated: boolean;
}

export interface Item {
  file: string;
  /** 1-based data row, header excluded. */
  row: number;
  questionKey: string;
  formatVersion: string;
  examVersionId: string;
  domainId: string;
  topicId: string;
  stem: string;
  difficulty: string;
  sourceReference: string;
  licenseReference: string;
  options: ItemOption[];
}

export interface LoadedBatch {
  file: string;
  sha256: string;
  byteLength: number;
  rows: number;
  included: boolean;
  excludedReason: string | null;
  items: Item[];
}

export interface ParsedBatch {
  batch: LoadedBatch;
  findings: Finding[];
}

/** Files in `--batches`, sorted by name: the report's ordering starts here. */
export function listBatchFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => extname(name).toLowerCase() === ".csv")
    .sort((left, right) => left.localeCompare(right));
}

function fileFinding(code: string, file: string, message: string, evidence: Record<string, string | number | boolean | null> = {}): Finding {
  return {
    code,
    severity: "error",
    owner: "tool",
    scope: { file, row: null, questionKey: null, domainId: null },
    message,
    evidence,
  };
}

function optionIsPopulated(cells: readonly string[], slot: number): boolean {
  const indices = optionColumnIndices(slot);
  return [indices.key, indices.text, indices.correct, indices.explanation].some(
    (index) => (cells[index] ?? "").trim().length > 0,
  );
}

function cell(cells: readonly string[], index: number): string {
  return cells[index] ?? "";
}

export function itemFromRow(file: string, row: number, cells: readonly string[], optionCount: number): Item {
  const options: ItemOption[] = [];
  // Every contract slot is read, not just the profile's option count: an extra
  // populated slot past the fourth is a defect the item must still be able to
  // report as OPTION_COUNT and OPTION_SLOT_GAP.
  const slots = Math.max(optionCount, OPTION_SLOTS);
  for (let slot = 1; slot <= slots; slot += 1) {
    const indices = optionColumnIndices(slot);
    options.push({
      slot,
      key: cell(cells, indices.key),
      text: cell(cells, indices.text),
      correct: cell(cells, indices.correct),
      explanation: cell(cells, indices.explanation),
      populated: optionIsPopulated(cells, slot),
    });
  }
  return {
    file,
    row,
    questionKey: cell(cells, 1).trim(),
    formatVersion: cell(cells, 0).trim(),
    examVersionId: cell(cells, 2).trim(),
    domainId: cell(cells, 3).trim(),
    topicId: cell(cells, 4).trim(),
    stem: cell(cells, 5),
    difficulty: cell(cells, 6).trim(),
    sourceReference: cell(cells, 7),
    licenseReference: cell(cells, 8),
    options,
  };
}

/**
 * Reads and judges the file's shape only. A file that fails here is excluded
 * and counted: an excluded file is a visible number, so a bank cannot look
 * balanced because half of it failed to parse.
 */
export function parseBatch(
  file: string,
  buffer: Buffer,
  optionCount: number,
): ParsedBatch {
  const digest = sha256(buffer);
  const excluded = (
    excludedReason: string,
    code: string,
    message: string,
    evidence: Record<string, string | number | boolean | null> = {},
  ): ParsedBatch => ({
    batch: {
      file,
      sha256: digest,
      byteLength: buffer.byteLength,
      rows: 0,
      included: false,
      excludedReason,
      items: [],
    },
    findings: [fileFinding(code, file, message, evidence)],
  });

  if (buffer.byteLength > QUESTION_IMPORT_MAX_BYTES) {
    return excluded("BATCH_BYTES", "BATCH_BYTES", "the file is over the byte cap", {
      bytes: buffer.byteLength,
      maximum: QUESTION_IMPORT_MAX_BYTES,
    });
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return excluded("CSV_BOM", "CSV_BOM", "the file starts with a byte-order mark");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return excluded("CSV_NOT_UTF8", "CSV_NOT_UTF8", "the file is not valid UTF-8");
  }

  let records: string[][];
  try {
    records = parseCsv(text);
  } catch {
    return excluded("CSV_UNPARSEABLE", "CSV_UNPARSEABLE", "the CSV could not be parsed");
  }
  if (records.length === 0) {
    return excluded("CSV_UNPARSEABLE", "CSV_UNPARSEABLE", "the file is empty", {
      options: JSON.stringify(CSV_PARSE_OPTIONS),
    });
  }

  const header = records[0] ?? [];
  const headerMatches =
    header.length === QUESTION_IMPORT_COLUMNS.length &&
    header.every((name, index) => name === QUESTION_IMPORT_COLUMNS[index]);
  if (!headerMatches) {
    return excluded("HEADER_MISMATCH", "HEADER_MISMATCH", "the header is not the 41-column contract", {
      columns: header.length,
      expected: QUESTION_IMPORT_COLUMNS.length,
    });
  }

  const dataRows = records.slice(1);
  const badRow = dataRows.findIndex((row) => row.length !== QUESTION_IMPORT_COLUMNS.length);
  if (badRow >= 0) {
    return excluded("ROW_CELL_COUNT", "ROW_CELL_COUNT", "a row does not have exactly 41 cells", {
      row: badRow + 1,
      cells: dataRows[badRow]?.length ?? 0,
      expected: QUESTION_IMPORT_COLUMNS.length,
    });
  }

  const items = dataRows.map((row, index) => itemFromRow(file, index + 1, row, optionCount));
  const findings: Finding[] = [];
  if (items.length > QUESTION_IMPORT_MAX_ROWS) {
    findings.push(
      fileFinding("BATCH_ROW_LIMIT", file, "the file holds more rows than the preview cap", {
        rows: items.length,
        maximum: QUESTION_IMPORT_MAX_ROWS,
      }),
    );
  }

  return {
    batch: {
      file,
      sha256: digest,
      byteLength: buffer.byteLength,
      rows: items.length,
      included: true,
      excludedReason: null,
      items,
    },
    findings,
  };
}

export function readBatchFile(directory: string, file: string): Buffer {
  return readFileSync(join(directory, file));
}
