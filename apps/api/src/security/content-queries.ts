import type { D1Value, SecurityDatabase } from "./database.ts";
import { createScopeGuard } from "./content.ts";
import type { StaffMfaPolicy } from "./mfa.ts";

export interface ContentPageInput {
  certificationId: string;
  tokenDigest: string;
  now: number;
  policy: StaffMfaPolicy;
  cursor?: string;
  pageSize: number;
}

export interface QuestionPageInput extends ContentPageInput {
  examVersionId: string;
  domainId: string;
  topicId: string;
  search?: string;
}

export interface QuestionRevisionPageInput extends ContentPageInput {
  examVersionId: string;
  questionId: string;
}

interface PageRow {
  id: string;
}

function pageResult<T extends PageRow>(
  rows: T[],
  pageSize: number,
): { items: T[]; nextCursor: string | null } {
  const hasNext = rows.length > pageSize;
  const items = rows.slice(0, pageSize);
  return {
    items,
    nextCursor: hasNext ? items.at(-1)?.id ?? null : null,
  };
}

function pageClause(cursor: string | undefined, idColumn = "row.id"): string {
  return cursor ? `AND ${idColumn} > ?` : "";
}

function pageValues(
  input: ContentPageInput,
  guardValues: D1Value[],
): D1Value[] {
  return [
    input.certificationId,
    ...guardValues,
    ...(input.cursor ? [input.cursor] : []),
    input.pageSize + 1,
  ];
}

export async function listAuthorizedCertifications(
  database: SecurityDatabase,
  tokenDigest: string,
  now: number,
  policy: StaffMfaPolicy,
  page: { cursor?: string; pageSize: number },
): Promise<{
  items: Array<{ id: string; slug: string; displayName: string }>;
  nextCursor: string | null;
}> {
  const methods = policy.allowedMethods.map(() => "?").join(", ");
  const session = database.withSession("first-primary");
  const result = await session
    .prepare(
      `SELECT certification.id,
             certification.slug,
             certification.display_name AS displayName
       FROM certifications AS certification
       WHERE EXISTS (
         SELECT 1
         FROM app_sessions AS scope_session
         JOIN users AS scope_user ON scope_user.id = scope_session.user_id
         JOIN staff_roles AS scope_role ON scope_role.user_id = scope_user.id
         WHERE scope_session.token_digest = ?
           AND scope_session.revoked_at IS NULL
           AND scope_session.expires_at > ?
           AND scope_user.status = 'active'
           AND scope_role.active = 1
           AND scope_session.mfa_verified_at BETWEEN ? AND ?
           AND scope_session.mfa_method IN (${methods})
           AND (
             scope_role.role = 'global_admin'
             OR (
               scope_role.role = 'manager'
               AND EXISTS (
                 SELECT 1 FROM manager_certification_assignments AS assignment
                 WHERE assignment.manager_user_id = scope_user.id
                   AND assignment.certification_id = certification.id
                   AND assignment.active = 1
               )
             )
           )
       )
         ${pageClause(page.cursor, "certification.id")}
       ORDER BY certification.id LIMIT ?`,
    )
    .bind(
      tokenDigest,
      now,
      now - policy.maxAgeMs,
      now,
      ...policy.allowedMethods,
      ...(page.cursor ? [page.cursor] : []),
      page.pageSize + 1,
    )
    .all<{ id: string; slug: string; displayName: string }>();
  return pageResult(result.results, page.pageSize);
}

export async function listExamVersions(
  database: SecurityDatabase,
  input: ContentPageInput,
): Promise<{
  items: Array<{ id: string; versionKey: string; title: string }>;
  nextCursor: string | null;
}> {
  const guard = createScopeGuard(
    input.tokenDigest,
    input.certificationId,
    input.now,
    input.policy,
  );
  const result = await database
    .withSession("first-primary")
    .prepare(
      `SELECT row.id, row.version_key AS versionKey, row.title
       FROM exam_versions AS row
       WHERE row.certification_id = ?
         AND ${guard.sql}
         ${pageClause(input.cursor)}
       ORDER BY row.id LIMIT ?`,
    )
    .bind(...pageValues(input, guard.values))
    .all<{ id: string; versionKey: string; title: string }>();
  return pageResult(result.results, input.pageSize);
}

export async function listDomains(
  database: SecurityDatabase,
  input: ContentPageInput & { examVersionId: string },
): Promise<{
  items: Array<{ id: string; domainKey: string; title: string; order: number }>;
  nextCursor: string | null;
}> {
  const guard = createScopeGuard(
    input.tokenDigest,
    input.certificationId,
    input.now,
    input.policy,
  );
  const result = await database
    .withSession("first-primary")
    .prepare(
      `SELECT row.id, row.domain_key AS domainKey, row.title,
              row.display_order AS "order"
       FROM domains AS row
       WHERE row.certification_id = ? AND row.exam_version_id = ?
         AND ${guard.sql}
         ${pageClause(input.cursor)}
       ORDER BY row.id LIMIT ?`,
    )
    .bind(
      input.certificationId,
      input.examVersionId,
      ...guard.values,
      ...(input.cursor ? [input.cursor] : []),
      input.pageSize + 1,
    )
    .all<{ id: string; domainKey: string; title: string; order: number }>();
  return pageResult(result.results, input.pageSize);
}

export async function listTopics(
  database: SecurityDatabase,
  input: ContentPageInput & { examVersionId: string; domainId: string },
): Promise<{
  items: Array<{ id: string; topicKey: string; title: string; order: number }>;
  nextCursor: string | null;
}> {
  const guard = createScopeGuard(
    input.tokenDigest,
    input.certificationId,
    input.now,
    input.policy,
  );
  const result = await database
    .withSession("first-primary")
    .prepare(
      `SELECT row.id, row.topic_key AS topicKey, row.title,
              row.display_order AS "order"
       FROM topics AS row
       WHERE row.certification_id = ?
         AND row.exam_version_id = ? AND row.domain_id = ?
         AND ${guard.sql}
         ${pageClause(input.cursor)}
       ORDER BY row.id LIMIT ?`,
    )
    .bind(
      input.certificationId,
      input.examVersionId,
      input.domainId,
      ...guard.values,
      ...(input.cursor ? [input.cursor] : []),
      input.pageSize + 1,
    )
    .all<{ id: string; topicKey: string; title: string; order: number }>();
  return pageResult(result.results, input.pageSize);
}

export async function listQuestions(
  database: SecurityDatabase,
  input: QuestionPageInput,
): Promise<{
  items: Array<{
    id: string;
    questionKey: string;
    currentRevisionId: string;
    revisionNumber: number;
    lockVersion: number;
    stem: string;
    workflowState: string;
  }>;
  nextCursor: string | null;
}> {
  const guard = createScopeGuard(
    input.tokenDigest,
    input.certificationId,
    input.now,
    input.policy,
  );
  const search = input.search?.replace(/[\\%_]/g, "\\$&");
  const result = await database
    .withSession("first-primary")
    .prepare(
      `SELECT question.id,
              question.question_key AS questionKey,
              revision.id AS currentRevisionId,
              revision.revision_number AS revisionNumber,
              question.lock_version AS lockVersion,
              substr(revision.stem, 1, 200) AS stem,
              COALESCE((
                SELECT event.event_type
                FROM question_revision_events AS event
                WHERE event.question_revision_id = revision.id
                ORDER BY event.sequence_number DESC LIMIT 1
              ), 'draft') AS workflowState
       FROM questions AS question
       JOIN question_revisions AS revision
         ON revision.question_id = question.id
        AND revision.revision_number = question.lock_version
       WHERE question.certification_id = ?
         AND revision.exam_version_id = ?
         AND revision.domain_id = ?
         AND revision.topic_id = ?
         AND ${guard.sql}
         AND (? IS NULL OR question.question_key LIKE ? ESCAPE '\\'
              OR revision.stem LIKE ? ESCAPE '\\')
         ${pageClause(input.cursor, "question.id")}
       ORDER BY question.id LIMIT ?`,
    )
    .bind(
      input.certificationId,
      input.examVersionId,
      input.domainId,
      input.topicId,
      ...guard.values,
      search ? `%${search}%` : null,
      search ? `%${search}%` : null,
      search ? `%${search}%` : null,
      ...(input.cursor ? [input.cursor] : []),
      input.pageSize + 1,
    )
    .all<{
      id: string;
      questionKey: string;
      currentRevisionId: string;
      revisionNumber: number;
      lockVersion: number;
      stem: string;
      workflowState: string;
    }>();
  return pageResult(result.results, input.pageSize);
}

export async function listQuestionRevisions(
  database: SecurityDatabase,
  input: QuestionRevisionPageInput,
): Promise<{
  items: Array<{
    id: string;
    revisionNumber: number;
    workflowState: string;
    createdAt: number;
  }>;
  nextCursor: string | null;
}> {
  const guard = createScopeGuard(
    input.tokenDigest,
    input.certificationId,
    input.now,
    input.policy,
  );
  const cursorClause = input.cursor
    ? `AND (
         revision.revision_number < (
           SELECT cursor_revision.revision_number
           FROM question_revisions AS cursor_revision
           WHERE cursor_revision.id = ?
             AND cursor_revision.question_id = revision.question_id
         )
         OR (
           revision.revision_number = (
             SELECT cursor_revision.revision_number
             FROM question_revisions AS cursor_revision
             WHERE cursor_revision.id = ?
               AND cursor_revision.question_id = revision.question_id
           )
           AND revision.id < ?
         )
       )`
    : "";
  const result = await database
    .withSession("first-primary")
    .prepare(
      `SELECT revision.id,
              revision.revision_number AS revisionNumber,
              revision.created_at AS createdAt,
              COALESCE((
                SELECT event.event_type
                FROM question_revision_events AS event
                WHERE event.question_revision_id = revision.id
                ORDER BY event.sequence_number DESC LIMIT 1
              ), 'draft') AS workflowState
       FROM question_revisions AS revision
       WHERE revision.certification_id = ?
         AND revision.exam_version_id = ?
         AND revision.question_id = ?
         AND ${guard.sql}
         ${cursorClause}
       ORDER BY revision.revision_number DESC, revision.id DESC LIMIT ?`,
    )
    .bind(
      input.certificationId,
      input.examVersionId,
      input.questionId,
      ...guard.values,
      ...(input.cursor ? [input.cursor, input.cursor, input.cursor] : []),
      input.pageSize + 1,
    )
    .all<{
      id: string;
      revisionNumber: number;
      workflowState: string;
      createdAt: number;
    }>();
  return pageResult(result.results, input.pageSize);
}

export async function getQuestionPublication(
    database: SecurityDatabase,
    input: Omit<ContentPageInput, "cursor" | "pageSize"> & {
      examVersionId: string;
      questionId: string;
    },
): Promise<{
    questionId: string;
    publication: {
      revisionId: string;
      state: "published" | "retired";
      pointerVersion: number;
      changedAt: number;
    } | null;
} | null> {
    const guard = createScopeGuard(
      input.tokenDigest,
      input.certificationId,
      input.now,
      input.policy,
    );
    const row = await database
      .withSession("first-primary")
      .prepare(
        `SELECT question.id AS questionId,
                pointer.question_revision_id AS revisionId,
                pointer.publication_state AS state,
                pointer.lock_version AS pointerVersion,
                pointer.changed_at AS changedAt
         FROM questions AS question
         LEFT JOIN exam_version_questions AS pointer
           ON pointer.certification_id = question.certification_id
          AND pointer.exam_version_id = ?
          AND pointer.question_id = question.id
         WHERE question.certification_id = ?
           AND question.id = ?
           AND EXISTS (
             SELECT 1 FROM question_revisions AS revision
             WHERE revision.certification_id = question.certification_id
               AND revision.exam_version_id = ?
               AND revision.question_id = question.id
           )
           AND ${guard.sql}`,
      )
      .bind(
        input.examVersionId,
        input.certificationId,
        input.questionId,
        input.examVersionId,
        ...guard.values,
      )
      .first<{
        questionId: string;
        revisionId: string | null;
        state: "published" | "retired" | null;
        pointerVersion: number | null;
        changedAt: number | null;
      }>();
    if (!row) return null;
    if (
      row.revisionId === null ||
      row.state === null ||
      row.pointerVersion === null ||
      row.changedAt === null
    ) {
      return { questionId: row.questionId, publication: null };
    }
    return {
      questionId: row.questionId,
      publication: {
        revisionId: row.revisionId,
        state: row.state,
        pointerVersion: row.pointerVersion,
        changedAt: row.changedAt,
      },
    };
}
