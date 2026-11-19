import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  QUESTION_IMPORT_FORMAT,
  QUESTION_IMPORT_MAX_ROWS,
  QUESTION_IMPORT_TEMPLATE_COLUMNS,
} from "../../apps/api/src/security/question-imports.ts";
import {
  ConverterError,
  FORMAT_VERSION,
  MAX_ROWS_PER_BATCH,
  QUESTION_IMPORT_COLUMNS,
  parseArgs,
  runConverter,
  splitDistractorExplanations,
  writeOutputsAtomically,
  type ConverterOptions,
  type RejectionCode,
} from "./cli.ts";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TOOL_DIR, "..", "..");
const TAXONOMY_PATH = join(TOOL_DIR, "taxonomy.json");

const PROVENANCE = {
  sourceReference: "Synthetic owner fixture",
  licenseReference: "All rights reserved",
};

const tempDirs: string[] = [];
after(() => {
  for (const directory of tempDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "cissp-convert-test-"));
  tempDirs.push(directory);
  return directory;
}

interface FixtureQuestion {
  id: number;
  question: string;
  options: Array<{ letter: string; text: string }>;
  correct_text: string;
  ins_why: string;
  ins_others: string;
  ins_map: string;
}

function syntheticQuestion(
  id: number,
  overrides: Partial<FixtureQuestion> = {},
): FixtureQuestion {
  return {
    id,
    question: `Synthetic stem ${id}?`,
    options: ["A", "B", "C", "D"].map((letter) => ({
      letter,
      text: `Synthetic ${id} option ${letter}`,
    })),
    correct_text: `Synthetic ${id} option A`,
    ins_why: `Synthetic reason ${id} for option A.`,
    ins_others:
      `B. Synthetic reason ${id} for the second option. ` +
      `C. Synthetic reason ${id} for the third option. ` +
      `D. Synthetic reason ${id} for the fourth option.`,
    ins_map: "Domain 1: Security and Risk Management > Risk management",
    ...overrides,
  };
}

function htmlFor(questions: unknown[]): string {
  return `<!doctype html><html><body><script>const allQuestions = ${JSON.stringify(
    questions,
  )};</script></body></html>`;
}

interface Fixture {
  root: string;
  inputPath: string;
  outDir: string;
  options: ConverterOptions;
}

function createFixture(
  questions: unknown[],
  overrides: Partial<ConverterOptions> = {},
  html = htmlFor(questions),
): Fixture {
  const root = makeTempDir();
  const inputPath = join(root, "input.html");
  writeFileSync(inputPath, html, "utf8");
  const outDir = join(root, "out");
  return {
    root,
    inputPath,
    outDir,
    options: {
      inputPath,
      taxonomyPath: TAXONOMY_PATH,
      outDir,
      examVersionId: "exam-v1",
      provenance: PROVENANCE,
      // Synthetic fixtures do not carry the owner's 484-item counts.
      allowCountDrift: true,
      ...overrides,
    },
  };
}

function captureError(action: () => unknown): ConverterError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof ConverterError, `expected ConverterError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the converter to fail closed");
}

function expectCode(action: () => unknown, code: string): ConverterError {
  const error = captureError(action);
  assert.equal(error.code, code);
  return error;
}

function readOutput(outDir: string, name: string): string {
  return readFileSync(join(outDir, name), "utf8");
}

/** Independent minimal RFC 4180 reader for assertions. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (character !== "\r") {
      cell += character;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const FIXTURE_QUESTIONS: FixtureQuestion[] = [
  {
    id: 1,
    question: "Synthetic stem one, with a comma?",
    options: [
      { letter: "A", text: "Synthetic option A" },
      { letter: "B", text: "Synthetic option B" },
      { letter: "C", text: "Synthetic option C" },
      { letter: "D", text: "Synthetic option D" },
    ],
    correct_text: "Synthetic option C",
    ins_why: "Synthetic reason for C.",
    ins_others:
      "A. Synthetic distraction alpha. B. Synthetic distraction beta. " +
      'D. Synthetic distraction delta, with "quotes".',
    ins_map: "Domain 1: Security and Risk Management > Risk management",
  },
  {
    id: 2,
    question: "Synthetic stem two?",
    options: [
      { letter: "A", text: "Synthetic option A" },
      { letter: "B", text: "Synthetic option B" },
      { letter: "C", text: "Synthetic option C" },
      { letter: "D", text: "Synthetic option D" },
    ],
    correct_text: "Synthetic option A",
    ins_why: "Synthetic reason for A.",
    ins_others:
      "B. Synthetic distraction bravo. C. Synthetic distraction charlie. " +
      "D. Synthetic distraction delta.",
    ins_map: "Domain 1: Security and Risk Management > Governance and policy",
  },
  {
    id: 3,
    question: "Synthetic stem three?",
    options: [
      { letter: "A", text: "Synthetic option A" },
      { letter: "B", text: "Synthetic option B" },
      { letter: "C", text: "Synthetic option C" },
      { letter: "D", text: "Synthetic option D" },
    ],
    correct_text: "Synthetic option D",
    ins_why: "Synthetic reason for D.",
    ins_others:
      "A. Synthetic distraction alpha. B. Synthetic distraction bravo. " +
      "C. Synthetic distraction charlie.",
    ins_map: "Domain 2: Asset Security > Asset",
  },
];

const EMPTY_SLOTS = ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""];

function expectedRow(cells: string[]): string {
  assert.equal(cells.length, 41, "the expected row must have 41 cells");
  return cells.join(",");
}

const EXPECTED_BATCH_ONE = [
  QUESTION_IMPORT_COLUMNS.join(","),
  expectedRow([
    "certpath-question-v1",
    "cissp-1",
    "exam-v1",
    "cissp-d1",
    "cissp-d1-risk-management",
    '"Synthetic stem one, with a comma?"',
    "medium",
    "Synthetic owner fixture",
    "All rights reserved",
    "A",
    "Synthetic option A",
    "false",
    "Synthetic distraction alpha.",
    "B",
    "Synthetic option B",
    "false",
    "Synthetic distraction beta.",
    "C",
    "Synthetic option C",
    "true",
    "Synthetic reason for C.",
    "D",
    "Synthetic option D",
    "false",
    '"Synthetic distraction delta, with ""quotes""."',
    ...EMPTY_SLOTS,
  ]),
  expectedRow([
    "certpath-question-v1",
    "cissp-2",
    "exam-v1",
    "cissp-d1",
    "cissp-d1-governance-and-compliance",
    "Synthetic stem two?",
    "medium",
    "Synthetic owner fixture",
    "All rights reserved",
    "A",
    "Synthetic option A",
    "true",
    "Synthetic reason for A.",
    "B",
    "Synthetic option B",
    "false",
    "Synthetic distraction bravo.",
    "C",
    "Synthetic option C",
    "false",
    "Synthetic distraction charlie.",
    "D",
    "Synthetic option D",
    "false",
    "Synthetic distraction delta.",
    ...EMPTY_SLOTS,
  ]),
  expectedRow([
    "certpath-question-v1",
    "cissp-3",
    "exam-v1",
    "cissp-d2",
    "cissp-d2-general",
    "Synthetic stem three?",
    "medium",
    "Synthetic owner fixture",
    "All rights reserved",
    "A",
    "Synthetic option A",
    "false",
    "Synthetic distraction alpha.",
    "B",
    "Synthetic option B",
    "false",
    "Synthetic distraction bravo.",
    "C",
    "Synthetic option C",
    "false",
    "Synthetic distraction charlie.",
    "D",
    "Synthetic option D",
    "true",
    "Synthetic reason for D.",
    ...EMPTY_SLOTS,
  ]),
].join("\n") + "\n";

test("header, format and row cap match the import contract", () => {
  assert.deepEqual([...QUESTION_IMPORT_COLUMNS], [...QUESTION_IMPORT_TEMPLATE_COLUMNS]);
  assert.equal(QUESTION_IMPORT_COLUMNS.length, 41);
  assert.equal(FORMAT_VERSION, QUESTION_IMPORT_FORMAT);
  assert.equal(MAX_ROWS_PER_BATCH, QUESTION_IMPORT_MAX_ROWS);
});

test("three synthetic questions produce the exact CSV bytes", () => {
  const fixture = createFixture(FIXTURE_QUESTIONS);
  const summary = runConverter(fixture.options);

  assert.deepEqual(
    {
      parsed: summary.parsed,
      written: summary.written,
      rejected: summary.rejected,
      batches: summary.batches,
    },
    { parsed: 3, written: 3, rejected: 0, batches: 1 },
  );
  assert.deepEqual(
    readdirSync(fixture.outDir).sort(),
    ["batch-001.csv", "manifest.json", "rejections.txt", "taxonomy-report.json"],
  );
  assert.equal(readOutput(fixture.outDir, "batch-001.csv"), EXPECTED_BATCH_ONE);
  assert.equal(readOutput(fixture.outDir, "rejections.txt"), "");

  const manifest = JSON.parse(readOutput(fixture.outDir, "manifest.json")) as {
    counts: Record<string, number>;
    rejectionsByCode: Record<string, number>;
  };
  assert.deepEqual(manifest.counts, {
    parsed: 3,
    written: 3,
    rejected: 0,
    batches: 1,
    domains: 8,
    topics: 36,
  });
  assert.deepEqual(manifest.rejectionsByCode, {});

  const report = JSON.parse(
    readOutput(fixture.outDir, "taxonomy-report.json"),
  ) as { totals: Record<string, number> };
  assert.equal(report.totals.observedQuestions, 3);
  assert.equal(report.totals.writtenQuestions, 3);
  assert.equal(report.totals.generalQuestions, 1);
});

test("batches never exceed the ten-row import cap", () => {
  const questions = Array.from({ length: 11 }, (_, index) =>
    syntheticQuestion(index + 1),
  );
  const fixture = createFixture(questions);
  const summary = runConverter(fixture.options);

  assert.equal(summary.written, 11);
  assert.equal(summary.batches, 2);
  const first = parseCsv(readOutput(fixture.outDir, "batch-001.csv"));
  const second = parseCsv(readOutput(fixture.outDir, "batch-002.csv"));
  assert.equal(first.length - 1, 10);
  assert.equal(second.length - 1, 1);
  for (const row of [...first, ...second]) {
    assert.equal(row.length, 41);
  }
});

interface TaxonomyForCounts {
  domains: Array<{
    id: string;
    sourcePrefixes: string[];
    topics: Array<{
      id: string;
      sourceLabels: Array<{ label: string; expectedQuestions: number }>;
    }>;
  }>;
}

function countCompleteQuestions(): FixtureQuestion[] {
  const taxonomy = JSON.parse(
    readFileSync(TAXONOMY_PATH, "utf8"),
  ) as TaxonomyForCounts;
  const questions: FixtureQuestion[] = [];
  let id = 1;
  for (const domain of taxonomy.domains) {
    const prefix = domain.sourcePrefixes[0];
    for (const topic of domain.topics) {
      for (const sourceLabel of topic.sourceLabels) {
        for (let count = 0; count < sourceLabel.expectedQuestions; count += 1) {
          questions.push(
            syntheticQuestion(id, {
              ins_map: `${prefix} > ${sourceLabel.label}`,
            }),
          );
          id += 1;
        }
      }
    }
  }
  return questions;
}

test("the approved counts are enforced unless drift is explicitly allowed", () => {
  const complete = countCompleteQuestions();
  assert.equal(complete.length, 484);

  const strict = createFixture(complete, { allowCountDrift: false });
  const summary = runConverter(strict.options);
  assert.equal(summary.parsed, 484);
  assert.equal(summary.written, 484);
  assert.equal(summary.rejected, 0);

  const omitted = complete.slice(0, -1);
  const drifted = createFixture(omitted, { allowCountDrift: false });
  expectCode(() => runConverter(drifted.options), "TAXONOMY_COUNT_MISMATCH");
  assert.equal(existsSync(drifted.outDir), false);
});

test("the explanation split maps each fragment to its own option", () => {
  const split = splitDistractorExplanations(
    "A. first reason. B. second reason. D. fourth reason.",
    ["A", "B", "D"],
  );
  assert.deepEqual(split, {
    ok: true,
    fragments: new Map([
      ["A", "first reason."],
      ["B", "second reason."],
      ["D", "fourth reason."],
    ]),
  });
});

test("prose that mentions a letter is not consumed as that option's marker", () => {
  const result = splitDistractorExplanations(
    "B. Option A is wrong, so pick C. That is the point. D. Fifth.",
    ["B", "C", "D"],
    ["A", "B", "C", "D"],
  );
  assert.equal(result.ok, false);
});

test("a fragment cannot fold another option's marker into its own text", () => {
  const result = splitDistractorExplanations(
    "B. one. C. two. A. three. D. four.",
    ["B", "C", "D"],
    ["A", "B", "C", "D"],
  );
  assert.equal(result.ok, false);
  assert.match(
    result.ok ? "" : result.detail,
    /still contains a marker for option A/,
  );
});

test("deliberately unsplittable and malformed explanations are rejected", () => {
  const cases: Array<{ name: string; text: string; expected: string[] }> = [
    { name: "no markers", text: "Synthetic prose without any letter.", expected: ["B", "C", "D"] },
    { name: "missing marker", text: "B. one. C. two.", expected: ["B", "C", "D"] },
    { name: "out-of-order markers", text: "C. one. B. two. D. three.", expected: ["B", "C", "D"] },
    { name: "empty fragment", text: "B. C. two. D. three.", expected: ["B", "C", "D"] },
    { name: "leading text", text: "prose B. one. C. two. D. three.", expected: ["B", "C", "D"] },
    { name: "correct option marker", text: "A. one. B. two. C. three. D. four.", expected: ["B", "C", "D"] },
  ];
  for (const testCase of cases) {
    const result = splitDistractorExplanations(testCase.text, testCase.expected);
    assert.equal(result.ok, false, testCase.name);
  }
});

test("every rejection code is emitted and the question is omitted", () => {
  const cases: Array<{ name: string; question: FixtureQuestion; code: RejectionCode }> = [
    {
      name: "zero correct matches",
      question: syntheticQuestion(1, { correct_text: "Synthetic missing option" }),
      code: "CORRECT_ANSWER_MATCH_COUNT",
    },
    {
      name: "two correct matches",
      question: syntheticQuestion(1, {
        options: [
          { letter: "A", text: "Synthetic duplicate option" },
          { letter: "B", text: "Synthetic duplicate option" },
          { letter: "C", text: "Synthetic option C" },
          { letter: "D", text: "Synthetic option D" },
        ],
        correct_text: "Synthetic duplicate option",
      }),
      code: "CORRECT_ANSWER_MATCH_COUNT",
    },
    {
      name: "blank correct explanation",
      question: syntheticQuestion(1, { ins_why: "   " }),
      code: "EXPLANATION_MISSING",
    },
    {
      name: "unsplittable distractors",
      question: syntheticQuestion(1, {
        ins_others: "Synthetic prose with no letter markers at all.",
      }),
      code: "EXPLANATION_SPLIT_INCOMPLETE",
    },
    {
      name: "missing distractor marker",
      question: syntheticQuestion(1, { ins_others: "A. one. B. two." }),
      code: "EXPLANATION_SPLIT_INCOMPLETE",
    },
    {
      name: "over-cap correct explanation",
      question: syntheticQuestion(1, { ins_why: "x".repeat(3001) }),
      code: "EXPLANATION_OVER_LIMIT",
    },
    {
      name: "over-cap distractor explanation",
      question: syntheticQuestion(1, {
        ins_others: `B. ${"x".repeat(3001)}. C. two. D. three.`,
      }),
      code: "EXPLANATION_OVER_LIMIT",
    },
  ];

  for (const testCase of cases) {
    const fixture = createFixture([testCase.question, syntheticQuestion(2)]);
    const summary = runConverter(fixture.options);
    assert.equal(summary.written, 1, testCase.name);
    assert.equal(summary.rejected, 1, testCase.name);
    const rejections = readOutput(fixture.outDir, "rejections.txt");
    assert.match(
      rejections,
      new RegExp(`^1\\t${testCase.code}\\t`, "m"),
      testCase.name,
    );
    const csv = readOutput(fixture.outDir, "batch-001.csv");
    assert.ok(!csv.includes(",cissp-1,"), `${testCase.name} must not be written`);
    assert.ok(
      csv.includes(",cissp-2,"),
      `${testCase.name} must not suppress the valid row`,
    );
    assert.ok(
      !csv.includes(testCase.question.ins_why),
      `${testCase.name} must never fall back to ins_why`,
    );
  }
});

test("fatal shape and taxonomy errors fail closed before any file is written", () => {
  const overCapped = "x".repeat(4001);
  const cases: Array<{ name: string; questions: unknown[]; code: string }> = [
    {
      name: "duplicate id",
      questions: [syntheticQuestion(1), syntheticQuestion(1)],
      code: "DUPLICATE_QUESTION_ID",
    },
    { name: "id too high", questions: [syntheticQuestion(485)], code: "QUESTION_ID_OUT_OF_RANGE" },
    { name: "id too low", questions: [syntheticQuestion(0)], code: "QUESTION_ID_OUT_OF_RANGE" },
    {
      name: "three options",
      questions: [
        syntheticQuestion(1, {
          options: [
            { letter: "A", text: "Synthetic option A" },
            { letter: "B", text: "Synthetic option B" },
            { letter: "C", text: "Synthetic option C" },
          ],
        }),
      ],
      code: "OPTION_COUNT_INVALID",
    },
    {
      name: "blank stem",
      questions: [syntheticQuestion(1, { question: "   " })],
      code: "BLANK_QUESTION_TEXT",
    },
    {
      name: "blank option",
      questions: [
        syntheticQuestion(1, {
          options: [
            { letter: "A", text: " " },
            { letter: "B", text: "Synthetic option B" },
            { letter: "C", text: "Synthetic option C" },
            { letter: "D", text: "Synthetic option D" },
          ],
        }),
      ],
      code: "BLANK_OPTION_TEXT",
    },
    {
      name: "stem over cap",
      questions: [syntheticQuestion(1, { question: overCapped })],
      code: "VALUE_OVER_LIMIT",
    },
    {
      name: "option text over cap",
      questions: [
        syntheticQuestion(1, {
          options: [
            { letter: "A", text: "x".repeat(1001) },
            { letter: "B", text: "Synthetic option B" },
            { letter: "C", text: "Synthetic option C" },
            { letter: "D", text: "Synthetic option D" },
          ],
        }),
      ],
      code: "VALUE_OVER_LIMIT",
    },
    {
      name: "unknown source label",
      questions: [
        syntheticQuestion(1, {
          ins_map: "Domain 1: Security and Risk Management > Not a mapped topic",
        }),
      ],
      code: "UNKNOWN_SOURCE_LABEL",
    },
    {
      name: "unknown domain prefix",
      questions: [syntheticQuestion(1, { ins_map: "Domain 9: Nothing > Risk management" })],
      code: "UNKNOWN_DOMAIN_PREFIX",
    },
  ];

  for (const testCase of cases) {
    const fixture = createFixture(testCase.questions);
    expectCode(() => runConverter(fixture.options), testCase.code);
    assert.equal(existsSync(fixture.outDir), false, `${testCase.name} wrote a directory`);
  }
});

test("unparseable HTML and JSON fail closed", () => {
  const missing = createFixture([], {}, "<html><body>no array here</body></html>");
  expectCode(() => runConverter(missing.options), "HTML_ARRAY_NOT_FOUND");
  assert.equal(existsSync(missing.outDir), false);

  const unparseable = createFixture(
    [],
    {},
    "<script>const allQuestions = [{\"id\":1,}];</script>",
  );
  expectCode(() => runConverter(unparseable.options), "HTML_ARRAY_UNPARSEABLE");
  assert.equal(existsSync(unparseable.outDir), false);

  const notArray = createFixture([], {}, "<script>const allQuestions = {};</script>");
  expectCode(() => runConverter(notArray.options), "HTML_ARRAY_NOT_FOUND");
});

test("a run with no accepted rows fails closed instead of writing an empty bank", () => {
  const fixture = createFixture([
    syntheticQuestion(1, { correct_text: "Synthetic missing option" }),
  ]);
  expectCode(() => runConverter(fixture.options), "NO_ROWS_WRITTEN");
  assert.equal(existsSync(fixture.outDir), false);
});

test("the converter refuses to write anywhere inside the repository", () => {
  const fixture = createFixture(FIXTURE_QUESTIONS);
  const forbidden = join(REPO_ROOT, "tools", "cissp-convert", ".forbidden-out");
  expectCode(
    () => runConverter({ ...fixture.options, outDir: forbidden }),
    "OUTPUT_INSIDE_REPOSITORY",
  );
  assert.equal(existsSync(forbidden), false);

  expectCode(
    () => runConverter({ ...fixture.options, outDir: REPO_ROOT }),
    "OUTPUT_INSIDE_REPOSITORY",
  );

  const toolEntries = readdirSync(TOOL_DIR);
  assert.ok(!toolEntries.some((entry) => entry.endsWith(".partial")));
  assert.ok(!toolEntries.some((entry) => entry.startsWith("batch-")));
});

test("a non-empty output directory is refused and left untouched", () => {
  const fixture = createFixture(FIXTURE_QUESTIONS);
  mkdirSync(fixture.outDir);
  writeFileSync(join(fixture.outDir, "keep.txt"), "keep", "utf8");
  expectCode(() => runConverter(fixture.options), "OUTPUT_DIRECTORY_NOT_EMPTY");
  assert.deepEqual(readdirSync(fixture.outDir), ["keep.txt"]);
  assert.equal(readFileSync(join(fixture.outDir, "keep.txt"), "utf8"), "keep");
});

test("a write failure removes every .partial and final file", () => {
  const root = makeTempDir();
  const outDir = join(root, "out");
  mkdirSync(outDir);
  let calls = 0;
  expectCode(
    () =>
      writeOutputsAtomically(
        outDir,
        [
          { name: "a.txt", contents: "a" },
          { name: "b.txt", contents: "b" },
        ],
        {
          writeFile(path, data) {
            calls += 1;
            if (calls === 2) throw new Error("synthetic write failure");
            writeFileSync(path, data, "utf8");
          },
        },
      ),
    "OUTPUT_WRITE_FAILED",
  );
  assert.deepEqual(readdirSync(outDir), []);
});

test("manifest, taxonomy report and rejections contain no question text", () => {
  const fixture = createFixture(FIXTURE_QUESTIONS);
  runConverter(fixture.options);

  const metadata = ["manifest.json", "taxonomy-report.json", "rejections.txt"]
    .map((name) => readOutput(fixture.outDir, name))
    .join("\n");
  for (const question of FIXTURE_QUESTIONS) {
    assert.ok(!metadata.includes(question.question), "stem leaked into metadata");
    assert.ok(!metadata.includes(question.ins_why), "ins_why leaked into metadata");
    for (const option of question.options) {
      assert.ok(!metadata.includes(option.text), "option text leaked into metadata");
    }
  }

  const manifest = JSON.parse(readOutput(fixture.outDir, "manifest.json")) as {
    batches: Array<{ file: string; rows: number; sha256: string }>;
  };
  assert.deepEqual(Object.keys(manifest).sort(), [
    "batches",
    "counts",
    "formatVersion",
    "provenanceSha256",
    "rejectionsByCode",
    "sourceSha256",
    "taxonomySha256",
  ]);
  for (const batch of manifest.batches) {
    const bytes = readFileSync(join(fixture.outDir, batch.file));
    assert.equal(batch.sha256, createHash("sha256").update(bytes).digest("hex"));
  }
});

test("the same input produces byte-identical output", () => {
  const first = createFixture(FIXTURE_QUESTIONS);
  const second = createFixture(FIXTURE_QUESTIONS);
  runConverter(first.options);
  runConverter(second.options);
  for (const name of readdirSync(first.outDir)) {
    assert.deepEqual(
      readFileSync(join(first.outDir, name)),
      readFileSync(join(second.outDir, name)),
      name,
    );
  }
});

test("provenance is required and never defaulted", () => {
  const base = [
    "--input",
    "input.html",
    "--taxonomy",
    "taxonomy.json",
    "--out",
    "out",
    "--exam-version-id",
    "exam-v1",
  ];

  expectCode(() => parseArgs(base), "MISSING_PROVENANCE");
  expectCode(() => parseArgs([...base, "--source-reference", "only source"]), "MISSING_PROVENANCE");
  expectCode(
    () =>
      parseArgs([
        ...base,
        "--provenance",
        "provenance.json",
        "--source-reference",
        "both",
        "--license-reference",
        "both",
      ]),
    "PROVENANCE_CONFLICT",
  );
  expectCode(
    () =>
      parseArgs([
        ...base,
        "--source-reference",
        "x".repeat(1001),
        "--license-reference",
        "licence",
      ]),
    "PROVENANCE_INVALID",
  );

  const parsed = parseArgs([
    ...base,
    "--source-reference",
    "Synthetic owner fixture",
    "--license-reference",
    "All rights reserved",
  ]);
  assert.equal(parsed.help, false);
  assert.deepEqual(parsed.options?.provenance, PROVENANCE);

  const root = makeTempDir();
  const partialProvenance = join(root, "provenance.json");
  writeFileSync(
    partialProvenance,
    JSON.stringify({ sourceReference: "Synthetic owner fixture" }),
    "utf8",
  );
  expectCode(
    () => parseArgs([...base, "--provenance", partialProvenance]),
    "PROVENANCE_INVALID",
  );
});

test("argument parsing rejects unknown, duplicate and missing values", () => {
  expectCode(
    () => parseArgs(["--input", "a", "--input", "b"]),
    "DUPLICATE_ARGUMENT",
  );
  expectCode(() => parseArgs(["--bogus", "value"]), "UNKNOWN_ARGUMENT");
  expectCode(
    () =>
      parseArgs([
        "--input",
        "--taxonomy",
        "t",
        "--out",
        "o",
        "--exam-version-id",
        "e",
        "--source-reference",
        "s",
        "--license-reference",
        "l",
      ]),
    "MISSING_ARGUMENT",
  );
  expectCode(
    () =>
      parseArgs([
        "--input",
        "i",
        "--taxonomy",
        "t",
        "--out",
        "o",
        "--exam-version-id",
        "not a key",
        "--source-reference",
        "s",
        "--license-reference",
        "l",
      ]),
    "INVALID_EXAM_VERSION_ID",
  );
  assert.equal(parseArgs(["--help"]).help, true);
});
