import assert from "node:assert/strict";
import test from "node:test";
import { QuestionCheckError } from "./errors.ts";
import { SYNTHETIC_SHAPE, taxonomyRaw } from "./fixtures.ts";
import { validateTaxonomy } from "./taxonomy.ts";
import { validateProfile } from "./profile.ts";
import { profileRaw } from "./fixtures.ts";

function expectCode(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof QuestionCheckError, `expected QuestionCheckError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

function rawWith(domains: unknown[]): Record<string, unknown> {
  return { ...taxonomyRaw(SYNTHETIC_SHAPE), domains };
}

const DOMAINS = taxonomyRaw(SYNTHETIC_SHAPE).domains as Array<Record<string, unknown>>;

test("the synthetic taxonomy is valid and prose-free validation allows blank prose", () => {
  const taxonomy = validateTaxonomy(taxonomyRaw(SYNTHETIC_SHAPE, { blankProse: true }), {
    requireProse: false,
  });
  assert.equal(taxonomy.domains.length, 4);
  assert.equal(taxonomy.domains[0]!.topics.length, 3);
});

test("a blank topic title fails the taxonomy verb", () => {
  expectCode(
    () => validateTaxonomy(taxonomyRaw(SYNTHETIC_SHAPE, { blankProse: true }), { requireProse: true }),
    "TAXONOMY_TITLE_BLANK",
  );
});

test("a blank topic meaning fails the taxonomy verb", () => {
  const domains = structuredClone(DOMAINS) as Array<{ topics: Array<{ meaning: string }> }>;
  domains[0]!.topics[1]!.meaning = "";
  const raw = { ...taxonomyRaw(SYNTHETIC_SHAPE), domains };
  assert.throws(
    () => validateTaxonomy(raw, { requireProse: true }),
    (error: unknown) =>
      error instanceof QuestionCheckError && error.code === "TAXONOMY_MEANING_BLANK",
  );
});

test("a topic id must be namespaced by its domain id", () => {
  const domains = structuredClone(DOMAINS) as Array<{ topics: Array<{ id: string }> }>;
  domains[0]!.topics[0]!.id = "syn-d2-t9";
  expectCode(() => validateTaxonomy(rawWith(domains), { requireProse: false }), "TAXONOMY_INVALID");
});

test("duplicate domain ids and duplicate topic ids are refused", () => {
  const duplicatedDomain = structuredClone(DOMAINS);
  duplicatedDomain[1]!.id = duplicatedDomain[0]!.id;
  expectCode(() => validateTaxonomy(rawWith(duplicatedDomain), { requireProse: false }), "TAXONOMY_INVALID");

  const duplicatedTopic = structuredClone(DOMAINS) as Array<{ topics: Array<{ id: string }> }>;
  duplicatedTopic[0]!.topics[1]!.id = duplicatedTopic[0]!.topics[0]!.id;
  expectCode(() => validateTaxonomy(rawWith(duplicatedTopic), { requireProse: false }), "TAXONOMY_INVALID");
});

test("titles and meanings over their caps are refused", () => {
  const longTitle = structuredClone(DOMAINS) as Array<{ topics: Array<{ title: string }> }>;
  longTitle[0]!.topics[0]!.title = "t".repeat(161);
  expectCode(() => validateTaxonomy(rawWith(longTitle), { requireProse: true }), "TAXONOMY_INVALID");

  const longMeaning = structuredClone(DOMAINS) as Array<{ topics: Array<{ meaning: string }> }>;
  longMeaning[0]!.topics[0]!.meaning = "m".repeat(2001);
  expectCode(() => validateTaxonomy(rawWith(longMeaning), { requireProse: true }), "TAXONOMY_INVALID");
});

test("unknown taxonomy keys are refused", () => {
  expectCode(
    () => validateTaxonomy({ ...taxonomyRaw(SYNTHETIC_SHAPE), weight: 0.18 }, { requireProse: false }),
    "TAXONOMY_INVALID",
  );
});

test("the profile carries no taxonomy domain that the taxonomy lacks, or the reverse", () => {
  const profile = validateProfile(profileRaw(SYNTHETIC_SHAPE));
  assert.equal(profile.domains.length, 4);
  assert.equal(new Set(profile.domains.map((domain) => domain.id)).size, 4);
});
