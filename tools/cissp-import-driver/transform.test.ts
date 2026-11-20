import assert from "node:assert/strict";
import test from "node:test";
import { csvLine } from "../cissp-convert/cli.ts";
import { QUESTION_IMPORT_COLUMNS, QUESTION_IMPORT_MAX_BYTES, parseCsv } from "./contract.ts";
import { DriverError } from "./errors.ts";
import { questionRow } from "./fixtures.ts";
import {
  buildUnits,
  buildUploadManifest,
  publishOrder,
  rewriteRowCells,
  serializeUnit,
} from "./transform.ts";
import type { SourceRow } from "./validate.ts";

const IDS = {
  examVersionId: "00000000-0000-4000-8000-000000000001",
  domainIds: new Map([
    ["cissp-d1", "11111111-1111-4111-8111-111111111111"],
    ["cissp-d2", "22222222-2222-4222-8222-222222222222"],
    ["cissp-d3", "33333333-3333-4333-8333-333333333333"],
  ]),
  topicIds: new Map([
    ["cissp-d1-topic-1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    ["cissp-d2-topic-1", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    ["cissp-d3-topic-1", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
  ]),
};

function sourceRows(cells: string[][]): SourceRow[] {
  return cells.map((row, index) => ({
    position: index + 1,
    key: row[1]!,
    domainKey: row[3]!,
    topicKey: row[4]!,
    cells: row,
  }));
}

test("only the three id cells are rewritten", () => {
  const row = questionRow({ key: "cissp-1" });
  const rewritten = rewriteRowCells(row, IDS);
  assert.equal(rewritten.length, row.length);
  assert.equal(rewritten[2], IDS.examVersionId);
  assert.equal(rewritten[3], IDS.domainIds.get("cissp-d1"));
  assert.equal(rewritten[4], IDS.topicIds.get("cissp-d1-topic-1"));
  for (let index = 0; index < row.length; index += 1) {
    if (index === 2 || index === 3 || index === 4) continue;
    assert.equal(rewritten[index], row[index], `column ${QUESTION_IMPORT_COLUMNS[index]}`);
  }
});

test("embedded commas, doubled quotes, CRLF and a quote-terminated cell survive the rewrite", () => {
  const row = questionRow({ key: "cissp-7" });
  row[5] = 'A stem with a comma, a "doubled" quote, and a CRLF\r\ninside it';
  row[10] = 'An option that ends with a quote"';
  row[11] = "true";
  row[12] = 'Explanation with "quotes", commas, and a\ntrailing newline inside.';
  const original = `${csvLine(row)}\n`;
  const rewritten = rewriteRowCells(row, IDS);
  const rewrittenText = `${csvLine(rewritten)}\n`;
  // Restoring the three ids in the rewritten text must reproduce the original
  // byte for byte: nothing outside columns 2-4 may have changed.
  const restored = rewrittenText
    .replace(IDS.examVersionId, row[2]!)
    .replace(IDS.domainIds.get("cissp-d1")!, row[3]!)
    .replace(IDS.topicIds.get("cissp-d1-topic-1")!, row[4]!);
  assert.equal(restored, original);
  const reparsed = parseCsv(rewrittenText)[0]!;
  assert.equal(reparsed[5], row[5]);
  assert.equal(reparsed[10], row[10]);
  assert.equal(reparsed[12], row[12]);
  assert.equal(reparsed[2], IDS.examVersionId);
});

test("an unknown taxonomy id is refused rather than defaulted", () => {
  const row = questionRow({ key: "cissp-2", domainId: "cissp-d9" });
  assert.throws(
    () => rewriteRowCells(row, IDS),
    (error: unknown) => error instanceof DriverError && error.code === "UNKNOWN_TAXONOMY_ID",
  );
});

test("463 rows re-chunk into 93 units of 5 with a 3-row tail", () => {
  const rows = sourceRows(
    Array.from({ length: 463 }, (_, index) => questionRow({ key: `cissp-${index + 1}` })),
  );
  const units = buildUnits(rows, IDS, 5, QUESTION_IMPORT_MAX_BYTES);
  assert.equal(units.length, 93);
  assert.equal(units[0]!.rows, 5);
  assert.equal(units[92]!.rows, 3);
  assert.equal(units[0]!.firstKey, "cissp-1");
  assert.equal(units[92]!.lastKey, "cissp-463");
  assert.equal(units.reduce((total, unit) => total + unit.rows, 0), 463);
});

test("batch size 10 reproduces the converter's 47 batches", () => {
  const rows = sourceRows(
    Array.from({ length: 463 }, (_, index) => questionRow({ key: `cissp-${index + 1}` })),
  );
  assert.equal(buildUnits(rows, IDS, 10, QUESTION_IMPORT_MAX_BYTES).length, 47);
  assert.equal(buildUnits(rows, IDS, 1, QUESTION_IMPORT_MAX_BYTES).length, 463);
});

test("row order is preserved across units", () => {
  const rows = sourceRows(
    Array.from({ length: 7 }, (_, index) => questionRow({ key: `cissp-${index + 1}` })),
  );
  const units = buildUnits(rows, IDS, 3, QUESTION_IMPORT_MAX_BYTES);
  assert.deepEqual(
    units.map((unit) => unit.firstKey),
    ["cissp-1", "cissp-4", "cissp-7"],
  );
  assert.deepEqual(
    units.map((unit) => unit.lastKey),
    ["cissp-3", "cissp-6", "cissp-7"],
  );
});

test("every unit carries the contract header and the server-minted ids", () => {
  const rows = sourceRows([questionRow({ key: "cissp-1" })]);
  const unit = buildUnits(rows, IDS, 5, QUESTION_IMPORT_MAX_BYTES)[0]!;
  const parsed = parseCsv(unit.contents);
  assert.deepEqual(parsed[0], [...QUESTION_IMPORT_COLUMNS]);
  assert.equal(parsed[1]![2], IDS.examVersionId);
});

test("a unit over the byte cap is refused", () => {
  const rows = sourceRows([questionRow({ key: "cissp-1" })]);
  assert.throws(
    () => buildUnits(rows, IDS, 5, 100),
    (error: unknown) => error instanceof DriverError && error.code === "UNIT_TOO_LARGE",
  );
});

test("the upload manifest records the unit digests and the converter manifest", () => {
  const rows = sourceRows([questionRow({ key: "cissp-1" }), questionRow({ key: "cissp-2" })]);
  const units = buildUnits(rows, IDS, 5, QUESTION_IMPORT_MAX_BYTES);
  const manifest = buildUploadManifest(units, 5, "a".repeat(64));
  assert.equal(manifest.formatVersion, "certpath-cissp-upload-manifest-v1");
  assert.equal(manifest.unitCount, 1);
  assert.equal(manifest.units[0]!.file, "upload-001.csv");
  assert.equal(manifest.units[0]!.rows, 2);
  assert.equal(manifest.converterManifestSha256, "a".repeat(64));
  assert.match(manifest.units[0]!.sha256, /^[0-9a-f]{64}$/);
});

test("publish order is smallest domain first, tie-broken by key, then numeric question key", () => {
  const rows = sourceRows([
    questionRow({ key: "cissp-10", domainId: "cissp-d1", topicId: "cissp-d1-topic-1" }),
    questionRow({ key: "cissp-2", domainId: "cissp-d1", topicId: "cissp-d1-topic-1" }),
    questionRow({ key: "cissp-3", domainId: "cissp-d2", topicId: "cissp-d2-topic-1" }),
    questionRow({ key: "cissp-4", domainId: "cissp-d3", topicId: "cissp-d3-topic-1" }),
    questionRow({ key: "cissp-5", domainId: "cissp-d2", topicId: "cissp-d2-topic-1" }),
    questionRow({ key: "cissp-1", domainId: "cissp-d1", topicId: "cissp-d1-topic-1" }),
  ]);
  assert.deepEqual(publishOrder(rows), ["cissp-4", "cissp-3", "cissp-5", "cissp-1", "cissp-2", "cissp-10"]);
});

test("equal-sized domains are ordered by taxonomy domain key, not input order", () => {
  const rows = sourceRows([
    questionRow({ key: "cissp-9", domainId: "cissp-d3", topicId: "cissp-d3-topic-1" }),
    questionRow({ key: "cissp-8", domainId: "cissp-d2", topicId: "cissp-d2-topic-1" }),
  ]);
  assert.deepEqual(publishOrder(rows), ["cissp-8", "cissp-9"]);
});
