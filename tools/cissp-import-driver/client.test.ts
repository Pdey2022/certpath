import assert from "node:assert/strict";
import test from "node:test";
import {
  StaffApi,
  buildUrl,
  certificationBody,
  confirmBody,
  domainBody,
  examVersionBody,
  paths,
  publishBody,
  readErrorEnvelope,
  reviewBody,
  topicBody,
} from "./client.ts";
import { DriverError } from "./errors.ts";
import { assertOriginPolicy, isLoopbackOrigin, normalizeOrigin } from "./origin.ts";

interface Recorded {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
}

function recorder(
  respond: (recorded: Recorded) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    const recorded = { url, init: init ?? {}, headers };
    calls.push(recorded);
    return respond(recorded);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const CSRF = `v1.${"a".repeat(43)}`;

function csrfResponse(): Response {
  return new Response(JSON.stringify({ csrfToken: CSRF }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("paths are the documented protected-content routes", () => {
  assert.equal(paths.csrf, "/api/admin/content/csrf");
  assert.equal(paths.session, "/api/admin/auth/session");
  assert.equal(paths.signIn, "/api/admin/auth/sign-in");
  assert.equal(paths.mfaVerify, "/api/admin/auth/mfa/verify");
  assert.equal(
    paths.importPreviews("cert-1", "ver-1"),
    "/api/admin/content/certifications/cert-1/exam-versions/ver-1/import-previews",
  );
  assert.equal(
    paths.confirm("cert-1", "import-1"),
    "/api/admin/content/certifications/cert-1/import-previews/import-1/confirm",
  );
  assert.equal(
    paths.publish("cert-1", "ver-1", "question-1"),
    "/api/admin/content/certifications/cert-1/exam-versions/ver-1/questions/question-1/publish",
  );
  assert.equal(
    paths.exportCsv("cert-1", "ver-1"),
    "/api/admin/content/certifications/cert-1/exam-versions/ver-1/export",
  );
});

test("query parameters are built exactly, and omitted when null", () => {
  assert.equal(
    buildUrl("http://localhost:5173", paths.certifications, { limit: 50 }),
    "http://localhost:5173/api/admin/content/certifications?limit=50",
  );
  assert.equal(
    buildUrl("http://localhost:5173", paths.certifications, { limit: 50, cursor: null }),
    "http://localhost:5173/api/admin/content/certifications?limit=50",
  );
  const questions = new URL(
    buildUrl("http://localhost:5173", paths.questions("cert-1", "ver-1"), {
      domainId: "d1",
      topicId: "t1",
      search: "cissp-12",
      limit: 50,
    }),
  );
  assert.equal(questions.pathname, "/api/admin/content/certifications/cert-1/exam-versions/ver-1/questions");
  assert.deepEqual(Object.fromEntries(questions.searchParams), {
    domainId: "d1",
    topicId: "t1",
    search: "cissp-12",
    limit: "50",
  });
});

test("request bodies carry exactly the contract's field set", () => {
  assert.deepEqual(JSON.parse(certificationBody({ id: "cissp", slug: "cissp", displayName: "CISSP" })), {
    id: "cissp",
    slug: "cissp",
    displayName: "CISSP",
  });
  assert.deepEqual(
    JSON.parse(examVersionBody({ versionKey: "v1", title: "Title", syllabusReference: "Ref" })),
    { versionKey: "v1", title: "Title", syllabusReference: "Ref" },
  );
  assert.deepEqual(
    JSON.parse(domainBody({ domainKey: "cissp-d1", title: "D1", meaning: "M", order: 0 })),
    { domainKey: "cissp-d1", title: "D1", meaning: "M", order: 0 },
  );
  assert.deepEqual(
    JSON.parse(topicBody({ topicKey: "cissp-d1-t", title: "T", meaning: "M", order: 1 })),
    { topicKey: "cissp-d1-t", title: "T", meaning: "M", order: 1 },
  );
  assert.deepEqual(JSON.parse(reviewBody("note")), { decision: "approved", notes: "note" });
  assert.deepEqual(JSON.parse(publishBody("revision-1")), {
    revisionId: "revision-1",
    expectedPointerVersion: null,
  });
  assert.deepEqual(JSON.parse(confirmBody()), {});
});

test("sign-in captures the cookie and every later mutation carries Origin and the CSRF token", async () => {
  const { fetchImpl, calls } = recorder(({ url }) => {
    if (url.endsWith("/sign-in")) {
      return jsonResponse({ redirectTo: "/admin/mfa/verify" }, 200, {
        "set-cookie": "certpath_session=opaque-value; Path=/; HttpOnly",
      });
    }
    if (url.endsWith("/csrf")) return jsonResponse({ csrfToken: `v1.${"a".repeat(43)}` });
    if (url.endsWith("/mfa/verify")) return jsonResponse({ redirectTo: "/admin/question-editor" });
    if (url.endsWith("/session")) {
      return jsonResponse({ userId: "user-1", role: "global_admin", certifications: [] });
    }
    return jsonResponse({}, 404);
  });
  const api = new StaffApi({ origin: "http://localhost:5173", fetchImpl });
  await api.signIn("owner@example.test", "not-a-real-password");
  await api.readCsrf();
  await api.verifyTotp("123456");
  const session = await api.readSession();
  assert.equal(session.userId, "user-1");

  assert.equal(calls[0]!.headers["origin"], "http://localhost:5173");
  assert.equal(calls[0]!.headers["cookie"], undefined);
  assert.equal(calls[1]!.headers["cookie"], "certpath_session=opaque-value");
  assert.equal(calls[2]!.headers["origin"], "http://localhost:5173");
  assert.equal(calls[2]!.headers["x-csrf-token"], `v1.${"a".repeat(43)}`);
  assert.equal(calls[2]!.headers["cookie"], "certpath_session=opaque-value");
});

test("a 401 stops the run after exactly one request and never retries", async () => {
  const { fetchImpl, calls } = recorder(() => jsonResponse({ error: { code: "unauthenticated", requestId: "r-1" } }, 401));
  const api = new StaffApi({ origin: "http://localhost:5173", fetchImpl });
  await assert.rejects(
    api.readSession(),
    (error: unknown) => error instanceof DriverError && error.code === "SESSION_LOST",
  );
  assert.equal(calls.length, 1);
});

test("a 429 stops the run with its own code and one preview request", async () => {
  const { fetchImpl, calls } = recorder(({ url }) =>
    url.endsWith("/csrf")
      ? csrfResponse()
      : jsonResponse({ error: { code: "rate_limited", requestId: "r-2" } }, 429),
  );
  const api = new StaffApi({ origin: "http://localhost:5173", fetchImpl });
  await api.readCsrf();
  const before = calls.length;
  const outcome = await api.previewImport("cert-1", "ver-1", new Uint8Array([1, 2, 3]));
  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.kind === "rejected" ? outcome.status : null, 429);
  assert.equal(calls.length - before, 1);
});

test("a 5xx is ambiguous, never success", async () => {
  const { fetchImpl } = recorder(({ url }) =>
    url.endsWith("/csrf")
      ? csrfResponse()
      : jsonResponse({ error: { code: "service_unavailable", requestId: "r-3" } }, 503),
  );
  const api = new StaffApi({ origin: "http://localhost:5173", fetchImpl });
  await api.readCsrf();
  const outcome = await api.confirmImport("cert-1", "import-1");
  assert.equal(outcome.kind, "ambiguous");
  assert.equal(outcome.kind === "ambiguous" ? outcome.status : null, 503);
  assert.equal(outcome.kind === "ambiguous" ? outcome.code : null, "service_unavailable");
});

test("a timeout is ambiguous with no status", async () => {
  const { fetchImpl } = recorder(({ url }) => {
    if (url.endsWith("/csrf")) return csrfResponse();
    throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
  });
  const api = new StaffApi({ origin: "http://localhost:5173", fetchImpl });
  await api.readCsrf();
  const outcome = await api.confirmImport("cert-1", "import-1");
  assert.equal(outcome.kind, "ambiguous");
  assert.equal(outcome.kind === "ambiguous" ? outcome.reason : null, "timeout");
});

test("the preview carries the CSV content type and the exact bytes", async () => {
  const { fetchImpl, calls } = recorder(({ url }) =>
    url.endsWith("/csrf") ? csrfResponse() : jsonResponse({}, 201),
  );
  const api = new StaffApi({ origin: "http://localhost:5173", fetchImpl });
  await api.readCsrf();
  await api.previewImport("cert-1", "ver-1", new TextEncoder().encode("header\nrow\n"));
  const preview = calls.at(-1)!;
  assert.equal(preview.headers["content-type"], "text/csv; charset=utf-8");
  assert.equal(preview.headers["accept"]?.includes("text/csv"), true);
  assert.deepEqual(new TextDecoder().decode(preview.init.body as Uint8Array), "header\nrow\n");
});

test("the error envelope keeps only a code, a request id, issues and a summary", () => {
  const envelope = readErrorEnvelope(
    JSON.stringify({
      error: {
        code: "validation_error",
        requestId: "r-4",
        message: "a stem the driver must not keep",
        issues: [{ path: "row.1.question_key", code: "existing_question_key" }],
        summary: { parsedRows: 1, validRows: 0, invalidRows: 1 },
      },
    }),
  );
  assert.deepEqual(envelope, {
    code: "validation_error",
    requestId: "r-4",
    issues: [{ path: "row.1.question_key", code: "existing_question_key" }],
    summary: { parsedRows: 1, validRows: 0, invalidRows: 1 },
  });
});

test("loopback origins are accepted and remote ones need all three gates", () => {
  assert.equal(normalizeOrigin("http://localhost:5173/"), "http://localhost:5173");
  assert.equal(isLoopbackOrigin("http://127.0.0.1:5173"), true);
  assert.equal(isLoopbackOrigin("http://[::1]:5173"), true);
  assert.equal(isLoopbackOrigin("https://certpath.example"), false);

  assert.doesNotThrow(() =>
    assertOriginPolicy({
      origin: "http://localhost:5173",
      allowRemote: false,
      remoteConfirm: null,
      approval: null,
    }),
  );
  assert.throws(
    () =>
      assertOriginPolicy({
        origin: "https://certpath.example",
        allowRemote: false,
        remoteConfirm: null,
        approval: null,
      }),
    (error: unknown) => error instanceof DriverError && error.code === "ORIGIN_NOT_LOOPBACK",
  );
  assert.throws(
    () =>
      assertOriginPolicy({
        origin: "https://certpath.example",
        allowRemote: true,
        remoteConfirm: "https://certpath.example",
        approval: null,
      }),
    (error: unknown) => error instanceof DriverError && error.code === "REMOTE_APPROVAL_MISSING",
  );
  assert.throws(
    () =>
      assertOriginPolicy({
        origin: "https://certpath.example",
        allowRemote: true,
        remoteConfirm: "https://other.example",
        approval: "issue-1",
      }),
    (error: unknown) => error instanceof DriverError && error.code === "REMOTE_CONFIRM_MISMATCH",
  );
  assert.throws(
    () =>
      assertOriginPolicy({
        origin: "https://certpath.example",
        allowRemote: false,
        remoteConfirm: null,
        approval: "issue-1",
      }),
    (error: unknown) => error instanceof DriverError && error.code === "ORIGIN_NOT_LOOPBACK",
  );
  assert.doesNotThrow(() =>
    assertOriginPolicy({
      origin: "https://certpath.example",
      allowRemote: true,
      remoteConfirm: "https://certpath.example",
      approval: "issue-1",
    }),
  );
});
