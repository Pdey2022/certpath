import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeDistribution } from "./checks/distribution.ts";
import { runSimilarityChecks } from "./checks/similarity.ts";
import { runStructureChecks } from "./checks/structure.ts";
import { combineVerdict } from "./combine.ts";
import { REPORT_FORMAT_VERSION } from "./contract.ts";
import { QuestionCheckError, describeError, refusalExitCode } from "./errors.ts";
import { listBatchFiles, parseBatch, readBatchFile, type Item, type LoadedBatch } from "./parse.ts";
import { assertOutsideRepository, reportPath } from "./paths.ts";
import { loadProfile, type QuestionProfile } from "./profile.ts";
import {
  REPORT_JSON_NAME,
  clearReportFiles,
  sortFindings,
  writeReportFiles,
  type Finding,
  type Report,
  type ReportInputFile,
  type ReportVerdict,
  type Suppression,
} from "./report.ts";
import { assertDomainSetsMatch, loadTaxonomy, taxonomyIndex, type Taxonomy } from "./taxonomy.ts";

/**
 * `question-check` — the deterministic validator behind PROF.
 *
 * No network, no credential, no database. It reads 41-column batches that live
 * outside the repository and writes a report that also lives outside it.
 */

export type Verb = "check" | "combine" | "taxonomy";

export interface SuppressionArgument {
  code: string;
  reason: string;
  approvedBy: string;
}

export interface CheckArgs {
  verb: "check";
  batches: string;
  profile: string;
  taxonomy: string;
  out: string;
  importedKeys: string | null;
  mode: "partial" | "complete";
  format: "json" | "markdown" | "both";
  redact: boolean;
  force: boolean;
  strictWarnings: boolean;
  suppressions: SuppressionArgument[];
}

export interface CombineArgs {
  verb: "combine";
  report: string;
  findings: string;
  out: string;
}

export interface TaxonomyArgs {
  verb: "taxonomy";
  taxonomy: string;
  profile: string;
  out: string | null;
}

export type ParsedArgs =
  | { help: true }
  | { help: false; args: CheckArgs | CombineArgs | TaxonomyArgs };

const HELP_TEXT = `Usage:
  tsx tools/question-check/cli.ts check
    --batches <dir> --profile <file> --taxonomy <file> --out <dir>
    [--imported-keys <file>] [--mode partial|complete]
    [--format json|markdown|both] [--redact] [--force] [--strict-warnings]
    [--suppress <code> --reason <text> --approved-by owner]

  tsx tools/question-check/cli.ts combine
    --report <file> --findings <file> --out <dir>

  tsx tools/question-check/cli.ts taxonomy --taxonomy <file> --profile <file> [--out <dir>]

  tsx tools/question-check/cli.ts --help

check judges a directory of 41-column CSV batches against a committed profile
and taxonomy. --batches, --imported-keys, --report, --findings and --out must
resolve outside the repository; --profile and --taxonomy are the committed
schema files.

Exit codes: 0 pass or pass_with_findings, 1 fail, 2 refused (nothing was
judged), 3 incomplete (the tool failed after judging began).

A report is not an approval. Only the owner signs off content.`;

const NEVER_SUPPRESSIBLE: ReadonlySet<string> = new Set([
  "CSV_BOM",
  "CSV_NOT_UTF8",
  "CSV_UNPARSEABLE",
  "HEADER_MISMATCH",
  "ROW_CELL_COUNT",
  "BATCH_ROW_LIMIT",
  "BATCH_BYTES",
  "FORMAT_VERSION",
  "FIELD_REQUIRED",
  "FIELD_CAP",
  "QUESTION_KEY_INVALID",
  "DUPLICATE_QUESTION_KEY",
  "KEY_ALREADY_IMPORTED",
  "OPTION_COUNT",
  "OPTION_SLOT_GAP",
  "OPTION_KEY_DUPLICATE",
  "CORRECT_FLAG_NOT_BOOLEAN",
  "CORRECT_OPTION_COUNT",
  "EXPLANATION_MISSING",
  "EXPLANATION_COPY",
  "DIFFICULTY_INVALID",
  "EXAM_VERSION_MISMATCH",
  "UNKNOWN_DOMAIN_KEY",
  "UNKNOWN_TOPIC_KEY",
  "DOMAIN_TOPIC_MISMATCH",
  "STEM_DUPLICATE",
  "ANSWER_POSITION_MONOTONE",
  "ANSWER_POSITION_BIASED",
  "DOMAIN_MISSING",
]);

const WARNING_CODES: ReadonlySet<string> = new Set([
  "DOMAIN_WEIGHT_DEVIATION",
  "DOMAIN_UNDER_TARGET",
  "DOMAIN_OVER_TARGET",
  "BANK_VOLUME_SHORTFALL",
  "ANSWER_POSITION_SKEW",
  "DIFFICULTY_TARGET_UNSET",
  "DIFFICULTY_CONCENTRATION",
  "DIFFICULTY_DEVIATION",
  "TOPIC_CONCENTRATION",
  "TOPIC_UNASSIGNED",
  "STEM_NEAR_DUPLICATE",
  "STEM_LENGTH_OUTLIER",
  "OPTION_LENGTH_OUTLIER",
  "CORRECT_OPTION_LONGEST_PATTERN",
  "EXPLANATION_THIN",
  "EXPLANATION_LETTER_REFERENCE",
  "STEM_NUMBER_INCONSISTENT",
]);

export function isKnownFindingCode(code: string): boolean {
  return NEVER_SUPPRESSIBLE.has(code) || WARNING_CODES.has(code);
}

/**
 * `DOMAIN_WEIGHT_DEVIATION` is an error in complete mode and a warning in
 * partial mode, so it is not statically unsuppressible. A suppression that
 * meets an error is refused after the run, never silently applied.
 */
export function isNeverSuppressible(code: string): boolean {
  return NEVER_SUPPRESSIBLE.has(code);
}

const CHECK_VALUE_FLAGS = new Set([
  "--batches",
  "--profile",
  "--taxonomy",
  "--out",
  "--imported-keys",
  "--mode",
  "--format",
]);

const CHECK_BOOLEAN_FLAGS = new Set(["--redact", "--force", "--strict-warnings", "--help"]);
const REPEATABLE_FLAGS = new Set(["--suppress", "--reason", "--approved-by"]);

const COMBINE_VALUE_FLAGS = new Set(["--report", "--findings", "--out"]);
const COMBINE_BOOLEAN_FLAGS = new Set(["--help"]);

const TAXONOMY_VALUE_FLAGS = new Set(["--taxonomy", "--profile", "--out"]);
const TAXONOMY_BOOLEAN_FLAGS = new Set(["--help"]);

function requireValue(
  argv: readonly string[],
  index: number,
  flag: string,
  { allowBlank = false }: { allowBlank?: boolean } = {},
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new QuestionCheckError("MISSING_ARGUMENT", `${flag} requires a value`);
  }
  if (!allowBlank && value.trim().length === 0) {
    throw new QuestionCheckError("MISSING_ARGUMENT", `${flag} requires a value`);
  }
  return value;
}

interface RawArguments {
  values: Map<string, string>;
  repeated: Map<string, string[]>;
  flags: Set<string>;
}

function collect(
  argv: readonly string[],
  valueFlags: ReadonlySet<string>,
  booleanFlags: ReadonlySet<string>,
): RawArguments {
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      throw new QuestionCheckError("UNKNOWN_ARGUMENT", "positional arguments are not accepted");
    }
    if (booleanFlags.has(argument)) {
      if (flags.has(argument)) {
        throw new QuestionCheckError("DUPLICATE_ARGUMENT", `${argument} was supplied twice`);
      }
      flags.add(argument);
      continue;
    }
    if (REPEATABLE_FLAGS.has(argument)) {
      const list = repeated.get(argument) ?? [];
      list.push(requireValue(argv, index, argument, { allowBlank: argument === "--reason" }));
      repeated.set(argument, list);
      index += 1;
      continue;
    }
    if (!valueFlags.has(argument)) {
      throw new QuestionCheckError("UNKNOWN_ARGUMENT", `unknown flag ${argument}`);
    }
    if (values.has(argument)) {
      throw new QuestionCheckError("DUPLICATE_ARGUMENT", `${argument} was supplied twice`);
    }
    values.set(argument, requireValue(argv, index, argument));
    index += 1;
  }
  return { values, repeated, flags };
}

function required(map: Map<string, string>, flag: string): string {
  const value = map.get(flag);
  if (value === undefined) {
    throw new QuestionCheckError("MISSING_ARGUMENT", `${flag} is required`);
  }
  return value;
}

function pairSuppressions(raw: RawArguments): SuppressionArgument[] {
  const codes = raw.repeated.get("--suppress") ?? [];
  const reasons = raw.repeated.get("--reason") ?? [];
  const approvers = raw.repeated.get("--approved-by") ?? [];
  if (codes.length === 0) {
    if (reasons.length > 0 || approvers.length > 0) {
      throw new QuestionCheckError("MISSING_ARGUMENT", "--reason and --approved-by accompany --suppress");
    }
    return [];
  }
  if (reasons.length !== codes.length) {
    throw new QuestionCheckError(
      "SUPPRESSION_UNJUSTIFIED",
      "a suppression without a reason is refused",
      { info: { code: codes[codes.length - 1] ?? null } },
    );
  }
  if (approvers.length !== codes.length) {
    throw new QuestionCheckError(
      "MISSING_ARGUMENT",
      "each --suppress needs exactly one --approved-by, in the same order",
    );
  }
  return codes.map((code, index) => {
    const reason = (reasons[index] ?? "").trim();
    const approvedBy = (approvers[index] ?? "").trim();
    if (!isKnownFindingCode(code)) {
      throw new QuestionCheckError("INVALID_ARGUMENT", "--suppress names a code the tool does not emit", {
        info: { code },
      });
    }
    if (isNeverSuppressible(code)) {
      throw new QuestionCheckError("CANNOT_SUPPRESS_ERROR", "an error cannot be suppressed", {
        info: { code },
      });
    }
    if (reason.length === 0) {
      throw new QuestionCheckError("SUPPRESSION_UNJUSTIFIED", "a suppression needs a reason", {
        info: { code },
      });
    }
    if (approvedBy !== "owner") {
      throw new QuestionCheckError("INVALID_ARGUMENT", "--approved-by must be the literal owner", {
        info: { code },
      });
    }
    return { code, reason, approvedBy };
  });
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new QuestionCheckError("MISSING_ARGUMENT", "a verb is required: check, combine or taxonomy");
  }
  if (argv[0] === "--help" || argv[0] === "-h") return { help: true };
  const verb = argv[0]!;
  const rest = argv.slice(1);

  if (verb === "check") {
    const raw = collect(rest, CHECK_VALUE_FLAGS, CHECK_BOOLEAN_FLAGS);
    if (raw.flags.has("--help")) return { help: true };
    const mode = raw.values.get("--mode") ?? "partial";
    if (mode !== "partial" && mode !== "complete") {
      throw new QuestionCheckError("INVALID_ARGUMENT", "--mode must be partial or complete");
    }
    const format = raw.values.get("--format") ?? "both";
    if (format !== "json" && format !== "markdown" && format !== "both") {
      throw new QuestionCheckError("INVALID_ARGUMENT", "--format must be json, markdown or both");
    }
    const importedKeys = raw.values.get("--imported-keys");
    return {
      help: false,
      args: {
        verb: "check",
        batches: resolve(required(raw.values, "--batches")),
        profile: resolve(required(raw.values, "--profile")),
        taxonomy: resolve(required(raw.values, "--taxonomy")),
        out: resolve(required(raw.values, "--out")),
        importedKeys: importedKeys === undefined ? null : resolve(importedKeys),
        mode,
        format,
        redact: raw.flags.has("--redact"),
        force: raw.flags.has("--force"),
        strictWarnings: raw.flags.has("--strict-warnings"),
        suppressions: pairSuppressions(raw),
      },
    };
  }

  if (verb === "combine") {
    const raw = collect(rest, COMBINE_VALUE_FLAGS, COMBINE_BOOLEAN_FLAGS);
    if (raw.flags.has("--help")) return { help: true };
    return {
      help: false,
      args: {
        verb: "combine",
        report: resolve(required(raw.values, "--report")),
        findings: resolve(required(raw.values, "--findings")),
        out: resolve(required(raw.values, "--out")),
      },
    };
  }

  if (verb === "taxonomy") {
    const raw = collect(rest, TAXONOMY_VALUE_FLAGS, TAXONOMY_BOOLEAN_FLAGS);
    if (raw.flags.has("--help")) return { help: true };
    const out = raw.values.get("--out");
    return {
      help: false,
      args: {
        verb: "taxonomy",
        taxonomy: resolve(required(raw.values, "--taxonomy")),
        profile: resolve(required(raw.values, "--profile")),
        out: out === undefined ? null : resolve(out),
      },
    };
  }

  throw new QuestionCheckError("UNKNOWN_VERB", "the verb must be check, combine or taxonomy", {
    info: { verb },
  });
}

export interface MainOptions {
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  repoRoot?: string;
}

export function defaultRepositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function readTextFile(
  path: string,
  unreadable: "PROFILE_UNREADABLE" | "TAXONOMY_UNREADABLE" | "FINDINGS_UNREADABLE",
  what: string,
): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new QuestionCheckError(unreadable, `the ${what} could not be read`);
  }
}

export function readProfile(path: string): QuestionProfile {
  return loadProfile(readTextFile(path, "PROFILE_UNREADABLE", "profile"));
}

export function readTaxonomy(path: string, requireProse: boolean): Taxonomy {
  return loadTaxonomy(readTextFile(path, "TAXONOMY_UNREADABLE", "taxonomy"), { requireProse });
}

function directoryHasEntries(path: string): boolean {
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

/** `--out` must be absent or empty; `--force` blanks the previous report first. */
function prepareOutDirectory(outDir: string, force: boolean): void {
  if (existsSync(outDir)) {
    if (!statSync(outDir).isDirectory()) {
      throw new QuestionCheckError("OUT_NOT_EMPTY", "--out must be a directory");
    }
    if (directoryHasEntries(outDir)) {
      if (!force) {
        throw new QuestionCheckError(
          "OUT_NOT_EMPTY",
          "--out must be absent or empty; use --force to replace the previous report",
        );
      }
      clearReportFiles(outDir);
    }
    return;
  }
  if (!existsSync(dirname(outDir))) {
    throw new QuestionCheckError("OUT_NOT_EMPTY", "--out's parent directory does not exist");
  }
}

function sha256Bytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path: string): string {
  try {
    return sha256Bytes(readFileSync(path));
  } catch {
    return "";
  }
}

export interface BuildReportInput {
  mode: "partial" | "complete";
  inputs: Report["inputs"];
  batches: readonly LoadedBatch[];
  findings: readonly Finding[];
  suppressions: readonly Suppression[];
  distribution: ReturnType<typeof computeDistribution>;
  strictWarnings: boolean;
}

export function buildReport(input: BuildReportInput): Report {
  const warnings = input.findings.filter((finding) => finding.severity === "warning");
  const errors = input.findings.filter((finding) => finding.severity === "error");
  const verdict: ReportVerdict =
    errors.length > 0
      ? "fail"
      : warnings.length > 0
        ? input.strictWarnings
          ? "fail"
          : "pass_with_findings"
        : "pass";
  const included = input.batches.filter((batch) => batch.included);
  const touched = (severity: "error" | "warning") =>
    new Set(
      input.findings
        .filter((finding) => finding.severity === severity && finding.scope.row !== null)
        .map((finding) => `${finding.scope.file ?? ""}#${finding.scope.row ?? 0}`),
    );
  return {
    formatVersion: REPORT_FORMAT_VERSION,
    advisoryOnly: true,
    approvalGranted: null,
    mode: input.mode,
    inputs: input.inputs,
    totals: {
      batches: input.batches.length,
      filesExcluded: input.batches.length - included.length,
      rows: included.reduce((sum, batch) => sum + batch.rows, 0),
      itemsWithErrors: touched("error").size,
      itemsWithWarnings: touched("warning").size,
    },
    byDomain: input.distribution.byDomain,
    byDifficulty: input.distribution.byDifficulty,
    byTopic: input.distribution.byTopic,
    answerPosition: input.distribution.answerPosition,
    coverage: input.distribution.coverage,
    findings: sortFindings(input.findings),
    suppressions: [...input.suppressions].sort(
      (left, right) =>
        left.code.localeCompare(right.code) ||
        (left.questionKey ?? "").localeCompare(right.questionKey ?? ""),
    ),
    verdict,
  };
}

export function applySuppressions(
  findings: readonly Finding[],
  suppressions: readonly SuppressionArgument[],
): { findings: Finding[]; suppressions: Suppression[] } {
  const remaining: Finding[] = [];
  const recorded: Suppression[] = [];
  const byCode = new Map(suppressions.map((entry) => [entry.code, entry]));
  for (const finding of findings) {
    const suppression = byCode.get(finding.code);
    if (suppression === undefined) {
      remaining.push(finding);
      continue;
    }
    if (finding.severity === "error") {
      throw new QuestionCheckError("CANNOT_SUPPRESS_ERROR", "an error cannot be suppressed", {
        info: { code: finding.code },
      });
    }
    recorded.push({
      code: suppression.code,
      questionKey: finding.scope.questionKey,
      reason: suppression.reason,
      approvedBy: suppression.approvedBy,
    });
  }
  for (const suppression of suppressions) {
    if (!recorded.some((entry) => entry.code === suppression.code)) {
      // A suppression that matched nothing is still recorded: an ineffective
      // suppression is evidence, not a silent no-op.
      recorded.push({
        code: suppression.code,
        questionKey: null,
        reason: suppression.reason,
        approvedBy: suppression.approvedBy,
      });
    }
  }
  return { findings: remaining, suppressions: recorded };
}

export interface CheckOutcome {
  exitCode: number;
  report: Report;
}

export function runCheck(args: CheckArgs, repoRoot: string): CheckOutcome {
  assertOutsideRepository(args.batches, repoRoot, "INPUT_INSIDE_REPOSITORY");
  if (args.importedKeys !== null) {
    assertOutsideRepository(args.importedKeys, repoRoot, "INPUT_INSIDE_REPOSITORY");
  }
  assertOutsideRepository(args.out, repoRoot, "OUT_INSIDE_REPOSITORY");
  prepareOutDirectory(args.out, args.force);

  const profile = readProfile(args.profile);
  const taxonomy = readTaxonomy(args.taxonomy, false);
  assertDomainSetsMatch(profile, taxonomy);

  let importedKeys = new Set<string>();
  let importedKeysInput: Report["inputs"]["importedKeys"] = null;
  if (args.importedKeys !== null) {
    let text: string;
    try {
      text = readFileSync(args.importedKeys, "utf8");
    } catch {
      throw new QuestionCheckError("IMPORTED_KEYS_UNREADABLE", "the imported-keys file could not be read");
    }
    const keys = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    importedKeys = new Set(keys);
    importedKeysInput = {
      path: reportPath(args.importedKeys, repoRoot),
      sha256: sha256Bytes(Buffer.from(text, "utf8")),
      count: keys.length,
    };
  }

  let files: string[];
  try {
    files = listBatchFiles(args.batches);
  } catch {
    throw new QuestionCheckError("BATCHES_UNREADABLE", "--batches is not a readable directory");
  }
  if (files.length === 0) {
    throw new QuestionCheckError("BATCHES_EMPTY", "--batches holds no .csv files");
  }

  const batches: LoadedBatch[] = [];
  const parseFindings: Finding[] = [];
  for (const file of files) {
    let buffer: Buffer;
    try {
      buffer = readBatchFile(args.batches, file);
    } catch {
      throw new QuestionCheckError("IO_FAILED", "a batch file could not be read", { info: { file } });
    }
    const parsed = parseBatch(file, buffer, profile.optionCount);
    batches.push(parsed.batch);
    parseFindings.push(...parsed.findings);
  }
  const items: Item[] = batches.flatMap((batch) => batch.items);

  const context = {
    profile,
    index: taxonomyIndex(taxonomy),
    importedKeys,
    questionKeyPattern: new RegExp(profile.questionKeyPattern),
  };
  const structureFindings = runStructureChecks(items, context);
  const similarityFindings = runSimilarityChecks(items, profile.nearDuplicate);
  const distribution = computeDistribution(items, profile, args.mode);

  const allFindings = [
    ...parseFindings,
    ...structureFindings,
    ...similarityFindings,
    ...distribution.findings,
  ];
  const suppressed = applySuppressions(allFindings, args.suppressions);
  const finalFindings = args.redact ? suppressed.findings.map(stripExcerpt) : suppressed.findings;

  const inputs: Report["inputs"] = {
    profile: { path: reportPath(args.profile, repoRoot), sha256: sha256File(args.profile) },
    taxonomy: { path: reportPath(args.taxonomy, repoRoot), sha256: sha256File(args.taxonomy) },
    batches: batches.map<ReportInputFile>((batch) => ({
      file: batch.file,
      sha256: batch.sha256,
      rows: batch.rows,
      included: batch.included,
      excludedReason: batch.excludedReason,
    })),
    importedKeys: importedKeysInput,
  };

  const report = buildReport({
    mode: args.mode,
    inputs,
    batches,
    findings: finalFindings,
    suppressions: suppressed.suppressions,
    distribution,
    strictWarnings: args.strictWarnings,
  });
  writeReportFiles(args.out, report, { format: args.format });
  return { exitCode: report.verdict === "fail" ? 1 : 0, report };
}

function stripExcerpt(finding: Finding): Finding {
  if (!("excerpt" in finding.evidence)) return finding;
  const evidence = { ...finding.evidence };
  delete evidence.excerpt;
  return { ...finding, evidence };
}

/** The taxonomy verb writes structure only; it never copies a title or meaning. */
export function runTaxonomy(args: TaxonomyArgs, repoRoot: string): number {
  // `--taxonomy` is the committed schema file and lives inside the repository by
  // design; only the artefact directory must stay outside it.
  if (args.out !== null) assertOutsideRepository(args.out, repoRoot, "OUT_INSIDE_REPOSITORY");
  const profile = readProfile(args.profile);
  const taxonomy = readTaxonomy(args.taxonomy, true);
  assertDomainSetsMatch(profile, taxonomy);
  if (args.out !== null) {
    writeJsonAtomically(join(args.out, "question-check-taxonomy-report.json"), {
      formatVersion: "certpath-question-taxonomy-report-v1",
      advisoryOnly: true,
      approvalGranted: null,
      verdict: "pass",
      domains: taxonomy.domains.map((domain) => ({
        id: domain.id,
        topics: domain.topics.map((topic) => topic.id),
      })),
    });
  }
  return 0;
}

function writeJsonAtomically(path: string, body: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  writeFileSync(partial, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  renameSync(partial, path);
}

export function runCombine(args: CombineArgs, repoRoot: string, stdout: NodeJS.WriteStream): number {
  assertOutsideRepository(args.report, repoRoot, "INPUT_INSIDE_REPOSITORY");
  assertOutsideRepository(args.findings, repoRoot, "INPUT_INSIDE_REPOSITORY");
  assertOutsideRepository(args.out, repoRoot, "OUT_INSIDE_REPOSITORY");

  let reportBytes: Buffer;
  try {
    reportBytes = readFileSync(args.report);
  } catch {
    throw new QuestionCheckError("REPORT_UNREADABLE", "the report could not be read");
  }
  let reportRaw: unknown;
  try {
    reportRaw = JSON.parse(reportBytes.toString("utf8"));
  } catch {
    throw new QuestionCheckError("REPORT_INVALID_JSON", "the report is not valid JSON");
  }
  const findingsText = readTextFile(args.findings, "FINDINGS_UNREADABLE", "findings file");
  let findingsRaw: unknown;
  try {
    findingsRaw = JSON.parse(findingsText);
  } catch {
    throw new QuestionCheckError("FINDINGS_INVALID_JSON", "the findings file is not valid JSON");
  }
  const result = combineVerdict(reportRaw, findingsRaw, sha256Bytes(reportBytes));
  writeJsonAtomically(join(args.out, "question-review-verdict.json"), result.output);
  stdout.write(
    `question-check: combined verdict=${result.output.verdict} ` +
      `blockedBy=${result.output.blockedBy.join(",") || "none"}\n`,
  );
  return result.exitCode;
}

export async function main(argv: readonly string[], overrides: MainOptions = {}): Promise<number> {
  const stdout = overrides.stdout ?? process.stdout;
  const stderr = overrides.stderr ?? process.stderr;
  const repoRoot = overrides.repoRoot ?? defaultRepositoryRoot();
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    stderr.write(`question-check: ${describeError(error)}\n`);
    return refusalExitCode(error);
  }
  if (parsed.help) {
    stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }
  try {
    const args = parsed.args;
    if (args.verb === "check") {
      const outcome = runCheck(args, repoRoot);
      const report = outcome.report;
      const errors = report.findings.filter((finding) => finding.severity === "error").length;
      const warnings = report.findings.filter((finding) => finding.severity === "warning").length;
      stdout.write(
        `question-check: verdict=${report.verdict} mode=${report.mode} rows=${report.totals.rows} ` +
          `errors=${errors} warnings=${warnings} repeatFreeMocks=${report.coverage.repeatFreeMocks} ` +
          `report=${REPORT_JSON_NAME}\n`,
      );
      return outcome.exitCode;
    }
    if (args.verb === "combine") return runCombine(args, repoRoot, stdout);
    runTaxonomy(args, repoRoot);
    stdout.write("question-check: taxonomy pass\n");
    return 0;
  } catch (error) {
    stderr.write(`question-check: ${describeError(error)}\n`);
    return refusalExitCode(error);
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
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
