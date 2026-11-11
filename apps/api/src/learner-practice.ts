import { Hono, type Context } from "hono";
import {
  practiceAnswerRequestSchema,
  practiceAttemptListQuerySchema,
  practiceAttemptListResponseSchema,
  practiceAttemptResponseSchema,
  practiceScopeResponseSchema,
  startPracticeRequestSchema,
  startTimedMockRequestSchema,
  timedMockAnswerRequestSchema,
  timedMockAttemptListResponseSchema,
  timedMockAttemptResponseSchema,
  timedMockPositionRequestSchema,
  timedMockSubmitRequestSchema,
} from "@certpath/contracts";
import type { SecurityDatabase } from "./security/database.ts";
import {
  getPracticeAttempt,
  listPracticeAttempts,
  listPracticeScopes,
  startPracticeAttempt,
  submitPracticeAnswer,
} from "./security/practice.ts";
import {
  getTimedMockAttempt,
  listTimedMockAttempts,
  saveTimedMockAnswer,
  saveTimedMockPosition,
  startTimedMock,
  submitTimedMock,
} from "./security/timed-mocks.ts";
import {
  constantTimeEqual,
  createCsrfToken,
  sessionCookieToken,
  sessionDigest,
} from "./security/http-session.ts";
import { findActiveApplicationSession } from "./security/repository.ts";

type Bindings = {
  DB: SecurityDatabase;
  PUBLIC_SITE_ORIGIN?: string;
  CSRF_HMAC_SECRET?: string;
};

interface Principal {
  userId: string;
  tokenDigest: string;
  origin: string;
  csrfSecret: Uint8Array;
}

interface Variables {
  principal: Principal;
  requestId: string;
}

type PracticeContext = Context<{ Bindings: Bindings; Variables: Variables }>;

const api = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const maxJsonBytes = 8 * 1024;
const pathIdSchema = /^[a-zA-Z0-9:_-]{1,128}$/;

function response(
  context: PracticeContext,
  status: number,
  code: string,
): Response {
  return context.json(
    { error: { code, requestId: context.get("requestId") } },
    status as 400 | 401 | 403 | 404 | 409 | 413 | 415 | 503,
  );
}

function readConfiguration(bindings: Bindings): {
  origin: string;
  csrfSecret: Uint8Array;
} | null {
  if (!bindings.PUBLIC_SITE_ORIGIN || !bindings.CSRF_HMAC_SECRET) return null;
  let url: URL;
  try {
    url = new URL(bindings.PUBLIC_SITE_ORIGIN);
  } catch {
    return null;
  }
  const secret = new TextEncoder().encode(bindings.CSRF_HMAC_SECRET);
  if (
    url.protocol !== "https:" ||
    url.origin !== bindings.PUBLIC_SITE_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    secret.byteLength < 32
  ) {
    return null;
  }
  return { origin: bindings.PUBLIC_SITE_ORIGIN, csrfSecret: secret };
}

function setPrivateHeaders(context: PracticeContext): void {
  context.header("Cache-Control", "private, no-store, max-age=0");
  context.header("Pragma", "no-cache");
  context.header("X-Robots-Tag", "noindex, nofollow");
  context.header("X-Request-Id", context.get("requestId"));
}

api.use("*", async (context, next) => {
  context.set("requestId", crypto.randomUUID());
  setPrivateHeaders(context);
  const configuration = readConfiguration(context.env);
  if (!configuration) return response(context, 503, "service_unavailable");
  const rawToken = sessionCookieToken(context.req.header("Cookie") ?? null);
  if (!rawToken) return response(context, 401, "unauthenticated");
  const tokenDigest = await sessionDigest(rawToken);
  const session = await findActiveApplicationSession(
    context.env.DB,
    tokenDigest,
    Date.now(),
  );
  if (!session) return response(context, 401, "unauthenticated");
  context.set("principal", {
    userId: session.userId,
    tokenDigest,
    ...configuration,
  });
  await next();
});

async function protectMutation(
  context: PracticeContext,
): Promise<Response | null> {
  const principal = context.get("principal");
  if (
    context.req.header("Origin") !== principal.origin ||
    new URL(context.req.url).origin !== principal.origin
  ) {
    return response(context, 400, "invalid_origin");
  }
  const supplied = context.req.header("X-CSRF-Token");
  if (!supplied || supplied.length > 64) {
    return response(context, 400, "invalid_csrf");
  }
  const expected = await createCsrfToken(
    principal.origin,
    principal.tokenDigest,
    principal.csrfSecret,
  );
  return constantTimeEqual(supplied, expected)
    ? null
    : response(context, 400, "invalid_csrf");
}

async function readJson<T>(
  context: PracticeContext,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<{ value: T } | { response: Response }> {
  const contentType = context.req.header("Content-Type")?.trim().toLowerCase();
  if (
    contentType !== "application/json" &&
    contentType !== "application/json; charset=utf-8"
  ) {
    return { response: response(context, 415, "unsupported_media_type") };
  }
  const length = context.req.header("Content-Length");
  if (length !== undefined) {
    if (!/^\d+$/.test(length)) {
      return { response: response(context, 400, "validation_error") };
    }
    if (Number(length) > maxJsonBytes) {
      return { response: response(context, 413, "payload_too_large") };
    }
  }
  const body = context.req.raw.body;
  if (!body) return { response: response(context, 400, "validation_error") };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > maxJsonBytes) {
      await reader.cancel();
      return { response: response(context, 413, "payload_too_large") };
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { response: response(context, 400, "validation_error") };
  }
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { value: parsed.data }
    : { response: response(context, 400, "validation_error") };
}

function operationFailure(
  context: PracticeContext,
  reason: string,
): Response {
  if (reason === "access-required") {
    return response(context, 403, "access_required");
  }
  if (reason === "not-found") return response(context, 404, "not_found");
  if (reason === "insufficient-questions") {
    return response(context, 409, "insufficient_questions");
  }
  if (reason === "deadline") {
    return response(context, 409, "deadline_reached");
  }
  if (reason === "invalid-answer") {
    return response(context, 400, "validation_error");
  }
  if (reason === "not-configured") {
    return response(context, 409, "mock_not_configured");
  }
  return response(context, 409, "conflict");
}

api.get("/csrf", async (context) => {
  const principal = context.get("principal");
  const suppliedOrigin = context.req.header("Origin");
  if (
    new URL(context.req.url).origin !== principal.origin ||
    (suppliedOrigin !== undefined && suppliedOrigin !== principal.origin)
  ) {
    return response(context, 400, "invalid_origin");
  }
  return context.json({
    csrfToken: await createCsrfToken(
      principal.origin,
      principal.tokenDigest,
      principal.csrfSecret,
    ),
  });
});

api.get("/scopes", async (context) => {
  const principal = context.get("principal");
  const result = await listPracticeScopes(
    context.env.DB,
    principal.userId,
    principal.tokenDigest,
    Date.now(),
  );
  return context.json(practiceScopeResponseSchema.parse(result));
});

api.get("/attempts", async (context) => {
  const entries = [...new URL(context.req.url).searchParams.entries()];
  if (entries.length !== 2 || new Set(entries.map(([key]) => key)).size !== 2) {
    return response(context, 400, "validation_error");
  }
  const parsed = practiceAttemptListQuerySchema.safeParse(
    Object.fromEntries(entries),
  );
  if (!parsed.success) return response(context, 400, "validation_error");
  const principal = context.get("principal");
  const result = await listPracticeAttempts(
    context.env.DB,
    principal.userId,
    principal.tokenDigest,
    parsed.data.certificationId,
    parsed.data.examVersionId,
    Date.now(),
  );
  if (!result.ok) return operationFailure(context, result.reason);
  return context.json(practiceAttemptListResponseSchema.parse(result.value));
});

api.post("/attempts", async (context) => {
  const denied = await protectMutation(context);
  if (denied) return denied;
  const parsed = await readJson(context, startPracticeRequestSchema);
  if ("response" in parsed) return parsed.response;
  const principal = context.get("principal");
  const result = await startPracticeAttempt(
    context.env.DB,
    principal.userId,
    principal.tokenDigest,
    parsed.value,
    Date.now(),
  );
  if (!result.ok) return operationFailure(context, result.reason);
  return context.json(practiceAttemptResponseSchema.parse(result.value), 201);
});

api.get("/attempts/:attemptId", async (context) => {
  const attemptId = context.req.param("attemptId");
  if (!pathIdSchema.test(attemptId)) {
    return response(context, 404, "not_found");
  }
  const principal = context.get("principal");
  const result = await getPracticeAttempt(
    context.env.DB,
    principal.userId,
    principal.tokenDigest,
    attemptId,
    Date.now(),
  );
  if (!result.ok) return operationFailure(context, result.reason);
  return context.json(practiceAttemptResponseSchema.parse(result.value));
});

api.post("/attempts/:attemptId/answers", async (context) => {
  const attemptId = context.req.param("attemptId");
  if (!pathIdSchema.test(attemptId)) {
    return response(context, 404, "not_found");
  }
  const denied = await protectMutation(context);
  if (denied) return denied;
  const parsed = await readJson(context, practiceAnswerRequestSchema);
  if ("response" in parsed) return parsed.response;
  const principal = context.get("principal");
  const result = await submitPracticeAnswer(
    context.env.DB,
    principal.userId,
    principal.tokenDigest,
    attemptId,
    parsed.value,
    Date.now(),
  );
  if (!result.ok) return operationFailure(context, result.reason);
  return context.json(practiceAttemptResponseSchema.parse(result.value));
});

api.get("/mocks", async (context) => {
  const entries = [...new URL(context.req.url).searchParams.entries()];
  if (entries.length !== 2 || new Set(entries.map(([key]) => key)).size !== 2) {
    return response(context, 400, "validation_error");
  }
  const parsed = practiceAttemptListQuerySchema.safeParse(
    Object.fromEntries(entries),
  );
  if (!parsed.success) return response(context, 400, "validation_error");
  const principal = context.get("principal");
  const result = await listTimedMockAttempts(
    context.env.DB,
    principal.userId,
    principal.tokenDigest,
    parsed.data.certificationId,
    parsed.data.examVersionId,
    Date.now(),
  );
  if (!result.ok) return operationFailure(context, result.reason);
  return context.json(timedMockAttemptListResponseSchema.parse(result.value));
});

api.post("/mocks", async (context) => {
  const denied = await protectMutation(context);
  if (denied) return denied;
  const parsed = await readJson(context, startTimedMockRequestSchema);
  if ("response" in parsed) return parsed.response;
  const principal = context.get("principal");
  const result = await startTimedMock(
    context.env.DB,
    principal.userId,
    principal.tokenDigest,
    parsed.value,
    Date.now(),
  );
  if (!result.ok) return operationFailure(context, result.reason);
  return context.json(timedMockAttemptResponseSchema.parse(result.value), 201);
});

api.get("/mocks/:attemptId", async (context) => {
  const attemptId = context.req.param("attemptId");
  if (!pathIdSchema.test(attemptId)) {
    return response(context, 404, "not_found");
  }
  const principal = context.get("principal");
  const result = await getTimedMockAttempt(
    context.env.DB,
    principal.userId,
    principal.tokenDigest,
    attemptId,
    Date.now(),
  );
  if (!result.ok) return operationFailure(context, result.reason);
  return context.json(timedMockAttemptResponseSchema.parse(result.value));
});

api.post("/mocks/:attemptId/answers", async (context) => {
  const attemptId = context.req.param("attemptId");
  if (!pathIdSchema.test(attemptId)) {
    return response(context, 404, "not_found");
  }
  const denied = await protectMutation(context);
  if (denied) return denied;
  const parsed = await readJson(context, timedMockAnswerRequestSchema);
  if ("response" in parsed) return parsed.response;
  const principal = context.get("principal");
  const result = await saveTimedMockAnswer(
    context.env.DB,
    principal.userId,
    principal.tokenDigest,
    attemptId,
    parsed.value,
    Date.now(),
  );
  if (!result.ok) return operationFailure(context, result.reason);
  return context.json(timedMockAttemptResponseSchema.parse(result.value));
});

api.post("/mocks/:attemptId/position", async (context) => {
  const attemptId = context.req.param("attemptId");
  if (!pathIdSchema.test(attemptId)) {
    return response(context, 404, "not_found");
  }
  const denied = await protectMutation(context);
  if (denied) return denied;
  const parsed = await readJson(context, timedMockPositionRequestSchema);
  if ("response" in parsed) return parsed.response;
  const principal = context.get("principal");
  const result = await saveTimedMockPosition(
    context.env.DB,
    principal.userId,
    principal.tokenDigest,
    attemptId,
    parsed.value,
    Date.now(),
  );
  if (!result.ok) return operationFailure(context, result.reason);
  return context.json(timedMockAttemptResponseSchema.parse(result.value));
});

api.post("/mocks/:attemptId/submit", async (context) => {
  const attemptId = context.req.param("attemptId");
  if (!pathIdSchema.test(attemptId)) {
    return response(context, 404, "not_found");
  }
  const denied = await protectMutation(context);
  if (denied) return denied;
  const parsed = await readJson(context, timedMockSubmitRequestSchema);
  if ("response" in parsed) return parsed.response;
  const principal = context.get("principal");
  const result = await submitTimedMock(
    context.env.DB,
    principal.userId,
    principal.tokenDigest,
    attemptId,
    parsed.value,
    Date.now(),
  );
  if (!result.ok) return operationFailure(context, result.reason);
  return context.json(timedMockAttemptResponseSchema.parse(result.value));
});

api.notFound((context) => response(context, 404, "not_found"));

api.onError((error, context) => {
  void error;
  setPrivateHeaders(context);
  console.error("Learner practice request failed", {
    requestId: context.get("requestId"),
  });
  return response(context, 503, "service_unavailable");
});

export const learnerPracticeApi = api;
