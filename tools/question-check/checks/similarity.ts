import type { Item } from "../parse.ts";
import type { NearDuplicateSettings } from "../profile.ts";
import type { Finding, FindingScope } from "../report.ts";

/**
 * Similarity and shape: duplicates, near-duplicates, length outliers and the
 * tells that survive a single item's own checks.
 *
 * Every finding here except `STEM_DUPLICATE` is a warning. A distribution over
 * a dozen items can be skewed by luck; two identical stems cannot.
 */

const EXCERPT_LIMIT = 160;

function excerpt(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length <= EXCERPT_LIMIT ? trimmed : `${trimmed.slice(0, EXCERPT_LIMIT - 1)}…`;
}

function scopeFor(item: Item): FindingScope {
  return {
    file: item.file,
    row: item.row,
    questionKey: item.questionKey.length > 0 ? item.questionKey : null,
    domainId: item.domainId.length > 0 ? item.domainId : null,
  };
}

function finding(
  code: string,
  severity: "error" | "warning",
  item: Item,
  message: string,
  evidence: Record<string, string | number | boolean | null> = {},
): Finding {
  return { code, severity, owner: "tool", scope: scopeFor(item), message, evidence };
}

/** NFKC, casefold, strip punctuation, collapse whitespace. */
export function normaliseStem(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenShingles(tokens: readonly string[], size: number): Set<string> {
  const shingles = new Set<string>();
  if (tokens.length < size) return shingles;
  for (let start = 0; start + size <= tokens.length; start += 1) {
    shingles.add(tokens.slice(start, start + size).join(" "));
  }
  return shingles;
}

export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let shared = 0;
  for (const value of left) if (right.has(value)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export function findStemDuplicates(items: readonly Item[]): Finding[] {
  const findings: Finding[] = [];
  const firstSeen = new Map<string, Item>();
  for (const item of items) {
    const normalised = normaliseStem(item.stem);
    if (normalised.length === 0) continue;
    const previous = firstSeen.get(normalised);
    if (previous === undefined) {
      firstSeen.set(normalised, item);
      continue;
    }
    findings.push(
      finding("STEM_DUPLICATE", "error", item, "the stem duplicates another item after normalisation", {
        firstQuestionKey: previous.questionKey,
        duplicateQuestionKey: item.questionKey,
        firstFile: previous.file,
        firstRow: previous.row,
        excerpt: excerpt(item.stem),
      }),
    );
  }
  return findings;
}

export function findNearDuplicates(items: readonly Item[], settings: NearDuplicateSettings): Finding[] {
  const findings: Finding[] = [];
  const shingles = items.map((item) => {
    const tokens = normaliseStem(item.stem).split(" ").filter((token) => token.length > 0);
    return tokenShingles(tokens, settings.shingleSize);
  });
  for (let right = 1; right < items.length; right += 1) {
    for (let left = 0; left < right; left += 1) {
      const leftShingles = shingles[left]!;
      const rightShingles = shingles[right]!;
      // Below the shingle size there is no 5-gram to compare, and a short stem
      // would otherwise match every other short stem on its one or two grams.
      if (leftShingles.size === 0 || rightShingles.size === 0) continue;
      const score = jaccard(leftShingles, rightShingles);
      if (score >= settings.threshold) {
        const current = items[right]!;
        findings.push(
          finding(
            "STEM_NEAR_DUPLICATE",
            "warning",
            current,
            "the stem closely resembles another item",
            {
              counterpartQuestionKey: items[left]!.questionKey,
              counterpartFile: items[left]!.file,
              counterpartRow: items[left]!.row,
              score: Math.round(score * 1000) / 1000,
              threshold: settings.threshold,
              excerpt: excerpt(current.stem),
            },
          ),
        );
      }
    }
  }
  return findings;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Modified z-score with the 0.6745 scale; a flat distribution has MAD 0 and no outliers. */
export function modifiedZOutliers(values: number[]): number[] {
  if (values.length < 4) return [];
  const centre = median(values);
  const mad = median(values.map((value) => Math.abs(value - centre)));
  if (mad === 0) return [];
  return values.map((value) => Math.abs((0.6745 * (value - centre)) / mad));
}

export function findLengthOutliers(items: readonly Item[]): Finding[] {
  const findings: Finding[] = [];
  const stemScores = modifiedZOutliers(items.map((item) => item.stem.trim().length));
  const optionScores = modifiedZOutliers(
    items.map((item) =>
      item.options.reduce((longest, option) => Math.max(longest, option.text.trim().length), 0),
    ),
  );
  items.forEach((item, index) => {
    const stemScore = stemScores[index];
    if (stemScore !== undefined && stemScore > 3.5) {
      findings.push(
        finding("STEM_LENGTH_OUTLIER", "warning", item, "the stem length is an outlier in the run", {
          length: item.stem.trim().length,
          zScore: Math.round(stemScore * 100) / 100,
        }),
      );
    }
    const optionScore = optionScores[index];
    if (optionScore !== undefined && optionScore > 3.5) {
      const longest = item.options.reduce(
        (length, option) => Math.max(length, option.text.trim().length),
        0,
      );
      findings.push(
        finding("OPTION_LENGTH_OUTLIER", "warning", item, "the longest option is an outlier in the run", {
          length: longest,
          zScore: Math.round(optionScore * 100) / 100,
        }),
      );
    }
  });
  return findings;
}

/** The "longest answer is right" tell: correct strictly longest in ≥ 50% of ≥ 10 items. */
export function findCorrectOptionLongest(items: readonly Item[]): Finding[] {
  if (items.length < 10) return [];
  let longestCorrect = 0;
  let considered = 0;
  for (const item of items) {
    const populated = item.options.filter((option) => option.populated);
    const keyed = populated.filter((option) => option.correct === "true");
    if (keyed.length !== 1) continue;
    considered += 1;
    const correctLength = keyed[0]!.text.trim().length;
    const longest = populated.reduce((best, option) => Math.max(best, option.text.trim().length), 0);
    const longestCount = populated.filter((option) => option.text.trim().length === longest).length;
    if (correctLength === longest && longestCount === 1) longestCorrect += 1;
  }
  if (considered < 10) return [];
  const share = longestCorrect / considered;
  if (share < 0.5) return [];
  return [
    {
      code: "CORRECT_OPTION_LONGEST_PATTERN",
      severity: "warning",
      owner: "tool",
      scope: { file: null, row: null, questionKey: null, domainId: null },
      message: "the keyed option is strictly the longest in at least half the run",
      evidence: {
        count: longestCorrect,
        rows: considered,
        share: Math.round(share * 1000) / 1000,
        threshold: 0.5,
      },
    },
  ];
}

/**
 * Keyword any case, letter upper case only. `[A-H]` is an option *letter*, so it
 * is upper case; the keyword may be sentence-initial ("Choice D") or mid-sentence
 * ("option C"). No `/i` flag: under it the article "a" also matched, so
 * "answers a value question" read as a reference to option A.
 */
const LETTER_PATTERNS: ReadonlyArray<RegExp> = [
  /\b[Oo]ption[s]?\s+[A-H]\b/,
  /\b(?:[Aa]nswer|[Cc]hoice)s?\s+[A-H]\b/,
  /[A-H][.)]\s/,
];

export function findExplanationIssues(items: readonly Item[]): Finding[] {
  const findings: Finding[] = [];
  for (const item of items) {
    for (const option of item.options) {
      if (!option.populated || option.explanation.trim().length === 0) continue;
      const isCorrect = option.correct === "true";
      if (!isCorrect && option.explanation.trim().length < 40) {
        findings.push(
          finding("EXPLANATION_THIN", "warning", item, "a distractor explanation is too short to teach", {
            slot: option.slot,
            length: option.explanation.trim().length,
            minimum: 40,
            excerpt: excerpt(option.explanation),
          }),
        );
      }
      const matched = LETTER_PATTERNS.find((pattern) => pattern.test(option.explanation));
      if (matched !== undefined) {
        findings.push(
          finding(
            "EXPLANATION_LETTER_REFERENCE",
            "warning",
            item,
            "an explanation names an option letter, which breaks if options are reordered",
            { slot: option.slot, pattern: matched.source },
          ),
        );
      }
    }
  }
  return findings;
}

const ARITHMETIC_STEM = /^(?:what is|calculate|compute)\b[\s\S]*?(\d+(?:\.\d+)?)\s*([+\-*/×x÷])\s*(\d+(?:\.\d+)?)/i;
const LEADING_NUMBER = /\d+(?:\.\d+)?/;

/**
 * A numeric stem whose stated arithmetic does not produce the keyed option.
 * Deliberately narrow: only stems that begin "what is", "calculate" or "compute"
 * and contain one explicit operation. A warning with a wide catchment would cost
 * the reviewer a judgement call per item.
 */
export function findNumberInconsistent(items: readonly Item[]): Finding[] {
  const findings: Finding[] = [];
  for (const item of items) {
    const match = ARITHMETIC_STEM.exec(item.stem.trim());
    if (match === null) continue;
    const left = Number(match[1]);
    const operator = match[2]!;
    const right = Number(match[3]);
    let result: number;
    if (operator === "+") result = left + right;
    else if (operator === "-") result = left - right;
    else if (operator === "*" || operator === "x" || operator === "×") result = left * right;
    else result = right === 0 ? Number.NaN : left / right;
    if (!Number.isFinite(result)) continue;
    const keyed = item.options.find((option) => option.populated && option.correct === "true");
    if (keyed === undefined) continue;
    const keyedNumber = LEADING_NUMBER.exec(keyed.text.trim());
    if (keyedNumber === null) continue;
    if (Math.abs(Number(keyedNumber[0]) - result) > 1e-9) {
      findings.push(
        finding("STEM_NUMBER_INCONSISTENT", "warning", item, "the stem's arithmetic does not produce the keyed option", {
          expected: Math.round(result * 1000) / 1000,
          keyed: Number(keyedNumber[0]),
          slot: keyed.slot,
        }),
      );
    }
  }
  return findings;
}

export function runSimilarityChecks(
  items: readonly Item[],
  settings: NearDuplicateSettings,
): Finding[] {
  return [
    ...findStemDuplicates(items),
    ...findNearDuplicates(items, settings),
    ...findLengthOutliers(items),
    ...findCorrectOptionLongest(items),
    ...findExplanationIssues(items),
    ...findNumberInconsistent(items),
  ];
}
