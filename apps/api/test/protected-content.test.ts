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
