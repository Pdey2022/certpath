import { Hono, type Context } from "hono";
import {
  createdDraftResponseSchema,
  createdIdResponseSchema,
  createdRevisionResponseSchema,
  certificationListResponseSchema,
  csrfResponseSchema,
  createCertificationRequestSchema,
  createDomainRequestSchema,
  createExamVersionRequestSchema,
  createQuestionRequestSchema,
  createQuestionRevisionRequestSchema,
  createTopicRequestSchema,
  contentPageQuerySchema,
  domainListResponseSchema,
  emptyMutationRequestSchema,
  exportQuerySchema,
  examVersionListResponseSchema,
  importConfirmationResponseSchema,
  importPreviewResponseSchema,
  protectedPathIdSchema,
  pointerVersionResponseSchema,
  questionRevisionResponseSchema,
  questionPublicationResponseSchema,
  questionListResponseSchema,
  questionPageQuerySchema,
  questionRevisionListResponseSchema,
  questionReviewRequestSchema,
  publishQuestionRequestSchema,
  reviewIdResponseSchema,
  revisionIdResponseSchema,
  retireQuestionRequestSchema,
  topicListResponseSchema,
} from "@certpath/contracts";
import type { CreateCertificationRequest } from "@certpath/contracts";
import type { SecurityDatabase } from "./security/database.ts";
import {
  readStaffSecurityConfiguration,
  type StaffSecurityBindings,
  type StaffSecurityConfiguration,
} from "./security/staff-configuration.ts";
import {
  createDomain,
  createDraftQuestion,
  createExamVersion,
  createQuestionRevision,
  createTopic,
  getQuestionRevision,
  publishQuestionRevision,
  recordQuestionReview,
  retirePublishedQuestion,
  submitQuestionForReview,
} from "./security/content.ts";
import type { ContentFailure, ContentResult } from "./security/content.ts";
import { createCertificationRoot } from "./security/mutations.ts";
import {
  confirmQuestionImport,
  exportPublishedQuestions,
  previewQuestionImport,
  QUESTION_IMPORT_MAX_BYTES,
} from "./security/question-imports.ts";

import {
  listAuthorizedCertifications,
  listDomains,
  listExamVersions,
  listQuestionRevisions,
  listQuestions,
  listTopics,
  getQuestionPublication,
} from "./security/content-queries.ts";
import {
  authorizeCertification,
  authorizeGlobalAdmin,
  authorizeStaffSession,
  findActiveApplicationSession,
} from "./security/repository.ts";
import {
  constantTimeEqual,
  createCsrfToken,
  sessionCookieToken,
  sessionDigest,
} from "./security/http-session.ts";

type ApiBindings = StaffSecurityBindings & {
  DB: SecurityDatabase;
};

interface RequestPrincipal {
  tokenDigest: string;
  userId: string;
  configuration: StaffSecurityConfiguration;
}

interface ProtectedVariables {
  principal: RequestPrincipal;
  requestId: string;
}

type ProtectedContext = Context<{
  Bindings: ApiBindings;
  Variables: ProtectedVariables;
}>;

const SMALL_JSON_BODY_MAX_BYTES = 24 * 1024;
const QUESTION_JSON_BODY_MAX_BYTES = 256 * 1024;
const CSV_BODY_MAX_BYTES = QUESTION_IMPORT_MAX_BYTES;

function errorResponse(
  context: ProtectedContext,
  status: number,
  code: string,
  issues?: Array<{ path: string; code: string }>,
  summary?: { parsedRows: number; validRows: number; invalidRows: number },
): Response {
  const headers = new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Request-Id": context.get("requestId"),
    "Content-Type": "application/json; charset=utf-8",
  });
  headers.set("Pragma", "no-cache");
  return new Response(
    JSON.stringify({
      error: {
        code,
        requestId: context.get("requestId"),
        ...(issues ? { issues } : {}),
        ...(summary ? { summary } : {}),
      },
    }),
    { status, headers },
  );
}

async function csrfToken(principal: RequestPrincipal): Promise<string> {
  return createCsrfToken(
    principal.configuration.origin,
    principal.tokenDigest,
    principal.configuration.csrfSecret,
  );
}

async function mutationProtection(
  context: ProtectedContext,
): Promise<Response | null> {
  const principal = context.get("principal");
  if (
    context.req.header("Origin") !== principal.configuration.origin ||
    new URL(context.req.url).origin !== principal.configuration.origin
  ) {
    return errorResponse(context, 400, "invalid_origin");
  }
  const supplied = context.req.header("X-CSRF-Token");
  if (!supplied || supplied.length > 64) {
    return errorResponse(context, 400, "invalid_csrf");
  }
  const expected = await csrfToken(principal);
  return constantTimeEqual(supplied, expected)
    ? null
    : errorResponse(context, 400, "invalid_csrf");
}

async function readBoundedBytes(
  context: ProtectedContext,
  maximumBytes: number,
): Promise<{ bytes: Uint8Array } | { response: Response }> {
  const declaredLength = context.req.header("Content-Length");
  if (declaredLength !== undefined) {
    if (!/^\d+$/.test(declaredLength)) {
      return { response: errorResponse(context, 400, "invalid_content_length") };
    }
    if (Number(declaredLength) > maximumBytes) {
      return { response: errorResponse(context, 413, "payload_too_large") };
    }
  }
  const body = context.req.raw.body;
  if (!body) return { response: errorResponse(context, 400, "validation_error") };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      return { response: errorResponse(context, 413, "payload_too_large") };
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}

function acceptsContentType(context: ProtectedContext, type: "json" | "csv"): boolean {
  const contentType = context.req.header("Content-Type")?.trim().toLowerCase();
  if (type === "json") {
    return contentType === "application/json" ||
      contentType === "application/json; charset=utf-8";
  }
  return contentType === "text/csv" ||
    contentType === "text/csv; charset=utf-8";
}

async function readJsonBody<T>(
  context: ProtectedContext,
  schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; code: string }> } } },
  maximumBytes = SMALL_JSON_BODY_MAX_BYTES,
): Promise<{ value: T } | { response: Response }> {
  if (!acceptsContentType(context, "json")) {
    return { response: errorResponse(context, 400, "unsupported_media_type") };
  }
  const body = await readBoundedBytes(context, maximumBytes);
  if ("response" in body) return body;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes));
  } catch {
    return { response: errorResponse(context, 400, "validation_error") };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return {
      response: errorResponse(
        context,
        400,
        "validation_error",
        parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          code: issue.code,
        })),
      ),
    };
  }
  return { value: parsed.data };
}

function serverMetadata(action: string) {
  return {
    operationId: `api:${action}:${crypto.randomUUID()}`,
    reason: `Protected content API: ${action}`,
    now: Date.now(),
  };
}

function contentError(
  context: ProtectedContext,
  reason: ContentFailure | string,
): Response {
  if (reason === "invalid-session") return errorResponse(context, 401, "unauthenticated");
  if (reason === "not-staff" || reason === "insufficient-role") {
    return errorResponse(context, 403, "forbidden");
  }
  if (
    reason === "certification-not-found" ||
    reason === "certification-unassigned" ||
    reason === "not-found"
  ) {
    return errorResponse(context, 404, "not_found");
  }
  if (reason === "mfa-policy-unconfigured" || reason === "mfa-policy-invalid") {
    return errorResponse(context, 503, "service_unavailable");
  }
  if (reason.startsWith("mfa-")) return errorResponse(context, 403, "forbidden");
  if (reason === "invalid-input") return errorResponse(context, 400, "validation_error");
  if (reason === "conflict") return errorResponse(context, 409, "conflict");
  return errorResponse(context, 503, "service_unavailable");
}

function resultResponse<T>(
  context: ProtectedContext,
  result: ContentResult<T>,
  successStatus: 200 | 201 = 200,
  responseSchema?: { parse(input: unknown): unknown },
): Response {
  if (!result.ok) return contentError(context, result.reason);
  const value = responseSchema
    ? responseSchema.parse(result.value)
    : result.value;
  return context.json(value, successStatus);
}

function validPathId(context: ProtectedContext, value: string): string | Response {
  const parsed = protectedPathIdSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : errorResponse(context, 400, "validation_error");
}

async function requireCertification(
  context: ProtectedContext,
  certificationId: string,
): Promise<Response | null> {
  const authorization = await authorizeCertification(
    context.env.DB,
    context.get("principal").tokenDigest,
    certificationId,
    Date.now(),
    context.get("principal").configuration.policy,
  );
  if (authorization.allowed) return null;
  return contentError(context, authorization.reason);
}

async function requireMutation(
  context: ProtectedContext,
  certificationId: string,
): Promise<Response | null> {
  const csrfFailure = await mutationProtection(context);
  if (csrfFailure) return csrfFailure;
  return requireCertification(context, certificationId);
}

/**
 * Platform-wide mutation scope: exact Origin, session-bound CSRF, then the same
 * Global Admin session/role/MFA check every platform-wide staff write uses
 * (`mutations.ts#authorizeMutation`). It exists because the certification-scoped
 * `requireMutation` above needs a `:certificationId` to authorize against, and a
 * certification root is created before any such scope exists.
 *
 * `createCertificationRoot` re-checks this authorization and its guarded INSERT
 * adds `globalAdminGuard`, so a role or MFA change between the two checks still
 * takes effect inside the write.
 */
async function requireGlobalAdminMutation(
  context: ProtectedContext,
): Promise<Response | null> {
  const csrfFailure = await mutationProtection(context);
  if (csrfFailure) return csrfFailure;
  const principal = context.get("principal");
  const authorization = await authorizeGlobalAdmin(
    context.env.DB,
    principal.tokenDigest,
    Date.now(),
    principal.configuration.policy,
  );
  if (!authorization.allowed) return contentError(context, authorization.reason);
  return null;
}

/**
 * Compile-time contract parity: `createCertificationRequestSchema` and the input
 * of `createCertificationRoot` are one shape. Adding a field on either side
 * without the other fails `npm run typecheck` instead of drifting silently at
 * runtime. `SameShape` is the contravariant-assignability identity check, so it
 * also catches a widened or narrowed field type, not just missing keys.
 */
type SameShape<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Condition extends true> = Condition;
type _CertificationRequestMatchesMutationInput = Expect<
  SameShape<
    CreateCertificationRequest,
    Parameters<typeof createCertificationRoot>[2]
  >
>;

async function exactRevisionExists(
  context: ProtectedContext,
  input: {
    certificationId: string;
    examVersionId: string;
    questionId: string;
    revisionId: string;
  },
): Promise<boolean> {
  const row = await context.env.DB
    .withSession("first-primary")
    .prepare(
      `SELECT 1 AS present FROM question_revisions
       WHERE certification_id = ? AND exam_version_id = ?
         AND question_id = ? AND id = ?`,
    )
    .bind(
      input.certificationId,
      input.examVersionId,
      input.questionId,
      input.revisionId,
    )
    .first<{ present: number }>();
  return row !== null;
}

async function examVersionExists(
  context: ProtectedContext,
  certificationId: string,
  examVersionId: string,
): Promise<boolean> {
  const row = await context.env.DB
    .withSession("first-primary")
    .prepare(
      `SELECT 1 AS present FROM exam_versions
       WHERE certification_id = ? AND id = ?`,
    )
    .bind(certificationId, examVersionId)
    .first<{ present: number }>();
  return row !== null;
}

async function domainExists(
  context: ProtectedContext,
  certificationId: string,
  examVersionId: string,
  domainId: string,
): Promise<boolean> {
  const row = await context.env.DB
    .withSession("first-primary")
    .prepare(
      `SELECT 1 AS present FROM domains
       WHERE certification_id = ? AND exam_version_id = ? AND id = ?`,
    )
    .bind(certificationId, examVersionId, domainId)
    .first<{ present: number }>();
  return row !== null;
}

async function questionIdentityExists(
  context: ProtectedContext,
  certificationId: string,
  questionId: string,
): Promise<boolean> {
  const row = await context.env.DB
    .withSession("first-primary")
    .prepare(
      `SELECT 1 AS present FROM questions
       WHERE certification_id = ? AND id = ?`,
    )
    .bind(certificationId, questionId)
    .first<{ present: number }>();
  return row !== null;
}

async function questionExistsInVersion(
  context: ProtectedContext,
  certificationId: string,
  examVersionId: string,
  questionId: string,
): Promise<boolean> {
  const row = await context.env.DB
    .withSession("first-primary")
    .prepare(
      `SELECT 1 AS present FROM question_revisions
       WHERE certification_id = ? AND exam_version_id = ?
         AND question_id = ? LIMIT 1`,
    )
    .bind(certificationId, examVersionId, questionId)
    .first<{ present: number }>();
  return row !== null;
}

function strictQueryObject(context: ProtectedContext): Record<string, string> | Response {
  const entries = [...new URL(context.req.url).searchParams.entries()];
  const query: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key in query) return errorResponse(context, 400, "validation_error");
    query[key] = value;
  }
  return query;
}

function parseQuery<T>(
  context: ProtectedContext,
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } },
): { value: T } | { response: Response } {
  const query = strictQueryObject(context);
  if (query instanceof Response) return { response: query };
  const parsed = schema.safeParse(query);
  return parsed.success
    ? { value: parsed.data }
    : { response: errorResponse(context, 400, "validation_error") };
}

function configurePrivateResponse(context: ProtectedContext): void {
  context.header("Cache-Control", "private, no-store, max-age=0");
  context.header("X-Robots-Tag", "noindex, nofollow");
  context.header("Pragma", "no-cache");
  context.header("X-Request-Id", context.get("requestId"));
}

const protectedApi = new Hono<{
  Bindings: ApiBindings;
  Variables: ProtectedVariables;
}>();

protectedApi.use("*", async (context, next) => {
  const requestId = crypto.randomUUID();
  context.set("requestId", requestId);
  configurePrivateResponse(context);
  const configuration = readStaffSecurityConfiguration(context.env);
  if (!configuration) {
    return errorResponse(context, 503, "service_unavailable");
  }
  const rawToken = sessionCookieToken(context.req.header("Cookie") ?? null);
  if (!rawToken) return errorResponse(context, 401, "unauthenticated");
  const tokenDigest = await sessionDigest(rawToken);
  const session = await findActiveApplicationSession(
    context.env.DB,
    tokenDigest,
    Date.now(),
  );
  if (!session) return errorResponse(context, 401, "unauthenticated");
  context.set("principal", {
    tokenDigest,
    userId: session.userId,
    configuration,
  });
  await next();
});

protectedApi.get("/csrf", async (context) => {
  const principal = context.get("principal");
  const requestOrigin = new URL(context.req.url).origin;
  const suppliedOrigin = context.req.header("Origin");
  if (
    requestOrigin !== principal.configuration.origin ||
    (suppliedOrigin !== undefined &&
      suppliedOrigin !== principal.configuration.origin)
  ) {
    return errorResponse(context, 400, "invalid_origin");
  }
  const token = await csrfToken(principal);
  return context.json(csrfResponseSchema.parse({ csrfToken: token }));
});

protectedApi.get("/certifications", async (context) => {
  const principal = context.get("principal");
  const policy = principal.configuration.policy;
  const authorization = await authorizeStaffSession(
    context.env.DB,
    principal.tokenDigest,
    Date.now(),
    policy,
  );
  if (!authorization.allowed) return contentError(context, authorization.reason);
  const parsed = parseQuery(context, contentPageQuerySchema);
  if ("response" in parsed) return parsed.response;
  const result = await listAuthorizedCertifications(
    context.env.DB,
    principal.tokenDigest,
    Date.now(),
    policy,
    {
      cursor: parsed.value.cursor,
      pageSize: parsed.value.limit,
    },
  );
  return context.json(certificationListResponseSchema.parse(result));
});

protectedApi.post("/certifications", async (context) => {
  const denied = await requireGlobalAdminMutation(context);
  if (denied) return denied;
  const parsed = await readJsonBody(context, createCertificationRequestSchema);
  if ("response" in parsed) return parsed.response;
  const result = await createCertificationRoot(
    context.env.DB,
    context.get("principal").tokenDigest,
    parsed.value,
    serverMetadata("create-certification"),
    context.get("principal").configuration.policy,
  );
  if (!result.applied) return contentError(context, result.reason);
  return context.json(createdIdResponseSchema.parse({ id: parsed.value.id }), 201);
});

protectedApi.get(
  "/certifications/:certificationId/exam-versions",
  async (context) => {
    const certificationId = validPathId(context, context.req.param("certificationId"));
    if (certificationId instanceof Response) return certificationId;
    const denied = await requireCertification(context, certificationId);
    if (denied) return denied;
    const parsed = parseQuery(context, contentPageQuerySchema);
    if ("response" in parsed) return parsed.response;
    const principal = context.get("principal");
    const result = await listExamVersions(context.env.DB, {
      certificationId,
      tokenDigest: principal.tokenDigest,
      now: Date.now(),
      policy: principal.configuration.policy,
      cursor: parsed.value.cursor,
      pageSize: parsed.value.limit,
    });
    return context.json(examVersionListResponseSchema.parse(result));
  },
);

protectedApi.get(
  "/certifications/:certificationId/exam-versions/:examVersionId/domains",
  async (context) => {
    const certificationId = validPathId(context, context.req.param("certificationId"));
    const examVersionId = validPathId(context, context.req.param("examVersionId"));
    if (certificationId instanceof Response) return certificationId;
    if (examVersionId instanceof Response) return examVersionId;
    const denied = await requireCertification(context, certificationId);
    if (denied) return denied;
    const parsed = parseQuery(context, contentPageQuerySchema);
    if ("response" in parsed) return parsed.response;
    const principal = context.get("principal");
    const result = await listDomains(context.env.DB, {
      certificationId,
      examVersionId,
      tokenDigest: principal.tokenDigest,
      now: Date.now(),
      policy: principal.configuration.policy,
      cursor: parsed.value.cursor,
      pageSize: parsed.value.limit,
    });
    return context.json(domainListResponseSchema.parse(result));
  },
);

protectedApi.get(
  "/certifications/:certificationId/exam-versions/:examVersionId/domains/:domainId/topics",
  async (context) => {
    const certificationId = validPathId(context, context.req.param("certificationId"));
    const examVersionId = validPathId(context, context.req.param("examVersionId"));
    const domainId = validPathId(context, context.req.param("domainId"));
    if (certificationId instanceof Response) return certificationId;
    if (examVersionId instanceof Response) return examVersionId;
    if (domainId instanceof Response) return domainId;
    const denied = await requireCertification(context, certificationId);
    if (denied) return denied;
    const parsed = parseQuery(context, contentPageQuerySchema);
    if ("response" in parsed) return parsed.response;
    const principal = context.get("principal");
    const result = await listTopics(context.env.DB, {
      certificationId,
      examVersionId,
      domainId,
      tokenDigest: principal.tokenDigest,
      now: Date.now(),
      policy: principal.configuration.policy,
      cursor: parsed.value.cursor,
      pageSize: parsed.value.limit,
    });
    return context.json(topicListResponseSchema.parse(result));
  },
);

protectedApi.get(
  "/certifications/:certificationId/exam-versions/:examVersionId/questions",
  async (context) => {
    const certificationId = validPathId(context, context.req.param("certificationId"));
    const examVersionId = validPathId(context, context.req.param("examVersionId"));
    if (certificationId instanceof Response) return certificationId;
    if (examVersionId instanceof Response) return examVersionId;
    const denied = await requireCertification(context, certificationId);
    if (denied) return denied;
    const parsed = parseQuery(context, questionPageQuerySchema);
    if ("response" in parsed) return parsed.response;
    const principal = context.get("principal");
    const result = await listQuestions(context.env.DB, {
      certificationId,
      examVersionId,
      domainId: parsed.value.domainId,
      topicId: parsed.value.topicId,
      questionId: parsed.value.questionId,
      tokenDigest: principal.tokenDigest,
      now: Date.now(),
      policy: principal.configuration.policy,
      cursor: parsed.value.cursor,
      pageSize: parsed.value.limit,
    });
    return context.json(questionListResponseSchema.parse(result));
  },
);

protectedApi.get(
  "/certifications/:certificationId/exam-versions/:examVersionId/questions/:questionId/revisions",
  async (context) => {
    const certificationId = validPathId(context, context.req.param("certificationId"));
    const examVersionId = validPathId(context, context.req.param("examVersionId"));
    const questionId = validPathId(context, context.req.param("questionId"));
    if (certificationId instanceof Response) return certificationId;
    if (examVersionId instanceof Response) return examVersionId;
    if (questionId instanceof Response) return questionId;
    const denied = await requireCertification(context, certificationId);
    if (denied) return denied;
    const parsed = parseQuery(context, contentPageQuerySchema);
    if ("response" in parsed) return parsed.response;
    const principal = context.get("principal");
    const result = await listQuestionRevisions(context.env.DB, {
      certificationId,
      examVersionId,
      questionId,
      tokenDigest: principal.tokenDigest,
      now: Date.now(),
      policy: principal.configuration.policy,
      cursor: parsed.value.cursor,
      pageSize: parsed.value.limit,
    });
    return context.json(questionRevisionListResponseSchema.parse(result));
  },
);

protectedApi.post("/certifications/:certificationId/exam-versions", async (context) => {
  const certificationId = validPathId(context, context.req.param("certificationId"));
  if (certificationId instanceof Response) return certificationId;
  const denied = await requireMutation(context, certificationId);
  if (denied) return denied;
  const parsed = await readJsonBody(context, createExamVersionRequestSchema);
  if ("response" in parsed) return parsed.response;
  const id = crypto.randomUUID();
  const result = await createExamVersion(
    context.env.DB,
    context.get("principal").tokenDigest,
    { ...parsed.value, id, certificationId },
    serverMetadata("create-exam-version"),
    context.get("principal").configuration.policy,
  );
  return resultResponse(context, result, 201, createdIdResponseSchema);
});

protectedApi.post(
  "/certifications/:certificationId/exam-versions/:examVersionId/domains",
  async (context) => {
    const certificationId = validPathId(context, context.req.param("certificationId"));
    const examVersionId = validPathId(context, context.req.param("examVersionId"));
    if (certificationId instanceof Response) return certificationId;
    if (examVersionId instanceof Response) return examVersionId;
    const denied = await requireMutation(context, certificationId);
    if (denied) return denied;
    if (!(await examVersionExists(context, certificationId, examVersionId))) {
      return errorResponse(context, 404, "not_found");
    }
    const parsed = await readJsonBody(context, createDomainRequestSchema);
    if ("response" in parsed) return parsed.response;
    const result = await createDomain(
      context.env.DB,
      context.get("principal").tokenDigest,
      {
        ...parsed.value,
        id: crypto.randomUUID(),
        certificationId,
        examVersionId,
      },
      serverMetadata("create-domain"),
      context.get("principal").configuration.policy,
    );
    return resultResponse(context, result, 201, createdIdResponseSchema);
  },
);

protectedApi.post(
  "/certifications/:certificationId/exam-versions/:examVersionId/domains/:domainId/topics",
  async (context) => {
    const certificationId = validPathId(context, context.req.param("certificationId"));
    const examVersionId = validPathId(context, context.req.param("examVersionId"));
    const domainId = validPathId(context, context.req.param("domainId"));
    if (certificationId instanceof Response) return certificationId;
    if (examVersionId instanceof Response) return examVersionId;
    if (domainId instanceof Response) return domainId;
    const denied = await requireMutation(context, certificationId);
    if (denied) return denied;
    if (!(await domainExists(context, certificationId, examVersionId, domainId))) {
      return errorResponse(context, 404, "not_found");
    }
    const parsed = await readJsonBody(context, createTopicRequestSchema);
    if ("response" in parsed) return parsed.response;
    const result = await createTopic(
      context.env.DB,
      context.get("principal").tokenDigest,
      {
        ...parsed.value,
        id: crypto.randomUUID(),
        certificationId,
        examVersionId,
        domainId,
      },
      serverMetadata("create-topic"),
      context.get("principal").configuration.policy,
    );
    return resultResponse(context, result, 201, createdIdResponseSchema);
  },
);

protectedApi.post(
  "/certifications/:certificationId/exam-versions/:examVersionId/questions",
  async (context) => {
    const certificationId = validPathId(context, context.req.param("certificationId"));
    const examVersionId = validPathId(context, context.req.param("examVersionId"));
    if (certificationId instanceof Response) return certificationId;
    if (examVersionId instanceof Response) return examVersionId;
    const denied = await requireMutation(context, certificationId);
    if (denied) return denied;
    if (!(await examVersionExists(context, certificationId, examVersionId))) {
      return errorResponse(context, 404, "not_found");
    }
    const parsed = await readJsonBody(
      context,
      createQuestionRequestSchema,
      QUESTION_JSON_BODY_MAX_BYTES,
    );
    if ("response" in parsed) return parsed.response;
    const result = await createDraftQuestion(
      context.env.DB,
      context.get("principal").tokenDigest,
      {
        ...parsed.value,
        certificationId,
        examVersionId,
      },
      serverMetadata("create-question-draft"),
      context.get("principal").configuration.policy,
    );
    return resultResponse(context, result, 201, createdDraftResponseSchema);
  },
);

protectedApi.post(
  "/certifications/:certificationId/exam-versions/:examVersionId/questions/:questionId/revisions",
  async (context) => {
    const certificationId = validPathId(context, context.req.param("certificationId"));
    const examVersionId = validPathId(context, context.req.param("examVersionId"));
    const questionId = validPathId(context, context.req.param("questionId"));
    if (certificationId instanceof Response) return certificationId;
    if (examVersionId instanceof Response) return examVersionId;
    if (questionId instanceof Response) return questionId;
    const denied = await requireMutation(context, certificationId);
    if (denied) return denied;
    if (!(await questionIdentityExists(context, certificationId, questionId))) {
      return errorResponse(context, 404, "not_found");
    }
    const parsed = await readJsonBody(
      context,
      createQuestionRevisionRequestSchema,
      QUESTION_JSON_BODY_MAX_BYTES,
    );
    if ("response" in parsed) return parsed.response;
    const result = await createQuestionRevision(
      context.env.DB,
      context.get("principal").tokenDigest,
      {
        ...parsed.value,
        certificationId,
        examVersionId,
        questionId,
      },
      serverMetadata("create-question-revision"),
      context.get("principal").configuration.policy,
    );
    return resultResponse(context, result, 201, createdRevisionResponseSchema);
  },
);

protectedApi.get(
  "/certifications/:certificationId/exam-versions/:examVersionId/questions/:questionId/revisions/:revisionId",
  async (context) => {
    const certificationId = validPathId(context, context.req.param("certificationId"));
    const examVersionId = validPathId(context, context.req.param("examVersionId"));
    const questionId = validPathId(context, context.req.param("questionId"));
    const revisionId = validPathId(context, context.req.param("revisionId"));
    if (certificationId instanceof Response) return certificationId;
    if (examVersionId instanceof Response) return examVersionId;
    if (questionId instanceof Response) return questionId;
    if (revisionId instanceof Response) return revisionId;
    const denied = await requireCertification(context, certificationId);
    if (denied) return denied;
    if (!(await exactRevisionExists(context, {
      certificationId,
      examVersionId,
      questionId,
      revisionId,
    }))) {
      return errorResponse(context, 404, "not_found");
    }
    const result = await getQuestionRevision(
      context.env.DB,
      context.get("principal").tokenDigest,
      { certificationId, revisionId },
      Date.now(),
      context.get("principal").configuration.policy,
    );
    if (!result.ok) return contentError(context, result.reason);
    if (
      result.value.examVersionId !== examVersionId ||
      result.value.questionId !== questionId
    ) {
      return errorResponse(context, 404, "not_found");
    }
    return context.json(questionRevisionResponseSchema.parse(result.value));
  },
);

protectedApi.get(
  "/certifications/:certificationId/exam-versions/:examVersionId/questions/:questionId/publication",
  async (context) => {
    const certificationId = validPathId(context, context.req.param("certificationId"));
    const examVersionId = validPathId(context, context.req.param("examVersionId"));
    const questionId = validPathId(context, context.req.param("questionId"));
    if (certificationId instanceof Response) return certificationId;
    if (examVersionId instanceof Response) return examVersionId;
    if (questionId instanceof Response) return questionId;
    const denied = await requireCertification(context, certificationId);
    if (denied) return denied;
    if (!(await questionExistsInVersion(context, certificationId, examVersionId, questionId))) {
      return errorResponse(context, 404, "not_found");
    }
    const publication = await getQuestionPublication(context.env.DB, {
      certificationId,
      examVersionId,
      questionId,
      tokenDigest: context.get("principal").tokenDigest,
      now: Date.now(),
      policy: context.get("principal").configuration.policy,
    });
    if (!publication) return errorResponse(context, 404, "not_found");
    return context.json(questionPublicationResponseSchema.parse(publication));
  },
);

protectedApi.post(
  "/certifications/:certificationId/exam-versions/:examVersionId/questions/:questionId/revisions/:revisionId/submit",
  async (context) => {
    const certificationId = validPathId(context, context.req.param("certificationId"));
    const examVersionId = validPathId(context, context.req.param("examVersionId"));
    const questionId = validPathId(context, context.req.param("questionId"));
    const revisionId = validPathId(context, context.req.param("revisionId"));
    if (certificationId instanceof Response) return certificationId;
    if (examVersionId instanceof Response) return examVersionId;
    if (questionId instanceof Response) return questionId;
    if (revisionId instanceof Response) return revisionId;
    const denied = await requireMutation(context, certificationId);
    if (denied) return denied;
    if (!(await exactRevisionExists(context, { certificationId, examVersionId, questionId, revisionId }))) {
      return errorResponse(context, 404, "not_found");
    }
    const parsed = await readJsonBody(context, emptyMutationRequestSchema);
    if ("response" in parsed) return parsed.response;
    return resultResponse(
      context,
      await submitQuestionForReview(
        context.env.DB,
        context.get("principal").tokenDigest,
        { certificationId, revisionId },
        serverMetadata("submit-question-review"),
        context.get("principal").configuration.policy,
      ),
      200,
      revisionIdResponseSchema,
    );
  },
);

protectedApi.post(
  "/certifications/:certificationId/exam-versions/:examVersionId/questions/:questionId/revisions/:revisionId/review",
  async (context) => {
    const certificationId = validPathId(context, context.req.param("certificationId"));
    const examVersionId = validPathId(context, context.req.param("examVersionId"));
    const questionId = validPathId(context, context.req.param("questionId"));
    const revisionId = validPathId(context, context.req.param("revisionId"));
    if (certificationId instanceof Response) return certificationId;
    if (examVersionId instanceof Response) return examVersionId;
    if (questionId instanceof Response) return questionId;
    if (revisionId instanceof Response) return revisionId;
    const denied = await requireMutation(context, certificationId);
    if (denied) return denied;
    if (!(await exactRevisionExists(context, { certificationId, examVersionId, questionId, revisionId }))) {
      return errorResponse(context, 404, "not_found");
    }
    const parsed = await readJsonBody(context, questionReviewRequestSchema);
    if ("response" in parsed) return parsed.response;
    return resultResponse(
      context,
      await recordQuestionReview(
        context.env.DB,
        context.get("principal").tokenDigest,
        { certificationId, revisionId, ...parsed.value },
        serverMetadata("review-question"),
        context.get("principal").configuration.policy,
      ),
      201,
      reviewIdResponseSchema,
    );
  },
);

protectedApi.post(
  "/certifications/:certificationId/exam-versions/:examVersionId/questions/:questionId/publish",
  async (context) => {
    const certificationId = validPathId(context, context.req.param("certificationId"));
    const examVersionId = validPathId(context, context.req.param("examVersionId"));
    const questionId = validPathId(context, context.req.param("questionId"));
    if (certificationId instanceof Response) return certificationId;
    if (examVersionId instanceof Response) return examVersionId;
    if (questionId instanceof Response) return questionId;
    const denied = await requireMutation(context, certificationId);
    if (denied) return denied;
    if (!(await questionExistsInVersion(context, certificationId, examVersionId, questionId))) {
      return errorResponse(context, 404, "not_found");
    }
    const parsed = await readJsonBody(context, publishQuestionRequestSchema);
    if ("response" in parsed) return parsed.response;
    const result = await publishQuestionRevision(
      context.env.DB,
      context.get("principal").tokenDigest,
      {
        ...parsed.value,
        certificationId,
        examVersionId,
        questionId,
      },
      serverMetadata("publish-question"),
      context.get("principal").configuration.policy,
    );
    return resultResponse(context, result, 200, pointerVersionResponseSchema);
  },
);

protectedApi.post(
  "/certifications/:certificationId/exam-versions/:examVersionId/questions/:questionId/retire",
  async (context) => {
    const certificationId = validPathId(context, context.req.param("certificationId"));
    const examVersionId = validPathId(context, context.req.param("examVersionId"));
    const questionId = validPathId(context, context.req.param("questionId"));
    if (certificationId instanceof Response) return certificationId;
    if (examVersionId instanceof Response) return examVersionId;
    if (questionId instanceof Response) return questionId;
    const denied = await requireMutation(context, certificationId);
    if (denied) return denied;
    if (!(await questionExistsInVersion(context, certificationId, examVersionId, questionId))) {
      return errorResponse(context, 404, "not_found");
    }
    const parsed = await readJsonBody(context, retireQuestionRequestSchema);
    if ("response" in parsed) return parsed.response;
    return resultResponse(
      context,
      await retirePublishedQuestion(
        context.env.DB,
        context.get("principal").tokenDigest,
        {
          certificationId,
          examVersionId,
          questionId,
          ...parsed.value,
        },
        serverMetadata("retire-question"),
        context.get("principal").configuration.policy,
      ),
      200,
      pointerVersionResponseSchema,
    );
  },
);

protectedApi.post(
  "/certifications/:certificationId/exam-versions/:examVersionId/import-previews",
  async (context) => {
    const certificationId = validPathId(context, context.req.param("certificationId"));
    const examVersionId = validPathId(context, context.req.param("examVersionId"));
    if (certificationId instanceof Response) return certificationId;
    if (examVersionId instanceof Response) return examVersionId;
    const denied = await requireMutation(context, certificationId);
    if (denied) return denied;
    if (!(await examVersionExists(context, certificationId, examVersionId))) {
      return errorResponse(context, 404, "not_found");
    }
    if (!acceptsContentType(context, "csv")) {
      return errorResponse(context, 400, "unsupported_media_type");
    }
    const body = await readBoundedBytes(context, CSV_BODY_MAX_BYTES);
    if ("response" in body) return body.response;
    const result = await previewQuestionImport(
      context.env.DB,
      {
        tokenDigest: context.get("principal").tokenDigest,
        certificationId,
        examVersionId,
        fileBytes: body.bytes,
        now: Date.now(),
      },
      context.get("principal").configuration.policy,
    );
    if (result.ok) {
      return context.json(importPreviewResponseSchema.parse(result.value), 201);
    }
    if (result.reason === "payload-too-large") {
      return errorResponse(context, 413, "payload_too_large");
    }
    if (result.errors.length > 0) {
      return errorResponse(
        context,
        result.reason === "conflict" ? 409 : result.reason === "not-found" ? 404 : 400,
        result.reason === "conflict" ? "conflict" : result.reason === "not-found" ? "not_found" : "validation_error",
        result.errors.map((issue) => ({
          path: `row.${issue.row}.${issue.code === "unknown_header" ? "header" : issue.column}`,
          code: issue.code,
        })),
        result.summary,
      );
    }
    return contentError(context, result.reason);
  },
);

protectedApi.post(
  "/certifications/:certificationId/import-previews/:importId/confirm",
  async (context) => {
    const certificationId = validPathId(context, context.req.param("certificationId"));
    const importId = validPathId(context, context.req.param("importId"));
    if (certificationId instanceof Response) return certificationId;
    if (importId instanceof Response) return importId;
    const denied = await requireMutation(context, certificationId);
    if (denied) return denied;
    const preview = await context.env.DB
      .withSession("first-primary")
      .prepare(
        `SELECT certification_id, actor_user_id
         FROM question_import_previews WHERE id = ?`,
      )
      .bind(importId)
      .first<{ certification_id: string; actor_user_id: string }>();
    if (
      !preview ||
      preview.certification_id !== certificationId ||
      preview.actor_user_id !== context.get("principal").userId
    ) {
      return errorResponse(context, 404, "not_found");
    }
    const parsed = await readJsonBody(context, emptyMutationRequestSchema);
    if ("response" in parsed) return parsed.response;
    return resultResponse(
      context,
      await confirmQuestionImport(
        context.env.DB,
        {
          tokenDigest: context.get("principal").tokenDigest,
          importId,
          now: Date.now(),
        },
        context.get("principal").configuration.policy,
      ),
      200,
      importConfirmationResponseSchema,
    );
  },
);

protectedApi.get(
  "/certifications/:certificationId/exam-versions/:examVersionId/export",
  async (context) => {
    const certificationId = validPathId(context, context.req.param("certificationId"));
    const examVersionId = validPathId(context, context.req.param("examVersionId"));
    if (certificationId instanceof Response) return certificationId;
    if (examVersionId instanceof Response) return examVersionId;
    const denied = await requireCertification(context, certificationId);
    if (denied) return denied;
    const queryEntries = [...new URL(context.req.url).searchParams.entries()];
    const queryObject: Record<string, string> = {};
    for (const [key, value] of queryEntries) {
      if (key in queryObject) return errorResponse(context, 400, "validation_error");
      queryObject[key] = value;
    }
    const query = exportQuerySchema.safeParse(queryObject);
    if (!query.success) {
      return errorResponse(context, 400, "validation_error");
    }
    const result = await exportPublishedQuestions(
      context.env.DB,
      {
        tokenDigest: context.get("principal").tokenDigest,
        certificationId,
        examVersionId,
        now: Date.now(),
        cursor: query.data.cursor,
        pageSize: query.data.limit,
      },
      context.get("principal").configuration.policy,
    );
    if (!result.ok) return contentError(context, result.reason);
    const headers = new Headers({
      "Content-Type": "text/csv; charset=utf-8",
    });
    const privateHeaders = context.res.headers;
    privateHeaders.forEach((value, key) => headers.set(key, value));
    if (result.value.nextCursor) {
      headers.set("X-Export-Next-Cursor", result.value.nextCursor);
    }
    return new Response(result.value.csv, { status: 200, headers });
  },
);

protectedApi.notFound((context) =>
  errorResponse(context, 404, "not_found"),
);

protectedApi.onError((error, context) => {
  void error;
  context.set("requestId", context.get("requestId") || crypto.randomUUID());
  configurePrivateResponse(context);
  console.error("Protected content request failed", {
    requestId: context.get("requestId"),
  });
  return errorResponse(context, 503, "service_unavailable");
});

export const protectedContentApi = protectedApi;
