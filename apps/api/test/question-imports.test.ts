import { env } from "cloudflare:workers";
import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  createDraftQuestion,
  publishQuestionRevision,
  recordQuestionReview,
  submitQuestionForReview,
} from "../src/security/content.ts";
import {
  cleanupExpiredQuestionImports,
  confirmQuestionImport,
  exportPublishedQuestions,
  previewQuestionImport,
  QUESTION_EXPORT_PAGE_MAX_ROWS,
  QUESTION_IMPORT_FORMAT,
  QUESTION_IMPORT_MAX_BYTES,
  QUESTION_IMPORT_MAX_ROWS,
  QUESTION_IMPORT_TEMPLATE_COLUMNS,
} from "../src/security/question-imports.ts";
import {
  assignTestCertification,
  createTestCertification,
  createTestIdentity,
  createTestSession,
  grantTestRole,
  testNow,
} from "./factories.ts";
import {
  contentMfaPolicy,
  contentOperation,
  createContentScope,
  countRows,
  validQuestionContent,
} from "./content-fixtures.ts";

const database: SecurityDatabase = env.DB;

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function makeRecord(
  scope: { examVersionId: string; domainId: string; topicId: string },
  questionKey: string,
  changes: {
    stem?: string;
    difficulty?: string;
    examVersionId?: string;
    domainId?: string;
    topicId?: string;
    options?: typeof validQuestionContent.options;
  } = {},
): string[] {
  const options = changes.options ?? validQuestionContent.options;
  const values = [
    QUESTION_IMPORT_FORMAT,
    questionKey,
    changes.examVersionId ?? scope.examVersionId,
    changes.domainId ?? scope.domainId,
    changes.topicId ?? scope.topicId,
    changes.stem ?? validQuestionContent.stem,
    changes.difficulty ?? validQuestionContent.difficulty,
    validQuestionContent.sourceReference,
    validQuestionContent.licenseReference,
  ];
  for (let index = 0; index < 8; index += 1) {
    const option = options[index];
    values.push(
      option?.key ?? "",
      option?.text ?? "",
      option ? String(option.correct) : "",
      option?.explanation ?? "",
    );
  }
  return values;
}

function makeCsv(records: string[][]): string {
  return [
    QUESTION_IMPORT_TEMPLATE_COLUMNS,
    ...records,
  ]
    .map((record) => record.map(csvCell).join(","))
    .join("\r\n") + "\r\n";
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function previewInput(
  scope: Awaited<ReturnType<typeof createContentScope>>,
  records: string[][],
) {
  return {
    tokenDigest: scope.tokenDigest,
    certificationId: scope.certificationId,
    examVersionId: scope.examVersionId,
    fileBytes: bytes(makeCsv(records)),
    now: testNow,
  };
}

async function createPreview(
  scope: Awaited<ReturnType<typeof createContentScope>>,
  questionKey = `import-${crypto.randomUUID()}`,
  record = makeRecord(scope, questionKey),
) {
  return previewQuestionImport(
    database,
    previewInput(scope, [record]),
    contentMfaPolicy,
  );
}

async function publishQuestion(
  scope: Awaited<ReturnType<typeof createContentScope>>,
  questionKey: string,
  content = validQuestionContent,
) {
  const draft = await createDraftQuestion(
    database,
    scope.tokenDigest,
    {
      certificationId: scope.certificationId,
      examVersionId: scope.examVersionId,
      domainId: scope.domainId,
      topicId: scope.topicId,
      questionKey,
      content,
    },
    contentOperation("export-question"),
    contentMfaPolicy,
  );
  expect(draft.ok).toBe(true);
  if (!draft.ok) return;

  const submitted = await submitQuestionForReview(
    database,
    scope.tokenDigest,
    {
      certificationId: scope.certificationId,
      revisionId: draft.value.revisionId,
    },
    contentOperation("export-submit"),
    contentMfaPolicy,
  );
  expect(submitted.ok).toBe(true);
  const reviewed = await recordQuestionReview(
    database,
    scope.tokenDigest,
    {
      certificationId: scope.certificationId,
      revisionId: draft.value.revisionId,
      decision: "approved",
      notes: "Synthetic export test review",
    },
    contentOperation("export-review"),
    contentMfaPolicy,
  );
  expect(reviewed.ok).toBe(true);
  const published = await publishQuestionRevision(
    database,
    scope.tokenDigest,
    {
      certificationId: scope.certificationId,
      examVersionId: scope.examVersionId,
      questionId: draft.value.questionId,
      revisionId: draft.value.revisionId,
      expectedPointerVersion: null,
    },
    contentOperation("export-publish"),
    contentMfaPolicy,
  );
  expect(published.ok).toBe(true);
  return draft.value;
}

describe("internal D1 question-bank imports and exports", () => {
  it("previews quoted, escaped and multiline fields without writing content", async () => {
    const scope = await createContentScope(database);
    const stem = 'Which value, on multiple lines,\ncontains a "quoted" phrase?';
    const options = validQuestionContent.options.map((option, index) =>
      index === 0
        ? { ...option, text: 'A comma, quote " and newline\nare preserved' }
        : option,
    );
    const result = await previewQuestionImport(
      database,
      previewInput(scope, [
        makeRecord(scope, `multiline-${crypto.randomUUID()}`, {
          stem,
          options,
        }),
      ]),
      contentMfaPolicy,
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        formatVersion: QUESTION_IMPORT_FORMAT,
        summary: { parsedRows: 1, validRows: 1, invalidRows: 0 },
      },
    });
    expect(await countRows(database, "questions", "certification_id", scope.certificationId)).toBe(0);
    expect(await countRows(database, "question_revisions", "certification_id", scope.certificationId)).toBe(0);
    expect(await countRows(database, "exam_version_questions", "certification_id", scope.certificationId)).toBe(0);
  });

  it("confirms sealed draft revisions once and returns the same outcome on retries", async () => {
    const scope = await createContentScope(database);
    const questionKey = `confirm-${crypto.randomUUID()}`;
    const preview = await createPreview(scope, questionKey);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const input = {
      tokenDigest: scope.tokenDigest,
      importId: preview.value.importId,
      now: testNow,
    };
    const confirmed = await confirmQuestionImport(
      database,
      input,
      contentMfaPolicy,
    );
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(
      await confirmQuestionImport(database, input, contentMfaPolicy),
    ).toEqual(confirmed);
    expect(await countRows(database, "questions", "certification_id", scope.certificationId)).toBe(1);
    expect(await countRows(database, "question_revision_seals", "question_revision_id", confirmed.value.revisionIds[0]!)).toBe(1);
    expect(await countRows(database, "exam_version_questions", "certification_id", scope.certificationId)).toBe(0);
    expect(
      await database
        .prepare(
          "SELECT COUNT(*) AS count FROM question_import_rows WHERE import_id = ? AND content_json IS NOT NULL",
        )
        .bind(preview.value.importId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 0 });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count FROM audit_events
           WHERE subject_id = ? AND action = 'question_import_confirmed'`,
        )
        .bind(preview.value.importId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 1 });
  });

  it("confirms the maximum ten-row import with eight options per revision in one bounded batch", async () => {
    const scope = await createContentScope(database);
    const eightOptions = [
      ...validQuestionContent.options,
      {
        key: "E",
        text: "A synthetic fifth choice",
        correct: false,
        explanation: "This additional synthetic choice is not correct.",
      },
      {
        key: "F",
        text: "A synthetic sixth choice",
        correct: false,
        explanation: "This additional synthetic choice is not correct.",
      },
      {
        key: "G",
        text: "A synthetic seventh choice",
        correct: false,
        explanation: "This additional synthetic choice is not correct.",
      },
      {
        key: "H",
        text: "A synthetic eighth choice",
        correct: false,
        explanation: "This additional synthetic choice is not correct.",
      },
    ];
    const preview = await previewQuestionImport(
      database,
      previewInput(
        scope,
        Array.from({ length: QUESTION_IMPORT_MAX_ROWS }, (_, index) =>
          makeRecord(
            scope,
            `max-batch-${index}-${crypto.randomUUID()}`,
            { options: eightOptions },
          ),
        ),
      ),
      contentMfaPolicy,
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const confirmed = await confirmQuestionImport(
      database,
      {
        tokenDigest: scope.tokenDigest,
        importId: preview.value.importId,
        now: testNow,
      },
      contentMfaPolicy,
    );
    expect(confirmed).toMatchObject({
      ok: true,
      value: { questionKeys: expect.arrayContaining([expect.any(String)]) },
    });
    expect(await countRows(database, "questions", "certification_id", scope.certificationId)).toBe(QUESTION_IMPORT_MAX_ROWS);
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM question_import_results AS result
           JOIN question_import_rows AS import_row
             ON import_row.import_id = result.import_id
            AND import_row.row_number = result.row_number
           JOIN answer_options AS option
             ON option.question_revision_id = result.revision_id
           WHERE result.import_id = ?`,
        )
        .bind(preview.value.importId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: QUESTION_IMPORT_MAX_ROWS * 8 });
  });

  it("rejects malformed, oversized, unsupported and structurally invalid CSV", async () => {
    const scope = await createContentScope(database);
    const malformed = await previewQuestionImport(
      database,
      {
        ...previewInput(scope, []),
        fileBytes: bytes(`${QUESTION_IMPORT_TEMPLATE_COLUMNS.join(",")}\n"unterminated`),
      },
      contentMfaPolicy,
    );
    expect(malformed).toMatchObject({
      ok: false,
      errors: [{ code: "malformed_csv" }],
    });

    const oversized = await previewQuestionImport(
      database,
      {
        ...previewInput(scope, []),
        fileBytes: new Uint8Array(QUESTION_IMPORT_MAX_BYTES + 1),
      },
      contentMfaPolicy,
    );
    expect(oversized).toMatchObject({ ok: false, reason: "payload-too-large" });

    const utf16 = await previewQuestionImport(
      database,
      {
        ...previewInput(scope, []),
        fileBytes: new Uint8Array([0xff, 0xfe, 0x41, 0x00]),
      },
      contentMfaPolicy,
    );
    expect(utf16).toMatchObject({
      ok: false,
      errors: [{ code: "unsupported_encoding" }],
    });

    const duplicateHeader = [...QUESTION_IMPORT_TEMPLATE_COLUMNS];
    duplicateHeader[1] = duplicateHeader[0]!;
    const duplicate = await previewQuestionImport(
      database,
      {
        ...previewInput(scope, []),
        fileBytes: bytes(`${duplicateHeader.join(",")}\n`),
      },
      contentMfaPolicy,
    );
    expect(duplicate).toMatchObject({
      ok: false,
      errors: [{ code: "duplicate_header" }],
    });

    const unknownHeader = [...QUESTION_IMPORT_TEMPLATE_COLUMNS, "unexpected"];
    const unknown = await previewQuestionImport(
      database,
      {
        ...previewInput(scope, []),
        fileBytes: bytes(`${unknownHeader.join(",")}\n`),
      },
      contentMfaPolicy,
    );
    expect(unknown).toMatchObject({
      ok: false,
      errors: [{ code: "unknown_header" }],
    });

    const tooManyRows = await previewQuestionImport(
      database,
      previewInput(
        scope,
        Array.from({ length: QUESTION_IMPORT_MAX_ROWS + 1 }, (_, index) =>
          makeRecord(scope, `limit-${index}-${crypto.randomUUID()}`),
        ),
      ),
      contentMfaPolicy,
    );
    expect(tooManyRows).toMatchObject({
      ok: false,
      errors: [{ code: "too_many_rows" }],
      summary: { parsedRows: QUESTION_IMPORT_MAX_ROWS + 1 },
    });
  });

  it("rejects duplicate keys, existing keys, invalid content and cross-scope references", async () => {
    const scope = await createContentScope(database);
    const duplicateKey = `duplicate-${crypto.randomUUID()}`;
    const duplicate = await previewQuestionImport(
      database,
      previewInput(scope, [
        makeRecord(scope, duplicateKey),
        makeRecord(scope, duplicateKey),
      ]),
      contentMfaPolicy,
    );
    expect(duplicate).toMatchObject({
      ok: false,
      errors: [{ row: 3, column: "question_key", code: "duplicate_question_key" }],
    });

    const existingKey = `existing-${crypto.randomUUID()}`;
    const existingQuestion = await createDraftQuestion(
      database,
      scope.tokenDigest,
      {
        certificationId: scope.certificationId,
        examVersionId: scope.examVersionId,
        domainId: scope.domainId,
        topicId: scope.topicId,
        questionKey: existingKey,
        content: validQuestionContent,
      },
      contentOperation("existing-import-key"),
      contentMfaPolicy,
    );
    expect(existingQuestion.ok).toBe(true);
    const existing = await createPreview(
      scope,
      existingKey,
      makeRecord(scope, existingKey),
    );
    expect(existing).toMatchObject({
      ok: false,
      errors: [{ code: "existing_question_key" }],
    });

    const invalidContent = await createPreview(
      scope,
      `invalid-${crypto.randomUUID()}`,
      makeRecord(scope, `invalid-${crypto.randomUUID()}`, {
        options: validQuestionContent.options.map((option) => ({
          ...option,
          correct: false,
        })),
      }),
    );
    expect(invalidContent).toMatchObject({
      ok: false,
      errors: [{ column: "content", code: "invalid_question_content" }],
    });

    const otherScope = await createContentScope(database);
    const foreignReference = await createPreview(
      scope,
      `foreign-${crypto.randomUUID()}`,
      makeRecord(scope, `foreign-${crypto.randomUUID()}`, {
        domainId: otherScope.domainId,
        topicId: otherScope.topicId,
      }),
    );
    expect(foreignReference).toMatchObject({
      ok: false,
      errors: [{ code: "invalid_scope_reference" }],
    });

    const wrongVersion = await createPreview(
      scope,
      `version-${crypto.randomUUID()}`,
      makeRecord(scope, `version-${crypto.randomUUID()}`, {
        examVersionId: crypto.randomUUID(),
      }),
    );
    expect(wrongVersion).toMatchObject({
      ok: false,
      errors: [{ column: "exam_version_id", code: "invalid_exam_version" }],
    });
  });

  it("denies learners, unassigned Managers, and missing or stale MFA", async () => {
    const scope = await createContentScope(database);
    const learner = await createTestIdentity(database);
    const learnerToken = await createTestSession(database, learner.userId, {
      mfaMethod: "totp",
    });
    expect(
      await previewQuestionImport(
        database,
        {
          ...previewInput(scope, [makeRecord(scope, `learner-${crypto.randomUUID()}`)]),
          tokenDigest: learnerToken,
        },
        contentMfaPolicy,
      ),
    ).toMatchObject({ ok: false, reason: "not-staff" });

    const unassignedManager = await createTestIdentity(database);
    await grantTestRole(database, unassignedManager.userId, "manager");
    const unassignedToken = await createTestSession(
      database,
      unassignedManager.userId,
      { mfaMethod: "totp" },
    );
    expect(
      await previewQuestionImport(
        database,
        {
          ...previewInput(scope, [makeRecord(scope, `unassigned-${crypto.randomUUID()}`)]),
          tokenDigest: unassignedToken,
        },
        contentMfaPolicy,
      ),
    ).toMatchObject({ ok: false, reason: "certification-unassigned" });

    await database
      .prepare(
        "UPDATE app_sessions SET mfa_method = NULL, mfa_verified_at = NULL WHERE token_digest = ?",
      )
      .bind(scope.tokenDigest)
      .run();
    expect(
      await previewQuestionImport(
        database,
        previewInput(scope, [makeRecord(scope, `no-mfa-${crypto.randomUUID()}`)]),
        contentMfaPolicy,
      ),
    ).toMatchObject({ ok: false, reason: "mfa-assurance-missing" });

    await database
      .prepare(
        "UPDATE app_sessions SET mfa_method = 'totp', mfa_verified_at = ? WHERE token_digest = ?",
      )
      .bind(testNow - contentMfaPolicy.maxAgeMs - 1, scope.tokenDigest)
      .run();
    expect(
      await previewQuestionImport(
        database,
        previewInput(scope, [makeRecord(scope, `stale-mfa-${crypto.randomUUID()}`)]),
        contentMfaPolicy,
      ),
    ).toMatchObject({ ok: false, reason: "mfa-assurance-stale" });
  });

  it("rechecks session and assignment revocation at confirmation", async () => {
    const scope = await createContentScope(database, { role: "manager" });
    const preview = await createPreview(scope);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    await database
      .prepare(
        `UPDATE manager_certification_assignments
         SET active = 0, operation_id = ?, reason = 'Synthetic revocation', changed_at = ?
         WHERE manager_user_id = ? AND certification_id = ?`,
      )
      .bind(
        `revoke-import-assignment:${crypto.randomUUID()}`,
        testNow + 1,
        scope.userId,
        scope.certificationId,
      )
      .run();
    expect(
      await confirmQuestionImport(
        database,
        {
          tokenDigest: scope.tokenDigest,
          importId: preview.value.importId,
          now: testNow + 1,
        },
        contentMfaPolicy,
      ),
    ).toMatchObject({ ok: false, reason: "not-found" });
    expect(await countRows(database, "questions", "certification_id", scope.certificationId)).toBe(0);

    const second = await createContentScope(database);
    const sessionPreview = await createPreview(second);
    expect(sessionPreview.ok).toBe(true);
    if (!sessionPreview.ok) return;
    await database
      .prepare(
        `UPDATE app_sessions
         SET revoked_at = ?, revocation_operation_id = ?, revoked_by_user_id = ?
         WHERE token_digest = ?`,
      )
      .bind(
        testNow + 1,
        `revoke-import-session:${crypto.randomUUID()}`,
        second.userId,
        second.tokenDigest,
      )
      .run();
    expect(
      await confirmQuestionImport(
        database,
        {
          tokenDigest: second.tokenDigest,
          importId: sessionPreview.value.importId,
          now: testNow + 1,
        },
        contentMfaPolicy,
      ),
    ).toMatchObject({ ok: false, reason: "invalid-session" });
  });

  it("rejects a stable-key conflict introduced after preview without partial drafts", async () => {
    const scope = await createContentScope(database);
    const questionKey = `race-key-${crypto.randomUUID()}`;
    const preview = await createPreview(scope, questionKey);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const competingDraft = await createDraftQuestion(
      database,
      scope.tokenDigest,
      {
        certificationId: scope.certificationId,
        examVersionId: scope.examVersionId,
        domainId: scope.domainId,
        topicId: scope.topicId,
        questionKey,
        content: validQuestionContent,
      },
      contentOperation("competing-key"),
      contentMfaPolicy,
    );
    expect(competingDraft.ok).toBe(true);
    const before = await countRows(
      database,
      "questions",
      "certification_id",
      scope.certificationId,
    );
    expect(
      await confirmQuestionImport(
        database,
        {
          tokenDigest: scope.tokenDigest,
          importId: preview.value.importId,
          now: testNow,
        },
        contentMfaPolicy,
      ),
    ).toMatchObject({ ok: false, reason: "conflict" });
    expect(
      await countRows(
        database,
        "questions",
        "certification_id",
        scope.certificationId,
      ),
    ).toBe(before);
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count FROM audit_events
           WHERE subject_id = ? AND action = 'question_import_confirmed'`,
        )
        .bind(preview.value.importId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 0 });
  });

  it("rejects client-tampered preview data and cleans expired validated rows", async () => {
    const scope = await createContentScope(database);
    const preview = await createPreview(scope);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    await expect(
      database
        .prepare(
          "UPDATE question_import_rows SET content_json = '{}' WHERE import_id = ?",
        )
        .bind(preview.value.importId)
        .run(),
    ).rejects.toThrow();
    expect(
      await confirmQuestionImport(
        database,
        {
          tokenDigest: scope.tokenDigest,
          importId: crypto.randomUUID(),
          now: testNow,
        },
        contentMfaPolicy,
      ),
    ).toMatchObject({ ok: false, reason: "not-found" });

    const cleanupPreview = await createPreview(
      scope,
      `cleanup-${crypto.randomUUID()}`,
    );
    expect(cleanupPreview.ok).toBe(true);
    if (!cleanupPreview.ok) return;
    const cleanup = await cleanupExpiredQuestionImports(
      database,
      cleanupPreview.value.expiresAt,
    );
    expect(cleanup).toMatchObject({ ok: true, value: { expired: expect.any(Number) } });
    if (!cleanup.ok) return;
    expect(cleanup.value.expired).toBeGreaterThanOrEqual(1);
    expect(
      await database
        .prepare(
          "SELECT COUNT(*) AS count FROM question_import_rows WHERE import_id = ?",
        )
        .bind(cleanupPreview.value.importId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 0 });
    expect(
      await database
        .prepare(
          `SELECT state FROM question_import_previews WHERE id = ?`,
        )
        .bind(cleanupPreview.value.importId)
        .first<{ state: string }>(),
    ).toMatchObject({ state: "expired" });

    const expiredConfirmation = await createPreview(
      scope,
      `expired-confirm-${crypto.randomUUID()}`,
    );
    expect(expiredConfirmation.ok).toBe(true);
    if (!expiredConfirmation.ok) return;
    await database
      .prepare(
        "UPDATE app_sessions SET expires_at = ?, mfa_verified_at = ? WHERE token_digest = ?",
      )
      .bind(
        expiredConfirmation.value.expiresAt + 1_000,
        expiredConfirmation.value.expiresAt,
        scope.tokenDigest,
      )
      .run();
    expect(
      await confirmQuestionImport(
        database,
        {
          tokenDigest: scope.tokenDigest,
          importId: expiredConfirmation.value.importId,
          now: expiredConfirmation.value.expiresAt,
        },
        contentMfaPolicy,
      ),
    ).toMatchObject({ ok: false, reason: "conflict" });
  });

  it("rolls back a mid-import SQL failure without drafts, locks, staging, or success audit", async () => {
    const scope = await createContentScope(database);
    const preview = await createPreview(
      scope,
      "force-import-failure",
      makeRecord(scope, "force-import-failure"),
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    await database
      .prepare(
        `CREATE TRIGGER test_question_import_abort
         BEFORE INSERT ON questions
         WHEN NEW.question_key = 'force-import-failure'
         BEGIN SELECT RAISE(ABORT, 'synthetic import failure'); END`,
      )
      .run();
    try {
      await expect(
        confirmQuestionImport(
          database,
          {
            tokenDigest: scope.tokenDigest,
            importId: preview.value.importId,
            now: testNow,
          },
          contentMfaPolicy,
        ),
      ).rejects.toThrow();
    } finally {
      await database.prepare("DROP TRIGGER test_question_import_abort").run();
    }

    expect(await countRows(database, "questions", "certification_id", scope.certificationId)).toBe(0);
    expect(await countRows(database, "question_revisions", "certification_id", scope.certificationId)).toBe(0);
    expect(await countRows(database, "answer_options", "certification_id", scope.certificationId)).toBe(0);
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count FROM question_option_construction
           WHERE operation_id LIKE ?`,
        )
        .bind(`${preview.value.importId}:row:%`)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 0 });
    expect(
      await database
        .prepare(
          `SELECT state FROM question_import_previews WHERE id = ?`,
        )
        .bind(preview.value.importId)
        .first<{ state: string }>(),
    ).toMatchObject({ state: "previewed" });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count FROM audit_events
           WHERE subject_id = ? AND action = 'question_import_confirmed'`,
        )
        .bind(preview.value.importId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 0 });
  });

  it("serializes concurrent confirmation into one set of sealed drafts", async () => {
    const scope = await createContentScope(database);
    const preview = await previewQuestionImport(
      database,
      previewInput(scope, [
        makeRecord(scope, `concurrent-a-${crypto.randomUUID()}`),
        makeRecord(scope, `concurrent-b-${crypto.randomUUID()}`),
      ]),
      contentMfaPolicy,
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const input = {
      tokenDigest: scope.tokenDigest,
      importId: preview.value.importId,
      now: testNow,
    };
    const results = await Promise.all([
      confirmQuestionImport(database, input, contentMfaPolicy),
      confirmQuestionImport(database, input, contentMfaPolicy),
    ]);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toEqual(results[0]);
    expect(await countRows(database, "questions", "certification_id", scope.certificationId)).toBe(2);
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count FROM audit_events
           WHERE subject_id = ? AND action = 'question_import_confirmed'`,
        )
        .bind(preview.value.importId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 1 });
  });

  it("exports only scoped published content with bounded pagination and formula-safe CSV", async () => {
    const scope = await createContentScope(database);
    const formulaContent = {
      ...validQuestionContent,
      stem: '=SUM(1,2) "safe CSV quoting"\nnext line',
      sourceReference: "@source, with comma",
    };
    await publishQuestion(scope, `published-a-${crypto.randomUUID()}`, formulaContent);
    await publishQuestion(scope, `published-b-${crypto.randomUUID()}`);
    await publishQuestion(scope, `published-c-${crypto.randomUUID()}`);
    const first = await exportPublishedQuestions(
      database,
      {
        tokenDigest: scope.tokenDigest,
        certificationId: scope.certificationId,
        examVersionId: scope.examVersionId,
        now: testNow,
        pageSize: 2,
      },
      contentMfaPolicy,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.rowCount).toBe(2);
    expect(first.value.nextCursor).toBeTruthy();
    const decoded = parse(first.value.csv);
    expect(decoded).toHaveLength(3);
    expect(decoded[0]).toEqual(QUESTION_IMPORT_TEMPLATE_COLUMNS);

    const second = await exportPublishedQuestions(
      database,
      {
        tokenDigest: scope.tokenDigest,
        certificationId: scope.certificationId,
        examVersionId: scope.examVersionId,
        now: testNow,
        cursor: first.value.nextCursor!,
        pageSize: 2,
      },
      contentMfaPolicy,
    );
    expect(second).toMatchObject({
      ok: true,
      value: { rowCount: 1, nextCursor: null },
    });
    if (!second.ok) return;
    const formulaRow = [...decoded.slice(1), ...parse(second.value.csv).slice(1)].find(
      (row: string[]) => row[5]?.startsWith("'=SUM"),
    );
    expect(formulaRow?.[5]).toBe('\'=SUM(1,2) "safe CSV quoting"\nnext line');
    expect(formulaRow?.[7]).toBe("'@source, with comma");
    expect(
      await exportPublishedQuestions(
        database,
        {
          tokenDigest: scope.tokenDigest,
          certificationId: scope.certificationId,
          examVersionId: scope.examVersionId,
          now: testNow,
          pageSize: QUESTION_EXPORT_PAGE_MAX_ROWS + 1,
        },
        contentMfaPolicy,
      ),
    ).toMatchObject({ ok: false, reason: "invalid-input" });
  });

  it("does not export an unassigned certification to a Manager", async () => {
    const contentScope = await createContentScope(database);
    await publishQuestion(
      contentScope,
      `private-export-${crypto.randomUUID()}`,
    );
    const unassigned = await createTestIdentity(database);
    await grantTestRole(database, unassigned.userId, "manager");
    const tokenDigest = await createTestSession(database, unassigned.userId, {
      mfaMethod: "totp",
    });
    await assignTestCertification(
      database,
      unassigned.userId,
      await createTestCertification(database, unassigned.userId),
    );
    expect(
      await exportPublishedQuestions(
        database,
        {
          tokenDigest,
          certificationId: contentScope.certificationId,
          examVersionId: contentScope.examVersionId,
          now: testNow,
        },
        contentMfaPolicy,
      ),
    ).toMatchObject({ ok: false, reason: "certification-unassigned" });
  });
});
