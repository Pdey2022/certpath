import {
  evaluateReadiness,
  isReadinessCurrent,
  readinessFormulaVersion,
  type BlueprintDomain,
  type ReadinessInput,
  type ReadinessMock,
  type ReadinessMockDomain,
  type ReadinessNextAction,
  type ReadinessSnapshot,
} from "../readiness.ts";
import type { SecurityDatabase } from "./database.ts";

export type ReadinessScope = {
  userId: string;
  certificationId: string;
  examVersionId: string;
};

type MockRow = {
  id: string;
  correct_count: number;
  question_count: number;
  completed_at: number;
};

type DomainRow = {
  attempt_id: string;
  domain_id: string;
  total: number;
  correct: number;
};

type CountRow = { total: number };

type SnapshotRow = {
  band: ReadinessSnapshot["band"];
  score: number;
  is_ready: number;
  basis_json: string;
  next_action_json: string | null;
  computed_at: number;
};

export type StoredReadiness = {
  band: ReadinessSnapshot["band"];
  score: number;
  isReady: boolean;
  basis: ReadinessSnapshot["basis"];
  nextAction: ReadinessNextAction | null;
  computedAt: number;
  isCurrent: boolean;
};

/** Loads exactly what readiness v1 needs, from stored attempts only. */
export async function loadReadinessInput(
  database: SecurityDatabase,
  scope: ReadinessScope,
): Promise<ReadinessInput> {
  const mocks = await database
    .prepare(
      `SELECT id, correct_count, question_count, completed_at
       FROM timed_mock_attempts
       WHERE user_id = ? AND certification_id = ? AND exam_version_id = ?
         AND state = 'completed' AND completed_at IS NOT NULL
       ORDER BY completed_at DESC, id DESC
       LIMIT 3`,
    )
    .bind(scope.userId, scope.certificationId, scope.examVersionId)
    .all<MockRow>();

  const domainRows =
    mocks.results.length === 0
      ? { results: [] as DomainRow[] }
      : await database
          .prepare(
            `SELECT item.attempt_id, revision.domain_id,
                    COUNT(*) AS total,
                    COALESCE(SUM(answer.is_correct), 0) AS correct
             FROM timed_mock_items AS item
             JOIN question_revisions AS revision
               ON revision.id = item.question_revision_id
             LEFT JOIN timed_mock_answers AS answer
               ON answer.attempt_id = item.attempt_id
              AND answer.position = item.position
             WHERE item.attempt_id IN (${mocks.results.map(() => "?").join(", ")})
             GROUP BY item.attempt_id, revision.domain_id`,
          )
          .bind(...mocks.results.map((mock) => mock.id))
          .all<DomainRow>();

  const domainsByAttempt = new Map<string, ReadinessMockDomain[]>();
  for (const row of domainRows.results) {
    const list = domainsByAttempt.get(row.attempt_id) ?? [];
    list.push({
      domainId: row.domain_id,
      correct: row.correct,
      total: row.total,
    });
    domainsByAttempt.set(row.attempt_id, list);
  }

  const mockResults: ReadinessMock[] = mocks.results.map((mock) => ({
    attemptId: mock.id,
    completedAt: mock.completed_at,
    correct: mock.correct_count,
    total: mock.question_count,
    domains: domainsByAttempt.get(mock.id) ?? [],
  }));

  const [answered, published, blueprint] = await Promise.all([
    database
      .prepare(
        `SELECT COUNT(*) AS total FROM (
           SELECT item.question_id
           FROM practice_attempt_items AS item
           JOIN practice_attempts AS attempt ON attempt.id = item.attempt_id
           JOIN practice_answer_events AS event
             ON event.attempt_id = item.attempt_id
            AND event.item_position = item.position
           WHERE attempt.user_id = ? AND item.certification_id = ?
             AND item.exam_version_id = ?
           UNION
           SELECT item.question_id
           FROM timed_mock_items AS item
           JOIN timed_mock_attempts AS attempt ON attempt.id = item.attempt_id
           JOIN timed_mock_answers AS answer
             ON answer.attempt_id = item.attempt_id
            AND answer.position = item.position
           WHERE attempt.user_id = ? AND item.certification_id = ?
             AND item.exam_version_id = ?
         )`,
      )
      .bind(
        scope.userId,
        scope.certificationId,
        scope.examVersionId,
        scope.userId,
        scope.certificationId,
        scope.examVersionId,
      )
      .first<CountRow>(),
    database
      .prepare(
        `SELECT COUNT(*) AS total FROM exam_version_questions
         WHERE certification_id = ? AND exam_version_id = ?
           AND publication_state = 'published'`,
      )
      .bind(scope.certificationId, scope.examVersionId)
      .first<CountRow>(),
    database
      .prepare(
        `SELECT revision.domain_id, domain.title,
                COUNT(*) AS published_questions
         FROM exam_version_questions AS published
         JOIN question_revisions AS revision
           ON revision.id = published.question_revision_id
         JOIN domains AS domain
           ON domain.id = revision.domain_id
          AND domain.certification_id = published.certification_id
          AND domain.exam_version_id = published.exam_version_id
         WHERE published.certification_id = ? AND published.exam_version_id = ?
           AND published.publication_state = 'published'
         GROUP BY revision.domain_id, domain.title, domain.display_order
         ORDER BY domain.display_order, revision.domain_id`,
      )
      .bind(scope.certificationId, scope.examVersionId)
      .all<{
        domain_id: string;
        title: string;
        published_questions: number;
      }>(),
  ]);

  const domains: BlueprintDomain[] = blueprint.results.map((row) => ({
    domainId: row.domain_id,
    title: row.title,
    publishedQuestions: row.published_questions,
  }));

  return {
    mocks: mockResults,
    coverage: {
      answeredQuestions: answered?.total ?? 0,
      publishedQuestions: published?.total ?? 0,
    },
    blueprint: domains,
  };
}

/**
 * Computes readiness from stored attempts and appends it as evidence.
 *
 * Idempotent per completed mock: re-observing the same attempt cannot append a
 * second snapshot.
 */
export async function recordReadinessSnapshot(
  database: SecurityDatabase,
  scope: ReadinessScope,
  options: { now: number; sourceAttemptId: string | null },
): Promise<ReadinessSnapshot> {
  const input = await loadReadinessInput(database, scope);
  const snapshot = evaluateReadiness(input);

  await database
    .prepare(
      `INSERT INTO readiness_snapshots (
         id, user_id, certification_id, exam_version_id, formula_version,
         band, score, is_ready, mocks_count, questions_count, basis_json,
         next_action_json, source_attempt_id, computed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_attempt_id) DO NOTHING`,
    )
    .bind(
      crypto.randomUUID(),
      scope.userId,
      scope.certificationId,
      scope.examVersionId,
      readinessFormulaVersion,
      snapshot.band,
      snapshot.score,
      snapshot.isReady ? 1 : 0,
      snapshot.basis.mocks,
      snapshot.basis.questions,
      JSON.stringify(snapshot.basis),
      snapshot.nextAction === null ? null : JSON.stringify(snapshot.nextAction),
      options.sourceAttemptId,
      options.now,
    )
    .run();

  return snapshot;
}

/**
 * Records readiness for a just-completed mock. Resolves the scope from the
 * attempt so completion paths do not have to carry it around.
 */
export async function recordReadinessForAttempt(
  database: SecurityDatabase,
  attemptId: string,
  now: number,
): Promise<void> {
  const attempt = await database
    .prepare(
      `SELECT user_id, certification_id, exam_version_id
       FROM timed_mock_attempts
       WHERE id = ? AND state = 'completed'`,
    )
    .bind(attemptId)
    .first<{
      user_id: string;
      certification_id: string;
      exam_version_id: string;
    }>();
  if (!attempt) return;

  await recordReadinessSnapshot(
    database,
    {
      userId: attempt.user_id,
      certificationId: attempt.certification_id,
      examVersionId: attempt.exam_version_id,
    },
    { now, sourceAttemptId: attemptId },
  );
}

/** The most recent snapshot for a scope, with its decay state resolved. */export async function loadLatestReadiness(
  database: SecurityDatabase,
  scope: ReadinessScope,
  now: number,
): Promise<StoredReadiness | null> {
  const row = await database
    .prepare(
      `SELECT band, score, is_ready, basis_json, next_action_json, computed_at
       FROM readiness_snapshots
       WHERE user_id = ? AND certification_id = ? AND exam_version_id = ?
       ORDER BY computed_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(scope.userId, scope.certificationId, scope.examVersionId)
    .first<SnapshotRow>();
  if (!row) return null;

  return {
    band: row.band,
    score: row.score,
    isReady: row.is_ready === 1,
    basis: JSON.parse(row.basis_json) as ReadinessSnapshot["basis"],
    nextAction: row.next_action_json === null
      ? null
      : (JSON.parse(row.next_action_json) as ReadinessNextAction),
    computedAt: row.computed_at,
    isCurrent: isReadinessCurrent(row.computed_at, now),
  };
}
