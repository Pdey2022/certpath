import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { QuestionCheckError, refusalExitCode } from "./errors.ts";
import {
  CISM_SHAPE,
  SYNTHETIC_SHAPE,
  bankItems,
  batchCsv,
  cleanupDirectories,
  makeEnvironment,
  runCli,
  splitIntoBatches,
  type BankShape,
  type Environment,
} from "./fixtures.ts";
import type { Report } from "./report.ts";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TOOL_DIR, "..", "..");
const CLEAN_OVERRIDES = { difficultyTargets: { easy: 0.33, medium: 0.34, hard: 0.33 } };
const tempDirs: string[] = [];
after(() => cleanupDirectories(tempDirs));

function environment(
  shape: BankShape,
  files: Record<string, string>,
  profileOverrides: Record<string, unknown> = CLEAN_OVERRIDES,
  name = "cli",
): Environment {
  const env = makeEnvironment({ shape, files, profileOverrides, name });
  tempDirs.push(env.root);
  return env;
}

function argv(env: Environment, extra: readonly string[] = [], out = env.out): string[] {
  return [
    "check",
    "--batches",
    env.batches,
    "--profile",
    env.profile,
    "--taxonomy",
    env.taxonomy,
    "--out",
    out,
    ...extra,
  ];
}

function readReport(out: string): Report {
  return JSON.parse(readFileSync(join(out, "question-check-report.json"), "utf8")) as Report;
}

function cleanEnvironment(name: string): Environment {
  return environment(
    SYNTHETIC_SHAPE,
    splitIntoBatches(SYNTHETIC_SHAPE, bankItems(SYNTHETIC_SHAPE, [3, 3, 3, 3]), 4),
    CLEAN_OVERRIDES,
    name,
  );
}

test("--help exits 0 and lists the three verbs", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /check/);
  assert.match(result.stdout, /combine/);
  assert.match(result.stdout, /taxonomy/);
});

test("an unknown verb, a missing argument and a positional argument are refused", async () => {
  const unknown = await runCli(["verify"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /UNKNOWN_VERB/);

  const missing = await runCli(["check", "--profile", "a", "--taxonomy", "b", "--out", "c"]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /MISSING_ARGUMENT/);

  const positional = await runCli(["check", "batches"]);
  assert.equal(positional.code, 2);
  assert.match(positional.stderr, /UNKNOWN_ARGUMENT/);
});

test("exit code 3 is reserved for a failure after judging began", () => {
  assert.equal(refusalExitCode(new QuestionCheckError("IO_FAILED", "x")), 3);
  assert.equal(refusalExitCode(new QuestionCheckError("BATCHES_UNREADABLE", "x")), 2);
  assert.equal(refusalExitCode(new Error("boom")), 2);
});

test("--out inside the repository is refused and nothing is written", async () => {
  const files = splitIntoBatches(SYNTHETIC_SHAPE, bankItems(SYNTHETIC_SHAPE, [3, 0, 0, 0]), 3);
  const env = environment(SYNTHETIC_SHAPE, files, CLEAN_OVERRIDES, "inner");
  const repo = join(env.root, "repo");
  mkdirSync(repo, { recursive: true });
  const out = join(repo, "out");
  const result = await runCli(argv(env, [], out), repo);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /OUT_INSIDE_REPOSITORY/);
  assert.equal(existsSync(out), false);
});

test("--batches inside the repository is refused", async () => {
  const env = cleanEnvironment("batches-inside");
  const repo = join(env.root, "repo");
  mkdirSync(join(repo, "batches"), { recursive: true });
  const result = await runCli(
    ["check", "--batches", join(repo, "batches"), "--profile", env.profile, "--taxonomy", env.taxonomy, "--out", join(env.root, "out")],
    repo,
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, /INPUT_INSIDE_REPOSITORY/);
});

test("the 12-item fixture passes in complete mode with coverage computed", async () => {
  const env = cleanEnvironment("happy");
  const result = await runCli(argv(env, ["--mode", "complete"]));
  assert.equal(result.code, 0);
  const report = readReport(env.out);
  assert.equal(report.verdict, "pass");
  assert.equal(report.totals.batches, 3);
  assert.equal(report.totals.rows, 12);
  assert.equal(
    Object.values(report.coverage.mockDraw).reduce((sum, value) => sum + value, 0),
    150,
  );
  assert.equal(typeof report.coverage.repeatFreeMocks, "number");
  assert.equal(report.advisoryOnly, true);
  assert.equal(report.approvalGranted, null);
});

test("two correct options in one row names file, row and question key", async () => {
  const specs = [
    {
      key: "syn-1",
      domainId: "syn-d1",
      topicId: "syn-d1-t1",
      options: [
        { key: "A", text: "First station choice", correct: true, explanation: "Synthetic rationale for the first choice." },
        { key: "B", text: "Second station choice", correct: true, explanation: "Synthetic rationale for the second choice." },
        { key: "C", text: "Third station choice", correct: false, explanation: "Synthetic rationale for the third choice." },
        { key: "D", text: "Fourth station choice", correct: false, explanation: "Synthetic rationale for the fourth choice." },
      ],
    },
  ];
  const env = environment(SYNTHETIC_SHAPE, { "batch-001.csv": batchCsv(SYNTHETIC_SHAPE, specs) });
  const result = await runCli(argv(env, ["--mode", "complete"]));
  assert.equal(result.code, 1);
  const finding = readReport(env.out).findings.find((entry) => entry.code === "CORRECT_OPTION_COUNT");
  assert.ok(finding !== undefined);
  assert.equal(finding.scope.file, "batch-001.csv");
  assert.equal(finding.scope.row, 1);
  assert.equal(finding.scope.questionKey, "syn-1");
  assert.equal(finding.evidence.count, 2);
});

test("an eleven-row batch is refused while the other batches are still judged", async () => {
  const eleven = batchCsv(
    SYNTHETIC_SHAPE,
    Array.from({ length: 11 }, (_, index) => ({
      key: `syn-${index + 1}`,
      domainId: "syn-d1",
      topicId: "syn-d1-t1",
      correctIndex: index % 4,
    })),
  );
  const other = batchCsv(SYNTHETIC_SHAPE, [
    { key: "syn-12", domainId: "syn-d1", topicId: "syn-d1-t99", correctIndex: 0 },
  ]);
  const env = environment(SYNTHETIC_SHAPE, { "a-eleven.csv": eleven, "b-other.csv": other });
  const result = await runCli(argv(env, ["--mode", "complete"]));
  assert.equal(result.code, 1);
  const report = readReport(env.out);
  const codes = report.findings.map((finding) => finding.code);
  assert.ok(codes.includes("BATCH_ROW_LIMIT"));
  assert.ok(codes.includes("UNKNOWN_TOPIC_KEY"));
  assert.equal(report.totals.batches, 2);
  assert.equal(report.totals.rows, 12);
  assert.equal(report.totals.filesExcluded, 0);
});

test("--strict-warnings turns a warning-only run into a failure", async () => {
  const env = environment(
    SYNTHETIC_SHAPE,
    splitIntoBatches(SYNTHETIC_SHAPE, bankItems(SYNTHETIC_SHAPE, [3, 3, 3, 3]), 4),
    {},
    "strict",
  );
  const relaxed = await runCli(argv(env, [], join(env.root, "relaxed")));
  assert.equal(relaxed.code, 0);
  assert.equal(readReport(join(env.root, "relaxed")).verdict, "pass_with_findings");
  const strict = await runCli(argv(env, ["--strict-warnings"], join(env.root, "strict-out")));
  assert.equal(strict.code, 1);
  assert.equal(readReport(join(env.root, "strict-out")).verdict, "fail");
});

test("a suppression is recorded, an error cannot be suppressed, and a blank reason is refused", async () => {
  const env = environment(
    CISM_SHAPE,
    splitIntoBatches(CISM_SHAPE, bankItems(CISM_SHAPE, [40, 20, 20, 20]), 10),
    {},
    "suppress",
  );
  const suppressed = await runCli(
    argv(env, [
      "--suppress",
      "DOMAIN_WEIGHT_DEVIATION",
      "--reason",
      "synthetic test: the split is deliberate",
      "--approved-by",
      "owner",
    ]),
  );
  assert.equal(suppressed.code, 0);
  const report = readReport(env.out);
  assert.equal(
    report.findings.filter((finding) => finding.code === "DOMAIN_WEIGHT_DEVIATION").length,
    0,
  );
  assert.ok(report.suppressions.length > 0);
  assert.ok(report.suppressions.every((entry) => entry.approvedBy === "owner"));
  assert.match(report.suppressions[0]!.reason, /synthetic test/);

  const error = await runCli(
    argv(env, [
      "--suppress",
      "CORRECT_OPTION_COUNT",
      "--reason",
      "no",
      "--approved-by",
      "owner",
    ], join(env.root, "error-suppress")),
  );
  assert.equal(error.code, 2);
  assert.match(error.stderr, /CANNOT_SUPPRESS_ERROR/);

  const blank = await runCli(
    argv(env, [
      "--suppress",
      "DIFFICULTY_TARGET_UNSET",
      "--reason",
      "   ",
      "--approved-by",
      "owner",
    ], join(env.root, "blank-reason")),
  );
  assert.equal(blank.code, 2);
  assert.match(blank.stderr, /SUPPRESSION_UNJUSTIFIED/);

  const absent = await runCli(
    argv(env, ["--suppress", "DIFFICULTY_TARGET_UNSET", "--approved-by", "owner"], join(env.root, "no-reason")),
  );
  assert.equal(absent.code, 2);
  assert.match(absent.stderr, /SUPPRESSION_UNJUSTIFIED/);
});

test("a planted sentinel stem never reaches the terminal or the markdown", async () => {
  const sentinel = "SENTINEL-9F3A-PLANTED";
  const stem = `${sentinel} widget station control applies to the case.`;
  const env = environment(SYNTHETIC_SHAPE, {
    "batch-001.csv": batchCsv(SYNTHETIC_SHAPE, [
      { key: "syn-1", domainId: "syn-d1", topicId: "syn-d1-t1", stem, correctIndex: 0 },
      { key: "syn-2", domainId: "syn-d1", topicId: "syn-d1-t1", stem: stem.toUpperCase(), correctIndex: 1 },
    ]),
  });
  const result = await runCli(argv(env, ["--format", "both"]));
  assert.equal(result.code, 1);
  assert.equal(result.stdout.includes(sentinel), false);
  assert.equal(result.stderr.includes(sentinel), false);
  const markdown = readFileSync(join(env.out, "question-check-report.md"), "utf8");
  assert.equal(markdown.includes(sentinel), false);
  const json = readFileSync(join(env.out, "question-check-report.json"), "utf8");
  const report = JSON.parse(json) as Report;
  const excerpts = report.findings
    .map((finding) => finding.evidence.excerpt)
    .filter((value): value is string => typeof value === "string");
  const outsideExcerpts = report.findings.filter((finding) => {
    const { excerpt, ...rest } = finding.evidence;
    void excerpt;
    return JSON.stringify(rest).includes(sentinel) || finding.message.includes(sentinel);
  });
  assert.deepEqual(outsideExcerpts, []);
  assert.ok(excerpts.some((excerpt) => excerpt.includes(sentinel)));

  const redacted = await runCli(argv(env, ["--redact", "--format", "json"], join(env.root, "redacted")));
  assert.equal(redacted.code, 1);
  assert.equal(
    readFileSync(join(env.root, "redacted", "question-check-report.json"), "utf8").includes(sentinel),
    false,
  );
});

test("the 100-item 40/20/20/20 split passes in partial mode with three warnings", async () => {
  const env = environment(
    CISM_SHAPE,
    splitIntoBatches(CISM_SHAPE, bankItems(CISM_SHAPE, [40, 20, 20, 20]), 10),
    {},
    "partial-100",
  );
  const result = await runCli(argv(env));
  assert.equal(result.code, 0);
  const report = readReport(env.out);
  assert.equal(report.verdict, "pass_with_findings");
  const deviations = report.findings.filter((finding) => finding.code === "DOMAIN_WEIGHT_DEVIATION");
  assert.equal(deviations.length, 3);
  assert.ok(deviations.every((finding) => finding.severity === "warning"));
  const complete = await runCli(argv(env, ["--mode", "complete"], join(env.root, "complete")));
  assert.equal(complete.code, 1);
  assert.equal(
    readReport(join(env.root, "complete")).findings.filter(
      (finding) => finding.code === "DOMAIN_WEIGHT_DEVIATION" && finding.severity === "error",
    ).length,
    3,
  );
});

test("the module graph makes no network call and imports no network module", () => {
  const entries = readdirSync(TOOL_DIR, { recursive: true }) as string[];
  const sources = entries.filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );
  assert.ok(sources.length >= 10, `expected the tool sources, found ${sources.length}`);
  const forbidden =
    /(\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|from\s+["'](?:node:)?(?:http|https|net|tls|dns|undici|axios)["']|import\(\s*["'](?:node:)?(?:http|https|net|tls|dns|undici)["']\s*\))/;
  for (const name of sources) {
    const text = readFileSync(join(TOOL_DIR, name), "utf8");
    assert.equal(forbidden.test(text), false, `${name} reaches for the network`);
  }
  const packageJson = readFileSync(join(REPO_ROOT, "package.json"), "utf8");
  assert.equal(/"dependencies"/.test(packageJson), false);
});

test("the committed CISM taxonomy fails the taxonomy verb because its topic prose is not approved", async () => {
  const result = await runCli([
    "taxonomy",
    "--taxonomy",
    join(TOOL_DIR, "taxonomy", "cism-2026.json"),
    "--profile",
    join(TOOL_DIR, "profiles", "cism-2026.json"),
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /TAXONOMY_TITLE_BLANK/);
});
