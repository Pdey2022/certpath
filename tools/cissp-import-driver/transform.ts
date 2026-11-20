import {
  COLUMN_DOMAIN_ID,
  COLUMN_EXAM_VERSION_ID,
  COLUMN_TOPIC_ID,
  QUESTION_IMPORT_COLUMNS,
  UPLOAD_MANIFEST_FORMAT_VERSION,
  assertBatchSize,
  csvLine,
  sha256,
} from "./contract.ts";
import type { SourceRow } from "./validate.ts";
import { DriverError } from "./errors.ts";

/**
 * Stage 2: rewrite the three id cells with server-minted ids and re-chunk into
 * upload units. Pure functions only; the caller owns the filesystem.
 */

export interface TaxonomyIdMap {
  examVersionId: string;
  domainIds: ReadonlyMap<string, string>;
  topicIds: ReadonlyMap<string, string>;
}

export interface UnitArtifact {
  unit: number;
  file: string;
  rows: number;
  firstKey: string;
  lastKey: string;
  sha256: string;
  /** CSV text, header included */
  contents: string;
}

export interface UploadManifest {
  formatVersion: typeof UPLOAD_MANIFEST_FORMAT_VERSION;
  batchSize: number;
  unitCount: number;
  converterManifestSha256: string;
  units: Array<{
    file: string;
    rows: number;
    firstKey: string;
    lastKey: string;
    sha256: string;
  }>;
}

function mapId(map: ReadonlyMap<string, string>, key: string, label: string): string {
  const value = map.get(key);
  if (value === undefined) {
    throw new DriverError("UNKNOWN_TAXONOMY_ID", `${label} ${key} has no server id in the checkpoint`);
  }
  return value;
}

/** Replaces exactly columns 2, 3 and 4; every other cell is untouched. */
export function rewriteRowCells(cells: readonly string[], ids: TaxonomyIdMap): string[] {
  if (cells.length !== QUESTION_IMPORT_COLUMNS.length) {
    throw new DriverError(
      "CSV_COLUMN_COUNT",
      `a row has ${cells.length} columns, expected ${QUESTION_IMPORT_COLUMNS.length}`,
    );
  }
  const rewritten = cells.slice();
  rewritten[COLUMN_EXAM_VERSION_ID] = ids.examVersionId;
  rewritten[COLUMN_DOMAIN_ID] = mapId(ids.domainIds, cells[COLUMN_DOMAIN_ID] ?? "", "domain");
  rewritten[COLUMN_TOPIC_ID] = mapId(ids.topicIds, cells[COLUMN_TOPIC_ID] ?? "", "topic");
  return rewritten;
}

export function serializeUnit(rows: readonly (readonly string[])[]): string {
  return [
    csvLine(QUESTION_IMPORT_COLUMNS),
    ...rows.map((row) => csvLine(row)),
  ].join("\n") + "\n";
}

export function unitFileName(unit: number): string {
  return `upload-${String(unit).padStart(3, "0")}.csv`;
}

export function buildUnits(
  rows: readonly SourceRow[],
  ids: TaxonomyIdMap,
  batchSize: number,
  maximumBytes: number,
): UnitArtifact[] {
  assertBatchSize(batchSize);
  if (rows.length === 0) {
    throw new DriverError("CONVERTER_COUNT_MISMATCH", "there are no rows to upload");
  }
  const units: UnitArtifact[] = [];
  for (let start = 0; start < rows.length; start += batchSize) {
    const slice = rows.slice(start, start + batchSize);
    const rewritten = slice.map((row) => rewriteRowCells(row.cells, ids));
    const contents = serializeUnit(rewritten);
    const bytes = Buffer.byteLength(contents, "utf8");
    if (bytes > maximumBytes) {
      throw new DriverError(
        "UNIT_TOO_LARGE",
        `unit ${units.length + 1} is ${bytes} bytes, over the ${maximumBytes}-byte import limit`,
      );
    }
    units.push({
      unit: units.length + 1,
      file: unitFileName(units.length + 1),
      rows: slice.length,
      firstKey: slice[0]!.key,
      lastKey: slice[slice.length - 1]!.key,
      sha256: sha256(contents),
      contents,
    });
  }
  return units;
}

export function buildUploadManifest(
  units: readonly UnitArtifact[],
  batchSize: number,
  converterManifestSha256: string,
): UploadManifest {
  return {
    formatVersion: UPLOAD_MANIFEST_FORMAT_VERSION,
    batchSize,
    unitCount: units.length,
    converterManifestSha256,
    units: units.map((unit) => ({
      file: unit.file,
      rows: unit.rows,
      firstKey: unit.firstKey,
      lastKey: unit.lastKey,
      sha256: unit.sha256,
    })),
  };
}

export function questionKeyNumber(key: string): number {
  const match = /^cissp-([0-9]+)$/.exec(key);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

/**
 * Smallest domain first, ties broken by domain key, then question key numeric
 * order inside the domain. Derived from the transformed rows, never hardcoded.
 */
export function publishOrder(rows: readonly Pick<SourceRow, "key" | "domainKey">[]): string[] {
  const perDomain = new Map<string, string[]>();
  for (const row of rows) {
    const keys = perDomain.get(row.domainKey) ?? [];
    keys.push(row.key);
    perDomain.set(row.domainKey, keys);
  }
  const domains = [...perDomain.keys()].sort((left, right) => {
    const difference = perDomain.get(left)!.length - perDomain.get(right)!.length;
    return difference !== 0 ? difference : left.localeCompare(right);
  });
  return domains.flatMap((domain) =>
    perDomain
      .get(domain)!
      .slice()
      .sort((left, right) => questionKeyNumber(left) - questionKeyNumber(right)),
  );
}
