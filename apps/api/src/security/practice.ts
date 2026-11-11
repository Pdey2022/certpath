import type {
  D1PreparedStatement,
  SecurityDatabase,
} from "./database.ts";
import type {
  PracticeAttemptResponse,
  PracticeScopeResponse,
  StartPracticeRequest,
  PracticeAnswerRequest,
} from "@certpath/contracts";

export type PracticeFailure =
  | "access-required"
  | "not-found"
  | "insufficient-questions"
  | "conflict";

export type PracticeResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: PracticeFailure };

interface ScopeRow {
  certification_id: string;
  certification_name: string;
  exam_version_id: string;
  version_key: string;
  exam_version_title: string;
  domain_id: string | null;
  domain_title: string | null;
}

interface AttemptRow {
  id: string;
  certification_id: string;
  exam_version_id: string;
  state: "in_progress" | "completed";
  version: number;
  question_count: number;
  current_position: number;
  correct_count: number;
  filters_json: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  create_request_id: string;
}

interface AttemptItemRow {
  position: number;
  question_id: string;
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

interface Snapshot {
  stem: string;
  correctOptionKey: string;
  options: Array<{
    key: string;
    text: string;
    explanation: string;
  }>;
}

interface AttemptFilters {
  domainId?: string;
  difficulty?: "easy" | "medium" | "hard";
}

function activeSessionSql(alias: string): string {
  return `EXISTS (
    SELECT 1
    FROM app_sessions AS active_session
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
    SELECT 1
    FROM learner_access_grants AS active_grant
    WHERE active_grant.user_id = ${alias}.user_id
      AND active_grant.certification_id = ${alias}.certification_id
      AND active_grant.feature = 'standard'
      AND active_grant.revoked_at IS NULL
      AND active_grant.starts_at <= ?
      AND active_grant.expires_at > ?
  )`;
}

export async function listPracticeScopes(
  database: SecurityDatabase,
  userId: string,
  tokenDigest: string,
  now: number,
): Promise<PracticeScopeResponse> {
  const rows = await database
    .prepare(
      `SELECT certification.id AS certification_id,
              certification.display_name AS certification_name,
              version.id AS exam_version_id,
              version.version_key, version.title AS exam_version_title,
              domain.id AS domain_id, domain.title AS domain_title
       FROM learner_access_grants AS access_grant
       JOIN certifications AS certification
         ON certification.id = access_grant.certification_id
       JOIN exam_versions AS version
         ON version.certification_id = access_grant.certification_id
       LEFT JOIN domains AS domain
         ON domain.certification_id = version.certification_id
        AND domain.exam_version_id = version.id
       WHERE access_grant.user_id = ?
         AND access_grant.feature = 'standard'
         AND access_grant.revoked_at IS NULL
         AND access_grant.starts_at <= ?
         AND access_grant.expires_at > ?
         AND ${activeSessionSql("access_grant")}
         AND EXISTS (
           SELECT 1
           FROM exam_version_questions AS pointer
           WHERE pointer.certification_id = version.certification_id
             AND pointer.exam_version_id = version.id
             AND pointer.publication_state = 'published'
         )
       ORDER BY certification.display_name, version.version_key,
                domain.display_order, domain.id
       LIMIT 4000`,
    )
    .bind(userId, now, now, tokenDigest, now)
    .all<ScopeRow>();
  if (rows.results.length >= 4000) {
    throw new Error("Authorized practice scope exceeds its response bound");
  }

  const scopes = new Map<string, PracticeScopeResponse["items"][number]>();
  for (const row of rows.results) {
    const key = `${row.certification_id}\n${row.exam_version_id}`;
    let scope = scopes.get(key);
    if (!scope) {
      if (scopes.size >= 200) {
        throw new Error("Authorized practice scopes exceed their response bound");
      }
      scope = {
        certificationId: row.certification_id,
        certificationName: row.certification_name,
        examVersionId: row.exam_version_id,
        versionKey: row.version_key,
        examVersionTitle: row.exam_version_title,
        domains: [],
      };
      scopes.set(key, scope);
    }
    if (
      row.domain_id &&
      !scope.domains.some((domain) => domain.id === row.domain_id)
    ) {
      if (scope.domains.length >= 200) {
        throw new Error("Authorized practice domains exceed their response bound");
      }
      scope.domains.push({ id: row.domain_id, title: row.domain_title ?? "" });
    }
  }
  return { items: [...scopes.values()] };
}

function toSummary(row: AttemptRow) {
  const filters = JSON.parse(row.filters_json) as AttemptFilters;
  return {
    id: row.id,
    certificationId: row.certification_id,
    examVersionId: row.exam_version_id,
    state: row.state,
    version: row.version,
    questionCount: row.question_count,
    currentPosition: row.current_position,
    ...(row.state === "completed" ? { correctCount: row.correct_count } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    filters,
  };
}

async function findAttemptByRequest(
  database: SecurityDatabase,
  userId: string,
  requestId: string,
): Promise<AttemptRow | null> {
  return database
    .prepare(
      `SELECT id, certification_id, exam_version_id, state, version,
              question_count, current_position, correct_count, filters_json,
              create_request_id, created_at, updated_at, completed_at
       FROM practice_attempts
       WHERE user_id = ? AND create_request_id = ?`,
    )
    .bind(userId, requestId)
    .first<AttemptRow>();
}

async function findAttempt(
  database: SecurityDatabase,
  userId: string,
  tokenDigest: string,
  attemptId: string,
  now: number,
): Promise<AttemptRow | null> {
  return database
    .prepare(
      `SELECT attempt.id, attempt.certification_id, attempt.exam_version_id,
              attempt.state, attempt.version, attempt.question_count,
              attempt.current_position, attempt.correct_count,
              attempt.filters_json, attempt.create_request_id,
              attempt.created_at, attempt.updated_at, attempt.completed_at
       FROM practice_attempts AS attempt
       WHERE attempt.id = ? AND attempt.user_id = ?
         AND ${activeSessionSql("attempt")}
         AND ${activeGrantSql("attempt")}`,
    )
    .bind(attemptId, userId, tokenDigest, now, now, now)
    .first<AttemptRow>();
}

async function hasActiveGrant(
  database: SecurityDatabase,
  userId: string,
  tokenDigest: string,
  certificationId: string,
  now: number,
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT 1 AS allowed
       FROM learner_access_grants AS access_grant
       WHERE access_grant.user_id = ?
         AND access_grant.certification_id = ?
         AND access_grant.feature = 'standard'
         AND access_grant.revoked_at IS NULL
         AND access_grant.starts_at <= ?
         AND access_grant.expires_at > ?
         AND EXISTS (
           SELECT 1 FROM app_sessions AS session
           JOIN users AS user ON user.id = session.user_id
           WHERE session.token_digest = ?
             AND session.user_id = access_grant.user_id
             AND session.revoked_at IS NULL
             AND session.expires_at > ?
             AND user.status = 'active'
         )
       LIMIT 1`,
    )
    .bind(userId, certificationId, now, now, tokenDigest, now)
    .first<{ allowed: number }>();
  return row !== null;
}

export async function listPracticeAttempts(
  database: SecurityDatabase,
  userId: string,
  tokenDigest: string,
  certificationId: string,
  examVersionId: string,
  now: number,
): Promise<PracticeResult<{ items: ReturnType<typeof toSummary>[] }>> {
  if (
    !(await hasActiveGrant(database, userId, tokenDigest, certificationId, now))
  ) {
    return { ok: false, reason: "access-required" };
  }
  const rows = await database
    .prepare(
      `SELECT id, certification_id, exam_version_id, state, version,
              question_count, current_position, correct_count, filters_json,
              create_request_id, created_at, updated_at, completed_at
       FROM practice_attempts AS attempt
       WHERE attempt.user_id = ?
         AND attempt.certification_id = ?
         AND attempt.exam_version_id = ?
         AND ${activeSessionSql("attempt")}
         AND ${activeGrantSql("attempt")}
       ORDER BY attempt.created_at DESC, attempt.id DESC
       LIMIT 20`,
    )
    .bind(
      userId,
      certificationId,
      examVersionId,
      tokenDigest,
      now,
      now,
      now,
    )
    .all<AttemptRow>();
  return { ok: true, value: { items: rows.results.map(toSummary) } };
}

async function loadAttemptResponse(
  database: SecurityDatabase,
  row: AttemptRow,
): Promise<PracticeAttemptResponse> {
  const itemRows = await database
    .prepare(
      `SELECT item.position, item.question_id, item.question_revision_id,
              item.snapshot_json, answer.selected_option_key, answer.is_correct
       FROM practice_attempt_items AS item
       LEFT JOIN practice_answer_events AS answer
         ON answer.attempt_id = item.attempt_id
        AND answer.item_position = item.position
       WHERE item.attempt_id = ?
       ORDER BY item.position`,
    )
    .bind(row.id)
    .all<AttemptItemRow>();
  const items = itemRows.results.map((item) => {
    const snapshot = JSON.parse(item.snapshot_json) as Snapshot;
    const answered = item.selected_option_key !== null;
    return {
      position: item.position,
      revisionId: item.question_revision_id,
      stem: snapshot.stem,
      options: snapshot.options.map((option) => ({
        key: option.key,
        text: option.text,
        ...(answered ? { explanation: option.explanation } : {}),
      })),
      ...(answered
        ? {
            selectedOptionKey: item.selected_option_key!,
            correctOptionKey: snapshot.correctOptionKey,
            isCorrect: item.is_correct === 1,
          }
        : {}),
    };
  });
  return { attempt: toSummary(row), items };
}

export async function getPracticeAttempt(
  database: SecurityDatabase,
  userId: string,
  tokenDigest: string,
  attemptId: string,
  now: number,
): Promise<PracticeResult<PracticeAttemptResponse>> {
  const row = await findAttempt(database, userId, tokenDigest, attemptId, now);
  if (!row) {
    const owned = await database
      .prepare("SELECT certification_id FROM practice_attempts WHERE id = ? AND user_id = ?")
      .bind(attemptId, userId)
      .first<{ certification_id: string }>();
    return {
      ok: false,
      reason: owned ? "access-required" : "not-found",
    };
  }
  return { ok: true, value: await loadAttemptResponse(database, row) };
}

function sameFilters(
  storedJson: string,
  input: StartPracticeRequest,
): boolean {
  const stored = JSON.parse(storedJson) as AttemptFilters;
  return (
    (stored.domainId ?? null) === (input.domainId ?? null) &&
    (stored.difficulty ?? null) === (input.difficulty ?? null)
  );
}

async function activeVersionExists(
  database: SecurityDatabase,
  userId: string,
  tokenDigest: string,
  certificationId: string,
  examVersionId: string,
  now: number,
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT 1 AS allowed
       FROM exam_versions AS version
       WHERE version.certification_id = ? AND version.id = ?
         AND EXISTS (
           SELECT 1 FROM learner_access_grants AS access_grant
           WHERE access_grant.user_id = ?
             AND access_grant.certification_id = version.certification_id
             AND access_grant.feature = 'standard'
             AND access_grant.revoked_at IS NULL
             AND access_grant.starts_at <= ? AND access_grant.expires_at > ?
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
      certificationId,
      examVersionId,
      userId,
      now,
      now,
      tokenDigest,
      userId,
      now,
    )
    .first<{ allowed: number }>();
  return row !== null;
}

async function selectQuestions(
  database: SecurityDatabase,
  input: StartPracticeRequest,
): Promise<PublishedQuestionRow[]> {
  const rows = await database
    .prepare(
      `WITH chosen AS (
         SELECT pointer.certification_id, pointer.exam_version_id,
                pointer.question_id, pointer.question_revision_id,
                revision.stem,
                (SELECT option.option_key
                 FROM answer_options AS option
                 WHERE option.question_revision_id = revision.id
                   AND option.is_correct = 1
                 LIMIT 1) AS correct_option_key,
                revision.domain_id,
                revision.difficulty,
                ROW_NUMBER() OVER (ORDER BY random()) - 1 AS position
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
           AND (? IS NULL OR revision.domain_id = ?)
           AND (? IS NULL OR revision.difficulty = ?)
         ORDER BY random()
         LIMIT ?
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
    .bind(
      input.certificationId,
      input.examVersionId,
      input.domainId ?? null,
      input.domainId ?? null,
      input.difficulty ?? null,
      input.difficulty ?? null,
      input.questionCount,
    )
    .all<PublishedQuestionRow>();
  return rows.results;
}

function groupQuestions(rows: PublishedQuestionRow[]): Array<{
  questionId: string;
  revisionId: string;
  position: number;
  snapshot: Snapshot;
}> {
  const questions = new Map<
    number,
    {
      questionId: string;
      revisionId: string;
      position: number;
      snapshot: Snapshot;
    }
  >();
  for (const row of rows) {
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

function snapshotInsert(
  database: SecurityDatabase,
  attemptId: string,
  userId: string,
  tokenDigest: string,
  certificationId: string,
  examVersionId: string,
  question: ReturnType<typeof groupQuestions>[number],
  now: number,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO practice_attempt_items (
         attempt_id, certification_id, exam_version_id,
         question_id, question_revision_id, position, snapshot_json
       )
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM practice_attempts AS attempt
         WHERE attempt.id = ? AND attempt.user_id = ?
           AND attempt.state = 'creating'
           AND EXISTS (
             SELECT 1 FROM exam_version_questions AS pointer
             WHERE pointer.certification_id = ?
               AND pointer.exam_version_id = ?
               AND pointer.question_id = ?
               AND pointer.question_revision_id = ?
               AND pointer.publication_state = 'published'
           )
           AND EXISTS (
             SELECT 1 FROM learner_access_grants AS access_grant
             WHERE access_grant.user_id = attempt.user_id
               AND access_grant.certification_id = attempt.certification_id
               AND access_grant.feature = 'standard'
               AND access_grant.revoked_at IS NULL
               AND access_grant.starts_at <= ? AND access_grant.expires_at > ?
           )
           AND ${activeSessionSql("attempt")}
       )`,
    )
    .bind(
      attemptId,
      certificationId,
      examVersionId,
      question.questionId,
      question.revisionId,
      question.position,
      JSON.stringify(question.snapshot),
      attemptId,
      userId,
      certificationId,
      examVersionId,
      question.questionId,
      question.revisionId,
      now,
      now,
      tokenDigest,
      now,
    );
}

export async function startPracticeAttempt(
  database: SecurityDatabase,
  userId: string,
  tokenDigest: string,
  input: StartPracticeRequest,
  now: number,
): Promise<PracticeResult<PracticeAttemptResponse>> {
  const previous = await findAttemptByRequest(database, userId, input.requestId);
  if (previous) {
    if (
      previous.certification_id !== input.certificationId ||
      previous.exam_version_id !== input.examVersionId ||
      previous.question_count !== input.questionCount ||
      !sameFilters(previous.filters_json, input)
    ) {
      return { ok: false, reason: "conflict" };
    }
    const existing = await findAttempt(
      database,
      userId,
      tokenDigest,
      previous.id,
      now,
    );
    if (!existing) return { ok: false, reason: "access-required" };
    return { ok: true, value: await loadAttemptResponse(database, existing) };
  }

  if (
    !(await activeVersionExists(
      database,
      userId,
      tokenDigest,
      input.certificationId,
      input.examVersionId,
      now,
    ))
  ) {
    return { ok: false, reason: "access-required" };
  }
  if (input.domainId) {
    const domain = await database
      .prepare(
        `SELECT 1 AS valid FROM domains
         WHERE certification_id = ? AND exam_version_id = ? AND id = ?`,
      )
      .bind(input.certificationId, input.examVersionId, input.domainId)
      .first<{ valid: number }>();
    if (!domain) return { ok: false, reason: "not-found" };
  }

  const questions = groupQuestions(await selectQuestions(database, input));
  if (questions.length !== input.questionCount) {
    return { ok: false, reason: "insufficient-questions" };
  }
  const attemptId = crypto.randomUUID();
  const filters: AttemptFilters = {
    ...(input.domainId ? { domainId: input.domainId } : {}),
    ...(input.difficulty ? { difficulty: input.difficulty } : {}),
  };
  const createAttempt = database
    .prepare(
      `INSERT INTO practice_attempts (
         id, user_id, certification_id, exam_version_id, state,
         version, question_count, current_position, correct_count,
         filters_json, create_request_id, created_at, updated_at
       )
       SELECT ?, ?, ?, ?, 'creating', 1, ?, 0, 0, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM app_sessions AS session
         JOIN users AS user ON user.id = session.user_id
         JOIN learner_access_grants AS access_grant
           ON access_grant.user_id = session.user_id
          AND access_grant.certification_id = ?
          AND access_grant.feature = 'standard'
         WHERE session.token_digest = ?
           AND session.user_id = ?
           AND session.revoked_at IS NULL
           AND session.expires_at > ?
           AND user.status = 'active'
           AND access_grant.revoked_at IS NULL
           AND access_grant.starts_at <= ? AND access_grant.expires_at > ?
       )
       AND EXISTS (
         SELECT 1 FROM exam_versions
         WHERE certification_id = ? AND id = ?
       )`,
    )
    .bind(
      attemptId,
      userId,
      input.certificationId,
      input.examVersionId,
      input.questionCount,
      JSON.stringify(filters),
      input.requestId,
      now,
      now,
      input.certificationId,
      tokenDigest,
      userId,
      now,
      now,
      now,
      input.certificationId,
      input.examVersionId,
    );

  const statements = [
    createAttempt,
    ...questions.map((question) =>
      snapshotInsert(
        database,
        attemptId,
        userId,
        tokenDigest,
        input.certificationId,
        input.examVersionId,
        question,
        now,
      ),
    ),
    database
      .prepare(
        `UPDATE practice_attempts
         SET state = 'in_progress'
         WHERE id = ? AND state = 'creating'`,
      )
      .bind(attemptId),
  ];

  try {
    const results = await database.batch(statements);
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results[results.length - 1]?.meta.changes ?? 0) !== 1
    ) {
      const duplicate = await findAttemptByRequest(
        database,
        userId,
        input.requestId,
      );
      if (duplicate) {
        if (
          duplicate.certification_id !== input.certificationId ||
          duplicate.exam_version_id !== input.examVersionId ||
          duplicate.question_count !== input.questionCount ||
          !sameFilters(duplicate.filters_json, input)
        ) {
          return { ok: false, reason: "conflict" };
        }
        const accessible = await findAttempt(
          database,
          userId,
          tokenDigest,
          duplicate.id,
          now,
        );
        if (!accessible) return { ok: false, reason: "access-required" };
        return {
          ok: true,
          value: await loadAttemptResponse(database, accessible),
        };
      }
      return { ok: false, reason: "access-required" };
    }
  } catch (error) {
    const duplicate = await findAttemptByRequest(
      database,
      userId,
      input.requestId,
    );
    if (duplicate) {
      if (
        duplicate.certification_id !== input.certificationId ||
        duplicate.exam_version_id !== input.examVersionId ||
        duplicate.question_count !== input.questionCount ||
        !sameFilters(duplicate.filters_json, input)
      ) {
        return { ok: false, reason: "conflict" };
      }
      const accessible = await findAttempt(
        database,
        userId,
        tokenDigest,
        duplicate.id,
        now,
      );
      if (!accessible) return { ok: false, reason: "access-required" };
      return { ok: true, value: await loadAttemptResponse(database, accessible) };
    }
    throw new Error("Practice attempt transaction failed", { cause: error });
  }

  const created = await findAttempt(
    database,
    userId,
    tokenDigest,
    attemptId,
    now,
  );
  if (!created) throw new Error("Created practice attempt could not be read");
  return { ok: true, value: await loadAttemptResponse(database, created) };
}

export async function submitPracticeAnswer(
  database: SecurityDatabase,
  userId: string,
  tokenDigest: string,
  attemptId: string,
  input: PracticeAnswerRequest,
  now: number,
): Promise<PracticeResult<PracticeAttemptResponse>> {
  const attempt = await findAttempt(
    database,
    userId,
    tokenDigest,
    attemptId,
    now,
  );
  if (!attempt) {
    const owned = await database
      .prepare(
        "SELECT certification_id FROM practice_attempts WHERE id = ? AND user_id = ?",
      )
      .bind(attemptId, userId)
      .first<{ certification_id: string }>();
    return {
      ok: false,
      reason: owned ? "access-required" : "not-found",
    };
  }

  const existing = await database
    .prepare(
      `SELECT item_position, selected_option_key, result_version
       FROM practice_answer_events
       WHERE attempt_id = ? AND request_id = ?`,
    )
    .bind(attemptId, input.requestId)
    .first<{
      item_position: number;
      selected_option_key: string;
      result_version: number;
    }>();
  if (existing) {
    if (
      existing.selected_option_key !== input.selectedOptionKey ||
      existing.result_version !== input.expectedVersion + 1
    ) {
      return { ok: false, reason: "conflict" };
    }
    const replay = await findAttempt(
      database,
      userId,
      tokenDigest,
      attemptId,
      now,
    );
    if (!replay) return { ok: false, reason: "access-required" };
    return { ok: true, value: await loadAttemptResponse(database, replay) };
  }

  const inserted = await database
    .prepare(
      `INSERT INTO practice_answer_events (
         attempt_id, request_id, item_position, selected_option_key,
         is_correct, result_version, submitted_at
       )
       SELECT attempt.id, ?, attempt.current_position, ?,
              CASE WHEN json_extract(item.snapshot_json, '$.correctOptionKey') = ?
                   THEN 1 ELSE 0 END,
              attempt.version + 1, ?
       FROM practice_attempts AS attempt
       JOIN practice_attempt_items AS item
         ON item.attempt_id = attempt.id
        AND item.position = attempt.current_position
       WHERE attempt.id = ?
         AND attempt.user_id = ?
         AND attempt.state = 'in_progress'
         AND attempt.version = ?
         AND ${activeSessionSql("attempt")}
         AND ${activeGrantSql("attempt")}
         AND NOT EXISTS (
           SELECT 1 FROM practice_answer_events AS prior
           WHERE prior.attempt_id = attempt.id
             AND prior.request_id = ?
         )
         AND EXISTS (
           SELECT 1 FROM json_each(item.snapshot_json, '$.options') AS option
           WHERE json_extract(option.value, '$.key') = ?
         )`,
    )
    .bind(
      input.requestId,
      input.selectedOptionKey,
      input.selectedOptionKey,
      now,
      attemptId,
      userId,
      input.expectedVersion,
      tokenDigest,
      now,
      now,
      now,
      input.requestId,
      input.selectedOptionKey,
    )
    .all<{ attempt_id: string }>();

  if (inserted.results.length === 0) {
    const raced = await database
      .prepare(
        `SELECT selected_option_key, result_version
         FROM practice_answer_events
         WHERE attempt_id = ? AND request_id = ?`,
      )
      .bind(attemptId, input.requestId)
      .first<{ selected_option_key: string; result_version: number }>();
    if (
      !raced ||
      raced.selected_option_key !== input.selectedOptionKey ||
      raced.result_version !== input.expectedVersion + 1
    ) {
      return { ok: false, reason: "conflict" };
    }
  }

  const updated = await findAttempt(
    database,
    userId,
    tokenDigest,
    attemptId,
    now,
  );
  if (!updated) return { ok: false, reason: "access-required" };
  return { ok: true, value: await loadAttemptResponse(database, updated) };
}
