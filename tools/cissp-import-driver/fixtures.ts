import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { QUESTION_IMPORT_COLUMNS } from "./contract.ts";
import { csvLine } from "../cissp-convert/cli.ts";

/**
 * Small, synthetic fixtures for the driver's tests. They are written to a temp
 * directory outside the repository and contain no real question text.
 */

export const TAXONOMY_DOMAIN_IDS = [
  "cissp-d1",
  "cissp-d2",
  "cissp-d3",
  "cissp-d4",
  "cissp-d5",
  "cissp-d6",
  "cissp-d7",
  "cissp-d8",
] as const;

export interface TopicRef {
  id: string;
  domainId: string;
}

export interface TaxonomyFixture {
  raw: Record<string, unknown>;
  text: string;
  sha256: string;
  topics: TopicRef[];
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 8 domains, 36 topics: the first four domains carry five topics, the rest four. */
export function taxonomyFixture(): TaxonomyFixture {
  const domains = TAXONOMY_DOMAIN_IDS.map((id, domainIndex) => {
    const topicCount = domainIndex < 4 ? 5 : 4;
    return {
      id,
      title: `Synthetic domain ${domainIndex + 1}`,
      sourcePrefixes: [`Synthetic ${domainIndex + 1}`],
      expectedQuestions: 1,
      topics: Array.from({ length: topicCount }, (_, topicIndex) => ({
        id: `${id}-topic-${topicIndex + 1}`,
        slug: `topic-${topicIndex + 1}`,
        title: `Synthetic topic ${domainIndex + 1}.${topicIndex + 1}`,
        expectedQuestions: 1,
        sourceLabels: [{ label: `Synthetic label ${domainIndex + 1}.${topicIndex + 1}`, expectedQuestions: 1 }],
      })),
    };
  });
  const raw = { formatVersion: "certpath-cissp-taxonomy-v1", domains };
  const text = `${JSON.stringify(raw, null, 2)}\n`;
  const topics = domains.flatMap((domain) =>
    domain.topics.map((topic) => ({ id: topic.id, domainId: domain.id })),
  );
  return { raw, text, sha256: sha256(text), topics };
}

export function proseFixture(
  taxonomy: TaxonomyFixture,
  overrides: { certificationId?: string; topics?: TopicRef[]; meaning?: string } = {},
): Record<string, unknown> {
  const topics = overrides.topics ?? taxonomy.topics;
  return {
    formatVersion: "certpath-cissp-taxonomy-prose-v1",
    taxonomySha256: taxonomy.sha256,
    certification: {
      id: overrides.certificationId ?? "synthetic",
      slug: "synthetic-pilot",
      displayName: "Synthetic pilot",
    },
    examVersion: {
      versionKey: "driver-test-v1",
      title: "Synthetic exam title",
      syllabusReference: "Synthetic syllabus reference",
    },
    domains: Object.fromEntries(
      TAXONOMY_DOMAIN_IDS.map((id) => [id, { meaning: overrides.meaning ?? `Meaning for ${id}` }]),
    ),
    topics: Object.fromEntries(
      topics.map((topic) => [topic.id, { meaning: overrides.meaning ?? `Meaning for ${topic.id}` }]),
    ),
  };
}

export interface PageRequest {
  cursor: string | null;
  limit: number;
}

export interface PageOf<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * One page of a collection ordered by ascending id, exactly as the Worker's
 * `pageClause`/`pageResult` pair does it: `id > cursor`, `LIMIT limit`, and a
 * `nextCursor` set to the last id of the page only when more remain.
 *
 * The driver's earlier fake returned every match and hardcoded `nextCursor:
 * null`, which made a "these rows are missing" answer impossible to reproduce
 * and every presence test vacuous. Fakes that cannot express the defect cannot
 * catch it, so the paging lives here once and its own test walks 120 items.
 */
export function pageOf<T>(items: readonly T[], request: PageRequest, idOf: (item: T) => string): PageOf<T> {
  if (!Number.isInteger(request.limit) || request.limit < 1) {
    throw new Error(`pageOf needs a positive integer limit, got ${request.limit}`);
  }
  const ordered = [...items].sort((left, right) => {
    const a = idOf(left);
    const b = idOf(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const remaining =
    request.cursor === null ? ordered : ordered.filter((item) => idOf(item) > request.cursor!);
  const page = remaining.slice(0, request.limit);
  const last = page.at(-1);
  return {
    items: page,
    nextCursor: remaining.length > request.limit && last !== undefined ? idOf(last) : null,
  };
}

export interface RowOptions {
  key: string;
  domainId?: string;
  topicId?: string;
  examVersionId?: string;
  optionCount?: number;
  correctCount?: number;
  extraOption?: boolean;
}

export function questionRow(options: RowOptions): string[] {
  const optionCount = options.optionCount ?? 4;
  const correctCount = options.correctCount ?? 1;
  const domainId = options.domainId ?? "cissp-d1";
  const topicId = options.topicId ?? "cissp-d1-topic-1";
  const cells = [
    "certpath-question-v1",
    options.key,
    options.examVersionId ?? "cissp-exam-v1",
    domainId,
    topicId,
    `Synthetic stem for ${options.key}?`,
    "medium",
    "Synthetic owner fixture",
    "All rights reserved",
  ];
  for (let option = 1; option <= 8; option += 1) {
    if (option <= Math.min(optionCount, 8)) {
      cells.push(
        String.fromCharCode(64 + option),
        `Synthetic option ${option} for ${options.key}`,
        option <= correctCount ? "true" : "false",
        `Synthetic explanation ${option} for ${options.key}`,
      );
    } else {
      cells.push("", "", "", "");
    }
  }
  if (options.extraOption === true) {
    // Overwrite option 5 with content while keeping options 6-8 empty.
    cells.splice(9 + 16, 4, "E", "Synthetic fifth option", "false", "Synthetic fifth explanation");
  }
  return cells;
}

export interface BatchSpec {
  name: string;
  rows: string[][];
  header?: string[];
  prefix?: string;
}

export interface ConverterFixture {
  rows: string[][];
  manifestText: string;
}

export interface FixturePaths {
  batchesDir: string;
  taxonomyPath: string;
  prosePath: string;
  taxonomy: TaxonomyFixture;
  rows: string[][];
}

export function writeConverterOutput(
  batchesDir: string,
  batches: readonly BatchSpec[],
  taxonomy: TaxonomyFixture,
): ConverterFixture {
  mkdirSync(batchesDir, { recursive: true });
  const entries: Array<{ file: string; rows: number; sha256: string }> = [];
  const rows: string[][] = [];
  for (const batch of batches) {
    const header = batch.header ?? [...QUESTION_IMPORT_COLUMNS];
    const text = `${batch.prefix ?? ""}${[header, ...batch.rows].map((row) => csvLine(row)).join("\n")}\n`;
    writeFileSync(join(batchesDir, batch.name), text, "utf8");
    entries.push({ file: batch.name, rows: batch.rows.length, sha256: sha256(text) });
    rows.push(...batch.rows);
  }
  const manifestText = `${JSON.stringify(
    {
      formatVersion: "certpath-cissp-convert-manifest-v1",
      counts: { written: rows.length, batches: entries.length },
      batches: entries,
    },
    null,
    2,
  )}\n`;
  writeFileSync(join(batchesDir, "manifest.json"), manifestText, "utf8");

  const perTopic = new Map<string, number>();
  for (const row of rows) perTopic.set(row[4]!, (perTopic.get(row[4]!) ?? 0) + 1);
  const report = {
    formatVersion: "certpath-cissp-convert-taxonomy-report-v1",
    domains: taxonomy.raw["domains"] as Array<Record<string, unknown>>,
    totals: { written: rows.length },
  };
  const reportDomains = (report.domains as Array<{ id: string; topics: Array<{ id: string }> }>).map(
    (domain) => ({
      id: domain.id,
      topics: domain.topics.map((topic) => ({
        id: topic.id,
        writtenQuestions: perTopic.get(topic.id) ?? 0,
      })),
    }),
  );
  writeFileSync(
    join(batchesDir, "taxonomy-report.json"),
    `${JSON.stringify({ ...report, domains: reportDomains }, null, 2)}\n`,
    "utf8",
  );
  return { rows, manifestText };
}

export function writeFixture(
  root: string,
  options: { rowCount?: number; firstKey?: number } = {},
): FixturePaths {
  const rowCount = options.rowCount ?? 5;
  const firstKey = options.firstKey ?? 1;
  const taxonomy = taxonomyFixture();
  const rows = Array.from({ length: rowCount }, (_, index) =>
    questionRow({ key: `cissp-${firstKey + index}` }),
  );
  mkdirSync(root, { recursive: true });
  const taxonomyPath = join(root, "taxonomy.json");
  writeFileSync(taxonomyPath, taxonomy.text, "utf8");
  const prosePath = join(root, "prose.json");
  writeFileSync(prosePath, `${JSON.stringify(proseFixture(taxonomy), null, 2)}\n`, "utf8");
  const batchesDir = join(root, "batches");
  // The converter caps a batch at ten rows, so a larger fixture is written as
  // several batches, exactly as the real converter output is.
  const batches: BatchSpec[] = [];
  for (let start = 0; start < rows.length; start += 10) {
    batches.push({
      name: `batch-${String(batches.length + 1).padStart(3, "0")}.csv`,
      rows: rows.slice(start, start + 10),
    });
  }
  writeConverterOutput(batchesDir, batches, taxonomy);
  return { batchesDir, taxonomyPath, prosePath, taxonomy, rows };
}

export { sha256 };
