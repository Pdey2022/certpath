import assert from "node:assert/strict";
import test from "node:test";
import {
  findCorrectOptionLongest,
  findExplanationIssues,
  findLengthOutliers,
  findNearDuplicates,
  findStemDuplicates,
  jaccard,
  normaliseStem,
  runSimilarityChecks,
  tokenShingles,
} from "./checks/similarity.ts";
import { SYNTHETIC_SHAPE, itemCells, type ItemSpec, type OptionSpec } from "./fixtures.ts";
import { itemFromRow, type Item } from "./parse.ts";

const SHAPE = SYNTHETIC_SHAPE;
const SETTINGS = { shingleSize: 5, threshold: 0.8 };

function itemsFrom(specs: readonly ItemSpec[]): Item[] {
  return specs.map((spec, index) =>
    itemFromRow("batch-001.csv", index + 1, itemCells(spec, SHAPE), SHAPE.optionCount),
  );
}

function spec(ordinal: number, overrides: Partial<ItemSpec> = {}): ItemSpec {
  return { key: `syn-${ordinal}`, domainId: "syn-d1", topicId: "syn-d1-t1", ...overrides };
}

function optionsWith(texts: readonly string[], correctIndex = 0): Array<OptionSpec> {
  return texts.map((text, index) => ({
    key: String.fromCharCode("A".charCodeAt(0) + index),
    text,
    correct: index === correctIndex,
    explanation: `Synthetic rationale for the station choice number ${index + 1}.`,
  }));
}

const TWENTY_TOKENS = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india",
  "juliet",
  "kilo",
  "lima",
  "mike",
  "november",
  "oscar",
  "papa",
  "quebec",
  "romeo",
  "sierra",
  "tango",
];

function stemWith(...ending: string[]): string {
  return [...TWENTY_TOKENS.slice(0, 20 - ending.length), ...ending].join(" ");
}

test("normalisation folds case, punctuation and whitespace", () => {
  assert.equal(normaliseStem("Widget  Control, applies."), "widget control applies");
  assert.equal(normaliseStem("WIDGET control applies"), normaliseStem("widget   control applies."));
});

test("two stems differing only in case, whitespace and a full stop are duplicates", () => {
  const findings = findStemDuplicates(
    itemsFrom([
      spec(1, { stem: "Widget Control Applies." }),
      spec(2, { stem: "widget   control applies" }),
    ]),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.code, "STEM_DUPLICATE");
  assert.equal(findings[0]!.severity, "error");
  assert.equal(findings[0]!.evidence.firstQuestionKey, "syn-1");
  assert.equal(findings[0]!.evidence.duplicateQuestionKey, "syn-2");
  assert.equal(findings[0]!.scope.questionKey, "syn-2");
});

test("a near duplicate at 0.88 is flagged with its score and counterpart", () => {
  const findings = findNearDuplicates(
    itemsFrom([spec(1, { stem: stemWith("tango") }), spec(2, { stem: stemWith("uniform") })]),
    SETTINGS,
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.code, "STEM_NEAR_DUPLICATE");
  assert.equal(findings[0]!.evidence.counterpartQuestionKey, "syn-1");
  assert.equal(findings[0]!.evidence.score, 0.882);
  assert.equal(findings[0]!.scope.questionKey, "syn-2");
});

test("a pair at 0.78 is not a near duplicate", () => {
  const findings = findNearDuplicates(
    itemsFrom([spec(1, { stem: stemWith("sierra", "tango") }), spec(2, { stem: stemWith("victor", "whiskey") })]),
    SETTINGS,
  );
  assert.deepEqual(findings, []);
  const left = tokenShingles(normaliseStem(stemWith("sierra", "tango")).split(" "), 5);
  const right = tokenShingles(normaliseStem(stemWith("victor", "whiskey")).split(" "), 5);
  assert.ok(jaccard(left, right) < 0.8);
});

test("stems shorter than the shingle size do not produce spurious matches", () => {
  const findings = findNearDuplicates(
    itemsFrom([spec(1, { stem: "widget board case" }), spec(2, { stem: "widget board item" })]),
    SETTINGS,
  );
  assert.deepEqual(findings, []);
});

test("a flat length distribution produces no outliers", () => {
  const items = itemsFrom(Array.from({ length: 8 }, (_, index) => spec(index + 1, { stem: "x".repeat(80) })));
  assert.deepEqual(findLengthOutliers(items), []);
});

test("one very long stem is a modified-z outlier", () => {
  const lengths = [100, 101, 100, 99, 100, 102, 98, 100, 101, 100];
  const specs = lengths.map((length, index) => spec(index + 1, { stem: "s".repeat(length) }));
  specs.push(spec(99, { stem: "s".repeat(1000) }));
  const findings = findLengthOutliers(itemsFrom(specs));
  const outlier = findings.find((finding) => finding.code === "STEM_LENGTH_OUTLIER");
  assert.ok(outlier !== undefined);
  assert.equal(outlier.scope.questionKey, "syn-99");
  assert.equal(outlier.evidence.length, 1000);
});

test("the correct option being strictly longest in half of ten items is a pattern", () => {
  const long = "A considerably longer synthetic choice for this widget station";
  const short = "Short choice";
  const specs: ItemSpec[] = Array.from({ length: 10 }, (_, index) => {
    const correctFirst = index < 5;
    const texts = correctFirst ? [long, short, short, short] : [short, long, short, short];
    return spec(index + 1, { options: optionsWith(texts, correctFirst ? 0 : 2) });
  });
  const findings = findCorrectOptionLongest(itemsFrom(specs));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.code, "CORRECT_OPTION_LONGEST_PATTERN");
  assert.equal(findings[0]!.evidence.share, 0.5);
});

test("nine items are below the pattern's minimum run", () => {
  const long = "A considerably longer synthetic choice for this widget station";
  const short = "Short choice";
  const specs: ItemSpec[] = Array.from({ length: 9 }, (_, index) =>
    spec(index + 1, { options: optionsWith([long, short, short, short], 0) }),
  );
  assert.deepEqual(findCorrectOptionLongest(itemsFrom(specs)), []);
});

test("a distractor explanation under 40 characters is thin", () => {
  const specs = [
    spec(1, {
      options: [
        { key: "A", text: "First station choice", correct: true, explanation: "Synthetic rationale that is long enough to teach." },
        { key: "B", text: "Second station choice", correct: false, explanation: "Too short." },
        { key: "C", text: "Third station choice", correct: false, explanation: "Synthetic rationale that is long enough to teach." },
        { key: "D", text: "Fourth station choice", correct: false, explanation: "Synthetic rationale that is long enough to teach." },
      ],
    }),
  ];
  const findings = findExplanationIssues(itemsFrom(specs));
  assert.deepEqual(findings.map((finding) => finding.code), ["EXPLANATION_THIN"]);
  assert.equal(findings[0]!.evidence.slot, 2);
});

test("an explanation naming an option letter is flagged, on all three patterns", () => {
  const explanations = [
    "The option B is the safer station control for this case.",
    "The answer C settles the widget case in this scenario.",
    "D. Choose this station control and record the decision.",
  ];
  const specs = explanations.map((explanation, index) =>
    spec(index + 1, {
      options: [
        { key: "A", text: "First station choice", correct: true, explanation: "Synthetic rationale for the first choice here." },
        { key: "B", text: "Second station choice", correct: false, explanation },
        { key: "C", text: "Third station choice", correct: false, explanation: "Synthetic rationale for the third choice here." },
        { key: "D", text: "Fourth station choice", correct: false, explanation: "Synthetic rationale for the fourth choice here." },
      ],
    }),
  );
  const findings = findExplanationIssues(itemsFrom(specs));
  assert.deepEqual(
    findings.filter((finding) => finding.code === "EXPLANATION_LETTER_REFERENCE").length,
    3,
  );
});

/** The letter-reference findings for one explanation placed in a distractor slot. */
function letterReferenceFindings(explanation: string) {
  const specs = [
    spec(1, {
      options: [
        { key: "A", text: "First station choice", correct: true, explanation: "Synthetic rationale for the first choice here." },
        { key: "B", text: "Second station choice", correct: false, explanation },
        { key: "C", text: "Third station choice", correct: false, explanation: "Synthetic rationale for the third choice here." },
        { key: "D", text: "Fourth station choice", correct: false, explanation: "Synthetic rationale for the fourth choice here." },
      ],
    }),
  ];
  return findExplanationIssues(itemsFrom(specs)).filter(
    (finding) => finding.code === "EXPLANATION_LETTER_REFERENCE",
  );
}

/**
 * Each pair is one position in which an upper-case letter is a reference and a
 * lower-case one is ordinary English. Asserting both halves together is what
 * makes a re-added `i` flag fail instead of slipping through.
 */
const LETTER_REFERENCE_PAIRS: ReadonlyArray<{
  reference: string;
  prose: string;
  pattern: string;
}> = [
  { reference: "option C is the safer control", prose: "option a reader sees is ambiguous", pattern: "\\b[Oo]ption[s]?\\s+[A-H]\\b" },
  { reference: "options A and B both fail here", prose: "options a writer drafts should be ranked", pattern: "\\b[Oo]ption[s]?\\s+[A-H]\\b" },
  { reference: "the answer B is the unsafe control", prose: "answers a narrower question than the stem asks", pattern: "\\b(?:[Aa]nswer|[Cc]hoice)s?\\s+[A-H]\\b" },
  { reference: "the choice D fails the widget case", prose: "does not answer a value question at all", pattern: "\\b(?:[Aa]nswer|[Cc]hoice)s?\\s+[A-H]\\b" },
  { reference: "answer C settles the widget case", prose: "a choice among alternatives is still a choice", pattern: "\\b(?:[Aa]nswer|[Cc]hoice)s?\\s+[A-H]\\b" },
  { reference: "See A. Then record the decision", prose: "option ambiguity exists in this stem", pattern: "[A-H][.)]\\s" },
];

test("each letter reference is flagged and each lower-case twin is not", () => {
  for (const { reference, prose, pattern } of LETTER_REFERENCE_PAIRS) {
    const referenceFindings = letterReferenceFindings(reference);
    assert.equal(referenceFindings.length, 1, `expected a finding for: ${reference}`);
    assert.equal(referenceFindings[0]!.evidence.pattern, pattern, reference);
    assert.deepEqual(letterReferenceFindings(prose), [], `expected no finding for: ${prose}`);
  }
});

test("the keyword matches in any case, the letter only in upper case", () => {
  for (const reference of [
    "option C is wrong",
    "Option C is wrong",
    "options A and B",
    "Choice D",
    "Answer B",
    "See A. ",
  ]) {
    assert.equal(letterReferenceFindings(reference).length, 1, `expected a finding for: ${reference}`);
  }
});

test("the article a after any keyword case is not a letter reference", () => {
  for (const prose of [
    "answers a narrower question",
    "does not answer a value question",
    "option a reviewer sees",
    "options a writer drafts",
    "answer a manager gives",
    "choice a team defends",
    "choices a test asserts",
  ]) {
    assert.deepEqual(letterReferenceFindings(prose), [], `expected no finding for: ${prose}`);
  }
});

/** "The answer is B" is a fourth shape; adding it is a separate decision. */
test("a copular answer letter is outside the three patterns", () => {
  assert.deepEqual(letterReferenceFindings("The answer is B"), []);
});

test("prose containing a lone a or I is not a letter reference", () => {
  const specs = [
    spec(1, {
      options: [
        { key: "A", text: "First station choice", correct: true, explanation: "I think a manager would agree with this station choice." },
        { key: "B", text: "Second station choice", correct: false, explanation: "A synthetic rationale that is long enough for the distractor." },
        { key: "C", text: "Third station choice", correct: false, explanation: "A synthetic rationale that is long enough for the distractor." },
        { key: "D", text: "Fourth station choice", correct: false, explanation: "A synthetic rationale that is long enough for the distractor." },
      ],
    }),
  ];
  assert.deepEqual(
    findExplanationIssues(itemsFrom(specs)).filter(
      (finding) => finding.code === "EXPLANATION_LETTER_REFERENCE",
    ),
    [],
  );
});

test("the run-level similarity pass combines every check", () => {
  const findings = runSimilarityChecks(
    itemsFrom([spec(1, { stem: "Widget Control Applies." }), spec(2, { stem: "widget control applies" })]),
    SETTINGS,
  );
  assert.ok(findings.some((finding) => finding.code === "STEM_DUPLICATE"));
});
