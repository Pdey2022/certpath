import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  confirmQuestionImport,
  exportPublishedQuestionPage,
  listDomains,
  listTopics,
  previewQuestionImport,
  ProtectedApiError,
} from "../lib/admin-question-editor-api";
import type {
  ImportConfirmation,
  ImportPreview,
  ImportPreviewSummary,
} from "../lib/admin-question-editor-api";

const maxImportBytes = 256 * 1024;
const importFormat = "certpath-question-v1";
const importColumns = [
  "format_version",
  "question_key",
  "exam_version_id",
  "domain_id",
  "topic_id",
  "stem",
  "difficulty",
  "source_reference",
  "license_reference",
  ...Array.from({ length: 8 }, (_, index) => {
    const option = index + 1;
    return [
      `option_${option}_key`,
      `option_${option}_text`,
      `option_${option}_correct`,
      `option_${option}_explanation`,
    ];
  }).flat(),
];

type PreviewState =
  | { kind: "valid"; value: ImportPreview }
  | { kind: "invalid"; summary: ImportPreviewSummary; issues: Array<{ path: string; code: string }> };

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function csvRow(values: string[]): string {
  return values.map(csvCell).join(",");
}

function makeTemplate(examVersionId: string, domainId: string, topicId: string): string {
  const values = [
    importFormat,
    "SYNTHETIC-EXAMPLE-CHANGE-THIS-KEY",
    examVersionId,
    domainId,
    topicId,
    "Synthetic example question? Replace this with approved content.",
    "medium",
    "Synthetic source reference (replace)",
    "Synthetic licence reference (replace)",
  ];
  for (let index = 0; index < 8; index += 1) {
    if (index < 2) {
      values.push(
        index === 0 ? "A" : "B",
        `Synthetic answer ${index === 0 ? "A" : "B"}`,
        index === 0 ? "true" : "false",
        `Synthetic explanation ${index === 0 ? "A" : "B"}`,
      );
    } else {
      values.push("", "", "", "");
    }
  }
  return `${csvRow(importColumns)}\r\n${csvRow(values)}\r\n`;
}

function safeFilenamePart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "scope";
}

function downloadCsv(csv: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  window.document.body.appendChild(anchor);
  anchor.click();
  anchor.parentNode?.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function apiErrorMessage(error: unknown): string {
  if (!(error instanceof ProtectedApiError)) {
    return "The protected import/export service could not complete the request.";
  }
  if (error.status === 401) {
    return "Your staff session is missing, expired, or revoked. Return after signing in through the approved staff identity flow.";
  }
  if (error.status === 403 || error.status === 404) {
    return "This certification or exam version is unavailable under your current staff access.";
  }
  if (error.status === 409) return "The requested content changed. Refresh the selection before retrying.";
  if (error.status === 413) {
    return "The CSV exceeds the 256 KiB import limit. Choose a smaller file.";
  }
  if (error.status === 400 && error.code === "validation_error") {
    return "CSV validation failed. Review the row and column errors before previewing again.";
  }
  if (error.status === 400 && error.code === "invalid_csrf") {
    return "The security token was rejected. Reload the protected workspace before retrying.";
  }
  if (error.status === 0 || error.status === 503) {
    return "The protected import/export service is temporarily unavailable.";
  }
  return "The protected import/export service rejected the request.";
}

function describeIssue(issue: { path: string; code: string }): string {
  const match = /^row\.(\d+)\.(.+)$/.exec(issue.path);
  const location = match
    ? `Row ${match[1]}, column ${match[2]}`
    : issue.path;
  const messages: Record<string, string> = {
    duplicate_header: "header names must be unique",
    unknown_header: "this column is not supported",
    missing_header: "this required column is missing",
    duplicate_question_key: "this question key is already used in the file",
    existing_question_key: "this question key already exists; imports do not correct existing questions",
    invalid_exam_version: "the row must use the selected exam version",
    invalid_scope_reference: "choose a topic belonging to the selected domain and exam version",
    invalid_domain: "choose a domain in this exam version",
    invalid_topic: "choose a topic belonging to the selected domain",
    invalid_question_content: "review this field and the single-choice question rules",
    incomplete_option: "provide the key, text, correctness and explanation for this option",
    invalid_boolean: "correctness must be exactly true or false",
    invalid_value: "use a value allowed by the CSV contract",
    invalid_record: "check the field value and row shape",
    malformed_csv: "check CSV quoting and record delimiters",
    invalid_utf8: "save the file as UTF-8 without a byte-order mark",
    unsupported_encoding: "save the file as UTF-8 without a byte-order mark",
    utf8_bom_not_supported: "save the file as UTF-8 without a byte-order mark",
    row_too_large: "this CSV record exceeds the documented record limit",
    too_many_rows: "the import is limited to 10 question rows",
    column_count_mismatch: "the row must contain the same columns as the template",
    unsupported_format_version: "use certpath-question-v1",
    no_question_rows: "add at least one question row",
    empty_row: "remove the blank row or fill it with a question",
    file_too_large: "the file exceeds the 256 KiB limit",
  };
  const message = messages[issue.code] ?? "check the value and the v1 template";
  return `${location}: ${message}.`;
}

export function ProtectedCsvTools({
  certificationId,
  certificationName,
  examVersionId,
  examVersionName,
}: {
  certificationId: string;
  certificationName: string;
  examVersionId: string;
  examVersionName: string;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewSummary, setPreviewSummary] = useState<ImportPreviewSummary | null>(null);
  const [previewIssues, setPreviewIssues] = useState<Array<{ path: string; code: string }>>([]);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmRetry, setConfirmRetry] = useState(false);
  const [confirmed, setConfirmed] = useState<ImportConfirmation | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportPage, setExportPage] = useState(1);
  const [exportCursor, setExportCursor] = useState<string | null>(null);
  const [hasMoreExport, setHasMoreExport] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const previewRequest = useRef(0);
  const confirmationRequest = useRef(0);
  const templateRequest = useRef(0);
  const exportRequest = useRef(0);
  const scope = `${certificationId}:${examVersionId}`;
  const activeScope = useRef(scope);

  useEffect(() => {
    activeScope.current = scope;
    previewRequest.current += 1;
    confirmationRequest.current += 1;
    templateRequest.current += 1;
    exportRequest.current += 1;
    if (fileInput.current) fileInput.current.value = "";
    setFile(null);
    setPreview(null);
    setPreviewSummary(null);
    setPreviewIssues([]);
    setTemplateBusy(false);
    setPreviewBusy(false);
    setConfirmBusy(false);
    setExportBusy(false);
    setConfirmed(null);
    setExportPage(1);
    setExportCursor(null);
    setHasMoreExport(false);
    setError("");
    setStatus("");
    return () => {
      previewRequest.current += 1;
      confirmationRequest.current += 1;
      templateRequest.current += 1;
      exportRequest.current += 1;
    };
  }, [scope]);

  function isCurrent(request: number, current: number): boolean {
    return activeScope.current === scope && request === current;
  }

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    previewRequest.current += 1;
    confirmationRequest.current += 1;
    setFile(event.currentTarget.files?.[0] ?? null);
    setPreview(null);
    setPreviewSummary(null);
    setPreviewIssues([]);
    setConfirmed(null);
    setConfirmRetry(false);
    setPreviewBusy(false);
    setConfirmBusy(false);
    setError("");
    setStatus("");
  }

  async function downloadTemplate() {
    const request = ++templateRequest.current;
    setTemplateBusy(true);
    setError("");
    setStatus("");
    try {
      const domains = await listDomains(certificationId, examVersionId);
      if (!isCurrent(request, templateRequest.current)) return;
      const domain = domains.items[0];
      let topicId = "";
      if (domain) {
        const topics = await listTopics(certificationId, examVersionId, domain.id);
        if (!isCurrent(request, templateRequest.current)) return;
        topicId = topics.items[0]?.id ?? "";
      }
      const csv = domain && topicId
        ? makeTemplate(examVersionId, domain.id, topicId)
        : `${csvRow(importColumns)}\r\n`;
      downloadCsv(
        csv,
        `${safeFilenamePart(certificationName)}-${safeFilenamePart(examVersionName)}-import-template-v1.csv`,
      );
      setStatus(
        domain && topicId
          ? "Downloaded the v1 template with a synthetic example row. Replace the sample key and values before previewing."
          : "Downloaded the exact v1 header. This exam version needs a domain and topic before a valid example row can be prepared.",
      );
    } catch (cause) {
      if (isCurrent(request, templateRequest.current)) setError(apiErrorMessage(cause));
    } finally {
      if (isCurrent(request, templateRequest.current)) setTemplateBusy(false);
    }
  }

  async function runPreview() {
    if (!file) return;
    const request = ++previewRequest.current;
    const expectedScope = scope;
    confirmationRequest.current += 1;
    setPreview(null);
    setPreviewIssues([]);
    setPreviewSummary(null);
    setConfirmed(null);
    setConfirmRetry(false);
    setPreviewBusy(true);
    setError("");
    setStatus("");
    if (file.size > maxImportBytes) {
      setPreviewSummary({ parsedRows: 0, validRows: 0, invalidRows: 1 });
      setPreviewIssues([{ path: "row.1.file", code: "file_too_large" }]);
      setError("The CSV exceeds the 256 KiB import limit. Choose a smaller file.");
      setPreviewBusy(false);
      return;
    }
    try {
      const result = await previewQuestionImport(certificationId, examVersionId, file);
      if (!isCurrent(request, previewRequest.current) || activeScope.current !== expectedScope) return;
      setPreview({ kind: "valid", value: result });
      setPreviewSummary(result.summary);
      setStatus("Preview complete. No questions or publication records were created.");
    } catch (cause) {
      if (!isCurrent(request, previewRequest.current) || activeScope.current !== expectedScope) return;
      if (cause instanceof ProtectedApiError) {
        if (cause.summary) setPreviewSummary(cause.summary);
        setPreviewIssues(cause.issues);
        setPreview({
          kind: "invalid",
          summary: cause.summary ?? { parsedRows: 0, validRows: 0, invalidRows: 0 },
          issues: cause.issues,
        });
      }
      setError(apiErrorMessage(cause));
    } finally {
      if (isCurrent(request, previewRequest.current)) setPreviewBusy(false);
    }
  }

  async function confirmPreview() {
    if (preview?.kind !== "valid" || confirmed || confirmBusy) return;
    const request = ++confirmationRequest.current;
    const importId = preview.value.importId;
    setConfirmBusy(true);
    setConfirmRetry(false);
    setError("");
    setStatus("");
    try {
      const outcome = await confirmQuestionImport(certificationId, importId);
      if (!isCurrent(request, confirmationRequest.current)) return;
      setConfirmed(outcome);
      setStatus(`Import confirmed. ${outcome.questionIds.length} sealed draft question(s) were created for review; none were published.`);
    } catch (cause) {
      if (!isCurrent(request, confirmationRequest.current)) return;
      if (cause instanceof ProtectedApiError && cause.status === 409) {
        setPreview(null);
        setPreviewSummary(null);
        setPreviewIssues([]);
        setError("This preview expired or is no longer available. Preview the selected file again.");
      } else {
        setError(
          cause instanceof ProtectedApiError && (cause.status === 0 || cause.status === 503)
            ? "The confirmation response was not received. Retry the same preview ID; the server makes confirmation idempotent."
            : apiErrorMessage(cause),
        );
        setConfirmRetry(cause instanceof ProtectedApiError && (cause.status === 0 || cause.status === 503));
      }
    } finally {
      if (isCurrent(request, confirmationRequest.current)) setConfirmBusy(false);
    }
  }

  async function downloadExportPage() {
    const request = ++exportRequest.current;
    setExportBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await exportPublishedQuestionPage(
        certificationId,
        examVersionId,
        exportCursor ?? undefined,
      );
      if (!isCurrent(request, exportRequest.current)) return;
      downloadCsv(
        result.csv,
        `${safeFilenamePart(certificationName)}-${safeFilenamePart(examVersionName)}-published-page-${exportPage}.csv`,
      );
      setExportCursor(result.nextCursor);
      setHasMoreExport(result.nextCursor !== null);
      setStatus(
        result.nextCursor
          ? `Downloaded published-content page ${exportPage}. Another page is available.`
          : `Downloaded published-content page ${exportPage}. There are no more pages.`,
      );
      setExportPage((current) => current + 1);
    } catch (cause) {
      if (isCurrent(request, exportRequest.current)) setError(apiErrorMessage(cause));
    } finally {
      if (isCurrent(request, exportRequest.current)) setExportBusy(false);
    }
  }

  return (
    <section className="protected-csv-tools" aria-labelledby="protected-csv-tools-title">
      <div className="protected-editor-section-heading">
        <div>
          <h2 id="protected-csv-tools-title">CSV import and export</h2>
          <p>
            {certificationName} · {examVersionName}
          </p>
        </div>
      </div>
      <div className="protected-csv-tools-grid">
        <section aria-labelledby="protected-csv-import-title">
          <h3 id="protected-csv-import-title">Import new drafts</h3>
          <p>
            Version 1 accepts at most 10 questions and 256 KiB per file. Preview checks every row;
            confirmation creates sealed drafts for review only.
          </p>
          <button
            className="button-secondary"
            type="button"
            disabled={templateBusy}
            onClick={() => void downloadTemplate()}
          >
            {templateBusy ? "Preparing template…" : "Download exact v1 CSV template"}
          </button>
          <details className="protected-csv-template">
            <summary>Show the exact v1 header</summary>
            <textarea
              aria-label="Exact v1 CSV header"
              readOnly
              rows={3}
              value={csvRow(importColumns)}
            />
            <p>The downloaded file includes a synthetic example row when this version has a domain and topic.</p>
          </details>
          <label className="protected-csv-file">
            CSV file
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              onChange={selectFile}
            />
          </label>
          {file && <p>Selected: {file.name} ({file.size.toLocaleString()} bytes)</p>}
          <button
            className="button-primary"
            type="button"
            disabled={!file || previewBusy}
            onClick={() => void runPreview()}
          >
            {previewBusy ? "Validating CSV…" : "Preview selected CSV"}
          </button>
          {previewSummary && (
            <p className="protected-csv-summary" role="status" aria-live="polite">
              Parsed {previewSummary.parsedRows} row(s): {previewSummary.validRows} valid, {previewSummary.invalidRows} invalid.
            </p>
          )}
          {previewIssues.length > 0 && (
            <ul className="protected-csv-issues" aria-label="CSV validation errors">
              {previewIssues.map((issue, index) => (
                <li key={`${issue.path}-${issue.code}-${index}`}>{describeIssue(issue)}</li>
              ))}
            </ul>
          )}
          {preview?.kind === "valid" && (
            <div className="protected-csv-confirmation">
              <p>
                Preview expires {new Date(preview.value.expiresAt).toLocaleString()}.
                Confirmation creates sealed drafts only.
              </p>
              <button
                className="button-primary"
                type="button"
                disabled={confirmBusy || confirmed !== null}
                onClick={() => void confirmPreview()}
              >
                {confirmBusy
                  ? "Confirming…"
                  : confirmRetry
                    ? "Retry same preview"
                    : "Confirm draft-only import"}
              </button>
            </div>
          )}
          {confirmed && (
            <p className="protected-csv-confirmation" role="status">
              Created {confirmed.questionKeys.length} sealed draft(s): {confirmed.questionKeys.join(", ")}.
              They are not published.
            </p>
          )}
        </section>
        <section aria-labelledby="protected-csv-export-title">
          <h3 id="protected-csv-export-title">Export published content</h3>
          <p>
            Downloads up to 100 published questions per page. This spreadsheet-safe report is not a
            re-import file.
          </p>
          {(exportPage === 1 || hasMoreExport) && (
            <button
              className="button-secondary"
              type="button"
              disabled={exportBusy}
              onClick={() => void downloadExportPage()}
            >
              {exportBusy
                ? "Preparing export…"
                : `Download published page ${exportPage}`}
            </button>
          )}
          <p role="status" aria-live="polite">
            {hasMoreExport
              ? `Another page is available. Next download: page ${exportPage}.`
              : exportPage === 1
                ? "No export page has been downloaded yet."
                : "No additional export page is available."}
          </p>
        </section>
      </div>
      {error && <p className="protected-editor-status protected-editor-status--error" role="alert">{error}</p>}
      {status && <p className="protected-editor-status" role="status" aria-live="polite">{status}</p>}
    </section>
  );
}
