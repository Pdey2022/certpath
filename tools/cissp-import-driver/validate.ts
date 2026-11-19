import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  CONVERTER_MANIFEST_FORMAT_VERSION,
  LIMITS,
  OPTION_COUNT,
  OPTION_SLOTS,
  PROSE_FORMAT_VERSION,
  QUESTION_IMPORT_COLUMNS,
  QUESTION_IMPORT_FORMAT,
  QUESTION_IMPORT_MAX_ROWS,
  QUESTION_KEY_PATTERN,
  TAXONOMY_FORMAT_VERSION,
  TAXONOMY_REPORT_FORMAT_VERSION,
  optionColumnIndices,
  parseCsv,
  sha256,
} from "./contract.ts";
import { DriverError } from "./errors.ts";

/**
 * Stage 0: validate every input before the driver makes a single request.
 *
 * Every function here is pure with respect to the network. File reads are the
 * only side effect, and nothing is written.
 */

export interface TaxonomyTopic {
  id: string;
  slug: string;
  title: string;
  order: number;
}

export interface TaxonomyDomain {
  id: string;
  title: string;
  order: number;
  topics: TaxonomyTopic[];
}

export interface TaxonomyDoc {
  domains: TaxonomyDomain[];
  domainIds: ReadonlySet<string>;
  /** topic id -> owning domain id */
  topicDomains: ReadonlyMap<string, string>;
  titles: ReadonlyMap<string, string>;
  topicIds: ReadonlySet<string>;
}

export interface ProseDoc {
  certification: { id: string | null; slug: string; displayName: string };
  examVersion: { versionKey: string; title: string; syllabusReference: string };
  domains: ReadonlyMap<string, string>;
  topics: ReadonlyMap<string, string>;
  sha256: string;
}

export interface SourceRow {
  /** position in converter order, 1-based */
  position: number;
  key: string;
  domainKey: string;
  topicKey: string;
  cells: string[];
}

export interface ConverterBundle {
  manifestSha256: string;
  declaredExamVersionId: string;
  rows: SourceRow[];
  batchCount: number;
}

export interface ValidatedInputs {
  taxonomy: TaxonomyDoc;
  prose: ProseDoc;
  rows: SourceRow[];
  converterManifestSha256: string;
  declaredExamVersionId: string;
  taxonomySha256: string;
  proseSha256: string;
  batchCount: number;
}

export interface InputPaths {
  batchesDir: string;
  taxonomyPath: string;
  prosePath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readTextFile(
  path: string,
  code:
    | "TAXONOMY_UNREADABLE"
    | "PROSE_UNREADABLE"
    | "CONVERTER_MANIFEST_UNREADABLE"
    | "TAXONOMY_REPORT_UNREADABLE",
): string {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new DriverError(code, `${basename(path)} is not a readable file`);
  }
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new DriverError(code, `${basename(path)} could not be read`);
  }
}

function readJsonFile(
  path: string,
  unreadable:
    | "TAXONOMY_UNREADABLE"
    | "PROSE_UNREADABLE"
    | "CONVERTER_MANIFEST_UNREADABLE"
    | "TAXONOMY_REPORT_UNREADABLE",
  invalid: "PROSE_INVALID_JSON" | "CONVERTER_MANIFEST_INVALID" | "TAXONOMY_INVALID" | "TAXONOMY_REPORT_UNREADABLE",
): { value: unknown; text: string } {
  const text = readTextFile(path, unreadable);
  try {
    return { value: JSON.parse(text), text };
  } catch {
    throw new DriverError(invalid, `${basename(path)} is not valid JSON`);
  }
}

function requireText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maximum) {
    throw new DriverError("TAXONOMY_INVALID", `${label} is missing or out of range`);
  }
  return value.trim();
}

/** Parses and cross-checks the approved taxonomy file. */
export function parseTaxonomy(raw: unknown): TaxonomyDoc {
  if (!isRecord(raw)) {
    throw new DriverError("TAXONOMY_INVALID", "the taxonomy is not an object");
  }
  if (raw["formatVersion"] !== TAXONOMY_FORMAT_VERSION) {
    throw new DriverError(
      "TAXONOMY_INVALID",
      `the taxonomy formatVersion must be ${TAXONOMY_FORMAT_VERSION}`,
    );
  }
  const rawDomains = raw["domains"];
  if (!Array.isArray(rawDomains) || rawDomains.length !== 8) {
    throw new DriverError("TAXONOMY_INVALID", "the taxonomy must hold exactly 8 domains");
  }

  const domains: TaxonomyDomain[] = [];
  const domainIds = new Set<string>();
  const topicIds = new Set<string>();
  const topicDomains = new Map<string, string>();
  const titles = new Map<string, string>();
  let topicCount = 0;

  for (const [domainIndex, rawDomain] of rawDomains.entries()) {
    if (!isRecord(rawDomain)) {
      throw new DriverError("TAXONOMY_INVALID", "a domain is not an object");
    }
    const id = rawDomain["id"];
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id) || id.length > 80) {
      throw new DriverError("TAXONOMY_INVALID", "a domain id is invalid");
    }
    if (domainIds.has(id)) {
      throw new DriverError("TAXONOMY_INVALID", `domain id ${id} is repeated`);
    }
    domainIds.add(id);
    const title = requireText(rawDomain["title"], `domain ${id} title`, 160);
    titles.set(id, title);

    const rawTopics = rawDomain["topics"];
    if (!Array.isArray(rawTopics) || rawTopics.length === 0) {
      throw new DriverError("TAXONOMY_INVALID", `domain ${id} has no topics`);
    }
    const topics: TaxonomyTopic[] = [];
    for (const [topicIndex, rawTopic] of rawTopics.entries()) {
      if (!isRecord(rawTopic)) {
        throw new DriverError("TAXONOMY_INVALID", `domain ${id} has a non-object topic`);
      }
      const topicId = rawTopic["id"];
      if (
        typeof topicId !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(topicId) ||
        topicId.length > 80
      ) {
        throw new DriverError("TAXONOMY_INVALID", `domain ${id} has an invalid topic id`);
      }
      if (!topicId.startsWith(`${id}-`)) {
        throw new DriverError(
          "TAXONOMY_INVALID",
          `topic ${topicId} is not namespaced with its domain ${id}`,
        );
      }
      if (topicIds.has(topicId)) {
        throw new DriverError("TAXONOMY_INVALID", `topic id ${topicId} is repeated`);
      }
      topicIds.add(topicId);
      topicDomains.set(topicId, id);
      const topicTitle = requireText(rawTopic["title"], `topic ${topicId} title`, 160);
      titles.set(topicId, topicTitle);
      topics.push({ id: topicId, slug: String(rawTopic["slug"] ?? ""), title: topicTitle, order: topicIndex });
      topicCount += 1;
    }
    domains.push({ id, title, order: domainIndex, topics });
  }

  if (topicCount !== 36) {
    throw new DriverError("TAXONOMY_INVALID", `the taxonomy must hold exactly 36 topics, found ${topicCount}`);
  }
  return { domains, domainIds, topicDomains, titles, topicIds };
}

const C0_CONTROL = /[\u0000-\u0008\u000b-\u001f]/;

/**
 * A domain or topic carries its meaning either as a bare string (the owner's
 * approved file) or as `{ meaning }` (the design document's sample). Both are
 * read; neither is defaulted.
 */
function readMeaningNode(raw: Record<string, unknown>, label: string): string {
  if (!("meaning" in raw)) {
    throw new DriverError("PROSE_MISSING", `meaning is missing for ${label}`);
  }
  const value = raw["meaning"];
  if (typeof value !== "string") {
    throw new DriverError("PROSE_MISSING", `meaning is missing for ${label}`);
  }
  if (C0_CONTROL.test(value)) {
    throw new DriverError("PROSE_MEANING_CONTROL_CHARACTER", `meaning for ${label} holds a control character`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new DriverError("PROSE_MEANING_BLANK", `meaning for ${label} is blank`);
  }
  if (trimmed.length > 2000) {
    throw new DriverError("PROSE_MEANING_OVER_LIMIT", `meaning for ${label} exceeds 2000 characters`);
  }
  return trimmed;
}

function readMeaning(value: unknown, label: string): string {
  if (typeof value === "string") {
    if (C0_CONTROL.test(value)) {
      throw new DriverError("PROSE_MEANING_CONTROL_CHARACTER", `meaning for ${label} holds a control character`);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new DriverError("PROSE_MEANING_BLANK", `meaning for ${label} is blank`);
    }
    if (trimmed.length > 2000) {
      throw new DriverError("PROSE_MEANING_OVER_LIMIT", `meaning for ${label} exceeds 2000 characters`);
    }
    return trimmed;
  }
  if (!isRecord(value)) {
    throw new DriverError("PROSE_MISSING", `meaning is missing for ${label}`);
  }
  return readMeaningNode(value, label);
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new DriverError("PROSE_UNKNOWN_KEY", `${label} has an unknown key`);
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      throw new DriverError("PROSE_MISSING", `${label} is missing a required key`);
    }
  }
}

function requireIdentityString(
  value: unknown,
  label: string,
  pattern: RegExp,
  maximum: number,
): string {
  if (typeof value !== "string" || !pattern.test(value) || value.length > maximum) {
    throw new DriverError("PROSE_IDENTITY_INVALID", `${label} is not a valid value`);
  }
  return value;
}

/** Parses and cross-checks the owner-supplied prose file. */
export function parseProse(raw: unknown, taxonomy: TaxonomyDoc, taxonomySha256: string): Omit<ProseDoc, "sha256"> {
  if (!isRecord(raw)) {
    throw new DriverError("PROSE_INVALID_JSON", "the prose file is not an object");
  }
  requireExactKeys(
    raw,
    ["formatVersion", "certification", "examVersion", "domains", "topics"],
    "the prose file",
    ["note", "taxonomySha256"],
  );
  if (raw["formatVersion"] !== PROSE_FORMAT_VERSION) {
    throw new DriverError("PROSE_FORMAT_INVALID", `the prose formatVersion must be ${PROSE_FORMAT_VERSION}`);
  }
  if ("note" in raw && (typeof raw["note"] !== "string" || raw["note"].length > 2000)) {
    throw new DriverError("PROSE_IDENTITY_INVALID", "note must be a short string");
  }
  // The digest is the design's anti-drift binding, and it is required: a prose
  // file without one is prose that was never approved against any taxonomy, so
  // there is nothing to compare and nothing to trust. It is listed as an
  // optional key only so the key-set check still names an unknown key as
  // unknown; presence is asserted here with its own code, because "you forgot
  // the binding" and "no such field" are different failures.
  const digest = raw["taxonomySha256"];
  if (typeof digest !== "string" || digest.length === 0) {
    throw new DriverError(
      "PROSE_TAXONOMY_DIGEST_MISSING",
      "the prose file must carry taxonomySha256, the digest of the taxonomy file it was approved against",
    );
  }
  if (digest !== taxonomySha256) {
    throw new DriverError(
      "PROSE_TAXONOMY_DIGEST_MISMATCH",
      "the prose file was not approved for this taxonomy file",
    );
  }

  const certification = raw["certification"];
  if (!isRecord(certification)) {
    throw new DriverError("PROSE_IDENTITY_INVALID", "certification is not an object");
  }
  requireExactKeys(certification, ["slug", "displayName"], "certification", ["id"]);
  const identityId = certification["id"];
  const certificationIdentity = {
    id:
      identityId === undefined
        ? null
        : requireIdentityString(identityId, "certification.id", /^[a-zA-Z0-9:_-]{1,128}$/, 128),
    slug: requireIdentityString(certification["slug"], "certification.slug", /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 120),
    displayName: (() => {
      const value = certification["displayName"];
      if (typeof value !== "string" || value.trim().length === 0 || value.length > 160) {
        throw new DriverError("PROSE_IDENTITY_INVALID", "certification.displayName is not a valid value");
      }
      return value;
    })(),
  };

  const examVersion = raw["examVersion"];
  if (!isRecord(examVersion)) {
    throw new DriverError("PROSE_IDENTITY_INVALID", "examVersion is not an object");
  }
  requireExactKeys(examVersion, ["versionKey", "title", "syllabusReference"], "examVersion");
  const versionKey = requireIdentityString(
    examVersion["versionKey"],
    "examVersion.versionKey",
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/,
    80,
  );
  const title = examVersion["title"];
  const syllabusReference = examVersion["syllabusReference"];
  if (typeof title !== "string" || title.trim().length === 0 || title.trim().length > 160) {
    throw new DriverError("PROSE_IDENTITY_INVALID", "examVersion.title is not a valid value");
  }
  if (
    typeof syllabusReference !== "string" ||
    syllabusReference.trim().length === 0 ||
    syllabusReference.trim().length > 500
  ) {
    throw new DriverError("PROSE_IDENTITY_INVALID", "examVersion.syllabusReference is not a valid value");
  }

  const rawDomains = raw["domains"];
  const rawTopics = raw["topics"];
  if (!isRecord(rawDomains) || !isRecord(rawTopics)) {
    throw new DriverError("PROSE_MISSING", "domains and topics must be objects");
  }

  const domains = new Map<string, string>();
  for (const [key, value] of Object.entries(rawDomains)) {
    if (!taxonomy.domainIds.has(key)) {
      throw new DriverError("PROSE_DOMAIN_SET_MISMATCH", `unknown domain key ${key}`);
    }
    if (isRecord(value)) requireExactKeys(value, ["meaning"], `domain ${key}`);
    domains.set(key, readMeaning(value, `domain ${key}`));
  }
  for (const id of taxonomy.domainIds) {
    if (!domains.has(id)) {
      throw new DriverError("PROSE_DOMAIN_SET_MISMATCH", `domain ${id} has no approved meaning`);
    }
  }

  const topics = new Map<string, string>();
  for (const [key, value] of Object.entries(rawTopics)) {
    const owningDomain = taxonomy.topicDomains.get(key);
    if (owningDomain === undefined) {
      throw new DriverError("PROSE_TOPIC_SET_MISMATCH", `unknown topic key ${key}`);
    }
    if (isRecord(value)) requireExactKeys(value, ["meaning"], `topic ${key}`);
    topics.set(key, readMeaning(value, `topic ${key}`));
  }
  for (const id of taxonomy.topicIds) {
    if (!topics.has(id)) {
      throw new DriverError("PROSE_TOPIC_SET_MISMATCH", `topic ${id} has no approved meaning`);
    }
  }

  return {
    certification: certificationIdentity,
    examVersion: {
      versionKey,
      title: title.trim(),
      syllabusReference: syllabusReference.trim(),
    },
    domains,
    topics,
  };
}

function checkIntRange(value: string, minimum: number, maximum: number, column: string, rowNumber: number): void {
  const length = value.trim().length;
  if (length < minimum || length > maximum) {
    throw new DriverError("CSV_VALUE_INVALID", `row ${rowNumber} ${column}: length ${length} outside ${minimum}-${maximum}`);
  }
}

function validateRow(cells: string[], rowNumber: number, taxonomy: TaxonomyDoc, seen: Set<string>): SourceRow {
  if (cells.length !== QUESTION_IMPORT_COLUMNS.length) {
    throw new DriverError(
      "CSV_COLUMN_COUNT",
      `row ${rowNumber} has ${cells.length} columns, expected ${QUESTION_IMPORT_COLUMNS.length}`,
    );
  }
  if (cells[0] !== QUESTION_IMPORT_FORMAT) {
    throw new DriverError("CSV_VALUE_INVALID", `row ${rowNumber} format_version is not ${QUESTION_IMPORT_FORMAT}`);
  }
  const key = cells[1] ?? "";
  if (!QUESTION_KEY_PATTERN.test(key)) {
    throw new DriverError("QUESTION_KEY_INVALID", `row ${rowNumber} question_key does not match the approved pattern`);
  }
  if (seen.has(key)) {
    throw new DriverError("DUPLICATE_QUESTION_KEY", `row ${rowNumber} repeats question_key ${key}`);
  }
  seen.add(key);

  if (!["easy", "medium", "hard"].includes(cells[6] ?? "")) {
    throw new DriverError("CSV_VALUE_INVALID", `row ${rowNumber} difficulty is not easy, medium or hard`);
  }
  checkIntRange(cells[5] ?? "", LIMITS.stem.minimum, LIMITS.stem.maximum, "stem", rowNumber);
  checkIntRange(cells[7] ?? "", LIMITS.sourceReference.minimum, LIMITS.sourceReference.maximum, "source_reference", rowNumber);
  checkIntRange(cells[8] ?? "", LIMITS.licenseReference.minimum, LIMITS.licenseReference.maximum, "license_reference", rowNumber);

  let correctCount = 0;
  for (let option = 1; option <= OPTION_SLOTS; option += 1) {
    const index = optionColumnIndices(option);
    const optionKey = cells[index.key] ?? "";
    const optionText = cells[index.text] ?? "";
    const correct = cells[index.correct] ?? "";
    const explanation = cells[index.explanation] ?? "";
    if (option <= OPTION_COUNT) {
      checkIntRange(optionKey, LIMITS.optionKey.minimum, LIMITS.optionKey.maximum, `option_${option}_key`, rowNumber);
      checkIntRange(optionText, LIMITS.optionText.minimum, LIMITS.optionText.maximum, `option_${option}_text`, rowNumber);
      checkIntRange(explanation, LIMITS.explanation.minimum, LIMITS.explanation.maximum, `option_${option}_explanation`, rowNumber);
      if (correct !== "true" && correct !== "false") {
        throw new DriverError("CSV_VALUE_INVALID", `row ${rowNumber} option_${option}_correct is not true or false`);
      }
      if (correct === "true") correctCount += 1;
    } else if (optionKey !== "" || optionText !== "" || correct !== "" || explanation !== "") {
      throw new DriverError("CSV_VALUE_INVALID", `row ${rowNumber} option_${option} must be empty`);
    }
  }
  if (correctCount !== 1) {
    throw new DriverError("CSV_VALUE_INVALID", `row ${rowNumber} has ${correctCount} correct options`);
  }

  const domainKey = cells[3] ?? "";
  const topicKey = cells[4] ?? "";
  if (domainKey === "" || !taxonomy.domainIds.has(domainKey)) {
    throw new DriverError("UNKNOWN_TAXONOMY_ID", `row ${rowNumber} domain_id is not in the taxonomy`);
  }
  if (topicKey === "" || !taxonomy.topicIds.has(topicKey)) {
    throw new DriverError("UNKNOWN_TAXONOMY_ID", `row ${rowNumber} topic_id is not in the taxonomy`);
  }
  if (taxonomy.topicDomains.get(topicKey) !== domainKey) {
    throw new DriverError("UNKNOWN_TAXONOMY_ID", `row ${rowNumber} topic_id does not belong to domain_id`);
  }
  if ((cells[2] ?? "").trim().length === 0) {
    throw new DriverError("CSV_VALUE_INVALID", `row ${rowNumber} exam_version_id is empty`);
  }

  return { position: rowNumber, key, domainKey, topicKey, cells };
}

interface ManifestBatch {
  file: string;
  rows: number;
  sha256: string;
}

function readManifestBatch(raw: unknown): ManifestBatch {
  if (!isRecord(raw)) {
    throw new DriverError("CONVERTER_MANIFEST_INVALID", "a manifest batch is not an object");
  }
  const file = raw["file"];
  const rows = raw["rows"];
  const digest = raw["sha256"];
  if (
    typeof file !== "string" ||
    file.length === 0 ||
    basename(file) !== file ||
    typeof rows !== "number" ||
    !Number.isInteger(rows) ||
    rows < 0 ||
    typeof digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(digest)
  ) {
    throw new DriverError("CONVERTER_MANIFEST_INVALID", "a manifest batch entry is invalid");
  }
  return { file, rows, sha256: digest };
}

/** Reads the converter's output directory read-only and validates every row. */
export function readConverterOutput(batchesDir: string, taxonomy: TaxonomyDoc): ConverterBundle {
  const manifestPath = join(batchesDir, "manifest.json");
  const manifestFile = readJsonFile(
    manifestPath,
    "CONVERTER_MANIFEST_UNREADABLE",
    "CONVERTER_MANIFEST_INVALID",
  );
  const manifest = manifestFile.value;
  if (!isRecord(manifest)) {
    throw new DriverError("CONVERTER_MANIFEST_INVALID", "the converter manifest is not an object");
  }
  if (manifest["formatVersion"] !== CONVERTER_MANIFEST_FORMAT_VERSION) {
    throw new DriverError(
      "CONVERTER_MANIFEST_INVALID",
      `the converter manifest formatVersion must be ${CONVERTER_MANIFEST_FORMAT_VERSION}`,
    );
  }
  const rawBatches = manifest["batches"];
  if (!Array.isArray(rawBatches) || rawBatches.length === 0) {
    throw new DriverError("CONVERTER_MANIFEST_INVALID", "the converter manifest lists no batches");
  }
  const batches = rawBatches.map(readManifestBatch);

  const rows: SourceRow[] = [];
  const seen = new Set<string>();
  let declared: string | null = null;

  for (const batch of batches) {
    const path = join(batchesDir, batch.file);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new DriverError("CONVERTER_FILE_MISSING", `${batch.file} is listed in the manifest but missing`);
    }
    const bytes = readFileSync(path);
    if (sha256(bytes) !== batch.sha256) {
      throw new DriverError("CONVERTER_DIGEST_MISMATCH", `${batch.file} does not match its manifest digest`);
    }
    let text: string;
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw new DriverError(
        "CSV_HEADER_MISMATCH",
        `${batch.file} starts with a byte-order mark the converter never writes`,
      );
    }
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new DriverError("CSV_NOT_UTF8", `${batch.file} is not valid UTF-8`);
    }
    const records = parseCsv(text);
    if (records.length === 0) {
      throw new DriverError("CSV_HEADER_MISMATCH", `${batch.file} is empty`);
    }
    const header = records[0] ?? [];
    if (
      header.length !== QUESTION_IMPORT_COLUMNS.length ||
      header.some((cell, index) => cell !== QUESTION_IMPORT_COLUMNS[index])
    ) {
      throw new DriverError("CSV_HEADER_MISMATCH", `${batch.file} does not carry the 41-column contract header`);
    }
    const dataRows = records.slice(1);
    if (dataRows.length !== batch.rows) {
      throw new DriverError(
        "CONVERTER_COUNT_MISMATCH",
        `${batch.file} holds ${dataRows.length} rows but the manifest says ${batch.rows}`,
      );
    }
    if (dataRows.length > QUESTION_IMPORT_MAX_ROWS) {
      throw new DriverError(
        "CONVERTER_COUNT_MISMATCH",
        `${batch.file} holds ${dataRows.length} rows; the converter caps a batch at ${QUESTION_IMPORT_MAX_ROWS}`,
      );
    }
    for (const cells of dataRows) {
      const row = validateRow(cells, rows.length + 1, taxonomy, seen);
      if (declared === null) declared = cells[2] ?? "";
      else if ((cells[2] ?? "") !== declared) {
        throw new DriverError(
          "CSV_VALUE_INVALID",
          `row ${row.position} declares a different exam_version_id than the earlier rows`,
        );
      }
      rows.push(row);
    }
  }

  if (rows.length === 0) {
    throw new DriverError("CONVERTER_COUNT_MISMATCH", "the converter output holds no rows");
  }
  const counts = manifest["counts"];
  if (!isRecord(counts) || typeof counts["written"] !== "number" || counts["written"] !== rows.length) {
    throw new DriverError("CONVERTER_COUNT_MISMATCH", "the manifest written count does not match the parsed rows");
  }

  return {
    manifestSha256: sha256(manifestFile.text),
    declaredExamVersionId: declared ?? "",
    rows,
    batchCount: batches.length,
  };
}

/**
 * Cross-checks the converter's own taxonomy report. `writtenQuestions` is what
 * the converter actually wrote; a mismatch with the CSVs means the two files
 * did not come from one run.
 */
export function crossCheckTaxonomyReport(batchesDir: string, rows: readonly SourceRow[]): void {
  const path = join(batchesDir, "taxonomy-report.json");
  const report = readJsonFile(path, "TAXONOMY_REPORT_UNREADABLE", "TAXONOMY_REPORT_UNREADABLE").value;
  if (!isRecord(report) || report["formatVersion"] !== TAXONOMY_REPORT_FORMAT_VERSION) {
    throw new DriverError("TAXONOMY_REPORT_UNREADABLE", "taxonomy-report.json has an unexpected format");
  }
  const rawDomains = report["domains"];
  if (!Array.isArray(rawDomains)) {
    throw new DriverError("TAXONOMY_REPORT_UNREADABLE", "taxonomy-report.json lists no domains");
  }
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.topicKey, (counts.get(row.topicKey) ?? 0) + 1);
  }
  const reported = new Set<string>();
  for (const domain of rawDomains) {
    if (!isRecord(domain) || !Array.isArray(domain["topics"])) {
      throw new DriverError("TAXONOMY_REPORT_UNREADABLE", "taxonomy-report.json is malformed");
    }
    for (const topic of domain["topics"]) {
      if (!isRecord(topic) || typeof topic["id"] !== "string" || typeof topic["writtenQuestions"] !== "number") {
        throw new DriverError("TAXONOMY_REPORT_UNREADABLE", "taxonomy-report.json is malformed");
      }
      reported.add(topic["id"]);
      const observed = counts.get(topic["id"]) ?? 0;
      if (observed !== topic["writtenQuestions"]) {
        throw new DriverError(
          "TAXONOMY_REPORT_MISMATCH",
          `topic ${topic["id"]} has ${observed} CSV rows but the report says ${topic["writtenQuestions"]}`,
        );
      }
    }
  }
  for (const key of counts.keys()) {
    if (!reported.has(key)) {
      throw new DriverError("TAXONOMY_REPORT_MISMATCH", `topic ${key} is absent from taxonomy-report.json`);
    }
  }
  for (const id of reported) {
    if (!counts.has(id)) {
      const topicReport = findTopicWritten(report, id);
      if (topicReport !== 0) {
        throw new DriverError("TAXONOMY_REPORT_MISMATCH", `topic ${id} is absent from the CSV output`);
      }
    }
  }
}

function findTopicWritten(report: Record<string, unknown>, topicId: string): number {
  for (const domain of report["domains"] as unknown[]) {
    if (!isRecord(domain) || !Array.isArray(domain["topics"])) continue;
    for (const topic of domain["topics"] as unknown[]) {
      if (isRecord(topic) && topic["id"] === topicId && typeof topic["writtenQuestions"] === "number") {
        return topic["writtenQuestions"];
      }
    }
  }
  return -1;
}

/** Stage 0 in one call: every input, every row, no network. */
export function validateInputs(paths: InputPaths): ValidatedInputs {
  const taxonomyFile = readJsonFile(paths.taxonomyPath, "TAXONOMY_UNREADABLE", "TAXONOMY_INVALID");
  const taxonomySha256 = sha256(taxonomyFile.text);
  const taxonomy = parseTaxonomy(taxonomyFile.value);

  const proseFile = readJsonFile(paths.prosePath, "PROSE_UNREADABLE", "PROSE_INVALID_JSON");
  const proseSha256 = sha256(proseFile.text);
  const prose = parseProse(proseFile.value, taxonomy, taxonomySha256);

  const converter = readConverterOutput(paths.batchesDir, taxonomy);
  crossCheckTaxonomyReport(paths.batchesDir, converter.rows);

  return {
    taxonomy,
    prose: { ...prose, sha256: proseSha256 },
    rows: converter.rows,
    converterManifestSha256: converter.manifestSha256,
    declaredExamVersionId: converter.declaredExamVersionId,
    taxonomySha256,
    proseSha256,
    batchCount: converter.batchCount,
  };
}
