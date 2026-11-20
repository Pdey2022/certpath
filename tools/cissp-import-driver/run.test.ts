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
import { pageOf, writeFixture } from "./fixtures.ts";
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

type ConfirmBehaviour =
  | "ok"
  | "commit-then-500"
  | "partial-then-500"
  | "unauthorized"
  | "confirm-409"
  // The three Stage 3/4 mutations that commit and then lose the answer. Each
  // one must be reconciled by observation, never re-sent blind.
  | "submit-then-500"
  | "submit-500-no-commit"
  | "publish-then-500"
  // Preview refusals that must keep their own code instead of collapsing into
  // PREVIEW_REJECTED.
  | "preview-401"
  | "preview-429";

interface ConfirmBehaviourOptions {
  /** Refuses the confirm for the first preview whose keys satisfy this. */
  failConfirmWhen?: (keys: readonly string[]) => boolean;
}

interface StubQuestion {
  key: string;
  domainId: string;
  topicId: string;
  questionId: string;
  revisionId: string;
  revisionNumber: number;
  stem: string;
  state: "draft" | "submitted" | "approved" | "published";
  publication: { revisionId: string; state: "published"; pointerVersion: number } | null;
}

interface DecoySpec {
  key: string;
  domainId?: string;
  topicId?: string;
  stem?: string;
  revisionNumber?: number;
}

interface SeedSpec extends DecoySpec {
  questionId?: string;
  revisionId?: string;
}

interface StubOptions extends ConfirmBehaviourOptions {
  behaviour?: ConfirmBehaviour;
  /**
   * Questions the server already holds, in the topic a unit's rows sit in.
   * Their ids sort before a confirmed question's, so they occupy the early
   * pages and push the exact rows past the first one - the shape of the live
   * defect.
   */
  decoys?: readonly DecoySpec[];
  /**
   * Keys the server holds but the listing does not return. A server answering
   * two reads differently is the situation the refusal cross-check exists for.
   */
  omitFromListing?: readonly string[];
  /** Answers `500` on the k-th `GET …/questions` (1-based). */
  failPageAt?: number;
}

/** Every `GET …/questions` URL any stub issued, for the global `search` pin. */
const everyQuestionUrl: string[] = [];

function createStub(options: StubOptions = {}) {
  const behaviour = options.behaviour ?? "ok";
  const previews = new Map<string, { keys: string[]; domainId: string; topicId: string }>();
  const questions = new Map<string, StubQuestion>();
  const reviewNotes: string[] = [];
  const calls: string[] = [];
  const previewBatches: string[][] = [];
  const confirmBatches: string[][] = [];
  let previewCount = 0;
  let confirmCount = 0;
  let submitCount = 0;
  let publishCount = 0;
  let revisionReads = 0;
  let publicationReads = 0;
  let questionReads = 0;
  let seeded = 0;
  const questionUrls: string[] = [];
  let observedUnitStateDuringConfirm: string | null = null;
  let observedConfirmBody: string | null = null;
  let observedQuestionStateDuringReview: string | null = null;

  /** Seeds a question the server already holds, as a previous run left it. */
  function seedQuestion(spec: SeedSpec): void {
    seeded += 1;
    const index = String(seeded).padStart(4, "0");
    questions.set(spec.key, {
      key: spec.key,
      domainId: spec.domainId ?? "dom-1",
      topicId: spec.topicId ?? "top-cissp-d1-topic-1",
      // `decoy-` sorts before the `question-` a confirm creates, which is what
      // puts an exact row past the first page.
      questionId: spec.questionId ?? `decoy-${index}`,
      revisionId: spec.revisionId ?? `decoy-revision-${index}`,
      revisionNumber: spec.revisionNumber ?? 1,
      stem: spec.stem ?? `Synthetic stem for ${spec.key}`,
      state: "draft",
      publication: null,
    });
  }

  for (const decoy of options.decoys ?? []) seedQuestion(decoy);
  const omitted = new Set(options.omitFromListing ?? []);

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
      if (behaviour === "preview-401") {
        return json({ error: { code: "unauthenticated", requestId: "stub-11" } }, 401);
      }
      if (behaviour === "preview-429") {
        return json({ error: { code: "rate_limited", requestId: "stub-12" } }, 429);
      }
      const body = init?.body;
      const text = typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array);
      const rows = parseCsv(text).slice(1);
      previewCount += 1;
      const keys = rows.map((row) => row[1]!);
      previewBatches.push(keys);
      // The server refuses a preview that would duplicate a key it already
      // holds: 400 with one issue per row, exactly as the import validator does.
      const duplicated = keys.filter((key) => questions.has(key));
      if (duplicated.length > 0) {
        return json(
          {
            error: {
              code: "validation_failed",
              requestId: "stub-14",
              issues: rows.flatMap((row, index) =>
                questions.has(row[1]!)
                  ? [{ path: `row.${index + 2}.question_key`, code: "existing_question_key" }]
                  : [],
              ),
            },
            summary: {
              parsedRows: rows.length,
              validRows: rows.length - duplicated.length,
              invalidRows: duplicated.length,
            },
          },
          400,
        );
      }
      const importId = `import-${previewCount}`;
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
      confirmBatches.push(preview.keys);
      const checkpoint = readCheckpoint(readOnlyStateDir);
      observedUnitStateDuringConfirm = checkpoint?.units[0]?.state ?? null;

      if (behaviour === "unauthorized") {
        return json({ error: { code: "unauthenticated", requestId: "stub-2" } }, 401);
      }
      if (behaviour === "confirm-409") {
        return json({ error: { code: "conflict", requestId: "stub-15" } }, 409);
      }
      if (options.failConfirmWhen?.(preview.keys) === true) {
        return json({ error: { code: "unauthenticated", requestId: "stub-16" } }, 401);
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
          revisionNumber: 1,
          stem: `Synthetic stem for ${key}`,
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
      questionReads += 1;
      questionUrls.push(url);
      everyQuestionUrl.push(url);
      if (options.failPageAt === questionReads) {
        return json({ error: { code: "service_unavailable", requestId: "stub-pages" } }, 500);
      }
      const domainId = parsed.searchParams.get("domainId");
      const topicId = parsed.searchParams.get("topicId");
      const search = parsed.searchParams.get("search");
      const limitParam = parsed.searchParams.get("limit");
      // A faithful page store: the route's default is 25 and its ceiling is 50,
      // it filters by domain, topic and (when asked) a substring of the key or
      // the stem, orders by `question.id` and only then applies `cursor`.
      const limit = limitParam === null ? 25 : Math.min(Number(limitParam), 50);
      const cursor = parsed.searchParams.get("cursor");
      const matching = [...questions.values()]
        .filter((question) => !omitted.has(question.key))
        .filter((question) => domainId === null || question.domainId === domainId)
        .filter((question) => topicId === null || question.topicId === topicId)
        .filter(
          (question) =>
            search === null || question.key.includes(search) || question.stem.includes(search),
        )
        .map((question) => ({ question, id: question.questionId }));
      const page = pageOf(matching, { cursor, limit }, (item) => item.id);
      return json({
        items: page.items.map(({ question }) => ({
          id: question.questionId,
          questionKey: question.key,
          currentRevisionId: question.revisionId,
          revisionNumber: question.revisionNumber,
          lockVersion: 1,
          stem: question.stem,
          workflowState: question.state,
        })),
        nextCursor: page.nextCursor,
      });
    }

    const revisionMatch = /\/questions\/([^/]+)\/revisions\/([^/]+)(\/submit|\/review)?$/.exec(path);
    if (revisionMatch) {
      const question = [...questions.values()].find((item) => item.questionId === revisionMatch[1]);
      if (!question) return json({ error: { code: "not_found", requestId: "stub-4" } }, 404);
      const action = revisionMatch[3];
      if (action === "/submit") {
        submitCount += 1;
        if (behaviour === "submit-500-no-commit") {
          // The call did not land: the revision stays where it was, so every
          // observation still sees draft.
          return json({ error: { code: "service_unavailable", requestId: "stub-13" } }, 500);
        }
        question.state = "submitted";
        if (behaviour === "submit-then-500") {
          return json({ error: { code: "service_unavailable", requestId: "stub-9" } }, 500);
        }
        return json({ revisionId: question.revisionId });
      }
      if (action === "/review") {
        const body = JSON.parse(String(init?.body)) as { decision: string; notes: string };
        reviewNotes.push(body.notes);
        // What the checkpoint said when the driver moved on from the submit:
        // "submitted" means the observation was recorded before reviewing.
        const checkpoint = readCheckpoint(readOnlyStateDir);
        observedQuestionStateDuringReview =
          checkpoint?.questions.find((item) => item.key === question.key)?.state ?? null;
        question.state = "approved";
        return json({ reviewId: `review-${question.questionId}` }, 201);
      }
      revisionReads += 1;
      return json({ revisionId: question.revisionId, workflowState: question.state });
    }

    const publicationMatch = /\/questions\/([^/]+)\/publication$/.exec(path);
    if (publicationMatch) {
      publicationReads += 1;
      const question = [...questions.values()].find((item) => item.questionId === publicationMatch[1]);
      if (!question) return json({ error: { code: "not_found", requestId: "stub-5" } }, 404);
      return json({ questionId: question.questionId, publication: question.publication });
    }

    const publishMatch = /\/questions\/([^/]+)\/publish$/.exec(path);
    if (publishMatch) {
      publishCount += 1;
      const question = [...questions.values()].find((item) => item.questionId === publishMatch[1]);
      if (!question) return json({ error: { code: "not_found", requestId: "stub-6" } }, 404);
      if (question.publication !== null) {
        return json({ error: { code: "conflict", requestId: "stub-7" } }, 409);
      }
      question.publication = { revisionId: question.revisionId, state: "published", pointerVersion: 1 };
      question.state = "published";
      if (behaviour === "publish-then-500") {
        return json({ error: { code: "service_unavailable", requestId: "stub-10" } }, 500);
      }
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
    previewBatches,
    confirmBatches,
    questionUrls,
    seedQuestion,
    get questionReads() {
      return questionReads;
    },
    get confirmCount() {
      return confirmCount;
    },
    get previewCount() {
      return previewCount;
    },
    get submitCount() {
      return submitCount;
    },
    get publishCount() {
      return publishCount;
    },
    get revisionReads() {
      return revisionReads;
    },
    get publicationReads() {
      return publicationReads;
    },
    get observedQuestionStateDuringReview() {
      return observedQuestionStateDuringReview;
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

function buildHarness(
  behaviour?: ConfirmBehaviour,
  rowCount = 5,
  stubOptions: StubOptions = {},
): { harness: Harness; stub: ReturnType<typeof createStub> } {
  const root = makeTempDir();
  const fixture = writeFixture(root, { rowCount });
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

  const stub = createStub({ behaviour, ...stubOptions });
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

/**
 * Questions the server already holds whose keys *contain* the unit's first two
 * rows as substrings (`cissp-120` contains `cissp-1`), plus one whose stem
 * quotes `cissp-3`. Their ids are `decoy-NNNN`, which sorts before the
 * `question-N` a confirm creates, so they fill the early pages and push the
 * exact rows past the first one - the shape of the live defect.
 */
function crowdingDecoys(count: number): DecoySpec[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `cissp-${100 + index}`,
    ...(index === 3 ? { stem: "Synthetic stem quoting cissp-3" } : {}),
  }));
}

async function runStages(
  harness: Harness,
  stages: Array<"transform" | "upload" | "publish" | "verify">,
  unitLimit: number | null = 1,
): Promise<void> {
  for (const stage of stages) {
    await runDriver(
      { ...harness.options, stage, unitLimit: stage === "transform" ? null : unitLimit },
      harness.deps,
    );
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

test("a submit that commits and then answers 500 is observed, not re-sent", async () => {
  // The intent must stay in flight across a lost answer: the next iteration has
  // to read the revision before deciding anything. Clearing it re-sent the
  // submit from the stale checkpoint, and the second submit of an
  // already-submitted revision is a 409 - a WORKFLOW_CONFLICT that hid the fact
  // that the server was already at the state the driver wanted.
  const { harness, stub } = buildHarness("submit-then-500", 1);
  await runStages(harness, ["transform", "upload", "publish"]);

  const checkpoint = readCheckpoint(harness.stateDir)!;
  assert.equal(stub.submitCount, 1);
  assert.equal(stub.revisionReads, 1);
  // The observation was recorded before the next action: the review saw a
  // checkpoint that said "submitted", not "draft".
  assert.equal(stub.observedQuestionStateDuringReview, "submitted");
  assert.equal(checkpoint.questions[0]!.state, "published");
  assert.equal(checkpoint.counters.recoveries >= 1, true);
});

test("a publish that commits and then answers 500 is observed, not re-sent", async () => {
  // Same rule for the last mutation: one publication read decides it, and the
  // run records "published" from what the server says rather than publishing
  // twice and turning the second attempt into a 409.
  const { harness, stub } = buildHarness("publish-then-500", 1);
  await runStages(harness, ["transform", "upload", "publish"]);

  const checkpoint = readCheckpoint(harness.stateDir)!;
  assert.equal(stub.publishCount, 1);
  assert.equal(stub.publicationReads, 1);
  assert.equal(checkpoint.questions[0]!.state, "published");
  assert.equal(checkpoint.questions[0]!.pointerVersion, 1);
});

test("a submit that never lands stops after one reconciliation, with the intent still set", async () => {
  // The bound is what stops a run grinding against a broken server: one
  // observation is allowed, a second conflict is not. This row is the one that
  // proves `recoveries > 1` actually bites - without it the guard could be
  // deleted and every other test would stay green.
  const { harness, stub } = buildHarness("submit-500-no-commit", 1);

  await assert.rejects(
    runStages(harness, ["transform", "upload", "publish"]),
    (error: unknown) =>
      error instanceof DriverError &&
      error.code === "WORKFLOW_CONFLICT" &&
      /second conflict/.test(error.message),
  );

  // Exactly two submits: the first, then the one re-issued after the single
  // permitted observation - and then the stop.
  assert.equal(stub.submitCount, 2);
  const checkpoint = readCheckpoint(harness.stateDir)!;
  assert.equal(checkpoint.questions[0]!.inFlight, "submit");
  assert.equal(checkpoint.questions[0]!.state, "draft");
  assert.equal(checkpoint.counters.recoveries, 1);
  assert.equal(checkpoint.counters.http5xx, 2);
  // The stop is what is recorded, not the last 5xx: the operator's next action
  // depends on knowing the run stopped, and the 5xx count is beside it.
  assert.equal(checkpoint.lastError?.code, "WORKFLOW_CONFLICT");
});

test("a stop from the observation branch keeps the in-flight intent on disk", async () => {
  // The checkpoint says submitted with a submit in flight (the answer was lost);
  // the server says draft, a transition the driver cannot explain. The stop
  // must leave the intent where the next run can see it: clearing it before the
  // throw deleted the one record that a mutation may have landed.
  const { harness, stub } = buildHarness("ok", 1);
  await runStages(harness, ["transform", "upload"]);

  const serverQuestion = [...stub.questions.values()][0]!;
  const checkpoint = readCheckpoint(harness.stateDir)!;
  const record = checkpoint.questions[0]!;
  record.state = "submitted";
  record.inFlight = "submit";
  saveCheckpoint(harness.checkpointPath, checkpoint, undefined, NOW);
  serverQuestion.state = "draft";

  await assert.rejects(
    runDriver({ ...harness.options, stage: "publish", unitLimit: 1 }, harness.deps),
    (error: unknown) => error instanceof DriverError && error.code === "WORKFLOW_CONFLICT",
  );

  const after = readCheckpoint(harness.stateDir)!;
  assert.equal(after.questions[0]!.inFlight, "submit");
  assert.equal(after.questions[0]!.state, "submitted");
  assert.equal(after.lastError?.code, "WORKFLOW_CONFLICT");
});

test("a refused preview keeps its own code instead of collapsing into PREVIEW_REJECTED", async () => {
  // A lost session and a rate limit stop the run for different reasons than a
  // refused body: the operator re-authenticates or waits, and neither is fixed
  // by editing the CSV. previewUnit used to map all three to PREVIEW_REJECTED.
  for (const [behaviour, code] of [
    ["preview-401", "SESSION_LOST"],
    ["preview-429", "RATE_LIMITED"],
  ] as const) {
    const { harness, stub } = buildHarness(behaviour);
    await assert.rejects(
      runStages(harness, ["transform", "upload"]),
      (error: unknown) => error instanceof DriverError && error.code === code,
      `${behaviour} should stop with ${code}`,
    );
    // The refusal happened at the preview, before any confirm.
    assert.equal(stub.confirmCount, 0);
  }
});

test("a partial reconciliation stops the run with PARTIAL_IMPORT and leaves the unit unconfirmed", async () => {
  // The confirm commits two rows of five and then answers 500. The read has to
  // establish the other three *absent* - so the topic is crowded enough that
  // the listing needs more than one page - before "some" is an honest answer.
  const { harness, stub } = buildHarness("partial-then-500", 5, { decoys: crowdingDecoys(60) });
  await assert.rejects(
    runStages(harness, ["transform", "upload"]),
    (error: unknown) => error instanceof DriverError && error.code === "PARTIAL_IMPORT",
  );
  const checkpoint = readCheckpoint(harness.stateDir)!;
  assert.notEqual(checkpoint.units[0]!.state, "confirmed");
  assert.equal(checkpoint.questions.length, 0);
  assert.equal(stub.confirmCount, 1);
  assert.equal(stub.questionReads > 1, true);
  assert.equal(checkpoint.lastError?.code, "PARTIAL_IMPORT");
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

test("an interrupted upload resumes at the first unconfirmed unit, not at unit 1", async () => {
  // Stage 2 re-runs on every invocation (`--stage all` includes it) and it used
  // to rebuild `checkpoint.units` from scratch: the confirmations of the first
  // process came back as `pending`, so the next process started at unit 1 and
  // the server's own keys stopped it there. The observed evidence was a
  // checkpoint with every unit pending while 440 questions were already on disk
  // and in the database.
  let interrupt = true;
  const { harness, stub } = buildHarness(undefined, 20, {
    failConfirmWhen: (keys) => interrupt && keys.includes("cissp-16"),
  });

  await assert.rejects(
    runStages(harness, ["transform", "upload"], null),
    (error: unknown) => error instanceof DriverError && error.code === "SESSION_LOST",
  );
  const interrupted = readCheckpoint(harness.stateDir)!;
  assert.deepEqual(
    interrupted.units.map((unit) => unit.state),
    ["confirmed", "confirmed", "confirmed", "previewed"],
  );
  assert.equal(interrupted.questions.length, 15);
  const confirmsBeforeResume = stub.confirmCount;
  assert.equal(confirmsBeforeResume, 4);

  interrupt = false;
  // A fresh process: the checkpoint is reloaded from disk and stage 2 re-runs
  // over the same converter output before the upload stage starts.
  await runStages(harness, ["transform", "upload"], null);

  const after = readCheckpoint(harness.stateDir)!;
  assert.deepEqual(
    after.units.map((unit) => unit.state),
    ["confirmed", "confirmed", "confirmed", "confirmed"],
  );
  assert.equal(after.stages.upload, "complete");
  assert.equal(after.questions.length, 20);
  // The second process's first preview and first confirm cover unit 4 only.
  assert.deepEqual(stub.previewBatches[4], [
    "cissp-16",
    "cissp-17",
    "cissp-18",
    "cissp-19",
    "cissp-20",
  ]);
  assert.deepEqual(stub.confirmBatches[confirmsBeforeResume], [
    "cissp-16",
    "cissp-17",
    "cissp-18",
    "cissp-19",
    "cissp-20",
  ]);
  // Four previews before the interruption, one after it.
  assert.equal(stub.previewBatches.length, 5);
  assert.equal(stub.questions.size, 20);
});

test("a unit whose keys are all in the checkpoint is adopted with no questions read", async () => {
  // The live incident, as a regression: the rows are on the server *and* in
  // the checkpoint's question list, the unit says `pending` because a stage-2
  // re-run reset the unit states but not the questions. The old read sent five
  // `search` probes, saw only the first page of each, and reported 3 of 5 rows
  // missing when all five existed. Presence is a checkpoint-local fact, so this
  // must cost zero `GET …/questions`.
  const { harness, stub } = buildHarness();
  await runStages(harness, ["transform", "upload"]);
  const confirms = stub.confirmCount;
  const previews = stub.previewCount;
  assert.equal(stub.questionReads, 0);

  const checkpoint = readCheckpoint(harness.stateDir)!;
  checkpoint.units = checkpoint.units.map((unit) => ({
    ...unit,
    state: "pending" as const,
    importId: null,
    expiresAt: null,
  }));
  checkpoint.stages.upload = "in-progress";
  saveCheckpoint(harness.checkpointPath, checkpoint, undefined, NOW);

  await runStages(harness, ["upload"]);

  const after = readCheckpoint(harness.stateDir)!;
  assert.equal(after.units[0]!.state, "confirmed");
  assert.equal(after.stages.upload, "complete");
  assert.equal(after.questions.length, 5);
  // One refused preview, then the checkpoint's own answer: no second preview,
  // no second confirm, nothing written back, and not one question read.
  assert.equal(stub.previewCount, previews + 1);
  assert.equal(stub.confirmCount, confirms);
  assert.equal(stub.questionReads, 0);
  assert.equal(stub.questions.size, 5);
});

test("a unit the server already holds is adopted through one exhaustive topic listing", async () => {
  // The checkpoint knows nothing; the server holds all five rows behind 115
  // decoys whose ids sort first, so page one cannot contain them. Only the
  // cursor-followed walk can answer, and it must answer for all five.
  const lines: string[] = [];
  const { harness, stub } = buildHarness(undefined, 5, { decoys: crowdingDecoys(115) });
  for (const key of ["cissp-1", "cissp-2", "cissp-3", "cissp-4", "cissp-5"]) {
    stub.seedQuestion({ key, questionId: `question-${key}` });
  }
  harness.deps.log = (line) => lines.push(line);

  await runStages(harness, ["transform", "upload"]);

  const checkpoint = readCheckpoint(harness.stateDir)!;
  assert.equal(checkpoint.units[0]!.state, "confirmed");
  assert.equal(checkpoint.stages.upload, "complete");
  assert.deepEqual(
    checkpoint.questions.map((question) => question.key),
    ["cissp-1", "cissp-2", "cissp-3", "cissp-4", "cissp-5"],
  );
  for (const question of checkpoint.questions) {
    assert.equal(question.questionId, `question-${question.key}`);
    assert.equal(question.revisionId, stub.questions.get(question.key)!.revisionId);
  }
  // Three pages: 115 decoys then the five exact rows. A first page is not an
  // answer, and the request count is what proves more than one was read.
  assert.equal(stub.questionReads, 3);
  assert.equal(stub.confirmCount, 0);
  assert.equal(stub.questions.size, 120);
  assert.equal(checkpoint.counters.recoveries >= 1, true);
  assert.equal(
    lines.some((line) => line.includes("adopted 5 question(s) (5 resolved by an exact topic read)")),
    true,
    lines.join("\n"),
  );
});

test("a row the server holds only at a later revision stops with PRESENCE_UNKNOWN", async () => {
  // Present, but not provably the revision an import of these bytes creates:
  // adopting it would attach the review note to content this pipeline cannot
  // show it wrote.
  const { harness, stub } = buildHarness(undefined, 5);
  for (const key of ["cissp-1", "cissp-2", "cissp-3", "cissp-4", "cissp-5"]) {
    stub.seedQuestion({ key, ...(key === "cissp-3" ? { revisionNumber: 2 } : {}) });
  }

  await assert.rejects(
    runStages(harness, ["transform", "upload"]),
    (error: unknown) => error instanceof DriverError && error.code === "PRESENCE_UNKNOWN",
  );

  const checkpoint = readCheckpoint(harness.stateDir)!;
  assert.notEqual(checkpoint.units[0]!.state, "confirmed");
  assert.equal(checkpoint.questions.length, 0);
  assert.equal(checkpoint.lastError?.code, "PRESENCE_UNKNOWN");
  assert.equal(stub.confirmCount, 0);
});

test("a refusal the listing cannot corroborate stops with PRESENCE_UNKNOWN", async () => {
  // The live incident, as an end-to-end case: the preview names five existing
  // keys and the listing shows two. Two server answers disagreeing is not a
  // partial import and certainly not five missing rows - the run stops.
  const { harness, stub } = buildHarness(undefined, 5, {
    omitFromListing: ["cissp-3", "cissp-4", "cissp-5"],
  });
  for (const key of ["cissp-1", "cissp-2", "cissp-3", "cissp-4", "cissp-5"]) {
    stub.seedQuestion({ key });
  }

  await assert.rejects(
    runStages(harness, ["transform", "upload"]),
    (error: unknown) => error instanceof DriverError && error.code === "PRESENCE_UNKNOWN",
  );

  const checkpoint = readCheckpoint(harness.stateDir)!;
  assert.notEqual(checkpoint.units[0]!.state, "confirmed");
  assert.equal(checkpoint.questions.length, 0);
  assert.equal(checkpoint.lastError?.code, "PRESENCE_UNKNOWN");
  assert.equal(stub.confirmCount, 0);
});

test("a unit the server partly holds stops with PARTIAL_IMPORT instead of importing the rest", async () => {
  // Four of unit 1's five rows are on the server, e.g. under a checkpoint this
  // process no longer has. The preview is all-or-nothing, so no reduced preview
  // could import the fifth row without leaving the unit half here and half
  // there: the refusal named four existing keys, the exhausted listing proves
  // four present and one absent, and the run stops.
  const { harness, stub } = buildHarness(undefined, 5);
  for (const key of ["cissp-1", "cissp-2", "cissp-3", "cissp-5"]) {
    stub.seedQuestion({ key, questionId: `seeded-${key}` });
  }

  await assert.rejects(
    runStages(harness, ["transform", "upload"]),
    (error: unknown) => error instanceof DriverError && error.code === "PARTIAL_IMPORT",
  );

  const checkpoint = readCheckpoint(harness.stateDir)!;
  assert.notEqual(checkpoint.units[0]!.state, "confirmed");
  assert.equal(checkpoint.questions.length, 0);
  assert.equal(checkpoint.lastError?.code, "PARTIAL_IMPORT");
  assert.equal(stub.confirmCount, 0);
  assert.deepEqual(stub.previewBatches, [
    ["cissp-1", "cissp-2", "cissp-3", "cissp-4", "cissp-5"],
  ]);
  assert.equal(stub.questions.size, 4);
});

test("an ambiguous confirm in a crowded topic adopts the exact rows, never a substring", async () => {
  // The decoder for the original bug: 115 questions whose keys contain the
  // unit's rows as substrings, one whose stem quotes a row key, all in the same
  // topic. `search=cissp-1` returns decoys; only the walked listing holds the
  // exact row, and a substring match is never adopted.
  const { harness, stub } = buildHarness("commit-then-500", 5, { decoys: crowdingDecoys(115) });

  await runStages(harness, ["transform", "upload"]);

  const checkpoint = readCheckpoint(harness.stateDir)!;
  assert.equal(checkpoint.units[0]!.state, "confirmed");
  assert.deepEqual(
    checkpoint.questions.map((question) => question.key),
    ["cissp-1", "cissp-2", "cissp-3", "cissp-4", "cissp-5"],
  );
  for (const question of checkpoint.questions) {
    assert.equal(question.questionId, stub.questions.get(question.key)!.questionId);
    assert.equal(stub.questions.get(question.key)!.key, question.key);
  }
  assert.equal(stub.questionReads > 1, true);
  assert.equal(stub.questions.size, 120);
});

test("a key that exists only as a substring is never adopted", async () => {
  // `cissp-100` … `cissp-214` contain `cissp-1` and `cissp-2`; `cissp-1` itself
  // is nowhere. The confirm never commits, the walk exhausts the topic without
  // an exact match, and the run stops - twice read, six pages, nothing adopted.
  const { harness, stub } = buildHarness("confirm-409", 5, { decoys: crowdingDecoys(115) });

  await assert.rejects(
    runStages(harness, ["transform", "upload"], null),
    (error: unknown) => error instanceof DriverError && error.code === "CONFIRM_FAILED",
  );

  assert.equal(stub.confirmCount, 2); // the confirm, then its single retry
  assert.equal(stub.questions.size, 115); // only the decoys the fake was given
  assert.equal(stub.questionReads, 6); // two exhausted reads of three pages
  const checkpoint = readCheckpoint(harness.stateDir)!;
  assert.notEqual(checkpoint.units[0]!.state, "confirmed");
  assert.equal(checkpoint.questions.length, 0);
  assert.equal(checkpoint.lastError?.code, "CONFIRM_FAILED");
});

test("a listing that fails mid-walk stops with PROTOCOL_ERROR and records nothing", async () => {
  const { harness, stub } = buildHarness("confirm-409", 5, {
    decoys: crowdingDecoys(60),
    failPageAt: 2,
  });

  await assert.rejects(
    runStages(harness, ["transform", "upload"], null),
    (error: unknown) => error instanceof DriverError && error.code === "PROTOCOL_ERROR",
  );

  assert.equal(stub.questionReads, 2);
  const checkpoint = readCheckpoint(harness.stateDir)!;
  assert.notEqual(checkpoint.units[0]!.state, "confirmed");
  assert.equal(checkpoint.questions.length, 0);
  assert.equal(checkpoint.lastError?.code, "PROTOCOL_ERROR");
});

test("the page bound stops the walk with PRESENCE_UNKNOWN instead of concluding absence", async () => {
  // 2 100 rows is 42 pages at 50 per page, past the 40-page bound. A bounded
  // read that cannot finish must say so, not report 5 000 rows absent.
  const { harness, stub } = buildHarness("confirm-409", 5, { decoys: crowdingDecoys(2_100) });

  await assert.rejects(
    runStages(harness, ["transform", "upload"], null),
    (error: unknown) => error instanceof DriverError && error.code === "PRESENCE_UNKNOWN",
  );

  assert.equal(stub.questionReads, 40);
  const checkpoint = readCheckpoint(harness.stateDir)!;
  assert.notEqual(checkpoint.units[0]!.state, "confirmed");
  assert.equal(checkpoint.questions.length, 0);
  assert.equal(checkpoint.lastError?.code, "PRESENCE_UNKNOWN");
});

test("the question fixture is a real page store: 120 rows at limit 50 is 50 + 50 + 20", async () => {
  // Without this, the fake can silently stop paginating and every presence test
  // above becomes vacuous in the same way the original tests were.
  const stub = createStub({ decoys: crowdingDecoys(120) });
  const readPage = async (cursor: string | null) => {
    const url = new URL(
      `${ORIGIN}/api/admin/content/certifications/cert-1/exam-versions/version-1/questions`,
    );
    url.searchParams.set("domainId", "dom-1");
    url.searchParams.set("topicId", "top-cissp-d1-topic-1");
    url.searchParams.set("limit", "50");
    if (cursor !== null) url.searchParams.set("cursor", cursor);
    const response = await stub.fetchImpl(url.toString());
    assert.equal(response.status, 200);
    return (await response.json()) as { items: Array<{ id: string }>; nextCursor: string | null };
  };

  const first = await readPage(null);
  assert.equal(first.items.length, 50);
  assert.equal(typeof first.nextCursor, "string");
  const second = await readPage(first.nextCursor);
  assert.equal(second.items.length, 50);
  assert.equal(typeof second.nextCursor, "string");
  const third = await readPage(second.nextCursor);
  assert.equal(third.items.length, 20);
  assert.equal(third.nextCursor, null);

  const seen = new Set([...first.items, ...second.items, ...third.items].map((item) => item.id));
  assert.equal(seen.size, 120);
  assert.equal(stub.questionReads, 3);
});

test("no question read ever carries `search`", () => {
  assert.equal(
    everyQuestionUrl.length > 0,
    true,
    "no question URL was recorded, so this pin would be vacuous",
  );
  for (const url of everyQuestionUrl) {
    assert.equal(new URL(url).searchParams.has("search"), false, url);
  }
});

test("a genuinely new conflict still stops the run and records no question", async () => {
  // Reconciling an existing key must not turn a real refusal into an import:
  // a 409 whose keys the server does not hold is still a stop.
  const { harness, stub } = buildHarness("confirm-409");
  await assert.rejects(
    runStages(harness, ["transform", "upload"], null),
    (error: unknown) => error instanceof DriverError && error.code === "CONFIRM_FAILED",
  );

  assert.equal(stub.confirmCount, 2); // the confirm, then its single retry
  assert.equal(stub.questions.size, 0);
  const checkpoint = readCheckpoint(harness.stateDir)!;
  assert.notEqual(checkpoint.units[0]!.state, "confirmed");
  assert.equal(checkpoint.questions.length, 0);
  assert.equal(checkpoint.counters.conflicts, 2);
  assert.equal(checkpoint.lastError?.code, "CONFIRM_FAILED");
});
