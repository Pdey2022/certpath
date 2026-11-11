import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api } from "../src/index.ts";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  QUESTION_IMPORT_FORMAT,
  QUESTION_IMPORT_TEMPLATE_COLUMNS,
  previewQuestionImport,
} from "../src/security/question-imports.ts";
import {
  revokeManagerCertification,
  revokeOwnApplicationSession,
} from "../src/security/mutations.ts";
import {
  assignTestCertification,
  createTestCertification,
  createTestIdentity,
  createTestSessionCredentials,
  grantTestRole,
} from "./factories.ts";
import { validQuestionContent } from "./content-fixtures.ts";

const database: SecurityDatabase = env.DB;
const origin = "https://certpath.example.test";
const secret = "local-worker-test-csrf-secret-with-enough-entropy";
const apiRoot = "/api/admin/content";

interface Actor {
  userId: string;
  tokenDigest: string;
  rawToken: string;
  certificationId: string;
  bindings: {
    DB: SecurityDatabase;
    PUBLIC_SITE_ORIGIN: string;
    STAFF_MFA_MAX_AGE_MS: string;
    STAFF_MFA_ALLOWED_METHODS: string;
    CSRF_HMAC_SECRET: string;
  };
  csrfToken?: string;
}

async function createActor(options: {
  role?: "global_admin" | "manager" | "learner";
  assigned?: boolean;
  status?: "active" | "disabled";
  mfaMethod?: string | null;
  mfaVerifiedAt?: number | null;
  now?: number;
  expiresAt?: number;
  maxMfaAge?: string;
} = {}): Promise<Actor> {
  const identity = await createTestIdentity(database, {
    status: options.status,
  });
  const role = options.role ?? "global_admin";
  if (role !== "learner") {
    await grantTestRole(database, identity.userId, role);
  }
  const now = options.now ?? Date.now();
  const credentials = await createTestSessionCredentials(
    database,
    identity.userId,
    {
      now,
      expiresAt: options.expiresAt,
      mfaMethod: options.mfaMethod === undefined ? "totp" : options.mfaMethod,
      mfaVerifiedAt: options.mfaVerifiedAt,
    },
  );
  const certificationId = await createTestCertification(
    database,
    identity.userId,
  );
  if (role === "manager" && options.assigned !== false) {
    await assignTestCertification(database, identity.userId, certificationId);
  }
  return {
    userId: identity.userId,
    tokenDigest: credentials.tokenDigest,
    rawToken: credentials.rawToken,
    certificationId,
    bindings: {
      DB: database,
      PUBLIC_SITE_ORIGIN: origin,
      STAFF_MFA_MAX_AGE_MS: options.maxMfaAge ?? "120000",
      STAFF_MFA_ALLOWED_METHODS: "totp",
      CSRF_HMAC_SECRET: secret,
    },
  };
}

function requestUrl(path: string): string {
  return `https://certpath.example.test${path}`;
}

async function getCsrf(actor: Actor): Promise<string> {
  const response = await api.fetch(
    new Request(requestUrl(`${apiRoot}/csrf`), {
      headers: { Cookie: `certpath_session=${actor.rawToken}` },
    }),
    actor.bindings,
  );
  if (!response.ok) throw new Error(`Could not get test CSRF token: ${response.status}`);
  const body = (await response.json()) as { csrfToken: string };
  actor.csrfToken = body.csrfToken;
  return body.csrfToken;
}

async function call(
  actor: Actor,
  path: string,
  options: {
    method?: string;
    body?: string;
    contentType?: string;
    csrf?: boolean;
    origin?: string | null;
    cookie?: string | null;
    extraHeaders?: Record<string, string>;
    bindings?: Actor["bindings"];
  } = {},
): Promise<Response> {
  const method = options.method ?? "GET";
  const headers = new Headers(options.extraHeaders);
  if (options.cookie !== null) {
    headers.set("Cookie", options.cookie ?? `certpath_session=${actor.rawToken}`);
  }
  if (options.body !== undefined) {
    headers.set("Content-Type", options.contentType ?? "application/json");
  }
  if (method !== "GET" && options.csrf !== false) {
    headers.set("Origin", options.origin ?? origin);
    if (!headers.has("X-CSRF-Token")) {
      headers.set(
        "X-CSRF-Token",
        actor.csrfToken ?? (await getCsrf(actor)),
      );
    }
  } else if (options.origin !== undefined && options.origin !== null) {
    headers.set("Origin", options.origin);
  }
  return api.fetch(
    new Request(requestUrl(path), {
      method,
      headers,
      body: options.body,
    }),
    options.bindings ?? actor.bindings,
  );
}

function assertPrivate(response: Response): void {
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(response.headers.get("x-request-id")).toBeTruthy();
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
}

function versionPath(actor: Actor, versionId = "version-test") {
  return `${apiRoot}/certifications/${actor.certificationId}/exam-versions/${versionId}`;
}

function contentRow(
  examVersionId: string,
  domainId: string,
  topicId: string,
  questionKey: string,
): string[] {
  const cells = [
    QUESTION_IMPORT_FORMAT,
    questionKey,
    examVersionId,
    domainId,
    topicId,
    validQuestionContent.stem,
    validQuestionContent.difficulty,
    validQuestionContent.sourceReference,
    validQuestionContent.licenseReference,
  ];
  for (let index = 0; index < 8; index += 1) {
    const option = validQuestionContent.options[index];
    cells.push(
      option?.key ?? "",
      option?.text ?? "",
      option ? String(option.correct) : "",
      option?.explanation ?? "",
    );
  }
  return cells;
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function csvFile(row: string[]): Uint8Array {
  const source = [QUESTION_IMPORT_TEMPLATE_COLUMNS, row]
    .map((cells) => cells.map(csvCell).join(","))
    .join("\r\n") + "\r\n";
  return new TextEncoder().encode(source);
}

describe("protected content HTTP boundary", () => {
  it("rejects absent, malformed, expired, revoked and disabled-account sessions", async () => {
    const actor = await createActor();
    const url = `${apiRoot}/certifications/${actor.certificationId}/exam-versions`;
    const noCookie = await call(actor, `${url}?tokenDigest=${actor.tokenDigest}&userId=${actor.userId}&role=global_admin`, {
      method: "POST",
      body: "{}",
      cookie: null,
    });
    expect(noCookie.status).toBe(401);
    assertPrivate(noCookie);

    const malformedCookie = await call(actor, url, {
      method: "POST",
      body: "{}",
      cookie: "certpath_session=not-a-valid-token",
    });
    expect(malformedCookie.status).toBe(401);
    expect(
      (
        await call(actor, url, {
          method: "POST",
          body: "{}",
          cookie: `certpath_session=${actor.rawToken}; certpath_session=${actor.rawToken}`,
        })
      ).status,
    ).toBe(401);

    const expired = await createActor({
      now: Date.now() - 60_000,
      expiresAt: Date.now() - 1,
    });
    expect(
      (
        await call(expired, `${apiRoot}/csrf`)
      ).status,
    ).toBe(401);

    expect(
      await revokeOwnApplicationSession(
        database,
        actor.tokenDigest,
        Date.now(),
        `http-test-revoke:${crypto.randomUUID()}`,
      ),
    ).toBe(true);
    expect((await call(actor, `${apiRoot}/csrf`)).status).toBe(401);

    const disabled = await createActor({ status: "disabled" });
    expect((await call(disabled, `${apiRoot}/csrf`)).status).toBe(401);
  });

  it("fails closed for missing security configuration and staff MFA assurance", async () => {
    const actor = await createActor();
    const missingConfig = {
      DB: database,
      PUBLIC_SITE_ORIGIN: origin,
      STAFF_MFA_ALLOWED_METHODS: "totp",
      CSRF_HMAC_SECRET: secret,
    };
    const missingPolicy = await call(actor, `${apiRoot}/csrf`, {
      bindings: missingConfig as Actor["bindings"],
    });
    expect(missingPolicy.status).toBe(503);
    assertPrivate(missingPolicy);

    const badPolicy = await call(actor, `${apiRoot}/csrf`, {
      bindings: {
        ...actor.bindings,
        STAFF_MFA_MAX_AGE_MS: "0",
      },
    });
    expect(badPolicy.status).toBe(503);

    const noMfa = await createActor({ mfaMethod: null });
    const noMfaResponse = await call(
      noMfa,
      `${apiRoot}/certifications/${noMfa.certificationId}/exam-versions`,
      { method: "POST", body: "{}" },
    );
    expect(noMfaResponse.status).toBe(403);

    const stale = await createActor({
      mfaVerifiedAt: Date.now() - 300_000,
      maxMfaAge: "1000",
    });
    expect(
      (
        await call(
          stale,
          `${apiRoot}/certifications/${stale.certificationId}/exam-versions`,
          { method: "POST", body: "{}" },
        )
      ).status,
    ).toBe(403);

    const unsupportedMethod = await createActor({ mfaMethod: "sms" });
    expect(
      (
        await call(
          unsupportedMethod,
          `${apiRoot}/certifications/${unsupportedMethod.certificationId}/exam-versions`,
          { method: "POST", body: "{}" },
        )
      ).status,
    ).toBe(403);
  });

  it("rejects forged client identity, permission, MFA, digest and clock fields", async () => {
    const learner = await createActor({ role: "learner" });
    const url = `${apiRoot}/certifications/${learner.certificationId}/exam-versions?demoRole=global_admin&now=1800000000000`;
    const response = await call(learner, url, {
      method: "POST",
      body: JSON.stringify({
        versionKey: "v1",
        title: "Test version",
        syllabusReference: "Synthetic only",
        tokenDigest: learner.tokenDigest,
        userId: learner.userId,
        role: "global_admin",
        mfaVerified: true,
        mfaVerifiedAt: Date.now(),
        certificationId: learner.certificationId,
      }),
    });
    expect(response.status).toBe(403);
    assertPrivate(response);

    const admin = await createActor();
    const strict = await call(
      admin,
      `${apiRoot}/certifications/${admin.certificationId}/exam-versions`,
      {
        method: "POST",
        body: JSON.stringify({
          versionKey: "forged",
          title: "Synthetic",
          syllabusReference: "Synthetic",
          role: "global_admin",
          tokenDigest: admin.tokenDigest,
        }),
      },
    );
    expect(strict.status).toBe(400);
    expect(await strict.text()).not.toContain(admin.tokenDigest);
  });

  it("enforces origin and session-bound CSRF before mutation bodies", async () => {
    const actor = await createActor();
    const path = `${apiRoot}/certifications/${actor.certificationId}/exam-versions`;
    expect(
      (
        await call(actor, path, {
          method: "POST",
          body: "{}",
          csrf: false,
        })
      ).status,
    ).toBe(400);

    const token = await getCsrf(actor);
    expect(
      (
        await call(actor, path, {
          method: "POST",
          body: "{}",
          extraHeaders: { "X-CSRF-Token": "v1.invalid" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(actor, path, {
          method: "POST",
          body: "{}",
          origin: "https://attacker.example",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(actor, path, {
          method: "POST",
          body: "{}",
          origin: null,
        })
      ).status,
    ).toBe(400);

    const forgedHost = await api.fetch(
      new Request(`https://attacker.example${path}`, {
        method: "POST",
        headers: {
          Cookie: `certpath_session=${actor.rawToken}`,
          Origin: origin,
          "X-CSRF-Token": token,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      actor.bindings,
    );
    expect(forgedHost.status).toBe(400);
  });

  it("requires certification assignment and rechecks revocation on each request", async () => {
    const manager = await createActor({ role: "manager", assigned: false });
    const path = `${apiRoot}/certifications/${manager.certificationId}/exam-versions`;
    const denied = await call(manager, path, {
      method: "POST",
      body: JSON.stringify({
        versionKey: "version-a",
        title: "Synthetic version",
        syllabusReference: "Synthetic syllabus",
      }),
    });
    expect(denied.status).toBe(404);
    assertPrivate(denied);
    const oversizedButUnauthorized = await call(manager, path, {
      method: "POST",
      body: "{}",
      extraHeaders: { "Content-Length": "33000" },
    });
    expect(oversizedButUnauthorized.status).toBe(404);

    const assigned = await createActor({ role: "manager" });
    const allowedPath = `${apiRoot}/certifications/${assigned.certificationId}/exam-versions`;
    const allowed = await call(assigned, allowedPath, {
      method: "POST",
      body: JSON.stringify({
        versionKey: "version-a",
        title: "Synthetic version",
        syllabusReference: "Synthetic syllabus",
      }),
    });
    expect(allowed.status).toBe(201);
    const created = (await allowed.json()) as { id: string };

    const administrator = await createActor();
    expect(
      await revokeManagerCertification(
        database,
        administrator.tokenDigest,
        assigned.userId,
        assigned.certificationId,
        {
          operationId: `http-test-assignment-revoke:${crypto.randomUUID()}`,
          reason: "Synthetic HTTP assignment revocation test",
          now: Date.now(),
        },
        { maxAgeMs: 120_000, allowedMethods: ["totp"] },
      ),
    ).toMatchObject({ applied: true });
    expect(
      (
        await call(
          assigned,
          `${allowedPath}/${created.id}/domains`,
          {
            method: "POST",
            body: JSON.stringify({
              domainKey: "domain-a",
              title: "Synthetic domain",
              meaning: "Synthetic meaning",
              order: 0,
            }),
          },
        )
      ).status,
    ).toBe(404);
  });

  it("enforces real streamed body limits and strict content types", async () => {
    const actor = await createActor();
    const path = `${apiRoot}/certifications/${actor.certificationId}/exam-versions`;
    const unsupported = await call(actor, path, {
      method: "POST",
      body: "{}",
      contentType: "text/plain",
    });
    expect(unsupported.status).toBe(400);

    const csrf = await getCsrf(actor);
    const headers = new Headers({
      Cookie: `certpath_session=${actor.rawToken}`,
      Origin: origin,
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json",
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20_000));
        controller.enqueue(new Uint8Array(20_000));
        controller.close();
      },
    });
    const chunked = await api.fetch(
      new Request(requestUrl(path), {
        method: "POST",
        headers,
        body: stream,
        duplex: "half",
      } as RequestInit),
      actor.bindings,
    );
    expect(chunked.status).toBe(413);
    assertPrivate(chunked);
  });

  it("returns atomic private conflicts for sequential and concurrent duplicate keys", async () => {
    const actor = await createActor();
    const examVersionsPath = `${apiRoot}/certifications/${actor.certificationId}/exam-versions`;
    const versionKey = `duplicate-version-${crypto.randomUUID()}`;
    const versionBody = JSON.stringify({
      versionKey,
      title: "Synthetic duplicate version",
      syllabusReference: "Synthetic syllabus",
    });
    const firstVersion = await call(actor, examVersionsPath, {
      method: "POST",
      body: versionBody,
    });
    expect(firstVersion.status).toBe(201);
    const versionId = ((await firstVersion.json()) as { id: string }).id;

    const duplicateVersion = await call(actor, examVersionsPath, {
      method: "POST",
      body: versionBody,
    });
    expect(duplicateVersion.status).toBe(409);
    expect(await duplicateVersion.text()).not.toMatch(/SQLITE|constraint failed|D1_ERROR/i);
    assertPrivate(duplicateVersion);
    const versionConflictAuditCount = await database
      .prepare(
        `SELECT COUNT(*) AS count FROM audit_events
         WHERE certification_id = ? AND action = 'exam_version_created'`,
      )
      .bind(actor.certificationId)
      .first<{ count: number }>();
    expect(versionConflictAuditCount?.count).toBe(1);

    const concurrentVersionKey = `concurrent-version-${crypto.randomUUID()}`;
    const concurrentVersionBody = JSON.stringify({
      versionKey: concurrentVersionKey,
      title: "Synthetic concurrent version",
      syllabusReference: "Synthetic syllabus",
    });
    const concurrentVersions = await Promise.all([
      call(actor, examVersionsPath, {
        method: "POST",
        body: concurrentVersionBody,
      }),
      call(actor, examVersionsPath, {
        method: "POST",
        body: concurrentVersionBody,
      }),
    ]);
    expect(concurrentVersions.map((response) => response.status).sort()).toEqual([201, 409]);
    for (const response of concurrentVersions) {
      assertPrivate(response);
      expect(await response.text()).not.toMatch(/SQLITE|constraint failed|D1_ERROR/i);
    }
    const concurrentVersionState = await database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM exam_versions
            WHERE certification_id = ? AND version_key = ?) AS versions,
           (SELECT COUNT(*) FROM audit_events
            WHERE certification_id = ? AND action = 'exam_version_created'
              AND subject_id IN (
                SELECT id FROM exam_versions
                WHERE certification_id = ? AND version_key = ?
              )) AS audits`,
      )
      .bind(
        actor.certificationId,
        concurrentVersionKey,
        actor.certificationId,
        actor.certificationId,
        concurrentVersionKey,
      )
      .first<{ versions: number; audits: number }>();
    expect(concurrentVersionState).toEqual({ versions: 1, audits: 1 });

    const versionPathValue = versionPath(actor, versionId);
    const domainKey = `duplicate-domain-${crypto.randomUUID()}`;
    const domainBody = JSON.stringify({
      domainKey,
      title: "Synthetic duplicate domain",
      meaning: "Synthetic meaning",
      order: 0,
    });
    const domainsPath = `${versionPathValue}/domains`;
    const firstDomain = await call(actor, domainsPath, {
      method: "POST",
      body: domainBody,
    });
    expect(firstDomain.status).toBe(201);
    const domainId = ((await firstDomain.json()) as { id: string }).id;
    const duplicateDomain = await call(actor, domainsPath, {
      method: "POST",
      body: domainBody,
    });
    expect(duplicateDomain.status).toBe(409);
    expect(await duplicateDomain.text()).not.toMatch(/SQLITE|constraint failed|D1_ERROR/i);
    assertPrivate(duplicateDomain);
    const domainAuditCount = await database
      .prepare(
        `SELECT COUNT(*) AS count FROM audit_events
         WHERE certification_id = ? AND action = 'domain_created'`,
      )
      .bind(actor.certificationId)
      .first<{ count: number }>();
    expect(domainAuditCount?.count).toBe(1);

    const concurrentDomainKey = `concurrent-domain-${crypto.randomUUID()}`;
    const concurrentDomainBody = JSON.stringify({
      domainKey: concurrentDomainKey,
      title: "Synthetic concurrent domain",
      meaning: "Synthetic meaning",
      order: 1,
    });
    const concurrentDomains = await Promise.all([
      call(actor, domainsPath, { method: "POST", body: concurrentDomainBody }),
      call(actor, domainsPath, { method: "POST", body: concurrentDomainBody }),
    ]);
    expect(concurrentDomains.map((response) => response.status).sort()).toEqual([201, 409]);
    for (const response of concurrentDomains) {
      assertPrivate(response);
      expect(await response.text()).not.toMatch(/SQLITE|constraint failed|D1_ERROR/i);
    }
    const concurrentDomainState = await database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM domains
            WHERE exam_version_id = ? AND domain_key = ?) AS domains,
           (SELECT COUNT(*) FROM audit_events
            WHERE certification_id = ? AND action = 'domain_created'
              AND subject_id IN (
                SELECT id FROM domains
                WHERE exam_version_id = ? AND domain_key = ?
              )) AS audits`,
      )
      .bind(
        versionId,
        concurrentDomainKey,
        actor.certificationId,
        versionId,
        concurrentDomainKey,
      )
      .first<{ domains: number; audits: number }>();
    expect(concurrentDomainState).toEqual({ domains: 1, audits: 1 });

    const topicsPath = `${domainsPath}/${domainId}/topics`;
    const topicKey = `duplicate-topic-${crypto.randomUUID()}`;
    const topicBody = JSON.stringify({
      topicKey,
      title: "Synthetic duplicate topic",
      meaning: "Synthetic meaning",
      order: 0,
    });
    const firstTopic = await call(actor, topicsPath, {
      method: "POST",
      body: topicBody,
    });
    expect(firstTopic.status).toBe(201);
    const topicId = ((await firstTopic.json()) as { id: string }).id;
    const duplicateTopic = await call(actor, topicsPath, {
      method: "POST",
      body: topicBody,
    });
    expect(duplicateTopic.status).toBe(409);
    expect(await duplicateTopic.text()).not.toMatch(/SQLITE|constraint failed|D1_ERROR/i);
    assertPrivate(duplicateTopic);
    const topicAuditCount = await database
      .prepare(
        `SELECT COUNT(*) AS count FROM audit_events
         WHERE certification_id = ? AND action = 'topic_created'`,
      )
      .bind(actor.certificationId)
      .first<{ count: number }>();
    expect(topicAuditCount?.count).toBe(1);

    const concurrentTopicKey = `concurrent-topic-${crypto.randomUUID()}`;
    const concurrentTopicBody = JSON.stringify({
      topicKey: concurrentTopicKey,
      title: "Synthetic concurrent topic",
      meaning: "Synthetic meaning",
      order: 1,
    });
    const concurrentTopics = await Promise.all([
      call(actor, topicsPath, { method: "POST", body: concurrentTopicBody }),
      call(actor, topicsPath, { method: "POST", body: concurrentTopicBody }),
    ]);
    expect(concurrentTopics.map((response) => response.status).sort()).toEqual([201, 409]);
    for (const response of concurrentTopics) {
      assertPrivate(response);
      expect(await response.text()).not.toMatch(/SQLITE|constraint failed|D1_ERROR/i);
    }
    const concurrentTopicState = await database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM topics
            WHERE domain_id = ? AND topic_key = ?) AS topics,
           (SELECT COUNT(*) FROM audit_events
            WHERE certification_id = ? AND action = 'topic_created'
              AND subject_id IN (
                SELECT id FROM topics
                WHERE domain_id = ? AND topic_key = ?
              )) AS audits`,
      )
      .bind(
        domainId,
        concurrentTopicKey,
        actor.certificationId,
        domainId,
        concurrentTopicKey,
      )
      .first<{ topics: number; audits: number }>();
    expect(concurrentTopicState).toEqual({ topics: 1, audits: 1 });

    const questionPath = `${versionPathValue}/questions`;
    const questionKey = `duplicate-question-${crypto.randomUUID()}`;
    const questionBody = JSON.stringify({
      questionKey,
      domainId,
      topicId,
      content: validQuestionContent,
    });
    const firstQuestion = await call(actor, questionPath, {
      method: "POST",
      body: questionBody,
    });
    expect(firstQuestion.status).toBe(201);
    const questionId = ((await firstQuestion.json()) as { questionId: string }).questionId;
    const duplicateQuestion = await call(actor, questionPath, {
      method: "POST",
      body: questionBody,
    });
    expect(duplicateQuestion.status).toBe(409);
    expect(await duplicateQuestion.text()).not.toMatch(/SQLITE|constraint failed|D1_ERROR/i);
    assertPrivate(duplicateQuestion);
    const questionConflictState = await database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM questions
            WHERE certification_id = ? AND question_key = ?) AS questions,
           (SELECT COUNT(*) FROM question_revisions
            WHERE question_id = ?) AS revisions,
           (SELECT COUNT(*) FROM audit_events
            WHERE certification_id = ? AND action = 'question_created'
              AND subject_id = ?) AS audits`,
      )
      .bind(
        actor.certificationId,
        questionKey,
        questionId,
        actor.certificationId,
        questionId,
      )
      .first<{ questions: number; revisions: number; audits: number }>();
    expect(questionConflictState).toEqual({ questions: 1, revisions: 1, audits: 1 });

    const concurrentQuestionKey = `concurrent-question-${crypto.randomUUID()}`;
    const concurrentQuestionBody = JSON.stringify({
      questionKey: concurrentQuestionKey,
      domainId,
      topicId,
      content: validQuestionContent,
    });
    const concurrentQuestions = await Promise.all([
      call(actor, questionPath, { method: "POST", body: concurrentQuestionBody }),
      call(actor, questionPath, { method: "POST", body: concurrentQuestionBody }),
    ]);
    expect(concurrentQuestions.map((response) => response.status).sort()).toEqual([201, 409]);
    for (const response of concurrentQuestions) {
      assertPrivate(response);
      expect(await response.text()).not.toMatch(/SQLITE|constraint failed|D1_ERROR/i);
    }
    const concurrentQuestionCount = await database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM questions
            WHERE certification_id = ? AND question_key = ?) AS questions,
           (SELECT COUNT(*) FROM question_revisions AS revision
            JOIN questions AS question ON question.id = revision.question_id
            WHERE question.certification_id = ? AND question.question_key = ?) AS revisions,
           (SELECT COUNT(*) FROM audit_events
            WHERE certification_id = ? AND action = 'question_created'
              AND subject_id IN (
                SELECT id FROM questions
                WHERE certification_id = ? AND question_key = ?
              )) AS audits`,
      )
      .bind(
        actor.certificationId,
        concurrentQuestionKey,
        actor.certificationId,
        concurrentQuestionKey,
        actor.certificationId,
        actor.certificationId,
        concurrentQuestionKey,
      )
      .first<{ questions: number; revisions: number; audits: number }>();
    expect(concurrentQuestionCount).toEqual({ questions: 1, revisions: 1, audits: 1 });
  });

  it("accepts maximum-length eight-option content and rejects oversized streamed JSON", async () => {
    const actor = await createActor();
    const versionResponse = await call(
      actor,
      `${apiRoot}/certifications/${actor.certificationId}/exam-versions`,
      {
        method: "POST",
        body: JSON.stringify({
          versionKey: `max-content-${crypto.randomUUID()}`,
          title: "Synthetic maximum content version",
          syllabusReference: "Synthetic syllabus",
        }),
      },
    );
    const versionId = ((await versionResponse.json()) as { id: string }).id;
    const versionPathValue = versionPath(actor, versionId);
    const domainResponse = await call(actor, `${versionPathValue}/domains`, {
      method: "POST",
      body: JSON.stringify({
        domainKey: `max-domain-${crypto.randomUUID()}`,
        title: "Synthetic maximum content domain",
        meaning: "Synthetic meaning",
        order: 0,
      }),
    });
    const domainId = ((await domainResponse.json()) as { id: string }).id;
    const topicResponse = await call(
      actor,
      `${versionPathValue}/domains/${domainId}/topics`,
      {
        method: "POST",
        body: JSON.stringify({
          topicKey: `max-topic-${crypto.randomUUID()}`,
          title: "Synthetic maximum content topic",
          meaning: "Synthetic meaning",
          order: 0,
        }),
      },
    );
    const topicId = ((await topicResponse.json()) as { id: string }).id;
    const maxLengthString = (maxCodeUnits: number) =>
      `${"😀".repeat(maxCodeUnits / 2 - 1)}\u0001\u0002`;
    const content = {
      stem: maxLengthString(4000),
      difficulty: "hard",
      sourceReference: maxLengthString(1000),
      licenseReference: maxLengthString(200),
      options: Array.from({ length: 8 }, (_, index) => ({
        key: `OPTION-${index + 1}`,
        text: maxLengthString(1000),
        correct: index === 0,
        explanation: maxLengthString(3000),
      })),
    };
    const questionKey = `maximum-question-${crypto.randomUUID()}`;
    const questionRequest = {
      questionKey,
      domainId,
      topicId,
      content,
    };
    const questionBody = JSON.stringify(questionRequest);
    expect(new TextEncoder().encode(questionBody).byteLength).toBeGreaterThan(32 * 1024);
    expect(new TextEncoder().encode(questionBody).byteLength).toBeLessThanOrEqual(256 * 1024);
    const question = await call(actor, `${versionPathValue}/questions`, {
      method: "POST",
      body: questionBody,
    });
    expect(question.status).toBe(201);
    const created = (await question.json()) as {
      questionId: string;
      revisionNumber: number;
    };
    expect(created.revisionNumber).toBe(1);

    const correctionBody = JSON.stringify({
      domainId,
      topicId,
      expectedLockVersion: 1,
      content,
    });
    expect(new TextEncoder().encode(correctionBody).byteLength).toBeGreaterThan(32 * 1024);
    const correction = await call(
      actor,
      `${versionPathValue}/questions/${created.questionId}/revisions`,
      { method: "POST", body: correctionBody },
    );
    expect(correction.status).toBe(201);
    expect(await correction.json()).toMatchObject({ revisionNumber: 2 });

    const oversizedQuestionKey = `oversized-question-${crypto.randomUUID()}`;
    const oversizedBody = JSON.stringify({
      ...questionRequest,
      questionKey: oversizedQuestionKey,
      padding: "x".repeat(256 * 1024),
    });
    const chunked = await api.fetch(
      new Request(
        requestUrl(`${versionPathValue}/questions`),
        {
          method: "POST",
          headers: {
            Cookie: `certpath_session=${actor.rawToken}`,
            Origin: origin,
            "X-CSRF-Token": actor.csrfToken ?? (await getCsrf(actor)),
            "Content-Type": "application/json",
          },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              const bytes = new TextEncoder().encode(oversizedBody);
              for (let offset = 0; offset < bytes.byteLength; offset += 32 * 1024) {
                controller.enqueue(bytes.slice(offset, offset + 32 * 1024));
              }
              controller.close();
            },
          }),
          duplex: "half",
        } as RequestInit,
      ),
      actor.bindings,
    );
    expect(chunked.status).toBe(413);
    assertPrivate(chunked);
    const noOversizedQuestion = await database
      .prepare(
        `SELECT COUNT(*) AS count FROM questions
         WHERE certification_id = ? AND question_key = ?`,
      )
        .bind(actor.certificationId, oversizedQuestionKey)
      .first<{ count: number }>();
    expect(noOversizedQuestion?.count).toBe(0);
  });

  it("supports scoped editor reads and Manager draft corrections through Worker/D1", async () => {
    const manager = await createActor({ role: "manager" });
    const unassigned = await createActor({ role: "manager", assigned: false });
    const versionsPath = `${apiRoot}/certifications/${manager.certificationId}/exam-versions`;
    const certificationPage = await call(
      manager,
      `${apiRoot}/certifications?limit=1`,
    );
    expect(certificationPage.status).toBe(200);
    assertPrivate(certificationPage);
    const certifications = (await certificationPage.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(certifications.items.map(({ id }) => id)).toContain(manager.certificationId);
    expect(certifications.items.map(({ id }) => id)).not.toContain(unassigned.certificationId);

    const versionResponse = await call(manager, versionsPath, {
      method: "POST",
      body: JSON.stringify({
        versionKey: `editor-${crypto.randomUUID()}`,
        title: "Synthetic editor version",
        syllabusReference: "Synthetic syllabus",
      }),
    });
    expect(versionResponse.status).toBe(201);
    const versionId = ((await versionResponse.json()) as { id: string }).id;
    const versionsPage = await call(
      manager,
      `${apiRoot}/certifications/${manager.certificationId}/exam-versions?limit=1`,
    );
    expect(versionsPage.status).toBe(200);
    assertPrivate(versionsPage);
    expect(
      ((await versionsPage.json()) as { items: Array<{ id: string }> }).items.map(({ id }) => id),
    ).toContain(versionId);

    const scopedVersionPath = versionPath(manager, versionId);
    const domainResponse = await call(manager, `${scopedVersionPath}/domains`, {
      method: "POST",
      body: JSON.stringify({
        domainKey: `editor-domain-${crypto.randomUUID()}`,
        title: "Synthetic editor domain",
        meaning: "Synthetic stable domain meaning",
        order: 0,
      }),
    });
    expect(domainResponse.status).toBe(201);
    const domainId = ((await domainResponse.json()) as { id: string }).id;
    const domainPage = await call(manager, `${scopedVersionPath}/domains?limit=1`);
    expect(domainPage.status).toBe(200);
    assertPrivate(domainPage);
    expect(
      ((await domainPage.json()) as { items: Array<{ id: string }> }).items.map(({ id }) => id),
    ).toContain(domainId);

    const topicResponse = await call(
      manager,
      `${scopedVersionPath}/domains/${domainId}/topics`,
      {
        method: "POST",
        body: JSON.stringify({
          topicKey: `editor-topic-${crypto.randomUUID()}`,
          title: "Synthetic editor topic",
          meaning: "Synthetic stable topic meaning",
          order: 0,
        }),
      },
    );
    expect(topicResponse.status).toBe(201);
    const topicId = ((await topicResponse.json()) as { id: string }).id;
    const topicPage = await call(
      manager,
      `${scopedVersionPath}/domains/${domainId}/topics?limit=1`,
    );
    expect(topicPage.status).toBe(200);
    assertPrivate(topicPage);
    expect(
      ((await topicPage.json()) as { items: Array<{ id: string }> }).items.map(({ id }) => id),
    ).toContain(topicId);

    const questionKey = `manager-question-${crypto.randomUUID()}`;
    const questionResponse = await call(manager, `${scopedVersionPath}/questions`, {
      method: "POST",
      body: JSON.stringify({
        questionKey,
        domainId,
        topicId,
        content: validQuestionContent,
      }),
    });
    expect(questionResponse.status).toBe(201);
    const createdQuestion = (await questionResponse.json()) as {
      questionId: string;
      revisionId: string;
      revisionNumber: number;
    };
    expect(createdQuestion.revisionNumber).toBe(1);
    const secondQuestionResponse = await call(manager, `${scopedVersionPath}/questions`, {
      method: "POST",
      body: JSON.stringify({
        questionKey: `${questionKey}-second`,
        domainId,
        topicId,
        content: validQuestionContent,
      }),
    });
    expect(secondQuestionResponse.status).toBe(201);
    const questionListPath =
      `${scopedVersionPath}/questions?domainId=${domainId}` +
      `&topicId=${topicId}&limit=1&search=${encodeURIComponent(questionKey)}`;
    const questionPage = await call(manager, questionListPath);
    expect(questionPage.status).toBe(200);
    assertPrivate(questionPage);
    const listedQuestions = (await questionPage.json()) as {
      items: Array<{ id: string; currentRevisionId: string }>;
      nextCursor: string | null;
    };
    expect(listedQuestions.items).toHaveLength(1);
    expect(listedQuestions.nextCursor).toBeTruthy();
    const exactQuestionSummary = await call(
      manager,
      `${scopedVersionPath}/questions?domainId=${domainId}` +
        `&topicId=${topicId}&questionId=${createdQuestion.questionId}`,
    );
    expect(exactQuestionSummary.status).toBe(200);
    assertPrivate(exactQuestionSummary);
    expect(await exactQuestionSummary.json()).toMatchObject({
      items: [{
        id: createdQuestion.questionId,
        currentRevisionId: createdQuestion.revisionId,
        revisionNumber: 1,
        lockVersion: 1,
      }],
      nextCursor: null,
    });
    const secondQuestionPage = await call(
      manager,
      `${scopedVersionPath}/questions?domainId=${domainId}` +
        `&topicId=${topicId}&limit=1&search=${encodeURIComponent(questionKey)}` +
        `&cursor=${listedQuestions.nextCursor}`,
    );
    expect(secondQuestionPage.status).toBe(200);
    assertPrivate(secondQuestionPage);
    const secondPage = (await secondQuestionPage.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.id).not.toBe(listedQuestions.items[0]?.id);
    expect(secondPage.nextCursor).toBeNull();

    const questionPath = `${scopedVersionPath}/questions/${createdQuestion.questionId}`;
    const revisionsResponse = await call(manager, `${questionPath}/revisions?limit=1`);
    expect(revisionsResponse.status).toBe(200);
    assertPrivate(revisionsResponse);
    expect(
      ((await revisionsResponse.json()) as { items: Array<{ id: string; revisionNumber: number }> })
        .items,
    ).toEqual([{ id: createdQuestion.revisionId, revisionNumber: 1, workflowState: "draft", createdAt: expect.any(Number) }]);

    const firstRevisionPath =
      `${questionPath}/revisions/${createdQuestion.revisionId}`;
    const firstRevision = await call(manager, firstRevisionPath);
    expect(firstRevision.status).toBe(200);
    const firstBefore = await firstRevision.json() as {
      revisionNumber: number;
      stem: string;
      options: unknown[];
    };
    const correctedContent = {
      ...validQuestionContent,
      stem: "Which revised control most directly limits unauthorized access?",
    };
    const corrected = await call(manager, `${questionPath}/revisions`, {
      method: "POST",
      body: JSON.stringify({
        domainId,
        topicId,
        expectedLockVersion: 1,
        content: correctedContent,
      }),
    });
    expect(corrected.status).toBe(201);
    assertPrivate(corrected);
    const createdCorrection = (await corrected.json()) as {
      revisionId: string;
      revisionNumber: number;
    };
    expect(createdCorrection.revisionNumber).toBe(2);
    const originalAfter = await call(manager, firstRevisionPath);
    expect(originalAfter.status).toBe(200);
    expect(await originalAfter.json()).toMatchObject({
      revisionNumber: firstBefore.revisionNumber,
      stem: firstBefore.stem,
      options: firstBefore.options,
    });
    const revisionHistory = await call(manager, `${questionPath}/revisions?limit=2`);
    expect(revisionHistory.status).toBe(200);
    expect(
      ((await revisionHistory.json()) as { items: Array<{ revisionNumber: number }> }).items,
    ).toHaveLength(2);
    const staleCorrection = await call(manager, `${questionPath}/revisions`, {
      method: "POST",
      body: JSON.stringify({
        domainId,
        topicId,
        expectedLockVersion: 1,
        content: {
          ...correctedContent,
          stem: "Stale manager edit must not be stored.",
        },
      }),
    });
    expect(staleCorrection.status).toBe(409);
    assertPrivate(staleCorrection);
    const historyAfterStaleEdit = await call(manager, `${questionPath}/revisions?limit=10`);
    expect(
      ((await historyAfterStaleEdit.json()) as { items: Array<{ revisionNumber: number }> }).items,
    ).toHaveLength(2);

    const inaccessibleCertifications = await call(
      unassigned,
      `${apiRoot}/certifications`,
    );
    expect(inaccessibleCertifications.status).toBe(200);
    assertPrivate(inaccessibleCertifications);
    expect(
      ((await inaccessibleCertifications.json()) as { items: Array<{ id: string }> }).items.map(
        ({ id }) => id,
      ),
    ).not.toContain(manager.certificationId);
    const unassignedQuestionList = await call(
      unassigned,
      `${apiRoot}/certifications/${manager.certificationId}/exam-versions/${versionId}/questions?domainId=${domainId}&topicId=${topicId}`,
    );
    expect(unassignedQuestionList.status).toBe(404);
    assertPrivate(unassignedQuestionList);
    const unassignedRevision = await call(unassigned, firstRevisionPath);
    expect(unassignedRevision.status).toBe(404);
    assertPrivate(unassignedRevision);
    const unassignedCorrection = await call(unassigned, `${questionPath}/revisions`, {
      method: "POST",
      body: JSON.stringify({
        domainId,
        topicId,
        expectedLockVersion: 2,
        content: correctedContent,
      }),
    });
    expect(unassignedCorrection.status).toBe(404);
    assertPrivate(unassignedCorrection);

    const expiredNow = Date.now() - 10_000;
    const expired = await createActor({
      role: "manager",
      now: expiredNow,
      expiresAt: expiredNow + 1_000,
    });
    const expiredRead = await call(expired, `${apiRoot}/certifications`);
    expect(expiredRead.status).toBe(401);
    assertPrivate(expiredRead);

    const csrfDenied = await call(
      manager,
      `${scopedVersionPath}/questions`,
      {
        method: "POST",
        csrf: false,
        body: JSON.stringify({
          questionKey: `csrf-question-${crypto.randomUUID()}`,
          domainId,
          topicId,
          content: validQuestionContent,
        }),
      },
    );
    expect(csrfDenied.status).toBe(400);
    assertPrivate(csrfDenied);
  });

  it("creates, reads, corrects, reviews, publishes, supersedes and retires scoped content", async () => {
    const actor = await createActor();
    const createVersion = await call(
      actor,
      `${apiRoot}/certifications/${actor.certificationId}/exam-versions`,
      {
        method: "POST",
        body: JSON.stringify({
          versionKey: `v-${crypto.randomUUID()}`,
          title: "Synthetic version",
          syllabusReference: "Synthetic syllabus",
        }),
      },
    );
    expect(createVersion.status).toBe(201);
    assertPrivate(createVersion);
    const versionId = ((await createVersion.json()) as { id: string }).id;
    const versionPathValue = versionPath(actor, versionId);

    const domainResponse = await call(actor, `${versionPathValue}/domains`, {
      method: "POST",
      body: JSON.stringify({
        domainKey: `domain-${crypto.randomUUID()}`,
        title: "Synthetic domain",
        meaning: "Stable synthetic meaning",
        order: 0,
      }),
    });
    expect(domainResponse.status).toBe(201);
    const domainId = ((await domainResponse.json()) as { id: string }).id;
    const topicResponse = await call(
      actor,
      `${versionPathValue}/domains/${domainId}/topics`,
      {
        method: "POST",
        body: JSON.stringify({
          topicKey: `topic-${crypto.randomUUID()}`,
          title: "Synthetic topic",
          meaning: "Stable synthetic meaning",
          order: 0,
        }),
      },
    );
    expect(topicResponse.status).toBe(201);
    const topicId = ((await topicResponse.json()) as { id: string }).id;

    const questionResponse = await call(actor, `${versionPathValue}/questions`, {
      method: "POST",
      body: JSON.stringify({
        questionKey: `question-${crypto.randomUUID()}`,
        domainId,
        topicId,
        content: validQuestionContent,
      }),
    });
    expect(questionResponse.status).toBe(201);
    const question = (await questionResponse.json()) as {
      questionId: string;
      revisionId: string;
      revisionNumber: number;
    };
    expect(question.revisionNumber).toBe(1);

    const revisionPath = `${versionPathValue}/questions/${question.questionId}/revisions/${question.revisionId}`;
    const read = await call(actor, revisionPath);
    expect(read.status).toBe(200);
    const readContent = (await read.json()) as {
      revisionId: string;
      options: Array<{ correct: boolean }>;
    };
    expect(readContent.revisionId).toBe(question.revisionId);
    expect(readContent.options[0]?.correct).toBe(true);
    assertPrivate(read);
    expect(
      (
        await call(
          actor,
          `${versionPathValue}/questions/not-the-question/revisions/${question.revisionId}`,
        )
      ).status,
    ).toBe(404);

    const submitted = await call(actor, `${revisionPath}/submit`, {
      method: "POST",
      body: "{}",
    });
    expect(submitted.status).toBe(200);
    const reviewed = await call(actor, `${revisionPath}/review`, {
      method: "POST",
      body: JSON.stringify({ decision: "approved", notes: "Synthetic review" }),
    });
    expect(reviewed.status).toBe(201);
    const published = await call(
      actor,
      `${versionPathValue}/questions/${question.questionId}/publish`,
      {
        method: "POST",
        body: JSON.stringify({
          revisionId: question.revisionId,
          expectedPointerVersion: null,
        }),
      },
    );
    expect(published.status).toBe(200);
    expect(await published.json()).toEqual({ pointerVersion: 1 });

    const stalePublish = await call(
      actor,
      `${versionPathValue}/questions/${question.questionId}/publish`,
      {
        method: "POST",
        body: JSON.stringify({
          revisionId: question.revisionId,
          expectedPointerVersion: null,
        }),
      },
    );
    expect(stalePublish.status).toBe(409);

    const correction = await call(
      actor,
      `${versionPathValue}/questions/${question.questionId}/revisions`,
      {
        method: "POST",
        body: JSON.stringify({
          domainId,
          topicId,
          expectedLockVersion: 1,
          content: {
            ...validQuestionContent,
            stem: "Corrected synthetic question stem?",
          },
        }),
      },
    );
    expect(correction.status).toBe(201);
    const corrected = (await correction.json()) as { revisionId: string; revisionNumber: number };
    expect(corrected.revisionNumber).toBe(2);
    expect(
      (
        await call(
          actor,
          `${versionPathValue}/questions/${question.questionId}/revisions`,
          {
            method: "POST",
            body: JSON.stringify({
              domainId,
              topicId,
              expectedLockVersion: 1,
              content: validQuestionContent,
            }),
          },
        )
      ).status,
    ).toBe(409);

    const correctedPath = `${versionPathValue}/questions/${question.questionId}/revisions/${corrected.revisionId}`;
    expect((await call(actor, `${correctedPath}/submit`, {
      method: "POST",
      body: "{}",
    })).status).toBe(200);
    expect((await call(actor, `${correctedPath}/review`, {
      method: "POST",
      body: JSON.stringify({ decision: "approved", notes: "Correction reviewed" }),
    })).status).toBe(201);
    expect((await call(
      actor,
      `${versionPathValue}/questions/${question.questionId}/publish`,
      {
        method: "POST",
        body: JSON.stringify({
          revisionId: corrected.revisionId,
          expectedPointerVersion: 1,
        }),
      },
    )).status).toBe(200);
    const exportResponse = await call(
      actor,
      `${versionPathValue}/export?limit=1`,
    );
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get("content-type")).toContain("text/csv");
    expect(await exportResponse.text()).toContain(
      "Corrected synthetic question stem?",
    );
    assertPrivate(exportResponse);
    expect(
      (
        await call(actor, `${versionPathValue}/export?limit=101`)
      ).status,
    ).toBe(400);

    const nextVersion = await call(
      actor,
      `${apiRoot}/certifications/${actor.certificationId}/exam-versions`,
      {
        method: "POST",
        body: JSON.stringify({
          versionKey: `next-${crypto.randomUUID()}`,
          title: "Synthetic subsequent version",
          syllabusReference: "Synthetic updated syllabus",
        }),
      },
    );
    const nextVersionId = ((await nextVersion.json()) as { id: string }).id;
    const nextVersionPath = versionPath(actor, nextVersionId);
    const nextDomainResponse = await call(actor, `${nextVersionPath}/domains`, {
      method: "POST",
      body: JSON.stringify({
        domainKey: `next-domain-${crypto.randomUUID()}`,
        title: "Synthetic subsequent domain",
        meaning: "New-version synthetic meaning",
        order: 0,
      }),
    });
    const nextDomainId = ((await nextDomainResponse.json()) as { id: string }).id;
    const nextTopicResponse = await call(
      actor,
      `${nextVersionPath}/domains/${nextDomainId}/topics`,
      {
        method: "POST",
        body: JSON.stringify({
          topicKey: `next-topic-${crypto.randomUUID()}`,
          title: "Synthetic subsequent topic",
          meaning: "New-version synthetic meaning",
          order: 0,
        }),
      },
    );
    const nextTopicId = ((await nextTopicResponse.json()) as { id: string }).id;
    const nextVersionRevision = await call(
      actor,
      `${nextVersionPath}/questions/${question.questionId}/revisions`,
      {
        method: "POST",
        body: JSON.stringify({
          domainId: nextDomainId,
          topicId: nextTopicId,
          expectedLockVersion: 2,
          content: validQuestionContent,
        }),
      },
    );
    expect(nextVersionRevision.status).toBe(201);
    expect(await nextVersionRevision.json()).toMatchObject({
      revisionNumber: 3,
    });

    const retired = await call(
      actor,
      `${versionPathValue}/questions/${question.questionId}/retire`,
      {
        method: "POST",
        body: JSON.stringify({ expectedPointerVersion: 2 }),
      },
    );
    expect(retired.status).toBe(200);
    expect(await retired.json()).toEqual({ pointerVersion: 3 });
  });

  it("supports the assigned Manager review, publication replacement, retirement and exact status read", async () => {
    const manager = await createActor({ role: "manager" });
    const unassigned = await createActor({ role: "manager", assigned: false });
    const versionResponse = await call(
      manager,
      `${apiRoot}/certifications/${manager.certificationId}/exam-versions`,
      {
        method: "POST",
        body: JSON.stringify({
          versionKey: `workflow-${crypto.randomUUID()}`,
          title: "Synthetic workflow version",
          syllabusReference: "Synthetic workflow syllabus",
        }),
      },
    );
    expect(versionResponse.status).toBe(201);
    const versionId = ((await versionResponse.json()) as { id: string }).id;
    const scopedVersion = versionPath(manager, versionId);
    const domainResponse = await call(manager, `${scopedVersion}/domains`, {
      method: "POST",
      body: JSON.stringify({
        domainKey: `workflow-domain-${crypto.randomUUID()}`,
        title: "Synthetic workflow domain",
        meaning: "Synthetic stable domain meaning",
        order: 0,
      }),
    });
    const domainId = ((await domainResponse.json()) as { id: string }).id;
    const topicResponse = await call(
      manager,
      `${scopedVersion}/domains/${domainId}/topics`,
      {
        method: "POST",
        body: JSON.stringify({
          topicKey: `workflow-topic-${crypto.randomUUID()}`,
          title: "Synthetic workflow topic",
          meaning: "Synthetic stable topic meaning",
          order: 0,
        }),
      },
    );
    const topicId = ((await topicResponse.json()) as { id: string }).id;
    const questionResponse = await call(manager, `${scopedVersion}/questions`, {
      method: "POST",
      body: JSON.stringify({
        questionKey: `workflow-question-${crypto.randomUUID()}`,
        domainId,
        topicId,
        content: validQuestionContent,
      }),
    });
    expect(questionResponse.status).toBe(201);
    const question = (await questionResponse.json()) as {
      questionId: string;
      revisionId: string;
      revisionNumber: number;
    };
    const questionPath = `${scopedVersion}/questions/${question.questionId}`;
    const publicationPath = `${questionPath}/publication`;
    const firstRevisionPath = `${questionPath}/revisions/${question.revisionId}`;

    const initialPublication = await call(manager, publicationPath);
    expect(initialPublication.status).toBe(200);
    expect(await initialPublication.json()).toEqual({
      questionId: question.questionId,
      publication: null,
    });
    assertPrivate(initialPublication);
    const unassignedPublication = await call(unassigned, publicationPath);
    expect(unassignedPublication.status).toBe(404);
    assertPrivate(unassignedPublication);

    expect((await call(manager, `${firstRevisionPath}/submit`, {
      method: "POST",
      body: "{}",
    })).status).toBe(200);
    const submitted = await call(manager, firstRevisionPath);
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toMatchObject({
      revisionId: question.revisionId,
      workflowState: "submitted",
    });
    expect((await call(manager, `${firstRevisionPath}/review`, {
      method: "POST",
      body: JSON.stringify({ decision: "rejected", notes: "Synthetic correction requested." }),
    })).status).toBe(201);
    expect(await (await call(manager, firstRevisionPath)).json()).toMatchObject({
      workflowState: "rejected",
    });

    const correctedResponse = await call(manager, `${questionPath}/revisions`, {
      method: "POST",
      body: JSON.stringify({
        domainId,
        topicId,
        expectedLockVersion: 1,
        content: {
          ...validQuestionContent,
          stem: "Corrected synthetic reviewed question?",
        },
      }),
    });
    expect(correctedResponse.status).toBe(201);
    const corrected = (await correctedResponse.json()) as {
      revisionId: string;
      revisionNumber: number;
    };
    expect(corrected.revisionNumber).toBe(2);
    expect(await (await call(manager, firstRevisionPath)).json()).toMatchObject({
      revisionId: question.revisionId,
      stem: validQuestionContent.stem,
      workflowState: "rejected",
    });
    expect((await call(manager, `${firstRevisionPath}/review`, {
      method: "POST",
      body: JSON.stringify({ decision: "approved", notes: "Wrong revision." }),
    })).status).toBe(409);
    const correctedPath = `${questionPath}/revisions/${corrected.revisionId}`;
    expect((await call(manager, `${correctedPath}/submit`, {
      method: "POST",
      body: "{}",
    })).status).toBe(200);
    expect(await (await call(manager, correctedPath)).json()).toMatchObject({
      revisionId: corrected.revisionId,
      workflowState: "submitted",
      stem: "Corrected synthetic reviewed question?",
    });
    expect((await call(manager, `${correctedPath}/review`, {
      method: "POST",
      body: JSON.stringify({ decision: "approved", notes: "Exact revision approved." }),
    })).status).toBe(201);
    expect(await (await call(manager, correctedPath)).json()).toMatchObject({
      workflowState: "approved",
    });

    const publishPath = `${questionPath}/publish`;
    const firstPublish = await call(manager, publishPath, {
      method: "POST",
      body: JSON.stringify({
        revisionId: corrected.revisionId,
        expectedPointerVersion: null,
      }),
    });
    expect(firstPublish.status).toBe(200);
    expect(await firstPublish.json()).toEqual({ pointerVersion: 1 });
    expect(await (await call(manager, correctedPath)).json()).toMatchObject({
      revisionId: corrected.revisionId,
      workflowState: "published",
    });

    const replacementResponse = await call(manager, `${questionPath}/revisions`, {
      method: "POST",
      body: JSON.stringify({
        domainId,
        topicId,
        expectedLockVersion: 2,
        content: {
          ...validQuestionContent,
          stem: "Approved replacement synthetic question?",
        },
      }),
    });
    expect(replacementResponse.status).toBe(201);
    const replacement = (await replacementResponse.json()) as { revisionId: string };
    const replacementPath = `${questionPath}/revisions/${replacement.revisionId}`;
    expect((await call(manager, `${replacementPath}/submit`, {
      method: "POST",
      body: "{}",
    })).status).toBe(200);
    expect((await call(manager, `${replacementPath}/review`, {
      method: "POST",
      body: JSON.stringify({ decision: "approved", notes: "Synthetic replacement approved." }),
    })).status).toBe(201);
    const replacePublication = await call(manager, publishPath, {
      method: "POST",
      body: JSON.stringify({
        revisionId: replacement.revisionId,
        expectedPointerVersion: 1,
      }),
    });
    expect(replacePublication.status).toBe(200);
    expect(await replacePublication.json()).toEqual({ pointerVersion: 2 });
    expect(await (await call(manager, correctedPath)).json()).toMatchObject({
      revisionId: corrected.revisionId,
      workflowState: "superseded",
    });
    expect(await (await call(manager, replacementPath)).json()).toMatchObject({
      revisionId: replacement.revisionId,
      workflowState: "published",
    });
    const publicationStatus = await call(manager, publicationPath);
    expect(publicationStatus.status).toBe(200);
    expect(await publicationStatus.json()).toEqual({
      questionId: question.questionId,
      publication: {
        revisionId: replacement.revisionId,
        state: "published",
        pointerVersion: 2,
        changedAt: expect.any(Number),
      },
    });
    assertPrivate(publicationStatus);

    const retirePath = `${questionPath}/retire`;
    const staleRetirement = await call(manager, retirePath, {
      method: "POST",
      body: JSON.stringify({ expectedPointerVersion: 1 }),
    });
    expect(staleRetirement.status).toBe(409);
    assertPrivate(staleRetirement);
    expect(await (await call(manager, publicationPath)).json()).toMatchObject({
      publication: {
        revisionId: replacement.revisionId,
        state: "published",
        pointerVersion: 2,
      },
    });
    const retirement = await call(manager, retirePath, {
      method: "POST",
      body: JSON.stringify({ expectedPointerVersion: 2 }),
    });
    expect(retirement.status).toBe(200);
    assertPrivate(retirement);
    expect(await retirement.json()).toEqual({ pointerVersion: 3 });
    expect(await (await call(manager, replacementPath)).json()).toMatchObject({
      revisionId: replacement.revisionId,
      workflowState: "retired",
    });
    expect(await (await call(manager, publicationPath)).json()).toMatchObject({
      publication: {
        revisionId: replacement.revisionId,
        state: "retired",
        pointerVersion: 3,
      },
    });
    expect((await call(manager, replacementPath)).status).toBe(200);
    const futureSelection = await call(
      manager,
      `${scopedVersion}/export`,
    );
    expect(futureSelection.status).toBe(200);
    assertPrivate(futureSelection);
    expect(await futureSelection.text()).not.toContain(
      "Approved replacement synthetic question?",
    );
    expect((await call(unassigned, publicationPath)).status).toBe(404);

    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count FROM content_publication_events
           WHERE question_id = ?`,
        )
        .bind(question.questionId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 3 });
    expect(
      await database
        .prepare(
          `SELECT reviewer_user_id FROM content_reviews
           WHERE question_revision_id = ? AND decision = 'approved'
           ORDER BY reviewed_at DESC LIMIT 1`,
        )
        .bind(replacement.revisionId)
        .first<{ reviewer_user_id: string }>(),
    ).toMatchObject({ reviewer_user_id: manager.userId });
    expect(
      await database
        .prepare(
          `SELECT changed_by_user_id FROM exam_version_questions
           WHERE question_id = ?`,
        )
        .bind(question.questionId)
        .first<{ changed_by_user_id: string }>(),
    ).toMatchObject({ changed_by_user_id: manager.userId });
  });

  it("supports bounded import preview, idempotent confirmation, expiry, and scoped export", async () => {
    const actor = await createActor();
    const versionId = crypto.randomUUID();
    const createVersion = await call(
      actor,
      `${apiRoot}/certifications/${actor.certificationId}/exam-versions`,
      {
        method: "POST",
        body: JSON.stringify({
          versionKey: `v-${versionId}`,
          title: "Synthetic import version",
          syllabusReference: "Synthetic syllabus",
        }),
      },
    );
    expect(createVersion.status).toBe(201);
    const actualVersionId = ((await createVersion.json()) as { id: string }).id;
    const versionPathValue = versionPath(actor, actualVersionId);
    const domainResponse = await call(actor, `${versionPathValue}/domains`, {
      method: "POST",
      body: JSON.stringify({
        domainKey: `d-${versionId}`,
        title: "Synthetic domain",
        meaning: "Synthetic meaning",
        order: 0,
      }),
    });
    const domainId = ((await domainResponse.json()) as { id: string }).id;
    const topicResponse = await call(actor, `${versionPathValue}/domains/${domainId}/topics`, {
      method: "POST",
      body: JSON.stringify({
        topicKey: `t-${versionId}`,
        title: "Synthetic topic",
        meaning: "Synthetic meaning",
        order: 0,
      }),
    });
    const topicId = ((await topicResponse.json()) as { id: string }).id;
    const csv = csvFile(
      contentRow(actualVersionId, domainId, topicId, `import-${versionId}`),
    );
    const previewResponse = await call(
      actor,
      `${versionPathValue}/import-previews`,
      {
        method: "POST",
        body: new TextDecoder().decode(csv),
        contentType: "text/csv",
      },
    );
    expect(previewResponse.status).toBe(201);
    const preview = (await previewResponse.json()) as { importId: string };
    const confirmPath = `${apiRoot}/certifications/${actor.certificationId}/import-previews/${preview.importId}/confirm`;
    const confirmed = await call(actor, confirmPath, {
      method: "POST",
      body: "{}",
    });
    expect(confirmed.status).toBe(200);
    const outcome = await confirmed.json();
    expect(outcome).toMatchObject({ importId: preview.importId });
    const retry = await call(actor, confirmPath, {
      method: "POST",
      body: "{}",
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(outcome);

    const expiredActor = await createActor({
      now: Date.now() - 15 * 60_000,
      expiresAt: Date.now() + 60 * 60_000,
      maxMfaAge: "3600000",
    });
    const expiredVersion = crypto.randomUUID();
    const expiredScopeVersion = await call(
      expiredActor,
      `${apiRoot}/certifications/${expiredActor.certificationId}/exam-versions`,
      {
        method: "POST",
        body: JSON.stringify({
          versionKey: `v-${expiredVersion}`,
          title: "Synthetic expired-preview version",
          syllabusReference: "Synthetic syllabus",
        }),
      },
    );
    const expiredVersionId = ((await expiredScopeVersion.json()) as { id: string }).id;
    const expiredDomainResponse = await call(
      expiredActor,
      versionPath(expiredActor, expiredVersionId) + "/domains",
      {
        method: "POST",
        body: JSON.stringify({
          domainKey: `d-${expiredVersion}`,
          title: "Synthetic domain",
          meaning: "Synthetic meaning",
          order: 0,
        }),
      },
    );
    const expiredDomainId = ((await expiredDomainResponse.json()) as { id: string }).id;
    const expiredTopicResponse = await call(
      expiredActor,
      `${versionPath(expiredActor, expiredVersionId)}/domains/${expiredDomainId}/topics`,
      {
        method: "POST",
        body: JSON.stringify({
          topicKey: `t-${expiredVersion}`,
          title: "Synthetic topic",
          meaning: "Synthetic meaning",
          order: 0,
        }),
      },
    );
    const expiredTopicId = ((await expiredTopicResponse.json()) as { id: string }).id;
    const oldNow = Date.now() - 15 * 60_000;
    const oldPreview = await previewQuestionImport(
      database,
      {
        tokenDigest: expiredActor.tokenDigest,
        certificationId: expiredActor.certificationId,
        examVersionId: expiredVersionId,
        fileBytes: csvFile(
          contentRow(
            expiredVersionId,
            expiredDomainId,
            expiredTopicId,
            `expired-${expiredVersion}`,
          ),
        ),
        now: oldNow,
      },
      {
        maxAgeMs: 3_600_000,
        allowedMethods: ["totp"],
      },
    );
    expect(oldPreview.ok).toBe(true);
    if (!oldPreview.ok) return;
    const expiredConfirm = await call(
      expiredActor,
      `${apiRoot}/certifications/${expiredActor.certificationId}/import-previews/${oldPreview.value.importId}/confirm`,
      { method: "POST", body: "{}" },
    );
    expect(expiredConfirm.status).toBe(409);

    const unassigned = await createActor({
      role: "manager",
      assigned: false,
    });
    const deniedExport = await call(
      unassigned,
      `${apiRoot}/certifications/${actor.certificationId}/exam-versions/${actualVersionId}/export`,
    );
    expect(deniedExport.status).toBe(404);
    assertPrivate(deniedExport);
  });

  it("rejects invalid nested/cross-certification references and oversized declared bodies", async () => {
    const actor = await createActor();
    const otherActor = await createActor();
    const versionId = crypto.randomUUID();
    const createdVersion = await call(
      actor,
      `${apiRoot}/certifications/${actor.certificationId}/exam-versions`,
      {
        method: "POST",
        body: JSON.stringify({
          versionKey: `v-${versionId}`,
          title: "Synthetic scope version",
          syllabusReference: "Synthetic syllabus",
        }),
      },
    );
    const actualVersionId = ((await createdVersion.json()) as { id: string }).id;
    const foreignVersionPath = versionPath(otherActor, actualVersionId);
    expect(
      (
        await call(otherActor, `${foreignVersionPath}/domains`, {
          method: "POST",
          body: JSON.stringify({
            domainKey: "foreign",
            title: "Synthetic",
            meaning: "Synthetic",
            order: 0,
          }),
        })
      ).status,
    ).toBe(404);

    const oversizedHeaders = new Headers({
      Cookie: `certpath_session=${actor.rawToken}`,
      Origin: origin,
      "X-CSRF-Token": await getCsrf(actor),
      "Content-Type": "application/json",
      "Content-Length": "33000",
    });
    const tooLarge = await api.fetch(
      new Request(requestUrl(`${apiRoot}/certifications/${actor.certificationId}/exam-versions`), {
        method: "POST",
        headers: oversizedHeaders,
        body: "{}",
      }),
      actor.bindings,
    );
    expect(tooLarge.status).toBe(413);

    const invalidId = await call(
      actor,
      `${apiRoot}/certifications/%2F/exam-versions`,
      { method: "POST", body: "{}" },
    );
    expect([400, 404]).toContain(invalidId.status);
  });

  it("sanitizes D1 failures and preserves public health behavior", async () => {
    const actor = await createActor();
    await database.prepare(
      `CREATE TRIGGER protected_api_test_audit_failure
       BEFORE INSERT ON audit_events
       WHEN NEW.action = 'exam_version_created'
         AND NEW.reason = 'Protected content API: create-exam-version'
       BEGIN SELECT RAISE(ABORT, 'sensitive synthetic SQL failure'); END`,
    ).run();
    try {
      const failed = await call(
        actor,
        `${apiRoot}/certifications/${actor.certificationId}/exam-versions`,
        {
          method: "POST",
          body: JSON.stringify({
            versionKey: `v-${crypto.randomUUID()}`,
            title: "Synthetic failure case",
            syllabusReference: "Synthetic only",
          }),
        },
      );
      expect(failed.status).toBe(503);
      const body = await failed.text();
      expect(body).toContain("service_unavailable");
      expect(body).not.toContain("sensitive synthetic SQL failure");
      expect(body).not.toContain(actor.rawToken);
      assertPrivate(failed);
    } finally {
      await database.prepare("DROP TRIGGER protected_api_test_audit_failure").run();
    }

    const health = await api.fetch(
      new Request("https://certpath.example.test/api/health?demoRole=global_admin"),
      actor.bindings,
    );
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(await health.json()).toEqual({ status: "ok" });
  });
});
