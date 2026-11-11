import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { api } from "../src/index.ts";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  createDraftQuestion,
  createQuestionRevision,
  publishQuestionRevision,
  recordQuestionReview,
  retirePublishedQuestion,
  submitQuestionForReview,
} from "../src/security/content.ts";
import {
  getPracticeAttempt,
} from "../src/security/practice.ts";
import {
  createTestIdentity,
  createTestSessionCredentials,
  grantTestLearnerAccess,
} from "./factories.ts";
import {
  contentMfaPolicy,
  contentOperation,
  createContentScope,
  validQuestionContent,
} from "./content-fixtures.ts";

const database: SecurityDatabase = env.DB;
const origin = "https://certpath.example.test";
const secret = "local-worker-test-csrf-secret-with-enough-entropy";

interface Learner {
  userId: string;
  tokenDigest: string;
  rawToken: string;
  certificationId: string;
  bindings: {
    DB: SecurityDatabase;
    PUBLIC_SITE_ORIGIN: string;
    CSRF_HMAC_SECRET: string;
  };
}

async function createLearner(
  certificationId: string,
  options: { sessionNow?: number; expiresAt?: number } = {},
): Promise<Learner> {
  const identity = await createTestIdentity(database);
  const sessionNow = options.sessionNow ?? Date.now();
  const credentials = await createTestSessionCredentials(
    database,
    identity.userId,
    {
      now: sessionNow,
      expiresAt: options.expiresAt ?? sessionNow + 60 * 60 * 1000,
    },
  );
  await grantTestLearnerAccess(database, identity.userId, certificationId);
  return {
    userId: identity.userId,
    tokenDigest: credentials.tokenDigest,
    rawToken: credentials.rawToken,
    certificationId,
    bindings: {
      DB: database,
      PUBLIC_SITE_ORIGIN: origin,
      CSRF_HMAC_SECRET: secret,
    },
  };
}

async function publishQuestion(
  scope: Awaited<ReturnType<typeof createContentScope>>,
  questionKey: string,
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
      content: validQuestionContent,
    },
    contentOperation("learner-practice-draft"),
    contentMfaPolicy,
  );
  if (!draft.ok) throw new Error(`Could not create fixture question: ${draft.reason}`);
  const submitted = await submitQuestionForReview(
    database,
    scope.tokenDigest,
    { certificationId: scope.certificationId, revisionId: draft.value.revisionId },
    contentOperation("learner-practice-submit"),
    contentMfaPolicy,
  );
  if (!submitted.ok) throw new Error(`Could not submit fixture question: ${submitted.reason}`);
  const review = await recordQuestionReview(
    database,
    scope.tokenDigest,
    {
      certificationId: scope.certificationId,
      revisionId: draft.value.revisionId,
      decision: "approved",
      notes: "Synthetic learner-practice fixture",
    },
    contentOperation("learner-practice-review"),
    contentMfaPolicy,
  );
  if (!review.ok) throw new Error(`Could not approve fixture question: ${review.reason}`);
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
    contentOperation("learner-practice-publish"),
    contentMfaPolicy,
  );
  if (!publication.ok) {
    throw new Error(`Could not publish fixture question: ${publication.reason}`);
  }
  return {
    questionId: draft.value.questionId,
    revisionId: draft.value.revisionId,
    stem: validQuestionContent.stem,
  };
}

function url(path: string): string {
  return `https://certpath.example.test/api/practice${path}`;
}

async function csrf(learner: Learner): Promise<string> {
  const response = await api.fetch(
    new Request(url("/csrf"), {
      headers: { Cookie: `certpath_session=${learner.rawToken}` },
    }),
    learner.bindings,
  );
  if (!response.ok) throw new Error(`Practice CSRF request failed: ${response.status}`);
  const body = (await response.json()) as { csrfToken: string };
  return body.csrfToken;
}

async function request(
  learner: Learner,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    csrf?: boolean;
    origin?: string | null;
  } = {},
): Promise<Response> {
  const method = options.method ?? "GET";
  const headers = new Headers({
    Cookie: `certpath_session=${learner.rawToken}`,
  });
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (method !== "GET" && options.csrf !== false) {
    headers.set("Origin", options.origin ?? origin);
    headers.set("X-CSRF-Token", await csrf(learner));
  } else if (options.origin !== undefined && options.origin !== null) {
    headers.set("Origin", options.origin);
  }
  return api.fetch(
    new Request(url(path), {
      method,
      headers,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    }),
    learner.bindings,
  );
}

async function createTimedMock(
  learner: Learner,
  scope: Awaited<ReturnType<typeof createContentScope>>,
  requestId = crypto.randomUUID(),
) {
  const response = await request(learner, "/mocks", {
    method: "POST",
    body: {
      certificationId: scope.certificationId,
      examVersionId: scope.examVersionId,
      requestId,
    },
  });
  return {
    response,
    body: await response.json() as {
      attempt: {
        id: string;
        version: number;
        state: string;
        currentPosition: number;
        durationSeconds: number;
        questionCount: number;
        startedAt: number;
        deadlineAt: number;
        completionReason: string | null;
        correctCount?: number;
      };
      serverNow: number;
      items: Array<{
        position: number;
        revisionId: string;
        stem: string;
        selectedOptionKey?: string;
        correctOptionKey?: string;
        isCorrect?: boolean;
        options: Array<{ key: string; text: string; explanation?: string }>;
      }>;
    },
  };
}

async function publishTimedMockQuestions(
  scope: Awaited<ReturnType<typeof createContentScope>>,
  count = 10,
) {
  const questions = [];
  for (let index = 0; index < count; index += 1) {
    questions.push(
      await publishQuestion(scope, `timed-mock-${crypto.randomUUID()}-${index}`),
    );
  }
  return questions;
}

function assertPrivate(response: Response): void {
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(response.headers.get("x-request-id")).toBeTruthy();
}

async function createPractice(
  learner: Learner,
  scope: Awaited<ReturnType<typeof createContentScope>>,
  questionCount: number,
  requestId = crypto.randomUUID(),
) {
  const response = await request(learner, "/attempts", {
    method: "POST",
    body: {
      certificationId: scope.certificationId,
      examVersionId: scope.examVersionId,
      questionCount,
      domainId: scope.domainId,
      requestId,
    },
  });
  return { response, body: await response.json() as {
    attempt: {
      id: string;
      version: number;
      currentPosition: number;
      state: string;
      correctCount?: number;
      filters: { domainId?: string; difficulty?: string };
    };
    items: Array<{
      position: number;
      revisionId: string;
      stem: string;
      options: Array<{ key: string; text: string; explanation?: string }>;
      selectedOptionKey?: string;
      correctOptionKey?: string;
      isCorrect?: boolean;
    }>;
  } };
}

describe("protected learner practice Worker/D1 boundary", () => {
  it("creates immutable published snapshots, reveals answers only after submission, resumes, and locks completion", async () => {
    const scope = await createContentScope(database);
    const questions = await Promise.all([
      publishQuestion(scope, `practice-${crypto.randomUUID()}`),
      publishQuestion(scope, `practice-${crypto.randomUUID()}`),
    ]);
    const learner = await createLearner(scope.certificationId);

    const scopesResponse = await request(learner, "/scopes");
    assertPrivate(scopesResponse);
    expect(scopesResponse.status).toBe(200);
    expect(await scopesResponse.json()).toMatchObject({
      items: [
        {
          certificationId: scope.certificationId,
          examVersionId: scope.examVersionId,
        },
      ],
    });

    const { response, body } = await createPractice(learner, scope, 2);
    assertPrivate(response);
    expect(response.status).toBe(201);
    expect(body.attempt).toMatchObject({
      state: "in_progress",
      version: 1,
      currentPosition: 0,
      questionCount: 2,
    });
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.options.map((option) => option.key)).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
    expect(body.attempt.filters).toEqual({ domainId: scope.domainId });
    expect(body.items[0]).not.toHaveProperty("correctOptionKey");
    expect(body.items[0]?.options[0]).not.toHaveProperty("explanation");
    expect(body.items[0]?.options[0]).not.toHaveProperty("correct");
    const firstItem = body.items[0]!;
    const answerRequestId = crypto.randomUUID();
    const firstAnswer = await request(learner, `/attempts/${body.attempt.id}/answers`, {
      method: "POST",
      body: {
        expectedVersion: 1,
        requestId: answerRequestId,
        selectedOptionKey: "A",
      },
    });
    assertPrivate(firstAnswer);
    expect(firstAnswer.status).toBe(200);
    const afterFirst = await firstAnswer.json() as typeof body;
    expect(afterFirst.attempt).toMatchObject({
      state: "in_progress",
      version: 2,
      currentPosition: 1,
    });
    expect(afterFirst.items.find((item) => item.position === firstItem.position))
      .toMatchObject({
        revisionId: firstItem.revisionId,
        selectedOptionKey: "A",
        correctOptionKey: "A",
        isCorrect: true,
      });
    expect(afterFirst.items[0]?.options[0]).toHaveProperty("explanation");
    const unanswered = afterFirst.items.find((item) => item.position === 1);
    expect(unanswered).not.toHaveProperty("correctOptionKey");
    expect(unanswered?.options[0]).not.toHaveProperty("explanation");
    const secondDeviceCredentials = await createTestSessionCredentials(
      database,
      learner.userId,
      { now: Date.now(), expiresAt: Date.now() + 60 * 60 * 1000 },
    );
    const secondDevice = {
      ...learner,
      tokenDigest: secondDeviceCredentials.tokenDigest,
      rawToken: secondDeviceCredentials.rawToken,
    };
    const resumedOnSecondDevice = await request(
      secondDevice,
      `/attempts/${body.attempt.id}`,
    );
    expect(resumedOnSecondDevice.status).toBe(200);
    expect((await resumedOnSecondDevice.json()).attempt).toMatchObject({
      version: 2,
      currentPosition: 1,
    });

    const replay = await request(learner, `/attempts/${body.attempt.id}/answers`, {
      method: "POST",
      body: {
        expectedVersion: 1,
        requestId: answerRequestId,
        selectedOptionKey: "A",
      },
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()).attempt.version).toBe(2);
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM practice_answer_events WHERE attempt_id = ?")
        .bind(body.attempt.id)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 1 });

    const secondAnswer = await request(learner, `/attempts/${body.attempt.id}/answers`, {
      method: "POST",
      body: {
        expectedVersion: 2,
        requestId: crypto.randomUUID(),
        selectedOptionKey: "B",
      },
    });
    expect(secondAnswer.status).toBe(200);
    const completed = await secondAnswer.json() as typeof body;
    expect(completed.attempt).toMatchObject({
      state: "completed",
      version: 3,
      currentPosition: 2,
      correctCount: 1,
    });
    expect((await request(learner, `/attempts/${body.attempt.id}`)).status).toBe(200);

    const locked = await request(learner, `/attempts/${body.attempt.id}/answers`, {
      method: "POST",
      body: {
        expectedVersion: 3,
        requestId: crypto.randomUUID(),
        selectedOptionKey: "A",
      },
    });
    expect(locked.status).toBe(409);
    assertPrivate(locked);

    const snapshot = await database
      .prepare(
        "SELECT question_id, question_revision_id FROM practice_attempt_items WHERE attempt_id = ? ORDER BY position",
      )
      .bind(body.attempt.id)
      .all<{ question_id: string; question_revision_id: string }>();
    expect(snapshot.results.map((item) => item.question_revision_id).sort()).toEqual(
      questions.map((question) => question.revisionId).sort(),
    );
    expect(await getPracticeAttempt(
      database,
      learner.userId,
      learner.tokenDigest,
      body.attempt.id,
      Date.now(),
    )).toMatchObject({ ok: true });
  });

  it("denies cross-user, cross-exam, expired-grant, and revoked-session access", async () => {
    const scope = await createContentScope(database);
    await publishQuestion(scope, `practice-${crypto.randomUUID()}`);
    const learner = await createLearner(scope.certificationId);
    const { response, body } = await createPractice(learner, scope, 1);
    expect(response.status).toBe(201);

    const other = await createLearner(scope.certificationId);
    const crossUser = await request(other, `/attempts/${body.attempt.id}`);
    expect(crossUser.status).toBe(404);
    assertPrivate(crossUser);

    const otherScope = await createContentScope(database);
    const crossExam = await request(learner, "/attempts", {
      method: "POST",
      body: {
        certificationId: otherScope.certificationId,
        examVersionId: otherScope.examVersionId,
        questionCount: 1,
        requestId: crypto.randomUUID(),
      },
    });
    expect(crossExam.status).toBe(403);

    const sameCertificationOtherVersion = await createContentScope(database, {
      certificationId: scope.certificationId,
    });
    const crossVersionDomain = await request(learner, "/attempts", {
      method: "POST",
      body: {
        certificationId: scope.certificationId,
        examVersionId: scope.examVersionId,
        domainId: sameCertificationOtherVersion.domainId,
        questionCount: 1,
        requestId: crypto.randomUUID(),
      },
    });
    expect(crossVersionDomain.status).toBe(404);

    await database
      .prepare("UPDATE learner_access_grants SET expires_at = ? WHERE user_id = ?")
      .bind(Date.now() - 1, learner.userId)
      .run();
    const expiredScopes = await (await request(learner, "/scopes")).json();
    expect(expiredScopes).toMatchObject({ items: [] });
    const expiredAttempt = await request(learner, `/attempts/${body.attempt.id}`);
    expect(expiredAttempt.status).toBe(403);

    const freshLearner = await createLearner(scope.certificationId);
    const fresh = await createPractice(freshLearner, scope, 1);
    expect(fresh.response.status).toBe(201);
    await database
      .prepare("UPDATE app_sessions SET revoked_at = ?, revocation_operation_id = ?, revoked_by_user_id = ? WHERE token_digest = ?")
      .bind(Date.now(), `practice-revoke:${crypto.randomUUID()}`, freshLearner.userId, freshLearner.tokenDigest)
      .run();
    expect((await request(freshLearner, `/attempts/${fresh.body.attempt.id}`)).status).toBe(401);

    const expiredSession = await createLearner(scope.certificationId, {
      sessionNow: Date.now() - 60_000,
      expiresAt: Date.now() - 1,
    });
    const expiredSessionResponse = await request(expiredSession, "/scopes");
    expect(expiredSessionResponse.status).toBe(401);
    assertPrivate(expiredSessionResponse);
  });

  it("makes concurrent start and answer retries idempotent and rejects stale versions", async () => {
    const scope = await createContentScope(database);
    await publishQuestion(scope, `practice-${crypto.randomUUID()}`);
    const learner = await createLearner(scope.certificationId);
    const requestId = crypto.randomUUID();
    const startResults = await Promise.all([
      createPractice(learner, scope, 1, requestId),
      createPractice(learner, scope, 1, requestId),
    ]);
    expect(startResults.map((item) => item.response.status)).toEqual([201, 201]);
    expect(startResults[0]?.body.attempt.id).toBe(startResults[1]?.body.attempt.id);
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM practice_attempts WHERE user_id = ? AND create_request_id = ?")
        .bind(learner.userId, requestId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 1 });

    const attemptId = startResults[0]!.body.attempt.id;
    const answer = {
      expectedVersion: 1,
      requestId: crypto.randomUUID(),
      selectedOptionKey: "A",
    };
    const answerResults = await Promise.all([
      request(learner, `/attempts/${attemptId}/answers`, { method: "POST", body: answer }),
      request(learner, `/attempts/${attemptId}/answers`, { method: "POST", body: answer }),
    ]);
    expect(answerResults.map((item) => item.status)).toEqual([200, 200]);
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM practice_answer_events WHERE attempt_id = ?")
        .bind(attemptId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 1 });

    const stale = await request(learner, `/attempts/${attemptId}/answers`, {
      method: "POST",
      body: { ...answer, requestId: crypto.randomUUID(), selectedOptionKey: "B" },
    });
    expect(stale.status).toBe(409);
    expect((await request(learner, `/attempts/${attemptId}`)).status).toBe(200);
  });

  it("returns a coherent resume snapshot while another device saves an answer", async () => {
    const scope = await createContentScope(database);
    await Promise.all([
      publishQuestion(scope, `practice-${crypto.randomUUID()}`),
      publishQuestion(scope, `practice-${crypto.randomUUID()}`),
    ]);
    const learner = await createLearner(scope.certificationId);
    const { response: created, body } = await createPractice(learner, scope, 2);
    expect(created.status).toBe(201);

    const secondDeviceCredentials = await createTestSessionCredentials(
      database,
      learner.userId,
      { now: Date.now(), expiresAt: Date.now() + 60 * 60 * 1000 },
    );
    const secondDevice = {
      ...learner,
      tokenDigest: secondDeviceCredentials.tokenDigest,
      rawToken: secondDeviceCredentials.rawToken,
    };
    const answerRequestId = crypto.randomUUID();
    const [savedResponse, concurrentResume] = await Promise.all([
      request(learner, `/attempts/${body.attempt.id}/answers`, {
        method: "POST",
        body: {
          expectedVersion: 1,
          requestId: answerRequestId,
          selectedOptionKey: "A",
        },
      }),
      request(secondDevice, `/attempts/${body.attempt.id}`),
    ]);
    expect(savedResponse.status).toBe(200);
    expect(concurrentResume.status).toBe(200);
    const saved = await savedResponse.json() as typeof body;
    const resumedDuringSave = await concurrentResume.json() as typeof body;

    const completedSnapshotIsVisible =
      resumedDuringSave.attempt.version === 2;
    expect(
      resumedDuringSave.attempt.currentPosition,
    ).toBe(completedSnapshotIsVisible ? 1 : 0);
    expect(resumedDuringSave.items.filter(
      (item) => item.selectedOptionKey !== undefined,
    )).toHaveLength(completedSnapshotIsVisible ? 1 : 0);
    expect(resumedDuringSave.items[0]?.selectedOptionKey).toBe(
      completedSnapshotIsVisible ? "A" : undefined,
    );
    expect(saved.attempt).toMatchObject({
      version: 2,
      currentPosition: 1,
    });
    expect(saved.items[0]).toMatchObject({
      selectedOptionKey: "A",
      isCorrect: true,
    });

    const resumedAfterSave = await request(
      secondDevice,
      `/attempts/${body.attempt.id}`,
    );
    const finalSnapshot = await resumedAfterSave.json() as typeof body;
    expect(finalSnapshot.attempt).toMatchObject({
      version: saved.attempt.version,
      currentPosition: saved.attempt.currentPosition,
      state: saved.attempt.state,
    });
    expect(finalSnapshot.items).toEqual(saved.items);
  });

  it("keeps the original question revision after publication replacement and retirement", async () => {
    const scope = await createContentScope(database);
    const question = await publishQuestion(scope, `practice-${crypto.randomUUID()}`);
    const learner = await createLearner(scope.certificationId);
    const { response, body } = await createPractice(learner, scope, 1);
    expect(response.status).toBe(201);

    const correction = {
      ...validQuestionContent,
      stem: "A corrected synthetic question with preserved attempt history?",
    };
    const newRevision = await createQuestionRevision(
      database,
      scope.tokenDigest,
      {
        certificationId: scope.certificationId,
        examVersionId: scope.examVersionId,
        questionId: question.questionId,
        domainId: scope.domainId,
        topicId: scope.topicId,
        expectedLockVersion: 1,
        content: correction,
      },
      contentOperation("practice-correction"),
      contentMfaPolicy,
    );
    if (!newRevision.ok) throw new Error(`Could not create correction: ${newRevision.reason}`);
    const submitted = await submitQuestionForReview(
      database,
      scope.tokenDigest,
      { certificationId: scope.certificationId, revisionId: newRevision.value.revisionId },
      contentOperation("practice-correction-submit"),
      contentMfaPolicy,
    );
    if (!submitted.ok) throw new Error(`Could not submit correction: ${submitted.reason}`);
    const review = await recordQuestionReview(
      database,
      scope.tokenDigest,
      {
        certificationId: scope.certificationId,
        revisionId: newRevision.value.revisionId,
        decision: "approved",
        notes: "Synthetic correction approval",
      },
      contentOperation("practice-correction-review"),
      contentMfaPolicy,
    );
    if (!review.ok) throw new Error(`Could not approve correction: ${review.reason}`);
    const published = await publishQuestionRevision(
      database,
      scope.tokenDigest,
      {
        certificationId: scope.certificationId,
        examVersionId: scope.examVersionId,
        questionId: question.questionId,
        revisionId: newRevision.value.revisionId,
        expectedPointerVersion: 1,
      },
      contentOperation("practice-correction-publish"),
      contentMfaPolicy,
    );
    if (!published.ok) throw new Error(`Could not replace publication: ${published.reason}`);
    const retired = await retirePublishedQuestion(
      database,
      scope.tokenDigest,
      {
        certificationId: scope.certificationId,
        examVersionId: scope.examVersionId,
        questionId: question.questionId,
        expectedPointerVersion: 2,
      },
      contentOperation("practice-correction-retire"),
      contentMfaPolicy,
    );
    if (!retired.ok) throw new Error(`Could not retire publication: ${retired.reason}`);

    const restored = await request(learner, `/attempts/${body.attempt.id}`);
    expect(restored.status).toBe(200);
    const restoredBody = await restored.json() as typeof body;
    expect(restoredBody.items[0]).toMatchObject({
      revisionId: question.revisionId,
      stem: question.stem,
    });
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM practice_attempt_items WHERE attempt_id = ?")
        .bind(body.attempt.id)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 1 });
  });

  it("rejects missing CSRF, wrong origin, and malformed or unsupported requests", async () => {
    const scope = await createContentScope(database);
    await publishQuestion(scope, `practice-${crypto.randomUUID()}`);
    const learner = await createLearner(scope.certificationId);
    const path = "/attempts";
    const requestBody = {
      certificationId: scope.certificationId,
      examVersionId: scope.examVersionId,
      questionCount: 1,
      requestId: crypto.randomUUID(),
    };
    expect(
      (await request(learner, path, {
        method: "POST",
        body: requestBody,
        csrf: false,
      })).status,
    ).toBe(400);
    expect(
      (await request(learner, path, {
        method: "POST",
        body: requestBody,
        origin: "https://attacker.example",
      })).status,
    ).toBe(400);
    const unsupported = await api.fetch(
      new Request(url(path), {
        method: "POST",
        headers: {
          Cookie: `certpath_session=${learner.rawToken}`,
          Origin: origin,
          "X-CSRF-Token": await csrf(learner),
          "Content-Type": "text/plain",
        },
        body: "not json",
      }),
      learner.bindings,
    );
    expect(unsupported.status).toBe(415);
    assertPrivate(unsupported);

    const forgedIdentity = await request(learner, path, {
      method: "POST",
      body: {
        ...requestBody,
        userId: learner.userId,
        role: "global_admin",
        tokenDigest: learner.tokenDigest,
      },
    });
    expect(forgedIdentity.status).toBe(400);
    assertPrivate(forgedIdentity);
  });

  it("rolls back all staged snapshots when a mid-batch D1 write fails", async () => {
    const scope = await createContentScope(database);
    await Promise.all([
      publishQuestion(scope, `practice-${crypto.randomUUID()}`),
      publishQuestion(scope, `practice-${crypto.randomUUID()}`),
    ]);
    const learner = await createLearner(scope.certificationId);
    const requestId = crypto.randomUUID();
    const trigger = `test_fail_practice_snapshot_${crypto.randomUUID().replaceAll("-", "")}`;
    await database
      .prepare(
        `CREATE TRIGGER ${trigger}
         BEFORE INSERT ON practice_attempt_items
         WHEN NEW.position = 1
         BEGIN
           SELECT RAISE(ABORT, 'synthetic mid-batch failure');
         END`,
      )
      .run();
    try {
      const failed = await request(learner, "/attempts", {
        method: "POST",
        body: {
          certificationId: scope.certificationId,
          examVersionId: scope.examVersionId,
          questionCount: 2,
          requestId,
        },
      });
      assertPrivate(failed);
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({
        error: { code: "service_unavailable" },
      });
      expect(
        await database
          .prepare(
            "SELECT COUNT(*) AS count FROM practice_attempts WHERE user_id = ? AND create_request_id = ?",
          )
          .bind(learner.userId, requestId)
          .first<{ count: number }>(),
      ).toMatchObject({ count: 0 });
      expect(
        await database
          .prepare(
            `SELECT COUNT(*) AS count FROM practice_attempt_items AS item
             JOIN practice_attempts AS attempt ON attempt.id = item.attempt_id
             WHERE attempt.user_id = ? AND attempt.create_request_id = ?`,
          )
          .bind(learner.userId, requestId)
          .first<{ count: number }>(),
      ).toMatchObject({ count: 0 });
    } finally {
      await database.prepare(`DROP TRIGGER ${trigger}`).run();
    }
  });

  it("enforces the JSON byte cap while streaming chunked request bodies", async () => {
    const scope = await createContentScope(database);
    await publishQuestion(scope, `practice-${crypto.randomUUID()}`);
    const learner = await createLearner(scope.certificationId);
    const token = await csrf(learner);
    const oversized = new TextEncoder().encode(
      JSON.stringify({
        certificationId: scope.certificationId,
        examVersionId: scope.examVersionId,
        questionCount: 1,
        requestId: crypto.randomUUID(),
        padding: "x".repeat(9000),
      }),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized.slice(0, 2048));
        controller.enqueue(oversized.slice(2048));
        controller.close();
      },
    });
    const tooLarge = await api.fetch(
      new Request(url("/attempts"), {
        method: "POST",
        headers: {
          Cookie: `certpath_session=${learner.rawToken}`,
          Origin: origin,
          "X-CSRF-Token": token,
          "Content-Type": "application/json",
        },
        body: stream,
        duplex: "half",
      } as RequestInit),
      learner.bindings,
    );
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({
      error: { code: "payload_too_large" },
    });
    assertPrivate(tooLarge);
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM practice_attempts WHERE user_id = ?")
        .bind(learner.userId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 0 });
  });

  it("runs a fixed mock with pinned snapshots, cross-session resume, stale-write protection, and one result", async () => {
    const scope = await createContentScope(database);
    const questions = await publishTimedMockQuestions(scope, 12);
    const learner = await createLearner(scope.certificationId);
    const requestId = crypto.randomUUID();
    const starts = await Promise.all([
    createTimedMock(learner, scope, requestId),
    createTimedMock(learner, scope, requestId),
    ]);
    expect(starts.map(({ response }) => response.status)).toEqual([201, 201]);
    const started = starts[0]!.body;
    expect(starts[1]!.body.attempt.id).toBe(started.attempt.id);
    expect(started.attempt).toMatchObject({
    state: "in_progress",
    version: 1,
    durationSeconds: 900,
    questionCount: 10,
    currentPosition: 0,
    });
    expect(started.attempt.deadlineAt - started.attempt.startedAt).toBe(900_000);
    expect(started.items).toHaveLength(10);
    expect(started.items.map((item) => item.position)).toEqual(
      Array.from({ length: 10 }, (_, position) => position),
    );
    expect(started.items[0]).not.toHaveProperty("correctOptionKey");
    expect(started.items[0]?.options[0]).not.toHaveProperty("explanation");
    assertPrivate(starts[0]!.response);
    expect(
    await database
      .prepare(
        "SELECT COUNT(*) AS count FROM timed_mock_attempts WHERE user_id = ? AND create_request_id = ?",
      )
      .bind(learner.userId, requestId)
      .first<{ count: number }>(),
    ).toMatchObject({ count: 1 });

    const answerInput = {
    expectedVersion: 1,
    requestId: crypto.randomUUID(),
    position: 0,
    selectedOptionKey: "A",
    };
    const answerPath = `/mocks/${started.attempt.id}/answers`;
    const savedAnswers = await Promise.all([
    request(learner, answerPath, {
      method: "POST",
      body: answerInput,
    }),
    request(learner, answerPath, {
      method: "POST",
      body: answerInput,
    }),
    ]);
    expect(savedAnswers.map((response) => response.status)).toEqual([200, 200]);
    const savedAnswer = savedAnswers[0]!;
    assertPrivate(savedAnswer);
    expect(savedAnswer.status).toBe(200);
    const acknowledged = await savedAnswer.json();
    expect(acknowledged.attempt).toMatchObject({
    state: "in_progress",
    version: 2,
    currentPosition: 0,
    answeredCount: 1,
    });
    expect(acknowledged.items[0]).toMatchObject({
    revisionId: started.items[0]?.revisionId,
    selectedOptionKey: "A",
    });
    expect(acknowledged.items[0]).not.toHaveProperty("correctOptionKey");
    expect(acknowledged.items[0]?.options[0]).not.toHaveProperty("explanation");
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM timed_mock_commands WHERE attempt_id = ?")
        .bind(started.attempt.id)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 1 });

    const stale = await request(learner, answerPath, {
    method: "POST",
    body: {
      ...answerInput,
      expectedVersion: 1,
      requestId: crypto.randomUUID(),
      selectedOptionKey: "B",
    },
    });
    assertPrivate(stale);
    expect(stale.status).toBe(409);

    const secondSessionCredentials = await createTestSessionCredentials(
    database,
    learner.userId,
    { now: Date.now(), expiresAt: Date.now() + 60 * 60 * 1000 },
    );
    const secondSession = {
    ...learner,
    rawToken: secondSessionCredentials.rawToken,
    tokenDigest: secondSessionCredentials.tokenDigest,
    };
    const resumed = await request(secondSession, `/mocks/${started.attempt.id}`);
    assertPrivate(resumed);
    expect(resumed.status).toBe(200);
    const resumedBody = await resumed.json();
    expect(resumedBody.attempt).toMatchObject({
    version: 2,
    deadlineAt: started.attempt.deadlineAt,
    answeredCount: 1,
    });
    expect(resumedBody.items[0]).toMatchObject({
    selectedOptionKey: "A",
    revisionId: started.items[0]?.revisionId,
    });
    expect(resumedBody).not.toHaveProperty("correctOptionKey");

    const submitInput = {
    expectedVersion: 2,
    requestId: crypto.randomUUID(),
    };
    const submitPath = `/mocks/${started.attempt.id}/submit`;
    const finalResponses = await Promise.all([
    request(learner, submitPath, { method: "POST", body: submitInput }),
    request(secondSession, submitPath, { method: "POST", body: submitInput }),
    ]);
    expect(finalResponses.map((response) => response.status)).toEqual([200, 200]);
    for (const response of finalResponses) assertPrivate(response);
    const finalized = await finalResponses[0]!.json();
    expect(finalized.attempt).toMatchObject({
    state: "completed",
    completionReason: "learner_submitted",
    version: 3,
    correctCount: 1,
    });
    expect(finalized.items[0]).toMatchObject({
    selectedOptionKey: "A",
    correctOptionKey: "A",
    isCorrect: true,
    });
    expect(finalized.items[0]?.options[0]).toHaveProperty("explanation");

    const retry = await request(learner, submitPath, {
    method: "POST",
    body: { expectedVersion: 2, requestId: crypto.randomUUID() },
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
    attempt: {
      id: started.attempt.id,
      state: "completed",
      completionReason: "learner_submitted",
      correctCount: 1,
    },
    });
    expect(
    await database
      .prepare(
        "SELECT COUNT(*) AS count FROM timed_mock_attempts WHERE id = ? AND state = 'completed'",
      )
      .bind(started.attempt.id)
      .first<{ count: number }>(),
    ).toMatchObject({ count: 1 });
    const snapshot = await database
    .prepare(
      "SELECT position, question_revision_id FROM timed_mock_items WHERE attempt_id = ? ORDER BY position",
    )
    .bind(started.attempt.id)
    .all<{ position: number; question_revision_id: string }>();
    expect(snapshot.results.map((item) => item.position)).toEqual(
      Array.from({ length: 10 }, (_, position) => position),
    );
    expect(snapshot.results).toHaveLength(10);
    expect(snapshot.results.every((item) =>
      questions.some((question) => question.revisionId === item.question_revision_id),
    )).toBe(true);

    const otherLearner = await createLearner(scope.certificationId);
    const hiddenFromOtherUser = await request(
    otherLearner,
    `/mocks/${started.attempt.id}`,
    );
    expect(hiddenFromOtherUser.status).toBe(404);
    assertPrivate(hiddenFromOtherUser);
  });

  it("enforces the deadline boundary and finalizes from acknowledged answers", async () => {
    const scope = await createContentScope(database);
    await publishTimedMockQuestions(scope);
    const learner = await createLearner(scope.certificationId);
    const started = await createTimedMock(learner, scope);
    expect(started.response.status).toBe(201);
    const attemptId = started.body.attempt.id;
    const answerPath = `/mocks/${attemptId}/answers`;

    vi.useFakeTimers();
    try {
    vi.setSystemTime(started.body.attempt.deadlineAt - 1000);
    const beforeDeadline = await request(learner, answerPath, {
      method: "POST",
      body: {
        expectedVersion: 1,
        requestId: crypto.randomUUID(),
        position: 0,
        selectedOptionKey: "A",
      },
    });
    expect(
      beforeDeadline.status,
      JSON.stringify(await beforeDeadline.clone().json()),
    ).toBe(200);

    vi.setSystemTime(started.body.attempt.deadlineAt);
    const atDeadline = await request(learner, answerPath, {
      method: "POST",
      body: {
        expectedVersion: 2,
        requestId: crypto.randomUUID(),
        position: 1,
        selectedOptionKey: "A",
      },
    });
    assertPrivate(atDeadline);
    expect(atDeadline.status).toBe(409);
    expect(await atDeadline.json()).toMatchObject({
      error: { code: "deadline_reached" },
    });

    const finalResponse = await request(learner, `/mocks/${attemptId}`);
    expect(finalResponse.status).toBe(200);
    const finalBody = await finalResponse.json();
    expect(finalBody.attempt).toMatchObject({
      state: "completed",
      completionReason: "timed_out",
      correctCount: 1,
    });
    expect(finalBody.items[0]).toMatchObject({
      selectedOptionKey: "A",
      correctOptionKey: "A",
      isCorrect: true,
    });
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM timed_mock_answers WHERE attempt_id = ?")
        .bind(attemptId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 1 });
    } finally {
    vi.useRealTimers();
    }
  });

  it("keeps Standard-grant expiry distinct from the running mock deadline", async () => {
    const scope = await createContentScope(database);
    await publishTimedMockQuestions(scope);
    const learner = await createLearner(scope.certificationId);
    const started = await createTimedMock(learner, scope);
    expect(started.response.status).toBe(201);
    const attemptId = started.body.attempt.id;
    await database
    .prepare(
      "UPDATE learner_access_grants SET expires_at = ? WHERE user_id = ? AND certification_id = ?",
    )
    .bind(started.body.attempt.deadlineAt - 1000, learner.userId, scope.certificationId)
    .run();

    vi.useFakeTimers();
    try {
    vi.setSystemTime(started.body.attempt.deadlineAt - 500);
    const expiredAccess = await request(learner, `/mocks/${attemptId}`);
    assertPrivate(expiredAccess);
    expect(expiredAccess.status).toBe(403);

    await database
      .prepare(
        "UPDATE learner_access_grants SET expires_at = ? WHERE user_id = ? AND certification_id = ?",
      )
      .bind(started.body.attempt.deadlineAt + 60_000, learner.userId, scope.certificationId)
      .run();
    const stillRunning = await request(learner, `/mocks/${attemptId}`);
    expect(stillRunning.status).toBe(200);
    expect((await stillRunning.json()).attempt).toMatchObject({
      state: "in_progress",
      deadlineAt: started.body.attempt.deadlineAt,
    });

    vi.setSystemTime(started.body.attempt.deadlineAt);
    const afterDeadline = await request(learner, `/mocks/${attemptId}`);
    expect(afterDeadline.status).toBe(200);
    expect(await afterDeadline.json()).toMatchObject({
      attempt: { state: "completed", completionReason: "timed_out" },
    });
    } finally {
    vi.useRealTimers();
    }
  });

  it("uses only the server profile and rejects an exam with too few published questions", async () => {
    const scope = await createContentScope(database);
    await publishTimedMockQuestions(scope, 9);
    const learner = await createLearner(scope.certificationId);
    const forgedProfile = await request(learner, "/mocks", {
    method: "POST",
    body: {
      certificationId: scope.certificationId,
      examVersionId: scope.examVersionId,
      durationSeconds: 60,
      questionCount: 1,
      requestId: crypto.randomUUID(),
    },
    });
    expect(forgedProfile.status).toBe(400);
    assertPrivate(forgedProfile);

    const insufficient = await createTimedMock(learner, scope);
    expect(insufficient.response.status).toBe(409);
    assertPrivate(insufficient.response);
    expect(insufficient.body).toMatchObject({
    error: { code: "insufficient_questions" },
    });
    expect(
    await database
      .prepare("SELECT COUNT(*) AS count FROM timed_mock_attempts WHERE user_id = ?")
      .bind(learner.userId)
      .first<{ count: number }>(),
    ).toMatchObject({ count: 0 });

    const otherScope = await createContentScope(database);
    const crossExam = await request(learner, "/mocks", {
    method: "POST",
    body: {
      certificationId: otherScope.certificationId,
      examVersionId: otherScope.examVersionId,
      requestId: crypto.randomUUID(),
    },
    });
    expect(crossExam.status).toBe(403);
    assertPrivate(crossExam);
  });
});
