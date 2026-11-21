import assert from "node:assert/strict";
import test from "node:test";
import { QuestionCheckError } from "./errors.ts";
import {
  CISM_SHAPE,
  SYNTHETIC_SHAPE,
  largestRemainder,
  profileRaw,
  profileText,
  shapeFromRows,
  taxonomyRaw,
} from "./fixtures.ts";
import {
  coverage,
  domainSlack,
  loadProfile,
  mockDraw,
  validateProfile,
} from "./profile.ts";
import { assertDomainSetsMatch, validateTaxonomy } from "./taxonomy.ts";

function expectCode(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof QuestionCheckError, `expected QuestionCheckError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("the committed CISM profile loads and allocates 108/120/198/174", () => {
  const profile = loadProfile(profileText(CISM_SHAPE));
  assert.deepEqual(
    profile.domains.map((domain) => domain.targetRows),
    [108, 120, 198, 174],
  );
  assert.deepEqual(largestRemainder(profile.domains.map((domain) => domain.weightShare), 600), [
    108, 120, 198, 174,
  ]);
});

test("the mock draw is 27/30/50/43 and the tie is broken by profile order", () => {
  const profile = loadProfile(profileText(CISM_SHAPE));
  assert.deepEqual(mockDraw(profile), [
    { domainId: "cism-d1", questions: 27 },
    { domainId: "cism-d2", questions: 30 },
    { domainId: "cism-d3", questions: 50 },
    { domainId: "cism-d4", questions: 43 },
  ]);
});

test("coverage reports 3 repeat-free mocks, bound by the programme domain", () => {
  const profile = loadProfile(profileText(CISM_SHAPE));
  const result = coverage(
    profile,
    new Map([
      ["cism-d1", 108],
      ["cism-d2", 120],
      ["cism-d3", 198],
      ["cism-d4", 174],
    ]),
  );
  assert.equal(result.repeatFreeMocks, 3);
  assert.equal(result.bindingDomain, "cism-d3");
});

test("a 602-row bank with programme at 200 reports 4 repeat-free mocks", () => {
  const shape = shapeFromRows(["cism-d1", "cism-d2", "cism-d3", "cism-d4"], [108, 120, 200, 174], {
    questionKeyPrefix: "cism",
  });
  const profile = loadProfile(profileText(shape));
  assert.deepEqual(
    profile.domains.map((domain) => domain.targetRows),
    [108, 120, 200, 174],
  );
  const result = coverage(
    profile,
    new Map([
      ["cism-d1", 108],
      ["cism-d2", 120],
      ["cism-d3", 200],
      ["cism-d4", 174],
    ]),
  );
  assert.equal(result.repeatFreeMocks, 4);
});

test("weights that do not sum to 1 are refused", () => {
  const raw = profileRaw(SYNTHETIC_SHAPE);
  const domains = raw.domains as Array<{ weightShare: number }>;
  domains[0]!.weightShare = 0.3;
  expectCode(() => validateProfile(raw), "PROFILE_INVALID");
});

test("domain targetRows that disagree with the allocation are refused", () => {
  const raw = profileRaw(SYNTHETIC_SHAPE);
  const domains = raw.domains as Array<{ targetRows: number }>;
  domains[0]!.targetRows = 4;
  domains[1]!.targetRows = 2;
  expectCode(() => validateProfile(raw), "PROFILE_INVALID");
});

test("targetRows that disagree with the domain sum are refused", () => {
  const raw = profileRaw(SYNTHETIC_SHAPE, { targetRows: 13 });
  expectCode(() => validateProfile(raw), "PROFILE_INVALID");
});

test("an unknown profile key is refused", () => {
  expectCode(() => validateProfile(profileRaw(SYNTHETIC_SHAPE, { extra: 1 })), "PROFILE_INVALID");
});

test("difficultyTargets is null or a distribution summing to 1", () => {
  const nullable = validateProfile(profileRaw(SYNTHETIC_SHAPE, { difficultyTargets: null }));
  assert.equal(nullable.difficultyTargets, null);
  const set = validateProfile(
    profileRaw(SYNTHETIC_SHAPE, { difficultyTargets: { easy: 0.33, medium: 0.34, hard: 0.33 } }),
  );
  assert.deepEqual(set.difficultyTargets, { easy: 0.33, medium: 0.34, hard: 0.33 });
  expectCode(
    () => validateProfile(profileRaw(SYNTHETIC_SHAPE, { difficultyTargets: { easy: 0.5, medium: 0.4, hard: 0.05 } })),
    "PROFILE_INVALID",
  );
});

test("the profile and taxonomy must name the same domains", () => {
  const profile = validateProfile(profileRaw(SYNTHETIC_SHAPE));
  const taxonomy = validateTaxonomy(taxonomyRaw(SYNTHETIC_SHAPE), { requireProse: false });
  assertDomainSetsMatch(profile, taxonomy);
  const narrower = validateTaxonomy(
    { ...taxonomyRaw(SYNTHETIC_SHAPE), domains: (taxonomyRaw(SYNTHETIC_SHAPE).domains as unknown[]).slice(0, 3) },
    { requireProse: false },
  );
  expectCode(() => assertDomainSetsMatch(profile, narrower), "TAXONOMY_DOMAIN_SET_MISMATCH");
});

test("the domain slack is the larger of the share and the item allowance", () => {
  const profile = validateProfile(profileRaw(SYNTHETIC_SHAPE));
  assert.equal(domainSlack(profile, 100), 0.05);
  assert.equal(domainSlack(profile, 10), 0.3);
  assert.equal(domainSlack(profile, 0), 0.05);
});
