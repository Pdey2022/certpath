import { CsvError, parse } from "csv-parse/sync";
import type {
  ContentFailure,
  ContentResult,
  QuestionContentInput,
  ScopeGuard,
} from "./content.ts";
import {
  createScopeGuard,
  normalizeQuestionContent,
  prepareImportedQuestionDraft,
} from "./content.ts";
import {
  cleanupExpiredQuestionImports,
  expireQuestionImportPreview,
} from "./question-import-cleanup.ts";
import type {
  D1PreparedStatement,
  SecurityDatabase,
} from "./database.ts";
import {
  authorizeCertification,
  findActiveApplicationSession,
} from "./repository.ts";
import type { StaffMfaPolicy } from "./mfa.ts";
import { isConfiguredMfaPolicy } from "./mfa.ts";

export { cleanupExpiredQuestionImports } from "./question-import-cleanup.ts";

export const QUESTION_IMPORT_FORMAT = "certpath-question-v1";
export const QUESTION_IMPORT_MAX_BYTES = 256 * 1024;
export const QUESTION_IMPORT_MAX_ROWS = 10;
export const QUESTION_IMPORT_TTL_MS = 10 * 60 * 1000;
export const QUESTION_EXPORT_PAGE_MAX_ROWS = 100;

const MAX_CSV_RECORD_SIZE = 96 * 1024;
const OPTION_COUNT = 8;

export const QUESTION_IMPORT_TEMPLATE_COLUMNS = [
  "format_version",
  "question_key",
  "exam_version_id",
  "domain_id",
  "topic_id",
  "stem",
  "difficulty",
  "source_reference",
  "license_reference",
  ...Array.from({ length: OPTION_COUNT }, (_, index) => {
    const option = index + 1;
    return [
      `option_${option}_key`,
      `option_${option}_text`,
      `option_${option}_correct`,
      `option_${option}_explanation`,
    ];
  }).flat(),
];

export interface ImportValidationIssue {
  row: number;
  column: string;
  code: string;
}

export interface QuestionImportSummary {
  parsedRows: number;
  validRows: number;
  invalidRows: number;
}

export type QuestionImportPreviewResult =
  | {
      ok: true;
      value: {
        importId: string;
        formatVersion: typeof QUESTION_IMPORT_FORMAT;
        expiresAt: number;
        summary: QuestionImportSummary;
      };
    }
  | {
      ok: false;
      reason: ContentFailure | "payload-too-large";
      errors: ImportValidationIssue[];
      summary: QuestionImportSummary;
    };

export type QuestionImportConfirmationResult = ContentResult<{
  importId: string;
  questionIds: string[];
  revisionIds: string[];
  questionKeys: string[];
}>;

interface ImportRow {
  formatVersion: typeof QUESTION_IMPORT_FORMAT;
  questionKey: string;
  questionId: string;
  revisionId: string;
  examVersionId: string;
  domainId: string;
  topicId: string;
  content: QuestionContentInput;
}

interface StoredImportRow {
  row_number: number;
  question_key: string;
  question_id: string;
  revision_id: string;
  content_json: string | null;
}

interface ImportPreviewRow {
  id: string;
  certification_id: string;
  exam_version_id: string;
  actor_user_id: string;
  format_version: typeof QUESTION_IMPORT_FORMAT;
  state: "constructing" | "previewed" | "confirming" | "confirmed" | "expired";
  row_count: number;
  payload_digest: string;
  created_at: number;
  expires_at: number;
}

interface ParsedQuestionRow {
  row: ImportRow;
}

function isId(value: string): boolean {
  return /^[a-zA-Z0-9:_-]{1,128}$/.test(value);
}

function isQuestionKey(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 120 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value)
  );
}

function digestHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function payloadDigest(
  certificationId: string,
  examVersionId: string,
  actorUserId: string,
  rows: ImportRow[],
): Promise<string> {
  const payload = JSON.stringify({
    formatVersion: QUESTION_IMPORT_FORMAT,
    certificationId,
    examVersionId,
    actorUserId,
    rows,
  });
  return digestHex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)),
  );
}

function issue(
  row: number,
  column: string,
  code: string,
): ImportValidationIssue {
  return { row, column, code };
}

function parseQuestionRecord(
  record: string[],
  rowNumber: number,
  requestedExamVersionId: string,
): { parsed?: ParsedQuestionRow; issues: ImportValidationIssue[] } {
  const issues: ImportValidationIssue[] = [];
  if (record.length !== QUESTION_IMPORT_TEMPLATE_COLUMNS.length) {
    return {
      issues: [issue(rowNumber, "record", "column_count_mismatch")],
    };
  }

  const value = (column: string): string =>
    record[QUESTION_IMPORT_TEMPLATE_COLUMNS.indexOf(column)] ?? "";
  const questionKey = value("question_key").trim();
  const examVersionId = value("exam_version_id").trim();
  const domainId = value("domain_id").trim();
  const topicId = value("topic_id").trim();
  const formatVersion = value("format_version").trim();

  if (formatVersion !== QUESTION_IMPORT_FORMAT) {
    issues.push(issue(rowNumber, "format_version", "unsupported_format_version"));
  }
  if (!isQuestionKey(questionKey)) {
    issues.push(issue(rowNumber, "question_key", "invalid_question_key"));
  }
  if (examVersionId !== requestedExamVersionId || !isId(examVersionId)) {
    issues.push(issue(rowNumber, "exam_version_id", "invalid_exam_version"));
  }
  if (!isId(domainId)) issues.push(issue(rowNumber, "domain_id", "invalid_domain"));
  if (!isId(topicId)) issues.push(issue(rowNumber, "topic_id", "invalid_topic"));

  const options: QuestionContentInput["options"] = [];
  for (let index = 1; index <= OPTION_COUNT; index += 1) {
    const optionValues = [
      value(`option_${index}_key`),
      value(`option_${index}_text`),
      value(`option_${index}_correct`),
      value(`option_${index}_explanation`),
    ];
    if (optionValues.every((field) => field === "")) continue;
    if (optionValues.some((field) => field === "")) {
      issues.push(issue(rowNumber, `option_${index}`, "incomplete_option"));
      continue;
    }
    if (optionValues[2] !== "true" && optionValues[2] !== "false") {
      issues.push(
        issue(rowNumber, `option_${index}_correct`, "invalid_boolean"),
      );
      continue;
    }
    options.push({
      key: optionValues[0]!,
      text: optionValues[1]!,
      correct: optionValues[2] === "true",
      explanation: optionValues[3]!,
    });
  }

  const content: QuestionContentInput = {
    stem: value("stem"),
    difficulty: value("difficulty") as QuestionContentInput["difficulty"],
    sourceReference: value("source_reference"),
    licenseReference: value("license_reference"),
    options,
  };
  const normalized = normalizeQuestionContent(content);
  if (!normalized) {
    issues.push(issue(rowNumber, "content", "invalid_question_content"));
  }
  if (issues.length > 0 || !normalized) return { issues };

  const questionId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const row: ImportRow = {
    formatVersion: QUESTION_IMPORT_FORMAT,
    questionKey,
    questionId,
    revisionId,
    examVersionId,
    domainId,
    topicId,
    content: normalized,
  };
  return {
    parsed: {
      row,
    },
    issues: [],
  };
}

function parseCsv(fileBytes: Uint8Array):
  | { records: string[][]; issue?: never }
  | { records?: never; issue: ImportValidationIssue } {
  if (
    fileBytes.length >= 2 &&
    ((fileBytes[0] === 0xff && fileBytes[1] === 0xfe) ||
      (fileBytes[0] === 0xfe && fileBytes[1] === 0xff))
  ) {
    return { issue: issue(1, "file", "unsupported_encoding") };
  }
  if (
    fileBytes.length >= 3 &&
    fileBytes[0] === 0xef &&
    fileBytes[1] === 0xbb &&
    fileBytes[2] === 0xbf
  ) {
    return { issue: issue(1, "file", "utf8_bom_not_supported") };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(fileBytes);
  } catch (error) {
    if (error instanceof TypeError) {
      return { issue: issue(1, "file", "invalid_utf8") };
    }
    throw error;
  }
  if (text.includes("\u0000")) {
    return { issue: issue(1, "file", "unsupported_encoding") };
  }
  try {
    return {
      records: parse(text, {
        relax_column_count: true,
        skip_empty_lines: false,
        max_record_size: MAX_CSV_RECORD_SIZE,
      }),
    };
  } catch (error) {
    if (error instanceof CsvError) {
      const errorLine = error.lines;
      return {
        issue: issue(
          typeof errorLine === "number" ? Math.max(1, errorLine) : 1,
          "record",
          "malformed_csv",
        ),
      };
    }
    throw error;
  }
}

async function recordImportOutcome(
  database: SecurityDatabase,
  input: {
    tokenDigest: string;
    certificationId: string;
    now: number;
    policy: StaffMfaPolicy;
    actorUserId: string;
    action: string;
    subjectId: string;
    reason: string;
    operationId: string;
  },
): Promise<void> {
  const guard = createScopeGuard(
    input.tokenDigest,
    input.certificationId,
    input.now,
    input.policy,
  );
  await database
    .prepare(
      `INSERT INTO audit_events (
         operation_id, actor_user_id, action, subject_type, subject_id,
         certification_id, reason, occurred_at
       )
       SELECT ?, ?, ?, 'question_import', ?, ?, ?, ?
       WHERE ${guard.sql}`,
    )
    .bind(
      input.operationId,
      input.actorUserId,
      input.action,
      input.subjectId,
      input.certificationId,
      input.reason,
      input.now,
      ...guard.values,
    )
    .run();
}

export async function previewQuestionImport(
  database: SecurityDatabase,
  input: {
    tokenDigest: string;
    certificationId: string;
    examVersionId: string;
    fileBytes: Uint8Array;
    now: number;
  },
  policy: StaffMfaPolicy | undefined,
): Promise<QuestionImportPreviewResult> {
  const summary: QuestionImportSummary = {
    parsedRows: 0,
    validRows: 0,
    invalidRows: 0,
  };
  if (
    !isId(input.certificationId) ||
    !isId(input.examVersionId) ||
    !Number.isSafeInteger(input.now) ||
    !(input.fileBytes instanceof Uint8Array)
  ) {
    return {
      ok: false,
      reason: "invalid-input",
      errors: [issue(1, "request", "invalid_request")],
      summary,
    };
  }

  const authorization = await authorizeCertification(
    database,
    input.tokenDigest,
    input.certificationId,
    input.now,
    policy,
  );
  if (!authorization.allowed) {
    return { ok: false, reason: authorization.reason, errors: [], summary };
  }
  if (!isConfiguredMfaPolicy(policy)) {
    return {
      ok: false,
      reason: "mfa-policy-unconfigured",
      errors: [],
      summary,
    };
  }
  const version = await database
    .withSession("first-primary")
    .prepare(
      "SELECT id FROM exam_versions WHERE id = ? AND certification_id = ?",
    )
    .bind(input.examVersionId, input.certificationId)
    .first<{ id: string }>();
  const rejectPreview = async (
    reason: ContentFailure | "invalid-input" | "payload-too-large",
    errors: ImportValidationIssue[],
    rejectedSummary: QuestionImportSummary,
  ): Promise<QuestionImportPreviewResult> => {
    await recordImportOutcome(database, {
      tokenDigest: input.tokenDigest,
      certificationId: input.certificationId,
      now: input.now,
      policy,
      actorUserId: authorization.userId,
      action: "question_import_preview_rejected",
      subjectId: crypto.randomUUID(),
      reason: "input_validation_failed",
      operationId: `question-import-rejected:${crypto.randomUUID()}`,
    });
    return { ok: false, reason, errors, summary: rejectedSummary };
  };
  if (!version) {
    return rejectPreview(
      "not-found",
      [issue(1, "exam_version_id", "exam_version_not_found")],
      summary,
    );
  }
  const cleanup = await cleanupExpiredQuestionImports(database, input.now);
  if (!cleanup.ok) {
    return {
      ok: false,
      reason: cleanup.reason,
      errors: [],
      summary,
    };
  }

  if (input.fileBytes.byteLength > QUESTION_IMPORT_MAX_BYTES) {
    const errors = [issue(1, "file", "file_too_large")];
    return rejectPreview("payload-too-large", errors, {
      ...summary,
      invalidRows: 1,
    });
  }

  const parsedCsv = parseCsv(input.fileBytes);
  if (!parsedCsv.records) {
    return rejectPreview("invalid-input", [parsedCsv.issue], {
      ...summary,
      invalidRows: 1,
    });
  }
  const [header, ...records] = parsedCsv.records;
  summary.parsedRows = records.length;
  if (!header || header.length === 0) {
    return rejectPreview(
      "invalid-input",
      [issue(1, "header", "missing_header")],
      summary,
    );
  }
  const duplicateHeaders = new Set(
    header.filter((name, index) => header.indexOf(name) !== index),
  );
  if (duplicateHeaders.size > 0) {
    return rejectPreview(
      "invalid-input",
      [...duplicateHeaders].map(() => issue(1, "header", "duplicate_header")),
      summary,
    );
  }
  const unknownHeaders = header.filter(
    (name) => !QUESTION_IMPORT_TEMPLATE_COLUMNS.includes(name),
  );
  const missingHeaders = QUESTION_IMPORT_TEMPLATE_COLUMNS.filter(
    (name) => !header.includes(name),
  );
  if (unknownHeaders.length > 0 || missingHeaders.length > 0) {
    return rejectPreview(
      "invalid-input",
      [
        ...unknownHeaders.map(() => issue(1, "header", "unknown_header")),
        ...missingHeaders.map((name) =>
          issue(1, name, "missing_header"),
        ),
      ],
      summary,
    );
  }
  if (
    header.some(
      (name, index) => name !== QUESTION_IMPORT_TEMPLATE_COLUMNS[index],
    )
  ) {
    return rejectPreview(
      "invalid-input",
      [issue(1, "header", "column_order_mismatch")],
      summary,
    );
  }
  if (records.length === 0 || records.length > QUESTION_IMPORT_MAX_ROWS) {
    return rejectPreview(
      "invalid-input",
      [
        issue(
          records.length > QUESTION_IMPORT_MAX_ROWS
            ? QUESTION_IMPORT_MAX_ROWS + 2
            : 2,
          "record",
          records.length === 0 ? "no_question_rows" : "too_many_rows",
        ),
      ],
      {
        parsedRows: records.length,
        validRows: 0,
        invalidRows: records.length || 1,
      },
    );
  }

  summary.parsedRows = records.length;
  const issues: ImportValidationIssue[] = [];
  const rows: ParsedQuestionRow[] = [];
  const keys = new Set<string>();
  for (const [index, record] of records.entries()) {
    const rowNumber = index + 2;
    const parsed = parseQuestionRecord(record, rowNumber, input.examVersionId);
    issues.push(...parsed.issues);
    if (!parsed.parsed) continue;
    if (keys.has(parsed.parsed.row.questionKey)) {
      issues.push(issue(rowNumber, "question_key", "duplicate_question_key"));
      continue;
    }
    keys.add(parsed.parsed.row.questionKey);
    const topic = await database
      .withSession("first-primary")
      .prepare(
        `SELECT topic.id
         FROM topics AS topic
         JOIN domains AS domain
           ON domain.certification_id = topic.certification_id
          AND domain.exam_version_id = topic.exam_version_id
          AND domain.id = topic.domain_id
         WHERE topic.certification_id = ?
           AND topic.exam_version_id = ?
           AND topic.domain_id = ?
           AND topic.id = ?`,
      )
      .bind(
        input.certificationId,
        input.examVersionId,
        parsed.parsed.row.domainId,
        parsed.parsed.row.topicId,
      )
      .first<{ id: string }>();
    if (!topic) {
      issues.push(issue(rowNumber, "topic_id", "invalid_scope_reference"));
      continue;
    }
    const existing = await database
      .withSession("first-primary")
      .prepare(
        "SELECT id FROM questions WHERE certification_id = ? AND question_key = ?",
      )
      .bind(input.certificationId, parsed.parsed.row.questionKey)
      .first<{ id: string }>();
    if (existing) {
      issues.push(issue(rowNumber, "question_key", "existing_question_key"));
      continue;
    }
    rows.push(parsed.parsed);
  }
  summary.validRows = rows.length;
  summary.invalidRows = records.length - rows.length;
  if (issues.length > 0 || rows.length !== records.length) {
    return rejectPreview("invalid-input", issues, summary);
  }

  const importId = crypto.randomUUID();
  const importedRows = rows.map((row) => row.row);
  const digest = await payloadDigest(
    input.certificationId,
    input.examVersionId,
    authorization.userId,
    importedRows,
  );
  const expiresAt = input.now + QUESTION_IMPORT_TTL_MS;
  const scopeGuard: ScopeGuard = createScopeGuard(
    input.tokenDigest,
    input.certificationId,
    input.now,
    policy,
  );
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT INTO question_import_previews (
           id, certification_id, exam_version_id, actor_user_id,
           format_version, state, row_count, payload_digest, created_at, expires_at
         )
         SELECT ?, ?, ?, ?, ?, 'constructing', ?, ?, ?, ?
         WHERE ${scopeGuard.sql}`,
      )
      .bind(
        importId,
        input.certificationId,
        input.examVersionId,
        authorization.userId,
        QUESTION_IMPORT_FORMAT,
        importedRows.length,
        digest,
        input.now,
        expiresAt,
        ...scopeGuard.values,
      ),
  ];
  for (const [index, row] of importedRows.entries()) {
    statements.push(
      database
        .prepare(
          `INSERT INTO question_import_rows (
             import_id, row_number, question_key, question_id, revision_id, content_json
           )
           SELECT ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM question_import_previews
             WHERE id = ? AND state = 'constructing'
           )`,
        )
        .bind(
          importId,
          index + 1,
          row.questionKey,
          row.questionId,
          row.revisionId,
          JSON.stringify(row),
          importId,
        ),
    );
  }
  statements.push(
    database
      .prepare(
        `UPDATE question_import_previews
         SET state = 'previewed'
         WHERE id = ? AND state = 'constructing'`,
      )
      .bind(importId),
  );
  const results = await database.batch(statements);
  if ((results[0]?.meta.changes ?? 0) < 1 || (results.at(-1)?.meta.changes ?? 0) < 1) {
    return {
      ok: false,
      reason: "conflict",
      errors: [],
      summary,
    };
  }
  return {
    ok: true,
    value: {
      importId,
      formatVersion: QUESTION_IMPORT_FORMAT,
      expiresAt,
      summary,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readStoredImportRow(
  stored: StoredImportRow,
  preview: ImportPreviewRow,
): ImportRow | null {
  if (stored.content_json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(stored.content_json);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!isRecord(value)) return null;
  const formatVersion = value["formatVersion"];
  const questionKey = value["questionKey"];
  const questionId = value["questionId"];
  const revisionId = value["revisionId"];
  const examVersionId = value["examVersionId"];
  const domainId = value["domainId"];
  const topicId = value["topicId"];
  const content = normalizeQuestionContent(value["content"]);
  if (
    formatVersion !== QUESTION_IMPORT_FORMAT ||
    typeof questionKey !== "string" ||
    questionKey !== stored.question_key ||
    typeof questionId !== "string" ||
    questionId !== stored.question_id ||
    typeof revisionId !== "string" ||
    revisionId !== stored.revision_id ||
    typeof examVersionId !== "string" ||
    !isId(examVersionId) ||
    examVersionId !== preview.exam_version_id ||
    typeof domainId !== "string" ||
    !isId(domainId) ||
    typeof topicId !== "string" ||
    !isId(topicId) ||
    !isQuestionKey(questionKey) ||
    !content
  ) {
    return null;
  }
  return {
    formatVersion,
    questionKey,
    questionId,
    revisionId,
    examVersionId,
    domainId,
    topicId,
    content,
  };
}

async function importResultForPreview(
  database: SecurityDatabase,
  importId: string,
): Promise<QuestionImportConfirmationResult | null> {
  const preview = await database
    .withSession("first-primary")
    .prepare(
      `SELECT import_row.question_key, result.question_id, result.revision_id
       FROM question_import_results AS result
       JOIN question_import_rows AS import_row
         ON import_row.import_id = result.import_id
        AND import_row.row_number = result.row_number
       WHERE result.import_id = ? ORDER BY result.row_number`,
    )
    .bind(importId)
    .all<{
      question_key: string;
      question_id: string;
      revision_id: string;
    }>();
  if (preview.results.length === 0) return null;
  return {
    ok: true,
    value: {
      importId,
      questionKeys: preview.results.map((row) => row.question_key),
      questionIds: preview.results.map((row) => row.question_id),
      revisionIds: preview.results.map((row) => row.revision_id),
    },
  };
}

async function findImportPreview(
  database: SecurityDatabase,
  importId: string,
): Promise<ImportPreviewRow | null> {
  return database
    .withSession("first-primary")
    .prepare(
      `SELECT id, certification_id, exam_version_id, actor_user_id,
              format_version, state, row_count, payload_digest, created_at, expires_at
       FROM question_import_previews WHERE id = ?`,
    )
    .bind(importId)
    .first<ImportPreviewRow>();
}

async function recordConfirmationRejection(
  database: SecurityDatabase,
  input: {
    tokenDigest: string;
    certificationId: string;
    actorUserId: string;
    importId: string;
    now: number;
    policy: StaffMfaPolicy;
    reason: string;
  },
): Promise<void> {
  await recordImportOutcome(database, {
    tokenDigest: input.tokenDigest,
    certificationId: input.certificationId,
    now: input.now,
    policy: input.policy,
    actorUserId: input.actorUserId,
    action: "question_import_confirmation_rejected",
    subjectId: input.importId,
    reason: input.reason,
    operationId: `${input.importId}:rejected:${crypto.randomUUID()}`,
  });
}

export async function confirmQuestionImport(
  database: SecurityDatabase,
  input: {
    tokenDigest: string;
    importId: string;
    now: number;
  },
  policy: StaffMfaPolicy | undefined,
): Promise<QuestionImportConfirmationResult> {
  if (
    !isId(input.importId) ||
    !Number.isSafeInteger(input.now)
  ) {
    return { ok: false, reason: "invalid-input" };
  }
  if (!isConfiguredMfaPolicy(policy)) {
    return { ok: false, reason: "mfa-policy-unconfigured" };
  }
  const activeSession = await findActiveApplicationSession(
    database,
    input.tokenDigest,
    input.now,
  );
  if (!activeSession) return { ok: false, reason: "invalid-session" };
  const initial = await findImportPreview(database, input.importId);
  if (!initial) return { ok: false, reason: "not-found" };
  const authorization = await authorizeCertification(
    database,
    input.tokenDigest,
    initial.certification_id,
    input.now,
    policy,
  );
  if (!authorization.allowed) return { ok: false, reason: "not-found" };
  if (
    authorization.userId !== initial.actor_user_id ||
    activeSession.userId !== initial.actor_user_id
  ) {
    return { ok: false, reason: "not-found" };
  }
  const cleanup = await cleanupExpiredQuestionImports(database, input.now);
  if (!cleanup.ok) return cleanup;

  if (initial.state === "confirmed") {
    const established = await importResultForPreview(database, input.importId);
    return established ?? { ok: false, reason: "conflict" };
  }
  if (initial.state === "expired" || initial.expires_at <= input.now) {
    if (initial.state === "previewed") {
      await expireQuestionImportPreview(database, input.importId, input.now);
    }
    await recordConfirmationRejection(database, {
      tokenDigest: input.tokenDigest,
      certificationId: initial.certification_id,
      actorUserId: authorization.userId,
      importId: input.importId,
      now: input.now,
      policy,
      reason: "preview_expired",
    });
    return { ok: false, reason: "conflict" };
  }
  if (initial.state !== "previewed") {
    return { ok: false, reason: "conflict" };
  }

  const storedResult = await database
    .withSession("first-primary")
    .prepare(
      `SELECT row_number, question_key, question_id, revision_id, content_json
       FROM question_import_rows WHERE import_id = ? ORDER BY row_number`,
    )
    .bind(input.importId)
    .all<StoredImportRow>();
  const importedRows: ImportRow[] = [];
  for (const stored of storedResult.results) {
    const row = readStoredImportRow(stored, initial);
    if (!row) {
      await recordConfirmationRejection(database, {
        tokenDigest: input.tokenDigest,
        certificationId: initial.certification_id,
        actorUserId: authorization.userId,
        importId: input.importId,
        now: input.now,
        policy,
        reason: "preview_payload_invalid",
      });
      return { ok: false, reason: "invalid-input" };
    }
    importedRows.push(row);
  }
  const verifiedDigest = await payloadDigest(
    initial.certification_id,
    initial.exam_version_id,
    initial.actor_user_id,
    importedRows,
  );
  if (
    importedRows.length !== initial.row_count ||
    verifiedDigest !== initial.payload_digest
  ) {
    await recordConfirmationRejection(database, {
      tokenDigest: input.tokenDigest,
      certificationId: initial.certification_id,
      actorUserId: authorization.userId,
      importId: input.importId,
      now: input.now,
      policy,
      reason: "preview_payload_invalid",
    });
    return { ok: false, reason: "invalid-input" };
  }

  const additionalGuard: ScopeGuard = {
    sql: `EXISTS (
      SELECT 1 FROM question_import_previews AS import_preview
      WHERE import_preview.id = ?
        AND import_preview.state = 'confirming'
        AND import_preview.actor_user_id = ?
        AND import_preview.certification_id = ?
        AND import_preview.exam_version_id = ?
        AND import_preview.format_version = ?
        AND import_preview.row_count = ?
        AND import_preview.payload_digest = ?
        AND import_preview.created_at = ?
        AND import_preview.expires_at > ?
    )`,
    values: [
      input.importId,
      authorization.userId,
      initial.certification_id,
      initial.exam_version_id,
      QUESTION_IMPORT_FORMAT,
      initial.row_count,
      initial.payload_digest,
      initial.created_at,
      input.now,
    ],
  };
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `UPDATE question_import_previews SET state = 'confirming'
         WHERE id = ? AND state = 'previewed'
           AND actor_user_id = ? AND certification_id = ?
           AND exam_version_id = ? AND payload_digest = ?
           AND expires_at > ?`,
      )
      .bind(
        input.importId,
        authorization.userId,
        initial.certification_id,
        initial.exam_version_id,
        initial.payload_digest,
        input.now,
      ),
  ];
  for (const [index, row] of importedRows.entries()) {
    const metadata = {
      operationId: `${input.importId}:row:${index + 1}`,
      reason: `Question import ${input.importId}`,
      now: input.now,
    };
    const draft = await prepareImportedQuestionDraft(
      database,
      input.tokenDigest,
      {
        certificationId: initial.certification_id,
        examVersionId: row.examVersionId,
        domainId: row.domainId,
        topicId: row.topicId,
        questionKey: row.questionKey,
        questionId: row.questionId,
        revisionId: row.revisionId,
        content: row.content,
      },
      metadata,
      policy,
      authorization.userId,
      additionalGuard,
    );
    if (!draft.ok) return draft;
    statements.push(...draft.value.statements);
  }
  for (const stored of storedResult.results) {
    statements.push(
      database
        .prepare(
          `INSERT INTO question_import_results (
             import_id, row_number, certification_id, exam_version_id,
             question_id, revision_id
           )
           SELECT ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1
             FROM question_import_previews AS preview
             JOIN question_revisions AS revision
               ON revision.id = ?
              AND revision.question_id = ?
             JOIN question_revision_seals AS seal
               ON seal.certification_id = revision.certification_id
              AND seal.question_revision_id = revision.id
             WHERE preview.id = ?
               AND preview.state = 'confirming'
               AND preview.actor_user_id = ?
               AND preview.certification_id = ?
               AND preview.exam_version_id = ?
           )`,
        )
        .bind(
          input.importId,
          stored.row_number,
          initial.certification_id,
          initial.exam_version_id,
          stored.question_id,
          stored.revision_id,
          stored.revision_id,
          stored.question_id,
          input.importId,
          authorization.userId,
          initial.certification_id,
          initial.exam_version_id,
        ),
    );
  }
  statements.push(
    database
      .prepare(
        `UPDATE question_import_previews
         SET state = 'confirmed', confirmed_at = ?
         WHERE id = ? AND state = 'confirming'
           AND actor_user_id = ? AND payload_digest = ?`,
      )
      .bind(
        input.now,
        input.importId,
        authorization.userId,
        initial.payload_digest,
      ),
    database
      .prepare(
        `UPDATE question_import_rows SET content_json = NULL
         WHERE import_id = ? AND content_json IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM question_import_previews
             WHERE id = ? AND state = 'confirmed'
           )`,
      )
      .bind(input.importId, input.importId),
  );

  let results;
  try {
    results = await database.batch(statements);
  } catch (error) {
    const current = await findImportPreview(database, input.importId);
    if (
      current?.state === "confirmed" &&
      current.actor_user_id === authorization.userId
    ) {
      const established = await importResultForPreview(database, input.importId);
      if (established) return established;
    }
    const currentAuthorization = await authorizeCertification(
      database,
      input.tokenDigest,
      initial.certification_id,
      input.now,
      policy,
    );
    if (!currentAuthorization.allowed) {
      return { ok: false, reason: currentAuthorization.reason };
    }
    if (
      current?.state === "previewed" &&
      current.actor_user_id === authorization.userId
    ) {
      for (const row of importedRows) {
        const existing = await database
          .withSession("first-primary")
          .prepare(
            `SELECT id FROM questions
             WHERE certification_id = ? AND question_key = ?`,
          )
          .bind(initial.certification_id, row.questionKey)
          .first<{ id: string }>();
        if (existing) {
          await recordConfirmationRejection(database, {
            tokenDigest: input.tokenDigest,
            certificationId: initial.certification_id,
            actorUserId: authorization.userId,
            importId: input.importId,
            now: input.now,
            policy,
            reason: "existing_question_key",
          });
          return { ok: false, reason: "conflict" };
        }
      }
      try {
        await recordConfirmationRejection(database, {
          tokenDigest: input.tokenDigest,
          certificationId: initial.certification_id,
          actorUserId: authorization.userId,
          importId: input.importId,
          now: input.now,
          policy,
          reason: "confirmation_failed",
        });
      } catch (auditError) {
        throw new AggregateError(
          [error, auditError],
          "Question import failed and its failure audit could not be recorded",
        );
      }
    }
    throw error;
  }
  if (
    (results[0]?.meta.changes ?? 0) < 1 ||
    (results.at(-2)?.meta.changes ?? 0) < 1
  ) {
    const current = await findImportPreview(database, input.importId);
    if (current?.state === "confirmed") {
      const established = await importResultForPreview(database, input.importId);
      if (established) return established;
    }
    return { ok: false, reason: "conflict" };
  }
  return {
    ok: true,
    value: {
      importId: input.importId,
      questionKeys: importedRows.map((row) => row.questionKey),
      questionIds: importedRows.map((row) => row.questionId),
      revisionIds: importedRows.map((row) => row.revisionId),
    },
  };
}

function csvCell(value: string): string {
  const formulaLeading =
    /^[\t\r\n=+\-@]/.test(value) || /^\s*[=+\-@]/u.test(value);
  const safeValue = formulaLeading ? `'${value}` : value;
  return `"${safeValue.replaceAll('"', '""')}"`;
}

function serializeCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

interface ExportRow {
  question_id: string;
  question_key: string;
  exam_version_id: string;
  domain_id: string;
  topic_id: string;
  stem: string;
  difficulty: string;
  source_reference: string;
  license_reference: string;
  option_key: string;
  option_order: number;
  option_text: string;
  is_correct: number;
  explanation: string;
}

export async function exportPublishedQuestions(
  database: SecurityDatabase,
  input: {
    tokenDigest: string;
    certificationId: string;
    examVersionId: string;
    now: number;
    cursor?: string;
    pageSize?: number;
  },
  policy: StaffMfaPolicy | undefined,
): Promise<
  ContentResult<{
    formatVersion: typeof QUESTION_IMPORT_FORMAT;
    csv: string;
    rowCount: number;
    nextCursor: string | null;
  }>
> {
  if (
    !isId(input.certificationId) ||
    !isId(input.examVersionId) ||
    !Number.isSafeInteger(input.now) ||
    (input.cursor !== undefined && !isId(input.cursor))
  ) {
    return { ok: false, reason: "invalid-input" };
  }
  const authorization = await authorizeCertification(
    database,
    input.tokenDigest,
    input.certificationId,
    input.now,
    policy,
  );
  if (!authorization.allowed) return { ok: false, reason: authorization.reason };
  if (!isConfiguredMfaPolicy(policy)) {
    return { ok: false, reason: "mfa-policy-unconfigured" };
  }
  const pageSize = input.pageSize ?? QUESTION_EXPORT_PAGE_MAX_ROWS;
  if (
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > QUESTION_EXPORT_PAGE_MAX_ROWS
  ) {
    return { ok: false, reason: "invalid-input" };
  }
  const version = await database
    .withSession("first-primary")
    .prepare(
      "SELECT id FROM exam_versions WHERE id = ? AND certification_id = ?",
    )
    .bind(input.examVersionId, input.certificationId)
    .first<{ id: string }>();
  if (!version) return { ok: false, reason: "not-found" };
  const cleanup = await cleanupExpiredQuestionImports(database, input.now);
  if (!cleanup.ok) return cleanup;

  const guard = createScopeGuard(
    input.tokenDigest,
    input.certificationId,
    input.now,
    policy,
  );
  const result = await database
    .withSession("first-primary")
    .prepare(
      `WITH page AS (
         SELECT question.id AS question_id, question.question_key,
                revision.exam_version_id, revision.domain_id, revision.topic_id,
                revision.stem, revision.difficulty, revision.source_reference,
                revision.license_reference
         FROM exam_version_questions AS pointer
         JOIN questions AS question
           ON question.certification_id = pointer.certification_id
          AND question.id = pointer.question_id
         JOIN question_revisions AS revision
           ON revision.certification_id = pointer.certification_id
          AND revision.question_id = pointer.question_id
          AND revision.id = pointer.question_revision_id
         JOIN question_revision_seals AS seal
           ON seal.certification_id = revision.certification_id
          AND seal.question_revision_id = revision.id
         WHERE pointer.certification_id = ?
           AND pointer.exam_version_id = ?
           AND pointer.publication_state = 'published'
           AND (? IS NULL OR question.id > ?)
           AND ${guard.sql}
         ORDER BY question.id
         LIMIT ?
       )
       SELECT page.*, option.option_key, option.option_order,
              option.option_text, option.is_correct, option.explanation
       FROM page
       JOIN answer_options AS option
         ON option.question_revision_id = (
           SELECT pointer.question_revision_id
           FROM exam_version_questions AS pointer
           WHERE pointer.certification_id = ?
             AND pointer.exam_version_id = ?
             AND pointer.question_id = page.question_id
             AND pointer.publication_state = 'published'
         )
       ORDER BY page.question_id, option.option_order`,
    )
    .bind(
      input.certificationId,
      input.examVersionId,
      input.cursor ?? null,
      input.cursor ?? null,
      ...guard.values,
      pageSize + 1,
      input.certificationId,
      input.examVersionId,
    )
    .all<ExportRow>();

  const grouped = new Map<string, { first: ExportRow; options: ExportRow[] }>();
  for (const row of result.results) {
    let group = grouped.get(row.question_id);
    if (!group) {
      group = { first: row, options: [] };
      grouped.set(row.question_id, group);
    }
    group.options.push(row);
  }
  const questions = [...grouped.values()];
  const hasMore = questions.length > pageSize;
  const pageQuestions = questions.slice(0, pageSize);
  const csvRows = [
    QUESTION_IMPORT_TEMPLATE_COLUMNS,
    ...pageQuestions.map(({ first, options }) => {
      const cells = [
        QUESTION_IMPORT_FORMAT,
        first.question_key,
        first.exam_version_id,
        first.domain_id,
        first.topic_id,
        first.stem,
        first.difficulty,
        first.source_reference,
        first.license_reference,
      ];
      for (let index = 1; index <= OPTION_COUNT; index += 1) {
        const option = options[index - 1];
        cells.push(
          option?.option_key ?? "",
          option?.option_text ?? "",
          option ? (option.is_correct === 1 ? "true" : "false") : "",
          option?.explanation ?? "",
        );
      }
      return cells;
    }),
  ];
  const operationId = `question-export:${crypto.randomUUID()}`;
  const audit = await database
    .prepare(
      `INSERT INTO audit_events (
         operation_id, actor_user_id, action, subject_type, subject_id,
         certification_id, reason, occurred_at
       )
       SELECT ?, ?, 'question_exported', 'exam_version', ?, ?, ?, ?
       WHERE ${guard.sql}
         AND EXISTS (
           SELECT 1 FROM exam_versions
           WHERE id = ? AND certification_id = ?
         )`,
    )
    .bind(
      operationId,
      authorization.userId,
      input.examVersionId,
      input.certificationId,
      `format=${QUESTION_IMPORT_FORMAT}; rows=${pageQuestions.length}; has_more=${hasMore}`,
      input.now,
      ...guard.values,
      input.examVersionId,
      input.certificationId,
    )
    .run();
  if (audit.meta.changes !== 1) {
    const current = await authorizeCertification(
      database,
      input.tokenDigest,
      input.certificationId,
      input.now,
      policy,
    );
    return current.allowed
      ? { ok: false, reason: "conflict" }
      : { ok: false, reason: current.reason };
  }
  return {
    ok: true,
    value: {
      formatVersion: QUESTION_IMPORT_FORMAT,
      csv: serializeCsv(csvRows),
      rowCount: pageQuestions.length,
      nextCursor:
        hasMore && pageQuestions.length > 0
          ? pageQuestions.at(-1)!.first.question_id
          : null,
    },
  };
}
