import { FINDINGS_FORMAT_VERSION, VERDICT_FORMAT_VERSION } from "./contract.ts";
import { QuestionCheckError } from "./errors.ts";
import type { Report, ReportVerdict } from "./report.ts";

/**
 * `combine` produces the one verdict that may be quoted. It is the only step
 * that sees both the tool's report and PROF's rubric findings, and every rule
 * below fails closed:
 *
 *   1. the report digests must match the findings' `batchDigests` — a verdict
 *      cannot outlive the bytes it describes;
 *   2. every warning needs an acknowledgement with a reason;
 *   3. an error in the report cannot be overridden by a PROF verdict;
 *   4. otherwise the verdict is the worse of PROF's verdict and the report's.
 */
export type ProfVerdict = "pass" | "pass_with_findings" | "fail";
export type ProfSeverity = "blocking" | "major" | "minor";
export type WarningJudgement = "not-a-defect" | "accepted" | "defect";

export interface ProfFinding {
  code: string;
  severity: ProfSeverity;
  scope: { file: string | null; row: number | null; questionKey: string | null };
  claim: string;
  evidence: string;
  fix: string;
}

export interface AcknowledgedWarning {
  code: string;
  scopeKey: string | null;
  judgement: WarningJudgement;
  reason: string;
}

export interface FindingsFile {
  formatVersion: string;
  reportSha256: string | null;
  batchDigests: Array<{ file: string; sha256: string }>;
  acknowledgedWarnings: AcknowledgedWarning[];
  findings: ProfFinding[];
  verdict: ProfVerdict;
}

export interface CombinedVerdictFile {
  formatVersion: string;
  advisoryOnly: true;
  approvalGranted: null;
  verdict: ProfVerdict;
  reportVerdict: ReportVerdict;
  profVerdict: ProfVerdict;
  errors: number;
  warnings: number;
  acknowledgedWarnings: number;
  blockedBy: string[];
  findings: ProfFinding[];
}

export interface CombineResult {
  output: CombinedVerdictFile;
  exitCode: number;
}

const PROF_VERDICTS: readonly ProfVerdict[] = ["pass", "pass_with_findings", "fail"];
const PROF_SEVERITIES: readonly ProfSeverity[] = ["blocking", "major", "minor"];
const JUDGEMENTS: readonly WarningJudgement[] = ["not-a-defect", "accepted", "defect"];

function invalid(reason: string, info: Record<string, string | number | boolean | null> = {}): never {
  throw new QuestionCheckError("FINDINGS_INVALID", reason, { info });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateFindings(raw: unknown): FindingsFile {
  if (!isRecord(raw)) invalid("the findings file must be a JSON object");
  if (raw.formatVersion !== FINDINGS_FORMAT_VERSION) {
    invalid("unsupported findings formatVersion", { formatVersion: String(raw.formatVersion) });
  }
  if (raw.reportSha256 !== null && typeof raw.reportSha256 !== "string") {
    invalid("reportSha256 must be a string or null");
  }
  if (!Array.isArray(raw.batchDigests)) invalid("batchDigests must be an array");
  const batchDigests = raw.batchDigests.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.file !== "string" || typeof entry.sha256 !== "string") {
      invalid(`batchDigests[${index}] must carry file and sha256`);
    }
    return { file: entry.file as string, sha256: entry.sha256 as string };
  });
  if (!Array.isArray(raw.acknowledgedWarnings)) {
    invalid("acknowledgedWarnings must be an array");
  }
  const acknowledgedWarnings = raw.acknowledgedWarnings.map((entry, index) => {
    if (!isRecord(entry)) invalid(`acknowledgedWarnings[${index}] must be an object`);
    if (typeof entry.code !== "string" || entry.code.length === 0) {
      invalid(`acknowledgedWarnings[${index}].code is required`);
    }
    if (entry.scopeKey !== null && typeof entry.scopeKey !== "string") {
      invalid(`acknowledgedWarnings[${index}].scopeKey must be a string or null`);
    }
    if (!JUDGEMENTS.includes(entry.judgement as WarningJudgement)) {
      invalid(`acknowledgedWarnings[${index}].judgement is not a known judgement`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      invalid(`acknowledgedWarnings[${index}].reason is required`);
    }
    return {
      code: entry.code,
      scopeKey: (entry.scopeKey ?? null) as string | null,
      judgement: entry.judgement as WarningJudgement,
      reason: entry.reason,
    };
  });
  if (!Array.isArray(raw.findings)) invalid("findings must be an array");
  const findings = raw.findings.map((entry, index) => {
    if (!isRecord(entry)) invalid(`findings[${index}] must be an object`);
    if (typeof entry.code !== "string" || entry.code.length === 0) {
      invalid(`findings[${index}].code is required`);
    }
    if (!PROF_SEVERITIES.includes(entry.severity as ProfSeverity)) {
      invalid(`findings[${index}].severity is not blocking, major or minor`);
    }
    if (!isRecord(entry.scope)) invalid(`findings[${index}].scope must be an object`);
    const scope = entry.scope;
    return {
      code: entry.code,
      severity: entry.severity as ProfSeverity,
      scope: {
        file: (scope.file ?? null) as string | null,
        row: (scope.row ?? null) as number | null,
        questionKey: (scope.questionKey ?? null) as string | null,
      },
      claim: typeof entry.claim === "string" ? entry.claim : invalid(`findings[${index}].claim is required`),
      evidence:
        typeof entry.evidence === "string" ? entry.evidence : invalid(`findings[${index}].evidence is required`),
      fix: typeof entry.fix === "string" ? entry.fix : invalid(`findings[${index}].fix is required`),
    };
  });
  if (!PROF_VERDICTS.includes(raw.verdict as ProfVerdict)) {
    invalid("verdict is not pass, pass_with_findings or fail");
  }
  return {
    formatVersion: FINDINGS_FORMAT_VERSION,
    reportSha256: (raw.reportSha256 ?? null) as string | null,
    batchDigests,
    acknowledgedWarnings,
    findings,
    verdict: raw.verdict as ProfVerdict,
  };
}

const VERDICT_RANK: Record<ProfVerdict, number> = {
  pass: 0,
  pass_with_findings: 1,
  fail: 2,
};

function worst(left: ProfVerdict, right: ProfVerdict): ProfVerdict {
  return VERDICT_RANK[left] >= VERDICT_RANK[right] ? left : right;
}

/** A report whose shape cannot be trusted is refused, not read optimistically. */
function validateReport(raw: unknown): Report {
  if (!isRecord(raw)) {
    throw new QuestionCheckError("REPORT_INVALID", "the report must be a JSON object");
  }
  if (raw.formatVersion !== "certpath-question-check-report-v1") {
    throw new QuestionCheckError("REPORT_INVALID", "unsupported report formatVersion", {
      info: { formatVersion: String(raw.formatVersion) },
    });
  }
  if (!Array.isArray(raw.findings)) {
    throw new QuestionCheckError("REPORT_INVALID", "report.findings must be an array");
  }
  if (
    !isRecord(raw.inputs) ||
    !Array.isArray(raw.inputs.batches) ||
    raw.inputs.batches.some(
      (batch) => !isRecord(batch) || typeof batch.file !== "string" || typeof batch.sha256 !== "string",
    )
  ) {
    throw new QuestionCheckError("REPORT_INVALID", "report.inputs.batches must carry file and sha256");
  }
  if (typeof raw.verdict !== "string") {
    throw new QuestionCheckError("REPORT_INVALID", "report.verdict must be a string");
  }
  const findings = raw.findings.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.code !== "string" ||
      (entry.severity !== "error" && entry.severity !== "warning") ||
      !isRecord(entry.scope)
    ) {
      throw new QuestionCheckError("REPORT_INVALID", "a report finding is malformed");
    }
    return {
      code: entry.code,
      severity: entry.severity,
      scope: {
        file: (entry.scope.file ?? null) as string | null,
        row: (entry.scope.row ?? null) as number | null,
        questionKey: (entry.scope.questionKey ?? null) as string | null,
        domainId: (entry.scope.domainId ?? null) as string | null,
      },
    };
  });
  return {
    ...(raw as unknown as Report),
    findings: findings as Report["findings"],
  };
}

function acknowledgementKey(code: string, scopeKey: string | null): string {
  return `${code}\u0000${scopeKey ?? ""}`;
}

/** Rule 1: the verdict describes these bytes and no others. */
export function assertNotStale(report: Report, findings: FindingsFile, reportSha256: string): void {
  if (findings.reportSha256 !== null && findings.reportSha256 !== reportSha256) {
    throw new QuestionCheckError("STALE_REPORT", "the findings were made against a different report");
  }
  const expected = report.inputs.batches
    .map((batch) => `${batch.file}\u0000${batch.sha256}`)
    .sort((left, right) => left.localeCompare(right));
  const actual = findings.batchDigests
    .map((batch) => `${batch.file}\u0000${batch.sha256}`)
    .sort((left, right) => left.localeCompare(right));
  if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) {
    throw new QuestionCheckError("STALE_REPORT", "the batch digests in the findings do not match the report");
  }
}

export function combineVerdict(
  rawReport: unknown,
  rawFindings: unknown,
  reportSha256: string,
): CombineResult {
  const report = validateReport(rawReport);
  const findings = validateFindings(rawFindings);
  assertNotStale(report, findings, reportSha256);

  const errors = report.findings.filter((entry) => entry.severity === "error");
  const warnings = report.findings.filter((entry) => entry.severity === "warning");

  // Rule 3 runs before the acknowledgement rule: a report with an error cannot
  // be passed by acknowledging anything.
  if (errors.length > 0 && findings.verdict !== "fail") {
    throw new QuestionCheckError(
      "CANNOT_OVERRIDE_ERROR",
      "the report contains an error and the findings do not say fail",
      { info: { errors: errors.length } },
    );
  }

  // Rule 2: every warning carries a person's judgement and a reason.
  const acknowledged = new Set(
    findings.acknowledgedWarnings.map((entry) => acknowledgementKey(entry.code, entry.scopeKey)),
  );
  const unacknowledged = warnings.filter(
    (entry) => !acknowledged.has(acknowledgementKey(entry.code, entry.scope.questionKey)),
  );

  let verdict: ProfVerdict = findings.verdict;
  if (errors.length > 0) verdict = "fail";
  else if (warnings.length > 0) verdict = worst(verdict, "pass_with_findings");
  if (unacknowledged.length > 0) verdict = "fail";

  const blockedBy = unacknowledged.length > 0 ? ["WARNING_UNACKNOWLEDGED"] : [];

  return {
    output: {
      formatVersion: VERDICT_FORMAT_VERSION,
      advisoryOnly: true,
      approvalGranted: null,
      verdict,
      reportVerdict: report.verdict,
      profVerdict: findings.verdict,
      errors: errors.length,
      warnings: warnings.length,
      acknowledgedWarnings: findings.acknowledgedWarnings.length,
      blockedBy,
      findings: [...findings.findings].sort(
        (left, right) =>
          left.code.localeCompare(right.code) ||
          (left.scope.questionKey ?? "").localeCompare(right.scope.questionKey ?? ""),
      ),
    },
    exitCode: verdict === "fail" ? 1 : 0,
  };
}
