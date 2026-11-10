import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  copyQuestionToCertification,
  createDomain,
  createDraftQuestion,
  createQuestionRevision,
  createTopic,
  getQuestionRevision,
  listPublishedQuestions,
  publishQuestionRevision,
  recordQuestionReview,
  retirePublishedQuestion,
  submitQuestionForReview,
} from "../src/security/content.ts";
import {
  assignTestCertification,
  createTestCertification,
  createTestIdentity,
  createTestSession,
  grantTestRole,
} from "./factories.ts";
import {
  contentMfaPolicy,
  contentOperation,
  createContentScope,
  countRows,
  validQuestionContent,
} from "./content-fixtures.ts";

const database: SecurityDatabase = env.DB;

async function createDraft(
  scope: Awaited<ReturnType<typeof createContentScope>>,
  content: typeof validQuestionContent = validQuestionContent,
  label = "create-question",
) {
  return createDraftQuestion(
    database,
    scope.tokenDigest,
    {
      certificationId: scope.certificationId,
      examVersionId: scope.examVersionId,
      domainId: scope.domainId,
      topicId: scope.topicId,
      questionKey: `question-${crypto.randomUUID()}`,
      content,
    },
    contentOperation(label),
    contentMfaPolicy,
  );
}

async function approveRevision(
  scope: Awaited<ReturnType<typeof createContentScope>>,
  revisionId: string,
  label: string,
) {
  const submitted = await submitQuestionForReview(
    database,
    scope.tokenDigest,
    { certificationId: scope.certificationId, revisionId },
    contentOperation(`${label}-submit`),
    contentMfaPolicy,
  );
  expect(submitted.ok).toBe(true);
  return recordQuestionReview(
    database,
    scope.tokenDigest,
    {
      certificationId: scope.certificationId,
      revisionId,
      decision: "approved",
      notes: "Synthetic test approval",
    },
    contentOperation(`${label}-review`),
    contentMfaPolicy,
  );
}

async function countAuditForPrefix(prefix: string): Promise<number> {
  const row = await database
    .prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE substr(operation_id, 1, length(?)) = ?",
    )
    .bind(prefix, prefix)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

describe("versioned D1 content foundations", () => {
  it("validates complete single-choice content before writing any rows", async () => {
    const scope = await createContentScope(database);
    const operation = contentOperation("invalid-content");
    const invalid = {
      ...validQuestionContent,
      options: [
        { ...validQuestionContent.options[0]!, correct: false },
        { ...validQuestionContent.options[1]!, correct: false },
      ],
    };

    expect(
      await createDraftQuestion(
        database,
        scope.tokenDigest,
        {
          certificationId: scope.certificationId,
          examVersionId: scope.examVersionId,
          domainId: scope.domainId,
          topicId: scope.topicId,
          questionKey: `invalid-${crypto.randomUUID()}`,
          content: invalid,
        },
        operation,
        contentMfaPolicy,
      ),
    ).toEqual({ ok: false, reason: "invalid-input" });
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM questions WHERE certification_id = ?")
        .bind(scope.certificationId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 0 });
    expect(await countAuditForPrefix(operation.operationId)).toBe(0);

    const missingExplanation = {
      ...validQuestionContent,
      options: validQuestionContent.options.map((option, index) =>
        index === 1 ? { ...option, explanation: " " } : option,
      ),
    };
    expect(
      await createDraft(scope, missingExplanation, "missing-explanation"),
    ).toEqual({ ok: false, reason: "invalid-input" });
  });

  it("rejects cross-version taxonomy references and protects taxonomy meaning", async () => {
    const first = await createContentScope(database);
    const secondVersionId = crypto.randomUUID();
    const secondVersion = await import("../src/security/content.ts").then(
      ({ createExamVersion }) =>
        createExamVersion(
          database,
          first.tokenDigest,
          {
            id: secondVersionId,
            certificationId: first.certificationId,
            versionKey: `fixture-${crypto.randomUUID()}`,
            title: "Synthetic second exam version",
            syllabusReference: "Synthetic syllabus revision",
          },
          contentOperation("create-second-version"),
          contentMfaPolicy,
        ),
    );
    expect(secondVersion.ok).toBe(true);

    const operation = contentOperation("cross-version-question");
    expect(
      await createDraftQuestion(
        database,
        first.tokenDigest,
        {
          certificationId: first.certificationId,
          examVersionId: secondVersionId,
          domainId: first.domainId,
          topicId: first.topicId,
          questionKey: `cross-version-${crypto.randomUUID()}`,
          content: validQuestionContent,
        },
        operation,
        contentMfaPolicy,
      ),
    ).toEqual({ ok: false, reason: "conflict" });
    expect(await countAuditForPrefix(operation.operationId)).toBe(0);
    await expect(
      database
        .prepare("UPDATE domains SET meaning = 'renamed' WHERE id = ?")
        .bind(first.domainId)
        .run(),
    ).rejects.toThrow();
    await expect(
      database
        .prepare("DELETE FROM topics WHERE id = ?")
        .bind(first.topicId)
        .run(),
    ).rejects.toThrow();

    const domainRow = await database
      .prepare("SELECT meaning FROM domains WHERE id = ?")
      .bind(first.domainId)
      .first<{ meaning: string }>();
    expect(domainRow?.meaning).toBe("A stable test-only domain meaning.");

    const newDomainId = crypto.randomUUID();
    const domain = await createDomain(
      database,
      first.tokenDigest,
      {
        id: newDomainId,
        certificationId: first.certificationId,
        examVersionId: secondVersionId,
        domainKey: `new-domain-${crypto.randomUUID()}`,
        title: "Newly identified domain",
        meaning: "A distinct stable meaning for the newer version.",
        order: 0,
      },
      contentOperation("create-new-domain"),
      contentMfaPolicy,
    );
    expect(domain.ok).toBe(true);
    const newTopicId = crypto.randomUUID();
    const topic = await createTopic(
      database,
      first.tokenDigest,
      {
        id: newTopicId,
        certificationId: first.certificationId,
        examVersionId: secondVersionId,
        domainId: newDomainId,
        topicKey: `new-topic-${crypto.randomUUID()}`,
        title: "New topic",
        meaning: "A distinct immutable topic meaning.",
        order: 0,
      },
      contentOperation("create-new-topic"),
      contentMfaPolicy,
    );
    expect(topic.ok).toBe(true);
  });

  it("creates immutable revisions, preserves corrections, and rejects stale editors", async () => {
    const scope = await createContentScope(database);
    const draft = await createDraft(scope);
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const firstRevision = await getQuestionRevision(
      database,
      scope.tokenDigest,
      { certificationId: scope.certificationId, revisionId: draft.value.revisionId },
      1_800_000_000_000,
      contentMfaPolicy,
    );
    expect(firstRevision.ok).toBe(true);
    if (!firstRevision.ok) return;

    const correctedContent = {
      ...validQuestionContent,
      stem: "Which updated control most directly limits unauthorized access?",
    };
    const correctionOperation = contentOperation("correct-question");
    const correction = await createQuestionRevision(
      database,
      scope.tokenDigest,
      {
        certificationId: scope.certificationId,
        questionId: draft.value.questionId,
        examVersionId: scope.examVersionId,
        domainId: scope.domainId,
        topicId: scope.topicId,
        expectedLockVersion: 1,
        content: correctedContent,
      },
      correctionOperation,
      contentMfaPolicy,
    );
    expect(correction).toMatchObject({
      ok: true,
      value: { revisionNumber: 2 },
    });
    if (!correction.ok) return;

    const preserved = await getQuestionRevision(
      database,
      scope.tokenDigest,
      { certificationId: scope.certificationId, revisionId: draft.value.revisionId },
      1_800_000_000_000,
      contentMfaPolicy,
    );
    expect(preserved.ok).toBe(true);
    if (preserved.ok) {
      expect(preserved.value.stem).toBe(validQuestionContent.stem);
      expect(preserved.value.options[0]?.text).toBe(
        validQuestionContent.options[0]?.text,
      );
    }

    await expect(
      database
        .prepare("UPDATE question_revisions SET stem = 'rewritten' WHERE id = ?")
        .bind(draft.value.revisionId)
        .run(),
    ).rejects.toThrow();
    await expect(
      database
        .prepare("DELETE FROM answer_options WHERE question_revision_id = ?")
        .bind(draft.value.revisionId)
        .run(),
    ).rejects.toThrow();
    await expect(
      database
        .prepare(
          "UPDATE answer_options SET option_text = 'rewritten' WHERE question_revision_id = ?",
        )
        .bind(draft.value.revisionId)
        .run(),
    ).rejects.toThrow();
    const staleOperation = contentOperation("stale-editor");
    expect(
      await createQuestionRevision(
        database,
        scope.tokenDigest,
        {
          certificationId: scope.certificationId,
          questionId: draft.value.questionId,
          examVersionId: scope.examVersionId,
          domainId: scope.domainId,
          topicId: scope.topicId,
          expectedLockVersion: 1,
          content: validQuestionContent,
        },
        staleOperation,
        contentMfaPolicy,
      ),
    ).toEqual({ ok: false, reason: "conflict" });
    expect(await countAuditForPrefix(staleOperation.operationId)).toBe(0);

    const concurrent = await Promise.all([
      createQuestionRevision(
        database,
        scope.tokenDigest,
        {
          certificationId: scope.certificationId,
          questionId: draft.value.questionId,
          examVersionId: scope.examVersionId,
          domainId: scope.domainId,
          topicId: scope.topicId,
          expectedLockVersion: 2,
          content: validQuestionContent,
        },
        contentOperation("concurrent-editor-a"),
        contentMfaPolicy,
      ),
      createQuestionRevision(
        database,
        scope.tokenDigest,
        {
          certificationId: scope.certificationId,
          questionId: draft.value.questionId,
          examVersionId: scope.examVersionId,
          domainId: scope.domainId,
          topicId: scope.topicId,
          expectedLockVersion: 2,
          content: correctedContent,
        },
        contentOperation("concurrent-editor-b"),
        contentMfaPolicy,
      ),
    ]);
    expect(concurrent.filter((result) => result.ok)).toHaveLength(1);
    expect(concurrent.filter((result) => !result.ok)).toHaveLength(1);
    expect(
      await database
        .prepare("SELECT lock_version FROM questions WHERE id = ?")
        .bind(draft.value.questionId)
        .first<{ lock_version: number }>(),
    ).toMatchObject({ lock_version: 3 });
  });

  it("requires review of the exact revision and publishes/retires atomically", async () => {
    const scope = await createContentScope(database, { role: "manager" });
    const draft = await createDraft(scope);
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    expect(
      await recordQuestionReview(
        database,
        scope.tokenDigest,
        {
          certificationId: scope.certificationId,
          revisionId: draft.value.revisionId,
          decision: "approved",
          notes: "Review before submission",
        },
        contentOperation("review-before-submit"),
        contentMfaPolicy,
      ),
    ).toEqual({ ok: false, reason: "conflict" });

    const submitted = await submitQuestionForReview(
      database,
      scope.tokenDigest,
      { certificationId: scope.certificationId, revisionId: draft.value.revisionId },
      contentOperation("submit"),
      contentMfaPolicy,
    );
    expect(submitted.ok).toBe(true);
    expect(
      await submitQuestionForReview(
        database,
        scope.tokenDigest,
        { certificationId: scope.certificationId, revisionId: draft.value.revisionId },
        contentOperation("duplicate-submit"),
        contentMfaPolicy,
      ),
    ).toEqual({ ok: false, reason: "conflict" });
    const reviewed = await recordQuestionReview(
      database,
      scope.tokenDigest,
      {
        certificationId: scope.certificationId,
        revisionId: draft.value.revisionId,
        decision: "approved",
        notes: "Manager approves own synthetic revision under the launch policy.",
      },
      contentOperation("approve"),
      contentMfaPolicy,
    );
    expect(reviewed.ok).toBe(true);

    const unapprovedDraft = await createQuestionRevision(
      database,
      scope.tokenDigest,
      {
        certificationId: scope.certificationId,
        questionId: draft.value.questionId,
        examVersionId: scope.examVersionId,
        domainId: scope.domainId,
        topicId: scope.topicId,
        expectedLockVersion: 1,
        content: validQuestionContent,
      },
      contentOperation("unapproved-correction"),
      contentMfaPolicy,
    );
    expect(unapprovedDraft.ok).toBe(true);
    if (!unapprovedDraft.ok) return;
    const rejectedPublishOp = contentOperation("publish-unapproved");
    expect(
      await publishQuestionRevision(
        database,
        scope.tokenDigest,
        {
          certificationId: scope.certificationId,
          examVersionId: scope.examVersionId,
          questionId: draft.value.questionId,
          revisionId: unapprovedDraft.value.revisionId,
          expectedPointerVersion: null,
        },
        rejectedPublishOp,
        contentMfaPolicy,
      ),
    ).toEqual({ ok: false, reason: "conflict" });
    expect(await countAuditForPrefix(rejectedPublishOp.operationId)).toBe(0);

    const publication = await publishQuestionRevision(
      database,
      scope.tokenDigest,
      {
        certificationId: scope.certificationId,
        examVersionId: scope.examVersionId,
        questionId: draft.value.questionId,
        revisionId: draft.value.revisionId,
        expectedPointerVersion: null,
      },
      contentOperation("publish-approved"),
      contentMfaPolicy,
    );
    expect(publication).toEqual({ ok: true, value: { pointerVersion: 1 } });
    expect(
      await listPublishedQuestions(
        database,
        scope.tokenDigest,
        {
          certificationId: scope.certificationId,
          examVersionId: scope.examVersionId,
        },
        1_800_000_000_000,
        contentMfaPolicy,
      ),
    ).toMatchObject({
      ok: true,
      value: [{ questionId: draft.value.questionId, revisionId: draft.value.revisionId }],
    });

    const retired = await retirePublishedQuestion(
      database,
      scope.tokenDigest,
      {
        certificationId: scope.certificationId,
        examVersionId: scope.examVersionId,
        questionId: draft.value.questionId,
        expectedPointerVersion: 1,
      },
      contentOperation("retire-publication"),
      contentMfaPolicy,
    );
    expect(retired).toEqual({ ok: true, value: { pointerVersion: 2 } });
    expect(
      await listPublishedQuestions(
        database,
        scope.tokenDigest,
        {
          certificationId: scope.certificationId,
          examVersionId: scope.examVersionId,
        },
        1_800_000_000_000,
        contentMfaPolicy,
      ),
    ).toEqual({ ok: true, value: [] });
    expect(
      await database
        .prepare(
          "SELECT COUNT(*) AS count FROM content_publication_events WHERE question_id = ?",
        )
        .bind(draft.value.questionId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 2 });
  });

  it("serializes concurrent publication and reports stale pointer conflicts without audit", async () => {
    const scope = await createContentScope(database);
    const draft = await createDraft(scope);
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(
      await approveRevision(scope, draft.value.revisionId, "first-approval"),
    ).toMatchObject({ ok: true });
    expect(
      await publishQuestionRevision(
        database,
        scope.tokenDigest,
        {
          certificationId: scope.certificationId,
          examVersionId: scope.examVersionId,
          questionId: draft.value.questionId,
          revisionId: draft.value.revisionId,
          expectedPointerVersion: null,
        },
        contentOperation("initial-publication"),
        contentMfaPolicy,
      ),
    ).toMatchObject({ ok: true });

    const next = await createQuestionRevision(
      database,
      scope.tokenDigest,
      {
        certificationId: scope.certificationId,
        questionId: draft.value.questionId,
        examVersionId: scope.examVersionId,
        domainId: scope.domainId,
        topicId: scope.topicId,
        expectedLockVersion: 1,
        content: {
          ...validQuestionContent,
          stem: "Which new control most directly limits unauthorized access?",
        },
      },
      contentOperation("second-revision"),
      contentMfaPolicy,
    );
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(await approveRevision(scope, next.value.revisionId, "second-approval"))
      .toMatchObject({ ok: true });

    const concurrent = await Promise.all([
      publishQuestionRevision(
        database,
        scope.tokenDigest,
        {
          certificationId: scope.certificationId,
          examVersionId: scope.examVersionId,
          questionId: draft.value.questionId,
          revisionId: next.value.revisionId,
          expectedPointerVersion: 1,
        },
        contentOperation("publish-race-a"),
        contentMfaPolicy,
      ),
      publishQuestionRevision(
        database,
        scope.tokenDigest,
        {
          certificationId: scope.certificationId,
          examVersionId: scope.examVersionId,
          questionId: draft.value.questionId,
          revisionId: next.value.revisionId,
          expectedPointerVersion: 1,
        },
        contentOperation("publish-race-b"),
        contentMfaPolicy,
      ),
    ]);
    expect(concurrent.filter((result) => result.ok)).toHaveLength(1);
    expect(concurrent.filter((result) => !result.ok)).toHaveLength(1);
    expect(
      await database
        .prepare(
          "SELECT question_revision_id, lock_version FROM exam_version_questions WHERE question_id = ?",
        )
        .bind(draft.value.questionId)
        .first<{ question_revision_id: string; lock_version: number }>(),
    ).toEqual({
      question_revision_id: next.value.revisionId,
      lock_version: 2,
    });
    const rejectedOperation = concurrent.find((result) => !result.ok);
    expect(rejectedOperation).toBeDefined();
    expect(
      await database
        .prepare(
          "SELECT COUNT(*) AS count FROM content_publication_events WHERE question_id = ?",
        )
        .bind(draft.value.questionId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 2 });
  });

  it("rolls back revision and audit rows when a database audit insert fails", async () => {
    const scope = await createContentScope(database);
    const operation = contentOperation("audit-rollback");
    await database
      .prepare(
        `INSERT INTO audit_events (
           operation_id, actor_user_id, action, subject_type, subject_id,
           certification_id, reason, occurred_at
         ) VALUES (?, ?, 'test_reserved', 'test', ?, ?, 'Synthetic reserved key', ?)`,
      )
      .bind(
        `${operation.operationId}:revision:draft`,
        scope.userId,
        "reserved",
        scope.certificationId,
        operation.now,
      )
      .run();

    await expect(
      createDraftQuestion(
        database,
        scope.tokenDigest,
        {
          certificationId: scope.certificationId,
          examVersionId: scope.examVersionId,
          domainId: scope.domainId,
          topicId: scope.topicId,
          questionKey: `rollback-${crypto.randomUUID()}`,
          content: validQuestionContent,
        },
        operation,
        contentMfaPolicy,
      ),
    ).rejects.toThrow();
    expect(
      await database
        .prepare(
          "SELECT COUNT(*) AS count FROM questions WHERE certification_id = ?",
        )
        .bind(scope.certificationId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 0 });
    expect(
      await database
        .prepare(
          "SELECT COUNT(*) AS count FROM question_revisions WHERE certification_id = ?",
        )
        .bind(scope.certificationId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 0 });
    expect(await countAuditForPrefix(`${operation.operationId}:question`)).toBe(0);
  });

  it("denies learners, unassigned Managers, revoked sessions, revoked assignments, and missing MFA", async () => {
    const owner = await createContentScope(database);
    const draft = await createDraft(owner);
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const unassigned = await createTestIdentity(database);
    await grantTestRole(database, unassigned.userId, "manager");
    const unassignedDigest = await createTestSession(database, unassigned.userId, {
      mfaMethod: "totp",
    });
    expect(
      await getQuestionRevision(
        database,
        unassignedDigest,
        {
          certificationId: owner.certificationId,
          revisionId: draft.value.revisionId,
        },
        1_800_000_000_000,
        contentMfaPolicy,
      ),
    ).toEqual({ ok: false, reason: "certification-unassigned" });
    expect(
      await createDraftQuestion(
        database,
        unassignedDigest,
        {
          certificationId: owner.certificationId,
          examVersionId: owner.examVersionId,
          domainId: owner.domainId,
          topicId: owner.topicId,
          questionKey: `unassigned-${crypto.randomUUID()}`,
          content: validQuestionContent,
        },
        contentOperation("unassigned-write"),
        contentMfaPolicy,
      ),
    ).toEqual({ ok: false, reason: "certification-unassigned" });

    const learner = await createTestIdentity(database);
    const learnerDigest = await createTestSession(database, learner.userId, {
      mfaMethod: "totp",
    });
    expect(
      await getQuestionRevision(
        database,
        learnerDigest,
        {
          certificationId: owner.certificationId,
          revisionId: draft.value.revisionId,
        },
        1_800_000_000_000,
        contentMfaPolicy,
      ),
    ).toEqual({ ok: false, reason: "not-staff" });

    const assignedManager = await createContentScope(database, {
      certificationId: owner.certificationId,
      role: "manager",
    });
    expect(
      await getQuestionRevision(
        database,
        assignedManager.tokenDigest,
        {
          certificationId: owner.certificationId,
          revisionId: draft.value.revisionId,
        },
        1_800_000_000_000,
        contentMfaPolicy,
      ),
    ).toMatchObject({ ok: true });

    const missingMfa = await createTestSession(database, assignedManager.userId);
    expect(
      await getQuestionRevision(
        database,
        missingMfa,
        {
          certificationId: owner.certificationId,
          revisionId: draft.value.revisionId,
        },
        1_800_000_000_000,
        contentMfaPolicy,
      ),
    ).toEqual({ ok: false, reason: "mfa-assurance-missing" });
    const staleMfa = await createTestSession(database, assignedManager.userId, {
      now: 1_800_000_000_000 - contentMfaPolicy.maxAgeMs - 1,
      expiresAt: 1_800_000_000_000 + 60_000,
      mfaMethod: "totp",
    });
    expect(
      await getQuestionRevision(
        database,
        staleMfa,
        {
          certificationId: owner.certificationId,
          revisionId: draft.value.revisionId,
        },
        1_800_000_000_000,
        contentMfaPolicy,
      ),
    ).toEqual({ ok: false, reason: "mfa-assurance-stale" });

    const revokedSession = await createTestSession(database, assignedManager.userId, {
      mfaMethod: "totp",
    });
    await database
      .prepare(
        `UPDATE app_sessions
         SET revoked_at = ?, revocation_operation_id = ?, revoked_by_user_id = user_id
         WHERE token_digest = ?`,
      )
      .bind(
        1_800_000_000_000,
        `content-revoke:${crypto.randomUUID()}`,
        revokedSession,
      )
      .run();
    expect(
      await getQuestionRevision(
        database,
        revokedSession,
        {
          certificationId: owner.certificationId,
          revisionId: draft.value.revisionId,
        },
        1_800_000_000_000 + 1,
        contentMfaPolicy,
      ),
    ).toEqual({ ok: false, reason: "invalid-session" });

    await database
      .prepare(
        `UPDATE manager_certification_assignments
         SET active = 0, operation_id = ?, reason = 'Synthetic revocation', changed_at = ?
         WHERE manager_user_id = ? AND certification_id = ?`,
      )
      .bind(
        `content-unassign:${crypto.randomUUID()}`,
        1_800_000_000_000,
        assignedManager.userId,
        owner.certificationId,
      )
      .run();
    expect(
      await getQuestionRevision(
        database,
        assignedManager.tokenDigest,
        {
          certificationId: owner.certificationId,
          revisionId: draft.value.revisionId,
        },
        1_800_000_000_000,
        contentMfaPolicy,
      ),
    ).toEqual({ ok: false, reason: "certification-unassigned" });
  });

  it("requires authorization in both scopes and records copy provenance on a new identity", async () => {
    const source = await createContentScope(database, { role: "manager" });
    const sourceDraft = await createDraft(source);
    expect(sourceDraft.ok).toBe(true);
    if (!sourceDraft.ok) return;
    const destinationAdmin = await createContentScope(database);

    const copyInput = {
      sourceCertificationId: source.certificationId,
      sourceQuestionId: sourceDraft.value.questionId,
      sourceRevisionId: sourceDraft.value.revisionId,
      destinationCertificationId: destinationAdmin.certificationId,
      destinationExamVersionId: destinationAdmin.examVersionId,
      destinationDomainId: destinationAdmin.domainId,
      destinationTopicId: destinationAdmin.topicId,
      destinationQuestionKey: `copy-${crypto.randomUUID()}`,
      reason: "Synthetic cross-certification copy test",
    };
    const denied = await copyQuestionToCertification(
      database,
      source.tokenDigest,
      copyInput,
      contentOperation("copy-denied-destination"),
      contentMfaPolicy,
    );
    expect(denied).toEqual({
      ok: false,
      reason: "certification-unassigned",
    });
    expect(
      await database
        .prepare(
          "SELECT COUNT(*) AS count FROM questions WHERE certification_id = ?",
        )
        .bind(destinationAdmin.certificationId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 0 });

    await assignTestCertification(
      database,
      source.userId,
      destinationAdmin.certificationId,
    );
    const copied = await copyQuestionToCertification(
      database,
      source.tokenDigest,
      copyInput,
      contentOperation("copy-allowed"),
      contentMfaPolicy,
    );
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    expect(copied.value.questionId).not.toBe(sourceDraft.value.questionId);
    const provenance = await database
      .prepare(
        `SELECT source_certification_id, source_question_id, source_revision_id,
                destination_certification_id, destination_question_id,
                destination_revision_id
         FROM question_derivations
         WHERE destination_question_id = ?`,
      )
      .bind(copied.value.questionId)
      .first<Record<string, string>>();
    expect(provenance).toEqual({
      source_certification_id: source.certificationId,
      source_question_id: sourceDraft.value.questionId,
      source_revision_id: sourceDraft.value.revisionId,
      destination_certification_id: destinationAdmin.certificationId,
      destination_question_id: copied.value.questionId,
      destination_revision_id: copied.value.revisionId,
    });
    expect(await countRows(database, "questions", "id", sourceDraft.value.questionId))
      .toBe(1);
    const original = await getQuestionRevision(
      database,
      source.tokenDigest,
      {
        certificationId: source.certificationId,
        revisionId: sourceDraft.value.revisionId,
      },
      1_800_000_000_000,
      contentMfaPolicy,
    );
    expect(original).toMatchObject({ ok: true });
  });
});
