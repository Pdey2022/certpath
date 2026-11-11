import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
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
});
