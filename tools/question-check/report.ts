import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPORT_FORMAT_VERSION } from "./contract.ts";

/**
 * The report is evidence, so it is deterministic: no timestamp, no absolute
 * path, findings sorted by (file, row, code), maps sorted by key. Two runs over
 * the same bytes produce byte-identical files, and a re-run either matches or
 * the input changed.
 */
export type Severity = "error" | "warning";

export interface FindingScope {
  file: string | null;
  row: number | null;
  questionKey: string | null;
  domainId: string | null;
}

export type EvidenceValue = string | number | boolean | null;

export interface Finding {
  code: string;
  severity: Severity;
  owner: "tool";
  scope: FindingScope;
  message: string;
  evidence: Record<string, EvidenceValue>;
}

export interface ReportInputFile {
  file: string;
  sha256: string;
  rows: number;
  included: boolean;
  excludedReason: string | null;
}

export interface ReportInputs {
  profile: { path: string; sha256: string };
  taxonomy: { path: string; sha256: string };
  batches: ReportInputFile[];
  importedKeys: { path: string; sha256: string; count: number } | null;
}

export interface Totals {
  batches: number;
  filesExcluded: number;
  rows: number;
  itemsWithErrors: number;
  itemsWithWarnings: number;
}

export interface DomainReport {
  domainId: string;
  count: number;
  targetShare: number;
  observedShare: number;
  delta: number;
  slack: number;
  verdict: "error" | "warning" | "ok";
}

export interface DifficultyReport {
  difficulty: string;
  count: number;
  share: number;
  target: number | null;
}

export interface TopicReport {
  domainId: string;
  topicId: string;
  count: number;
  shareOfDomain: number;
}

export interface AnswerPositionReport {
  positions: Record<string, number>;
  maxShare: number;
  verdict: "error" | "warning" | "ok";
}

export interface CoverageReport {
  mockDraw: Record<string, number>;
  repeatFreeMocks: number;
  bindingDomain: string | null;
}

export interface Suppression {
  code: string;
  questionKey: string | null;
  reason: string;
  approvedBy: string;
}

export type ReportVerdict = "pass" | "pass_with_findings" | "fail" | "refused" | "incomplete";

export interface Report {
  formatVersion: string;
  advisoryOnly: true;
  approvalGranted: null;
  mode: "partial" | "complete";
  inputs: ReportInputs;
  totals: Totals;
  byDomain: DomainReport[];
  byDifficulty: DifficultyReport[];
  byTopic: TopicReport[];
  answerPosition: AnswerPositionReport;
  coverage: CoverageReport;
  findings: Finding[];
  suppressions: Suppression[];
  verdict: ReportVerdict;
}

export function roundShare(value: number): number {
  const factor = 1e6;
  return Math.round(value * factor) / factor;
}

/** Canonical key order for `evidence`, so two runs cannot differ by key order. */
function canonicalEvidence(evidence: Record<string, EvidenceValue>): Record<string, EvidenceValue> {
  const ordered: Record<string, EvidenceValue> = {};
  for (const key of Object.keys(evidence).sort()) {
    ordered[key] = evidence[key] ?? null;
  }
  return ordered;
}

export function canonicalFinding(finding: Finding): Finding {
  return {
    code: finding.code,
    severity: finding.severity,
    owner: "tool",
    scope: {
      file: finding.scope.file,
      row: finding.scope.row,
      questionKey: finding.scope.questionKey,
      domainId: finding.scope.domainId,
    },
    message: finding.message,
    evidence: canonicalEvidence(finding.evidence),
  };
}

/**
 * Sorted by file (run-level first), then row, then code, then question key.
 * The tie-breakers exist so two findings that share a code on one row still
 * have one order.
 */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return findings
    .map(canonicalFinding)
    .sort(
      (left, right) =>
        (left.scope.file ?? "").localeCompare(right.scope.file ?? "") ||
        (left.scope.row ?? 0) - (right.scope.row ?? 0) ||
        left.code.localeCompare(right.code) ||
        (left.scope.questionKey ?? "").localeCompare(right.scope.questionKey ?? "") ||
        left.message.localeCompare(right.message),
    );
}

/** Position keys as strings, ascending. Any slot above `optionCount` is included too. */
export function buildPositions(counts: ReadonlyMap<number, number>, optionCount: number): Record<string, number> {
  const positions: Record<string, number> = {};
  const highest = Math.max(optionCount, ...counts.keys());
  for (let position = 1; position <= highest; position += 1) {
    positions[String(position)] = counts.get(position) ?? 0;
  }
  return positions;
}

export function buildMockDrawMap(entries: ReadonlyArray<{ domainId: string; questions: number }>): Record<string, number> {
  const map: Record<string, number> = {};
  for (const entry of [...entries].sort((left, right) => left.domainId.localeCompare(right.domainId))) {
    map[entry.domainId] = entry.questions;
  }
  return map;
}

export function reportJson(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const ADVISORY_LINE =
  "Advisory only. This report is not an approval of content, of an import, of a merge, " +
  "of a deployment or of a provisioning step. Only the owner signs off content.";

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|");
}

function countBySeverity(findings: readonly Finding[], severity: Severity): number {
  return findings.filter((finding) => finding.severity === severity).length;
}

/**
 * Markdown carries no excerpts: it is the form most likely to be pasted into an
 * issue, and an issue is a public place. `--redact` is implicit here.
 */
export function reportMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push("# Question-check report");
  lines.push("");
  lines.push(`> ${ADVISORY_LINE}`);
  lines.push("");
  lines.push(`- Mode: \`${report.mode}\``);
  lines.push(`- Verdict: \`${report.verdict}\``);
  lines.push(`- Errors: ${countBySeverity(report.findings, "error")}`);
  lines.push(`- Warnings: ${countBySeverity(report.findings, "warning")}`);
  lines.push(`- Rows judged: ${report.totals.rows}`);
  lines.push(`- Batches: ${report.totals.batches} (${report.totals.filesExcluded} excluded)`);
  lines.push("");
  lines.push("## Inputs");
  lines.push("");
  lines.push("| File | SHA-256 | Rows | Included |");
  lines.push("|---|---|---:|---|");
  lines.push(`| ${escapeCell(report.inputs.profile.path)} | ${report.inputs.profile.sha256} | — | profile |`);
  lines.push(`| ${escapeCell(report.inputs.taxonomy.path)} | ${report.inputs.taxonomy.sha256} | — | taxonomy |`);
  if (report.inputs.importedKeys !== null) {
    lines.push(
      `| ${escapeCell(report.inputs.importedKeys.path)} | ${report.inputs.importedKeys.sha256} | ${report.inputs.importedKeys.count} | imported keys |`,
    );
  }
  for (const batch of report.inputs.batches) {
    lines.push(
      `| ${escapeCell(batch.file)} | ${batch.sha256} | ${batch.rows} | ${batch.included ? "yes" : `no (${batch.excludedReason ?? "?"})`} |`,
    );
  }
  lines.push("");
  lines.push("## Domain distribution");
  lines.push("");
  lines.push("| Domain | Count | Target share | Observed | Delta | Slack | Verdict |");
  lines.push("|---|---:|---:|---:|---:|---:|---|");
  for (const domain of report.byDomain) {
    lines.push(
      `| ${domain.domainId} | ${domain.count} | ${domain.targetShare} | ${domain.observedShare} | ${domain.delta} | ${domain.slack} | ${domain.verdict} |`,
    );
  }
  lines.push("");
  lines.push("## Difficulty distribution");
  lines.push("");
  lines.push("| Difficulty | Count | Share | Target |");
  lines.push("|---|---:|---:|---|");
  for (const entry of report.byDifficulty) {
    lines.push(
      `| ${entry.difficulty} | ${entry.count} | ${entry.share} | ${entry.target === null ? "unset" : entry.target} |`,
    );
  }
  lines.push("");
  lines.push("## Answer position");
  lines.push("");
  lines.push("| Position | Count |");
  lines.push("|---|---:|");
  for (const key of Object.keys(report.answerPosition.positions)) {
    lines.push(`| ${key} | ${report.answerPosition.positions[key]} |`);
  }
  lines.push("");
  lines.push(`Maximum share: ${report.answerPosition.maxShare} (${report.answerPosition.verdict})`);
  lines.push("");
  lines.push("## Coverage");
  lines.push("");
  lines.push("| Domain | Per-mock draw |");
  lines.push("|---|---:|");
  for (const key of Object.keys(report.coverage.mockDraw)) {
    lines.push(`| ${key} | ${report.coverage.mockDraw[key]} |`);
  }
  lines.push("");
  lines.push(
    `Repeat-free mocks: ${report.coverage.repeatFreeMocks}` +
      (report.coverage.bindingDomain === null ? "" : ` (binding domain: ${report.coverage.bindingDomain})`),
  );
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  if (report.findings.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Code | Severity | File | Row | Question key | Message |");
    lines.push("|---|---|---|---:|---|---|");
    for (const finding of report.findings) {
      lines.push(
        `| ${finding.code} | ${finding.severity} | ${escapeCell(finding.scope.file ?? "—")} | ${
          finding.scope.row ?? "—"
        } | ${escapeCell(finding.scope.questionKey ?? "—")} | ${escapeCell(finding.message)} |`,
      );
    }
  }
  lines.push("");
  if (report.suppressions.length > 0) {
    lines.push("## Suppressions");
    lines.push("");
    lines.push("| Code | Question key | Reason | Approved by |");
    lines.push("|---|---|---|---|");
    for (const suppression of report.suppressions) {
      lines.push(
        `| ${suppression.code} | ${escapeCell(suppression.questionKey ?? "—")} | ${escapeCell(suppression.reason)} | ${escapeCell(suppression.approvedBy)} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export const REPORT_JSON_NAME = "question-check-report.json";
export const REPORT_MARKDOWN_NAME = "question-check-report.md";

export interface WriteReportOptions {
  format: "json" | "markdown" | "both";
}

/**
 * Writes each artefact to `<name>.partial` and renames it into place only after
 * the whole file is serialised. A crash leaves `.partial` files, never a
 * half-written report that looks like a verdict.
 */
export function writeReportFiles(
  outDir: string,
  report: Report,
  options: WriteReportOptions,
): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  const payloads: Array<{ name: string; text: string }> = [];
  if (options.format === "json" || options.format === "both") {
    payloads.push({ name: REPORT_JSON_NAME, text: reportJson(report) });
  }
  if (options.format === "markdown" || options.format === "both") {
    payloads.push({ name: REPORT_MARKDOWN_NAME, text: reportMarkdown(report) });
  }
  for (const payload of payloads) {
    const target = join(outDir, payload.name);
    const partial = `${target}.partial`;
    writeFileSync(partial, payload.text, "utf8");
    renameSync(partial, target);
    written.push(payload.name);
  }
  return written;
}

/** `--force` blanks the previous report before a new run, so a crash cannot leave a stale pass. */
export function clearReportFiles(outDir: string): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(outDir);
  } catch {
    return removed;
  }
  for (const name of names.sort()) {
    if (name === REPORT_JSON_NAME || name === REPORT_MARKDOWN_NAME || name.endsWith(".partial")) {
      rmSync(join(outDir, name), { force: true });
      removed.push(name);
    }
  }
  return removed;
}