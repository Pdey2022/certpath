import type { Item } from "../parse.ts";
import {
  DIFFICULTY_ORDER,
  coverage,
  domainSlack,
  type QuestionProfile,
} from "../profile.ts";
import {
  buildMockDrawMap,
  buildPositions,
  roundShare as roundReportShare,
  type AnswerPositionReport,
  type CoverageReport,
  type DifficultyReport,
  type DomainReport,
  type Finding,
  type TopicReport,
} from "../report.ts";

/**
 * Distribution over items: shares, answer positions and coverage.
 *
 * Every one of these is a statement about a set of items, and a legitimate
 * small bank can be skewed, so almost all of it is a warning. The exceptions
 * are `DOMAIN_MISSING` and the complete-mode `DOMAIN_WEIGHT_DEVIATION`: a
 * blueprint-weighted bank that omits a domain is not a bank yet.
 */
export interface DistributionResult {
  byDomain: DomainReport[];
  byDifficulty: DifficultyReport[];
  byTopic: TopicReport[];
  answerPosition: AnswerPositionReport;
  coverage: CoverageReport;
  findings: Finding[];
}

function runFinding(
  code: string,
  severity: "error" | "warning",
  message: string,
  evidence: Record<string, string | number | boolean | null> = {},
): Finding {
  return {
    code,
    severity,
    owner: "tool",
    scope: { file: null, row: null, questionKey: null, domainId: null },
    message,
    evidence,
  };
}

function domainFinding(
  code: string,
  severity: "error" | "warning",
  domainId: string,
  message: string,
  evidence: Record<string, string | number | boolean | null> = {},
): Finding {
  return {
    code,
    severity,
    owner: "tool",
    scope: { file: null, row: null, questionKey: null, domainId },
    message,
    evidence,
  };
}

function fileFinding(
  code: string,
  file: string,
  message: string,
  evidence: Record<string, string | number | boolean | null> = {},
): Finding {
  return {
    code,
    severity: "error",
    owner: "tool",
    scope: { file, row: null, questionKey: null, domainId: null },
    message,
    evidence,
  };
}

/** The 1-based slot of the single keyed option, or null when the row is not well formed. */
export function positionOf(item: Item): number | null {
  const keyed = item.options.filter((option) => option.populated && option.correct === "true");
  return keyed.length === 1 ? keyed[0]!.slot : null;
}

export function computeDistribution(
  items: readonly Item[],
  profile: QuestionProfile,
  mode: "partial" | "complete",
): DistributionResult {
  const findings: Finding[] = [];
  const rows = items.length;
  const slack = domainSlack(profile, rows);

  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.domainId.length === 0) continue;
    counts.set(item.domainId, (counts.get(item.domainId) ?? 0) + 1);
  }

  const byDomain: DomainReport[] = profile.domains.map((domain) => {
    const count = counts.get(domain.id) ?? 0;
    const observedShare = rows > 0 ? roundReportShare(count / rows) : 0;
    const delta = roundReportShare(observedShare - domain.weightShare);
    const domainSlackValue = domainSlack(profile, rows);
    const deviates = rows > 0 && Math.abs(delta) > domainSlackValue;
    const severity: "error" | "warning" = mode === "complete" ? "error" : "warning";
    let verdict: DomainReport["verdict"] = "ok";

    if (domain.weightShare > 0 && count === 0) {
      verdict = "error";
      findings.push(
        domainFinding(
          "DOMAIN_MISSING",
          "error",
          domain.id,
          "a weighted domain has no rows",
          { count, weightShare: domain.weightShare },
        ),
      );
    } else if (deviates) {
      verdict = severity;
      findings.push(
        domainFinding(
          "DOMAIN_WEIGHT_DEVIATION",
          severity,
          domain.id,
          `domain ${domain.id} holds ${observedShare} of rows against a target share of ${domain.weightShare}`,
          { count, rows, delta, slack: domainSlackValue },
        ),
      );
      if (mode === "partial") {
        findings.push(
          domainFinding(
            delta > 0 ? "DOMAIN_OVER_TARGET" : "DOMAIN_UNDER_TARGET",
            "warning",
            domain.id,
            delta > 0
              ? "the domain holds more rows than its blueprint share"
              : "the domain holds fewer rows than its blueprint share",
            { count, rows, delta, targetShare: domain.weightShare, slack: domainSlackValue },
          ),
        );
      }
    }

    return {
      domainId: domain.id,
      count,
      targetShare: domain.weightShare,
      observedShare,
      delta,
      slack: domainSlackValue,
      verdict,
    };
  });

  if (rows > 0 && rows < profile.targetRows) {
    findings.push(
      runFinding("BANK_VOLUME_SHORTFALL", "warning", "the bank is short of the profile's target volume", {
        rows,
        targetRows: profile.targetRows,
      }),
    );
  }

  const difficultyCounts = new Map<string, number>();
  for (const item of items) {
    difficultyCounts.set(item.difficulty, (difficultyCounts.get(item.difficulty) ?? 0) + 1);
  }
  const byDifficulty: DifficultyReport[] = DIFFICULTY_ORDER.map((difficulty) => {
    const count = difficultyCounts.get(difficulty) ?? 0;
    return {
      difficulty,
      count,
      share: rows > 0 ? roundReportShare(count / rows) : 0,
      target: profile.difficultyTargets === null ? null : profile.difficultyTargets[difficulty],
    };
  });

  if (profile.difficultyTargets === null) {
    findings.push(
      runFinding(
        "DIFFICULTY_TARGET_UNSET",
        "warning",
        "no difficulty target exists, so difficulty is measured and not judged",
        { rows },
      ),
    );
  } else {
    for (const entry of byDifficulty) {
      const target = profile.difficultyTargets[entry.difficulty as keyof typeof profile.difficultyTargets];
      if (rows > 0 && Math.abs(entry.share - target) > slack) {
        findings.push(
          runFinding("DIFFICULTY_DEVIATION", "warning", "difficulty is off its target share", {
            difficulty: entry.difficulty,
            count: entry.count,
            rows,
            share: entry.share,
            target,
            slack,
          }),
        );
      }
    }
  }

  if (rows > 0) {
    const concentrated = byDifficulty.find((entry) => entry.share >= 0.8);
    if (concentrated !== undefined) {
      findings.push(
        runFinding("DIFFICULTY_CONCENTRATION", "warning", "one difficulty holds at least 80% of the run", {
          difficulty: concentrated.difficulty,
          count: concentrated.count,
          rows,
          share: concentrated.share,
        }),
      );
    }
  }

  const topicCounts = new Map<string, Map<string, number>>();
  for (const item of items) {
    if (item.domainId.length === 0 || item.topicId.length === 0) continue;
    const bucket = topicCounts.get(item.domainId) ?? new Map<string, number>();
    bucket.set(item.topicId, (bucket.get(item.topicId) ?? 0) + 1);
    topicCounts.set(item.domainId, bucket);
  }
  const byTopic: TopicReport[] = [];
  for (const domain of profile.domains) {
    const bucket = topicCounts.get(domain.id);
    if (bucket === undefined) continue;
    const domainRows = [...bucket.values()].reduce((sum, value) => sum + value, 0);
    for (const topicId of [...bucket.keys()].sort((left, right) => left.localeCompare(right))) {
      const count = bucket.get(topicId) ?? 0;
      byTopic.push({
        domainId: domain.id,
        topicId,
        count,
        shareOfDomain: domainRows > 0 ? roundReportShare(count / domainRows) : 0,
      });
    }
  }

  for (const domain of profile.domains) {
    const bucket = topicCounts.get(domain.id);
    if (bucket === undefined || bucket.size < 3) continue;
    const domainRows = [...bucket.values()].reduce((sum, value) => sum + value, 0);
    for (const topicId of [...bucket.keys()].sort((left, right) => left.localeCompare(right))) {
      const share = domainRows > 0 ? roundReportShare((bucket.get(topicId) ?? 0) / domainRows) : 0;
      if (share > 0.35) {
        findings.push(
          runFinding("TOPIC_CONCENTRATION", "warning", "one topic holds more than 35% of its domain", {
            domainId: domain.id,
            topicId,
            count: bucket.get(topicId) ?? 0,
            share,
            threshold: 0.35,
          }),
        );
      }
    }
  }

  for (const catchAll of profile.catchAllTopicKeys) {
    const count = items.filter((item) => item.topicId === catchAll).length;
    if (rows > 0 && count / rows > 0.25) {
      findings.push(
        runFinding("TOPIC_UNASSIGNED", "warning", "the catch-all topic holds more than 25% of the run", {
          topicId: catchAll,
          count,
          rows,
          share: roundReportShare(count / rows),
          threshold: 0.25,
        }),
      );
    }
  }

  const positionCounts = new Map<number, number>();
  let positionable = 0;
  for (const item of items) {
    const position = positionOf(item);
    if (position === null) continue;
    positionable += 1;
    positionCounts.set(position, (positionCounts.get(position) ?? 0) + 1);
  }
  const maxCount = Math.max(0, ...[...positionCounts.values()]);
  const maxShare = positionable > 0 ? roundReportShare(maxCount / positionable) : 0;

  const byFile = new Map<string, number[]>();
  for (const item of items) {
    const bucket = byFile.get(item.file) ?? [];
    const position = positionOf(item);
    if (position !== null) bucket.push(position);
    byFile.set(item.file, bucket);
  }
  let monotoneFiles = 0;
  for (const file of [...byFile.keys()].sort((left, right) => left.localeCompare(right))) {
    const positions = byFile.get(file) ?? [];
    if (positions.length < profile.answerPosition.monotoneBatchMinimum) continue;
    if (new Set(positions).size !== 1) continue;
    monotoneFiles += 1;
    findings.push(
      fileFinding("ANSWER_POSITION_MONOTONE", file, "every correct answer in the file sits at one position", {
        rows: positions.length,
        position: positions[0] ?? null,
        minimum: profile.answerPosition.monotoneBatchMinimum,
      }),
    );
  }

  let positionVerdict: AnswerPositionReport["verdict"] = "ok";
  if (
    positionable >= profile.answerPosition.biasedMinimumRows &&
    maxShare >= profile.answerPosition.biasedShare
  ) {
    positionVerdict = "error";
    findings.push(
      runFinding("ANSWER_POSITION_BIASED", "error", "one answer position holds a biased share of the run", {
        position: positionOfMax(positionCounts),
        count: maxCount,
        rows: positionable,
        share: maxShare,
        threshold: profile.answerPosition.biasedShare,
      }),
    );
  } else if (
    positionable >= profile.answerPosition.biasedMinimumRows &&
    maxShare >= profile.answerPosition.skewShare
  ) {
    positionVerdict = "warning";
    findings.push(
      runFinding("ANSWER_POSITION_SKEW", "warning", "one answer position is over-skewed", {
        position: positionOfMax(positionCounts),
        count: maxCount,
        rows: positionable,
        share: maxShare,
        threshold: profile.answerPosition.skewShare,
      }),
    );
  }
  if (monotoneFiles > 0) positionVerdict = "error";

  const rowsByDomain = new Map<string, number>();
  for (const domain of profile.domains) rowsByDomain.set(domain.id, counts.get(domain.id) ?? 0);
  const coverageResult = coverage(profile, rowsByDomain);

  return {
    byDomain,
    byDifficulty,
    byTopic,
    answerPosition: {
      positions: buildPositions(positionCounts, profile.optionCount),
      maxShare,
      verdict: positionVerdict,
    },
    coverage: {
      mockDraw: buildMockDrawMap(coverageResult.mockDraw),
      repeatFreeMocks: coverageResult.repeatFreeMocks,
      bindingDomain: coverageResult.bindingDomain,
    },
    findings,
  };
}

function positionOfMax(counts: ReadonlyMap<number, number>): number | null {
  let best: number | null = null;
  let bestCount = -1;
  for (const position of [...counts.keys()].sort((left, right) => left - right)) {
    const count = counts.get(position) ?? 0;
    if (count > bestCount) {
      best = position;
      bestCount = count;
    }
  }
  return best;
}
