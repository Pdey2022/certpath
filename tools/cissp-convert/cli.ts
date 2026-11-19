import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fail-closed converter from the owner's local CISSP study file into the
 * `certpath-question-v1` question-import CSV.
 *
 * This module contains schema constants, the taxonomy contract and limit
 * checks only. It contains no question text, options, answers or explanations:
 * every such value is read at run time from the input file and written to the
 * requested output directory outside the repository.
 */

export const FORMAT_VERSION = "certpath-question-v1";
export const DIFFICULTY = "medium";
export const MAX_ROWS_PER_BATCH = 10;
export const OPTION_COUNT = 4;
export const OPTION_SLOTS = 8;
export const QUESTION_ID_MIN = 1;
export const QUESTION_ID_MAX = 484;
export const TAXONOMY_FORMAT_VERSION = "certpath-cissp-taxonomy-v1";
export const MANIFEST_FORMAT_VERSION = "certpath-cissp-convert-manifest-v1";
export const TAXONOMY_REPORT_FORMAT_VERSION =
  "certpath-cissp-convert-taxonomy-report-v1";

/** Contract caps from docs/question-bank-import-export.md. */
export const LIMITS = {
  stem: { minimum: 5, maximum: 4000 },
  optionText: { minimum: 1, maximum: 1000 },
  explanation: { minimum: 1, maximum: 3000 },
  sourceReference: { minimum: 1, maximum: 1000 },
  licenseReference: { minimum: 1, maximum: 200 },
  key: { minimum: 1, maximum: 120 },
  optionKey: { minimum: 1, maximum: 32 },
} as const;

/**
 * The exact ordered header of `QUESTION_IMPORT_TEMPLATE_COLUMNS` in
 * `apps/api/src/security/question-imports.ts`. The parity test imports the real
 * constant so this copy cannot drift unnoticed.
 */
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

export type ConverterErrorCode =
  | "UNKNOWN_ARGUMENT"
  | "DUPLICATE_ARGUMENT"
  | "MISSING_ARGUMENT"
  | "INVALID_EXAM_VERSION_ID"
  | "MISSING_PROVENANCE"
  | "PROVENANCE_CONFLICT"
  | "PROVENANCE_UNREADABLE"
  | "PROVENANCE_INVALID"
  | "INPUT_UNREADABLE"
  | "HTML_ARRAY_NOT_FOUND"
  | "HTML_ARRAY_UNPARSEABLE"
  | "QUESTIONS_NOT_ARRAY"
  | "QUESTION_NOT_OBJECT"
  | "QUESTION_FIELD_INVALID"
  | "DUPLICATE_QUESTION_ID"
  | "QUESTION_ID_OUT_OF_RANGE"
  | "OPTION_COUNT_INVALID"
  | "OPTION_KEY_INVALID"
  | "BLANK_QUESTION_TEXT"
  | "BLANK_OPTION_TEXT"
  | "VALUE_BELOW_MINIMUM"
  | "VALUE_OVER_LIMIT"
  | "TAXONOMY_UNREADABLE"
  | "TAXONOMY_INVALID"
  | "UNKNOWN_DOMAIN_PREFIX"
  | "UNKNOWN_SOURCE_LABEL"
  | "NO_ROWS_WRITTEN"
  | "OUTPUT_INSIDE_REPOSITORY"
  | "OUTPUT_PATH_INVALID"
  | "OUTPUT_DIRECTORY_NOT_EMPTY"
  | "OUTPUT_WRITE_FAILED";

export class ConverterError extends Error {
  readonly code: ConverterErrorCode;

  constructor(code: ConverterErrorCode, detail: string) {
    super(detail);
    this.name = "ConverterError";
    this.code = code;
  }
}

export type RejectionCode =
  | "CORRECT_ANSWER_MATCH_COUNT"
  | "EXPLANATION_MISSING"
  | "EXPLANATION_SPLIT_INCOMPLETE";

export interface Provenance {
  sourceReference: string;
  licenseReference: string;
}

export interface CliOptions {
  inputPath: string;
  taxonomyPath: string;
  outDir: string;
  examVersionId: string;
  provenance: Provenance;
}

export interface Rejection {
  id: number;
  code: RejectionCode;
  detail: string;
}

export interface ConversionSummary {
  parsed: number;
  written: number;
  rejected: number;
  batches: number;
  rejectionsByCode: Record<string, number>;
  outputDir: string;
}

interface SourceOption {
  key: string;
  text: string;
}

interface SourceQuestion {
  id: number;
  stem: string;
  options: SourceOption[];
  correctText: string;
  correctExplanation: string;
  distractorExplanations: string;
  label: string;
}

interface TaxonomySourceLabel {
  label: string;
  expectedQuestions: number;
}

interface TaxonomyTopic {
  id: string;
  slug: string;
  title: string;
  expectedQuestions: number;
  sourceLabels: TaxonomySourceLabel[];
}

interface TaxonomyDomain {
  id: string;
  title: string;
  sourcePrefixes: string[];
  expectedQuestions: number;
  topics: TaxonomyTopic[];
}

interface Taxonomy {
  domains: TaxonomyDomain[];
  labels: Map<string, { domain: TaxonomyDomain; topic: TaxonomyTopic }>;
  topicCount: number;
}

interface ImportRow {
  id: number;
  domainId: string;
  topicId: string;
  label: string;
  cells: string[];
}

export interface OutputFile {
  name: string;
  contents: string;
}

export interface OutputIo {
  writeFile(path: string, data: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
  mkdir(path: string): void;
  removeDir(path: string): void;
  readdir(path: string): string[];
  exists(path: string): boolean;
}

const defaultIo: OutputIo = {
  writeFile(path, data) {
    writeFileSync(path, data, "utf8");
  },
  rename(from, to) {
    renameSync(from, to);
  },
  remove(path) {
    rmSync(path, { force: true });
  },
  mkdir(path) {
    mkdirSync(path, { recursive: true });
  },
  removeDir(path) {
    rmdirSync(path);
  },
  readdir(path) {
    return readdirSync(path);
  },
  exists(path) {
    return existsSync(path);
  },
};

const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const OPTION_KEY_PATTERN = /^[A-H]$/;
const MARKER_PATTERN = /(?:^|(?<=[\s;,:]))([A-H])\.(?=\s|$)/g;

function isKey(value: string, maximum: number): boolean {
  return value.length >= 1 && value.length <= maximum && KEY_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireBoundedText(
  value: unknown,
  field: string,
  bounds: { minimum: number; maximum: number },
  code: ConverterErrorCode = "VALUE_OVER_LIMIT",
): string {
  if (typeof value !== "string") {
    throw new ConverterError("QUESTION_FIELD_INVALID", `${field} is not text`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ConverterError(
      field === "stem" ? "BLANK_QUESTION_TEXT" : "BLANK_OPTION_TEXT",
      `${field} is blank`,
    );
  }
  if (trimmed.length < bounds.minimum) {
    throw new ConverterError(
      "VALUE_BELOW_MINIMUM",
      `${field} length ${trimmed.length} is below ${bounds.minimum}`,
    );
  }
  if (trimmed.length > bounds.maximum) {
    throw new ConverterError(
      code,
      `${field} length ${trimmed.length} exceeds ${bounds.maximum}`,
    );
  }
  return trimmed;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Minimal RFC 4180 writer: quote only when a cell contains a quote, comma or
 * line break, or has leading/trailing whitespace. Doubling quotes is the
 * `csv-parse` convention documented for export.
 */
export function csvCell(value: string): string {
  if (/[",\r\n]/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export function csvLine(cells: readonly string[]): string {
  return cells.map(csvCell).join(",");
}

/**
 * Locates the JSON array assigned to `allQuestions` in the HTML and parses it.
 * Anything other than one JSON array is a named failure: no partial parse is
 * used and no fallback to a regex over objects is attempted.
 */
export function parseQuestionsHtml(html: string): unknown[] {
  const marker = "allQuestions";
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) {
    throw new ConverterError(
      "HTML_ARRAY_NOT_FOUND",
      "no allQuestions declaration found",
    );
  }
  const arrayStart = html.indexOf("[", markerIndex);
  if (arrayStart < 0) {
    throw new ConverterError(
      "HTML_ARRAY_NOT_FOUND",
      "no array follows the allQuestions declaration",
    );
  }
  const between = html.slice(markerIndex + marker.length, arrayStart);
  if (!/^\s*=\s*$/.test(between)) {
    throw new ConverterError(
      "HTML_ARRAY_NOT_FOUND",
      "allQuestions is not assigned an array literal",
    );
  }

  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  let arrayEnd = -1;
  for (let index = arrayStart; index < html.length; index += 1) {
    const character = html[index];
    if (inString !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === inString) {
        inString = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      inString = character;
      continue;
    }
    if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        arrayEnd = index;
        break;
      }
    }
  }
  if (arrayEnd < 0) {
    throw new ConverterError(
      "HTML_ARRAY_UNPARSEABLE",
      "the allQuestions array is not closed",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(html.slice(arrayStart, arrayEnd + 1));
  } catch {
    throw new ConverterError(
      "HTML_ARRAY_UNPARSEABLE",
      "the allQuestions array is not valid JSON",
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ConverterError("QUESTIONS_NOT_ARRAY", "allQuestions is not an array");
  }
  return parsed;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : null;
}

/**
 * Validates the taxonomy file. A malformed or internally inconsistent
 * taxonomy is fatal: the tool never guesses a domain or topic.
 */
export function parseTaxonomy(raw: unknown): Taxonomy {
  if (!isRecord(raw)) {
    throw new ConverterError("TAXONOMY_INVALID", "taxonomy is not an object");
  }
  if (raw["formatVersion"] !== TAXONOMY_FORMAT_VERSION) {
    throw new ConverterError(
      "TAXONOMY_INVALID",
      `taxonomy formatVersion must be ${TAXONOMY_FORMAT_VERSION}`,
    );
  }
  if (!Array.isArray(raw["domains"])) {
    throw new ConverterError("TAXONOMY_INVALID", "domains is not an array");
  }
  if (raw["domains"].length !== 8) {
    throw new ConverterError(
      "TAXONOMY_INVALID",
      `expected 8 domains, found ${raw["domains"].length}`,
    );
  }

  const domains: TaxonomyDomain[] = [];
  const labels = new Map<
    string,
    { domain: TaxonomyDomain; topic: TaxonomyTopic }
  >();
  const domainIds = new Set<string>();
  const topicIds = new Set<string>();
  const prefixes = new Set<string>();
  let topicCount = 0;

  for (const rawDomain of raw["domains"]) {
    if (!isRecord(rawDomain)) {
      throw new ConverterError("TAXONOMY_INVALID", "domain is not an object");
    }
    const id = rawDomain["id"];
    const title = rawDomain["title"];
    const sourcePrefixes = rawDomain["sourcePrefixes"];
    const expectedQuestions = positiveInteger(rawDomain["expectedQuestions"]);
    if (
      typeof id !== "string" ||
      !isKey(id, LIMITS.key.maximum) ||
      typeof title !== "string" ||
      title.trim().length === 0 ||
      !Array.isArray(sourcePrefixes) ||
      sourcePrefixes.length === 0 ||
      expectedQuestions === null
    ) {
      throw new ConverterError("TAXONOMY_INVALID", "domain shape is invalid");
    }
    if (domainIds.has(id)) {
      throw new ConverterError("TAXONOMY_INVALID", `duplicate domain id ${id}`);
    }
    domainIds.add(id);

    const domainPrefixes: string[] = [];
    for (const prefix of sourcePrefixes) {
      if (typeof prefix !== "string" || prefix.trim() !== prefix || prefix.length === 0) {
        throw new ConverterError(
          "TAXONOMY_INVALID",
          `domain ${id} has an invalid source prefix`,
        );
      }
      if (prefixes.has(prefix)) {
        throw new ConverterError(
          "TAXONOMY_INVALID",
          `source prefix ${prefix} is claimed twice`,
        );
      }
      prefixes.add(prefix);
      domainPrefixes.push(prefix);
    }

    if (!Array.isArray(rawDomain["topics"]) || rawDomain["topics"].length === 0) {
      throw new ConverterError("TAXONOMY_INVALID", `domain ${id} has no topics`);
    }

    const topics: TaxonomyTopic[] = [];
    const domainLabels = new Set<string>();
    let domainTopicTotal = 0;
    for (const rawTopic of rawDomain["topics"]) {
      if (!isRecord(rawTopic)) {
        throw new ConverterError("TAXONOMY_INVALID", `domain ${id} has a non-object topic`);
      }
      const topicId = rawTopic["id"];
      const slug = rawTopic["slug"];
      const topicTitle = rawTopic["title"];
      const topicExpected = positiveInteger(rawTopic["expectedQuestions"]);
      if (
        typeof topicId !== "string" ||
        !isKey(topicId, LIMITS.key.maximum) ||
        typeof slug !== "string" ||
        !isKey(slug, LIMITS.key.maximum) ||
        typeof topicTitle !== "string" ||
        topicTitle.trim().length === 0 ||
        topicExpected === null
      ) {
        throw new ConverterError("TAXONOMY_INVALID", `domain ${id} has an invalid topic`);
      }
      if (topicIds.has(topicId)) {
        throw new ConverterError("TAXONOMY_INVALID", `duplicate topic id ${topicId}`);
      }
      topicIds.add(topicId);
      if (topics.some((topic) => topic.slug === slug)) {
        throw new ConverterError(
          "TAXONOMY_INVALID",
          `domain ${id} repeats topic slug ${slug}`,
        );
      }
      if (!Array.isArray(rawTopic["sourceLabels"]) || rawTopic["sourceLabels"].length === 0) {
        throw new ConverterError(
          "TAXONOMY_INVALID",
          `topic ${topicId} has no source labels`,
        );
      }

      const sourceLabels: TaxonomySourceLabel[] = [];
      let labelTotal = 0;
      for (const rawLabel of rawTopic["sourceLabels"]) {
        if (!isRecord(rawLabel)) {
          throw new ConverterError(
            "TAXONOMY_INVALID",
            `topic ${topicId} has a non-object source label`,
          );
        }
        const label = rawLabel["label"];
        const labelExpected = positiveInteger(rawLabel["expectedQuestions"]);
        if (
          typeof label !== "string" ||
          label.trim() !== label ||
          label.length === 0 ||
          /\s{2,}/.test(label) ||
          labelExpected === null
        ) {
          throw new ConverterError(
            "TAXONOMY_INVALID",
            `topic ${topicId} has an invalid source label`,
          );
        }
        if (domainLabels.has(label)) {
          throw new ConverterError(
            "TAXONOMY_INVALID",
            `domain ${id} maps source label ${label} twice`,
          );
        }
        domainLabels.add(label);
        labelTotal += labelExpected;
        sourceLabels.push({ label, expectedQuestions: labelExpected });
      }
      if (labelTotal !== topicExpected) {
        throw new ConverterError(
          "TAXONOMY_INVALID",
          `topic ${topicId} expects ${topicExpected} but its labels total ${labelTotal}`,
        );
      }
      domainTopicTotal += topicExpected;
      topicCount += 1;
      topics.push({
        id: topicId,
        slug,
        title: topicTitle,
        expectedQuestions: topicExpected,
        sourceLabels,
      });
    }
    if (domainTopicTotal !== expectedQuestions) {
      throw new ConverterError(
        "TAXONOMY_INVALID",
        `domain ${id} expects ${expectedQuestions} but its topics total ${domainTopicTotal}`,
      );
    }
    domains.push({
      id,
      title,
      sourcePrefixes: domainPrefixes,
      expectedQuestions,
      topics,
    });
  }

  if (topicCount !== 36) {
    throw new ConverterError(
      "TAXONOMY_INVALID",
      `expected 36 topics, found ${topicCount}`,
    );
  }

  // The label map above is keyed by domain+label; resolve its topic objects
  // against the completed domain records so every reference is the same object.
  for (const domain of domains) {
    for (const topic of domain.topics) {
      for (const sourceLabel of topic.sourceLabels) {
        labels.set(`${domain.id}\u0000${sourceLabel.label}`, { domain, topic });
      }
    }
  }

  return { domains, labels, topicCount };
}

function resolveLabel(
  labelText: string,
  taxonomy: Taxonomy,
): { domain: TaxonomyDomain; topic: TaxonomyTopic } {
  for (const domain of taxonomy.domains) {
    for (const prefix of domain.sourcePrefixes) {
      for (const separator of [" > ", " / "]) {
        const fullPrefix = `${prefix}${separator}`;
        if (labelText.startsWith(fullPrefix)) {
          const label = labelText.slice(fullPrefix.length);
          const match = taxonomy.labels.get(`${domain.id}\u0000${label}`);
          if (!match) {
            throw new ConverterError(
              "UNKNOWN_SOURCE_LABEL",
              `domain ${domain.id} does not map source label ${label}`,
            );
          }
          return match;
        }
      }
    }
  }
  throw new ConverterError(
    "UNKNOWN_DOMAIN_PREFIX",
    `no domain source prefix matches ${labelText}`,
  );
}

function normalizeForComparison(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseSourceQuestions(questions: unknown[]): SourceQuestion[] {
  const seen = new Set<number>();
  const result: SourceQuestion[] = [];

  for (const rawQuestion of questions) {
    if (!isRecord(rawQuestion)) {
      throw new ConverterError("QUESTION_NOT_OBJECT", "a question is not an object");
    }
    const rawId = rawQuestion["id"];
    if (
      typeof rawId !== "number" ||
      !Number.isInteger(rawId) ||
      rawId < QUESTION_ID_MIN ||
      rawId > QUESTION_ID_MAX
    ) {
      throw new ConverterError(
        "QUESTION_ID_OUT_OF_RANGE",
        `question id must be an integer from ${QUESTION_ID_MIN} to ${QUESTION_ID_MAX}`,
      );
    }
    if (seen.has(rawId)) {
      throw new ConverterError("DUPLICATE_QUESTION_ID", `duplicate question id ${rawId}`);
    }
    seen.add(rawId);

    const stem = requireBoundedText(rawQuestion["question"], "stem", LIMITS.stem);

    const rawOptions = rawQuestion["options"];
    if (!Array.isArray(rawOptions) || rawOptions.length !== OPTION_COUNT) {
      throw new ConverterError(
        "OPTION_COUNT_INVALID",
        `question ${rawId} must have ${OPTION_COUNT} options`,
      );
    }
    const options: SourceOption[] = [];
    const optionKeys = new Set<string>();
    for (const rawOption of rawOptions) {
      if (!isRecord(rawOption)) {
        throw new ConverterError("QUESTION_FIELD_INVALID", `question ${rawId} has a non-object option`);
      }
      const rawLetter = rawOption["letter"];
      const key = typeof rawLetter === "string" ? rawLetter.trim().toUpperCase() : "";
      if (!OPTION_KEY_PATTERN.test(key)) {
        throw new ConverterError(
          "OPTION_KEY_INVALID",
          `question ${rawId} has an option letter outside A-H`,
        );
      }
      if (optionKeys.has(key)) {
        throw new ConverterError(
          "OPTION_KEY_INVALID",
          `question ${rawId} repeats option key ${key}`,
        );
      }
      optionKeys.add(key);
      const text = requireBoundedText(
        rawOption["text"],
        `question ${rawId} option ${key} text`,
        LIMITS.optionText,
      );
      options.push({ key, text });
    }

    const correctText = rawQuestion["correct_text"];
    if (typeof correctText !== "string" || correctText.trim().length === 0) {
      throw new ConverterError("QUESTION_FIELD_INVALID", `question ${rawId} has no correct_text`);
    }
    const correctExplanation = rawQuestion["ins_why"];
    if (typeof correctExplanation !== "string") {
      throw new ConverterError("QUESTION_FIELD_INVALID", `question ${rawId} has no ins_why`);
    }
    const distractorExplanations = rawQuestion["ins_others"];
    if (typeof distractorExplanations !== "string") {
      throw new ConverterError("QUESTION_FIELD_INVALID", `question ${rawId} has no ins_others`);
    }
    const label = rawQuestion["ins_map"];
    if (typeof label !== "string" || label.trim().length === 0) {
      throw new ConverterError("QUESTION_FIELD_INVALID", `question ${rawId} has no ins_map`);
    }

    result.push({
      id: rawId,
      stem,
      options,
      correctText,
      correctExplanation,
      distractorExplanations,
      label: label.trim(),
    });
  }

  return result;
}

export type SplitResult =
  | { ok: true; fragments: Map<string, string> }
  | { ok: false; detail: string };

/**
 * Splits `ins_others` on the source's letter markers. A marker is the *next
 * expected* option letter, in option order; any other capital letter followed
 * by a full stop is prose (for example a sentence ending in "option B."), not a
 * marker. The result must contain exactly one non-empty fragment for each
 * expected (non-correct) option. No fragment is ever duplicated onto another
 * option and the correct option's `ins_why` is never used as a fallback.
 */
export function splitDistractorExplanations(
  text: string,
  expectedLetters: readonly string[],
): SplitResult {
  const source = text.trim();
  const expected = `${expectedLetters.join(",")}`;
  const markerPattern = new RegExp(MARKER_PATTERN.source, "g");
  const candidates = [...source.matchAll(markerPattern)];

  const selected: Array<{ letter: string; index: number; length: number }> = [];
  let position = 0;
  for (const candidate of candidates) {
    if (position >= expectedLetters.length) break;
    if (candidate[1] === expectedLetters[position]) {
      selected.push({
        letter: candidate[1],
        index: candidate.index,
        length: candidate[0].length,
      });
      position += 1;
    }
  }

  if (selected.length === 0) {
    return {
      ok: false,
      detail: `no letter markers found; expected ${expected}`,
    };
  }
  const leading = source.slice(0, selected[0].index).trim();
  if (leading.length > 0) {
    return {
      ok: false,
      detail: `text precedes the first letter marker; expected ${expected}`,
    };
  }
  if (position !== expectedLetters.length) {
    return {
      ok: false,
      detail: `found markers ${selected
        .map((marker) => marker.letter)
        .join(",")}; expected ${expected}`,
    };
  }

  const fragments = new Map<string, string>();
  for (let index = 0; index < selected.length; index += 1) {
    const marker = selected[index];
    const start = marker.index + marker.length;
    const end =
      index + 1 < selected.length ? selected[index + 1].index : source.length;
    const fragment = source.slice(start, end).trim();
    if (fragment.length === 0) {
      return {
        ok: false,
        detail: `empty fragment for option ${marker.letter}; expected ${expected}`,
      };
    }
    fragments.set(marker.letter, fragment);
  }

  return { ok: true, fragments };
}

function buildRow(
  question: SourceQuestion,
  domain: TaxonomyDomain,
  topic: TaxonomyTopic,
  examVersionId: string,
  provenance: Provenance,
): { cells: string[]; rejection: Rejection | null } {
  const correctMatches = question.options.filter(
    (option) =>
      normalizeForComparison(option.text) ===
      normalizeForComparison(question.correctText),
  );
  if (correctMatches.length !== 1) {
    return {
      cells: [],
      rejection: {
        id: question.id,
        code: "CORRECT_ANSWER_MATCH_COUNT",
        detail: `correct_text matches ${correctMatches.length} option(s)`,
      },
    };
  }
  const correctKey = correctMatches[0].key;

  const correctExplanation = question.correctExplanation.trim();
  if (correctExplanation.length === 0) {
    return {
      cells: [],
      rejection: {
        id: question.id,
        code: "EXPLANATION_MISSING",
        detail: "ins_why is blank",
      },
    };
  }
  if (correctExplanation.length > LIMITS.explanation.maximum) {
    throw new ConverterError(
      "VALUE_OVER_LIMIT",
      `question ${question.id} ins_why length ${correctExplanation.length} exceeds ${LIMITS.explanation.maximum}`,
    );
  }

  const expectedLetters = question.options
    .map((option) => option.key)
    .filter((key) => key !== correctKey);
  const split = splitDistractorExplanations(
    question.distractorExplanations,
    expectedLetters,
  );
  if (!split.ok) {
    return {
      cells: [],
      rejection: {
        id: question.id,
        code: "EXPLANATION_SPLIT_INCOMPLETE",
        detail: split.detail,
      },
    };
  }

  const explanations = new Map<string, string>();
  for (const option of question.options) {
    const explanation =
      option.key === correctKey ? correctExplanation : split.fragments.get(option.key);
    if (explanation === undefined || explanation.trim().length === 0) {
      return {
        cells: [],
        rejection: {
          id: question.id,
          code: "EXPLANATION_MISSING",
          detail: `option ${option.key} has no explanation`,
        },
      };
    }
    if (explanation.length > LIMITS.explanation.maximum) {
      throw new ConverterError(
        "VALUE_OVER_LIMIT",
        `question ${question.id} option ${option.key} explanation length ${explanation.length} exceeds ${LIMITS.explanation.maximum}`,
      );
    }
    explanations.set(option.key, explanation);
  }

  const cells: string[] = [
    FORMAT_VERSION,
    `cissp-${question.id}`,
    examVersionId,
    domain.id,
    topic.id,
    question.stem,
    DIFFICULTY,
    provenance.sourceReference,
    provenance.licenseReference,
  ];
  for (let slot = 1; slot <= OPTION_SLOTS; slot += 1) {
    const option = question.options[slot - 1];
    if (!option) {
      cells.push("", "", "", "");
      continue;
    }
    cells.push(
      option.key,
      option.text,
      option.key === correctKey ? "true" : "false",
      explanations.get(option.key) ?? "",
    );
  }

  if (cells.length !== QUESTION_IMPORT_COLUMNS.length) {
    throw new ConverterError(
      "OUTPUT_WRITE_FAILED",
      `row has ${cells.length} cells but the template has ${QUESTION_IMPORT_COLUMNS.length}`,
    );
  }

  return {
    cells,
    rejection: null,
  };
}

function validateProvenance(value: unknown): Provenance {
  if (!isRecord(value)) {
    throw new ConverterError("PROVENANCE_INVALID", "provenance is not an object");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "licenseReference" || keys[1] !== "sourceReference") {
    throw new ConverterError(
      "PROVENANCE_INVALID",
      "provenance must contain exactly sourceReference and licenseReference",
    );
  }
  const sourceReference = value["sourceReference"];
  const licenseReference = value["licenseReference"];
  if (typeof sourceReference !== "string" || typeof licenseReference !== "string") {
    throw new ConverterError(
      "PROVENANCE_INVALID",
      "provenance values must be strings",
    );
  }
  const source = sourceReference.trim();
  const license = licenseReference.trim();
  if (
    source.length < LIMITS.sourceReference.minimum ||
    source.length > LIMITS.sourceReference.maximum
  ) {
    throw new ConverterError(
      "PROVENANCE_INVALID",
      `sourceReference must be ${LIMITS.sourceReference.minimum}-${LIMITS.sourceReference.maximum} characters`,
    );
  }
  if (
    license.length < LIMITS.licenseReference.minimum ||
    license.length > LIMITS.licenseReference.maximum
  ) {
    throw new ConverterError(
      "PROVENANCE_INVALID",
      `licenseReference must be ${LIMITS.licenseReference.minimum}-${LIMITS.licenseReference.maximum} characters`,
    );
  }
  return { sourceReference: source, licenseReference: license };
}

interface JsonFile {
  value: unknown;
  text: string;
}

function readJsonFile(
  path: string,
  unreadable: ConverterErrorCode,
  invalid: ConverterErrorCode,
  field: string,
): JsonFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConverterError(unreadable, `${field} could not be read`);
  }
  try {
    return { value: JSON.parse(text), text };
  } catch {
    throw new ConverterError(invalid, `${field} is not valid JSON`);
  }
}

function canonicalRepositoryPath(path: string): string {
  const resolved = resolve(path);
  if (existsSync(resolved)) {
    try {
      return realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  }
  const parent = dirname(resolved);
  if (parent === resolved) return resolved;
  return join(canonicalRepositoryPath(parent), basename(resolved));
}

function isInside(parent: string, child: string): boolean {
  const normalize = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const parentPath = normalize(parent);
  const childPath = normalize(child);
  if (childPath === parentPath) return true;
  const boundary = parentPath.endsWith(sep) ? parentPath : `${parentPath}${sep}`;
  return childPath.startsWith(boundary);
}

export function assertOutputOutsideRepository(outDir: string, repoRoot: string): string {
  const canonicalOut = canonicalRepositoryPath(outDir);
  const canonicalRoot = canonicalRepositoryPath(repoRoot);
  if (isInside(canonicalRoot, canonicalOut)) {
    throw new ConverterError(
      "OUTPUT_INSIDE_REPOSITORY",
      "the output directory must be outside the repository",
    );
  }
  return canonicalOut;
}

export function writeOutputsAtomically(
  outDir: string,
  files: readonly OutputFile[],
  ioOverrides: Partial<OutputIo> = {},
): void {
  const io: OutputIo = { ...defaultIo, ...ioOverrides };
  let createdDir = false;
  if (!io.exists(outDir)) {
    io.mkdir(outDir);
    createdDir = true;
  }

  const partials: string[] = [];
  const finals: string[] = [];
  try {
    for (const file of files) {
      const partial = join(outDir, `${file.name}.partial`);
      io.writeFile(partial, file.contents);
      partials.push(partial);
    }
    for (const file of files) {
      const partial = join(outDir, `${file.name}.partial`);
      const final = join(outDir, file.name);
      io.rename(partial, final);
      finals.push(final);
    }
  } catch {
    for (const path of partials) {
      try {
        io.remove(path);
      } catch {
        // Best effort cleanup; the original failure is what matters.
      }
    }
    for (const path of finals) {
      try {
        io.remove(path);
      } catch {
        // Best effort cleanup; the original failure is what matters.
      }
    }
    if (createdDir) {
      try {
        io.removeDir(outDir);
      } catch {
        // The directory may not be empty if the platform held a handle open.
      }
    }
    throw new ConverterError("OUTPUT_WRITE_FAILED", "output files were not written");
  }
}

function assertOutputDirectoryReady(outDir: string, io: OutputIo): void {
  if (io.exists(outDir)) {
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(outDir);
    } catch {
      throw new ConverterError("OUTPUT_PATH_INVALID", "the output path is not readable");
    }
    if (!stats.isDirectory()) {
      throw new ConverterError("OUTPUT_PATH_INVALID", "the output path is not a directory");
    }
    if (io.readdir(outDir).length > 0) {
      throw new ConverterError(
        "OUTPUT_DIRECTORY_NOT_EMPTY",
        "the output directory must be empty",
      );
    }
  }
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function sortRecord(record: Record<string, number>): Record<string, number> {
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = record[key];
  }
  return sorted;
}

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));

export function defaultRepositoryRoot(): string {
  return canonicalRepositoryPath(resolve(TOOL_DIR, "..", ".."));
}

export interface ConverterOptions {
  inputPath: string;
  taxonomyPath: string;
  outDir: string;
  examVersionId: string;
  provenance: Provenance;
  repoRoot?: string;
  io?: Partial<OutputIo>;
}

export function runConverter(options: ConverterOptions): ConversionSummary {
  const repoRoot = options.repoRoot ?? defaultRepositoryRoot();
  const canonicalOut = assertOutputOutsideRepository(options.outDir, repoRoot);
  const provenance = validateProvenance(options.provenance);

  if (!isKey(options.examVersionId, LIMITS.key.maximum)) {
    throw new ConverterError(
      "INVALID_EXAM_VERSION_ID",
      `exam version id must match ${KEY_PATTERN.source} and be at most ${LIMITS.key.maximum} characters`,
    );
  }

  let sourceText: string;
  try {
    sourceText = readFileSync(options.inputPath, "utf8");
  } catch {
    throw new ConverterError("INPUT_UNREADABLE", "the input file could not be read");
  }

  const taxonomyJson = readJsonFile(
    options.taxonomyPath,
    "TAXONOMY_UNREADABLE",
    "TAXONOMY_INVALID",
    "taxonomy",
  );
  const taxonomy = parseTaxonomy(taxonomyJson.value);

  const rawQuestions = parseQuestionsHtml(sourceText);
  const questions = parseSourceQuestions(rawQuestions);

  const rows: ImportRow[] = [];
  const rejections: Rejection[] = [];
  const observedByLabel = new Map<string, number>();

  for (const question of questions) {
    const { domain, topic } = resolveLabel(question.label, taxonomy);
    const observedKey = `${domain.id}\u0000${topic.id}`;
    observedByLabel.set(observedKey, (observedByLabel.get(observedKey) ?? 0) + 1);

    const built = buildRow(question, domain, topic, options.examVersionId, provenance);
    if (built.rejection) {
      rejections.push(built.rejection);
      continue;
    }
    rows.push({
      id: question.id,
      domainId: domain.id,
      topicId: topic.id,
      label: question.label,
      cells: built.cells,
    });
  }

  if (rows.length === 0) {
    throw new ConverterError("NO_ROWS_WRITTEN", "no question passed the import contract");
  }

  const batches = chunks(rows, MAX_ROWS_PER_BATCH);
  const files: OutputFile[] = batches.map((batch, index) => {
    const name = `batch-${String(index + 1).padStart(3, "0")}.csv`;
    const contents = [
      csvLine(QUESTION_IMPORT_COLUMNS),
      ...batch.map((row) => csvLine(row.cells)),
    ].join("\n") + "\n";
    return { name, contents };
  });

  const rejectionsByCode: Record<string, number> = {};
  for (const rejection of rejections) {
    rejectionsByCode[rejection.code] = (rejectionsByCode[rejection.code] ?? 0) + 1;
  }
  const orderedRejections = [...rejections].sort((a, b) => a.id - b.id);
  const rejectionsText =
    orderedRejections
      .map((rejection) => `${rejection.id}\t${rejection.code}\t${rejection.detail}`)
      .join("\n") + (orderedRejections.length > 0 ? "\n" : "");

  const writtenByLabel = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.domainId}\u0000${row.topicId}`;
    writtenByLabel.set(key, (writtenByLabel.get(key) ?? 0) + 1);
  }

  const observedBySourceLabel = new Map<string, number>();
  for (const question of questions) {
    observedBySourceLabel.set(
      question.label,
      (observedBySourceLabel.get(question.label) ?? 0) + 1,
    );
  }
  const countSourceLabel = (domain: TaxonomyDomain, label: string): number =>
    domain.sourcePrefixes.reduce(
      (total, prefix) =>
        total +
        (observedBySourceLabel.get(`${prefix} > ${label}`) ?? 0) +
        (observedBySourceLabel.get(`${prefix} / ${label}`) ?? 0),
      0,
    );

  const taxonomyReport = {
    formatVersion: TAXONOMY_REPORT_FORMAT_VERSION,
    totals: {
      domains: taxonomy.domains.length,
      topics: taxonomy.topicCount,
      expectedQuestions: taxonomy.domains.reduce(
        (total, domain) => total + domain.expectedQuestions,
        0,
      ),
      observedQuestions: questions.length,
      writtenQuestions: rows.length,
      generalQuestions: taxonomy.domains.reduce((total, domain) => {
        const general = domain.topics.find((topic) => topic.slug === "general");
        return (
          total +
          (general ? (observedByLabel.get(`${domain.id}\u0000${general.id}`) ?? 0) : 0)
        );
      }, 0),
    },
    domains: taxonomy.domains.map((domain) => {
      const domainObserved = domain.topics.reduce(
        (total, topic) =>
          total + (observedByLabel.get(`${domain.id}\u0000${topic.id}`) ?? 0),
        0,
      );
      return {
        id: domain.id,
        title: domain.title,
        expectedQuestions: domain.expectedQuestions,
        observedQuestions: domainObserved,
        topics: domain.topics.map((topic) => {
          const key = `${domain.id}\u0000${topic.id}`;
          return {
            id: topic.id,
            slug: topic.slug,
            title: topic.title,
            expectedQuestions: topic.expectedQuestions,
            observedQuestions: observedByLabel.get(key) ?? 0,
            writtenQuestions: writtenByLabel.get(key) ?? 0,
            sourceLabels: topic.sourceLabels.map((sourceLabel) => ({
              label: sourceLabel.label,
              expectedQuestions: sourceLabel.expectedQuestions,
              observedQuestions: countSourceLabel(domain, sourceLabel.label),
            })),
          };
        }),
      };
    }),
  };

  const manifest = {
    formatVersion: MANIFEST_FORMAT_VERSION,
    sourceSha256: sha256(sourceText),
    taxonomySha256: sha256(taxonomyJson.text),
    provenanceSha256: sha256(
      JSON.stringify({
        sourceReference: provenance.sourceReference,
        licenseReference: provenance.licenseReference,
      }),
    ),
    counts: {
      parsed: questions.length,
      written: rows.length,
      rejected: rejections.length,
      batches: batches.length,
      domains: taxonomy.domains.length,
      topics: taxonomy.topicCount,
    },
    rejectionsByCode: sortRecord(rejectionsByCode),
    batches: files.map((file, index) => ({
      file: file.name,
      rows: batches[index].length,
      sha256: sha256(file.contents),
    })),
  };

  files.push(
    { name: "manifest.json", contents: `${JSON.stringify(manifest, null, 2)}\n` },
    {
      name: "taxonomy-report.json",
      contents: `${JSON.stringify(taxonomyReport, null, 2)}\n`,
    },
    { name: "rejections.txt", contents: rejectionsText },
  );

  assertOutputDirectoryReady(canonicalOut, { ...defaultIo, ...options.io });
  writeOutputsAtomically(canonicalOut, files, options.io);

  return {
    parsed: questions.length,
    written: rows.length,
    rejected: rejections.length,
    batches: batches.length,
    rejectionsByCode: sortRecord(rejectionsByCode),
    outputDir: canonicalOut,
  };
}

export interface ParsedArgs {
  help: boolean;
  options?: CliOptions;
}

function nextValue(
  argv: readonly string[],
  index: number,
  inline: string | undefined,
  name: string,
): { value: string; nextIndex: number } {
  if (inline !== undefined) {
    if (inline.length === 0) {
      throw new ConverterError("MISSING_ARGUMENT", `${name} requires a value`);
    }
    return { value: inline, nextIndex: index };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ConverterError("MISSING_ARGUMENT", `${name} requires a value`);
  }
  return { value, nextIndex: index + 1 };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      throw new ConverterError("UNKNOWN_ARGUMENT", `unknown argument ${argument}`);
    }
    const equals = argument.indexOf("=");
    const name = equals >= 0 ? argument.slice(0, equals) : argument;
    const inline = equals >= 0 ? argument.slice(equals + 1) : undefined;
    if (
      ![
        "--input",
        "--taxonomy",
        "--out",
        "--exam-version-id",
        "--source-reference",
        "--license-reference",
        "--provenance",
      ].includes(name)
    ) {
      throw new ConverterError("UNKNOWN_ARGUMENT", `unknown argument ${name}`);
    }
    if (values.has(name)) {
      throw new ConverterError("DUPLICATE_ARGUMENT", `${name} was given twice`);
    }
    const { value, nextIndex } = nextValue(argv, index, inline, name);
    values.set(name, value);
    index = nextIndex;
  }

  if (help) return { help: true };

  const required = ["--input", "--taxonomy", "--out", "--exam-version-id"];
  for (const name of required) {
    if (!values.has(name)) {
      throw new ConverterError("MISSING_ARGUMENT", `${name} is required`);
    }
  }
  const examVersionId = values.get("--exam-version-id") as string;
  if (!isKey(examVersionId, LIMITS.key.maximum)) {
    throw new ConverterError(
      "INVALID_EXAM_VERSION_ID",
      `exam version id must match ${KEY_PATTERN.source} and be at most ${LIMITS.key.maximum} characters`,
    );
  }

  const provenancePath = values.get("--provenance");
  const sourceReference = values.get("--source-reference");
  const licenseReference = values.get("--license-reference");
  let provenance: Provenance;
  if (provenancePath !== undefined) {
    if (sourceReference !== undefined || licenseReference !== undefined) {
      throw new ConverterError(
        "PROVENANCE_CONFLICT",
        "use --provenance or the two reference flags, not both",
      );
    }
    const raw = readJsonFile(
      provenancePath,
      "PROVENANCE_UNREADABLE",
      "PROVENANCE_INVALID",
      "provenance",
    );
    provenance = validateProvenance(raw.value);
  } else {
    if (sourceReference === undefined || licenseReference === undefined) {
      throw new ConverterError(
        "MISSING_PROVENANCE",
        "provide --source-reference and --license-reference, or --provenance",
      );
    }
    provenance = validateProvenance({ sourceReference, licenseReference });
  }

  return {
    help: false,
    options: {
      inputPath: values.get("--input") as string,
      taxonomyPath: values.get("--taxonomy") as string,
      outDir: values.get("--out") as string,
      examVersionId,
      provenance,
    },
  };
}

const HELP_TEXT = `Usage:
  tsx tools/cissp-convert/cli.ts --input <html> --taxonomy <json> --out <dir>
    --exam-version-id <id>
    (--source-reference <text> --license-reference <text> | --provenance <json>)

The output directory must exist outside the repository and be empty. The tool
writes batch-NNN.csv, manifest.json, taxonomy-report.json and rejections.txt.
It exits non-zero with a named code on any fatal condition.`;

function printSummary(summary: ConversionSummary): void {
  console.log(`cissp-convert: parsed ${summary.parsed} question(s)`);
  console.log(
    `cissp-convert: wrote ${summary.written} row(s) in ${summary.batches} batch(es)`,
  );
  console.log(`cissp-convert: rejected ${summary.rejected} question(s)`);
  const codes = Object.keys(summary.rejectionsByCode);
  if (codes.length === 0) {
    console.log("  none");
  } else {
    for (const code of codes) {
      console.log(`  ${code}: ${summary.rejectionsByCode[code]}`);
    }
  }
  console.log(`cissp-convert: output ${summary.outputDir}`);
}

export function main(argv: readonly string[]): number {
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      console.log(HELP_TEXT);
      return 0;
    }
    const summary = runConverter(parsed.options as CliOptions);
    printSummary(summary);
    return 0;
  } catch (error) {
    if (error instanceof ConverterError) {
      console.error(`CISSP_CONVERT_ERROR ${error.code}: ${error.message}`);
      return 1;
    }
    console.error("CISSP_CONVERT_ERROR UNEXPECTED");
    return 1;
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync.native(resolve(entry)) === realpathSync.native(resolve(modulePath));
  } catch {
    return resolve(entry) === resolve(modulePath);
  }
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2));
}
