import { Hono, type Context } from "hono";
import {
  proEnablementMutationResponseSchema,
  proEnablementRequestSchema,
  proEnablementResponseSchema,
} from "@certpath/contracts";
import type { SecurityDatabase } from "./security/database.ts";
import {
  requireCapability,
  type StaffRequester,
} from "./security/staff-request.ts";
import {
  readStaffSecurityConfiguration,
  type StaffSecurityBindings,
  type StaffSecurityConfiguration,
} from "./security/staff-configuration.ts";
import {
  constantTimeEqual,
  createCsrfToken,
} from "./security/http-session.ts";
import {
  readProEnablementDetail,
  recordProEnablement,
  type ProEnablementWriteFailure,
} from "./security/pro-enablement.ts";

// The admin commerce surface for this phase: Pro enablement, read and write.
//
// This is a **commercial** act, not a content one, so it is Global Admin only
// and uses `globalAdminGuard` inside the write. `certificationGuard` is
// deliberately not used: it admits an assigned Manager.
//
// `commerce.read` guards the read and `access.grant` the write - both already
// exist in the capability matrix and both are Global Admin only, so this router
// adds no capability names. Every response is private, non-indexable and carries
// a request id, mirroring the learner-support surface.
//
// Rules: docs/decisions/0003-pricing-pro-and-refunds.md,
// docs/decisions/0004-staff-capabilities-and-learner-data.md and
// docs/admin-capabilities.md.

type ApiBindings = StaffSecurityBindings & {
  DB: SecurityDatabase;
};

interface AdminCommerceVariables {
  requestId: string;
  configuration: StaffSecurityConfiguration;
}

type AdminCommerceContext = Context<{
  Bindings: ApiBindings;
  Variables: AdminCommerceVariables;
}>;

const SMALL_JSON_BODY_MAX_BYTES = 24 * 1024;

function errorResponse(
  context: AdminCommerceContext,
  status: number,
  code: string,
): Response {
  const headers = new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Request-Id": context.get("requestId"),
    Pragma: "no-cache",
    "Content-Type": "application/json; charset=utf-8",
  });
  return new Response(
    JSON.stringify({ error: { code, requestId: context.get("requestId") } }),
    { status, headers },
  );
}

function validationResponse(
  context: AdminCommerceContext,
  issues: Array<{ path: PropertyKey[]; code: string }>,
): Response {
  const headers = new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Request-Id": context.get("requestId"),
    Pragma: "no-cache",
    "Content-Type": "application/json; charset=utf-8",
  });
  return new Response(
    JSON.stringify({
      error: {
        code: "validation_error",
        requestId: context.get("requestId"),
        issues: issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          code: issue.code,
        })),
      },
    }),
    { status: 400, headers },
  );
}

async function readJsonBody<T>(
  context: AdminCommerceContext,
  schema: {
    safeParse: (
      input: unknown,
    ) =>
      | { success: true; data: T }
      | {
          success: false;
          error: { issues: Array<{ path: PropertyKey[]; code: string }> };
        };
  },
): Promise<{ value: T } | { response: Response }> {
  const contentType = context.req.header("Content-Type")?.trim().toLowerCase();
  if (
    contentType !== "application/json" &&
    contentType !== "application/json; charset=utf-8"
  ) {
    return { response: errorResponse(context, 400, "unsupported_media_type") };
  }
  const declaredLength = context.req.header("Content-Length");
  if (declaredLength !== undefined) {
    if (!/^\d+$/.test(declaredLength)) {
      return { response: errorResponse(context, 400, "invalid_content_length") };
    }
    if (Number(declaredLength) > SMALL_JSON_BODY_MAX_BYTES) {
      return { response: errorResponse(context, 413, "payload_too_large") };
    }
  }
  const raw = context.req.raw.body;
  if (!raw) return { response: errorResponse(context, 400, "validation_error") };

  const reader = raw.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > SMALL_JSON_BODY_MAX_BYTES) {
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
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { response: errorResponse(context, 400, "validation_error") };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { response: validationResponse(context, parsed.error.issues) };
  }
  return { value: parsed.data };
}

function writeFailureResponse(
  context: AdminCommerceContext,
  reason: ProEnablementWriteFailure,
): Response {
  switch (reason) {
    case "invalid-input":
      return errorResponse(context, 400, "validation_error");
    case "unauthorized":
      return errorResponse(context, 401, "unauthenticated");
    case "certification-not-found":
      return errorResponse(context, 404, "certification_not_found");
    case "conflict":
      return errorResponse(context, 409, "conflict");
  }
}

function validPathId(
  context: AdminCommerceContext,
  value: string,
): string | Response {
  return /^[a-zA-Z0-9:_-]{1,128}$/.test(value)
    ? value
    : errorResponse(context, 400, "validation_error");
}

function requirementFailureResponse(
  context: AdminCommerceContext,
  reason: string,
): Response {
  switch (reason) {
    case "invalid-session":
    case "not-staff":
      return errorResponse(context, 401, "unauthenticated");
    case "mfa-policy-unconfigured":
    case "mfa-policy-invalid":
      return errorResponse(context, 503, "service_unavailable");
    case "insufficient-role":
    case "unknown-capability":
    case "resource-kind-mismatch":
      return errorResponse(context, 403, "insufficient_role");
    default:
      return errorResponse(context, 403, "insufficient_role");
  }
}

async function requireAdmin(
  context: AdminCommerceContext,
  capability: "commerce.read" | "access.grant",
  nowMs: number,
): Promise<{ requester: StaffRequester } | { response: Response }> {
  const result = await requireCapability(
    context.env.DB,
    context.req.header("Cookie") ?? null,
    capability,
    { kind: "platform" },
    nowMs,
    context.get("configuration").policy,
  );
  return result.ok
    ? { requester: result.requester }
    : { response: requirementFailureResponse(context, result.reason) };
}

async function mutationProtection(
  context: AdminCommerceContext,
  requester: StaffRequester,
): Promise<Response | null> {
  const configuration = context.get("configuration");
  if (
    context.req.header("Origin") !== configuration.origin ||
    new URL(context.req.url).origin !== configuration.origin
  ) {
    return errorResponse(context, 400, "invalid_origin");
  }
  const supplied = context.req.header("X-CSRF-Token");
  if (!supplied || supplied.length > 64) {
    return errorResponse(context, 400, "invalid_csrf");
  }
  const expected = await createCsrfToken(
    configuration.origin,
    requester.tokenDigest,
    configuration.csrfSecret,
  );
  return constantTimeEqual(supplied, expected)
    ? null
    : errorResponse(context, 400, "invalid_csrf");
}

export function createAdminCommerceApi(now: () => number = Date.now) {
  const api = new Hono<{
    Bindings: ApiBindings;
    Variables: AdminCommerceVariables;
  }>();

  api.use("*", async (context, next) => {
    context.set("requestId", crypto.randomUUID());
    context.header("Cache-Control", "private, no-store, max-age=0");
    context.header("X-Robots-Tag", "noindex, nofollow");
    context.header("Pragma", "no-cache");
    context.header("X-Request-Id", context.get("requestId"));
    const configuration = readStaffSecurityConfiguration(context.env);
    if (!configuration) {
      return errorResponse(context, 503, "service_unavailable");
    }
    context.set("configuration", configuration);
    await next();
  });

  api.get(
    "/certifications/:certificationId/pro-enablement",
    async (context) => {
      const certificationId = validPathId(
        context,
        context.req.param("certificationId"),
      );
      if (certificationId instanceof Response) return certificationId;
      const admin = await requireAdmin(context, "commerce.read", now());
      if ("response" in admin) return admin.response;

      const detail = await readProEnablementDetail(
        context.env.DB,
        certificationId,
      );
      if (!detail) {
        return errorResponse(context, 404, "certification_not_found");
      }
      return context.json(
        proEnablementResponseSchema.parse({
          certificationId,
          enabled: detail.record?.enabled ?? false,
          effectiveAt: detail.record?.effectiveAt ?? null,
          history: detail.history,
        }),
      );
    },
  );

  api.post(
    "/certifications/:certificationId/pro-enablement",
    async (context) => {
      const certificationId = validPathId(
        context,
        context.req.param("certificationId"),
      );
      if (certificationId instanceof Response) return certificationId;
      const admin = await requireAdmin(context, "access.grant", now());
      if ("response" in admin) return admin.response;
      const csrfFailure = await mutationProtection(context, admin.requester);
      if (csrfFailure) return csrfFailure;

      const body = await readJsonBody(context, proEnablementRequestSchema);
      if ("response" in body) return body.response;

      const operationId = `api:pro-enablement:${crypto.randomUUID()}`;
      const applied = await recordProEnablement(context.env.DB, {
        actor: {
          tokenDigest: admin.requester.tokenDigest,
          userId: admin.requester.userId,
        },
        certificationId,
        mutation: {
          enabled: body.value.enabled,
          reason: body.value.reason,
          operationId,
          now: now(),
        },
        policy: context.get("configuration").policy,
      });
      if (!applied.ok) return writeFailureResponse(context, applied.reason);
      return context.json(
        proEnablementMutationResponseSchema.parse({
          certificationId,
          enabled: applied.record.enabled,
          effectiveAt: applied.record.effectiveAt,
          operationId: applied.operationId,
        }),
      );
    },
  );

  return api;
}
