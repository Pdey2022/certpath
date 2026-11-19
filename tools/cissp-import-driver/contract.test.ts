import assert from "node:assert/strict";
import test from "node:test";
import { QUESTION_CONTENT_LIMITS } from "../../apps/api/src/security/content.ts";
import {
  QUESTION_IMPORT_MAX_ROWS,
  QUESTION_IMPORT_TEMPLATE_COLUMNS,
  QUESTION_IMPORT_TTL_MS as SERVER_TTL_MS,
  QUESTION_IMPORT_MAX_BYTES as SERVER_MAX_BYTES,
} from "../../apps/api/src/security/question-imports.ts";
import { csvCell as converterCell } from "../cissp-convert/cli.ts";
import {
  DRIVER_BATCH_SIZE_DEFAULT,
  DRIVER_BATCH_SIZE_MAX,
  DRIVER_BATCH_SIZE_MIN,
  LIMITS,
  QUESTION_IMPORT_COLUMNS,
  QUESTION_IMPORT_MAX_BYTES,
  QUESTION_IMPORT_MAX_ROWS as DRIVER_MAX_ROWS,
  QUESTION_IMPORT_TTL_MS,
  assertBatchSize,
  csvCell,
  optionColumnIndices,
  parseCsv,
  serializeCsv,
} from "./contract.ts";
import { DriverError } from "./errors.ts";

test("the driver's column list is byte-equal to the server's import template", () => {
  assert.equal(QUESTION_IMPORT_COLUMNS.length, 41);
  assert.deepEqual([...QUESTION_IMPORT_COLUMNS], [...QUESTION_IMPORT_TEMPLATE_COLUMNS]);
});

test("the driver's contract constants match the server's", () => {
  assert.equal(DRIVER_MAX_ROWS, QUESTION_IMPORT_MAX_ROWS);
  assert.equal(QUESTION_IMPORT_MAX_BYTES, SERVER_MAX_BYTES);
  assert.equal(QUESTION_IMPORT_TTL_MS, SERVER_TTL_MS);
  assert.equal(QUESTION_IMPORT_TTL_MS, 600_000);
  assert.equal(QUESTION_IMPORT_MAX_BYTES, 256 * 1024);
});

test("the driver's LIMITS are exactly the server's question-content caps", () => {
  // The driver refuses an over-long stem or explanation at stage 0 so the run
  // stops before any request; the server refuses it again on confirm. A cap
  // that moved on one side only used to surface mid-run, after the first
  // confirm had already imported rows. The server is the source of truth.
  assert.deepEqual(LIMITS, QUESTION_CONTENT_LIMITS);
});

test("option columns are the four cells the template puts at 9 + (n-1)*4", () => {
  assert.deepEqual(optionColumnIndices(1), { key: 9, text: 10, correct: 11, explanation: 12 });
  assert.deepEqual(optionColumnIndices(8), { key: 37, text: 38, correct: 39, explanation: 40 });
  assert.equal(optionColumnIndices(8).explanation, QUESTION_IMPORT_COLUMNS.length - 1);
});

test("batch size accepts 1 and 10 and refuses 0 and 11", () => {
  assert.equal(assertBatchSize(DRIVER_BATCH_SIZE_MIN), 1);
  assert.equal(assertBatchSize(DRIVER_BATCH_SIZE_MAX), 10);
  assert.equal(assertBatchSize(DRIVER_BATCH_SIZE_DEFAULT), 5);
  for (const bad of [0, 11, 3.5, Number.NaN, -1]) {
    assert.throws(
      () => assertBatchSize(bad),
      (error: unknown) => error instanceof DriverError && error.code === "BATCH_SIZE_INVALID",
    );
  }
});

test("the driver's CSV cell writer agrees with the converter's on tricky values", () => {
  const values = [
    "plain",
    "with,comma",
    'with"quote',
    'ends with a quote"',
    "line\nbreak",
    "carriage\r\nreturn",
    " leading space",
    "trailing space ",
    "",
    "=formula",
  ];
  for (const value of values) {
    assert.equal(csvCell(value), converterCell(value), `cell ${JSON.stringify(value)}`);
  }
});

test("serialise then parse returns the same cells, preserving embedded quoting", () => {
  const cells = [
    "certpath-question-v1",
    "cissp-1",
    "exam",
    "domain",
    "topic",
    'A stem with a comma, a "quoted" word, and a CRLF\r\ninside',
    "medium",
    "source",
    "licence",
    "A",
    'Option ending in a quote"',
    "true",
    "explanation",
  ];
  const text = serializeCsv([cells]);
  const parsed = parseCsv(text);
  assert.deepEqual(parsed, [cells]);
});

test("a BOM before the header is not silently stripped", () => {
  const text = `\uFEFF${serializeCsv([["a", "b"]])}`;
  const parsed = parseCsv(text);
  assert.equal(parsed[0]?.[0], "\uFEFFa");
});
