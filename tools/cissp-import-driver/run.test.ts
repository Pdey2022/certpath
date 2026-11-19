import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { QUESTION_IMPORT_COLUMNS, parseCsv, csvLine } from "./contract.ts";
import {
  loadCheckpoint,
  saveCheckpoint,
  createCheckpoint,
  type Checkpoint,
} from "./checkpoint.ts";
import { DriverError } from "./errors.ts";
import { writeFixture } from "./fixtures.ts";
import { reviewNote, runDriver, type RunDependencies, type RunOptions } from "./run.ts";
import { validateInputs } from "./validate.ts";

const NOW = 1_700_000_000_000;
const ORIGIN = "http://localhost:5173";
const CSRF = `v1.${"a".repeat(43)}`;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "cissp-driver-run-"));
  tempDirs.push(directory);
  return directory;
}

after(() => {
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
});

type ConfirmBehaviour = "ok" | "commit-then-500" | "partial-then-500" | "unauthorized";

interface StubQuestion {
  key: string;
  domainId: string;
  topicId: string;
  questionId: string;
  revisionId: string;
  state: "draft" | "submitted" | "approved" | "published";
  publication: { revisionId: string; state: "published"; pointerVersion: number } | null;
}

function createStub(options: { behaviour?: ConfirmBehaviour } = {}) {
  const behaviour = options.behaviour ?? "ok";
  const previews = new Map<string, { keys: string[]; domainId: string; topicId: string }>();
  const questions = new Map<string, StubQuestion>();
  const reviewNotes: string[] = [];
  const calls: string[] = [];
  let previewCount = 0;
  let confirmCount = 0;
  let observedUnitStateDuringConfirm: string | null = null;
  let observedConfirmBody: string | null = null;

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(url);
    const path = parsed.pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);

    if (path === "/api/admin/auth/sign-in") {
      return new Response(JSON.stringify({ redirectTo: "/admin/mfa/verify" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "certpath_session=stub-session; Path=/; HttpOnly",
        },
      });
    }
    if (path === "/api/admin/content/csrf") return json({ csrfToken: CSRF });
    if (path === "/api/admin/auth/mfa/verify") return json({ redirectTo: "/admin/question-editor" });
    if (path === "/api/admin/auth/session") {
      return json({ userId: "user-1", role: "global_admin", certifications: [] });
    }

    if (path.endsWith("/import-previews")) {
      const body = init?.body;
      const text = typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array);
      const rows = parseCsv(text).slice(1);
      previewCount += 1;
      const importId = `import-${previewCount}`;
      const keys = rows.map((row) => row[1]!);
      previews.set(importId, { keys, domainId: rows[0]![3]!, topicId: rows[0]![4]! });
      return json(
        {
          importId,
          formatVersion: "certpath-question-v1",
          expiresAt: NOW + 600_000,
          summary: { parsedRows: rows.length, validRows: rows.length, invalidRows: 0 },
        },
        201,
      );
    }

    const confirmMatch = /\/import-previews\/([^/]+)\/confirm$/.exec(path);
    if (confirmMatch) {
      confirmCount += 1;
      const importId = confirmMatch[1]!;
      const preview = previews.get(importId);
      if (!preview) return json({ error: { code: "not_found", requestId: "stub-1" } }, 404);
      observedConfirmBody = typeof init?.body === "string" ? init.body : "not-a-string";
      const checkpoint = readCheckpoint(readOnlyStateDir);
      observedUnitStateDuringConfirm = checkpoint?.units[0]?.state ?? null;

      if (behaviour === "unauthorized") {
        return json({ error: { code: "unauthenticated", requestId: "stub-2" } }, 401);
      }
      const toCreate = behaviour === "partial-then-500" ? preview.keys.slice(0, 2) : preview.keys;
      for (const key of toCreate) {
        if (questions.has(key)) continue;
        const index = questions.size + 1;
        questions.set(key, {
          key,
          domainId: preview.domainId,
          topicId: preview.topicId,
          questionId: `question-${index}`,
          revisionId: `revision-${index}`,
          state: "draft",
          publication: null,
        });
      }
      if (behaviour === "commit-then-500" || behaviour === "partial-then-500") {
        return json({ error: { code: "service_unavailable", requestId: "stub-3" } }, 500);
      }
      return json({
        importId,
        questionIds: preview.keys.map((key) => questions.get(key)!.questionId),
        revisionIds: preview.keys.map((key) => questions.get(key)!.revisionId),
        questionKeys: preview.keys,
      });
    }

    if (path.endsWith("/questions")) {
      const search = parsed.searchParams.get("search") ?? "";
      const domainId = parsed.searchParams.get("domainId");
      const topicId = parsed.searchParams.get("topicId");
      const items = [...questions.values()]
        .filter((question) => question.key.includes(search))
        .filter((question) => domainId === null || question.domainId === domainId)
        .filter((question) => topicId === null || question.topicId === topicId)
        .map((question) => ({
          id: question.questionId,
          questionKey: question.key,
          currentRevisionId: question.revisionId,
          revisionNumber: 1,
          lockVersion: 1,
          stem: "Synthetic stem",
          workflowState: question.state,
        }));
      return json({ items, nextCursor: null });
    }

    const revisionMatch = /\/questions\/([^/]+)\/revisions\/([^/]+)(\/submit|\/review)?$/.exec(path);
    if (revisionMatch) {
      const question = [...questions.values()].find((item) => item.questionId === revisionMatch[1]);
      if (!question) return json({ error: { code: "not_found", requestId: "stub-4" } }, 404);
      const action = revisionMatch[3];
      if (action === "/submit") {
        question.state = "submitted";
        return json({ revisionId: question.revisionId });
      }
      if (action === "/review") {
        const body = JSON.parse(String(init?.body)) as { decision: string; notes: string };
        reviewNotes.push(body.notes);
        question.state = "approved";
        return json({ reviewId: `review-${question.questionId}` }, 201);
      }
      return json({ revisionId: question.revisionId, workflowState: question.state });
    }

    const publicationMatch = /\/questions\/([^/]+)\/publication$/.exec(path);
    if (publicationMatch) {
      const question = [...questions.values()].find((item) => item.questionId === publicationMatch[1]);
      if (!question) return json({ error: { code: "not_found", requestId: "stub-5" } }, 404);
      return json({ questionId: question.questionId, publication: question.publication });
    }

    const publishMatch = /\/questions\/([^/]+)\/publish$/.exec(path);
    if (publishMatch) {
      const question = [...questions.values()].find((item) => item.questionId === publishMatch[1]);
      if (!question) return json({ error: { code: "not_found", requestId: "stub-6" } }, 404);
      if (question.publication !== null) {
        return json({ error: { code: "conflict", requestId: "stub-7" } }, 409);
      }
      question.publication = { revisionId: question.revisionId, state: "published", pointerVersion: 1 };
      question.state = "published";
      return json({ pointerVersion: 1 });
    }

    if (path.endsWith("/export")) {
      const published = [...questions.values()].filter((question) => question.publication !== null);
      const rows = published.map((question) => {
        const cells = Array.from({ length: QUESTION_IMPORT_COLUMNS.length }, () => "");
        cells[0] = "certpath-question-v1";
        cells[1] = question.key;
        return csvLine(cells);
      });
      const csv = `${csvLine([...QUESTION_IMPORT_COLUMNS])}\r\n${rows.join("\r\n")}\r\n`;
      return new Response(csv, { status: 200, headers: { "content-type": "text/csv; charset=utf-8" } });
    }

    return json({ error: { code: "not_found", requestId: "stub-8" } }, 404);
  }) as typeof fetch;

  return {
    fetchImpl,
    questions,
    reviewNotes,
    calls,
    get confirmCount() {
      return confirmCount;
    },
    get previewCount() {
      return previewCount;
    },
    get observedUnitStateDuringConfirm() {
      return observedUnitStateDuringConfirm;
    },
    get observedConfirmBody() {
      return observedConfirmBody;
    },
  };
}

let readOnlyStateDir = "";

function readCheckpoint(stateDir: string): Checkpoint | null {
  try {
    return loadCheckpoint(join(stateDir, "checkpoint.json"));
  } catch {
    return null;
  }
}

interface Harness {
  options: Omit<RunOptions, "stage" | "unitLimit">;
  checkpointPath: string;
  stateDir: string;
  deps: RunDependencies;
}

function buildHarness(behaviour?: ConfirmBehaviour): { harness: Harness; stub: ReturnType<typeof createStub> } {
  const root = makeTempDir();
  const fixture = writeFixture(root, { rowCount: 5 });
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const validated = validateInputs({
    batchesDir: fixture.batchesDir,
    taxonomyPath: fixture.taxonomyPath,
    prosePath: fixture.prosePath,
  });
  const checkpoint = createCheckpoint({
    runId: "run-canary",
    now: NOW,
    target: {
      origin: ORIGIN,
      actorUserId: "user-1",
      certificationId: "cert-1",
      certificationSlug: "synthetic-pilot",
      examVersionKey: "driver-test-v1",
      examVersionId: "version-1",
    },
    inputs: {
      taxonomySha256: validated.taxonomySha256,
      proseSha256: validated.proseSha256,
      converterManifestSha256: validated.converterManifestSha256,
      uploadManifestSha256: null,
      batchSize: 5,
      converterDeclaredExamVersionId: validated.declaredExamVersionId,
      unitLimit: null,
    },
  });
  checkpoint.stages.taxonomy = "complete";
  checkpoint.taxonomy = {
    certification: { id: "cert-1", created: false, displayName: "Synthetic pilot" },
    examVersion: { id: "version-1", created: false, title: "Synthetic exam title" },
    domains: validated.taxonomy.domains.map((domain, index) => ({
      key: domain.id,
      serverId: `dom-${index + 1}`,
      order: domain.order,
      title: domain.title,
    })),
    topics: validated.taxonomy.domains.flatMap((domain) =>
      domain.topics.map((topic) => ({
        key: topic.id,
        serverId: `top-${topic.id}`,
        domainKey: domain.id,
        order: topic.order,
        title: topic.title,
      })),
    ),
  };
  saveCheckpoint(join(stateDir, "checkpoint.json"), checkpoint, undefined, NOW);
  readOnlyStateDir = stateDir;

  const stub = createStub({ behaviour });
  const options = {
    origin: ORIGIN,
    batchesDir: fixture.batchesDir,
    taxonomyPath: fixture.taxonomyPath,
    prosePath: fixture.prosePath,
    stateDir,
    email: "owner@example.test",
    certificationSlug: "synthetic-pilot",
    versionKey: "driver-test-v1",
    createCertification: false,
    batchSize: 5,
    dryRun: false,
  };
  const deps: RunDependencies = {
    fetchImpl: stub.fetchImpl,
    now: () => NOW,
    log: () => {},
    secrets: async () => ({ password: "not-a-real-password", totpCode: "123456" }),
    newId: () => "run-canary",
    repoRoot: join(root, "repo"),
  };
  return { harness: { options, checkpointPath: join(stateDir, "checkpoint.json"), stateDir, deps }, stub };
}

async function runStages(
  harness: Harness,
  stages: Array<"transform" | "upload" | "publish" | "verify">,
): Promise<void> {
  for (const stage of stages) {
    await runDriver({ ...harness.options, stage, unitLimit: stage === "transform" ? null : 1 }, harness.deps);
  }
}

test("the happy path confirms, reviews, publishes and verifies five questions", async () => {
  const { harness, stub } = buildHarness();
  await runStages(harness, ["transform", "upload", "publish", "verify"]);

  const checkpoint = readCheckpoint(harness.stateDir)!;
  assert.equal(checkpoint.units.length, 1);
  assert.equal(checkpoint.units[0]!.state, "confirmed");
  assert.equal(checkpoint.questions.length, 5);
  assert.equal(checkpoint.questions.every((question) => question.state === "published"), true);
  assert.equal(stub.questions.size, 5);
  assert.equal(stub.reviewNotes.length, 5);
  assert.equal(stub.reviewNotes[0], reviewNote("run-canary", 1));
  for (const note of stub.reviewNotes) assert.equal(note, stub.reviewNotes[0]);
  assert.equal(checkpoint.counters.recoveries, 0);
});

test("the checkpoint records the preview before the confirm is sent", async () => {
  const { harness, stub } = buildHarness();
  await runStages(harness, ["transform", "upload"]);
  assert.equal(stub.observedUnitStateDuringConfirm, "previewed");
  assert.equal(stub.observedConfirmBody, "{}");
  assert.equal(stub.confirmCount, 1);
});

test("a confirm that commits and then answers 500 is reconciled by question key, not retried", async () => {
  const { harness, stub } = buildHarness("commit-then-500");
  await runStages(harness, ["transform", "upload"]);

  const checkpoint = readCheckpoint(harness.stateDir)!;
  assert.equal(stub.confirmCount, 1);
  assert.equal(checkpoint.units[0]!.state, "confirmed");
  assert.equal(checkpoint.questions.length, 5);
  assert.equal(new Set(checkpoint.questions.map((question) => question.key)).size, 5);
  assert.equal(stub.questions.size, 5);
  assert.equal(checkpoint.counters.recoveries >= 1, true);
});

test("a partial reconciliation stops the run with PARTIAL_IMPORT and leaves the unit unconfirmed", async () => {
  const { harness, stub } = buildHarness("partial-then-500");
  await assert.rejects(
    runStages(harness, ["transform", "upload"]),
    (error: unknown) => error instanceof DriverError && error.code === "PARTIAL_IMPORT",
  );
  const checkpoint = readCheckpoint(harness.stateDir)!;
  assert.notEqual(checkpoint.units[0]!.state, "confirmed");
  assert.equal(checkpoint.questions.length, 0);
  assert.equal(stub.confirmCount, 1);
});

test("a 401 on the confirm stops the run without a second attempt", async () => {
  const { harness, stub } = buildHarness("unauthorized");
  await assert.rejects(
    runStages(harness, ["transform", "upload"]),
    (error: unknown) => error instanceof DriverError && error.code === "SESSION_LOST",
  );
  assert.equal(stub.confirmCount, 1);
  const checkpoint = readCheckpoint(harness.stateDir)!;
  assert.notEqual(checkpoint.units[0]!.state, "confirmed");
  assert.equal(checkpoint.lastError?.code ?? "", "SESSION_LOST");
  assert.equal(checkpoint.lastError?.status, 401);
});

test("a resume after a complete upload makes no confirm call", async () => {
  const { harness, stub } = buildHarness();
  await runStages(harness, ["transform", "upload"]);
  const before = stub.confirmCount;
  await runDriver({ ...harness.options, stage: "upload", unitLimit: 1 }, harness.deps);
  assert.equal(stub.confirmCount, before);
});

test("a no-op invocation keeps the run's cumulative request counter", async () => {
  const { harness } = buildHarness();
  await runStages(harness, ["transform", "upload", "publish", "verify"]);
  const cumulative = readCheckpoint(harness.stateDir)!.counters.requests;
  assert.equal(cumulative > 20, true);
  await runDriver({ ...harness.options, stage: "verify", unitLimit: 1 }, harness.deps);
  assert.equal(readCheckpoint(harness.stateDir)!.counters.requests, cumulative);
});

test("a successful invocation clears the previous run's last error", async () => {
  const { harness } = buildHarness();
  const checkpoint = readCheckpoint(harness.stateDir)!;
  checkpoint.lastError = { code: "AUTH_FAILED", status: 400, requestId: "earlier" };
  saveCheckpoint(harness.checkpointPath, checkpoint, undefined, NOW);
  await runStages(harness, ["transform"]);
  assert.equal(readCheckpoint(harness.stateDir)!.lastError, null);
});
