import { describe, expect, it } from "vitest";
import {
  evaluateReadiness,
  isReadinessCurrent,
  readinessDecayMs,
  type BlueprintDomain,
  type ReadinessMock,
} from "../src/readiness.ts";

const day = 86_400_000;
const now = 1_763_000_000_000;

const blueprint: BlueprintDomain[] = [
  { domainId: "d1", title: "Security and Risk Management", publishedQuestions: 60 },
  { domainId: "d2", title: "Asset Security", publishedQuestions: 30 },
  { domainId: "d3", title: "Security Architecture", publishedQuestions: 10 },
];

/** A mock that scored `perDomain` correct out of `questionsApiece` in each domain. */
function mock(
  completedAt: number,
  perDomain: Array<{ domainId: string; correct: number; total: number }>,
  attemptId: string = crypto.randomUUID(),
): ReadinessMock {
  return {
    attemptId,
    completedAt,
    correct: perDomain.reduce((total, domain) => total + domain.correct, 0),
    total: perDomain.reduce((total, domain) => total + domain.total, 0),
    domains: perDomain,
  };
}

function strongMock(completedAt: number, attemptId?: string): ReadinessMock {
  return mock(
    completedAt,
    [
      { domainId: "d1", correct: 7, total: 10 },
      { domainId: "d2", correct: 7, total: 10 },
    ],
    attemptId,
  );
}

describe("readiness v1 promotion gate", () => {
  it("is ready when two of the last three mocks clear both marks", () => {
    const result = evaluateReadiness({
      mocks: [strongMock(now), strongMock(now - day), strongMock(now - 2 * day)],
      coverage: { answeredQuestions: 10, publishedQuestions: 100 },
      blueprint,
    });
    expect(result.isReady).toBe(true);
    expect(result.reasons).toEqual({ recentMocks: true, coverage: false });
    expect(result.formulaVersion).toBe("v1");
  });

  it("is not ready on one strong mock alone", () => {
    const result = evaluateReadiness({
      mocks: [strongMock(now)],
      coverage: { answeredQuestions: 10, publishedQuestions: 100 },
      blueprint,
    });
    expect(result.isReady).toBe(false);
    expect(result.reasons.recentMocks).toBe(false);
  });

  it("ignores a mock that missed the per-domain mark even with a high overall score", () => {
    const lopsided = mock(now, [
      { domainId: "d1", correct: 9, total: 10 },
      { domainId: "d2", correct: 4, total: 10 },
    ]);
    const result = evaluateReadiness({
      mocks: [lopsided, lopsided, lopsided],
      coverage: { answeredQuestions: 10, publishedQuestions: 100 },
      blueprint,
    });
    expect(result.isReady).toBe(false);
  });

  it("allows coverage to carry a learner whose mocks fall short of two-of-three", () => {
    const result = evaluateReadiness({
      mocks: [mock(now, [{ domainId: "d1", correct: 7, total: 10 }])],
      coverage: { answeredQuestions: 75, publishedQuestions: 100 },
      blueprint,
    });
    expect(result.isReady).toBe(true);
    expect(result.reasons).toEqual({ recentMocks: false, coverage: true });
  });

  it("needs the latest mock to stay solid for the coverage path", () => {
    const result = evaluateReadiness({
      mocks: [mock(now, [{ domainId: "d1", correct: 6, total: 10 }])],
      coverage: { answeredQuestions: 75, publishedQuestions: 100 },
      blueprint,
    });
    expect(result.isReady).toBe(false);
  });

  it("does not let coverage alone make a learner ready", () => {
    const result = evaluateReadiness({
      mocks: [],
      coverage: { answeredQuestions: 100, publishedQuestions: 100 },
      blueprint,
    });
    expect(result.isReady).toBe(false);
    expect(result.score).toBe(0);
  });
});

describe("readiness scoring and bands", () => {
  it("weights the score by the blueprint rather than the question mix", () => {
    const heavyDomains = mock(now, [
      { domainId: "d1", correct: 10, total: 10 },
      { domainId: "d3", correct: 0, total: 10 },
    ]);
    const result = evaluateReadiness({
      mocks: [heavyDomains],
      coverage: { answeredQuestions: 20, publishedQuestions: 1000 },
      blueprint,
    });
    // d1 carries 60/100 of the blueprint and is perfect; d3 carries 10/100 and
    // is empty, so the weighted score sits far above the raw 50%.
    expect(result.score).toBe(86);
    expect(result.band).toBe("ready");
    expect(result.isReady).toBe(false);
  });

  it("separates the display band from the promotion gate", () => {
    const inForm = mock(now, [
      { domainId: "d1", correct: 8, total: 10 },
      { domainId: "d2", correct: 8, total: 10 },
    ]);
    const result = evaluateReadiness({
      mocks: [inForm],
      coverage: { answeredQuestions: 20, publishedQuestions: 1000 },
      blueprint,
    });
    expect(result.band).toBe("ready");
    expect(result.isReady).toBe(false);
  });

  it("bands by score thresholds", () => {
    const low = evaluateReadiness({
      mocks: [mock(now, [{ domainId: "d1", correct: 4, total: 10 }])],
      coverage: { answeredQuestions: 0, publishedQuestions: 100 },
      blueprint,
    });
    expect(low.score).toBe(40);
    expect(low.band).toBe("low");

    const medium = evaluateReadiness({
      mocks: [mock(now, [{ domainId: "d1", correct: 6, total: 10 }])],
      coverage: { answeredQuestions: 0, publishedQuestions: 100 },
      blueprint,
    });
    expect(medium.score).toBe(60);
    expect(medium.band).toBe("medium");
  });

  it("falls back to raw accuracy when no blueprint is published", () => {
    const result = evaluateReadiness({
      mocks: [mock(now, [{ domainId: "d1", correct: 8, total: 10 }])],
      coverage: { answeredQuestions: 10, publishedQuestions: 10 },
      blueprint: [],
    });
    expect(result.score).toBe(80);
    expect(result.nextAction).toBeNull();
    expect(result.basis.blueprintWeighted).toBe(true);
  });

  it("uses at most the last three mocks", () => {
    const result = evaluateReadiness({
      mocks: [
        strongMock(now, "a"),
        strongMock(now - day, "b"),
        strongMock(now - 2 * day, "c"),
        strongMock(now - 3 * day, "d"),
      ],
      coverage: { answeredQuestions: 0, publishedQuestions: 100 },
      blueprint,
    });
    expect(result.basis.mocks).toBe(3);
    expect(result.basis.questions).toBe(60);
  });

  it("reports the basis every display needs", () => {
    const result = evaluateReadiness({
      mocks: [strongMock(now, "a"), strongMock(now - day, "b")],
      coverage: { answeredQuestions: 40, publishedQuestions: 100 },
      blueprint,
    });
    expect(result.basis).toEqual({
      mocks: 2,
      questions: 40,
      blueprintWeighted: true,
    });
  });
});

describe("next action", () => {
  it("picks the weakest domain by accuracy", () => {
    const result = evaluateReadiness({
      mocks: [
        mock(now, [
          { domainId: "d1", correct: 9, total: 10 },
          { domainId: "d2", correct: 5, total: 10 },
          { domainId: "d3", correct: 6, total: 10 },
        ]),
      ],
      coverage: { answeredQuestions: 30, publishedQuestions: 100 },
      blueprint,
    });
    expect(result.nextAction).toMatchObject({
      domainId: "d2",
      title: "Asset Security",
      accuracy: 50,
      questions: 10,
    });
  });

  it("breaks an accuracy tie with the heavier blueprint domain", () => {
    const result = evaluateReadiness({
      mocks: [
        mock(now, [
          { domainId: "d2", correct: 5, total: 10 },
          { domainId: "d3", correct: 5, total: 10 },
        ]),
      ],
      coverage: { answeredQuestions: 20, publishedQuestions: 100 },
      // Only the two tied domains exist in this blueprint.
      blueprint: [
        { domainId: "d2", title: "Asset Security", publishedQuestions: 30 },
        { domainId: "d3", title: "Security Architecture", publishedQuestions: 10 },
      ],
    });
    expect(result.nextAction?.domainId).toBe("d2");
    expect(result.nextAction?.blueprintWeight).toBe(75);
  });

  it("breaks a full tie with recency", () => {
    const result = evaluateReadiness({
      mocks: [
        mock(now, [{ domainId: "d2", correct: 5, total: 10 }]),
        mock(now - day, [{ domainId: "d3", correct: 5, total: 10 }]),
      ],
      coverage: { answeredQuestions: 20, publishedQuestions: 100 },
      // Equal weight domains so only recency can decide.
      blueprint: [
        { domainId: "d2", title: "Asset Security", publishedQuestions: 50 },
        { domainId: "d3", title: "Security Architecture", publishedQuestions: 50 },
      ],
    });
    expect(result.nextAction?.domainId).toBe("d2");
  });

  it("proposes an untouched domain as the place to start", () => {
    const result = evaluateReadiness({
      mocks: [mock(now, [{ domainId: "d1", correct: 10, total: 10 }])],
      coverage: { answeredQuestions: 10, publishedQuestions: 100 },
      blueprint,
    });
    expect(result.nextAction).toMatchObject({
      domainId: "d2",
      accuracy: 0,
      questions: 0,
    });
  });
});

describe("decay", () => {
  it("treats a snapshot inside the window as current", () => {
    expect(isReadinessCurrent(now - readinessDecayMs, now)).toBe(true);
  });

  it("lets a snapshot go stale after fourteen idle days", () => {
    expect(isReadinessCurrent(now - readinessDecayMs - 1, now)).toBe(false);
  });
});
