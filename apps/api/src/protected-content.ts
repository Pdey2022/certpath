import { Hono, type Context } from "hono";
import {
  createdDraftResponseSchema,
  createdIdResponseSchema,
  createdRevisionResponseSchema,
  certificationListResponseSchema,
  csrfResponseSchema,
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
import type { SecurityDatabase } from "./security/database.ts";
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
import {
  confirmQuestionImport,
  exportPublishedQuestions,
  previewQuestionImport,
  QUESTION_IMPORT_MAX_BYTES,
} from "./security/question-imports.ts";
import type { StaffMfaPolicy } from "./security/mfa.ts";
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
  authorizeStaffSession,
  findActiveApplicationSession,
} from "./security/repository.ts";

type ApiBindings = {
  DB: SecurityDatabase;
  PUBLIC_SITE_ORIGIN?: string;
  STAFF_MFA_MAX_AGE_MS?: string;
  STAFF_MFA_ALLOWED_METHODS?: string;
  CSRF_HMAC_SECRET?: string;
};

interface SecurityConfiguration {
  origin: string;
  policy: StaffMfaPolicy;
  csrfSecret: Uint8Array;
}

interface RequestPrincipal {
  tokenDigest: string;
  userId: string;
  configuration: SecurityConfiguration;
}

interface ProtectedVariables {
  principal: RequestPrincipal;
  requestId: string;
}

type ProtectedContext = Context<{
  Bindings: ApiBindings;
  Variables: ProtectedVariables;
}>;

const SESSION_COOKIE = "certpath_session";
const SMALL_JSON_BODY_MAX_BYTES = 24 * 1024;
const QUESTION_JSON_BODY_MAX_BYTES = 256 * 1024;
const CSV_BODY_MAX_BYTES = QUESTION_IMPORT_MAX_BYTES;

function errorResponse(
  context: ProtectedContext,
  status: number,
  code: string,
  issues?: Array<{ path: string; code: string }>,
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
      },
    }),
    { status, headers },
  );
}

function readSecurityConfiguration(bindings: ApiBindings): SecurityConfiguration | null {
  const originValue = bindings.PUBLIC_SITE_ORIGIN;
  const ageValue = bindings.STAFF_MFA_MAX_AGE_MS;
  const methodsValue = bindings.STAFF_MFA_ALLOWED_METHODS;
  const secretValue = bindings.CSRF_HMAC_SECRET;
  if (!originValue || !ageValue || !methodsValue || !secretValue) return null;

  let origin: URL;
  try {
    origin = new URL(originValue);
  } catch {
    return null;
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== originValue ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    return null;
  }
  if (!/^[1-9]\d*$/.test(ageValue)) return null;
  const maxAgeMs = Number(ageValue);
  if (!Number.isSafeInteger(maxAgeMs)) return null;

  const methodValues = methodsValue.split(",").map((method) => method.trim());
  const allowed = new Set(["totp", "webauthn", "sms"]);
  if (
    methodValues.length === 0 ||
    methodValues.some((method) => !allowed.has(method)) ||
    new Set(methodValues).size !== methodValues.length
  ) {
    return null;
  }
  const csrfSecret = new TextEncoder().encode(secretValue);
  if (csrfSecret.byteLength < 32) return null;
  return {
    origin: originValue,
    policy: {
      maxAgeMs,
      allowedMethods: methodValues as StaffMfaPolicy["allowedMethods"],
    },
    csrfSecret,
  };
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=";
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength !== 32) return null;
    const canonical = btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    return canonical === value ? bytes : null;
  } catch {
    return null;
  }
}

function sessionCookieToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const matches = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(SESSION_COOKIE.length + 1);
  return decodeBase64Url(value) ? value : null;
}

async function sessionDigest(rawToken: string): Promise<string> {
  const bytes = decodeBase64Url(rawToken);
  if (!bytes) throw new Error("Invalid opaque session token");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", arrayBuffer(bytes)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function csrfToken(principal: RequestPrincipal): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    arrayBuffer(principal.configuration.csrfSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = `certpath-csrf-v1\n${principal.configuration.origin}\n${principal.tokenDigest}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      arrayBuffer(new TextEncoder().encode(payload)),
    ),
  );
  return `v1.${base64Url(signature)}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
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
  const configuration = readSecurityConfiguration(context.env);
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
          path: `row.${issue.row}.${issue.column}`,
          code: issue.code,
        })),
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
