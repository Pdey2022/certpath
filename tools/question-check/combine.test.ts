import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  CISM_SHAPE,
  SYNTHETIC_SHAPE,
  bankItems,
  cleanupDirectories,
  makeEnvironment,
  runCli,
  splitIntoBatches,
  type BankShape,
  type Environment,
  type ItemSpec,
} from "./fixtures.ts";
import { listBatchFiles } from "./parse.ts";
import type { Report } from "./report.ts";

const CLEAN_OVERRIDES = { difficultyTargets: { easy: 0.33, medium: 0.34, hard: 0.33 } };
const tempDirs: string[] = [];
after(() => cleanupDirectories(tempDirs));

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Run {
  env: Environment;
  reportPath: string;
  reportBytes: Buffer;
  report: Report;
}

async function runCheck(input: {
  name: string;
  shape: BankShape;
  rowsPerDomain: readonly number[];
  profileOverrides?: Record<string, unknown>;
  items?: readonly ItemSpec[];
}): Promise<Run> {
  const env = makeEnvironment({
    shape: input.shape,
    files: splitIntoBatches(input.shape, input.items ?? bankItems(input.shape, input.rowsPerDomain), 10),
    profileOverrides: input.profileOverrides ?? CLEAN_OVERRIDES,
    name: input.name,
  });
  tempDirs.push(env.root);
  const result = await runCli([
    "check",
    "--batches",
    env.batches,
    "--profile",
    env.profile,
    "--taxonomy",
    env.taxonomy,
    "--out",
    env.out,
    "--mode",
    "complete",
  ]);
  assert.ok(result.code === 0 || result.code === 1, result.stderr);
  const reportPath = join(env.out, "question-check-report.json");
  const reportBytes = readFileSync(reportPath);
  return { env, reportPath, reportBytes, report: JSON.parse(reportBytes.toString("utf8")) as Report };
}

/** PROF's findings file. Digests are taken from the batches as they stand now. */
function findingsBody(run: Run, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: "certpath-prof-findings-v1",
    reportSha256: sha256(run.reportBytes),
    batchDigests: listBatchFiles(run.env.batches).map((file) => ({
      file,
      sha256: sha256(readFileSync(join(run.env.batches, file))),
    })),
    acknowledgedWarnings: [],
    findings: [],
    verdict: "pass",
    ...overrides,
  };
}

async function combine(run: Run, body: Record<string, unknown>): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  verdict: Record<string, unknown> | null;
}> {
  const findingsPath = join(run.env.root, "prof-findings.json");
  writeFileSync(findingsPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  const out = join(run.env.root, "verdict");
  const result = await runCli([
    "combine",
    "--report",
    run.reportPath,
    "--findings",
    findingsPath,
    "--out",
    out,
  ]);
  let verdict: Record<string, unknown> | null = null;
  try {
    verdict = JSON.parse(readFileSync(join(out, "question-review-verdict.json"), "utf8")) as Record<string, unknown>;
  } catch {
    verdict = null;
  }
  return { ...result, verdict };
}

function acknowledgeAll(report: Report): Array<Record<string, unknown>> {
  return report.findings
    .filter((finding) => finding.severity === "warning")
    .map((finding) => ({
      code: finding.code,
      scopeKey: finding.scope.questionKey,
      judgement: "accepted",
      reason: "synthetic acknowledgement for the test",
    }));
}

test("a clean report and a passing review combine to pass", async () => {
  const run = await runCheck({ name: "combine-clean", shape: SYNTHETIC_SHAPE, rowsPerDomain: [3, 3, 3, 3] });
  assert.equal(run.report.verdict, "pass");
  const result = await combine(run, findingsBody(run));
  assert.equal(result.code, 0);
  assert.equal(result.verdict?.verdict, "pass");
  assert.equal(result.verdict?.advisoryOnly, true);
  assert.equal(result.verdict?.approvalGranted, null);
});

test("a batch edited after the run makes the findings stale", async () => {
  const run = await runCheck({ name: "combine-stale", shape: SYNTHETIC_SHAPE, rowsPerDomain: [3, 3, 3, 3] });
  const batchPath = join(run.env.batches, "batch-001.csv");
  const edited = readFileSync(batchPath, "utf8").replace("Synthetic widget-change", "Synthetic widget-changed");
  writeFileSync(batchPath, edited, "utf8");
  const result = await combine(run, findingsBody(run));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /STALE_REPORT/);
  assert.equal(result.verdict, null);
});

test("an unacknowledged warning fails closed with WARNING_UNACKNOWLEDGED", async () => {
  const run = await runCheck({
    name: "combine-unacknowledged",
    shape: CISM_SHAPE,
    rowsPerDomain: [3, 3, 3, 3],
    profileOverrides: {},
  });
  const warnings = run.report.findings.filter((finding) => finding.severity === "warning");
  assert.ok(warnings.length > 0);
  const result = await combine(run, findingsBody(run));
  assert.equal(result.code, 1);
  assert.equal(result.verdict?.verdict, "fail");
  assert.deepEqual(result.verdict?.blockedBy, ["WARNING_UNACKNOWLEDGED"]);
  assert.match(result.stdout, /WARNING_UNACKNOWLEDGED/);
});

test("acknowledging every warning lifts the block and yields pass_with_findings", async () => {
  const run = await runCheck({
    name: "combine-acknowledged",
    shape: CISM_SHAPE,
    rowsPerDomain: [3, 3, 3, 3],
    profileOverrides: {},
  });
  const result = await combine(
    run,
    findingsBody(run, { acknowledgedWarnings: acknowledgeAll(run.report) }),
  );
  assert.equal(result.code, 0);
  assert.equal(result.verdict?.verdict, "pass_with_findings");
  assert.deepEqual(result.verdict?.blockedBy, []);
});

test("a PROF verdict of pass cannot override an error in the report", async () => {
  const twoCorrect = bankItems(SYNTHETIC_SHAPE, [2, 0, 0, 0]).map((item, index) => ({
    ...item,
    options: [
      { key: "A", text: "First station choice", correct: true, explanation: "Synthetic rationale for the first station choice." },
      { key: "B", text: "Second station choice", correct: true, explanation: "Synthetic rationale for the second station choice." },
      { key: "C", text: "Third station choice", correct: false, explanation: "Synthetic rationale for the third station choice." },
      { key: "D", text: "Fourth station choice", correct: false, explanation: "Synthetic rationale for the fourth station choice." },
    ],
    correctIndex: index,
  }));
  const run = await runCheck({
    name: "combine-override",
    shape: SYNTHETIC_SHAPE,
    rowsPerDomain: [2, 0, 0, 0],
    items: twoCorrect,
  });
  assert.ok(run.report.findings.some((finding) => finding.code === "CORRECT_OPTION_COUNT"));
  const result = await combine(run, findingsBody(run, { verdict: "pass" }));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /CANNOT_OVERRIDE_ERROR/);
});

test("the combined verdict is the worse of the two, and only blocking findings fail", async () => {
  const run = await runCheck({
    name: "combine-worst",
    shape: CISM_SHAPE,
    rowsPerDomain: [3, 3, 3, 3],
    profileOverrides: {},
  });
  const acknowledgedWarnings = acknowledgeAll(run.report);
  const majorFinding = {
    code: "DISTRACTOR_IMPLAUSIBLE",
    severity: "major",
    scope: { file: "batch-001.csv", row: 1, questionKey: "cism-1" },
    claim: "no practitioner would pick this option",
    evidence: "the option describes a control nobody runs at this station",
    fix: "replace it with a plausible near-miss control",
  };
  const withMajor = await combine(
    run,
    findingsBody(run, { acknowledgedWarnings, findings: [majorFinding], verdict: "pass_with_findings" }),
  );
  assert.equal(withMajor.code, 0);
  assert.equal(withMajor.verdict?.verdict, "pass_with_findings");

  const withBlocking = await combine(
    run,
    findingsBody(run, {
      acknowledgedWarnings,
      findings: [{ ...majorFinding, severity: "blocking" }],
      verdict: "fail",
    }),
  );
  assert.equal(withBlocking.code, 1);
  assert.equal(withBlocking.verdict?.verdict, "fail");
});

test("a findings file without a reason is refused", async () => {
  const run = await runCheck({ name: "combine-invalid", shape: SYNTHETIC_SHAPE, rowsPerDomain: [3, 3, 3, 3] });
  const result = await combine(
    run,
    findingsBody(run, {
      acknowledgedWarnings: [{ code: "DIFFICULTY_TARGET_UNSET", scopeKey: null, judgement: "accepted", reason: "" }],
    }),
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, /FINDINGS_INVALID/);
});
