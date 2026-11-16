import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/index.ts";
import { addTerm } from "../src/calendar.ts";
import { isProOffered, proTerm } from "../src/pricing.ts";
import { readinessFormulaVersion } from "../src/readiness.ts";
import type { SecurityDatabase } from "../src/security/database.ts";
import { sessionDigest } from "../src/security/http-session.ts";
import { getLearnerDashboard } from "../src/security/learner-dashboard.ts";
import type { StaffMfaPolicy } from "../src/security/mfa.ts";
import {
  readProEnablement,
  readProEnablementDetail,
  recordProEnablement,
} from "../src/security/pro-enablement.ts";
import { createContentScope } from "./content-fixtures.ts";
import {
  createTestIdentity,
  createTestLearnerUser,
  createTestSessionCredentials,
  grantTestLearnerAccess,
  grantTestRole,
} from "./factories.ts";

// Pro enablement: the read, the act, the storage guarantees and the dashboard
// projection that reads it.

const database: SecurityDatabase = env.DB;
const origin = "https://localhost";
const csrfSecret = "local-worker-test-csrf-secret-with-enough-entropy";
const rateLimitSecret =
  "local-worker-test-rate-limit-secret-with-enough-entropy";
const testerIps = Array.from({ length: 40 }, (_, index) => `203.0.113.${index + 10}`);
const testerIp = testerIps[0]!;

const clock = Date.now();
// Storage allows one act per millisecond per certification, so a test that
// records two acts advances the injected clock between them.
let nowMs = clock;
const application = createApi(fetch, () => nowMs);

function tick(milliseconds = 1): void {
  nowMs += milliseconds;
}

const staffPolicy: StaffMfaPolicy = {
  maxAgeMs: 15 * 60 * 1000,
  allowedMethods: ["tester-gate"],
};

const bindings = {
  DB: database,
  PUBLIC_SITE_ORIGIN: origin,
  CSRF_HMAC_SECRET: csrfSecret,
  LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET: rateLimitSecret,
  LOCAL_LEARNER_AUTH_ENABLED: "false",
  LOCAL_TEST_MAIL_ENABLED: "false",
  STAFF_MFA_MAX_AGE_MS: String(staffPolicy.maxAgeMs),
  STAFF_MFA_ALLOWED_METHODS: staffPolicy.allowedMethods.join(","),
  ADMIN_TESTER_IPS: testerIps.join(","),
  ADMIN_TESTER_ASSURANCE: "true",
};

interface StaffActor {
  userId: string;
  cookie: string;
  token: string;
}

async function staffActor(
  role: "global_admin" | "manager",
): Promise<StaffActor> {
  const identity = await createTestIdentity(database);
  await grantTestRole(database, identity.userId, role);
  const { rawToken } = await createTestSessionCredentials(
    database,
    identity.userId,
    {
      now: clock,
      expiresAt: clock + 6 * 60 * 60 * 1000,
      mfaMethod: "tester-gate",
    },
  );
  const response = await application.fetch(
    new Request(`${origin}/api/admin/csrf`, {
      headers: {
        Cookie: `certpath_session=${rawToken}`,
        "CF-Connecting-IP": testerIp,
      },
    }),
    bindings,
  );
  expect(response.status).toBe(200);
  const token = ((await response.json()) as { csrfToken: string }).csrfToken;
  return { userId: identity.userId, cookie: rawToken, token };
}

async function digestFor(actor: StaffActor): Promise<string> {
  return sessionDigest(actor.cookie);
}

async function act(
  actor: StaffActor,
  certificationId: string,
  enabled: boolean,
  now = clock,
) {
  return recordProEnablement(database, {
    actor: { tokenDigest: await digestFor(actor), userId: actor.userId },
    certificationId,
    mutation: {
      enabled,
      reason: enabled ? "enabled for the test" : "withdrawn for the test",
      operationId: `fixture-enablement:${crypto.randomUUID()}`,
      now,
    },
    policy: staffPolicy,
  });
}

async function proEnablementRequest(
  method: "GET" | "POST",
  certificationId: string,
  options: {
    actor?: StaffActor;
    body?: unknown;
    token?: string | null;
    origin?: string | null;
  } = {},
) {
  const headers: Record<string, string> = { "CF-Connecting-IP": testerIp };
  const requestOrigin = options.origin === undefined ? origin : options.origin;
  if (requestOrigin !== null) headers.Origin = requestOrigin;
  if (options.actor) headers.Cookie = `certpath_session=${options.actor.cookie}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const token =
    options.token === undefined ? options.actor?.token : options.token;
  if (token) headers["X-CSRF-Token"] = token;
  return application.fetch(
    new Request(
      `${origin}/api/admin/commerce/certifications/${certificationId}/pro-enablement`,
      {
        method,
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      },
    ),
    bindings,
  );
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}

async function auditRowsFor(operationId: string) {
  const rows = await database
    .prepare(
      `SELECT action, actor_user_id, actor_ref, subject_type, subject_id,
              certification_id, details_json
       FROM audit_events WHERE operation_id = ?`,
    )
    .bind(operationId)
    .all<{
      action: string;
      actor_user_id: string | null;
      actor_ref: string | null;
      subject_type: string;
      subject_id: string;
      certification_id: string;
      details_json: string | null;
    }>();
  return rows.results;
}

async function actCount(certificationId: string): Promise<number> {
  const row = await database
    .prepare(
      "SELECT COUNT(*) AS count FROM certification_pro_enablement WHERE certification_id = ?",
    )
    .bind(certificationId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

describe("pro enablement authority", () => {
  it("refuses a manager on both routes", async () => {
    const scope = await createContentScope(database);
    const manager = await staffActor("manager");
    const read = await proEnablementRequest("GET", scope.certificationId, {
      actor: manager,
    });
    expect(read.status).toBe(403);
    expect(await errorCode(read)).toBe("insufficient_role");
    const write = await proEnablementRequest("POST", scope.certificationId, {
      actor: manager,
      body: { enabled: true, reason: "manager attempt" },
    });
    expect(write.status).toBe(403);
    expect(await errorCode(write)).toBe("insufficient_role");
    expect(await actCount(scope.certificationId)).toBe(0);
  });

  it("requires a session", async () => {
    const scope = await createContentScope(database);
    const response = await proEnablementRequest("GET", scope.certificationId);
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("unauthenticated");
  });

  it("requires the origin and the CSRF token on the write", async () => {
    const scope = await createContentScope(database);
    const admin = await staffActor("global_admin");
    const noToken = await proEnablementRequest("POST", scope.certificationId, {
      actor: admin,
      body: { enabled: true, reason: "no csrf" },
      token: null,
    });
    expect(noToken.status).toBe(400);
    expect(await errorCode(noToken)).toBe("invalid_csrf");
    const wrongOrigin = await proEnablementRequest(
      "POST",
      scope.certificationId,
      {
        actor: admin,
        body: { enabled: true, reason: "wrong origin" },
        origin: "https://evil.example.test",
      },
    );
    expect(wrongOrigin.status).toBe(400);
    expect(await errorCode(wrongOrigin)).toBe("invalid_origin");
    expect(await actCount(scope.certificationId)).toBe(0);
  });
});

describe("pro enablement acts", () => {
  it("records an act, audits it exactly once and answers the operation id", async () => {
    const scope = await createContentScope(database);
    const admin = await staffActor("global_admin");

    const before = await proEnablementRequest("GET", scope.certificationId, {
      actor: admin,
    });
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({
      certificationId: scope.certificationId,
      enabled: false,
      effectiveAt: null,
      history: [],
    });

    const response = await proEnablementRequest("POST", scope.certificationId, {
      actor: admin,
      body: { enabled: true, reason: "Adaptive items are live for this exam" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      certificationId: string;
      enabled: boolean;
      effectiveAt: number;
      operationId: string;
    };
    expect(body.enabled).toBe(true);
    expect(body.effectiveAt).toBe(clock);
    expect(body.operationId).toMatch(/^api:pro-enablement:/);

    const audit = await auditRowsFor(body.operationId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "certification_pro_enabled",
      actor_user_id: admin.userId,
      actor_ref: null,
      subject_type: "certification",
      subject_id: scope.certificationId,
      certification_id: scope.certificationId,
      details_json: null,
    });

    const after = await proEnablementRequest("GET", scope.certificationId, {
      actor: admin,
    });
    expect(await after.json()).toEqual({
      certificationId: scope.certificationId,
      enabled: true,
      effectiveAt: clock,
      history: [
        {
          enabled: true,
          effectiveAt: clock,
          operationId: body.operationId,
          reason: "Adaptive items are live for this exam",
        },
      ],
    });
  });

  it("refuses an act that would not change the state", async () => {
    const scope = await createContentScope(database);
    const admin = await staffActor("global_admin");
    const first = await proEnablementRequest("POST", scope.certificationId, {
      actor: admin,
      body: { enabled: true, reason: "first act" },
    });
    expect(first.status).toBe(200);
    // A different millisecond on purpose: the refusal below must come from the
    // "state already holds" predicate, not from UNIQUE(certification_id,
    // effective_at) catching a same-millisecond collision.
    tick();
    const second = await proEnablementRequest("POST", scope.certificationId, {
      actor: admin,
      body: { enabled: true, reason: "same state again" },
    });
    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe("conflict");
    expect(await actCount(scope.certificationId)).toBe(1);
  });

  it("records a withdrawal as its own audited act", async () => {
    const scope = await createContentScope(database);
    const admin = await staffActor("global_admin");
    const enabled = await proEnablementRequest("POST", scope.certificationId, {
      actor: admin,
      body: { enabled: true, reason: "enabled for the pilot" },
    });
    expect(enabled.status).toBe(200);
    const enabledBody = (await enabled.json()) as { effectiveAt: number };
    tick();
    const withdrawal = await proEnablementRequest(
      "POST",
      scope.certificationId,
      {
        actor: admin,
        body: { enabled: false, reason: "withdrawn after review" },
      },
    );
    expect(withdrawal.status).toBe(200);
    const withdrawalBody = (await withdrawal.json()) as {
      enabled: boolean;
      effectiveAt: number;
      operationId: string;
    };
    expect(withdrawalBody.effectiveAt).toBeGreaterThan(enabledBody.effectiveAt);
    expect(withdrawalBody.enabled).toBe(false);
    const audit = await auditRowsFor(withdrawalBody.operationId);
    expect(audit[0]?.action).toBe("certification_pro_disabled");
  });

  it("answers 404 for a certification that does not exist", async () => {
    const admin = await staffActor("global_admin");
    const read = await proEnablementRequest("GET", "no-such-exam", {
      actor: admin,
    });
    expect(read.status).toBe(404);
    expect(await errorCode(read)).toBe("certification_not_found");
    const write = await proEnablementRequest("POST", "no-such-exam", {
      actor: admin,
      body: { enabled: true, reason: "does not exist" },
    });
    expect(write.status).toBe(404);
    expect(await errorCode(write)).toBe("certification_not_found");
  });

  it("rejects a body without a usable reason", async () => {
    const scope = await createContentScope(database);
    const admin = await staffActor("global_admin");
    for (const body of [
      { enabled: true },
      { enabled: true, reason: "" },
      { enabled: true, reason: "x".repeat(201) },
      { enabled: "yes", reason: "a reason" },
    ]) {
      const response = await proEnablementRequest(
        "POST",
        scope.certificationId,
        { actor: admin, body },
      );
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("validation_error");
    }
    expect(await actCount(scope.certificationId)).toBe(0);
  });
});

describe("pro enablement statement guard", () => {
  it("refuses a write from a live session that is not a global admin", async () => {
    const scope = await createContentScope(database);
    // Bypass the route entirely: the guard in the statement is the second line
    // of defence, so it has to refuse on its own.
    const manager = await staffActor("manager");
    const applied = await recordProEnablement(database, {
      actor: { tokenDigest: await digestFor(manager), userId: manager.userId },
      certificationId: scope.certificationId,
      mutation: {
        enabled: true,
        reason: "manager through the module",
        operationId: `fixture-enablement:${crypto.randomUUID()}`,
        now: clock,
      },
      policy: staffPolicy,
    });
    expect(applied).toEqual({ ok: false, reason: "unauthorized" });
    expect(await actCount(scope.certificationId)).toBe(0);
  });

  it("refuses a write from a global admin whose MFA assurance is stale", async () => {
    const scope = await createContentScope(database);
    const identity = await createTestIdentity(database);
    await grantTestRole(database, identity.userId, "global_admin");
    const { rawToken } = await createTestSessionCredentials(
      database,
      identity.userId,
      {
        now: clock,
        expiresAt: clock + 6 * 60 * 60 * 1000,
        mfaMethod: "tester-gate",
      },
    );
    const applied = await recordProEnablement(database, {
      actor: {
        tokenDigest: await sessionDigest(rawToken),
        userId: identity.userId,
      },
      certificationId: scope.certificationId,
      mutation: {
        enabled: true,
        reason: "stale assurance",
        operationId: `fixture-enablement:${crypto.randomUUID()}`,
        // One millisecond past the assurance window.
        now: clock + staffPolicy.maxAgeMs + 1,
      },
      policy: staffPolicy,
    });
    expect(applied).toEqual({ ok: false, reason: "unauthorized" });
    expect(await actCount(scope.certificationId)).toBe(0);
  });
});

describe("pro enablement storage guarantees", () => {
  it("refuses an edit or a delete of a recorded act", async () => {
    const scope = await createContentScope(database);
    const admin = await staffActor("global_admin");
    const applied = await act(admin, scope.certificationId, true);
    expect(applied.ok).toBe(true);
    await expect(
      database
        .prepare(
          "UPDATE certification_pro_enablement SET enabled = 0 WHERE certification_id = ?",
        )
        .bind(scope.certificationId)
        .run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      database
        .prepare(
          "DELETE FROM certification_pro_enablement WHERE certification_id = ?",
        )
        .bind(scope.certificationId)
        .run(),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it("allows one act per millisecond per certification", async () => {
    const scope = await createContentScope(database);
    const admin = await staffActor("global_admin");
    const insert = (operationId: string) =>
      database
        .prepare(
          `INSERT INTO certification_pro_enablement (
             id, certification_id, enabled, effective_at,
             changed_by_user_id, operation_id, reason
           ) VALUES (?, ?, 1, ?, ?, ?, 'same millisecond')`,
        )
        .bind(
          crypto.randomUUID(),
          scope.certificationId,
          clock,
          admin.userId,
          operationId,
        )
        .run();
    await insert(`fixture-enablement:${crypto.randomUUID()}`);
    await expect(
      insert(`fixture-enablement:${crypto.randomUUID()}`),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("leaves certifications immutable", async () => {
    const scope = await createContentScope(database);
    await expect(
      database
        .prepare(
          "UPDATE certifications SET display_name = 'renamed' WHERE id = ?",
        )
        .bind(scope.certificationId)
        .run(),
    ).rejects.toThrow();
  });
});

describe("pro enablement reads", () => {
  it("returns the current state of several certifications in one query", async () => {
    const first = await createContentScope(database);
    const second = await createContentScope(database);
    const admin = await staffActor("global_admin");
    for (const certificationId of [
      first.certificationId,
      second.certificationId,
    ]) {
      expect((await act(admin, certificationId, true)).ok).toBe(true);
    }
    const current = await readProEnablement(database, [
      first.certificationId,
      second.certificationId,
    ]);
    expect(current.get(first.certificationId)).toEqual({
      enabled: true,
      effectiveAt: clock,
    });
    expect(current.get(second.certificationId)).toEqual({
      enabled: true,
      effectiveAt: clock,
    });
    expect(current.size).toBe(2);
    expect(await readProEnablement(database, [])).toEqual(new Map());
  });

  it("reads the newest act as the current state, stably", async () => {
    const scope = await createContentScope(database);
    const admin = await staffActor("global_admin");
    let now = clock;
    for (const enabled of [true, false, true]) {
      expect((await act(admin, scope.certificationId, enabled, now)).ok).toBe(
        true,
      );
      now += 1;
    }
    const firstRead = await readProEnablementDetail(
      database,
      scope.certificationId,
    );
    const secondRead = await readProEnablementDetail(
      database,
      scope.certificationId,
    );
    expect(firstRead?.record).toEqual({ enabled: true, effectiveAt: clock + 2 });
    expect(firstRead?.history).toHaveLength(3);
    expect(firstRead?.history.map((entry) => entry.enabled)).toEqual([
      true,
      false,
      true,
    ]);
    expect(secondRead).toEqual(firstRead);
    expect(await readProEnablementDetail(database, "no-such-exam")).toBeNull();
  });

  it("treats storage as a fact and null as not offered", () => {
    expect(isProOffered(null)).toBe(false);
    expect(isProOffered({ enabled: false, effectiveAt: clock })).toBe(false);
    expect(isProOffered({ enabled: true, effectiveAt: clock })).toBe(true);
  });
});

describe("dashboard pro prompt", () => {
  async function learnerWithReadiness(
    certificationId: string,
    examVersionId: string,
    coverageEndMs: number,
  ): Promise<{ userId: string; tokenDigest: string }> {
    const userId = await createTestLearnerUser(database);
    const { tokenDigest } = await createTestSessionCredentials(
      database,
      userId,
      { now: clock, expiresAt: clock + 60 * 60 * 1000 },
    );
    await grantTestLearnerAccess(database, userId, certificationId, {
      startsAt: clock - 86_400_000,
      expiresAt: coverageEndMs,
    });
    await database
      .prepare(
        `INSERT INTO readiness_snapshots (
           id, user_id, certification_id, exam_version_id, formula_version,
           band, score, is_ready, mocks_count, questions_count, basis_json,
           next_action_json, source_attempt_id, computed_at
         ) VALUES (?, ?, ?, ?, ?, 'ready', 80, 1, 2, 40, ?, NULL, NULL, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        userId,
        certificationId,
        examVersionId,
        readinessFormulaVersion,
        JSON.stringify({ mocks: 2, questions: 40, blueprintWeighted: false }),
        clock,
      )
      .run();
    return { userId, tokenDigest };
  }

  async function proPrompt(
    userId: string,
    tokenDigest: string,
  ): Promise<boolean | undefined> {
    const dashboard = await getLearnerDashboard(
      database,
      userId,
      tokenDigest,
      clock,
    );
    return dashboard.groups[0]?.readiness?.proPrompt;
  }

  it("flips only after a Global Admin enables Pro for the exam", async () => {
    const scope = await createContentScope(database);
    const learner = await learnerWithReadiness(
      scope.certificationId,
      scope.examVersionId,
      addTerm(clock, proTerm),
    );
    expect(await proPrompt(learner.userId, learner.tokenDigest)).toBe(false);

    const admin = await staffActor("global_admin");
    expect((await act(admin, scope.certificationId, true)).ok).toBe(true);
    expect(await proPrompt(learner.userId, learner.tokenDigest)).toBe(true);
  });

  it("stays false when Standard does not cover a full Pro term", async () => {
    const scope = await createContentScope(database);
    const learner = await learnerWithReadiness(
      scope.certificationId,
      scope.examVersionId,
      addTerm(clock, proTerm) - 1,
    );
    const admin = await staffActor("global_admin");
    expect((await act(admin, scope.certificationId, true)).ok).toBe(true);
    expect(await proPrompt(learner.userId, learner.tokenDigest)).toBe(false);
  });
});
