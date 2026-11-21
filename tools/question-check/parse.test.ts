import assert from "node:assert/strict";
import test from "node:test";
import { QUESTION_IMPORT_COLUMNS } from "./contract.ts";
import { SYNTHETIC_SHAPE, batchCsv, itemCells, type ItemSpec } from "./fixtures.ts";
import { parseBatch } from "./parse.ts";

const SHAPE = SYNTHETIC_SHAPE;

function item(ordinal: number, overrides: Partial<ItemSpec> = {}): ItemSpec {
  return {
    key: `syn-${ordinal}`,
    domainId: "syn-d1",
    topicId: "syn-d1-t1",
    correctIndex: ordinal % 4,
    ...overrides,
  };
}

function codes(buffer: Buffer): string[] {
  const parsed = parseBatch("batch-001.csv", buffer, SHAPE.optionCount);
  return parsed.findings.map((finding) => finding.code);
}

function rowLine(overrides: Partial<ItemSpec> = {}): string {
  return itemCells(item(1, overrides), SHAPE)
    .map((value) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value))
    .join(",");
}

test("a byte-order mark excludes the file", () => {
  const text = batchCsv(SHAPE, [item(1)]);
  const parsed = parseBatch("batch-001.csv", Buffer.from(`\uFEFF${text}`, "utf8"), SHAPE.optionCount);
  assert.deepEqual(parsed.findings.map((finding) => finding.code), ["CSV_BOM"]);
  assert.equal(parsed.batch.included, false);
  assert.equal(parsed.batch.excludedReason, "CSV_BOM");
});

test("invalid UTF-8 excludes the file", () => {
  const buffer = Buffer.concat([Buffer.from(QUESTION_IMPORT_COLUMNS.join(",")), Buffer.from([0xff, 0xfe])]);
  assert.deepEqual(codes(buffer), ["CSV_NOT_UTF8"]);
});

test("CRLF line endings parse", () => {
  const text = batchCsv(SHAPE, [item(1)]).replaceAll("\n", "\r\n");
  const parsed = parseBatch("batch-001.csv", Buffer.from(text, "utf8"), SHAPE.optionCount);
  assert.deepEqual(parsed.findings, []);
  assert.equal(parsed.batch.rows, 1);
  assert.equal(parsed.batch.items[0]!.questionKey, "syn-1");
});

test("quoted commas, embedded newlines and quoted quotes survive", () => {
  const stem = 'A widget, with a comma\nand a newline and a "quoted" word inside.';
  const text = batchCsv(SHAPE, [item(1, { stem })]);
  const parsed = parseBatch("batch-001.csv", Buffer.from(text, "utf8"), SHAPE.optionCount);
  assert.deepEqual(parsed.findings, []);
  assert.equal(parsed.batch.items[0]!.stem, stem);
});

test("a 40-cell and a 42-cell row exclude the file", () => {
  const header = QUESTION_IMPORT_COLUMNS.join(",");
  const forty = `${header}\n${QUESTION_IMPORT_COLUMNS.slice(0, 40).map(() => "x").join(",")}\n`;
  assert.deepEqual(codes(Buffer.from(forty, "utf8")), ["ROW_CELL_COUNT"]);

  const fortyTwo = `${header}\n${[...Array<string>(42).fill("x")].join(",")}\n`;
  const parsed = parseBatch("batch-001.csv", Buffer.from(fortyTwo, "utf8"), SHAPE.optionCount);
  assert.deepEqual(parsed.findings.map((finding) => finding.code), ["ROW_CELL_COUNT"]);
  assert.equal(parsed.findings[0]!.evidence.cells, 42);
});

test("a reordered or differently-cased header excludes the file", () => {
  const header = [...QUESTION_IMPORT_COLUMNS];
  [header[0], header[1]] = [header[1]!, header[0]!];
  const reordered = `${header.join(",")}\n${rowLine()}\n`;
  assert.deepEqual(codes(Buffer.from(reordered, "utf8")), ["HEADER_MISMATCH"]);

  const cased = [...QUESTION_IMPORT_COLUMNS];
  cased[0] = "Format_Version";
  const differentCase = `${cased.join(",")}\n${rowLine()}\n`;
  assert.deepEqual(codes(Buffer.from(differentCase, "utf8")), ["HEADER_MISMATCH"]);
});

test("a blank line is a one-cell row and excludes the file", () => {
  const text = `${batchCsv(SHAPE, [item(1)])}\n`;
  assert.deepEqual(codes(Buffer.from(text, "utf8")), ["ROW_CELL_COUNT"]);
});

test("an empty file is unparseable", () => {
  assert.deepEqual(codes(Buffer.from("", "utf8")), ["CSV_UNPARSEABLE"]);
});

test("eleven rows is a BATCH_ROW_LIMIT error and the file is still judged", () => {
  const items = Array.from({ length: 11 }, (_, index) => item(index + 1));
  const parsed = parseBatch("batch-001.csv", Buffer.from(batchCsv(SHAPE, items), "utf8"), SHAPE.optionCount);
  assert.equal(parsed.batch.included, true);
  assert.equal(parsed.batch.rows, 11);
  assert.deepEqual(parsed.findings.map((finding) => finding.code), ["BATCH_ROW_LIMIT"]);
  assert.equal(parsed.findings[0]!.evidence.maximum, 10);
});

test("a file over 256 KiB is excluded before it is parsed", () => {
  const parsed = parseBatch(
    "batch-001.csv",
    Buffer.alloc(256 * 1024 + 1, 0x61),
    SHAPE.optionCount,
  );
  assert.deepEqual(parsed.findings.map((finding) => finding.code), ["BATCH_BYTES"]);
  assert.equal(parsed.batch.excludedReason, "BATCH_BYTES");
});

test("unused option slots are empty and slots are numbered from 1", () => {
  const parsed = parseBatch("batch-001.csv", Buffer.from(batchCsv(SHAPE, [item(1)]), "utf8"), SHAPE.optionCount);
  const options = parsed.batch.items[0]!.options;
  assert.equal(options.length, 8);
  assert.deepEqual(options.slice(0, 4).map((option) => option.populated), [true, true, true, true]);
  assert.deepEqual(options.slice(4).map((option) => option.populated), [false, false, false, false]);
  assert.deepEqual(options.slice(0, 4).map((option) => option.slot), [1, 2, 3, 4]);
});
