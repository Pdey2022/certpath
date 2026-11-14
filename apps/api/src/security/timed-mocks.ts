import type { TimedMockAttemptResponse } from "@certpath/contracts";
import type { SecurityDatabase, D1PreparedStatement } from "./database.ts";
import type { PracticeResult } from "./practice.ts";
import { recordReadinessForAttempt } from "./readiness-snapshots.ts";

type MockFailure =
  | "access-required"
  | "conflict"
  | "deadline"
  | "insufficient-questions"
  | "invalid-answer"
  | "not-configured"
  | "not-found";

type MockResult<T> = PracticeResult<T> | { ok: false; reason: MockFailure };

interface ProfileRow {
  profile_version: number;
  duration_seconds: number;
  question_count: number;
}

interface MockRow {
  id: string;
  certification_id: string;
  exam_version_id: string;
  profile_version: number;
  state: "creating" | "in_progress" | "completed";
  completion_reason: "learner_submitted" | "timed_out" | null;
  version: number;
  duration_seconds: number;
  question_count: number;
  current_position: number;
  correct_count: number;
  started_at: number;
  deadline_at: number;
  create_request_id: string;
  completion_request_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface MockItemRow extends MockRow {
  position: number;
  question_revision_id: string;
  snapshot_json: string;
  selected_option_key: string | null;
  is_correct: number | null;
}

interface PublishedQuestionRow {
  position: number;
  question_id: string;
  question_revision_id: string;
  stem: string;
  correct_option_key: string;
  option_key: string;
  option_text: string;
  explanation: string;
}

interface MockSnapshot {
  stem: string;
  correctOptionKey: string;
  options: Array<{ key: string; text: string; explanation: string }>;
}

interface GroupedQuestion {
  questionId: string;
  revisionId: string;
  position: number;
  snapshot: MockSnapshot;
}

function activeSessionSql(alias: string): string {
  return `EXISTS (
    SELECT 1 FROM app_sessions AS active_session
    JOIN users AS active_user ON active_user.id = active_session.user_id
    WHERE active_session.token_digest = ?
      AND active_session.user_id = ${alias}.user_id
      AND active_session.revoked_at IS NULL
      AND active_session.expires_at > ?
      AND active_user.status = 'active'
  )`;
}

function activeGrantSql(alias: string): string {
  return `EXISTS (
    SELECT 1 FROM learner_access_grants AS active_grant
    WHERE active_grant.user_id = ${alias}.user_id
      AND active_grant.certification_id = ${alias}.certification_id
      AND active_grant.feature = 'standard'
      AND active_grant.revoked_at IS NULL
      AND active_grant.starts_at <= ?
      AND active_grant.expires_at > ?
  )`;
}

function summarize(row: MockRow, answeredCount: number) {
  return {
    id: row.id,
    certificationId: row.certification_id,
    examVersionId: row.exam_version_id,
    state: row.state === "creating" ? "in_progress" as const : row.state,
    completionReason: row.completion_reason,
    version: row.version,
    profileVersion: row.profile_version,
    durationSeconds: row.duration_seconds,
    questionCount: row.question_count,
    currentPosition: row.current_position,
    answeredCount,
    ...(row.state === "completed" ? { correctCount: row.correct_count } : {}),
    startedAt: row.started_at,
    deadlineAt: row.deadline_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function findByStartRequest(
  database: SecurityDatabase,
  userId: string,
  requestId: string,
): Promise<MockRow | null> {
  return database
    .prepare(
      `SELECT id, certification_id, exam_version_id, profile_version, state,
              completion_reason, version, duration_seconds, question_count,
              current_position, correct_count, started_at, deadline_at,
              create_request_id, completion_request_id, created_at, updated_at,
              completed_at
       FROM timed_mock_attempts
       WHERE user_id = ? AND create_request_id = ?`,
    )
    .bind(userId, requestId)
    .first<MockRow>();
}

async function selectQuestions(
  database: SecurityDatabase,
  certificationId: string,
  examVersionId: string,
  questionCount: number,
): Promise<GroupedQuestion[]> {
  const rows = await database
    .prepare(
      `WITH selected AS (
         SELECT pointer.certification_id, pointer.exam_version_id,
                pointer.question_id, pointer.question_revision_id,
                revision.stem,
                (SELECT option.option_key
                 FROM answer_options AS option
                 WHERE option.question_revision_id = revision.id
                   AND option.is_correct = 1
                 LIMIT 1) AS correct_option_key
         FROM exam_version_questions AS pointer
         JOIN question_revisions AS revision
           ON revision.certification_id = pointer.certification_id
          AND revision.exam_version_id = pointer.exam_version_id
          AND revision.question_id = pointer.question_id
          AND revision.id = pointer.question_revision_id
         JOIN question_revision_seals AS seal
           ON seal.certification_id = revision.certification_id
          AND seal.question_revision_id = revision.id
         WHERE pointer.certification_id = ?
           AND pointer.exam_version_id = ?
           AND pointer.publication_state = 'published'
         ORDER BY random()
         LIMIT ?
       ),
       chosen AS (
         SELECT selected.*,
                ROW_NUMBER() OVER (ORDER BY random()) - 1 AS position
         FROM selected
       )
       SELECT chosen.position, chosen.question_id,
              chosen.question_revision_id, chosen.stem,
              chosen.correct_option_key, option.option_key,
              option.option_text, option.explanation
       FROM chosen
       JOIN answer_options AS option
         ON option.certification_id = chosen.certification_id
        AND option.question_revision_id = chosen.question_revision_id
       ORDER BY chosen.position, option.option_order`,
    )
    .bind(certificationId, examVersionId, questionCount)
    .all<PublishedQuestionRow>();
  const questions = new Map<number, GroupedQuestion>();
  for (const row of rows.results) {
    let question = questions.get(row.position);
    if (!question) {
      question = {
        questionId: row.question_id,
        revisionId: row.question_revision_id,
        position: row.position,
        snapshot: {
          stem: row.stem,
          correctOptionKey: row.correct_option_key,
          options: [],
        },
      };
      questions.set(row.position, question);
    }
    question.snapshot.options.push({
      key: row.option_key,
      text: row.option_text,
      explanation: row.explanation,
    });
  }
  return [...questions.values()];
}

function createAttemptStatement(
  database: SecurityDatabase,
  input: {
    id: string;
    userId: string;
    tokenDigest: string;
    certificationId: string;
    examVersionId: string;
    requestId: string;
    profile: ProfileRow;
    now: number;
  },
): D1PreparedStatement {
  const { id, userId, tokenDigest, certificationId, examVersionId, requestId, profile, now } = input;
  return database
    .prepare(
      `INSERT INTO timed_mock_attempts (
         id, user_id, certification_id, exam_version_id, profile_version,
         state, completion_reason, version, duration_seconds, question_count,
         current_position, correct_count, started_at, deadline_at,
         create_request_id, created_at, updated_at
       )
       SELECT ?, ?, ?, ?, ?, 'creating', NULL, 1, ?, ?, 0, 0, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM timed_mock_profiles AS profile
         WHERE profile.certification_id = ? AND profile.exam_version_id = ?
           AND profile.profile_version = ? AND profile.active = 1
           AND profile.duration_seconds = ? AND profile.question_count = ?
       )
         AND EXISTS (
           SELECT 1 FROM app_sessions AS session
           JOIN users AS user ON user.id = session.user_id
           JOIN learner_access_grants AS grant_record
             ON grant_record.user_id = session.user_id
            AND grant_record.certification_id = ?
            AND grant_record.feature = 'standard'
           WHERE session.token_digest = ? AND session.user_id = ?
             AND session.revoked_at IS NULL AND session.expires_at > ?
             AND user.status = 'active'
             AND grant_record.revoked_at IS NULL
             AND grant_record.starts_at <= ? AND grant_record.expires_at > ?
         )`,
    )
    .bind(
      id, userId, certificationId, examVersionId, profile.profile_version,
      profile.duration_seconds, profile.question_count, now,
      now + profile.duration_seconds * 1000, requestId, now, now,
      certificationId, examVersionId, profile.profile_version,
      profile.duration_seconds, profile.question_count,
      certificationId, tokenDigest, userId, now, now, now,
    );
}

function insertSnapshot(
  database: SecurityDatabase,
  input: {
    attemptId: string;
    userId: string;
    tokenDigest: string;
    certificationId: string;
    examVersionId: string;
    question: GroupedQuestion;
    now: number;
  },
): D1PreparedStatement {
  const { attemptId, userId, tokenDigest, certificationId, examVersionId, question, now } = input;
  return database
    .prepare(
      `INSERT INTO timed_mock_items (
         attempt_id, certification_id, exam_version_id, question_id,
         question_revision_id, position, snapshot_json
       )
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM timed_mock_attempts AS attempt
         WHERE attempt.id = ? AND attempt.user_id = ?
           AND attempt.state = 'creating'
           AND EXISTS (
             SELECT 1 FROM exam_version_questions AS pointer
             WHERE pointer.certification_id = ? AND pointer.exam_version_id = ?
               AND pointer.question_id = ? AND pointer.question_revision_id = ?
               AND pointer.publication_state = 'published'
           )
           AND EXISTS (
             SELECT 1 FROM learner_access_grants AS grant_record
             WHERE grant_record.user_id = attempt.user_id
               AND grant_record.certification_id = attempt.certification_id
               AND grant_record.feature = 'standard'
               AND grant_record.revoked_at IS NULL
               AND grant_record.starts_at <= ? AND grant_record.expires_at > ?
           )
           AND ${activeSessionSql("attempt")}
       )`,
    )
    .bind(
      attemptId, certificationId, examVersionId, question.questionId,
      question.revisionId, question.position, JSON.stringify(question.snapshot),
      attemptId, userId, certificationId, examVersionId, question.questionId,
      question.revisionId, now, now, tokenDigest, now,
    );
}

async function finishExpired(
  database: SecurityDatabase,
  userId: string,
  tokenDigest: string,
  attemptId: string,
  now: number,
): Promise<void> {
  const finished = await database
    .prepare(
      `UPDATE timed_mock_attempts AS attempt
       SET state = 'completed', completion_reason = 'timed_out',
           correct_count = (
             SELECT COUNT(*) FROM timed_mock_answers AS answer
             WHERE answer.attempt_id = attempt.id AND answer.is_correct = 1
           ),
           completed_at = ?, updated_at = ?, version = version + 1
       WHERE attempt.id = ? AND attempt.user_id = ?
         AND attempt.state = 'in_progress' AND attempt.deadline_at <= ?
         AND ${activeSessionSql("attempt")}
         AND ${activeGrantSql("attempt")}`,
    )
    .bind(now, now, attemptId, userId, now, tokenDigest, now, now, now)
    .run();
  if (finished.meta.changes > 0) {
    await recordReadinessForAttempt(database, attemptId, now);
  }
}

async function loadResponse(
  database: SecurityDatabase,
  userId: string,
  tokenDigest: string,
  attemptId: string,
  now: number,
): Promise<TimedMockAttemptResponse | null> {
  await finishExpired(database, userId, tokenDigest, attemptId, now);
  const rows = await database
    .prepare(
      `SELECT attempt.id, attempt.certification_id, attempt.exam_version_id,
              attempt.profile_version, attempt.state, attempt.completion_reason,
              attempt.version, attempt.duration_seconds, attempt.question_count,
              attempt.current_position, attempt.correct_count, attempt.started_at,
              attempt.deadline_at, attempt.create_request_id,
              attempt.completion_request_id, attempt.created_at, attempt.updated_at,
              attempt.completed_at, item.position, item.question_revision_id,
              item.snapshot_json, answer.selected_option_key, answer.is_correct
       FROM timed_mock_attempts AS attempt
       JOIN exam_versions AS exam_version
         ON exam_version.certification_id = attempt.certification_id
        AND exam_version.id = attempt.exam_version_id
       JOIN timed_mock_items AS item ON item.attempt_id = attempt.id
       LEFT JOIN timed_mock_answers AS answer
         ON answer.attempt_id = item.attempt_id AND answer.position = item.position
       WHERE attempt.id = ? AND attempt.user_id = ?
         AND ${activeSessionSql("attempt")}
         AND ${activeGrantSql("attempt")}
       ORDER BY item.position`,
    )
    .bind(attemptId, userId, tokenDigest, now, now, now)
    .all<MockItemRow>();
  const first = rows.results[0];
  if (!first) return null;
  const row: MockRow = {
    id: first.id,
    certification_id: first.certification_id,
    exam_version_id: first.exam_version_id,
    profile_version: first.profile_version,
    state: first.state,
    completion_reason: first.completion_reason,
    version: first.version,
    duration_seconds: first.duration_seconds,
    question_count: first.question_count,
    current_position: first.current_position,
    correct_count: first.correct_count,
    started_at: first.started_at,
    deadline_at: first.deadline_at,
    create_request_id: first.create_request_id,
    completion_request_id: first.completion_request_id,
    created_at: first.created_at,
    updated_at: first.updated_at,
    completed_at: first.completed_at,
  };
  const isComplete = row.state === "completed";
  const answeredCount = rows.results.filter((item) => item.selected_option_key !== null).length;
  return {
    attempt: summarize(row, answeredCount),
    serverNow: now,
    items: rows.results.map((item) => {
      const snapshot = JSON.parse(item.snapshot_json) as MockSnapshot;
      const answered = item.selected_option_key !== null;
      return {
        position: item.position,
        revisionId: item.question_revision_id,
        stem: snapshot.stem,
        options: snapshot.options.map((option) => ({
          key: option.key,
          text: option.text,
          ...(isComplete ? { explanation: option.explanation } : {}),
        })),
        ...(answered ? { selectedOptionKey: item.selected_option_key! } : {}),
        ...(isComplete
          ? {
              correctOptionKey: snapshot.correctOptionKey,
              ...(answered ? { isCorrect: item.is_correct === 1 } : {}),
            }
          : {}),
      };
    }),
  };
}

export async function listTimedMockAttempts(
  database: SecurityDatabase,
  userId: string,
  tokenDigest: string,
  certificationId: string,
  examVersionId: string,
  now: number,
): Promise<MockResult<{ items: ReturnType<typeof summarize>[] }>> {
  const attempts = await database
    .prepare(
      `SELECT attempt.id
       FROM timed_mock_attempts AS attempt
       WHERE attempt.user_id = ? AND attempt.certification_id = ?
         AND attempt.exam_version_id = ?
         AND ${activeSessionSql("attempt")}
         AND ${activeGrantSql("attempt")}
       ORDER BY attempt.created_at DESC, attempt.id DESC
       LIMIT 20`,
    )
    .bind(userId, certificationId, examVersionId, tokenDigest, now, now, now)
    .all<{ id: string }>();
  if (attempts.results.length === 0) {
    const hasGrant = await database
      .prepare(
        `SELECT 1 FROM learner_access_grants AS grant_record
         WHERE grant_record.user_id = ? AND grant_record.certification_id = ?
           AND grant_record.feature = 'standard' AND grant_record.revoked_at IS NULL
           AND grant_record.starts_at <= ? AND grant_record.expires_at > ?
           AND EXISTS (
             SELECT 1 FROM app_sessions AS session
             JOIN users AS user ON user.id = session.user_id
             WHERE session.token_digest = ? AND session.user_id = grant_record.user_id
               AND session.revoked_at IS NULL AND session.expires_at > ?
               AND user.status = 'active'
           )
         LIMIT 1`,
      )
      .bind(userId, certificationId, now, now, tokenDigest, now)
      .first<{ 1: number }>();
    if (!hasGrant) return { ok: false, reason: "access-required" };
  }
  const summaries: ReturnType<typeof summarize>[] = [];
  for (const { id } of attempts.results) {
    const response = await loadResponse(database, userId, tokenDigest, id, now);
    if (response) summaries.push(response.attempt);
  }
  return { ok: true, value: { items: summaries } };
}

export async function getTimedMockAttempt(
  database: SecurityDatabase,
  userId: string,
  tokenDigest: string,
  attemptId: string,
  now: number,
): Promise<MockResult<TimedMockAttemptResponse>> {
  const response = await loadResponse(database, userId, tokenDigest, attemptId, now);
  if (response) return { ok: true, value: response };
  const owned = await database
    .prepare("SELECT certification_id FROM timed_mock_attempts WHERE id = ? AND user_id = ?")
    .bind(attemptId, userId)
    .first<{ certification_id: string }>();
  return { ok: false, reason: owned ? "access-required" : "not-found" };
}

async function replayExistingStart(
  database: SecurityDatabase,
  userId: string,
  tokenDigest: string,
  row: MockRow,
  certificationId: string,
  examVersionId: string,
  now: number,
): Promise<MockResult<TimedMockAttemptResponse>> {
  if (
    row.certification_id !== certificationId ||
    row.exam_version_id !== examVersionId
  ) {
    return { ok: false, reason: "conflict" };
  }
  return getTimedMockAttempt(database, userId, tokenDigest, row.id, now);
}

export async function startTimedMock(
  database: SecurityDatabase,
  userId: string,
  tokenDigest: string,
  input: { certificationId: string; examVersionId: string; requestId: string },
  now: number,
): Promise<MockResult<TimedMockAttemptResponse>> {
  const previous = await findByStartRequest(database, userId, input.requestId);
  if (previous) {
    return replayExistingStart(
      database, userId, tokenDigest, previous,
      input.certificationId, input.examVersionId, now,
    );
  }
  const profile = await database
    .prepare(
      `SELECT profile.profile_version, profile.duration_seconds, profile.question_count
       FROM timed_mock_profiles AS profile
       WHERE profile.certification_id = ? AND profile.exam_version_id = ?
         AND profile.active = 1
         AND EXISTS (
           SELECT 1 FROM learner_access_grants AS grant_record
           WHERE grant_record.user_id = ? AND grant_record.certification_id = profile.certification_id
             AND grant_record.feature = 'standard' AND grant_record.revoked_at IS NULL
             AND grant_record.starts_at <= ? AND grant_record.expires_at > ?
         )
         AND EXISTS (
           SELECT 1 FROM app_sessions AS session
           JOIN users AS user ON user.id = session.user_id
           WHERE session.token_digest = ? AND session.user_id = ?
             AND session.revoked_at IS NULL AND session.expires_at > ?
             AND user.status = 'active'
         )
       LIMIT 1`,
    )
    .bind(
      input.certificationId, input.examVersionId, userId, now, now,
      tokenDigest, userId, now,
    )
    .first<ProfileRow>();
  if (!profile) {
    const hasAccess = await database
      .prepare(
        `SELECT 1 FROM exam_versions AS version
         WHERE version.certification_id = ? AND version.id = ?
           AND EXISTS (
             SELECT 1 FROM learner_access_grants AS grant_record
             WHERE grant_record.user_id = ? AND grant_record.certification_id = version.certification_id
               AND grant_record.feature = 'standard' AND grant_record.revoked_at IS NULL
               AND grant_record.starts_at <= ? AND grant_record.expires_at > ?
           )
           AND EXISTS (
             SELECT 1 FROM app_sessions AS session
             JOIN users AS user ON user.id = session.user_id
             WHERE session.token_digest = ? AND session.user_id = ?
               AND session.revoked_at IS NULL AND session.expires_at > ?
               AND user.status = 'active'
           )`,
      )
      .bind(
        input.certificationId, input.examVersionId, userId, now, now,
        tokenDigest, userId, now,
      )
      .first<{ 1: number }>();
    return { ok: false, reason: hasAccess ? "not-configured" : "access-required" };
  }
  if (
    !Number.isInteger(profile.duration_seconds) ||
    profile.duration_seconds < 60 ||
    profile.duration_seconds > 14_400 ||
    !Number.isInteger(profile.question_count) ||
    profile.question_count < 1 ||
    profile.question_count > 20
  ) {
    throw new Error("Timed mock profile is outside supported server limits");
  }
  const questions = await selectQuestions(
    database,
    input.certificationId,
    input.examVersionId,
    profile.question_count,
  );
  if (questions.length !== profile.question_count) {
    return { ok: false, reason: "insufficient-questions" };
  }
  const attemptId = crypto.randomUUID();
  const statements = [
    createAttemptStatement(database, {
      id: attemptId,
      userId,
      tokenDigest,
      certificationId: input.certificationId,
      examVersionId: input.examVersionId,
      requestId: input.requestId,
      profile,
      now,
    }),
    ...questions.map((question) =>
      insertSnapshot(database, {
        attemptId,
        userId,
        tokenDigest,
        certificationId: input.certificationId,
        examVersionId: input.examVersionId,
        question,
        now,
      }),
    ),
    database
      .prepare(
        `UPDATE timed_mock_attempts
         SET state = 'in_progress'
         WHERE id = ? AND state = 'creating'
           AND EXISTS (
             SELECT 1 FROM app_sessions AS session
             JOIN users AS user ON user.id = session.user_id
             JOIN learner_access_grants AS grant_record
               ON grant_record.user_id = session.user_id
              AND grant_record.certification_id = timed_mock_attempts.certification_id
              AND grant_record.feature = 'standard'
             WHERE session.token_digest = ? AND session.user_id = timed_mock_attempts.user_id
               AND session.revoked_at IS NULL AND session.expires_at > ?
               AND user.status = 'active'
               AND grant_record.revoked_at IS NULL
               AND grant_record.starts_at <= ? AND grant_record.expires_at > ?
           )`,
      )
      .bind(attemptId, tokenDigest, now, now, now),
  ];
  try {
    const results = await database.batch(statements);
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results.at(-1)?.meta.changes ?? 0) !== 1
    ) {
      const duplicate = await findByStartRequest(database, userId, input.requestId);
      if (duplicate) {
        return replayExistingStart(
          database, userId, tokenDigest, duplicate,
          input.certificationId, input.examVersionId, now,
        );
      }
      return { ok: false, reason: "access-required" };
    }
  } catch (error) {
    const duplicate = await findByStartRequest(database, userId, input.requestId);
    if (duplicate) {
      return replayExistingStart(
        database, userId, tokenDigest, duplicate,
        input.certificationId, input.examVersionId, now,
      );
    }
    throw new Error("Timed mock attempt transaction failed", { cause: error });
  }
  const response = await loadResponse(database, userId, tokenDigest, attemptId, now);
  return response ? { ok: true, value: response } : { ok: false, reason: "access-required" };
}

async function findCommand(
  database: SecurityDatabase,
  attemptId: string,
  requestId: string,
) {
  return database
    .prepare(
      `SELECT command_type, expected_version, position, selected_option_key
       FROM timed_mock_commands WHERE attempt_id = ? AND request_id = ?`,
    )
    .bind(attemptId, requestId)
    .first<{
      command_type: "answer" | "navigate";
      expected_version: number;
      position: number;
      selected_option_key: string | null;
    }>();
}

async function writeCommand(
  database: SecurityDatabase,
  userId: string,
  tokenDigest: string,
  attemptId: string,
  input: {
    expectedVersion: number;
    requestId: string;
    position: number;
    selectedOptionKey: string | null;
  },
  now: number,
): Promise<MockResult<TimedMockAttemptResponse>> {
  const current = await getTimedMockAttempt(database, userId, tokenDigest, attemptId, now);
  if (!current.ok) return current;
  const existing = await findCommand(database, attemptId, input.requestId);
  if (existing) {
    if (
      existing.command_type !== (input.selectedOptionKey === null ? "navigate" : "answer") ||
      existing.expected_version !== input.expectedVersion ||
      existing.position !== input.position ||
      existing.selected_option_key !== input.selectedOptionKey
    ) {
      return { ok: false, reason: "conflict" };
    }
    return { ok: true, value: current.value };
  }
  if (current.value.attempt.state === "completed") {
    return {
      ok: false,
      reason: current.value.attempt.completionReason === "timed_out"
        ? "deadline"
        : "conflict",
    };
  }
  if (now >= current.value.attempt.deadlineAt) {
    return { ok: false, reason: "deadline" };
  }
  if (input.position >= current.value.attempt.questionCount) {
    return { ok: false, reason: "invalid-answer" };
  }
  if (
    input.selectedOptionKey !== null &&
    !current.value.items[input.position]?.options.some(
      (option) => option.key === input.selectedOptionKey,
    )
  ) {
    return { ok: false, reason: "invalid-answer" };
  }
  const commandType = input.selectedOptionKey === null ? "navigate" : "answer";
  try {
    await database
      .prepare(
        `INSERT INTO timed_mock_commands (
           attempt_id, request_id, command_type, expected_version,
           result_version, position, selected_option_key, submitted_at
         )
         SELECT attempt.id, ?, ?, ?, attempt.version + 1, ?, ?, ?
         FROM timed_mock_attempts AS attempt
         WHERE attempt.id = ? AND attempt.user_id = ?
           AND attempt.state = 'in_progress'
           AND attempt.version = ?
           AND attempt.deadline_at > ?
           AND ${activeSessionSql("attempt")}
           AND ${activeGrantSql("attempt")}`,
      )
      .bind(
        input.requestId, commandType, input.expectedVersion, input.position,
        input.selectedOptionKey, now, attemptId, userId, input.expectedVersion,
        now, tokenDigest, now, now, now,
      )
      .run();
    const persisted = await findCommand(database, attemptId, input.requestId);
    if (persisted) {
      if (
        persisted.command_type !== commandType ||
        persisted.expected_version !== input.expectedVersion ||
        persisted.position !== input.position ||
        persisted.selected_option_key !== input.selectedOptionKey
      ) {
        return { ok: false, reason: "conflict" };
      }
      const updated = await getTimedMockAttempt(database, userId, tokenDigest, attemptId, now);
      return updated.ok ? updated : { ok: false, reason: "access-required" };
    }
  } catch (error) {
    const replay = await findCommand(database, attemptId, input.requestId);
    if (replay) {
      const updated = await getTimedMockAttempt(database, userId, tokenDigest, attemptId, now);
      if (
        replay.command_type === commandType &&
        replay.expected_version === input.expectedVersion &&
        replay.position === input.position &&
        replay.selected_option_key === input.selectedOptionKey &&
        updated.ok
      ) {
        return updated;
      }
    }
    throw new Error("Timed mock command failed", { cause: error });
  }
  const latest = await getTimedMockAttempt(database, userId, tokenDigest, attemptId, now);
  if (!latest.ok) return latest;
  return latest.value.attempt.state === "completed" &&
    latest.value.attempt.completionReason === "timed_out"
    ? { ok: false, reason: "deadline" }
    : { ok: false, reason: "conflict" };
}

export function saveTimedMockAnswer(
  database: SecurityDatabase,
  userId: string,
  tokenDigest: string,
  attemptId: string,
  input: {
    expectedVersion: number;
    requestId: string;
    position: number;
    selectedOptionKey: string;
  },
  now: number,
) {
  return writeCommand(database, userId, tokenDigest, attemptId, input, now);
}

export function saveTimedMockPosition(
  database: SecurityDatabase,
  userId: string,
  tokenDigest: string,
  attemptId: string,
  input: { expectedVersion: number; requestId: string; position: number },
  now: number,
) {
  return writeCommand(
    database,
    userId,
    tokenDigest,
    attemptId,
    { ...input, selectedOptionKey: null },
    now,
  );
}

export async function submitTimedMock(
  database: SecurityDatabase,
  userId: string,
  tokenDigest: string,
  attemptId: string,
  input: { expectedVersion: number; requestId: string },
  now: number,
): Promise<MockResult<TimedMockAttemptResponse>> {
  const current = await getTimedMockAttempt(database, userId, tokenDigest, attemptId, now);
  if (!current.ok) return current;
  if (current.value.attempt.state === "completed") return current;
  if (now >= current.value.attempt.deadlineAt) return current;
  if (current.value.attempt.version !== input.expectedVersion) {
    return { ok: false, reason: "conflict" };
  }
  const completed = await database
    .prepare(
      `UPDATE timed_mock_attempts AS attempt
       SET state = 'completed', completion_reason = 'learner_submitted',
           completion_request_id = ?,
           correct_count = (
             SELECT COUNT(*) FROM timed_mock_answers AS answer
             WHERE answer.attempt_id = attempt.id AND answer.is_correct = 1
           ),
           completed_at = ?, updated_at = ?, version = version + 1
       WHERE attempt.id = ? AND attempt.user_id = ?
         AND attempt.state = 'in_progress' AND attempt.version = ?
         AND attempt.deadline_at > ?
         AND ${activeSessionSql("attempt")}
         AND ${activeGrantSql("attempt")}`,
    )
    .bind(
      input.requestId, now, now, attemptId, userId, input.expectedVersion,
      now, tokenDigest, now, now, now,
    )
    .run();
  if (completed.meta.changes > 0) {
    await recordReadinessForAttempt(database, attemptId, now);
  }
  const finalized = await getTimedMockAttempt(database, userId, tokenDigest, attemptId, now);
  if (!finalized.ok) return finalized;
  if (finalized.value.attempt.state === "completed") return finalized;
  return { ok: false, reason: "conflict" };
}
