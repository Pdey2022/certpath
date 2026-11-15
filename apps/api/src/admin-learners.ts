import { Hono, type Context } from "hono";
import {
  adminCapabilitiesResponseSchema,
  csrfResponseSchema,
  emptyMutationRequestSchema,
  learnerContactCorrectionRequestSchema,
  learnerContactCorrectionResponseSchema,
  learnerContactRevealResponseSchema,
  learnerDeactivateRequestSchema,
  learnerDeactivateResponseSchema,
  learnerLookupRequestSchema,
  learnerLookupResponseSchema,
  learnerSupportHistoryQuerySchema,
  learnerSupportHistoryResponseSchema,
  maskedLearnerRecordSchema,
} from "@certpath/contracts";
import type { SecurityDatabase } from "./security/database.ts";
import {
  capabilitiesForRole,
  type CapabilityResource,
} from "./security/capabilities.ts";
import type { StaffRequestFailure } from "./security/staff-request.ts";
import {
  findStaffRoleRecord,
  requireCapability,
  type StaffRequester,
} from "./security/staff-request.ts";
import {
  contactHeldByAnotherLearner,
  correctLearnerContact,
  deactivateLearner,
  findLearnerUserIdByEmail,
  hasPasswordCredential,
  learnerAccountStatus,
  learnerSubjectExists,
  listLearnerSupportHistory,
  maskEmail,
  readMaskedLearnerRecord,
  readStoredCredentialEmail,
  recordLearnerView,
  revealLearnerContact,
  type LearnerAccessFailure,
} from "./security/learner-access.ts";
import { authorizeStaffSession } from "./security/repository.ts";
import { normalizeEmail } from "./security/local-learner-request.ts";
import {
  readStaffSecurityConfiguration,
  type StaffSecurityBindings,
  type StaffSecurityConfiguration,
} from "./security/staff-configuration.ts";
import {
  constantTimeEqual,
  createCsrfToken,
  sessionCookieToken,
  sessionDigest,
} from "./security/http-session.ts";

// Learner support for the two staff roles.
//
// Every route re-validates the live session, the active role, the MFA assurance
// and the capability before it reads or writes anything, and every write carries
// the same checks again inside its own SQL statement.
//
// There is no UI here and no list, enumeration or export: a lookup returns zero
// or one record. An address never appears in a URL - lookups are POST - and never
// appears in a response except the audited reveal.
//
// Rules: docs/admin-capabilities.md and docs/permissions.md.

type ApiBindings = StaffSecurityBindings & {
  DB: SecurityDatabase;
};

interface RequestPrincipal {
  tokenDigest: string;
  userId: string;
  configuration: StaffSecurityConfiguration;
}

interface AdminLearnerVariables {
  principal: RequestPrincipal;
  requestId: string;
}

type AdminLearnerContext = Context<{
  Bindings: ApiBindings;
  Variables: AdminLearnerVariables;
}>;

const SMALL_JSON_BODY_MAX_BYTES = 24 * 1024;

/**
 * No transport exists in this phase, and no binding can turn one on by
 * configuration drift. Both email actions therefore answer 409
 * `email_unavailable`: minting a token that cannot be delivered would leave a
 * live credential with no legitimate reader.
 */
function supportEmailConfigured(_bindings: ApiBindings): boolean {
  return false;
}

function errorResponse(
  context: AdminLearnerContext,
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
  context: AdminLearnerContext,
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

async function csrfToken(principal: RequestPrincipal): Promise<string> {
  return createCsrfToken(
    principal.configuration.origin,
    principal.tokenDigest,
    principal.configuration.csrfSecret,
  );
}

async function mutationProtection(
  context: AdminLearnerContext,
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

async function readJsonBody<T>(
  context: AdminLearnerContext,
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

function staffFailureResponse(
  context: AdminLearnerContext,
  reason: StaffRequestFailure | LearnerAccessFailure,
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
      return errorResponse(context, 403, "forbidden");
    case "certification-not-found":
    case "certification-unassigned":
    case "learner-not-found":
    case "not-found":
      return errorResponse(context, 404, "not_found");
    case "invalid-input":
      return errorResponse(context, 400, "validation_error");
    case "contact-not-available":
      return errorResponse(context, 409, "contact_not_available");
    case "contact-unchanged":
      return errorResponse(context, 409, "contact_unchanged");
    case "contact-taken":
      return errorResponse(context, 409, "contact_taken");
    case "contact-not-correctable":
      return errorResponse(context, 409, "contact_not_correctable");
    case "already-deactivated":
      return errorResponse(context, 409, "already_deactivated");
    case "conflict":
      return errorResponse(context, 409, "conflict");
    default:
      return errorResponse(context, 403, "forbidden");
  }
}

async function requireStaff(
  context: AdminLearnerContext,
  capability: string,
  resource: CapabilityResource,
): Promise<{ requester: StaffRequester } | { response: Response }> {
  const result = await requireCapability(
    context.env.DB,
    context.req.header("Cookie") ?? null,
    capability,
    resource,
    Date.now(),
    context.get("principal").configuration.policy,
  );
  return result.ok
    ? { requester: result.requester }
    : { response: staffFailureResponse(context, result.reason) };
}

function validPathId(
  context: AdminLearnerContext,
  value: string,
): string | Response {
  return /^[a-zA-Z0-9:_-]{1,128}$/.test(value)
    ? value
    : errorResponse(context, 400, "validation_error");
}

function parseQuery<T>(
  context: AdminLearnerContext,
  schema: {
    safeParse(input: unknown): { success: true; data: T } | { success: false };
  },
): { value: T } | { response: Response } {
  const query: Record<string, string> = {};
  for (const [key, value] of new URL(context.req.url).searchParams.entries()) {
    if (key in query) {
      return { response: errorResponse(context, 400, "validation_error") };
    }
    query[key] = value;
  }
  const parsed = schema.safeParse(query);
  return parsed.success
    ? { value: parsed.data }
    : { response: errorResponse(context, 400, "validation_error") };
}

async function isVerifiedCredential(
  database: SecurityDatabase,
  learnerUserId: string,
): Promise<boolean> {
  const row = await database
    .withSession("first-primary")
    .prepare(
      `SELECT 1 AS verified FROM learner_password_credentials
       WHERE user_id = ? AND email_verified_at IS NOT NULL`,
    )
    .bind(learnerUserId)
    .first<{ verified: number }>();
  return row !== null;
}

const adminLearnersApi = new Hono<{
  Bindings: ApiBindings;
  Variables: AdminLearnerVariables;
}>();

// Session bootstrap for this router's own paths only. Registering it as
// `/admin/*` would also swallow `/admin/content` and `/admin/auth`, so each path
// this router owns opts in explicitly.
async function bootstrap(context: AdminLearnerContext, next: () => Promise<void>) {
  context.set("requestId", crypto.randomUUID());
  context.header("Cache-Control", "private, no-store, max-age=0");
  context.header("X-Robots-Tag", "noindex, nofollow");
  context.header("Pragma", "no-cache");
  context.header("X-Request-Id", context.get("requestId"));
  const configuration = readStaffSecurityConfiguration(context.env);
  if (!configuration) {
    return errorResponse(context, 503, "service_unavailable");
  }
  const rawToken = sessionCookieToken(context.req.header("Cookie") ?? null);
  if (!rawToken) return errorResponse(context, 401, "unauthenticated");
  const tokenDigest = await sessionDigest(rawToken);
  const now = Date.now();
  const session = await context.env.DB.withSession("first-primary")
    .prepare(
      `SELECT s.user_id AS user_id
       FROM app_sessions AS s
       JOIN users AS u ON u.id = s.user_id
       WHERE s.token_digest = ?
         AND s.revoked_at IS NULL
         AND s.expires_at > ?
         AND u.status = 'active'`,
    )
    .bind(tokenDigest, now)
    .first<{ user_id: string }>();
  if (!session) return errorResponse(context, 401, "unauthenticated");
  context.set("principal", {
    tokenDigest,
    userId: session.user_id,
    configuration,
  });
  await next();
}

adminLearnersApi.use("/csrf", bootstrap);
adminLearnersApi.use("/capabilities", bootstrap);
adminLearnersApi.use("/learners/*", bootstrap);

adminLearnersApi.get("/csrf", async (context) => {
  const principal = context.get("principal");
  const record = await findStaffRoleRecord(context.env.DB, principal.userId);
  // A CSRF token is useless without a capability, but it is still only minted
  // for an account that currently holds an active staff role.
  if (!record || !record.active) {
    return errorResponse(context, 401, "unauthenticated");
  }
  const requestOrigin = new URL(context.req.url).origin;
  const suppliedOrigin = context.req.header("Origin");
  if (
    requestOrigin !== principal.configuration.origin ||
    (suppliedOrigin !== undefined &&
      suppliedOrigin !== principal.configuration.origin)
  ) {
    return errorResponse(context, 400, "invalid_origin");
  }
  return context.json(
    csrfResponseSchema.parse({ csrfToken: await csrfToken(principal) }),
  );
});

adminLearnersApi.get("/capabilities", async (context) => {
  const principal = context.get("principal");
  const record = await findStaffRoleRecord(context.env.DB, principal.userId);
  if (!record) return errorResponse(context, 401, "unauthenticated");
  if (!record.active) return errorResponse(context, 404, "not_found");
  const authorization = await authorizeStaffSession(
    context.env.DB,
    principal.tokenDigest,
    Date.now(),
    principal.configuration.policy,
  );
  if (!authorization.allowed) {
    return staffFailureResponse(context, authorization.reason);
  }
  return context.json(
    adminCapabilitiesResponseSchema.parse({
      role: authorization.role,
      capabilities: capabilitiesForRole(authorization.role),
    }),
  );
});

adminLearnersApi.post("/learners/lookup", async (context) => {
  const staff = await requireStaff(context, "learner.lookup", {
    kind: "platform",
  });
  if ("response" in staff) return staff.response;
  // A lookup is a POST, so it carries the same origin and CSRF checks as every
  // other POST here, even though it writes nothing on a miss.
  const csrfFailure = await mutationProtection(context);
  if (csrfFailure) return csrfFailure;

  const body = await readJsonBody(context, learnerLookupRequestSchema);
  if ("response" in body) return body.response;
  const hasEmail = body.value.email !== undefined;
  const hasUserId = body.value.userId !== undefined;
  if (hasEmail === hasUserId) {
    return errorResponse(context, 400, "validation_error");
  }

  const now = Date.now();
  let learnerUserId: string | null = null;
  if (body.value.email !== undefined) {
    learnerUserId = await findLearnerUserIdByEmail(
      context.env.DB,
      normalizeEmail(body.value.email),
    );
  } else if (
    body.value.userId !== undefined &&
    (await learnerSubjectExists(context.env.DB, body.value.userId))
  ) {
    learnerUserId = body.value.userId;
  }

  const record =
    learnerUserId === null
      ? null
      : await readMaskedLearnerRecord(context.env.DB, learnerUserId, now);
  if (learnerUserId === null || record === null) {
    return context.json(learnerLookupResponseSchema.parse({ items: [] }));
  }

  const audited = await recordLearnerView(context.env.DB, {
    actor: staff.requester,
    learnerUserId,
    operationId: `api:learner-view:${crypto.randomUUID()}`,
    now,
    policy: context.get("principal").configuration.policy,
  });
  if (!audited) return errorResponse(context, 401, "unauthenticated");
  return context.json(learnerLookupResponseSchema.parse({ items: [record] }));
});

adminLearnersApi.get("/learners/:learnerId", async (context) => {
  const learnerId = validPathId(context, context.req.param("learnerId"));
  if (learnerId instanceof Response) return learnerId;
  const staff = await requireStaff(context, "learner.read", {
    kind: "learner",
    learnerUserId: learnerId,
  });
  if ("response" in staff) return staff.response;

  const now = Date.now();
  const record = await readMaskedLearnerRecord(context.env.DB, learnerId, now);
  if (!record) return errorResponse(context, 404, "not_found");
  const audited = await recordLearnerView(context.env.DB, {
    actor: staff.requester,
    learnerUserId: learnerId,
    operationId: `api:learner-view:${crypto.randomUUID()}`,
    now,
    policy: context.get("principal").configuration.policy,
  });
  if (!audited) return errorResponse(context, 401, "unauthenticated");
  return context.json(maskedLearnerRecordSchema.parse(record));
});

adminLearnersApi.post(
  "/learners/:learnerId/contact-reveal",
  async (context) => {
    const learnerId = validPathId(context, context.req.param("learnerId"));
    if (learnerId instanceof Response) return learnerId;
    const staff = await requireStaff(context, "learner.reveal", {
      kind: "learner",
      learnerUserId: learnerId,
    });
    if ("response" in staff) return staff.response;
    const csrfFailure = await mutationProtection(context);
    if (csrfFailure) return csrfFailure;

    const body = await readJsonBody(context, emptyMutationRequestSchema);
    if ("response" in body) return body.response;

    const now = Date.now();
    const operationId = `api:learner-reveal:${crypto.randomUUID()}`;
    const revealed = await revealLearnerContact(context.env.DB, {
      actor: staff.requester,
      learnerUserId: learnerId,
      operationId,
      now,
      policy: context.get("principal").configuration.policy,
    });
    if (!revealed.ok) return staffFailureResponse(context, revealed.reason);
    return context.json(
      learnerContactRevealResponseSchema.parse({
        userId: learnerId,
        contactKind: revealed.value.contactKind,
        email: revealed.value.email,
        revealedAt: now,
        operationId,
      }),
    );
  },
);

adminLearnersApi.post("/learners/:learnerId/deactivate", async (context) => {
  const learnerId = validPathId(context, context.req.param("learnerId"));
  if (learnerId instanceof Response) return learnerId;
  const staff = await requireStaff(context, "learner.deactivate", {
    kind: "learner",
    learnerUserId: learnerId,
  });
  if ("response" in staff) return staff.response;
  const csrfFailure = await mutationProtection(context);
  if (csrfFailure) return csrfFailure;

  const body = await readJsonBody(context, learnerDeactivateRequestSchema);
  if ("response" in body) return body.response;

  const status = await learnerAccountStatus(context.env.DB, learnerId);
  if (status === null) return errorResponse(context, 404, "not_found");
  if (status === "deactivated") {
    return errorResponse(context, 409, "already_deactivated");
  }

  const now = Date.now();
  const operationId = `api:learner-deactivate:${crypto.randomUUID()}`;
  const applied = await deactivateLearner(context.env.DB, {
    actor: staff.requester,
    learnerUserId: learnerId,
    metadata: { operationId, reason: body.value.reason, now },
    policy: context.get("principal").configuration.policy,
  });
  if (!applied.ok) return staffFailureResponse(context, applied.reason);
  return context.json(
    learnerDeactivateResponseSchema.parse({
      userId: learnerId,
      accountStatus: "deactivated",
      deactivatedAt: applied.value.deactivatedAt,
      operationId,
    }),
  );
});

adminLearnersApi.post("/learners/:learnerId/contact", async (context) => {
  const learnerId = validPathId(context, context.req.param("learnerId"));
  if (learnerId instanceof Response) return learnerId;
  const staff = await requireStaff(context, "learner.contact.correct", {
    kind: "learner",
    learnerUserId: learnerId,
  });
  if ("response" in staff) return staff.response;
  const csrfFailure = await mutationProtection(context);
  if (csrfFailure) return csrfFailure;

  const body = await readJsonBody(
    context,
    learnerContactCorrectionRequestSchema,
  );
  if ("response" in body) return body.response;

  const emailNormalized = normalizeEmail(body.value.email);
  const email = body.value.email.trim();
  const stored = await readStoredCredentialEmail(context.env.DB, learnerId);
  if (!stored || !(await hasPasswordCredential(context.env.DB, learnerId))) {
    // Correcting an invite key is a provisioning action, not a support action.
    return errorResponse(context, 409, "contact_not_correctable");
  }
  if (stored.emailNormalized === emailNormalized) {
    return errorResponse(context, 409, "contact_unchanged");
  }
  if (
    await contactHeldByAnotherLearner(context.env.DB, emailNormalized, learnerId)
  ) {
    return errorResponse(context, 409, "contact_taken");
  }

  const now = Date.now();
  const operationId = `api:learner-contact:${crypto.randomUUID()}`;
  let applied: Awaited<ReturnType<typeof correctLearnerContact>>;
  try {
    applied = await correctLearnerContact(context.env.DB, {
      actor: staff.requester,
      learnerUserId: learnerId,
      email,
      emailNormalized,
      metadata: { operationId, reason: body.value.reason, now },
      policy: context.get("principal").configuration.policy,
    });
  } catch {
    // Any D1 failure other than the storage guarantee stays a 503.
    return errorResponse(context, 503, "service_unavailable");
  }
  if (!applied.ok) return staffFailureResponse(context, applied.reason);
  return context.json(
    learnerContactCorrectionResponseSchema.parse({
      userId: learnerId,
      maskedContact: maskEmail(email),
      contactKind: "password-credential",
      operationId,
    }),
  );
});

adminLearnersApi.post(
  "/learners/:learnerId/password-reset",
  async (context) => {
    const learnerId = validPathId(context, context.req.param("learnerId"));
    if (learnerId instanceof Response) return learnerId;
    const staff = await requireStaff(context, "learner.support.email", {
      kind: "learner",
      learnerUserId: learnerId,
    });
    if ("response" in staff) return staff.response;
    const csrfFailure = await mutationProtection(context);
    if (csrfFailure) return csrfFailure;
    const body = await readJsonBody(context, emptyMutationRequestSchema);
    if ("response" in body) return body.response;
    if (!supportEmailConfigured(context.env)) {
      return errorResponse(context, 409, "email_unavailable");
    }
    // Tripwire: unreachable while `supportEmailConfigured()` returns false for
    // every binding. It stays so a future transport cannot claim a reset mail was
    // sent from a route that never sends one.
    return errorResponse(context, 503, "service_unavailable");
  },
);

adminLearnersApi.post(
  "/learners/:learnerId/resend-verification",
  async (context) => {
    const learnerId = validPathId(context, context.req.param("learnerId"));
    if (learnerId instanceof Response) return learnerId;
    const staff = await requireStaff(context, "learner.support.email", {
      kind: "learner",
      learnerUserId: learnerId,
    });
    if ("response" in staff) return staff.response;
    const csrfFailure = await mutationProtection(context);
    if (csrfFailure) return csrfFailure;
    const body = await readJsonBody(context, emptyMutationRequestSchema);
    if ("response" in body) return body.response;
    // The verified-account refusal is decided before the transport gate, so it is
    // reachable while `supportEmailConfigured()` is false. A verified account
    // needs no verification mail, and answering `email_unavailable` for it would
    // hide a real, actionable state behind a transport limitation.
    if (await isVerifiedCredential(context.env.DB, learnerId)) {
      return errorResponse(context, 409, "already_verified");
    }
    if (!supportEmailConfigured(context.env)) {
      return errorResponse(context, 409, "email_unavailable");
    }
    // Tripwire: unreachable while `supportEmailConfigured()` returns false for
    // every binding. If a transport is ever added, this 503 is what stops the
    // route from silently claiming a mail was sent.
    return errorResponse(context, 503, "service_unavailable");
  },
);

adminLearnersApi.get(
  "/learners/:learnerId/support-history",
  async (context) => {
    const learnerId = validPathId(context, context.req.param("learnerId"));
    if (learnerId instanceof Response) return learnerId;
    const staff = await requireStaff(context, "learner.support.history", {
      kind: "learner",
      learnerUserId: learnerId,
    });
    if ("response" in staff) return staff.response;

    const query = parseQuery(context, learnerSupportHistoryQuerySchema);
    if ("response" in query) return query.response;

    const result = await listLearnerSupportHistory(context.env.DB, {
      actor: staff.requester,
      learnerUserId: learnerId,
      now: Date.now(),
      policy: context.get("principal").configuration.policy,
      limit: query.value.limit ?? 50,
      cursor: query.value.cursor ?? null,
      viewOperationId: `api:learner-history:${crypto.randomUUID()}`,
    });
    if (!result.ok) return staffFailureResponse(context, result.reason);
    return context.json(learnerSupportHistoryResponseSchema.parse(result.value));
  },
);

export { adminLearnersApi };
