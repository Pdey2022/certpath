import assert from "node:assert/strict";
import test from "node:test";
import { computeDistribution } from "./checks/distribution.ts";
import {
  CISM_SHAPE,
  SYNTHETIC_SHAPE,
  bankItems,
  itemCells,
  profileRaw,
  profileText,
  type BankShape,
  type ItemSpec,
} from "./fixtures.ts";
import { itemFromRow, type Item } from "./parse.ts";
import { loadProfile, validateProfile } from "./profile.ts";

function itemsFor(shape: BankShape, rowsPerDomain: readonly number[], perFile = 10): Item[] {
  return itemsFromSpecs(shape, bankItems(shape, rowsPerDomain), perFile);
}

function itemsFromSpecs(shape: BankShape, specs: readonly ItemSpec[], perFile = 10): Item[] {
  return specs.map((spec, index) =>
    itemFromRow(
      `batch-${String(Math.floor(index / perFile) + 1).padStart(3, "0")}.csv`,
      (index % perFile) + 1,
      itemCells(spec, shape),
      shape.optionCount,
    ),
  );
}

/** One item per file, so a position test cannot trip the per-file monotone rule. */
function isolatedItems(shape: BankShape, count: number, position: (index: number) => number): Item[] {
  return Array.from({ length: count }, (_, index) =>
    itemFromRow(
      `item-${String(index + 1).padStart(3, "0")}.csv`,
      1,
      itemCells(
        {
          key: `syn-${index + 1}`,
          domainId: shape.domainIds[index % shape.domainIds.length]!,
          topicId: `${shape.domainIds[index % shape.domainIds.length]!}-t1`,
          // `correctIndex` is zero-based, so `position` returns 0..3 here.
          correctIndex: position(index),
        },
        shape,
      ),
      shape.optionCount,
    ),
  );
}

const CISM_PROFILE = loadProfile(profileText(CISM_SHAPE));

test("100 items at 40/20/20/20 fail complete mode on three domains", () => {
  const items = itemsFor(CISM_SHAPE, [40, 20, 20, 20]);
  const complete = computeDistribution(items, CISM_PROFILE, "complete");
  const deviations = complete.findings.filter((finding) => finding.code === "DOMAIN_WEIGHT_DEVIATION");
  assert.deepEqual(
    deviations.map((finding) => [finding.scope.domainId, finding.severity]),
    [
      ["cism-d1", "error"],
      ["cism-d3", "error"],
      ["cism-d4", "error"],
    ],
  );
  assert.deepEqual(
    complete.byDomain.map((domain) => [domain.domainId, domain.observedShare, domain.delta, domain.verdict]),
    [
      ["cism-d1", 0.4, 0.22, "error"],
      ["cism-d2", 0.2, 0, "ok"],
      ["cism-d3", 0.2, -0.13, "error"],
      ["cism-d4", 0.2, -0.09, "error"],
    ],
  );
  assert.equal(complete.byDomain[0]!.slack, 0.05);
});

test("the same 100 items pass in partial mode, with the deviations as warnings", () => {
  const items = itemsFor(CISM_SHAPE, [40, 20, 20, 20]);
  const partial = computeDistribution(items, CISM_PROFILE, "partial");
  const deviations = partial.findings.filter((finding) => finding.code === "DOMAIN_WEIGHT_DEVIATION");
  assert.equal(deviations.length, 3);
  assert.ok(deviations.every((finding) => finding.severity === "warning"));
  assert.deepEqual(
    partial.findings
      .filter((finding) => finding.code === "DOMAIN_OVER_TARGET" || finding.code === "DOMAIN_UNDER_TARGET")
      .map((finding) => finding.code),
    ["DOMAIN_OVER_TARGET", "DOMAIN_UNDER_TARGET", "DOMAIN_UNDER_TARGET"],
  );
});

test("a blueprint-weighted 600-item bank has no domain findings and 3 repeat-free mocks", () => {
  const items = itemsFor(CISM_SHAPE, [108, 120, 198, 174]);
  assert.equal(items.length, 600);
  const result = computeDistribution(items, CISM_PROFILE, "complete");
  assert.deepEqual(
    result.findings.filter((finding) => finding.code.startsWith("DOMAIN_")),
    [],
  );
  assert.deepEqual(result.coverage.mockDraw, {
    "cism-d1": 27,
    "cism-d2": 30,
    "cism-d3": 50,
    "cism-d4": 43,
  });
  assert.equal(result.coverage.repeatFreeMocks, 3);
  assert.equal(result.coverage.bindingDomain, "cism-d3");
});

test("a weighted domain with no rows is an error in partial mode too", () => {
  const shape = SYNTHETIC_SHAPE;
  const profile = validateProfile(profileRaw(shape));
  const items = itemsFor(shape, [6, 0, 0, 0]);
  const result = computeDistribution(items, profile, "partial");
  const missing = result.findings.filter((finding) => finding.code === "DOMAIN_MISSING");
  assert.deepEqual(
    missing.map((finding) => [finding.scope.domainId, finding.severity]),
    [
      ["syn-d2", "error"],
      ["syn-d3", "error"],
      ["syn-d4", "error"],
    ],
  );
});

test("a short bank is a BANK_VOLUME_SHORTFALL warning", () => {
  const items = itemsFor(CISM_SHAPE, [10, 10, 10, 10]);
  const result = computeDistribution(items, CISM_PROFILE, "partial");
  const shortfall = result.findings.find((finding) => finding.code === "BANK_VOLUME_SHORTFALL");
  assert.ok(shortfall !== undefined);
  assert.equal(shortfall.evidence.rows, 40);
  assert.equal(shortfall.evidence.targetRows, 600);
});

test("a 10-row batch with every answer at position 1 is monotone", () => {
  const items = itemsFromSpecs(
    SYNTHETIC_SHAPE,
    Array.from({ length: 10 }, (_, index) => ({
      key: `syn-${index + 1}`,
      domainId: "syn-d1",
      topicId: "syn-d1-t1",
      correctIndex: 0,
    })),
    10,
  );
  const profile = validateProfile(profileRaw(SYNTHETIC_SHAPE));
  const result = computeDistribution(items, profile, "partial");
  const monotone = result.findings.filter((finding) => finding.code === "ANSWER_POSITION_MONOTONE");
  assert.equal(monotone.length, 1);
  assert.equal(monotone[0]!.scope.file, "batch-001.csv");
  assert.equal(monotone[0]!.evidence.position, 1);
  assert.equal(result.answerPosition.verdict, "error");
});

test("the monotone rule applies at four rows and not at three", () => {
  const four = itemsFromSpecs(
    SYNTHETIC_SHAPE,
    Array.from({ length: 4 }, (_, index) => ({
      key: `syn-${index + 1}`,
      domainId: "syn-d1",
      topicId: "syn-d1-t1",
      correctIndex: 0,
    })),
    4,
  );
  const profile = validateProfile(profileRaw(SYNTHETIC_SHAPE));
  assert.equal(
    computeDistribution(four, profile, "partial").findings.filter(
      (finding) => finding.code === "ANSWER_POSITION_MONOTONE",
    ).length,
    1,
  );

  const three = four.slice(0, 3);
  assert.equal(
    computeDistribution(three, profile, "partial").findings.filter(
      (finding) => finding.code === "ANSWER_POSITION_MONOTONE",
    ).length,
    0,
  );
});

test("a 40-row run at exactly 40% on one position is ANSWER_POSITION_BIASED", () => {
  const profile = validateProfile(profileRaw(SYNTHETIC_SHAPE));
  const items = isolatedItems(SYNTHETIC_SHAPE, 40, (index) => (index < 16 ? 0 : (index % 3) + 1));
  const result = computeDistribution(items, profile, "partial");
  const biased = result.findings.find((finding) => finding.code === "ANSWER_POSITION_BIASED");
  assert.ok(biased !== undefined);
  assert.equal(biased.evidence.share, 0.4);
  assert.equal(result.answerPosition.maxShare, 0.4);
  assert.equal(result.answerPosition.verdict, "error");
});

test("39 rows at the same share is not judged: the minimum row count binds", () => {
  const profile = validateProfile(profileRaw(SYNTHETIC_SHAPE));
  const items = isolatedItems(SYNTHETIC_SHAPE, 39, (index) => (index < 16 ? 0 : (index % 3) + 1));
  const result = computeDistribution(items, profile, "partial");
  assert.equal(
    result.findings.filter((finding) => finding.code === "ANSWER_POSITION_BIASED").length,
    0,
  );
  assert.equal(
    result.findings.filter((finding) => finding.code === "ANSWER_POSITION_SKEW").length,
    0,
  );
  assert.equal(result.answerPosition.verdict, "ok");
  assert.equal(result.answerPosition.maxShare, 0.410256);
});

test("a 32–40% share on 40 rows is ANSWER_POSITION_SKEW", () => {
  const profile = validateProfile(profileRaw(SYNTHETIC_SHAPE));
  const items = isolatedItems(SYNTHETIC_SHAPE, 40, (index) => (index < 13 ? 0 : (index % 3) + 1));
  const result = computeDistribution(items, profile, "partial");
  const skew = result.findings.find((finding) => finding.code === "ANSWER_POSITION_SKEW");
  assert.ok(skew !== undefined);
  assert.equal(skew.evidence.share, 0.325);
  assert.equal(result.answerPosition.verdict, "warning");
});

test("a null difficulty target warns and never errors (F3)", () => {
  const profile = validateProfile(profileRaw(SYNTHETIC_SHAPE, { difficultyTargets: null }));
  const items = itemsFor(SYNTHETIC_SHAPE, [3, 3, 3, 3]);
  const result = computeDistribution(items, profile, "complete");
  const unset = result.findings.find((finding) => finding.code === "DIFFICULTY_TARGET_UNSET");
  assert.ok(unset !== undefined);
  assert.equal(unset.severity, "warning");
  assert.deepEqual(
    result.byDifficulty.map((entry) => entry.target),
    [null, null, null],
  );
});

test("a difficulty distribution at or over 80% is a concentration warning", () => {
  const profile = validateProfile(profileRaw(SYNTHETIC_SHAPE));
  const specs: ItemSpec[] = Array.from({ length: 12 }, (_, index) => ({
    key: `syn-${index + 1}`,
    domainId: SYNTHETIC_SHAPE.domainIds[index % 4]!,
    topicId: `${SYNTHETIC_SHAPE.domainIds[index % 4]!}-t1`,
    difficulty: index < 10 ? "medium" : "easy",
    correctIndex: index % 4,
  }));
  const result = computeDistribution(itemsFromSpecs(SYNTHETIC_SHAPE, specs), profile, "partial");
  const concentration = result.findings.find((finding) => finding.code === "DIFFICULTY_CONCENTRATION");
  assert.ok(concentration !== undefined);
  assert.equal(concentration.evidence.difficulty, "medium");
});

test("a topic holding more than 35% of its domain is a warning", () => {
  const profile = validateProfile(profileRaw(SYNTHETIC_SHAPE));
  const specs: ItemSpec[] = Array.from({ length: 12 }, (_, index) => ({
    key: `syn-${index + 1}`,
    domainId: "syn-d1",
    topicId: index < 6 ? "syn-d1-t1" : `syn-d1-t${(index % 2) + 2}`,
    correctIndex: index % 4,
  }));
  const result = computeDistribution(itemsFromSpecs(SYNTHETIC_SHAPE, specs), profile, "partial");
  const concentration = result.findings.find((finding) => finding.code === "TOPIC_CONCENTRATION");
  assert.ok(concentration !== undefined);
  assert.equal(concentration.evidence.topicId, "syn-d1-t1");
  assert.equal(concentration.evidence.share, 0.5);
});
