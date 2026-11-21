import assert from "node:assert/strict";
import test from "node:test";
import {
  QUESTION_IMPORT_FORMAT as SERVER_FORMAT,
  QUESTION_IMPORT_MAX_BYTES as SERVER_MAX_BYTES,
  QUESTION_IMPORT_MAX_ROWS as SERVER_MAX_ROWS,
  QUESTION_IMPORT_TEMPLATE_COLUMNS,
} from "../../apps/api/src/security/question-imports.ts";
import { LIMITS as DRIVER_LIMITS } from "../cissp-import-driver/contract.ts";
import {
  CSV_PARSE_OPTIONS,
  LIMITS,
  OPTION_SLOTS,
  QUESTION_IMPORT_COLUMNS,
  QUESTION_IMPORT_FORMAT,
  QUESTION_IMPORT_MAX_BYTES,
  QUESTION_IMPORT_MAX_ROWS,
  optionColumnIndices,
} from "./contract.ts";

test("the column list is the server's, in the server's order", () => {
  assert.deepEqual([...QUESTION_IMPORT_COLUMNS], [...QUESTION_IMPORT_TEMPLATE_COLUMNS]);
  assert.equal(QUESTION_IMPORT_COLUMNS.length, 41);
  assert.equal(QUESTION_IMPORT_COLUMNS[0], "format_version");
  assert.equal(QUESTION_IMPORT_COLUMNS[40], "option_8_explanation");
});

test("the format version, row cap and byte cap are the server's", () => {
  assert.equal(QUESTION_IMPORT_FORMAT, SERVER_FORMAT);
  assert.equal(QUESTION_IMPORT_MAX_ROWS, SERVER_MAX_ROWS);
  assert.equal(QUESTION_IMPORT_MAX_BYTES, SERVER_MAX_BYTES);
  assert.equal(QUESTION_IMPORT_MAX_ROWS, 10);
  assert.equal(QUESTION_IMPORT_MAX_BYTES, 256 * 1024);
  assert.equal(QUESTION_IMPORT_FORMAT, "certpath-question-v1");
});

test("the field caps are the driver's copy of the same contract", () => {
  assert.deepEqual(LIMITS, DRIVER_LIMITS);
  assert.deepEqual(LIMITS, {
    stem: { minimum: 5, maximum: 4000 },
    optionText: { minimum: 1, maximum: 1000 },
    explanation: { minimum: 1, maximum: 3000 },
    sourceReference: { minimum: 1, maximum: 1000 },
    licenseReference: { minimum: 1, maximum: 200 },
    questionKey: { minimum: 1, maximum: 120 },
    optionKey: { minimum: 1, maximum: 32 },
  });
});

test("the parse options are the server preview's, spelled out", () => {
  // A future server change must fail here rather than in production.
  assert.deepEqual({ ...CSV_PARSE_OPTIONS }, {
    relax_column_count: true,
    skip_empty_lines: false,
    max_record_size: 96 * 1024,
  });
});

test("option slots map to the documented column indices", () => {
  assert.equal(OPTION_SLOTS, 8);
  assert.deepEqual(optionColumnIndices(1), { key: 9, text: 10, correct: 11, explanation: 12 });
  assert.deepEqual(optionColumnIndices(4), { key: 21, text: 22, correct: 23, explanation: 24 });
  assert.deepEqual(optionColumnIndices(8), { key: 37, text: 38, correct: 39, explanation: 40 });
});
