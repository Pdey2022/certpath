import type {
  AuthorizationFailure,
  AuthorizationResult,
} from "./repository.ts";
import { authorizeCertification } from "./repository.ts";
import type {
  D1PreparedStatement,
  D1Value,
  SecurityDatabase,
} from "./database.ts";
import { isValidTokenDigest } from "./database.ts";
import type { StaffMfaPolicy } from "./mfa.ts";
import { isConfiguredMfaPolicy } from "./mfa.ts";
import type { MutationMetadata } from "./mutations.ts";

export type ContentFailure =
  | AuthorizationFailure
  | "invalid-input"
  | "not-found"
  | "conflict";

export type ContentResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ContentFailure };

export interface QuestionOptionInput {
  key: string;
  text: string;
  correct: boolean;
  explanation: string;
}

export interface QuestionContentInput {
  stem: string;
  difficulty: "easy" | "medium" | "hard";
  sourceReference: string;
  licenseReference: string;
  options: QuestionOptionInput[];
}

export interface QuestionContent {
  revisionId: string;
  questionId: string;
  certificationId: string;
  examVersionId: string;
  domainId: string;
  topicId: string;
  revisionNumber: number;
  lockVersion: number;
  stem: string;
  difficulty: "easy" | "medium" | "hard";
  sourceReference: string;
  licenseReference: string;
  workflowState: string;
  options: Array<{
    key: string;
    order: number;
    text: string;
    correct: boolean;
    explanation: string;
  }>;
}

export interface ScopeGuard {
  sql: string;
  values: D1Value[];
}

export interface NormalizedQuestionContent {
  stem: string;
  difficulty: "easy" | "medium" | "hard";
  sourceReference: string;
  licenseReference: string;
  options: QuestionOptionInput[];
}

interface CopySource {
  certificationId: string;
  questionId: string;
  revisionId: string;
  reason: string;
}

export interface CreateQuestionInput {
  certificationId: string;
  examVersionId: string;
  domainId: string;
  topicId: string;
  questionKey: string;
  content: QuestionContentInput;
  source?: CopySource;
}

function isId(value: string): boolean {
  return /^[a-zA-Z0-9:_-]{1,128}$/.test(value);
}

function isKey(value: string, maximum = 80): boolean {
  return (
    value.length > 0 &&
    value.length <= maximum &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value)
  );
}

function isBoundedText(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length >= minimum &&
    value.trim().length <= maximum
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDifficulty(
  value: unknown,
): value is QuestionContentInput["difficulty"] {
  return value === "easy" || value === "medium" || value === "hard";
}

export function normalizeQuestionContent(
  value: unknown,
): NormalizedQuestionContent | null {
  if (!isRecord(value)) return null;
  const optionsInput = value["options"];
  if (
    !isBoundedText(value["stem"], 5, 4000) ||
    !isDifficulty(value["difficulty"]) ||
    !isBoundedText(value["sourceReference"], 1, 1000) ||
    !isBoundedText(value["licenseReference"], 1, 200) ||
    !Array.isArray(optionsInput) ||
    optionsInput.length < 2 ||
    optionsInput.length > 8
  ) {
    return null;
  }

  const keys = new Set<string>();
  const options: QuestionOptionInput[] = [];
  let correctCount = 0;
  for (const option of optionsInput) {
    if (!isRecord(option)) return null;
    const key = option["key"];
    const text = option["text"];
    const explanation = option["explanation"];
    const correct = option["correct"];
    if (
      typeof key !== "string" ||
      !isKey(key, 32) ||
      !isBoundedText(text, 1, 1000) ||
      !isBoundedText(explanation, 1, 3000) ||
      typeof correct !== "boolean" ||
      keys.has(key)
    ) {
      return null;
    }
    keys.add(key);
    if (correct) correctCount += 1;
    options.push({
      key,
      text: text.trim(),
      correct,
      explanation: explanation.trim(),
    });
  }
  if (correctCount !== 1) return null;

  return {
    stem: value["stem"].trim(),
    difficulty: value["difficulty"],
    sourceReference: value["sourceReference"].trim(),
    licenseReference: value["licenseReference"].trim(),
    options,
  };
}

function createOptionInput(options: QuestionOptionInput[]): {
  sql: string;
  values: D1Value[];
} {
  return {
    sql: options.map(() => "(?, ?, ?, ?, ?)").join(", "),
    values: options.flatMap((option, index) => [
      option.key,
      index + 1,
      option.text,
      option.correct ? 1 : 0,
      option.explanation,
    ]),
  };
}

function createOptionConstructionInsert(
  database: SecurityDatabase,
  operationId: string,
  questionId: string,
  questionOperationId: string | null,
  requiresProvenance: boolean,
  options: QuestionOptionInput[],
): D1PreparedStatement {
  const optionInput = createOptionInput(options);
  return database
    .prepare(
      `WITH option_input(option_key, option_order, option_text, is_correct, explanation)
       AS (VALUES ${optionInput.sql})
       INSERT INTO question_option_construction (
         operation_id, question_id, question_operation_id,
         requires_provenance, option_key,
         option_order, option_text, is_correct, explanation
       )
       SELECT ?, ?, ?, ?, option_key, option_order, option_text, is_correct, explanation
       FROM option_input
       WHERE EXISTS (
         SELECT 1 FROM questions AS question
         WHERE question.id = ?
           AND (? IS NULL OR question.created_operation_id = ?)
       )
       RETURNING operation_id`,
    )
    .bind(
      ...optionInput.values,
      operationId,
      questionId,
      questionOperationId,
      requiresProvenance ? 1 : 0,
      questionId,
      questionOperationId,
      questionOperationId,
    );
}

function createOptionConstructionCleanup(
  database: SecurityDatabase,
  operationId: string,
): D1PreparedStatement {
  return database
    .prepare(
      "DELETE FROM question_option_construction WHERE operation_id = ?",
    )
    .bind(operationId);
}

function isValidMetadata(metadata: MutationMetadata): boolean {
  return (
    /^[a-zA-Z0-9:_-]{1,100}$/.test(metadata.operationId) &&
    isBoundedText(metadata.reason, 1, 500) &&
    Number.isSafeInteger(metadata.now)
  );
}

export function createScopeGuard(
  tokenDigest: string,
  certificationId: string,
  now: number,
  policy: StaffMfaPolicy,
): ScopeGuard {
  const placeholders = policy.allowedMethods.map(() => "?").join(", ");
  return {
    sql: `EXISTS (
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
        AND scope_session.mfa_method IN (${placeholders})
        AND (
          scope_role.role = 'global_admin'
          OR (
            scope_role.role = 'manager'
            AND EXISTS (
              SELECT 1
              FROM manager_certification_assignments AS scope_assignment
              WHERE scope_assignment.manager_user_id = scope_user.id
                AND scope_assignment.certification_id = ?
                AND scope_assignment.active = 1
            )
          )
        )
    )`,
    values: [
      tokenDigest,
      now,
      now - policy.maxAgeMs,
      now,
      ...policy.allowedMethods,
      certificationId,
    ],
  };
}

async function authorizeScope(
  database: SecurityDatabase,
  tokenDigest: string,
  certificationId: string,
  now: number,
  policy: StaffMfaPolicy | undefined,
): Promise<AuthorizationResult> {
  return authorizeCertification(
    database,
    tokenDigest,
    certificationId,
    now,
    policy,
  );
}

function idResult(result: { results?: unknown[] }): boolean {
  return (result.results?.length ?? 0) === 1;
}

function validateScopeCall(
  tokenDigest: string,
  certificationId: string,
  metadata: MutationMetadata,
): boolean {
  return (
    isValidTokenDigest(tokenDigest) &&
    isId(certificationId) &&
    isValidMetadata(metadata)
  );
}

export async function createExamVersion(
  database: SecurityDatabase,
  tokenDigest: string,
  input: {
    id: string;
    certificationId: string;
    versionKey: string;
    title: string;
    syllabusReference: string;
    effectiveFrom?: number | null;
    effectiveUntil?: number | null;
  },
  metadata: MutationMetadata,
  policy: StaffMfaPolicy | undefined,
): Promise<ContentResult<{ id: string }>> {
  if (
    !validateScopeCall(tokenDigest, input.certificationId, metadata) ||
    !isId(input.id) ||
    !isKey(input.versionKey) ||
    !isBoundedText(input.title, 1, 160) ||
    !isBoundedText(input.syllabusReference, 1, 500) ||
    (input.effectiveFrom != null && !Number.isSafeInteger(input.effectiveFrom)) ||
    (input.effectiveUntil != null && !Number.isSafeInteger(input.effectiveUntil)) ||
    (input.effectiveFrom != null &&
      input.effectiveUntil != null &&
      input.effectiveUntil <= input.effectiveFrom)
  ) {
    return { ok: false, reason: "invalid-input" };
  }

  const auth = await authorizeScope(
    database,
    tokenDigest,
    input.certificationId,
    metadata.now,
    policy,
  );
  if (!auth.allowed) return { ok: false, reason: auth.reason };
  const guard = createScopeGuard(
    tokenDigest,
    input.certificationId,
    metadata.now,
    policy!,
  );
  const result = await database
    .prepare(
      `INSERT INTO exam_versions (
         id, certification_id, version_key, title, syllabus_reference,
         effective_from, effective_until, created_by_user_id,
         created_operation_id, creation_reason, created_at
       )
       SELECT ?, certification.id, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM certifications AS certification
       WHERE certification.id = ? AND ${guard.sql}
       RETURNING id`,
    )
    .bind(
      input.id,
      input.versionKey,
      input.title.trim(),
      input.syllabusReference.trim(),
      input.effectiveFrom ?? null,
      input.effectiveUntil ?? null,
      auth.allowed ? auth.userId : "",
      metadata.operationId,
      metadata.reason.trim(),
      metadata.now,
      input.certificationId,
      ...guard.values,
    )
    .all<{ id: string }>();

  return idResult(result)
    ? { ok: true, value: { id: input.id } }
    : { ok: false, reason: "conflict" };
}

export async function createDomain(
  database: SecurityDatabase,
  tokenDigest: string,
  input: {
    id: string;
    certificationId: string;
    examVersionId: string;
    domainKey: string;
    title: string;
    meaning: string;
    order: number;
  },
  metadata: MutationMetadata,
  policy: StaffMfaPolicy | undefined,
): Promise<ContentResult<{ id: string }>> {
  if (
    !validateScopeCall(tokenDigest, input.certificationId, metadata) ||
    !isId(input.id) ||
    !isId(input.examVersionId) ||
    !isKey(input.domainKey) ||
    !isBoundedText(input.title, 1, 160) ||
    !isBoundedText(input.meaning, 1, 2000) ||
    !Number.isSafeInteger(input.order) ||
    input.order < 0
  ) {
    return { ok: false, reason: "invalid-input" };
  }
  const auth = await authorizeScope(
    database,
    tokenDigest,
    input.certificationId,
    metadata.now,
    policy,
  );
  if (!auth.allowed) return { ok: false, reason: auth.reason };
  const guard = createScopeGuard(
    tokenDigest,
    input.certificationId,
    metadata.now,
    policy!,
  );
  const result = await database
    .prepare(
      `INSERT INTO domains (
         id, certification_id, exam_version_id, domain_key, title, meaning,
         display_order, created_by_user_id, created_operation_id,
         creation_reason, created_at
       )
       SELECT ?, version.certification_id, version.id, ?, ?, ?, ?, ?, ?, ?, ?
       FROM exam_versions AS version
       WHERE version.id = ? AND version.certification_id = ?
         AND ${guard.sql}
       RETURNING id`,
    )
    .bind(
      input.id,
      input.domainKey,
      input.title.trim(),
      input.meaning.trim(),
      input.order,
      auth.allowed ? auth.userId : "",
      metadata.operationId,
      metadata.reason.trim(),
      metadata.now,
      input.examVersionId,
      input.certificationId,
      ...guard.values,
    )
    .all<{ id: string }>();

  return idResult(result)
    ? { ok: true, value: { id: input.id } }
    : { ok: false, reason: "conflict" };
}

export async function createTopic(
  database: SecurityDatabase,
  tokenDigest: string,
  input: {
    id: string;
    certificationId: string;
    examVersionId: string;
    domainId: string;
    topicKey: string;
    title: string;
    meaning: string;
    order: number;
  },
  metadata: MutationMetadata,
  policy: StaffMfaPolicy | undefined,
): Promise<ContentResult<{ id: string }>> {
  if (
    !validateScopeCall(tokenDigest, input.certificationId, metadata) ||
    !isId(input.id) ||
    !isId(input.examVersionId) ||
    !isId(input.domainId) ||
    !isKey(input.topicKey) ||
    !isBoundedText(input.title, 1, 160) ||
    !isBoundedText(input.meaning, 1, 2000) ||
    !Number.isSafeInteger(input.order) ||
    input.order < 0
  ) {
    return { ok: false, reason: "invalid-input" };
  }
  const auth = await authorizeScope(
    database,
    tokenDigest,
    input.certificationId,
    metadata.now,
    policy,
  );
  if (!auth.allowed) return { ok: false, reason: auth.reason };
  const guard = createScopeGuard(
    tokenDigest,
    input.certificationId,
    metadata.now,
    policy!,
  );
  const result = await database
    .prepare(
      `INSERT INTO topics (
         id, certification_id, exam_version_id, domain_id, topic_key, title,
         meaning, display_order, created_by_user_id, created_operation_id,
         creation_reason, created_at
       )
       SELECT ?, domain.certification_id, domain.exam_version_id, domain.id,
              ?, ?, ?, ?, ?, ?, ?, ?
       FROM domains AS domain
       WHERE domain.id = ? AND domain.exam_version_id = ?
         AND domain.certification_id = ? AND ${guard.sql}
       RETURNING id`,
    )
    .bind(
      input.id,
      input.topicKey,
      input.title.trim(),
      input.meaning.trim(),
      input.order,
      auth.allowed ? auth.userId : "",
      metadata.operationId,
      metadata.reason.trim(),
      metadata.now,
      input.domainId,
      input.examVersionId,
      input.certificationId,
      ...guard.values,
    )
    .all<{ id: string }>();

  return idResult(result)
    ? { ok: true, value: { id: input.id } }
    : { ok: false, reason: "conflict" };
}

async function createQuestionWithRevision(
  database: SecurityDatabase,
  tokenDigest: string,
  input: CreateQuestionInput,
  metadata: MutationMetadata,
  policy: StaffMfaPolicy,
  actorUserId: string,
  options?: {
    questionId?: string;
    revisionId?: string;
    additionalGuard?: ScopeGuard;
    statements?: D1PreparedStatement[];
  },
): Promise<ContentResult<{ questionId: string; revisionId: string; revisionNumber: number }>> {
  const questionId = options?.questionId ?? crypto.randomUUID();
  const revisionId = options?.revisionId ?? crypto.randomUUID();
  const questionOperationId = `${metadata.operationId}:question`;
  const revisionOperationId = `${metadata.operationId}:revision`;
  const baseDestinationGuard = createScopeGuard(
    tokenDigest,
    input.certificationId,
    metadata.now,
    policy,
  );
  const destinationGuard = options?.additionalGuard
    ? {
        sql: `(${baseDestinationGuard.sql}) AND (${options.additionalGuard.sql})`,
        values: [
          ...baseDestinationGuard.values,
          ...options.additionalGuard.values,
        ],
      }
    : baseDestinationGuard;
  const sourceGuard = input.source
    ? createScopeGuard(tokenDigest, input.source.certificationId, metadata.now, policy)
    : null;
  const sourceExistsSql = input.source
    ? `AND EXISTS (
         SELECT 1
         FROM question_revisions AS source_revision
         JOIN questions AS source_question
           ON source_question.id = source_revision.question_id
         WHERE source_revision.id = ?
           AND source_revision.question_id = ?
           AND source_revision.certification_id = ?
           AND source_question.certification_id = ?
       )
       AND ${sourceGuard!.sql}`
    : "";
  const sourceValues: D1Value[] = input.source
    ? [
        input.source.revisionId,
        input.source.questionId,
        input.source.certificationId,
        input.source.certificationId,
        ...sourceGuard!.values,
      ]
    : [];
  const content = normalizeQuestionContent(input.content);
  if (!content) return { ok: false, reason: "invalid-input" };

  const questionInsert = database
    .prepare(
      `INSERT INTO questions (
         id, certification_id, question_key, lock_version, created_by_user_id,
         created_operation_id, creation_reason, created_at
       )
       SELECT ?, certification.id, ?, 0, ?, ?, ?, ?
       FROM certifications AS certification
       WHERE certification.id = ?
         AND EXISTS (
           SELECT 1 FROM exam_versions AS version
           JOIN domains AS domain ON domain.exam_version_id = version.id
           JOIN topics AS topic ON topic.domain_id = domain.id
           WHERE version.id = ?
             AND version.certification_id = certification.id
             AND domain.id = ?
             AND topic.id = ?
             AND topic.exam_version_id = version.id
         )
         AND ${destinationGuard.sql}
         ${sourceExistsSql}
       RETURNING id`,
    )
    .bind(
      questionId,
      input.questionKey.trim(),
      actorUserId,
      questionOperationId,
      metadata.reason.trim(),
      metadata.now,
      input.certificationId,
      input.examVersionId,
      input.domainId,
      input.topicId,
      ...destinationGuard.values,
      ...sourceValues,
    );

  const revisionInsert = database
    .prepare(
      `INSERT INTO question_revisions (
         id, certification_id, exam_version_id, question_id,
         revision_number, base_lock_version, domain_id, topic_id, item_type,
         stem, difficulty, source_reference, license_reference,
         authored_by_user_id, created_operation_id, created_at
       )
       SELECT ?, question.certification_id, version.id, question.id,
              1, 0, domain.id, topic.id, 'single_choice',
              ?, ?, ?, ?, ?, ?, ?
       FROM questions AS question
       JOIN exam_versions AS version
         ON version.certification_id = question.certification_id
       JOIN domains AS domain
         ON domain.certification_id = version.certification_id
        AND domain.exam_version_id = version.id
       JOIN topics AS topic
         ON topic.certification_id = domain.certification_id
        AND topic.exam_version_id = domain.exam_version_id
        AND topic.domain_id = domain.id
       WHERE question.id = ?
         AND question.created_operation_id = ?
         AND question.lock_version = 0
         AND version.id = ?
         AND domain.id = ?
         AND topic.id = ?
         AND ${destinationGuard.sql}
         ${sourceExistsSql}
       RETURNING id`,
    )
    .bind(
      revisionId,
      content.stem,
      content.difficulty,
      content.sourceReference,
      content.licenseReference,
      actorUserId,
      revisionOperationId,
      metadata.now,
      questionId,
      questionOperationId,
      input.examVersionId,
      input.domainId,
      input.topicId,
      ...destinationGuard.values,
      ...sourceValues,
    );

  const optionConstructionInsert = createOptionConstructionInsert(
    database,
    revisionOperationId,
    questionId,
    questionOperationId,
    input.source !== undefined,
    content.options,
  );
  const optionConstructionCleanup = createOptionConstructionCleanup(
    database,
    revisionOperationId,
  );
  const batchStatements = [
    questionInsert,
    optionConstructionInsert,
    revisionInsert,
  ];
  if (input.source) {
    const derivationInsert = database
      .prepare(
        `INSERT INTO question_derivations (
           id, source_certification_id, source_question_id, source_revision_id,
           destination_certification_id, destination_question_id,
           destination_revision_id, actor_user_id, operation_id, reason, created_at
         )
         SELECT ?, ?, ?, ?, ?, question.id, revision.id, ?, ?, ?, ?
         FROM questions AS question
         JOIN question_revisions AS revision
           ON revision.question_id = question.id
         WHERE question.id = ?
           AND question.created_operation_id = ?
           AND revision.created_operation_id = ?
           AND ${destinationGuard.sql}
           AND ${sourceGuard!.sql}`,
      )
      .bind(
        crypto.randomUUID(),
        input.source.certificationId,
        input.source.questionId,
        input.source.revisionId,
        input.certificationId,
        actorUserId,
        `${metadata.operationId}:provenance`,
        input.source.reason.trim(),
        metadata.now,
        questionId,
        questionOperationId,
        revisionOperationId,
        ...destinationGuard.values,
        ...sourceGuard!.values,
      );
    batchStatements.push(derivationInsert);
  }
  batchStatements.push(optionConstructionCleanup);

  if (options?.statements) {
    options.statements.push(...batchStatements);
    return {
      ok: true,
      value: { questionId, revisionId, revisionNumber: 1 },
    };
  }

  const results = await database.batch(batchStatements);
  if (!idResult(results[0] ?? {}) || !idResult(results[2] ?? {})) {
    return { ok: false, reason: "conflict" };
  }
  return {
    ok: true,
    value: { questionId, revisionId, revisionNumber: 1 },
  };
}

export async function prepareImportedQuestionDraft(
  database: SecurityDatabase,
  tokenDigest: string,
  input: CreateQuestionInput & { questionId: string; revisionId: string },
  metadata: MutationMetadata,
  policy: StaffMfaPolicy,
  actorUserId: string,
  additionalGuard: ScopeGuard,
): Promise<
  ContentResult<{
    questionId: string;
    revisionId: string;
    revisionNumber: number;
    statements: D1PreparedStatement[];
  }>
> {
  const statements: D1PreparedStatement[] = [];
  const prepared = await createQuestionWithRevision(
    database,
    tokenDigest,
    input,
    metadata,
    policy,
    actorUserId,
    {
      questionId: input.questionId,
      revisionId: input.revisionId,
      additionalGuard,
      statements,
    },
  );
  if (!prepared.ok) return prepared;
  return {
    ok: true,
    value: { ...prepared.value, statements },
  };
}

export async function createDraftQuestion(
  database: SecurityDatabase,
  tokenDigest: string,
  input: CreateQuestionInput,
  metadata: MutationMetadata,
  policy: StaffMfaPolicy | undefined,
): Promise<ContentResult<{ questionId: string; revisionId: string; revisionNumber: number }>> {
  if (
    !validateScopeCall(tokenDigest, input.certificationId, metadata) ||
    !isId(input.examVersionId) ||
    !isId(input.domainId) ||
    !isId(input.topicId) ||
    !isKey(input.questionKey, 120) ||
    metadata.operationId.length > 100 ||
    !normalizeQuestionContent(input.content)
  ) {
    return { ok: false, reason: "invalid-input" };
  }
  const auth = await authorizeScope(
    database,
    tokenDigest,
    input.certificationId,
    metadata.now,
    policy,
  );
  if (!auth.allowed) return { ok: false, reason: auth.reason };
  if (input.source) {
    if (
      !isId(input.source.certificationId) ||
      !isId(input.source.questionId) ||
      !isId(input.source.revisionId) ||
      !isBoundedText(input.source.reason, 1, 500) ||
      input.source.certificationId === input.certificationId
    ) {
      return { ok: false, reason: "invalid-input" };
    }
    const sourceAuthorization = await authorizeScope(
      database,
      tokenDigest,
      input.source.certificationId,
      metadata.now,
      policy,
    );
    if (!sourceAuthorization.allowed) {
      return { ok: false, reason: sourceAuthorization.reason };
    }
  }
  return createQuestionWithRevision(
    database,
    tokenDigest,
    input,
    metadata,
    policy!,
    auth.userId,
  );
}

export async function createQuestionRevision(
  database: SecurityDatabase,
  tokenDigest: string,
  input: {
    certificationId: string;
    questionId: string;
    examVersionId: string;
    domainId: string;
    topicId: string;
    expectedLockVersion: number;
    content: QuestionContentInput;
  },
  metadata: MutationMetadata,
  policy: StaffMfaPolicy | undefined,
): Promise<ContentResult<{ revisionId: string; revisionNumber: number }>> {
  if (
    !validateScopeCall(tokenDigest, input.certificationId, metadata) ||
    !isId(input.questionId) ||
    !isId(input.examVersionId) ||
    !isId(input.domainId) ||
    !isId(input.topicId) ||
    !Number.isSafeInteger(input.expectedLockVersion) ||
    input.expectedLockVersion < 1 ||
    metadata.operationId.length > 100
  ) {
    return { ok: false, reason: "invalid-input" };
  }
  const content = normalizeQuestionContent(input.content);
  if (!content) return { ok: false, reason: "invalid-input" };
  const auth = await authorizeScope(
    database,
    tokenDigest,
    input.certificationId,
    metadata.now,
    policy,
  );
  if (!auth.allowed) return { ok: false, reason: auth.reason };
  const guard = createScopeGuard(
    tokenDigest,
    input.certificationId,
    metadata.now,
    policy!,
  );
  const revisionId = crypto.randomUUID();
  const revisionOperationId = `${metadata.operationId}:revision`;
  const revisionInsert = database
    .prepare(
      `INSERT INTO question_revisions (
         id, certification_id, exam_version_id, question_id,
         revision_number, base_lock_version, domain_id, topic_id, item_type,
         stem, difficulty, source_reference, license_reference,
         authored_by_user_id, created_operation_id, created_at
       )
       SELECT ?, question.certification_id, version.id, question.id,
              question.lock_version + 1, question.lock_version, domain.id,
              topic.id, 'single_choice', ?, ?, ?, ?, ?, ?, ?
       FROM questions AS question
       JOIN exam_versions AS version
         ON version.certification_id = question.certification_id
       JOIN domains AS domain
         ON domain.certification_id = version.certification_id
        AND domain.exam_version_id = version.id
       JOIN topics AS topic
         ON topic.certification_id = domain.certification_id
        AND topic.exam_version_id = domain.exam_version_id
        AND topic.domain_id = domain.id
       WHERE question.id = ?
         AND question.certification_id = ?
         AND question.lock_version = ?
         AND version.id = ?
         AND domain.id = ?
         AND topic.id = ?
         AND ${guard.sql}
       RETURNING id`,
    )
    .bind(
      revisionId,
      content.stem,
      content.difficulty,
      content.sourceReference,
      content.licenseReference,
      auth.userId,
      revisionOperationId,
      metadata.now,
      input.questionId,
      input.certificationId,
      input.expectedLockVersion,
      input.examVersionId,
      input.domainId,
      input.topicId,
      ...guard.values,
    );
  const optionConstructionInsert = createOptionConstructionInsert(
    database,
    revisionOperationId,
    input.questionId,
    null,
    false,
    content.options,
  );
  const optionConstructionCleanup = createOptionConstructionCleanup(
    database,
    revisionOperationId,
  );
  const results = await database.batch([
    optionConstructionInsert,
    revisionInsert,
    optionConstructionCleanup,
  ]);
  if (!idResult(results[1] ?? {})) {
    return { ok: false, reason: "conflict" };
  }
  return {
    ok: true,
    value: {
      revisionId,
      revisionNumber: input.expectedLockVersion + 1,
    },
  };
}

export async function submitQuestionForReview(
  database: SecurityDatabase,
  tokenDigest: string,
  input: { certificationId: string; revisionId: string },
  metadata: MutationMetadata,
  policy: StaffMfaPolicy | undefined,
): Promise<ContentResult<{ revisionId: string }>> {
  if (
    !validateScopeCall(tokenDigest, input.certificationId, metadata) ||
    !isId(input.revisionId) ||
    metadata.operationId.length > 100
  ) {
    return { ok: false, reason: "invalid-input" };
  }
  const auth = await authorizeScope(
    database,
    tokenDigest,
    input.certificationId,
    metadata.now,
    policy,
  );
  if (!auth.allowed) return { ok: false, reason: auth.reason };
  const guard = createScopeGuard(
    tokenDigest,
    input.certificationId,
    metadata.now,
    policy!,
  );
  const result = await database
    .prepare(
      `INSERT INTO question_revision_events (
         id, certification_id, question_revision_id, sequence_number,
         event_type, actor_user_id, operation_id, reason, occurred_at
       )
       SELECT ?, revision.certification_id, revision.id,
              COALESCE((
                SELECT MAX(sequence_number) + 1
                FROM question_revision_events
                WHERE question_revision_id = revision.id
              ), 1),
              'submitted', ?, ?, ?, ?
       FROM question_revisions AS revision
       WHERE revision.id = ? AND revision.certification_id = ?
         AND COALESCE((
           SELECT event_type FROM question_revision_events
           WHERE question_revision_id = revision.id
           ORDER BY sequence_number DESC LIMIT 1
         ), '') IN ('draft', 'rejected')
         AND ${guard.sql}
       RETURNING question_revision_id`,
    )
    .bind(
      crypto.randomUUID(),
      auth.userId,
      `${metadata.operationId}:submit`,
      metadata.reason.trim(),
      metadata.now,
      input.revisionId,
      input.certificationId,
      ...guard.values,
    )
    .all<{ question_revision_id: string }>();

  return idResult(result)
    ? { ok: true, value: { revisionId: input.revisionId } }
    : { ok: false, reason: "conflict" };
}

export async function recordQuestionReview(
  database: SecurityDatabase,
  tokenDigest: string,
  input: {
    certificationId: string;
    revisionId: string;
    decision: "approved" | "rejected";
    notes: string;
  },
  metadata: MutationMetadata,
  policy: StaffMfaPolicy | undefined,
): Promise<ContentResult<{ reviewId: string }>> {
  if (
    !validateScopeCall(tokenDigest, input.certificationId, metadata) ||
    !isId(input.revisionId) ||
    !["approved", "rejected"].includes(input.decision) ||
    !isBoundedText(input.notes, 1, 3000) ||
    metadata.operationId.length > 100
  ) {
    return { ok: false, reason: "invalid-input" };
  }
  const auth = await authorizeScope(
    database,
    tokenDigest,
    input.certificationId,
    metadata.now,
    policy,
  );
  if (!auth.allowed) return { ok: false, reason: auth.reason };
  const guard = createScopeGuard(
    tokenDigest,
    input.certificationId,
    metadata.now,
    policy!,
  );
  const reviewId = crypto.randomUUID();
  const result = await database
    .prepare(
      `INSERT INTO content_reviews (
         id, certification_id, question_revision_id, reviewer_user_id,
         decision, notes, operation_id, reviewed_at
       )
       SELECT ?, revision.certification_id, revision.id, ?, ?, ?, ?, ?
       FROM question_revisions AS revision
       WHERE revision.id = ? AND revision.certification_id = ?
         AND COALESCE((
           SELECT event_type FROM question_revision_events
           WHERE question_revision_id = revision.id
           ORDER BY sequence_number DESC LIMIT 1
         ), '') = 'submitted'
         AND ${guard.sql}
       RETURNING id`,
    )
    .bind(
      reviewId,
      auth.userId,
      input.decision,
      input.notes.trim(),
      `${metadata.operationId}:review`,
      metadata.now,
      input.revisionId,
      input.certificationId,
      ...guard.values,
    )
    .all<{ id: string }>();

  return idResult(result)
    ? { ok: true, value: { reviewId } }
    : { ok: false, reason: "conflict" };
}

export async function publishQuestionRevision(
  database: SecurityDatabase,
  tokenDigest: string,
  input: {
    certificationId: string;
    examVersionId: string;
    questionId: string;
    revisionId: string;
    expectedPointerVersion: number | null;
  },
  metadata: MutationMetadata,
  policy: StaffMfaPolicy | undefined,
): Promise<ContentResult<{ pointerVersion: number }>> {
  if (
    !validateScopeCall(tokenDigest, input.certificationId, metadata) ||
    !isId(input.examVersionId) ||
    !isId(input.questionId) ||
    !isId(input.revisionId) ||
    (input.expectedPointerVersion !== null &&
      (!Number.isSafeInteger(input.expectedPointerVersion) ||
        input.expectedPointerVersion < 1)) ||
    metadata.operationId.length > 100
  ) {
    return { ok: false, reason: "invalid-input" };
  }
  const auth = await authorizeScope(
    database,
    tokenDigest,
    input.certificationId,
    metadata.now,
    policy,
  );
  if (!auth.allowed) return { ok: false, reason: auth.reason };
  const guard = createScopeGuard(
    tokenDigest,
    input.certificationId,
    metadata.now,
    policy!,
  );
  const result = await database
    .prepare(
      `INSERT INTO exam_version_questions (
         certification_id, exam_version_id, question_id, question_revision_id,
         publication_state, lock_version, changed_by_user_id,
         changed_operation_id, reason, changed_at
       )
       SELECT revision.certification_id, revision.exam_version_id,
              revision.question_id, revision.id, 'published', 1, ?, ?, ?, ?
       FROM question_revisions AS revision
       WHERE revision.certification_id = ?
         AND revision.exam_version_id = ?
         AND revision.question_id = ?
         AND revision.id = ?
         AND COALESCE((
           SELECT event_type FROM question_revision_events
           WHERE question_revision_id = revision.id
           ORDER BY sequence_number DESC LIMIT 1
         ), '') = 'approved'
         AND (
           (? IS NULL AND NOT EXISTS (
             SELECT 1 FROM exam_version_questions
             WHERE exam_version_id = ? AND question_id = ?
           ))
           OR
           (? IS NOT NULL AND EXISTS (
             SELECT 1 FROM exam_version_questions
             WHERE exam_version_id = ? AND question_id = ?
               AND lock_version = ? AND publication_state = 'published'
               AND question_revision_id <> ?
           ))
         )
         AND ${guard.sql}
       ON CONFLICT(exam_version_id, question_id) DO UPDATE SET
         question_revision_id = excluded.question_revision_id,
         publication_state = 'published',
         lock_version = exam_version_questions.lock_version + 1,
         changed_by_user_id = excluded.changed_by_user_id,
         changed_operation_id = excluded.changed_operation_id,
         reason = excluded.reason,
         changed_at = excluded.changed_at
       WHERE ? IS NOT NULL
         AND exam_version_questions.lock_version = ?
         AND exam_version_questions.publication_state = 'published'
         AND exam_version_questions.question_revision_id <> excluded.question_revision_id
       RETURNING lock_version`,
    )
    .bind(
      auth.userId,
      metadata.operationId,
      metadata.reason.trim(),
      metadata.now,
      input.certificationId,
      input.examVersionId,
      input.questionId,
      input.revisionId,
      input.expectedPointerVersion,
      input.examVersionId,
      input.questionId,
      input.expectedPointerVersion,
      input.examVersionId,
      input.questionId,
      input.expectedPointerVersion,
      input.revisionId,
      ...guard.values,
      input.expectedPointerVersion,
      input.expectedPointerVersion,
    )
    .all<{ lock_version: number }>();
  const pointer = result.results[0];
  return pointer && typeof pointer === "object" && "lock_version" in pointer
    ? {
        ok: true,
        value: { pointerVersion: Number(pointer.lock_version) },
      }
    : { ok: false, reason: "conflict" };
}

export async function retirePublishedQuestion(
  database: SecurityDatabase,
  tokenDigest: string,
  input: {
    certificationId: string;
    examVersionId: string;
    questionId: string;
    expectedPointerVersion: number;
  },
  metadata: MutationMetadata,
  policy: StaffMfaPolicy | undefined,
): Promise<ContentResult<{ pointerVersion: number }>> {
  if (
    !validateScopeCall(tokenDigest, input.certificationId, metadata) ||
    !isId(input.examVersionId) ||
    !isId(input.questionId) ||
    !Number.isSafeInteger(input.expectedPointerVersion) ||
    input.expectedPointerVersion < 1 ||
    metadata.operationId.length > 100
  ) {
    return { ok: false, reason: "invalid-input" };
  }
  const auth = await authorizeScope(
    database,
    tokenDigest,
    input.certificationId,
    metadata.now,
    policy,
  );
  if (!auth.allowed) return { ok: false, reason: auth.reason };
  const guard = createScopeGuard(
    tokenDigest,
    input.certificationId,
    metadata.now,
    policy!,
  );
  const result = await database
    .prepare(
      `UPDATE exam_version_questions
       SET publication_state = 'retired',
           lock_version = lock_version + 1,
           changed_by_user_id = ?,
           changed_operation_id = ?,
           reason = ?,
           changed_at = ?
       WHERE certification_id = ?
         AND exam_version_id = ?
         AND question_id = ?
         AND publication_state = 'published'
         AND lock_version = ?
         AND ${guard.sql}
       RETURNING lock_version`,
    )
    .bind(
      auth.userId,
      metadata.operationId,
      metadata.reason.trim(),
      metadata.now,
      input.certificationId,
      input.examVersionId,
      input.questionId,
      input.expectedPointerVersion,
      ...guard.values,
    )
    .all<{ lock_version: number }>();
  const pointer = result.results[0];
  return pointer && typeof pointer === "object" && "lock_version" in pointer
    ? {
        ok: true,
        value: { pointerVersion: Number(pointer.lock_version) },
      }
    : { ok: false, reason: "conflict" };
}

export async function copyQuestionToCertification(
  database: SecurityDatabase,
  tokenDigest: string,
  input: {
    sourceCertificationId: string;
    sourceQuestionId: string;
    sourceRevisionId: string;
    destinationCertificationId: string;
    destinationExamVersionId: string;
    destinationDomainId: string;
    destinationTopicId: string;
    destinationQuestionKey: string;
    reason: string;
  },
  metadata: MutationMetadata,
  policy: StaffMfaPolicy | undefined,
): Promise<ContentResult<{ questionId: string; revisionId: string }>> {
  if (
    !validateScopeCall(
      tokenDigest,
      input.destinationCertificationId,
      metadata,
    ) ||
    !isId(input.sourceCertificationId) ||
    !isId(input.sourceQuestionId) ||
    !isId(input.sourceRevisionId) ||
    !isId(input.destinationExamVersionId) ||
    !isId(input.destinationDomainId) ||
    !isId(input.destinationTopicId) ||
    !isKey(input.destinationQuestionKey, 120) ||
    !isBoundedText(input.reason, 1, 500) ||
    input.sourceCertificationId === input.destinationCertificationId ||
    metadata.operationId.length > 100
  ) {
    return { ok: false, reason: "invalid-input" };
  }
  const [sourceAuth, destinationAuth] = await Promise.all([
    authorizeScope(
      database,
      tokenDigest,
      input.sourceCertificationId,
      metadata.now,
      policy,
    ),
    authorizeScope(
      database,
      tokenDigest,
      input.destinationCertificationId,
      metadata.now,
      policy,
    ),
  ]);
  if (!sourceAuth.allowed) return { ok: false, reason: sourceAuth.reason };
  if (!destinationAuth.allowed) {
    return { ok: false, reason: destinationAuth.reason };
  }

  const source = await getQuestionRevision(
    database,
    tokenDigest,
    {
      certificationId: input.sourceCertificationId,
      revisionId: input.sourceRevisionId,
    },
    metadata.now,
    policy,
  );
  if (!source.ok) return source;
  if (source.value.questionId !== input.sourceQuestionId) {
    return { ok: false, reason: "not-found" };
  }
  const metadataForCopy = {
    ...metadata,
    reason: input.reason,
  };
  const created = await createQuestionWithRevision(
    database,
    tokenDigest,
    {
      certificationId: input.destinationCertificationId,
      examVersionId: input.destinationExamVersionId,
      domainId: input.destinationDomainId,
      topicId: input.destinationTopicId,
      questionKey: input.destinationQuestionKey,
      content: {
        stem: source.value.stem,
        difficulty: source.value.difficulty,
        sourceReference: source.value.sourceReference,
        licenseReference: source.value.licenseReference,
        options: source.value.options.map((option) => ({
          key: option.key,
          text: option.text,
          correct: option.correct,
          explanation: option.explanation,
        })),
      },
      source: {
        certificationId: input.sourceCertificationId,
        questionId: input.sourceQuestionId,
        revisionId: input.sourceRevisionId,
        reason: input.reason,
      },
    },
    metadataForCopy,
    policy!,
    destinationAuth.userId,
  );
  return created.ok
    ? {
        ok: true,
        value: {
          questionId: created.value.questionId,
          revisionId: created.value.revisionId,
        },
      }
    : created;
}

export async function getQuestionRevision(
  database: SecurityDatabase,
  tokenDigest: string,
  input: { certificationId: string; revisionId: string },
  now: number,
  policy: StaffMfaPolicy | undefined,
): Promise<ContentResult<QuestionContent>> {
  if (
    !isValidTokenDigest(tokenDigest) ||
    !isId(input.certificationId) ||
    !isId(input.revisionId)
  ) {
    return { ok: false, reason: "invalid-input" };
  }
  const authorization = await authorizeScope(
    database,
    tokenDigest,
    input.certificationId,
    now,
    policy,
  );
  if (!authorization.allowed) {
    return { ok: false, reason: authorization.reason };
  }
  if (!isConfiguredMfaPolicy(policy)) {
    return { ok: false, reason: "mfa-policy-unconfigured" };
  }
  const guard = createScopeGuard(
    tokenDigest,
    input.certificationId,
    now,
    policy,
  );
  const rows = await database
    .withSession("first-primary")
    .prepare(
      `SELECT revision.id AS revision_id, revision.question_id,
              revision.certification_id, revision.exam_version_id,
              revision.domain_id, revision.topic_id, revision.revision_number,
              revision.stem, revision.difficulty, revision.source_reference,
              revision.license_reference,
              question.lock_version,
              (SELECT event_type FROM question_revision_events
               WHERE question_revision_id = revision.id
               ORDER BY sequence_number DESC LIMIT 1) AS workflow_state,
              option.option_key, option.option_order, option.option_text,
              option.is_correct, option.explanation
       FROM question_revisions AS revision
       JOIN questions AS question ON question.id = revision.question_id
       JOIN question_revision_seals AS seal
         ON seal.certification_id = revision.certification_id
        AND seal.question_revision_id = revision.id
       LEFT JOIN answer_options AS option
         ON option.question_revision_id = revision.id
       WHERE revision.id = ?
         AND revision.certification_id = ?
         AND ${guard.sql}
       ORDER BY option.option_order`,
    )
    .bind(input.revisionId, input.certificationId, ...guard.values)
    .all<{
      revision_id: string;
      question_id: string;
      certification_id: string;
      exam_version_id: string;
      domain_id: string;
      topic_id: string;
      revision_number: number;
      stem: string;
      difficulty: "easy" | "medium" | "hard";
      source_reference: string;
      license_reference: string;
      lock_version: number;
      workflow_state: string;
      option_key: string | null;
      option_order: number | null;
      option_text: string | null;
      is_correct: number | null;
      explanation: string | null;
    }>();
  const first = rows.results[0];
  if (!first) return { ok: false, reason: "not-found" };
  return {
    ok: true,
    value: {
      revisionId: first.revision_id,
      questionId: first.question_id,
      certificationId: first.certification_id,
      examVersionId: first.exam_version_id,
      domainId: first.domain_id,
      topicId: first.topic_id,
      revisionNumber: first.revision_number,
      lockVersion: first.lock_version,
      stem: first.stem,
      difficulty: first.difficulty,
      sourceReference: first.source_reference,
      licenseReference: first.license_reference,
      workflowState: first.workflow_state,
      options: rows.results.flatMap((row) =>
        row.option_key === null
          ? []
          : [
              {
                key: row.option_key,
                order: row.option_order!,
                text: row.option_text!,
                correct: row.is_correct === 1,
                explanation: row.explanation!,
              },
            ],
      ),
    },
  };
}

export async function listPublishedQuestions(
  database: SecurityDatabase,
  tokenDigest: string,
  input: { certificationId: string; examVersionId: string },
  now: number,
  policy: StaffMfaPolicy | undefined,
): Promise<
  ContentResult<
    Array<{
      questionId: string;
      revisionId: string;
      stem: string;
      difficulty: "easy" | "medium" | "hard";
    }>
  >
> {
  if (
    !isValidTokenDigest(tokenDigest) ||
    !isId(input.certificationId) ||
    !isId(input.examVersionId)
  ) {
    return { ok: false, reason: "invalid-input" };
  }
  const authorization = await authorizeScope(
    database,
    tokenDigest,
    input.certificationId,
    now,
    policy,
  );
  if (!authorization.allowed) {
    return { ok: false, reason: authorization.reason };
  }
  if (!isConfiguredMfaPolicy(policy)) {
    return { ok: false, reason: "mfa-policy-unconfigured" };
  }
  const guard = createScopeGuard(
    tokenDigest,
    input.certificationId,
    now,
    policy,
  );
  const rows = await database
    .withSession("first-primary")
    .prepare(
      `SELECT revision.question_id, revision.id AS revision_id,
              revision.stem, revision.difficulty
       FROM published_question_revisions AS published
       JOIN question_revisions AS revision
         ON revision.id = published.question_revision_id
       WHERE published.certification_id = ?
         AND published.exam_version_id = ?
         AND ${guard.sql}
       ORDER BY revision.question_id`,
    )
    .bind(input.certificationId, input.examVersionId, ...guard.values)
    .all<{
      question_id: string;
      revision_id: string;
      stem: string;
      difficulty: "easy" | "medium" | "hard";
    }>();
  return {
    ok: true,
    value: rows.results.map((row) => ({
      questionId: row.question_id,
      revisionId: row.revision_id,
      stem: row.stem,
      difficulty: row.difficulty,
    })),
  };
}
