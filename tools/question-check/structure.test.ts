import assert from "node:assert/strict";
import test from "node:test";
import { optionColumnIndices } from "./contract.ts";
import {
  SYNTHETIC_SHAPE,
  itemCells,
  profileRaw,
  taxonomyRaw,
  type ItemSpec,
  type OptionSpec,
} from "./fixtures.ts";
import { itemFromRow, type Item } from "./parse.ts";
import { validateProfile } from "./profile.ts";
import { runStructureChecks, type StructureContext } from "./checks/structure.ts";
import { taxonomyIndex, validateTaxonomy } from "./taxonomy.ts";

const SHAPE = SYNTHETIC_SHAPE;
const PROFILE = validateProfile(profileRaw(SHAPE));
const TAXONOMY = validateTaxonomy(taxonomyRaw(SHAPE), { requireProse: false });

function context(importedKeys: Iterable<string> = []): StructureContext {
  return {
    profile: PROFILE,
    index: taxonomyIndex(TAXONOMY),
    importedKeys: new Set(importedKeys),
    questionKeyPattern: new RegExp(PROFILE.questionKeyPattern),
  };
}

function baseItem(ordinal: number, overrides: Partial<ItemSpec> = {}): ItemSpec {
  return {
    key: `syn-${ordinal}`,
    domainId: "syn-d1",
    topicId: "syn-d1-t1",
    correctIndex: ordinal % 4,
    ...overrides,
  };
}

function itemsFrom(specs: readonly ItemSpec[], file = "batch-001.csv"): Item[] {
  return specs.map((spec, index) => itemFromRow(file, index + 1, itemCells(spec, SHAPE), SHAPE.optionCount));
}

function codes(specs: readonly ItemSpec[], ctx: StructureContext = context()): string[] {
  return [...new Set(runStructureChecks(itemsFrom(specs), ctx).map((finding) => finding.code))].sort();
}

function options(overrides: Array<Partial<OptionSpec> | null | undefined>): Array<OptionSpec | null> {
  const base: Array<OptionSpec | null> = [
    { key: "A", text: "First station choice", correct: false, explanation: "First synthetic rationale for the station." },
    { key: "B", text: "Second station choice", correct: true, explanation: "Second synthetic rationale for the station." },
    { key: "C", text: "Third station choice", correct: false, explanation: "Third synthetic rationale for the station." },
    { key: "D", text: "Fourth station choice", correct: false, explanation: "Fourth synthetic rationale for the station." },
  ];
  return base.map((option, index) => {
    const override = overrides[index];
    if (override === null) return null;
    if (override === undefined) return option;
    return option === null ? null : { ...option, ...override };
  });
}

test("a clean item produces no findings", () => {
  assert.deepEqual(codes([baseItem(1)]), []);
});

test("zero, two and three correct options are refused", () => {
  assert.deepEqual(
    codes([baseItem(1, { options: options([{ correct: false }, { correct: false }]) })]),
    ["CORRECT_OPTION_COUNT"],
  );
  const twoCorrect = runStructureChecks(
    itemsFrom([baseItem(1, { options: options([{ correct: true }, { correct: true }]) })]),
    context(),
  );
  assert.deepEqual(twoCorrect.map((finding) => finding.code), ["CORRECT_OPTION_COUNT"]);
  assert.equal(twoCorrect[0]!.evidence.count, 2);
  assert.deepEqual(
    codes([baseItem(1, { options: options([{ correct: true }, { correct: true }, { correct: true }]) })]),
    ["CORRECT_OPTION_COUNT"],
  );
});

test("a correct flag that is not the literal true or false is an error", () => {
  const cells = itemCells(baseItem(1), SHAPE);
  cells[optionColumnIndices(1).correct] = "TRUE";
  const findings = runStructureChecks(
    [itemFromRow("batch-001.csv", 1, cells, SHAPE.optionCount)],
    context(),
  );
  assert.deepEqual(findings.map((finding) => finding.code), ["CORRECT_FLAG_NOT_BOOLEAN"]);
  assert.equal(findings[0]!.evidence.value, "TRUE");
});

test("three populated slots is an OPTION_COUNT error", () => {
  assert.deepEqual(codes([baseItem(1, { options: options([undefined, undefined, undefined, null]) })]), [
    "OPTION_COUNT",
  ]);
});

test("a gap in the slots is an OPTION_SLOT_GAP error", () => {
  const result = codes([
    baseItem(1, {
      options: options([{ correct: true }, null, { correct: false }, { correct: false }]),
    }),
  ]);
  assert.ok(result.includes("OPTION_SLOT_GAP"), result.join(","));
  assert.ok(result.includes("OPTION_COUNT"), result.join(","));
});

test("a duplicate option key is an error", () => {
  assert.deepEqual(
    codes([baseItem(1, { options: options([{ key: "A" }, { key: "A" }, undefined, undefined]) })]),
    ["OPTION_KEY_DUPLICATE"],
  );
});

test("a distractor without an explanation is an error", () => {
  assert.deepEqual(
    codes([baseItem(1, { options: options([undefined, undefined, { explanation: "" }, undefined]) })]),
    ["EXPLANATION_MISSING"],
  );
});

test("a copied explanation is an error", () => {
  assert.deepEqual(
    codes([
      baseItem(1, {
        options: options([
          undefined,
          { explanation: "The same synthetic sentence for both cells." },
          { explanation: "The same synthetic sentence for both cells." },
          undefined,
        ]),
      }),
    ]),
    ["EXPLANATION_COPY"],
  );
});

test("each field cap is enforced", () => {
  const cases: Array<[string, ItemSpec]> = [
    ["stem", baseItem(1, { stem: "s".repeat(4001) })],
    ["option_1_text", baseItem(1, { options: options([{ text: "o".repeat(1001) }]) })],
    ["option_1_explanation", baseItem(1, { options: options([{ explanation: "e".repeat(3001) }]) })],
    ["source_reference", baseItem(1, { sourceReference: "r".repeat(1001) })],
    ["license_reference", baseItem(1, { licenseReference: "l".repeat(201) })],
    ["question_key", baseItem(1, { key: `syn-${"9".repeat(120)}` })],
    ["option_1_key", baseItem(1, { options: options([{ key: "k".repeat(33) }]) })],
  ];
  for (const [field, spec] of cases) {
    const findings = runStructureChecks(itemsFrom([spec]), context());
    const cap = findings.find((finding) => finding.code === "FIELD_CAP");
    assert.ok(cap !== undefined, `expected a FIELD_CAP finding for ${field}`);
    assert.equal(cap.evidence.field, field);
  }
});

test("a short stem and an empty required field are refused", () => {
  assert.deepEqual(codes([baseItem(1, { stem: "tiny" })]), ["FIELD_CAP"]);
  const missing = runStructureChecks(itemsFrom([baseItem(1, { difficulty: "" })]), context());
  assert.deepEqual(missing.map((finding) => finding.code), ["FIELD_REQUIRED"]);
  assert.equal(missing[0]!.evidence.field, "difficulty");
});

test("an unknown domain or topic key names the offending value in evidence", () => {
  const unknownTopic = runStructureChecks(itemsFrom([baseItem(1, { topicId: "syn-d1-t99" })]), context());
  assert.deepEqual(unknownTopic.map((finding) => finding.code), ["UNKNOWN_TOPIC_KEY"]);
  assert.equal(unknownTopic[0]!.evidence.value, "syn-d1-t99");
  assert.equal(unknownTopic[0]!.scope.questionKey, "syn-1");

  const unknownDomain = runStructureChecks(itemsFrom([baseItem(1, { domainId: "syn-d9" })]), context());
  assert.ok(unknownDomain.some((finding) => finding.code === "UNKNOWN_DOMAIN_KEY"));
});

test("a topic from another domain is a DOMAIN_TOPIC_MISMATCH", () => {
  assert.deepEqual(
    codes([baseItem(1, { domainId: "syn-d1", topicId: "syn-d2-t1" })]),
    ["DOMAIN_TOPIC_MISMATCH"],
  );
});

test("a duplicate key in one file is refused, first occurrence named", () => {
  const findings = runStructureChecks(
    itemsFrom([baseItem(1), baseItem(2, { key: "syn-1" })]),
    context(),
  );
  assert.deepEqual(findings.map((finding) => finding.code), ["DUPLICATE_QUESTION_KEY"]);
  assert.equal(findings[0]!.scope.row, 2);
  assert.equal(findings[0]!.evidence.firstFile, "batch-001.csv");
  assert.equal(findings[0]!.evidence.firstRow, 1);
});

test("a duplicate key across two files is refused", () => {
  const first = itemFromRow("batch-001.csv", 1, itemCells(baseItem(1), SHAPE), SHAPE.optionCount);
  const second = itemFromRow("batch-002.csv", 1, itemCells(baseItem(1), SHAPE), SHAPE.optionCount);
  const findings = runStructureChecks([first, second], context());
  assert.deepEqual(findings.map((finding) => finding.code), ["DUPLICATE_QUESTION_KEY"]);
  assert.equal(findings[0]!.scope.file, "batch-002.csv");
});

test("a key already in the platform is refused", () => {
  const findings = runStructureChecks(itemsFrom([baseItem(2)]), context(["syn-2"]));
  assert.deepEqual(findings.map((finding) => finding.code), ["KEY_ALREADY_IMPORTED"]);
  assert.equal(findings[0]!.evidence.key, "syn-2");
});

test("a key outside the profile pattern is refused", () => {
  assert.deepEqual(codes([baseItem(1, { key: "syn-0" })]), ["QUESTION_KEY_INVALID"]);
});

test("a wrong exam version, format version or difficulty is refused", () => {
  assert.deepEqual(codes([baseItem(1, { examVersionId: "syn-exam-v2" })]), ["EXAM_VERSION_MISMATCH"]);
  assert.deepEqual(codes([baseItem(1, { formatVersion: "certpath-question-v2" })]), ["FORMAT_VERSION"]);
  assert.deepEqual(codes([baseItem(1, { difficulty: "expert" })]), ["DIFFICULTY_INVALID"]);
});
