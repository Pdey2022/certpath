import { TAXONOMY_FORMAT_VERSION } from "./contract.ts";
import { QuestionCheckError } from "./errors.ts";
import type { QuestionProfile } from "./profile.ts";

/**
 * The taxonomy is identity plus prose. Identity (ids, keys, order) is what the
 * validator needs to judge a batch; prose (title, meaning) is what the owner
 * approves, and a topic with a blank title or meaning is not approved prose.
 *
 * `check` validates identity only, because a batch can be checked before the
 * prose is written. `taxonomy` is the gate that requires the prose, which is
 * why it is run before the first item is authored.
 */
export interface TaxonomyTopic {
  id: string;
  title: string;
  meaning: string;
}

export interface TaxonomyDomain {
  id: string;
  title: string;
  topics: TaxonomyTopic[];
}

export interface Taxonomy {
  formatVersion: string;
  certificationKey: string;
  examVersionId: string;
  domains: TaxonomyDomain[];
}

export interface TaxonomyIndex {
  domainIds: Set<string>;
  topicDomain: Map<string, string>;
  domainOf: Map<string, TaxonomyDomain>;
}

export interface LoadTaxonomyOptions {
  /** `taxonomy` verb: blank title or meaning is a refusal. `check`: not. */
  requireProse: boolean;
}

const TITLE_MAXIMUM = 160;
const MEANING_MAXIMUM = 2000;

function invalid(reason: string, info: Record<string, string | number | boolean | null> = {}): never {
  throw new QuestionCheckError("TAXONOMY_INVALID", reason, { info });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value).sort()) {
    if (!allowed.includes(key)) invalid(`${where} has an unknown key`, { key });
  }
}

function nonEmptyId(value: unknown, where: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    invalid(`${where} must be a lower-case id`, { where });
  }
  return value;
}

export function loadTaxonomy(text: string, options: LoadTaxonomyOptions): Taxonomy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new QuestionCheckError("TAXONOMY_INVALID_JSON", "the taxonomy is not valid JSON");
  }
  return validateTaxonomy(raw, options);
}

export function validateTaxonomy(raw: unknown, options: LoadTaxonomyOptions): Taxonomy {
  if (!isRecord(raw)) invalid("the taxonomy must be a JSON object");
  assertOnlyKeys(raw, ["formatVersion", "certificationKey", "examVersionId", "domains"], "taxonomy");
  if (raw.formatVersion !== TAXONOMY_FORMAT_VERSION) {
    invalid("unsupported taxonomy formatVersion", { formatVersion: String(raw.formatVersion) });
  }
  if (typeof raw.certificationKey !== "string" || raw.certificationKey.length === 0) {
    invalid("certificationKey must be a non-empty string");
  }
  if (typeof raw.examVersionId !== "string" || raw.examVersionId.length === 0) {
    invalid("examVersionId must be a non-empty string");
  }
  if (!Array.isArray(raw.domains) || raw.domains.length === 0) {
    invalid("domains must be a non-empty array");
  }

  const domainIds = new Set<string>();
  const topicIds = new Set<string>();
  const domains: TaxonomyDomain[] = raw.domains.map((entry, domainIndex) => {
    if (!isRecord(entry)) invalid(`domains[${domainIndex}] must be an object`, { domainIndex });
    assertOnlyKeys(entry, ["id", "title", "topics"], `domains[${domainIndex}]`);
    const id = nonEmptyId(entry.id, `domains[${domainIndex}].id`);
    if (domainIds.has(id)) invalid("duplicate domain id", { id });
    domainIds.add(id);
    const title = typeof entry.title === "string" ? entry.title : invalid("domain title must be a string", { id });
    if (!Array.isArray(entry.topics) || entry.topics.length === 0) {
      invalid("a domain must have at least one topic", { id });
    }
    const topics: TaxonomyTopic[] = entry.topics.map((topic, topicIndex) => {
      if (!isRecord(topic)) invalid(`domains[${domainIndex}].topics[${topicIndex}] must be an object`);
      assertOnlyKeys(topic, ["id", "title", "meaning"], `domains[${domainIndex}].topics[${topicIndex}]`);
      const topicId = nonEmptyId(topic.id, `domains[${domainIndex}].topics[${topicIndex}].id`);
      if (topicIds.has(topicId)) invalid("duplicate topic id", { id: topicId });
      if (!topicId.startsWith(`${id}-`)) {
        invalid("a topic id must be namespaced by its domain id", { id: topicId, domainId: id });
      }
      topicIds.add(topicId);
      const topicTitle = typeof topic.title === "string" ? topic.title : invalid("topic title must be a string", { id: topicId });
      const meaning = typeof topic.meaning === "string" ? topic.meaning : invalid("topic meaning must be a string", { id: topicId });
      if (topicTitle.length > TITLE_MAXIMUM) {
        invalid("topic title is over its cap", { id: topicId, maximum: TITLE_MAXIMUM });
      }
      if (meaning.length > MEANING_MAXIMUM) {
        invalid("topic meaning is over its cap", { id: topicId, maximum: MEANING_MAXIMUM });
      }
      if (options.requireProse && topicTitle.trim().length === 0) {
        throw new QuestionCheckError("TAXONOMY_TITLE_BLANK", "a topic title is blank", {
          info: { id: topicId },
        });
      }
      if (options.requireProse && meaning.trim().length === 0) {
        throw new QuestionCheckError("TAXONOMY_MEANING_BLANK", "a topic meaning is blank", {
          info: { id: topicId },
        });
      }
      return { id: topicId, title: topicTitle, meaning };
    });
    return { id, title, topics };
  });

  return {
    formatVersion: TAXONOMY_FORMAT_VERSION,
    certificationKey: raw.certificationKey,
    examVersionId: raw.examVersionId,
    domains,
  };
}

export function taxonomyIndex(taxonomy: Taxonomy): TaxonomyIndex {
  const domainIds = new Set<string>();
  const topicDomain = new Map<string, string>();
  const domainOf = new Map<string, TaxonomyDomain>();
  for (const domain of taxonomy.domains) {
    domainIds.add(domain.id);
    domainOf.set(domain.id, domain);
    for (const topic of domain.topics) topicDomain.set(topic.id, domain.id);
  }
  return { domainIds, topicDomain, domainOf };
}

/** The profile and the taxonomy must name the same domains; neither may drift. */
export function assertDomainSetsMatch(profile: QuestionProfile, taxonomy: Taxonomy): void {
  const profileIds = new Set(profile.domains.map((domain) => domain.id));
  const taxonomyIds = new Set(taxonomy.domains.map((domain) => domain.id));
  const missing = [...profileIds].filter((id) => !taxonomyIds.has(id)).sort();
  const extra = [...taxonomyIds].filter((id) => !profileIds.has(id)).sort();
  if (missing.length > 0 || extra.length > 0) {
    throw new QuestionCheckError(
      "TAXONOMY_DOMAIN_SET_MISMATCH",
      "the profile and the taxonomy name different domains",
      { info: { missingInTaxonomy: missing.join(","), missingInProfile: extra.join(",") } },
    );
  }
  if (taxonomy.examVersionId !== profile.examVersionId) {
    invalid("the taxonomy examVersionId differs from the profile's", {
      taxonomy: taxonomy.examVersionId,
      profile: profile.examVersionId,
    });
  }
}
