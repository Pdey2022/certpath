import { OPTION_SLOTS, PROFILE_FORMAT_VERSION } from "./contract.ts";
import { QuestionCheckError } from "./errors.ts";

/**
 * The blueprint profile: the run's numbers, all of them from the owner.
 *
 * Nothing here is a product rule the tool invents. The weights, the target row
 * count, the option count and the difficulty targets are owner input; when a
 * value has not been decided the profile carries `null` and the tool warns.
 */
export interface DomainProfile {
  id: string;
  weightShare: number;
  targetRows: number;
}

export interface DifficultyTargets {
  easy: number;
  medium: number;
  hard: number;
}

export interface ReferenceProcess {
  id: string;
  title: string;
  steps: string[];
}

export interface AnswerPositionSettings {
  monotoneBatchMinimum: number;
  biasedMinimumRows: number;
  biasedShare: number;
  skewShare: number;
}

export interface NearDuplicateSettings {
  shingleSize: number;
  threshold: number;
}

export interface QuestionProfile {
  formatVersion: string;
  certificationKey: string;
  examVersionId: string;
  targetRows: number;
  examQuestionCount: number;
  optionCount: number;
  questionKeyPattern: string;
  domains: DomainProfile[];
  difficultyTargets: DifficultyTargets | null;
  catchAllTopicKeys: string[];
  maxDomainShareDeviation: number;
  maxDomainDeviationSlackItems: number;
  answerPosition: AnswerPositionSettings;
  nearDuplicate: NearDuplicateSettings;
  referenceProcesses: ReferenceProcess[];
}

export const DIFFICULTY_ORDER = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTY_ORDER)[number];

const PROFILE_KEYS = [
  "formatVersion",
  "certificationKey",
  "examVersionId",
  "targetRows",
  "examQuestionCount",
  "optionCount",
  "questionKeyPattern",
  "domains",
  "difficultyTargets",
  "catchAllTopicKeys",
  "maxDomainShareDeviation",
  "maxDomainDeviationSlackItems",
  "answerPosition",
  "nearDuplicate",
  "referenceProcesses",
] as const;

function invalid(reason: string, info: Record<string, string | number | boolean | null> = {}): never {
  throw new QuestionCheckError("PROFILE_INVALID", reason, { info });
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

function numberInRange(
  value: unknown,
  where: string,
  minimum: number,
  maximum: number,
  { integer = false }: { integer?: boolean } = {},
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(`${where} must be a number`, { where });
  }
  if (integer && !Number.isInteger(value)) invalid(`${where} must be an integer`, { where });
  if (value < minimum || value > maximum) {
    invalid(`${where} is out of range`, { where, minimum, maximum });
  }
  return value;
}

function nonEmptyString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${where} must be a non-empty string`, { where });
  }
  return value;
}

function round(value: number, places = 6): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function loadProfile(text: string): QuestionProfile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new QuestionCheckError("PROFILE_INVALID_JSON", "the profile is not valid JSON");
  }
  return validateProfile(raw);
}

export function validateProfile(raw: unknown): QuestionProfile {
  if (!isRecord(raw)) invalid("the profile must be a JSON object");
  assertOnlyKeys(raw, PROFILE_KEYS, "profile");

  if (raw.formatVersion !== PROFILE_FORMAT_VERSION) {
    invalid("unsupported profile formatVersion", { formatVersion: String(raw.formatVersion) });
  }
  const certificationKey = nonEmptyString(raw.certificationKey, "certificationKey");
  const examVersionId = nonEmptyString(raw.examVersionId, "examVersionId");
  const targetRows = numberInRange(raw.targetRows, "targetRows", 1, 1_000_000, { integer: true });
  const examQuestionCount = numberInRange(
    raw.examQuestionCount,
    "examQuestionCount",
    1,
    10_000,
    { integer: true },
  );
  const optionCount = numberInRange(raw.optionCount, "optionCount", 1, OPTION_SLOTS, {
    integer: true,
  });
  const questionKeyPattern = nonEmptyString(raw.questionKeyPattern, "questionKeyPattern");
  try {
    new RegExp(questionKeyPattern);
  } catch {
    invalid("questionKeyPattern does not compile");
  }

  if (!Array.isArray(raw.domains) || raw.domains.length === 0) {
    invalid("domains must be a non-empty array");
  }
  const seen = new Set<string>();
  const domains: DomainProfile[] = raw.domains.map((entry, index) => {
    if (!isRecord(entry)) invalid(`domains[${index}] must be an object`, { index });
    assertOnlyKeys(entry, ["id", "weightShare", "targetRows"], `domains[${index}]`);
    const id = nonEmptyString(entry.id, `domains[${index}].id`);
    if (seen.has(id)) invalid("duplicate domain id", { id });
    seen.add(id);
    const weightShare = numberInRange(entry.weightShare, `domains[${index}].weightShare`, 0, 1);
    const rows = numberInRange(entry.targetRows, `domains[${index}].targetRows`, 0, 1_000_000, {
      integer: true,
    });
    return { id, weightShare, targetRows: rows };
  });

  const weightSum = domains.reduce((total, domain) => total + domain.weightShare, 0);
  if (Math.abs(weightSum - 1) > 1e-9) {
    invalid("domain weightShare values do not sum to 1", { weightSum: round(weightSum) });
  }

  const rowSum = domains.reduce((total, domain) => total + domain.targetRows, 0);
  if (rowSum !== targetRows) {
    invalid("domain targetRows do not sum to targetRows", { rowSum, targetRows });
  }
  const allocated = largestRemainder(
    domains.map((domain) => domain.weightShare),
    targetRows,
  );
  domains.forEach((domain, index) => {
    if (allocated[index] !== domain.targetRows) {
      invalid("domain targetRows disagree with the largest-remainder allocation", {
        id: domain.id,
        expected: allocated[index] ?? null,
        actual: domain.targetRows,
      });
    }
  });

  let difficultyTargets: DifficultyTargets | null = null;
  if (raw.difficultyTargets !== null) {
    if (!isRecord(raw.difficultyTargets)) {
      invalid("difficultyTargets must be null or an object");
    }
    assertOnlyKeys(raw.difficultyTargets, DIFFICULTY_ORDER, "difficultyTargets");
    const easy = numberInRange(raw.difficultyTargets.easy, "difficultyTargets.easy", 0, 1);
    const medium = numberInRange(raw.difficultyTargets.medium, "difficultyTargets.medium", 0, 1);
    const hard = numberInRange(raw.difficultyTargets.hard, "difficultyTargets.hard", 0, 1);
    const sum = easy + medium + hard;
    if (Math.abs(sum - 1) > 1e-9) {
      invalid("difficultyTargets do not sum to 1", { sum: round(sum) });
    }
    difficultyTargets = { easy, medium, hard };
  }

  if (!Array.isArray(raw.catchAllTopicKeys)) invalid("catchAllTopicKeys must be an array");
  const catchAllTopicKeys = raw.catchAllTopicKeys.map((value, index) =>
    nonEmptyString(value, `catchAllTopicKeys[${index}]`),
  );

  const maxDomainShareDeviation = numberInRange(
    raw.maxDomainShareDeviation,
    "maxDomainShareDeviation",
    0,
    1,
  );
  const maxDomainDeviationSlackItems = numberInRange(
    raw.maxDomainDeviationSlackItems,
    "maxDomainDeviationSlackItems",
    0,
    10_000,
    { integer: true },
  );

  if (!isRecord(raw.answerPosition)) invalid("answerPosition must be an object");
  assertOnlyKeys(
    raw.answerPosition,
    ["monotoneBatchMinimum", "biasedMinimumRows", "biasedShare", "skewShare"],
    "answerPosition",
  );
  const answerPosition: AnswerPositionSettings = {
    monotoneBatchMinimum: numberInRange(
      raw.answerPosition.monotoneBatchMinimum,
      "answerPosition.monotoneBatchMinimum",
      1,
      1_000_000,
      { integer: true },
    ),
    biasedMinimumRows: numberInRange(
      raw.answerPosition.biasedMinimumRows,
      "answerPosition.biasedMinimumRows",
      1,
      1_000_000,
      { integer: true },
    ),
    biasedShare: numberInRange(raw.answerPosition.biasedShare, "answerPosition.biasedShare", 0, 1),
    skewShare: numberInRange(raw.answerPosition.skewShare, "answerPosition.skewShare", 0, 1),
  };
  if (answerPosition.skewShare > answerPosition.biasedShare) {
    invalid("answerPosition.skewShare must not exceed biasedShare");
  }

  if (!isRecord(raw.nearDuplicate)) invalid("nearDuplicate must be an object");
  assertOnlyKeys(raw.nearDuplicate, ["shingleSize", "threshold"], "nearDuplicate");
  const nearDuplicate: NearDuplicateSettings = {
    shingleSize: numberInRange(raw.nearDuplicate.shingleSize, "nearDuplicate.shingleSize", 1, 100, {
      integer: true,
    }),
    threshold: numberInRange(raw.nearDuplicate.threshold, "nearDuplicate.threshold", 0, 1),
  };

  if (!Array.isArray(raw.referenceProcesses)) invalid("referenceProcesses must be an array");
  const processIds = new Set<string>();
  const referenceProcesses: ReferenceProcess[] = raw.referenceProcesses.map((entry, index) => {
    if (!isRecord(entry)) invalid(`referenceProcesses[${index}] must be an object`, { index });
    assertOnlyKeys(entry, ["id", "title", "steps"], `referenceProcesses[${index}]`);
    const id = nonEmptyString(entry.id, `referenceProcesses[${index}].id`);
    if (processIds.has(id)) invalid("duplicate reference process id", { id });
    processIds.add(id);
    const title = nonEmptyString(entry.title, `referenceProcesses[${index}].title`);
    if (!Array.isArray(entry.steps) || entry.steps.length === 0) {
      invalid(`referenceProcesses[${index}].steps must be a non-empty array`, { id });
    }
    const steps = entry.steps.map((step, stepIndex) =>
      nonEmptyString(step, `referenceProcesses[${index}].steps[${stepIndex}]`),
    );
    return { id, title, steps };
  });

  return {
    formatVersion: PROFILE_FORMAT_VERSION,
    certificationKey,
    examVersionId,
    targetRows,
    examQuestionCount,
    optionCount,
    questionKeyPattern,
    domains,
    difficultyTargets,
    catchAllTopicKeys,
    maxDomainShareDeviation,
    maxDomainDeviationSlackItems,
    answerPosition,
    nearDuplicate,
    referenceProcesses,
  };
}

/**
 * Hamilton largest-remainder allocation. Ties are broken by input order, so the
 * profile's domain order decides — never an object key order.
 */
export function largestRemainder(values: readonly number[], total: number): number[] {
  const raw = values.map((value) => value * total);
  const floors = raw.map((value) => Math.floor(value + 1e-9));
  const allocated = total - floors.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value + 1e-9) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let step = 0; step < allocated; step += 1) {
    const target = order[step % order.length]!;
    floors[target.index] = (floors[target.index] ?? 0) + 1;
  }
  return floors;
}

export interface MockDraw {
  domainId: string;
  questions: number;
}

/** `examQuestionCount × weightShare`, Hamilton-rounded to `examQuestionCount`. */
export function mockDraw(profile: QuestionProfile): MockDraw[] {
  const counts = largestRemainder(
    profile.domains.map((domain) => domain.weightShare),
    profile.examQuestionCount,
  );
  return profile.domains.map((domain, index) => ({
    domainId: domain.id,
    questions: counts[index] ?? 0,
  }));
}

export interface Coverage {
  mockDraw: MockDraw[];
  repeatFreeMocks: number;
  bindingDomain: string | null;
}

/**
 * `min over domains floor(bankRows / draw)`. Reported, never enforced: the
 * weights are the product's claim about the exam, and inflating a domain to
 * please a mock-count target would quietly change that claim.
 */
export function coverage(profile: QuestionProfile, rowsByDomain: ReadonlyMap<string, number>): Coverage {
  const draw = mockDraw(profile);
  let repeatFreeMocks = Number.POSITIVE_INFINITY;
  let bindingDomain: string | null = null;
  for (const entry of draw) {
    if (entry.questions === 0) continue;
    const rows = rowsByDomain.get(entry.domainId) ?? 0;
    const mocks = Math.floor(rows / entry.questions);
    if (mocks < repeatFreeMocks) {
      repeatFreeMocks = mocks;
      bindingDomain = entry.domainId;
    }
  }
  return {
    mockDraw: draw,
    repeatFreeMocks: Number.isFinite(repeatFreeMocks) ? repeatFreeMocks : 0,
    bindingDomain,
  };
}

/**
 * `max(maxDomainShareDeviation, maxDomainDeviationSlackItems / rows)`.
 * Fewer rows means a wider band: three items cannot be a 5% share.
 */
export function domainSlack(profile: QuestionProfile, rows: number): number {
  const fromItems = rows > 0 ? profile.maxDomainDeviationSlackItems / rows : 0;
  return round(Math.max(profile.maxDomainShareDeviation, fromItems));
}

export function roundShare(value: number): number {
  return round(value);
}
