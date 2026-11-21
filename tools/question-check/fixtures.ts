import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPTION_SLOTS, QUESTION_IMPORT_COLUMNS, QUESTION_IMPORT_FORMAT } from "./contract.ts";

/**
 * Synthetic fixtures only. Every item here is about a fictional widget-change
 * board at a fictional station; none of it is exam material, and none of it is
 * derived from a real bank.
 */

export interface BankShape {
  domainIds: readonly string[];
  weights: readonly number[];
  targetRows: number;
  topicsPerDomain: readonly number[];
  optionCount: number;
  questionKeyPrefix: string;
  domainTitles: readonly string[];
}

/** Four synthetic domains at a flat 25%, 12 rows, three topics each. */
export const SYNTHETIC_SHAPE: BankShape = {
  domainIds: ["syn-d1", "syn-d2", "syn-d3", "syn-d4"],
  weights: [0.25, 0.25, 0.25, 0.25],
  targetRows: 12,
  topicsPerDomain: [3, 3, 3, 3],
  optionCount: 4,
  questionKeyPrefix: "syn",
  domainTitles: [
    "Synthetic governance",
    "Synthetic risk",
    "Synthetic programme",
    "Synthetic incident",
  ],
};

/** The committed CISM shape, for tests that must not drift from the profile. */
export const CISM_SHAPE: BankShape = {
  domainIds: ["cism-d1", "cism-d2", "cism-d3", "cism-d4"],
  weights: [0.18, 0.2, 0.33, 0.29],
  targetRows: 600,
  topicsPerDomain: [4, 4, 5, 5],
  optionCount: 4,
  questionKeyPrefix: "cism",
  domainTitles: [
    "Synthetic governance",
    "Synthetic risk",
    "Synthetic programme",
    "Synthetic incident",
  ],
};

/** A shape whose domain rows are the weights, so any row split can be expressed. */
export function shapeFromRows(
  domainIds: readonly string[],
  rows: readonly number[],
  options: Partial<BankShape> = {},
): BankShape {
  const total = rows.reduce((sum, value) => sum + value, 0);
  const weights = rows.map((value) => value / total);
  // Renormalise the floating remainder onto the last domain so the sum is 1.
  const sum = weights.slice(0, -1).reduce((acc, value) => acc + value, 0);
  weights[weights.length - 1] = 1 - sum;
  return {
    domainIds,
    weights,
    targetRows: total,
    topicsPerDomain: domainIds.map(() => 3),
    optionCount: 4,
    questionKeyPrefix: "syn",
    domainTitles: domainIds.map((id) => `Synthetic domain ${id}`),
    ...options,
  };
}

export function topicIdFor(shape: BankShape, domainIndex: number, topicIndex: number): string {
  return `${shape.domainIds[domainIndex]}-t${topicIndex + 1}`;
}

export function profileRaw(shape: BankShape, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const targets = largestRemainder(shape.weights, shape.targetRows);
  return {
    formatVersion: "certpath-question-profile-v1",
    certificationKey: shape.questionKeyPrefix,
    examVersionId: `${shape.questionKeyPrefix}-exam-v1`,
    targetRows: shape.targetRows,
    examQuestionCount: 150,
    optionCount: shape.optionCount,
    questionKeyPattern: `^${shape.questionKeyPrefix}-[1-9][0-9]*$`,
    domains: shape.domainIds.map((id, index) => ({
      id,
      weightShare: shape.weights[index],
      targetRows: targets[index],
    })),
    difficultyTargets: null,
    catchAllTopicKeys: [],
    maxDomainShareDeviation: 0.05,
    maxDomainDeviationSlackItems: 3,
    answerPosition: {
      monotoneBatchMinimum: 4,
      biasedMinimumRows: 40,
      biasedShare: 0.4,
      skewShare: 0.32,
    },
    nearDuplicate: { shingleSize: 5, threshold: 0.8 },
    referenceProcesses: [],
    ...overrides,
  };
}

export function profileText(shape: BankShape, overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify(profileRaw(shape, overrides), null, 2)}\n`;
}

export function taxonomyRaw(
  shape: BankShape,
  overrides: { blankProse?: boolean } = {},
): Record<string, unknown> {
  return {
    formatVersion: "certpath-question-taxonomy-v1",
    certificationKey: shape.questionKeyPrefix,
    examVersionId: `${shape.questionKeyPrefix}-exam-v1`,
    domains: shape.domainIds.map((id, domainIndex) => ({
      id,
      title: shape.domainTitles[domainIndex] ?? `Synthetic domain ${id}`,
      topics: Array.from({ length: shape.topicsPerDomain[domainIndex] ?? 3 }, (_, topicIndex) => ({
        id: topicIdFor(shape, domainIndex, topicIndex),
        title: overrides.blankProse === true ? "" : `Synthetic topic ${domainIndex + 1}.${topicIndex + 1}`,
        meaning:
          overrides.blankProse === true
            ? ""
            : `Synthetic meaning for topic ${domainIndex + 1}.${topicIndex + 1}.`,
      })),
    })),
  };
}

export function taxonomyText(
  shape: BankShape,
  overrides: { blankProse?: boolean } = {},
): string {
  return `${JSON.stringify(taxonomyRaw(shape, overrides), null, 2)}\n`;
}

export interface OptionSpec {
  key?: string;
  text?: string;
  correct?: boolean;
  explanation?: string;
}

export interface ItemSpec {
  key: string;
  domainId?: string;
  topicId?: string;
  stem?: string;
  difficulty?: string;
  formatVersion?: string;
  examVersionId?: string;
  sourceReference?: string;
  licenseReference?: string;
  options?: Array<OptionSpec | null>;
  /** Index of the keyed option when `options` is omitted; defaults to 0. */
  correctIndex?: number;
}

export const DEFAULT_EXPLANATION = "Synthetic rationale: this station control settles the case.";

function defaultOptions(spec: ItemSpec, optionCount: number): Array<OptionSpec | null> {
  const correctIndex = spec.correctIndex ?? 0;
  return Array.from({ length: optionCount }, (_, index) => ({
    key: String.fromCharCode("A".charCodeAt(0) + index),
    text: `Synthetic choice ${index + 1} for ${spec.key} station`,
    correct: index === correctIndex,
    explanation: `${DEFAULT_EXPLANATION} Choice ${index + 1} is the station option.`,
  }));
}

/** One 41-cell row. Unused slots are empty strings, exactly as the export writes them. */
export function itemCells(spec: ItemSpec, shape: BankShape): string[] {
  const optionCount = shape.optionCount;
  const options = spec.options ?? defaultOptions(spec, optionCount);
  const cells = [
    spec.formatVersion ?? QUESTION_IMPORT_FORMAT,
    spec.key,
    spec.examVersionId ?? `${shape.questionKeyPrefix}-exam-v1`,
    spec.domainId ?? shape.domainIds[0]!,
    spec.topicId ?? topicIdFor(shape, 0, 0),
    spec.stem ?? `Synthetic widget-change item ${spec.key} concerns a station control.`,
    spec.difficulty ?? "medium",
    spec.sourceReference ?? "Synthetic owner fixture",
    spec.licenseReference ?? "Synthetic only",
  ];
  for (let slot = 0; slot < OPTION_SLOTS; slot += 1) {
    const option = slot < optionCount ? options[slot] ?? null : null;
    cells.push(
      option?.key ?? "",
      option?.text ?? "",
      option === null ? "" : option.correct === true ? "true" : "false",
      option?.explanation ?? "",
    );
  }
  return cells;
}

export function batchCsv(
  shape: BankShape,
  items: readonly ItemSpec[],
  options: { header?: readonly string[] } = {},
): string {
  const header = options.header ?? QUESTION_IMPORT_COLUMNS;
  const lines = [header.join(","), ...items.map((item) => itemCells(item, shape).map(csvCell).join(","))];
  return `${lines.join("\n")}\n`;
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

/**
 * A run of `rowsPerDomain` items per domain, waiting to be split into batches.
 * Keys are sequential from 1, answer positions cycle 1..optionCount so a
 * fixture does not trip `ANSWER_POSITION_MONOTONE` by accident.
 */
export function bankItems(
  shape: BankShape,
  rowsPerDomain: readonly number[],
  options: {
    keys?: readonly string[];
    stem?: (item: { key: string; domainIndex: number; ordinal: number }) => string;
    difficultyCycle?: readonly string[];
  } = {},
): ItemSpec[] {
  const items: ItemSpec[] = [];
  let ordinal = 0;
  const providedKeys = options.keys;
  shape.domainIds.forEach((domainId, domainIndex) => {
    const rows = rowsPerDomain[domainIndex] ?? 0;
    const topics = shape.topicsPerDomain[domainIndex] ?? 3;
    for (let row = 0; row < rows; row += 1) {
      ordinal += 1;
      const key = providedKeys?.[ordinal - 1] ?? `${shape.questionKeyPrefix}-${ordinal}`;
      const topicIndex = row % topics;
      const cycle = options.difficultyCycle ?? ["easy", "medium", "hard", "medium"];
      items.push({
        key,
        domainId,
        topicId: topicIdFor(shape, domainIndex, topicIndex),
        stem:
          options.stem?.({ key, domainIndex, ordinal }) ??
          `Synthetic widget-change item ${key} concerns station control ${ordinal}.`,
        difficulty: cycle[ordinal % cycle.length] ?? "medium",
        correctIndex: ordinal % shape.optionCount,
      });
    }
  });
  return items;
}

/** Splits items into files of `size` rows, named `batch-001.csv`, `batch-002.csv`, … */
export function splitIntoBatches(
  shape: BankShape,
  items: readonly ItemSpec[],
  size = 10,
): Record<string, string> {
  const files: Record<string, string> = {};
  for (let start = 0, index = 1; start < items.length; start += size, index += 1) {
    files[`batch-${String(index).padStart(3, "0")}.csv`] = batchCsv(shape, items.slice(start, start + size));
  }
  return files;
}

export function makeTempDir(prefix = "question-check-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupDirectories(directories: readonly string[]): void {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function writeFiles(directory: string, files: Record<string, string>): void {
  mkdirSync(directory, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(directory, name), text, "utf8");
  }
}

export function writeText(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
}

export function largestRemainder(values: readonly number[], total: number): number[] {
  const raw = values.map((value) => value * total);
  const floors = raw.map((value) => Math.floor(value + 1e-9));
  const allocated = total - floors.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value + 1e-9) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let step = 0; step < allocated; step += 1) {
    const target = order[step % order.length]!;
    floors[target.index] = (floors[target.index] ?? 0) + 1;
  }
  return floors;
}

export interface Environment {
  root: string;
  batches: string;
  profile: string;
  taxonomy: string;
  out: string;
}

/** A complete run environment in a temp directory outside the repository. */
export function makeEnvironment(input: {
  shape: BankShape;
  files: Record<string, string>;
  profileOverrides?: Record<string, unknown>;
  taxonomyOverrides?: { blankProse?: boolean };
  name?: string;
}): Environment {
  const root = makeTempDir();
  const batches = join(root, input.name ?? "batches");
  const profile = join(root, "profile.json");
  const taxonomy = join(root, "taxonomy.json");
  writeFiles(batches, input.files);
  writeFileSync(profile, profileText(input.shape, input.profileOverrides ?? {}), "utf8");
  writeFileSync(taxonomy, taxonomyText(input.shape, input.taxonomyOverrides ?? {}), "utf8");
  return { root, batches, profile, taxonomy, out: join(root, "out") };
}

export function checkArgv(environment: Environment, extra: readonly string[] = []): string[] {
  return [
    "check",
    "--batches",
    environment.batches,
    "--profile",
    environment.profile,
    "--taxonomy",
    environment.taxonomy,
    "--out",
    environment.out,
    ...extra,
  ];
}

interface Capture {
  stream: NodeJS.WriteStream;
  text: () => string;
}

function captureStream(): Capture {
  let buffer = "";
  const stream = {
    write(chunk: string | Uint8Array): boolean {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
  };
  return { stream: stream as unknown as NodeJS.WriteStream, text: () => buffer };
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI in-process with captured streams; never touches the network. */
export async function runCli(argv: readonly string[], repoRoot?: string): Promise<CliResult> {
  const { main } = await import("./cli.ts");
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await main(argv, {
    stdout: stdout.stream,
    stderr: stderr.stream,
    ...(repoRoot === undefined ? {} : { repoRoot }),
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}
