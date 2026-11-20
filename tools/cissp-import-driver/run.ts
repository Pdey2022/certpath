import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PREVIEW_EXPIRY_MARGIN_MS,
  QUESTION_IMPORT_MAX_BYTES,
  STAGE_ORDER,
  type StageName,
  parseCsv,
  sha256,
} from "./contract.ts";
import { assertOutsideRepository } from "./paths.ts";
import {
  StaffApi,
  outcomeError,
  previewResponse,
  rejectedError,
  confirmResponse,
  type ApiOutcome,
  type ConfirmResponse,
  type StaffSession,
} from "./client.ts";
import {
  addQuestions,
  alignQuestionState,
  assertCheckpointMatches,
  assertUnitLimit,
  beginStage,
  createCheckpoint,
  findQuestion,
  finishStage,
  isStageComplete,
  loadCheckpoint,
  noteConflict,
  noteRecovery,
  noteServerError,
  recordFailure,
  saveCheckpoint,
  setInFlight,
  setQuestionState,
  setUnitState,
  reconcileUnits,
  unitsInScope,
  type Checkpoint,
  type QuestionRecord,
  type QuestionState,
  type UnitRecord,
} from "./checkpoint.ts";
import {
  decideConfirm,
  decideNextStep,
  mapWorkflowState,
  type ConfirmObservation,
  type ConfirmedQuestionIds,
} from "./decide.ts";
import { DriverError, type DriverErrorCode } from "./errors.ts";
import { resolveUnitPresence, type PresentQuestion, type UnitPresence } from "./presence.ts";
import {
  buildUnits,
  buildUploadManifest,
  publishOrder,
  type TaxonomyIdMap,
  type UnitArtifact,
} from "./transform.ts";
import { validateInputs, type SourceRow, type ValidatedInputs } from "./validate.ts";

export interface RunOptions {
  origin: string;
  batchesDir: string;
  taxonomyPath: string;
  prosePath: string;
  stateDir: string;
  email: string;
  stage: StageName | "all";
  /** CLI override; the prose file's identity is the default. */
  certificationSlug: string | null;
  /** CLI override; the prose file's identity is the default. */
  versionKey: string | null;
  createCertification: boolean;
  batchSize: number;
  unitLimit: number | null;
  dryRun: boolean;
}

export interface RunDependencies {
  fetchImpl: typeof fetch;
  now: () => number;
  log: (line: string) => void;
  /** Secrets are read once per process and never written anywhere. */
  secrets: () => Promise<{ password: string; totpCode: string }>;
  newId: () => string;
  repoRoot: string;
}

export interface RunReport {
  completedStages: StageName[];
  requests: number;
  creates: { certification: number; examVersion: number; domains: number; topics: number };
  adoptions: number;
  published: number;
}

/** The identity is resolved once, after stage 0 supplies the prose defaults. */
interface ResolvedRunOptions extends RunOptions {
  certificationSlug: string;
  versionKey: string;
}

/** The approved review note. Identical for every question, verbatim. */
export function reviewNote(runId: string, unit: number): string {
  return (
    "Owner self-review under the pilot exception in docs/cissp-bank-import.md: " +
    "owner-authored source, converted by tools/cissp-convert and imported " +
    "verbatim through the protected import API. Recorded by driver run " +
    `${runId}, unit ${unit}.`
  );
}

interface Context {
  options: ResolvedRunOptions;
  deps: RunDependencies;
  validated: ValidatedInputs;
  checkpoint: Checkpoint;
  statePath: string;
  api: StaffApi;
  session: StaffSession | null;
  consecutiveFailures: number;
  creates: RunReport["creates"];
  adoptions: number;
  published: number;
  /** Requests already recorded by earlier processes of this run. */
  requestBaseline: number;
}

function log(context: Context, line: string): void {
  context.deps.log(line);
}

function persist(context: Context): void {
  context.checkpoint.counters.requests = context.requestBaseline + context.api.requests;
  context.checkpoint.inputs.unitLimit = context.options.unitLimit;
  saveCheckpoint(context.statePath, context.checkpoint, undefined, context.deps.now());
}

function noteOutcome(context: Context, outcome: Exclude<ApiOutcome, { kind: "ok" }>): void {
  if (outcome.kind === "ambiguous" && outcome.reason === "server") {
    noteServerError(context.checkpoint);
  }
  recordFailure(context.checkpoint, {
    code:
      outcome.code ??
      (outcome.kind === "ambiguous"
        ? outcome.reason === "timeout"
          ? "request_timeout"
          : outcome.reason === "network"
            ? "network_error"
            : "service_unavailable"
        : "unknown_error"),
    status: outcome.status ?? undefined,
    requestId: outcome.requestId ?? undefined,
  });
}

function noteStop(context: Context, error: DriverError): DriverError {
  recordFailure(context.checkpoint, {
    code: error.code,
    status: error.status,
    requestId: error.requestId,
  });
  try {
    persist(context);
  } catch {
    // The original failure is what matters; a failed checkpoint write is
    // reported by the operator's exit code either way.
  }
  return error;
}

function noteFailure(context: Context): void {
  context.consecutiveFailures += 1;
  if (context.consecutiveFailures >= 2) {
    throw new DriverError(
      "CONSECUTIVE_FAILURES",
      "two consecutive failures; stopping rather than grinding against a broken dependency",
    );
  }
}

function noteSuccess(context: Context): void {
  context.consecutiveFailures = 0;
}

/** Reads stage 0's inputs, then waits until a network stage needs a session. */
async function ensureSession(context: Context): Promise<StaffSession> {
  if (context.session !== null) return context.session;
  const { password, totpCode } = await context.deps.secrets();
  await context.api.signIn(context.options.email, password);
  await context.api.readCsrf();
  await context.api.verifyTotp(totpCode);
  const session = await context.api.readSession();
  context.session = session;
  context.checkpoint.target.actorUserId ??= session.userId;
  if (context.checkpoint.target.actorUserId !== session.userId) {
    throw new DriverError(
      "ACTOR_CHANGED",
      "this run is bound to a different staff account than the one that signed in",
    );
  }
  log(context, `auth: signed in as ${session.role}`);
  persist(context);
  return session;
}

function readCreatedId(text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DriverError("PROTOCOL_ERROR", "the create response is not JSON");
  }
  if (value === null || typeof value !== "object" || typeof (value as { id?: unknown }).id !== "string") {
    throw new DriverError("PROTOCOL_ERROR", "the create response is missing an id");
  }
  return (value as { id: string }).id;
}

/**
 * Create once, then reconcile by natural key before any retry. A 409 with no
 * matching row is a collision the driver does not understand and stops.
 */
async function createWithRecovery(
  context: Context,
  spec: {
    label: string;
    create: () => Promise<ApiOutcome>;
    adopt: () => Promise<string | null>;
  },
): Promise<{ id: string; created: boolean }> {
  let outcome = await spec.create();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (outcome.kind === "ok") {
      return { id: readCreatedId(outcome.text), created: true };
    }
    const existing = await spec.adopt();
    if (existing !== null) {
      noteRecovery(context.checkpoint);
      return { id: existing, created: false };
    }
    if (outcome.kind === "rejected") {
      if (outcome.status === 409) {
        throw new DriverError(
          "KEY_COLLISION",
          `${spec.label} answered 409 but no row carries its natural key`,
        );
      }
      throw outcomeError(outcome, "PROTOCOL_ERROR");
    }
    noteOutcome(context, outcome);
    noteRecovery(context.checkpoint);
    outcome = await spec.create();
  }
  if (outcome.kind === "ok") {
    return { id: readCreatedId(outcome.text), created: true };
  }
  throw outcomeError(outcome, "PROTOCOL_ERROR");
}

function idMapFrom(checkpoint: Checkpoint): TaxonomyIdMap {
  const domainIds = new Map<string, string>();
  const topicIds = new Map<string, string>();
  for (const domain of checkpoint.taxonomy.domains) domainIds.set(domain.key, domain.serverId);
  for (const topic of checkpoint.taxonomy.topics) topicIds.set(topic.key, topic.serverId);
  if (checkpoint.target.examVersionId === null || domainIds.size === 0 || topicIds.size === 0) {
    throw new DriverError("CHECKPOINT_INVALID", "the checkpoint holds no taxonomy id map yet");
  }
  return { examVersionId: checkpoint.target.examVersionId, domainIds, topicIds };
}

function unitRows(rows: readonly SourceRow[], batchSize: number): Map<number, SourceRow[]> {
  const map = new Map<number, SourceRow[]>();
  for (let index = 0; index < rows.length; index += batchSize) {
    map.set(map.size + 1, rows.slice(index, index + batchSize));
  }
  return map;
}

async function runTaxonomyStage(context: Context): Promise<void> {
  const { checkpoint, validated } = context;
  const options = context.options;
  beginStage(checkpoint, "taxonomy");
  persist(context);

  const session = await ensureSession(context);
  const certificationId = checkpoint.target.certificationId;
  const existingCertifications = await context.api.listCertifications();
  const found = existingCertifications.find((item) => item.slug === options.certificationSlug) ?? null;

  if (found !== null) {
    if (certificationId !== null && certificationId !== found.id) {
      throw new DriverError("CHECKPOINT_MISMATCH", "the checkpoint names a different certification id");
    }
    checkpoint.target.certificationId = found.id;
    checkpoint.taxonomy.certification = {
      id: found.id,
      created: false,
      displayName: found.displayName,
    };
    context.adoptions += 1;
    log(context, `taxonomy: adopted certification ${options.certificationSlug} (${found.displayName})`);
  } else {
    if (!options.createCertification) {
      throw new DriverError(
        "CERTIFICATION_NOT_FOUND",
        `no certification has slug ${options.certificationSlug}; pass --create-certification to create one`,
      );
    }
    if (session.role !== "global_admin") {
      throw new DriverError(
        "CERTIFICATION_CREATE_FORBIDDEN",
        "creating a certification root is a Global Admin action",
      );
    }
    const newCertificationId = validated.prose.certification.id;
    if (newCertificationId === null) {
      throw new DriverError(
        "PROSE_IDENTITY_INVALID",
        "certification.id is required to create a certification root",
      );
    }
    const created = await createWithRecovery(context, {
      label: "certification",
      create: () =>
        context.api.createCertification({
          id: newCertificationId,
          slug: options.certificationSlug,
          displayName: validated.prose.certification.displayName,
        }),
      adopt: async () =>
        (await context.api.listCertifications()).find((item) => item.slug === options.certificationSlug)?.id ??
        null,
    });
    checkpoint.target.certificationId = created.id;
    checkpoint.taxonomy.certification = {
      id: created.id,
      created: created.created,
      displayName: validated.prose.certification.displayName,
    };
    context.creates.certification += created.created ? 1 : 0;
    context.adoptions += created.created ? 0 : 1;
    log(context, `taxonomy: ${created.created ? "created" : "adopted"} certification ${options.certificationSlug}`);
  }
  const certification = checkpoint.target.certificationId;
  if (certification === null) throw new DriverError("CHECKPOINT_INVALID", "no certification id");
  persist(context);

  const existingVersions = await context.api.listExamVersions(certification);
  const existingVersion = existingVersions.find((item) => item.versionKey === options.versionKey) ?? null;
  if (existingVersion !== null) {
    checkpoint.target.examVersionId = existingVersion.id;
    checkpoint.taxonomy.examVersion = {
      id: existingVersion.id,
      created: false,
      title: existingVersion.title,
    };
    context.adoptions += 1;
    log(context, `taxonomy: adopted exam version ${options.versionKey} (${existingVersion.title})`);
  } else {
    const created = await createWithRecovery(context, {
      label: "exam version",
      create: () =>
        context.api.createExamVersion(certification, {
          versionKey: options.versionKey,
          title: validated.prose.examVersion.title,
          syllabusReference: validated.prose.examVersion.syllabusReference,
        }),
      adopt: async () =>
        (await context.api.listExamVersions(certification)).find(
          (item) => item.versionKey === options.versionKey,
        )?.id ?? null,
    });
    checkpoint.target.examVersionId = created.id;
    checkpoint.taxonomy.examVersion = {
      id: created.id,
      created: created.created,
      title: validated.prose.examVersion.title,
    };
    context.creates.examVersion += created.created ? 1 : 0;
    context.adoptions += created.created ? 0 : 1;
    log(context, `taxonomy: ${created.created ? "created" : "adopted"} exam version ${options.versionKey}`);
  }
  const examVersionId = checkpoint.target.examVersionId;
  if (examVersionId === null) throw new DriverError("CHECKPOINT_INVALID", "no exam version id");
  persist(context);

  const domains = await context.api.listDomains(certification, examVersionId);
  const domainIds = new Map<string, string>();
  checkpoint.taxonomy.domains = [];
  for (const domain of validated.taxonomy.domains) {
    const meaning = validated.prose.domains.get(domain.id);
    if (meaning === undefined) {
      throw new DriverError("PROSE_MISSING", `domain ${domain.id} has no approved meaning`);
    }
    const existing = domains.find((item) => item.domainKey === domain.id) ?? null;
    if (existing !== null) {
      if (existing.title !== domain.title || existing.order !== domain.order) {
        throw new DriverError(
          "TAXONOMY_PROSE_MISMATCH",
          `domain ${domain.id} exists with a different title or order`,
        );
      }
      domainIds.set(domain.id, existing.id);
      checkpoint.taxonomy.domains.push({
        key: domain.id,
        serverId: existing.id,
        order: domain.order,
        title: existing.title,
      });
      context.adoptions += 1;
      continue;
    }
    const created = await createWithRecovery(context, {
      label: `domain ${domain.id}`,
      create: () =>
        context.api.createDomain(certification, examVersionId, {
          domainKey: domain.id,
          title: domain.title,
          meaning,
          order: domain.order,
        }),
      adopt: async () =>
        (await context.api.listDomains(certification, examVersionId)).find(
          (item) => item.domainKey === domain.id,
        )?.id ?? null,
    });
    domainIds.set(domain.id, created.id);
    checkpoint.taxonomy.domains.push({
      key: domain.id,
      serverId: created.id,
      order: domain.order,
      title: domain.title,
    });
    context.creates.domains += created.created ? 1 : 0;
    context.adoptions += created.created ? 0 : 1;
  }
  persist(context);
  log(
    context,
    `taxonomy: ${checkpoint.taxonomy.domains.length} domains (${context.creates.domains} created, ${checkpoint.taxonomy.domains.length - context.creates.domains} adopted)`,
  );

  const topicCounts = { created: 0, adopted: 0 };
  checkpoint.taxonomy.topics = [];
  for (const domain of validated.taxonomy.domains) {
    const domainId = domainIds.get(domain.id);
    if (domainId === undefined) {
      throw new DriverError("CHECKPOINT_INVALID", `domain ${domain.id} has no server id`);
    }
    const existingTopics = await context.api.listTopics(certification, examVersionId, domainId);
    for (const topic of domain.topics) {
      const meaning = validated.prose.topics.get(topic.id);
      if (meaning === undefined) {
        throw new DriverError("PROSE_MISSING", `topic ${topic.id} has no approved meaning`);
      }
      const existing = existingTopics.find((item) => item.topicKey === topic.id) ?? null;
      if (existing !== null) {
        if (existing.title !== topic.title || existing.order !== topic.order) {
          throw new DriverError(
            "TAXONOMY_PROSE_MISMATCH",
            `topic ${topic.id} exists with a different title or order`,
          );
        }
        checkpoint.taxonomy.topics.push({
          key: topic.id,
          serverId: existing.id,
          domainKey: domain.id,
          order: topic.order,
          title: existing.title,
        });
        topicCounts.adopted += 1;
        continue;
      }
      const created = await createWithRecovery(context, {
        label: `topic ${topic.id}`,
        create: () =>
          context.api.createTopic(certification, examVersionId, domainId, {
            topicKey: topic.id,
            title: topic.title,
            meaning,
            order: topic.order,
          }),
        adopt: async () =>
          (await context.api.listTopics(certification, examVersionId, domainId)).find(
            (item) => item.topicKey === topic.id,
          )?.id ?? null,
      });
      checkpoint.taxonomy.topics.push({
        key: topic.id,
        serverId: created.id,
        domainKey: domain.id,
        order: topic.order,
        title: topic.title,
      });
      topicCounts.created += created.created ? 1 : 0;
    }
  }
  context.creates.topics = topicCounts.created;
  context.adoptions += topicCounts.adopted + (checkpoint.taxonomy.topics.length - topicCounts.adopted - topicCounts.created);
  persist(context);
  log(
    context,
    `taxonomy: ${checkpoint.taxonomy.topics.length} topics (${topicCounts.created} created, ${checkpoint.taxonomy.topics.length - topicCounts.created} adopted)`,
  );

  finishStage(checkpoint, "taxonomy");
  persist(context);
  noteSuccess(context);
}

function writeUploadArtifacts(stateDir: string, units: readonly UnitArtifact[], manifestText: string): void {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  for (const unit of units) {
    const target = join(stateDir, unit.file);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, unit.contents, "utf8");
    renameSync(temporary, target);
  }
  const manifestPath = join(stateDir, "upload-manifest.json");
  const temporary = `${manifestPath}.tmp`;
  writeFileSync(temporary, manifestText, "utf8");
  renameSync(temporary, manifestPath);
}

function runTransformStage(context: Context): void {
  const { checkpoint, validated, options } = context;
  beginStage(checkpoint, "transform");
  persist(context);
  const units = buildUnits(validated.rows, idMapFrom(checkpoint), options.batchSize, QUESTION_IMPORT_MAX_BYTES);
  const manifest = buildUploadManifest(units, options.batchSize, validated.converterManifestSha256);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeUploadArtifacts(options.stateDir, units, manifestText);
  checkpoint.inputs.uploadManifestSha256 = sha256(manifestText);
  // Re-running this stage must not discard what stage 3 already confirmed: the
  // unit list is derived from the same converter output, so every unchanged
  // unit keeps its state. Rebuilding the records from scratch here is what made
  // a resume start again at unit 1.
  const preserved = reconcileUnits(checkpoint, units);
  finishStage(checkpoint, "transform");
  persist(context);
  log(
    context,
    `transform: ${validated.rows.length} rows in ${units.length} unit(s) of at most ${options.batchSize} outside the repository` +
      (preserved > 0 ? `; kept ${preserved} confirmed unit(s) from the checkpoint` : ""),
  );
}

function unitBytes(context: Context, unit: UnitArtifact): Uint8Array {
  return new TextEncoder().encode(unit.contents);
}

async function previewUnit(context: Context, unit: UnitArtifact): Promise<PreviewOpening> {
  const certification = context.checkpoint.target.certificationId!;
  const examVersion = context.checkpoint.target.examVersionId!;
  const bytes = unitBytes(context, unit);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = await context.api.previewImport(certification, examVersion, bytes);
    if (outcome.kind === "ok") {
      const parsed = previewResponse(outcome.text);
      if (
        parsed.summary.parsedRows !== unit.rows ||
        parsed.summary.validRows !== unit.rows ||
        parsed.summary.invalidRows !== 0
      ) {
        throw new DriverError(
          "PREVIEW_REJECTED",
          `unit ${unit.unit} previewed ${parsed.summary.validRows} valid of ${parsed.summary.parsedRows} rows`,
          { info: { ...parsed.summary } },
        );
      }
      noteSuccess(context);
      return { kind: "previewed", importId: parsed.importId, expiresAt: parsed.expiresAt };
    }
    if (outcome.kind === "rejected") {
      noteOutcome(context, outcome);
      const issues = outcome.issues ?? [];
      const issueList = issues
        .slice(0, 10)
        .map((issue) => `${issue.path}:${issue.code}`)
        .join(" ");
      const existingKeyIssues = issues.filter((issue) => issue.code === "existing_question_key").length;
      // A refusal whose every issue is `existing_question_key` is not a content
      // error: it says the server already holds every row of this unit, which
      // the caller resolves by presence. One other code anywhere and it is the
      // refusal it looks like.
      if (issues.length > 0 && existingKeyIssues === issues.length) {
        return { kind: "existing-keys", existingKeyIssues };
      }
      if (existingKeyIssues > 0) {
        throw new DriverError(
          "EXISTING_KEYS",
          `unit ${unit.unit} was refused by the import validator${issueList ? ` (${issueList})` : ""}`,
          { status: outcome.status, requestId: outcome.requestId ?? undefined },
        );
      }
      // The run stops either way, but not for the same reason: a lost session
      // (401/403) is re-authenticated and a 429 is waited out, while a refused
      // body is fixed. Collapsing them into PREVIEW_REJECTED hid that.
      if (outcome.status === 401 || outcome.status === 403 || outcome.status === 429) {
        throw rejectedError(outcome, "PREVIEW_REJECTED");
      }
      throw new DriverError(
        "PREVIEW_REJECTED",
        `unit ${unit.unit} was refused by the import validator${issueList ? ` (${issueList})` : ""}`,
        { status: outcome.status, requestId: outcome.requestId ?? undefined },
      );
    }
    noteOutcome(context, outcome);
    noteFailure(context);
  }
  throw new DriverError("PREVIEW_REJECTED", `unit ${unit.unit} could not be previewed`);
}

function rowsForUnit(context: Context, unit: number): SourceRow[] {
  const rows = unitRows(context.validated.rows, context.options.batchSize).get(unit);
  if (!rows) throw new DriverError("CHECKPOINT_INVALID", `unit ${unit} has no rows`);
  return rows;
}

/**
 * The unit's rows as presence input, in row order.
 */
function presenceRows(context: Context, unit: number): Array<{ key: string; domainKey: string; topicKey: string }> {
  return rowsForUnit(context, unit).map((row) => ({
    key: row.key,
    domainKey: row.domainKey,
    topicKey: row.topicKey,
  }));
}

/**
 * Resolves a unit's rows against the checkpoint first and the server second.
 *
 * The checkpoint answers without a request when it holds the ids; only the rows
 * it cannot answer are read, and then by one exhaustive listing of each row's
 * own topic - never by one `search` per key. `PRESENCE_UNKNOWN` on the way out
 * means the read could not conclude, which is not the same claim as "absent".
 *
 * A 5xx on the walk is a server failure the operator needs counted, so it is
 * recorded as one before it propagates; the code the client produced
 * (`PROTOCOL_ERROR`) travels unchanged.
 */
async function readUnitPresence(
  context: Context,
  unit: number,
  options: { refusedExistingKeys?: number } = {},
): Promise<UnitPresence> {
  const certification = context.checkpoint.target.certificationId!;
  const examVersion = context.checkpoint.target.examVersionId!;
  let presence: UnitPresence;
  try {
    presence = await resolveUnitPresence({
      unit,
      rows: presenceRows(context, unit),
      ids: idMapFrom(context.checkpoint),
      questions: context.checkpoint.questions,
      readPage: (domainId, topicId, cursor) =>
        context.api.listQuestions(certification, examVersion, { domainId, topicId, cursor }),
      ...(options.refusedExistingKeys === undefined
        ? {}
        : { refusedExistingKeys: options.refusedExistingKeys }),
    });
  } catch (error) {
    if (error instanceof DriverError && error.status !== undefined && error.status >= 500) {
      noteServerError(context.checkpoint);
    }
    throw error;
  }
  noteRecovery(context.checkpoint);
  return presence;
}

/** How many of a presence result came from the server rather than the file. */
function fromServer(presence: UnitPresence): number {
  const items =
    presence.kind === "all" ? presence.ids : presence.kind === "some" ? presence.present : [];
  return items.filter((item) => item.source === "server").length;
}

/**
 * The observation `decideConfirm` reads, mapped down from the richer presence
 * result. `decide.ts` stays a pure decision table: the revision check and the
 * page walk are properties of the *read*, not of the decision.
 */
function observationFrom(presence: UnitPresence): ConfirmObservation {
  if (presence.kind === "all") {
    return {
      kind: "all",
      ids: presence.ids.map((item) => ({
        key: item.key,
        questionId: item.questionId,
        revisionId: item.revisionId,
      })),
    };
  }
  if (presence.kind === "some") {
    return {
      kind: "some",
      presentKeys: presence.present.map((item) => item.key),
      missingKeys: presence.missingKeys,
    };
  }
  return { kind: "none" };
}

/** The confirm's positional arrays, checked against the keys the preview sent. */
function confirmedIds(
  unit: number,
  confirmation: ConfirmResponse,
  keys: readonly string[],
): ConfirmedQuestionIds[] {
  if (
    confirmation.questionKeys.length !== keys.length ||
    confirmation.questionIds.length !== keys.length ||
    confirmation.revisionIds.length !== keys.length
  ) {
    throw new DriverError(
      "PROTOCOL_ERROR",
      `unit ${unit} confirm answered for ${confirmation.questionKeys.length} key(s) of ${keys.length}`,
    );
  }
  return keys.map((key, index) => {
    if (confirmation.questionKeys[index] !== key) {
      throw new DriverError("PROTOCOL_ERROR", `unit ${unit} confirm returned a different key order`);
    }
    return {
      key,
      questionId: confirmation.questionIds[index]!,
      revisionId: confirmation.revisionIds[index]!,
    };
  });
}

/**
 * Records a unit's questions and marks it confirmed. Every row of the unit must
 * be accounted for: a unit is never confirmed while one of its keys has no
 * server id, because the publish stage would silently skip that question.
 */
function recordUnitQuestions(
  context: Context,
  unit: UnitArtifact,
  entries: readonly ConfirmedQuestionIds[],
): void {
  const rows = rowsForUnit(context, unit.unit);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const records = new Map<string, QuestionRecord>();
  for (const entry of entries) {
    const row = byKey.get(entry.key);
    if (row === undefined) {
      // A second net over the server-answer class, unreachable from both call
      // sites: a confirm's keys are checked against `opening.keys`, and presence
      // only ever returns rows it was given. If it is ever reached the server
      // named a foreign key and the driver has a bug; either way, naming the key
      // and stopping closed is the honest answer, so it stays.
      throw new DriverError(
        "PROTOCOL_ERROR",
        `unit ${unit.unit} reported key ${entry.key}, which is not one of its rows`,
      );
    }
    records.set(entry.key, {
      key: row.key,
      unit: unit.unit,
      domainKey: row.domainKey,
      topicKey: row.topicKey,
      questionId: entry.questionId,
      revisionId: entry.revisionId,
      state: "draft",
      pointerVersion: null,
      inFlight: null,
    });
  }
  if (records.size !== rows.length) {
    const missing = rows.filter((row) => !records.has(row.key)).map((row) => row.key);
    throw new DriverError(
      "PARTIAL_IMPORT",
      `unit ${unit.unit} has ${rows.length} row(s) but only ${records.size} are on the server ` +
        `(${missing.slice(0, 5).join(", ")})`,
    );
  }
  addQuestions(context.checkpoint, [...records.values()]);
  // A unit refused at preview is `previewing` when it is adopted, and
  // `previewing -> confirmed` is deliberately not a legal edge: `previewed` is
  // the state that proves a preview attempt produced an importId we could
  // confirm, and widening the table would let a future path confirm a unit
  // whose preview never ran. Adoption therefore takes the two legal steps in
  // memory and persists once. The intermediate is never written: `previewed`
  // with a null importId is a state the resume loop does not handle.
  const unitRecord = context.checkpoint.units.find((candidate) => candidate.unit === unit.unit);
  if (unitRecord === undefined) {
    throw new DriverError("CHECKPOINT_INVALID", `unit ${unit.unit} is not in the checkpoint`);
  }
  if (unitRecord.state === "previewing") setUnitState(context.checkpoint, unit.unit, "previewed");
  setUnitState(context.checkpoint, unit.unit, "confirmed");
  persist(context);
}

interface UnitPreview {
  importId: string;
  expiresAt: number;
}

/** What `previewUnit` can answer with. */
type PreviewOpening =
  | { kind: "previewed"; importId: string; expiresAt: number }
  /** Every issue was `existing_question_key`: the server holds every row. */
  | { kind: "existing-keys"; existingKeyIssues: number };

/** What the driver holds when it is about to confirm one unit. */
interface UnitOpening {
  /** `null` when the server already holds every key the unit wants. */
  preview: UnitPreview | null;
  /** The keys the preview covers, in row order; empty when there is no preview. */
  keys: string[];
  /** Rows the server already held, resolved by presence. */
  adopted: PresentQuestion[];
}

/**
 * Previews a unit, or reconciles it when the validator refuses its keys.
 *
 * `existing_question_key` is evidence, not a verdict: the rows are on the
 * server, and the driver's job is to record that rather than to stop a run that
 * only the checkpoint's own gap made look new. The read is the same presence
 * resolution an ambiguous confirm uses, cross-checked against the number of
 * keys the refusal itself named.
 *
 * Only a whole unit is adopted, and only on ids this run can account for
 * (`previewed`): see the `EXISTING_KEYS` throw below.
 *
 * The preview is all-or-nothing, so a server that holds some of a unit's keys
 * is a state nobody can proceed from: it stops with `PARTIAL_IMPORT` rather
 * than importing the rest and leaving the unit half in one place and half in
 * another.
 *
 * `previewed` is true when this checkpoint holds an `importId` for the unit,
 * which means these exact bytes were previewed here at some point
 * (`reconcileUnits` clears the `importId` when a unit's bytes move).
 */
async function openUnit(
  context: Context,
  unit: UnitArtifact,
  previewed: boolean,
): Promise<UnitOpening> {
  const keys = rowsForUnit(context, unit.unit).map((row) => row.key);
  const opened = await previewUnit(context, unit);
  if (opened.kind === "previewed") {
    return { preview: opened, keys, adopted: [] };
  }
  const presence = await readUnitPresence(context, unit.unit, {
    refusedExistingKeys: opened.existingKeyIssues,
  });
  if (presence.kind === "all") {
    // Fail closed. An id from the listing proves the key exists, not that the
    // row holds the bytes this unit carries: `UNIQUE (certification_id,
    // question_key)` is scoped to the certification, so a re-import after the
    // source was corrected meets the same keys holding the *old* content, at
    // revision 1. Publishing those rows would attach the review note to content
    // this pipeline never sent. Adopt a server-resolved id only when this
    // checkpoint previewed these exact bytes; a checkpoint-local id is the
    // run's own record and needs no such licence.
    const unproven = presence.ids.filter((item) => item.source === "server");
    if (unproven.length > 0 && !previewed) {
      throw new DriverError(
        "EXISTING_KEYS",
        `unit ${unit.unit} needs ${unproven.length} row(s) this run never previewed ` +
          `(${unproven.slice(0, 5).map((item) => item.key).join(", ")}); ` +
          "its ids would come from a listing that proves the key, not the content",
      );
    }
    return { preview: null, keys: [], adopted: presence.ids };
  }
  if (presence.kind === "some") {
    throw new DriverError(
      "PARTIAL_IMPORT",
      `unit ${unit.unit} has ${presence.present.length} of ${unit.rows} row(s) on the server; ` +
        `absent: ${presence.missingKeys.slice(0, 5).join(", ")}`,
    );
  }
  // `none` reaches here only when the refusal named no key at all, which the
  // resolver's count cross-check already refuses. Fail closed rather than
  // believing either answer.
  throw new DriverError(
    "PRESENCE_UNKNOWN",
    `unit ${unit.unit} was refused for existing keys but its topic listing shows none of them`,
  );
}

function markPreviewed(context: Context, unit: number, preview: UnitPreview): void {
  setUnitState(context.checkpoint, unit, "previewed", {
    importId: preview.importId,
    expiresAt: preview.expiresAt,
  });
  persist(context);
}

/**
 * One unit end to end: preview, confirm, and adopt what the server already
 * holds. Returns only when the unit is `confirmed` on disk.
 */
async function confirmUnit(context: Context, unit: UnitArtifact, record: UnitRecord): Promise<void> {
  const { checkpoint } = context;
  if (record.state === "previewing") {
    // A crash before the preview response. Nothing was created; start over.
    setUnitState(checkpoint, record.unit, "pending");
    persist(context);
  }
  if (record.state === "previewed" && record.importId !== null) {
    // A crash after preview: reuse nothing across a restart; re-preview the
    // same bytes so the confirmation is adjacent to a fresh preview.
    setUnitState(checkpoint, record.unit, "previewing");
    persist(context);
  } else if (record.state === "pending") {
    setUnitState(checkpoint, record.unit, "previewing");
    persist(context);
  }

  // `importId` is the discriminator the fail-closed adoption needs, and it is
  // read *after* the state fix-ups above: recovering a `previewed` unit moves
  // it back to `previewing` but keeps the id, which is exactly the evidence
  // that these bytes were previewed here.
  const previewed = record.importId !== null;

  let opening = await openUnit(context, unit, previewed);
  if (opening.preview !== null) markPreviewed(context, record.unit, opening.preview);

  let retried = false;
  for (;;) {
    const preview = opening.preview;
    if (preview === null) {
      recordUnitQuestions(context, unit, opening.adopted);
      noteSuccess(context);
      log(
        context,
        `upload: unit ${unit.unit} adopted ${opening.adopted.length} question(s) ` +
          `(${opening.adopted.filter((item) => item.source === "server").length} resolved by an exact topic read)`,
      );
      return;
    }

    if (context.deps.now() > preview.expiresAt - PREVIEW_EXPIRY_MARGIN_MS) {
      setUnitState(checkpoint, record.unit, "previewing");
      persist(context);
      opening = await openUnit(context, unit, previewed);
      if (opening.preview !== null) markPreviewed(context, record.unit, opening.preview);
      retried = false;
      continue;
    }

    const outcome = await context.api.confirmImport(
      context.checkpoint.target.certificationId!,
      preview.importId,
    );
    if (outcome.kind === "ok") {
      const confirmation = confirmResponse(outcome.text);
      recordUnitQuestions(context, unit, [
        ...opening.adopted,
        ...confirmedIds(unit.unit, confirmation, opening.keys),
      ]);
      noteSuccess(context);
      log(context, `upload: unit ${unit.unit} confirmed ${opening.keys.length} question(s)`);
      return;
    }

    if (outcome.kind === "rejected" && outcome.status !== 409) {
      noteOutcome(context, outcome);
      throw outcomeError(outcome, "CONFIRM_FAILED");
    }
    if (outcome.kind === "rejected" && outcome.status === 409) noteConflict(checkpoint);
    noteOutcome(context, outcome);
    const presence = await readUnitPresence(context, unit.unit);
    const decision = decideConfirm({
      outcome: "ambiguous",
      observation: observationFrom(presence),
      previewExpired: context.deps.now() >= preview.expiresAt,
      retried,
    });
    if (decision.action === "adopt") {
      recordUnitQuestions(context, unit, [...opening.adopted, ...decision.ids]);
      noteSuccess(context);
      log(
        context,
        `upload: unit ${unit.unit} adopted ${decision.ids.length} question(s) after reconciliation ` +
          `(${fromServer(presence)} resolved by an exact topic read)`,
      );
      return;
    }
    if (decision.action === "retry") {
      retried = true;
      noteFailure(context);
      continue;
    }
    if (decision.action === "re-preview") {
      setUnitState(checkpoint, record.unit, "previewing");
      persist(context);
      opening = await openUnit(context, unit, previewed);
      if (opening.preview !== null) markPreviewed(context, record.unit, opening.preview);
      retried = false;
      continue;
    }
    if (decision.action === "stop") {
      throw new DriverError(decision.code, decision.detail);
    }
    throw new DriverError("CONFIRM_FAILED", `unit ${unit.unit} did not confirm`);
  }
}

async function runUploadStage(context: Context): Promise<void> {
  const { checkpoint, options } = context;
  beginStage(checkpoint, "upload");
  assertUnitLimit(options.unitLimit, checkpoint.units.length);
  persist(context);
  await ensureSession(context);

  const units = unitsInScope(checkpoint, options.unitLimit);
  const built = buildUnits(
    context.validated.rows,
    idMapFrom(checkpoint),
    options.batchSize,
    QUESTION_IMPORT_MAX_BYTES,
  );
  const byNumber = new Map(built.map((unit) => [unit.unit, unit]));

  for (const record of units) {
    if (record.state === "confirmed") continue;
    const unit = byNumber.get(record.unit);
    if (!unit) throw new DriverError("CHECKPOINT_INVALID", `unit ${record.unit} has no file`);
    await confirmUnit(context, unit, record);
  }

  const remaining = units.filter((unit) => unit.state !== "confirmed");
  if (remaining.length > 0) {
    throw new DriverError(
      "STAGE_ORDER",
      `upload is scoped to ${units.length} unit(s) but ${remaining.length} are not confirmed`,
    );
  }
  finishStage(checkpoint, "upload");
  persist(context);
}

interface Observation {
  workflowState: ReturnType<typeof mapWorkflowState>;
  publication: Awaited<ReturnType<StaffApi["readPublication"]>>;
}

async function observeQuestion(context: Context, record: QuestionRecord): Promise<Observation> {
  const certification = context.checkpoint.target.certificationId!;
  const examVersion = context.checkpoint.target.examVersionId!;
  const questionId = record.questionId;
  const revisionId = record.revisionId;
  if (questionId === null || revisionId === null) {
    throw new DriverError("CHECKPOINT_INVALID", `question ${record.key} has no server ids`);
  }
  const publication = await context.api.readPublication(certification, examVersion, questionId);
  const workflowState = await context.api.readRevisionState(
    certification,
    examVersion,
    questionId,
    revisionId,
  );
  noteRecovery(context.checkpoint);
  return { workflowState: mapWorkflowState(workflowState), publication };
}

function questionWorkflowState(state: QuestionState): ReturnType<typeof mapWorkflowState> {
  return state === "pending" ? "draft" : state;
}

async function convergeQuestion(context: Context, record: QuestionRecord): Promise<void> {
  const certification = context.checkpoint.target.certificationId!;
  const examVersion = context.checkpoint.target.examVersionId!;
  const questionId = record.questionId;
  const revisionId = record.revisionId;
  if (questionId === null || revisionId === null) {
    throw new DriverError("CHECKPOINT_INVALID", `question ${record.key} has no server ids`);
  }
  let recoveries = 0;

  for (let step = 0; step < 10; step += 1) {
    if (record.state === "published") return;
    let workflowState = questionWorkflowState(record.state);
    let publication: Observation["publication"] = null;
    if (record.inFlight !== null) {
      const observation = await observeQuestion(context, record);
      // The intent is cleared by the branch's own continuing writes, which pass
      // `{ inFlight: null }` to align/set before they persist. Clearing it here
      // would destroy the on-disk record of "a mutation was in flight" on
      // exactly the throws below (a publication for another revision, an
      // unexpected state, an observation behind the checkpoint) - the stop that
      // most needs to say a call may have landed.
      workflowState = observation.workflowState;
      publication = observation.publication;
      if (publication !== null) {
        if (publication.revisionId !== revisionId) {
          throw new DriverError(
            "PUBLICATION_CONFLICT",
            `${record.key}: a publication exists for a different revision`,
          );
        }
        if (publication.state === "published") {
          alignQuestionState(context.checkpoint, record.key, "published", {
            pointerVersion: publication.pointerVersion,
            inFlight: null,
          });
          persist(context);
          context.published += 1;
          return;
        }
        throw new DriverError(
          "PUBLICATION_CONFLICT",
          `${record.key}: our revision is retired, not published`,
        );
      }
      if (workflowState !== "draft" && workflowState !== "submitted" && workflowState !== "approved" && workflowState !== "published") {
        throw new DriverError(
          "WORKFLOW_CONFLICT",
          `${record.key}: the server reports an unexpected workflow state`,
        );
      }
      alignQuestionState(context.checkpoint, record.key, workflowState, { inFlight: null });
      persist(context);
    }
    const decision = decideNextStep({
      workflowState,
      publication,
      ourRevisionId: revisionId,
    });
    if (decision.action === "done") {
      setQuestionState(context.checkpoint, record.key, "published", {
        pointerVersion: decision.pointerVersion,
        inFlight: null,
      });
      persist(context);
      context.published += 1;
      return;
    }
    if (decision.action === "stop") {
      throw new DriverError(decision.code, `${record.key}: ${decision.detail}`);
    }

    const action = decision.action;
    setInFlight(context.checkpoint, record.key, action);
    persist(context);

    const outcome =
      action === "submit"
        ? await context.api.submitRevision(certification, examVersion, questionId, revisionId)
        : action === "review"
          ? await context.api.reviewRevision(
              certification,
              examVersion,
              questionId,
              revisionId,
              reviewNote(context.checkpoint.runId, record.unit),
            )
          : await context.api.publishQuestion(certification, examVersion, questionId, revisionId);

    if (outcome.kind === "ok") {
      setQuestionState(
        context.checkpoint,
        record.key,
        action === "submit" ? "submitted" : action === "review" ? "approved" : "published",
        {
          inFlight: null,
          ...(action === "publish"
            ? { pointerVersion: Number((JSON.parse(outcome.text) as { pointerVersion?: number }).pointerVersion ?? 0) || null }
            : {}),
        },
      );
      persist(context);
      noteSuccess(context);
      if (action === "publish") {
        context.published += 1;
        return;
      }
      continue;
    }

    if (outcome.kind === "rejected" && outcome.status !== 409) {
      noteOutcome(context, outcome);
      throw outcomeError(outcome, "WORKFLOW_CONFLICT");
    }
    if (outcome.kind === "rejected") noteConflict(context.checkpoint);
    noteOutcome(context, outcome);
    recoveries += 1;
    if (recoveries > 1) {
      throw new DriverError(
        "WORKFLOW_CONFLICT",
        `${record.key}: a second conflict after one reconciliation`,
      );
    }
    noteFailure(context);
    // The intent stays set. A rejected, 5xx or timed-out answer does not say
    // whether the mutation committed, so the next iteration must observe the
    // server state and align before deciding anything - "re-read the server
    // state, then act" in docs/cissp-import-driver.md. Clearing it here is what
    // re-sent the same submit from the stale checkpoint, and a submit that
    // committed with a lost response then surfaced as a 409 and a
    // WORKFLOW_CONFLICT instead of the state the server already held.
    persist(context);
  }
  throw new DriverError("WORKFLOW_CONFLICT", `${record.key}: the workflow did not converge`);
}

async function runPublishStage(context: Context): Promise<void> {
  const { checkpoint, options } = context;
  beginStage(checkpoint, "publish");
  persist(context);
  await ensureSession(context);

  const order = publishOrder(context.validated.rows);
  const confirmedKeys = new Set(
    checkpoint.questions
      .filter((record) => record.questionId !== null)
      .filter((record) => options.unitLimit === null || record.unit <= options.unitLimit)
      .map((record) => record.key),
  );
  let count = 0;
  for (const key of order) {
    if (!confirmedKeys.has(key)) continue;
    const record = findQuestion(checkpoint, key);
    await convergeQuestion(context, record);
    if (record.state === "published") count += 1;
  }
  const unpublished = checkpoint.questions.filter((record) => record.state !== "published");
  if (unpublished.length > 0) {
    throw new DriverError(
      "STAGE_ORDER",
      `${unpublished.length} confirmed question(s) are not published`,
    );
  }
  finishStage(checkpoint, "publish");
  persist(context);
  log(context, `publish: ${count} question(s) submitted, approved and published`);
}

async function runVerifyStage(context: Context): Promise<void> {
  const { checkpoint, options } = context;
  beginStage(checkpoint, "verify");
  persist(context);
  await ensureSession(context);

  const certification = checkpoint.target.certificationId!;
  const examVersion = checkpoint.target.examVersionId!;
  const keys: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const page = await context.api.exportPage(certification, examVersion, cursor);
    pages += 1;
    const records = parseCsv(page.csv);
    for (const record of records.slice(1)) {
      keys.push(record[1] ?? "");
    }
    cursor = page.nextCursor;
    if (cursor === null) break;
    if (pages > 100) throw new DriverError("PROTOCOL_ERROR", "the export did not finish paginating");
  }

  const expected = checkpoint.questions
    .filter((record) => record.state === "published")
    .filter((record) => options.unitLimit === null || record.unit <= options.unitLimit)
    .map((record) => record.key);
  if (keys.length !== expected.length) {
    throw new DriverError(
      "VERIFY_COUNT_MISMATCH",
      `the export holds ${keys.length} row(s); the checkpoint confirmed ${expected.length}`,
    );
  }
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) {
      throw new DriverError("VERIFY_KEY_MISMATCH", "the export repeats a question key");
    }
    seen.add(key);
  }
  const missing = expected.filter((key) => !seen.has(key));
  if (missing.length > 0) {
    throw new DriverError(
      "VERIFY_KEY_MISMATCH",
      `${missing.length} published question key(s) are absent from the export`,
    );
  }
  finishStage(checkpoint, "verify");
  persist(context);
  log(context, `verify: ${keys.length} published row(s) read back across ${pages} export page(s)`);
}

function stagesToRun(stage: StageName | "all"): StageName[] {
  return stage === "all" ? [...STAGE_ORDER] : [stage];
}

/** The driver's single entry point; returns a report or throws a DriverError. */
export async function runDriver(options: RunOptions, deps: RunDependencies): Promise<RunReport> {
  const validated = validateInputs({
    batchesDir: options.batchesDir,
    taxonomyPath: options.taxonomyPath,
    prosePath: options.prosePath,
  });
  deps.log(
    `validate: ${validated.rows.length} row(s) in ${validated.batchCount} converter batch(es); ` +
      `${validated.taxonomy.domains.length} domains; ${validated.taxonomy.topicIds.size} topics; ` +
      `prose validated against the taxonomy key set`,
  );
  const unitCount = Math.ceil(validated.rows.length / options.batchSize);
  deps.log(
    `validate: ${unitCount} upload unit(s) of at most ${options.batchSize}; declared exam version ${validated.declaredExamVersionId}`,
  );

  // The operator names the target; the prose file supplies the identity the
  // operator did not override.
  const resolved: ResolvedRunOptions = {
    ...options,
    certificationSlug: options.certificationSlug ?? validated.prose.certification.slug,
    versionKey: options.versionKey ?? validated.prose.examVersion.versionKey,
  };
  if (
    resolved.certificationSlug !== validated.prose.certification.slug ||
    resolved.versionKey !== validated.prose.examVersion.versionKey
  ) {
    deps.log(
      `validate: target override — prose names ${validated.prose.certification.slug}/${validated.prose.examVersion.versionKey}, ` +
        `run targets ${resolved.certificationSlug}/${resolved.versionKey}`,
    );
  }

  const report: RunReport = {
    completedStages: [],
    requests: 0,
    creates: { certification: 0, examVersion: 0, domains: 0, topics: 0 },
    adoptions: 0,
    published: 0,
  };
  if (resolved.dryRun) return report;

  const stateDir = assertOutsideRepository(resolved.stateDir, deps.repoRoot, "STATE_INSIDE_REPOSITORY");
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, "checkpoint.json");
  const existing = loadCheckpoint(statePath);
  const now = deps.now();
  const checkpoint =
    existing ??
    createCheckpoint({
      runId: deps.newId(),
      now,
      target: {
        origin: resolved.origin,
        actorUserId: null,
        certificationId: null,
        certificationSlug: resolved.certificationSlug,
        examVersionKey: resolved.versionKey,
        examVersionId: null,
      },
      inputs: {
        taxonomySha256: validated.taxonomySha256,
        proseSha256: validated.proseSha256,
        converterManifestSha256: validated.converterManifestSha256,
        uploadManifestSha256: null,
        batchSize: resolved.batchSize,
        converterDeclaredExamVersionId: validated.declaredExamVersionId,
        unitLimit: resolved.unitLimit,
      },
    });
  assertCheckpointMatches(checkpoint, {
    origin: resolved.origin,
    certificationSlug: resolved.certificationSlug,
    examVersionKey: resolved.versionKey,
    taxonomySha256: validated.taxonomySha256,
    proseSha256: validated.proseSha256,
    converterManifestSha256: validated.converterManifestSha256,
    batchSize: resolved.batchSize,
  });

  const context: Context = {
    options: resolved,
    deps,
    validated,
    checkpoint,
    statePath,
    api: new StaffApi({ origin: resolved.origin, fetchImpl: deps.fetchImpl }),
    session: null,
    consecutiveFailures: 0,
    creates: report.creates,
    adoptions: 0,
    published: 0,
    requestBaseline: checkpoint.counters.requests,
  };
  persist(context);

  try {
    for (const stage of stagesToRun(resolved.stage)) {
      if (isStageComplete(checkpoint, stage) && stage !== "taxonomy" && stage !== "transform") {
        deps.log(`driver: stage ${stage} is already complete; nothing to do`);
        continue;
      }
      deps.log(`driver: stage ${stage}`);
      if (stage === "taxonomy") await runTaxonomyStage(context);
      else if (stage === "transform") runTransformStage(context);
      else if (stage === "upload") await runUploadStage(context);
      else if (stage === "publish") await runPublishStage(context);
      else await runVerifyStage(context);
      report.completedStages.push(stage);
    }
  } catch (error) {
    if (error instanceof DriverError) throw noteStop(context, error);
    recordFailure(checkpoint, { code: "UNEXPECTED" });
    throw noteStop(
      context,
      new DriverError("UNEXPECTED", "the driver stopped on an unexpected error"),
    );
  }

  report.requests = context.api.requests;
  report.adoptions = context.adoptions;
  report.published = context.published;
  // A fully successful invocation leaves no unresolved failure behind. The
  // audit trail of earlier attempts lives in the server's audit events.
  checkpoint.lastError = null;
  persist(context);
  return report;
}

export type { DriverErrorCode };
