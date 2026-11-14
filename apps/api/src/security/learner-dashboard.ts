import type { LearnerDashboardResponse } from "@certpath/contracts";
import {
  can,
  evaluateAccess,
  graceDaysRemaining,
  type AccessGrantRecord,
} from "../entitlements.ts";
import { proMinimumStandardDays, proOffered } from "../pricing.ts";
import type { SecurityDatabase } from "./database.ts";
import { loadLatestReadiness } from "./readiness-snapshots.ts";

interface ScopeRow {
  certification_id: string;
  certification_name: string;
  exam_version_id: string;
  version_key: string;
  exam_version_title: string;
}

interface GrantRow {
  certification_id: string;
  feature: "standard" | "pro";
  starts_at: number;
  expires_at: number;
  revoked_at: number | null;
}

const dayMs = 86_400_000;

interface DashboardAttemptRow {
  certification_id: string;
  exam_version_id: string;
  id: string;
  kind: "practice" | "timed_mock";
  state: "in_progress" | "completed";
  question_count: number;
  answered_count: number;
  current_position: number;
  correct_count: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  deadline_at: number | null;
  completion_reason: "learner_submitted" | "timed_out" | null;
}

const activeAccessSql = `
  EXISTS (
    SELECT 1 FROM learner_access_grants AS grant_record
    WHERE grant_record.user_id = attempt.user_id
      AND grant_record.certification_id = attempt.certification_id
      AND grant_record.feature = 'standard'
      AND grant_record.revoked_at IS NULL
      AND grant_record.starts_at <= ?
      AND grant_record.expires_at > ?
  )
  AND EXISTS (
    SELECT 1 FROM app_sessions AS active_session
    JOIN users AS active_user ON active_user.id = active_session.user_id
    WHERE active_session.token_digest = ?
      AND active_session.user_id = attempt.user_id
      AND active_session.revoked_at IS NULL
      AND active_session.expires_at > ?
      AND active_user.status = 'active'
  )`;

function dashboardQuery(kind: "practice" | "timed_mock"): string {
  const isPractice = kind === "practice";
  const attemptTable = isPractice ? "practice_attempts" : "timed_mock_attempts";
  const answerTable = isPractice ? "practice_answer_events" : "timed_mock_answers";
  const deadlineColumn = isPractice ? "NULL AS deadline_at" : "attempt.deadline_at";
  const completionReasonColumn = isPractice
    ? "NULL AS completion_reason"
    : "attempt.completion_reason";
  return `WITH in_progress AS (
    SELECT attempt.certification_id, attempt.exam_version_id, attempt.id,
           '${kind}' AS kind, attempt.state, attempt.question_count,
           (SELECT COUNT(*) FROM ${answerTable} AS answer
            WHERE answer.attempt_id = attempt.id) AS answered_count,
           attempt.current_position, NULL AS correct_count,
           attempt.created_at, attempt.updated_at, attempt.completed_at,
           ${deadlineColumn}, ${completionReasonColumn}
    FROM ${attemptTable} AS attempt
    WHERE attempt.user_id = ?
      AND attempt.state = 'in_progress'
      AND ${activeAccessSql}
    ORDER BY attempt.updated_at DESC, attempt.id DESC
    LIMIT 20
  ), completed AS (
    SELECT attempt.certification_id, attempt.exam_version_id, attempt.id,
           '${kind}' AS kind, attempt.state, attempt.question_count,
           (SELECT COUNT(*) FROM ${answerTable} AS answer
            WHERE answer.attempt_id = attempt.id) AS answered_count,
           attempt.current_position, attempt.correct_count,
           attempt.created_at, attempt.updated_at, attempt.completed_at,
           ${deadlineColumn}, ${completionReasonColumn}
    FROM ${attemptTable} AS attempt
    WHERE attempt.user_id = ?
      AND attempt.state = 'completed'
      AND ${activeAccessSql}
    ORDER BY COALESCE(attempt.completed_at, attempt.updated_at) DESC,
             attempt.id DESC
    LIMIT 20
  )
  SELECT certification_id, exam_version_id, id, kind, state, question_count,
         answered_count, current_position, correct_count, created_at,
         updated_at, completed_at, deadline_at, completion_reason
  FROM (
    SELECT * FROM in_progress
    UNION ALL
    SELECT * FROM completed
  )
  ORDER BY CASE WHEN state = 'in_progress' THEN 0 ELSE 1 END,
           COALESCE(completed_at, updated_at) DESC, id DESC`;
}

function bindDashboardQuery(
  database: SecurityDatabase,
  kind: "practice" | "timed_mock",
  userId: string,
  tokenDigest: string,
  now: number,
) {
  return database
    .prepare(dashboardQuery(kind))
    .bind(
      userId,
      now,
      now,
      tokenDigest,
      now,
      userId,
      now,
      now,
      tokenDigest,
      now,
    );
}

export async function getLearnerDashboard(
  database: SecurityDatabase,
  userId: string,
  tokenDigest: string,
  now: number,
): Promise<LearnerDashboardResponse> {
  // Scopes come from any live grant: a learner in grace still sees the exam,
  // with a renewal prompt and no attempt history (ADR 0005).
  const scopes = await database
    .prepare(
      `SELECT DISTINCT certification.id AS certification_id,
              certification.display_name AS certification_name,
              version.id AS exam_version_id,
              version.version_key, version.title AS exam_version_title
       FROM learner_access_grants AS grant_record
       JOIN certifications AS certification
         ON certification.id = grant_record.certification_id
       JOIN exam_versions AS version
         ON version.certification_id = grant_record.certification_id
       WHERE grant_record.user_id = ?
         AND grant_record.revoked_at IS NULL
         AND EXISTS (
           SELECT 1 FROM app_sessions AS active_session
           JOIN users AS active_user ON active_user.id = active_session.user_id
           WHERE active_session.token_digest = ?
             AND active_session.user_id = grant_record.user_id
             AND active_session.revoked_at IS NULL
             AND active_session.expires_at > ?
             AND active_user.status = 'active'
         )
       ORDER BY certification.display_name, version.version_key
       LIMIT 201`,
    )
    .bind(userId, tokenDigest, now)
    .all<ScopeRow>();
  if (scopes.results.length > 200) {
    throw new Error("Authorized learner dashboard scopes exceed their response bound");
  }

  const grants = await database
    .prepare(
      `SELECT certification_id, feature, starts_at, expires_at, revoked_at
       FROM learner_access_grants
       WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .bind(userId)
    .all<GrantRow>();
  const grantsByCertification = new Map<string, AccessGrantRecord[]>();
  for (const grant of grants.results) {
    const list = grantsByCertification.get(grant.certification_id) ?? [];
    list.push({
      feature: grant.feature,
      startsAt: grant.starts_at,
      expiresAt: grant.expires_at,
      revokedAt: grant.revoked_at,
    });
    grantsByCertification.set(grant.certification_id, list);
  }

  const [practice, timedMocks] = await Promise.all([
    bindDashboardQuery(database, "practice", userId, tokenDigest, now)
      .all<DashboardAttemptRow>(),
    bindDashboardQuery(database, "timed_mock", userId, tokenDigest, now)
      .all<DashboardAttemptRow>(),
  ]);
  const groups = new Map<
    string,
    LearnerDashboardResponse["groups"][number]
  >();
  for (const scope of scopes.results) {
    const access = evaluateAccess(
      grantsByCertification.get(scope.certification_id) ?? [],
      now,
    );
    // Read access is what the dashboard itself needs; grace grants that, an
    // expired membership does not.
    if (!can(access, "results")) continue;
    groups.set(`${scope.certification_id}\n${scope.exam_version_id}`, {
      certificationId: scope.certification_id,
      certificationName: scope.certification_name,
      examVersionId: scope.exam_version_id,
      versionKey: scope.version_key,
      examVersionTitle: scope.exam_version_title,
      access: {
        state: access.standard.state,
        endsAt: access.standard.endsAt,
        graceEndsAt: access.standard.graceEndsAt,
        graceDaysRemaining: graceDaysRemaining(access.standard, now),
      },
      readiness: null,
      resumable: [],
      completed: [],
    });
  }

  for (const row of [...practice.results, ...timedMocks.results]) {
    const group = groups.get(`${row.certification_id}\n${row.exam_version_id}`);
    if (!group) continue;
    const summary = {
      id: row.id,
      kind: row.kind,
      state: row.state,
      questionCount: row.question_count,
      answeredCount: row.answered_count,
      currentPosition: row.current_position,
      ...(row.correct_count !== null ? { correctCount: row.correct_count } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      ...(row.deadline_at !== null ? { deadlineAt: row.deadline_at } : {}),
      ...(row.kind === "timed_mock"
        ? { completionReason: row.completion_reason }
        : {}),
    };
    if (row.state === "in_progress") group.resumable.push(summary);
    else group.completed.push(summary);
  }

  for (const group of groups.values()) {
    group.resumable.sort((left, right) => {
      const byKind = left.kind.localeCompare(right.kind);
      return byKind || right.updatedAt - left.updatedAt;
    });
    group.completed.sort(
      (left, right) =>
        (right.completedAt ?? right.updatedAt) -
        (left.completedAt ?? left.updatedAt),
    );
  }

  // Readiness and the Pro prompt are read-only projections of stored snapshots;
  // the dashboard never computes or writes readiness itself.
  await Promise.all(
    [...groups.values()].map(async (group) => {
      const stored = await loadLatestReadiness(
        database,
        {
          userId,
          certificationId: group.certificationId,
          examVersionId: group.examVersionId,
        },
        now,
      );
      if (!stored) return;
      const standardRemainingDays =
        group.access.state === "active" && group.access.endsAt !== null
          ? Math.floor((group.access.endsAt - now) / dayMs)
          : 0;
      group.readiness = {
        band: stored.band,
        score: stored.score,
        isReady: stored.isReady,
        isCurrent: stored.isCurrent,
        computedAt: stored.computedAt,
        basis: stored.basis,
        nextAction: stored.nextAction,
        proPrompt:
          stored.isCurrent &&
          stored.isReady &&
          proOffered(group.certificationId) &&
          standardRemainingDays >= proMinimumStandardDays,
      };
    }),
  );

  return { groups: [...groups.values()] };
}
