// Learner readiness, formula v1.
//
// Pure and runtime-neutral: the Worker, the tests and any future reporting all
// call these predicates. Attempt data is loaded elsewhere; this module only
// answers "how ready is this learner, and why?".
//
// Readiness is computed from timed mocks and blueprint weights, never from
// practice clicks alone, and every answer carries the basis it was derived
// from.
//
// Rules: docs/decisions/0005-readiness-and-access-lifecycle.md.

export const readinessFormulaVersion = "v1";

/** A snapshot older than this is no longer current for display or promotion. */
export const readinessDecayMs = 14 * 24 * 60 * 60 * 1000;

/** Mocks considered, most recent first. */
export const readinessWindow = 3;

/** Path A: two of the last three mocks at or above these marks. */
export const readyMockAccuracy = 0.7;
export const readyDomainAccuracy = 0.55;
export const readyMockCount = 2;

/** Path B: broad coverage plus a solid latest mock. */
export const readyCoverage = 0.75;
export const coverageMockAccuracy = 0.65;

/** Display bands. */
export const bandMediumMinimum = 50;
export const bandReadyMinimum = 75;

export type ReadinessBand = "low" | "medium" | "ready";

export type ReadinessMockDomain = {
  domainId: string;
  correct: number;
  total: number;
};

export type ReadinessMock = {
  attemptId: string;
  completedAt: number;
  correct: number;
  total: number;
  domains: readonly ReadinessMockDomain[];
};

export type BlueprintDomain = {
  domainId: string;
  title: string;
  publishedQuestions: number;
};

export type ReadinessBasis = {
  mocks: number;
  questions: number;
  blueprintWeighted: true;
};

export type ReadinessNextAction = {
  domainId: string;
  title: string;
  /** Percent, rounded for display. */
  accuracy: number;
  questions: number;
  /** Percent of the blueprint this domain carries, rounded for display. */
  blueprintWeight: number;
};

export type ReadinessSnapshot = {
  formulaVersion: typeof readinessFormulaVersion;
  band: ReadinessBand;
  /** Blueprint-weighted accuracy over the window, percent. */
  score: number;
  isReady: boolean;
  basis: ReadinessBasis;
  nextAction: ReadinessNextAction | null;
  reasons: { recentMocks: boolean; coverage: boolean };
};

export type ReadinessInput = {
  /** Most recent first. At most `readinessWindow` entries are used. */
  mocks: readonly ReadinessMock[];
  coverage: { answeredQuestions: number; publishedQuestions: number };
  blueprint: readonly BlueprintDomain[];
};

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function percent(value: number): number {
  return Math.round(value * 100);
}

type DomainTally = { correct: number; total: number; lastAnsweredAt: number };

/**
 * `isReady` is the promotion gate (ADR 0005). `band` is the display band from
 * `score`. They are different questions: a learner can be in form (band) without
 * yet meeting the two-of-three rule, and the basis line is what explains it.
 */
export function evaluateReadiness(input: ReadinessInput): ReadinessSnapshot {
  const mocks = input.mocks.slice(0, readinessWindow);
  const basis: ReadinessBasis = {
    mocks: mocks.length,
    questions: mocks.reduce((total, mock) => total + mock.total, 0),
    blueprintWeighted: true,
  };

  const strongMocks = mocks.filter(
    (mock) =>
      ratio(mock.correct, mock.total) >= readyMockAccuracy &&
      mock.domains.every(
        (domain) => ratio(domain.correct, domain.total) >= readyDomainAccuracy,
      ),
  );
  const recentMocks = strongMocks.length >= readyMockCount;

  const latest = mocks[0] ?? null;
  const coverage = ratio(
    input.coverage.answeredQuestions,
    input.coverage.publishedQuestions,
  );
  const coveragePath =
    latest !== null &&
    coverage >= readyCoverage &&
    ratio(latest.correct, latest.total) >= coverageMockAccuracy;

  const tallies = new Map<string, DomainTally>();
  for (const mock of mocks) {
    for (const domain of mock.domains) {
      const tally = tallies.get(domain.domainId) ?? {
        correct: 0,
        total: 0,
        lastAnsweredAt: 0,
      };
      tally.correct += domain.correct;
      tally.total += domain.total;
      tally.lastAnsweredAt = Math.max(tally.lastAnsweredAt, mock.completedAt);
      tallies.set(domain.domainId, tally);
    }
  }

  const publishedTotal = input.blueprint.reduce(
    (total, domain) => total + domain.publishedQuestions,
    0,
  );
  const weightOf = (domain: BlueprintDomain) =>
    ratio(domain.publishedQuestions, publishedTotal);

  let weightedCorrect = 0;
  let weightSeen = 0;
  for (const domain of input.blueprint) {
    const tally = tallies.get(domain.domainId);
    if (!tally || tally.total === 0) continue;
    const weight = weightOf(domain);
    weightedCorrect += weight * ratio(tally.correct, tally.total);
    weightSeen += weight;
  }

  const score =
    weightSeen > 0
      ? percent(weightedCorrect / weightSeen)
      : percent(
          ratio(
            mocks.reduce((total, mock) => total + mock.correct, 0),
            mocks.reduce((total, mock) => total + mock.total, 0),
          ),
        );

  return {
    formulaVersion: readinessFormulaVersion,
    band:
      score < bandMediumMinimum
        ? "low"
        : score < bandReadyMinimum
          ? "medium"
          : "ready",
    score,
    isReady: recentMocks || coveragePath,
    basis,
    nextAction: weakestDomain(input.blueprint, tallies, weightOf),
    reasons: { recentMocks, coverage: coveragePath },
  };
}

/**
 * Weakest domain by accuracy, weighted by the blueprint, with recency as the
 * tiebreak. A domain with no attempts counts as the weakest thing to start.
 */
function weakestDomain(
  blueprint: readonly BlueprintDomain[],
  tallies: ReadonlyMap<string, DomainTally>,
  weightOf: (domain: BlueprintDomain) => number,
): ReadinessNextAction | null {
  if (blueprint.length === 0) return null;

  const ranked = [...blueprint].sort((left, right) => {
    const leftTally = tallies.get(left.domainId);
    const rightTally = tallies.get(right.domainId);
    const leftAccuracy = ratio(leftTally?.correct ?? 0, leftTally?.total ?? 0);
    const rightAccuracy = ratio(rightTally?.correct ?? 0, rightTally?.total ?? 0);
    if (leftAccuracy !== rightAccuracy) return leftAccuracy - rightAccuracy;

    const byWeight = weightOf(right) - weightOf(left);
    if (byWeight !== 0) return byWeight;

    const byRecency =
      (rightTally?.lastAnsweredAt ?? 0) - (leftTally?.lastAnsweredAt ?? 0);
    if (byRecency !== 0) return byRecency;

    return left.domainId.localeCompare(right.domainId);
  });

  const target = ranked[0]!;
  const tally = tallies.get(target.domainId);
  return {
    domainId: target.domainId,
    title: target.title,
    accuracy: percent(ratio(tally?.correct ?? 0, tally?.total ?? 0)),
    questions: tally?.total ?? 0,
    blueprintWeight: percent(weightOf(target)),
  };
}

export function isReadinessCurrent(computedAt: number, now: number): boolean {
  return now - computedAt <= readinessDecayMs;
}
