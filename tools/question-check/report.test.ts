import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  SYNTHETIC_SHAPE,
  bankItems,
  batchCsv,
  cleanupDirectories,
  makeEnvironment,
  runCli,
  splitIntoBatches,
  type Environment,
} from "./fixtures.ts";
import { sortFindings, type Finding, type Report } from "./report.ts";

const CLEAN_OVERRIDES = { difficultyTargets: { easy: 0.33, medium: 0.34, hard: 0.33 } };
const tempDirs: string[] = [];
after(() => cleanupDirectories(tempDirs));

function environment(name: string, overrides: Record<string, unknown> = CLEAN_OVERRIDES): Environment {
  const env = makeEnvironment({
    shape: SYNTHETIC_SHAPE,
    files: splitIntoBatches(SYNTHETIC_SHAPE, bankItems(SYNTHETIC_SHAPE, [3, 3, 3, 3]), 4),
    profileOverrides: overrides,
    name,
  });
  tempDirs.push(env.root);
  return env;
}

function argv(env: Environment, out: string, extra: readonly string[] = []): string[] {
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

function readReport(path: string): Report {
  return JSON.parse(readFileSync(path, "utf8")) as Report;
}

test("two runs over identical bytes produce byte-identical JSON", async () => {
  const env = environment("determinism");
  const first = await runCli(argv(env, join(env.root, "out-a"), ["--mode", "complete"]));
  const second = await runCli(argv(env, join(env.root, "out-b"), ["--mode", "complete"]));
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  const left = readFileSync(join(env.root, "out-a", "question-check-report.json"));
  const right = readFileSync(join(env.root, "out-b", "question-check-report.json"));
  assert.equal(
    createHash("sha256").update(left).digest("hex"),
    createHash("sha256").update(right).digest("hex"),
  );
});

test("the report carries no absolute path and no timestamp", async () => {
  const env = environment("paths");
  const result = await runCli(argv(env, join(env.root, "out"), ["--mode", "complete"]));
  assert.equal(result.code, 0);
  const text = readFileSync(join(env.root, "out", "question-check-report.json"), "utf8");
  assert.equal(text.includes(env.root.replaceAll("\\", "\\\\")), false);
  assert.equal(text.includes(env.root), false);
  assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text), false);
  const report = readReport(join(env.root, "out", "question-check-report.json"));
  assert.equal(report.inputs.profile.path, "profile.json");
  assert.equal(report.inputs.batches[0]!.file, "batch-001.csv");
});

test("the batch digest is the digest of the file's bytes", async () => {
  const env = environment("digests");
  await runCli(argv(env, join(env.root, "out"), ["--mode", "complete"]));
  const report = readReport(join(env.root, "out", "question-check-report.json"));
  const bytes = readFileSync(join(env.batches, "batch-001.csv"));
  assert.equal(
    report.inputs.batches[0]!.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
});

test("findings are ordered by file, row and code regardless of input order", () => {
  const findings: Finding[] = [
    { code: "STEM_DUPLICATE", severity: "error", owner: "tool", scope: { file: "b.csv", row: 2, questionKey: "syn-3", domainId: null }, message: "x", evidence: {} },
    { code: "FIELD_REQUIRED", severity: "error", owner: "tool", scope: { file: "a.csv", row: 9, questionKey: "syn-9", domainId: null }, message: "y", evidence: {} },
    { code: "ANSWER_POSITION_BIASED", severity: "error", owner: "tool", scope: { file: null, row: null, questionKey: null, domainId: null }, message: "z", evidence: {} },
  ];
  const forward = sortFindings(findings);
  const backward = sortFindings([...findings].reverse());
  assert.deepEqual(forward, backward);
  assert.deepEqual(
    forward.map((finding) => finding.code),
    ["ANSWER_POSITION_BIASED", "FIELD_REQUIRED", "STEM_DUPLICATE"],
  );
});

test("an excerpt is capped at 160 characters and markdown never carries one", async () => {
  // Two stems that differ only in case and whitespace produce a STEM_DUPLICATE
  // whose evidence carries one capped excerpt.
  const longStem = "Widget station control applies to the case. ".repeat(20);
  const env = makeEnvironment({
    shape: SYNTHETIC_SHAPE,
    files: {
      "batch-001.csv": batchCsv(SYNTHETIC_SHAPE, [
        { key: "syn-1", domainId: "syn-d1", topicId: "syn-d1-t1", stem: longStem, correctIndex: 0 },
        {
          key: "syn-2",
          domainId: "syn-d1",
          topicId: "syn-d1-t1",
          stem: `  ${longStem.toUpperCase()}  `,
          correctIndex: 1,
        },
      ]),
    },
    profileOverrides: CLEAN_OVERRIDES,
  });
  tempDirs.push(env.root);
  const result = await runCli(argv(env, join(env.root, "out"), ["--format", "both"]));
  assert.equal(result.code, 1);
  const report = readReport(join(env.root, "out", "question-check-report.json"));
  const excerpts = report.findings
    .map((finding) => finding.evidence.excerpt)
    .filter((value): value is string => typeof value === "string");
  assert.ok(excerpts.length > 0);
  for (const excerpt of excerpts) assert.ok(excerpt.length <= 160, `excerpt was ${excerpt.length}`);
  const markdown = readFileSync(join(env.root, "out", "question-check-report.md"), "utf8");
  assert.equal(markdown.includes("Widget station control applies"), false);

  const redacted = await runCli(
    argv(env, join(env.root, "out-redacted"), ["--redact", "--format", "json"]),
  );
  assert.equal(redacted.code, 1);
  const redactedText = readFileSync(
    join(env.root, "out-redacted", "question-check-report.json"),
    "utf8",
  );
  assert.equal(redactedText.includes("Widget station control applies"), false);
  assert.equal(redactedText.includes("\"excerpt\""), false);
});

test("a non-empty --out is refused without --force and replaced with it", async () => {
  const env = environment("force");
  const out = join(env.root, "out");
  const first = await runCli(argv(env, out, ["--mode", "complete"]));
  assert.equal(first.code, 0);
  const before = readReport(join(out, "question-check-report.json"));

  const second = await runCli(argv(env, out, ["--mode", "complete"]));
  assert.equal(second.code, 2);
  assert.match(second.stderr, /OUT_NOT_EMPTY/);
  assert.equal(
    readReport(join(out, "question-check-report.json")).inputs.batches[0]!.sha256,
    before.inputs.batches[0]!.sha256,
  );

  const batchPath = join(env.batches, "batch-001.csv");
  writeFileSync(batchPath, `${readFileSync(batchPath, "utf8")}`.replace("Synthetic", "Synthetic!"), "utf8");
  const third = await runCli(argv(env, out, ["--mode", "complete", "--force"]));
  assert.equal(third.code, 0);
  const afterRun = readReport(join(out, "question-check-report.json"));
  assert.notEqual(afterRun.inputs.batches[0]!.sha256, before.inputs.batches[0]!.sha256);
});

test("--format json writes one file and --format markdown writes one file", async () => {
  const env = environment("formats");
  await runCli(argv(env, join(env.root, "json-only"), ["--format", "json", "--mode", "complete"]));
  assert.throws(() => readFileSync(join(env.root, "json-only", "question-check-report.md")));
  await runCli(argv(env, join(env.root, "md-only"), ["--format", "markdown", "--mode", "complete"]));
  assert.throws(() => readFileSync(join(env.root, "md-only", "question-check-report.json")));
});
