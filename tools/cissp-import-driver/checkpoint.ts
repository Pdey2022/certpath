import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { CHECKPOINT_FORMAT_VERSION, STAGE_ORDER, type StageName } from "./contract.ts";
import { DriverError } from "./errors.ts";

/**
 * The checkpoint: one JSON file outside the repository, replaced atomically.
 *
 * It records intent before a call and outcome after it, so a crash leaves at
 * most one unit in `previewing` or one question with `inFlight` set — never a
 * silent gap. It never holds a cookie, a CSRF token, a password, a TOTP code
 * or seed, a recovery code, a stem, an option, an explanation or any question
 * text. `lastError` holds a code, an HTTP status and a server `requestId`.
 */

export type StageState = "pending" | "in-progress" | "complete";
export type UnitState = "pending" | "previewing" | "previewed" | "confirmed";
export type QuestionState = "pending" | "draft" | "submitted" | "approved" | "published";
export type InFlightAction = "submit" | "review" | "publish";

export interface CheckpointTarget {
  origin: string;
  actorUserId: string | null;
  certificationId: string | null;
  certificationSlug: string;
  examVersionKey: string;
  examVersionId: string | null;
}

export interface CheckpointInputs {
  taxonomySha256: string;
  proseSha256: string;
  converterManifestSha256: string;
  uploadManifestSha256: string | null;
  batchSize: number;
  converterDeclaredExamVersionId: string;
  unitLimit: number | null;
}

export interface TaxonomyCheckpoint {
  certification: { id: string; created: boolean; displayName: string | null };
  examVersion: { id: string; created: boolean; title: string | null };
  domains: Array<{ key: string; serverId: string; order: number; title: string }>;
  topics: Array<{ key: string; serverId: string; domainKey: string; order: number; title: string }>;
}

export interface UnitRecord {
  unit: number;
  file: string;
  sha256: string;
  rows: number;
  state: UnitState;
  importId: string | null;
  expiresAt: number | null;
}

export interface QuestionRecord {
  key: string;
  unit: number;
  domainKey: string;
  topicKey: string;
  questionId: string | null;
  revisionId: string | null;
  state: QuestionState;
  pointerVersion: number | null;
  inFlight: InFlightAction | null;
}

export interface Counters {
  requests: number;
  http5xx: number;
  conflicts: number;
  recoveries: number;
}

export interface CheckpointError {
  code: string;
  status: number | null;
  requestId: string | null;
}

export interface Checkpoint {
  formatVersion: typeof CHECKPOINT_FORMAT_VERSION;
  runId: string;
  createdAt: number;
  updatedAt: number;
  target: CheckpointTarget;
  inputs: CheckpointInputs;
  stages: Record<StageName, StageState>;
  taxonomy: TaxonomyCheckpoint;
  units: UnitRecord[];
  questions: QuestionRecord[];
  counters: Counters;
  lastError: CheckpointError | null;
}

export interface CheckpointIo {
  exists(path: string): boolean;
  read(path: string): string;
  write(path: string, text: string): void;
  rename(from: string, to: string): void;
}

export const defaultCheckpointIo: CheckpointIo = {
  exists: (path) => existsSync(path),
  read: (path) => readFileSync(path, "utf8"),
  write: (path, text) => writeFileSync(path, text, "utf8"),
  rename: (from, to) => renameSync(from, to),
};

/** Stages whose re-run is a pure read or a pure file transform. */
const RESTARTABLE_STAGES: ReadonlySet<StageName> = new Set(["taxonomy", "transform"]);

const UNIT_TRANSITIONS: Record<UnitState, readonly UnitState[]> = {
  pending: ["previewing"],
  // `previewing` -> `confirmed` is the reconciled outcome: the preview was
  // refused because the server already held every key, and the by-key read
  // proved it. Nothing was created, and no preview ever succeeded.
  previewing: ["previewed", "pending", "confirmed"],
  previewed: ["previewing", "confirmed"],
  confirmed: [],
};

const QUESTION_TRANSITIONS: Record<QuestionState, readonly QuestionState[]> = {
  pending: ["draft"],
  draft: ["submitted"],
  submitted: ["approved"],
  approved: ["published"],
  published: [],
};

export interface CreateCheckpointInput {
  runId: string;
  now: number;
  target: CheckpointTarget;
  inputs: CheckpointInputs;
}

export function createCheckpoint(input: CreateCheckpointInput): Checkpoint {
  return {
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    runId: input.runId,
    createdAt: input.now,
    updatedAt: input.now,
    target: input.target,
    inputs: input.inputs,
    stages: {
      taxonomy: "pending",
      transform: "pending",
      upload: "pending",
      publish: "pending",
      verify: "pending",
    },
    taxonomy: {
      certification: { id: "", created: false, displayName: null },
      examVersion: { id: "", created: false, title: null },
      domains: [],
      topics: [],
    },
    units: [],
    questions: [],
    counters: { requests: 0, http5xx: 0, conflicts: 0, recoveries: 0 },
    lastError: null,
  };
}

export function loadCheckpoint(path: string, io: CheckpointIo = defaultCheckpointIo): Checkpoint | null {
  if (!io.exists(path)) return null;
  let text: string;
  try {
    text = io.read(path);
  } catch {
    throw new DriverError("CHECKPOINT_UNREADABLE", "the checkpoint could not be read");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DriverError("CHECKPOINT_INVALID", "the checkpoint is not valid JSON");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    (value as Checkpoint).formatVersion !== CHECKPOINT_FORMAT_VERSION
  ) {
    throw new DriverError("CHECKPOINT_INVALID", "the checkpoint has an unexpected format");
  }
  const checkpoint = value as Checkpoint;
  for (const stage of STAGE_ORDER) {
    const state = checkpoint.stages[stage];
    if (state !== "pending" && state !== "in-progress" && state !== "complete") {
      throw new DriverError("CHECKPOINT_INVALID", `stage ${stage} has an unknown state`);
    }
  }
  return checkpoint;
}

/**
 * Atomic replace: serialise first (a failure here writes nothing), then write a
 * sibling `.tmp` file and rename it over the checkpoint.
 */
export function saveCheckpoint(
  path: string,
  checkpoint: Checkpoint,
  io: CheckpointIo = defaultCheckpointIo,
  now: number = Date.now(),
): void {
  checkpoint.updatedAt = now;
  const text = `${JSON.stringify(checkpoint, null, 2)}\n`;
  const temporary = `${path}.tmp`;
  io.write(temporary, text);
  io.rename(temporary, path);
}

export interface CheckpointExpectation {
  origin: string;
  certificationSlug: string;
  examVersionKey: string;
  taxonomySha256: string;
  proseSha256: string;
  converterManifestSha256: string;
  batchSize: number;
}

/** Refuses a checkpoint that describes a different target or different inputs. */
export function assertCheckpointMatches(
  checkpoint: Checkpoint,
  expected: CheckpointExpectation,
): void {
  const mismatches: string[] = [];
  if (checkpoint.target.origin !== expected.origin) mismatches.push("origin");
  if (checkpoint.target.certificationSlug !== expected.certificationSlug) mismatches.push("certificationSlug");
  if (checkpoint.target.examVersionKey !== expected.examVersionKey) mismatches.push("examVersionKey");
  if (checkpoint.inputs.taxonomySha256 !== expected.taxonomySha256) mismatches.push("taxonomySha256");
  if (checkpoint.inputs.proseSha256 !== expected.proseSha256) mismatches.push("proseSha256");
  if (checkpoint.inputs.converterManifestSha256 !== expected.converterManifestSha256) {
    mismatches.push("converterManifestSha256");
  }
  if (checkpoint.inputs.batchSize !== expected.batchSize) mismatches.push("batchSize");
  if (mismatches.length > 0) {
    throw new DriverError(
      "CHECKPOINT_MISMATCH",
      `the checkpoint belongs to a different run (${mismatches.join(", ")})`,
    );
  }
}

export function stageIndex(stage: StageName): number {
  return STAGE_ORDER.indexOf(stage);
}

/**
 * Marks a stage in progress. Every earlier stage must be `complete`, and a
 * completed stage cannot be re-entered unless its re-run is a pure read or a
 * pure file transform.
 */
export function beginStage(checkpoint: Checkpoint, stage: StageName): void {
  for (const earlier of STAGE_ORDER.slice(0, stageIndex(stage))) {
    if (checkpoint.stages[earlier] !== "complete") {
      throw new DriverError(
        "STAGE_ORDER",
        `stage ${stage} requires stage ${earlier} to be complete first`,
      );
    }
  }
  const current = checkpoint.stages[stage];
  if (current === "complete") {
    if (!RESTARTABLE_STAGES.has(stage)) {
      throw new DriverError("TRANSITION_INVALID", `stage ${stage} is already complete`);
    }
  }
  checkpoint.stages[stage] = "in-progress";
}

export function finishStage(checkpoint: Checkpoint, stage: StageName): void {
  if (checkpoint.stages[stage] !== "in-progress") {
    throw new DriverError("TRANSITION_INVALID", `stage ${stage} is not in progress`);
  }
  checkpoint.stages[stage] = "complete";
}

export function isStageComplete(checkpoint: Checkpoint, stage: StageName): boolean {
  return checkpoint.stages[stage] === "complete";
}

export function setUnitState(
  checkpoint: Checkpoint,
  unit: number,
  next: UnitState,
  patch: { importId?: string | null; expiresAt?: number | null } = {},
): UnitRecord {
  const record = checkpoint.units.find((candidate) => candidate.unit === unit);
  if (!record) {
    throw new DriverError("CHECKPOINT_INVALID", `unit ${unit} is not in the checkpoint`);
  }
  if (!UNIT_TRANSITIONS[record.state].includes(next)) {
    throw new DriverError(
      "TRANSITION_INVALID",
      `unit ${unit} cannot move from ${record.state} to ${next}`,
    );
  }
  record.state = next;
  if (patch.importId !== undefined) record.importId = patch.importId;
  if (patch.expiresAt !== undefined) record.expiresAt = patch.expiresAt;
  return record;
}

/**
 * Re-derives the unit list from the transformer's current output, keeping the
 * state a previous process recorded.
 *
 * Stage 2 is restarted on every invocation - `--stage all` re-runs it - and it
 * is a pure function of the converter output, so its output must not be a way
 * to lose what stage 3 already did. A unit whose file, digest and row count are
 * unchanged keeps its state, `importId` and expiry; anything else starts at
 * `pending`, which is the only safe reading of a unit whose bytes moved.
 */
export function reconcileUnits(
  checkpoint: Checkpoint,
  units: ReadonlyArray<Pick<UnitRecord, "unit" | "file" | "sha256" | "rows">>,
): number {
  const previous = new Map(checkpoint.units.map((record) => [record.unit, record]));
  let preserved = 0;
  checkpoint.units = units.map((unit) => {
    const record = previous.get(unit.unit);
    if (
      record !== undefined &&
      record.file === unit.file &&
      record.sha256 === unit.sha256 &&
      record.rows === unit.rows
    ) {
      if (record.state === "confirmed") preserved += 1;
      return { ...record };
    }
    return {
      unit: unit.unit,
      file: unit.file,
      sha256: unit.sha256,
      rows: unit.rows,
      state: "pending",
      importId: null,
      expiresAt: null,
    };
  });
  return preserved;
}

/**
 * Records questions the server confirmed or already held.
 *
 * `question_key` is the join key, so re-recording a key the server reports with
 * the same ids is a no-op rather than an error: a resume that reconciles a unit
 * an earlier process imported must land on the record that is already there,
 * including the workflow state a later stage may have advanced. The same key
 * with different ids or a different unit is a server state the driver cannot
 * explain, and it stops.
 */
export function addQuestions(checkpoint: Checkpoint, records: readonly QuestionRecord[]): void {
  for (const record of records) {
    const existing = checkpoint.questions.find((candidate) => candidate.key === record.key);
    if (existing === undefined) {
      checkpoint.questions.push({ ...record });
      continue;
    }
    if (existing.questionId !== record.questionId || existing.revisionId !== record.revisionId) {
      throw new DriverError(
        "CHECKPOINT_INVALID",
        `question ${record.key} is already in the checkpoint with different server ids`,
      );
    }
    if (existing.unit !== record.unit) {
      throw new DriverError(
        "CHECKPOINT_INVALID",
        `question ${record.key} is already in the checkpoint for unit ${existing.unit}`,
      );
    }
  }
}

export function findQuestion(checkpoint: Checkpoint, key: string): QuestionRecord {
  const record = checkpoint.questions.find((candidate) => candidate.key === key);
  if (!record) {
    throw new DriverError("CHECKPOINT_INVALID", `question ${key} is not in the checkpoint`);
  }
  return record;
}

export function setQuestionState(
  checkpoint: Checkpoint,
  key: string,
  next: QuestionState,
  patch: Partial<Pick<QuestionRecord, "questionId" | "revisionId" | "pointerVersion" | "inFlight">> = {},
): QuestionRecord {
  const record = findQuestion(checkpoint, key);
  if (next !== record.state && !QUESTION_TRANSITIONS[record.state].includes(next)) {
    throw new DriverError(
      "TRANSITION_INVALID",
      `question ${key} cannot move from ${record.state} to ${next}`,
    );
  }
  record.state = next;
  if (patch.questionId !== undefined) record.questionId = patch.questionId;
  if (patch.revisionId !== undefined) record.revisionId = patch.revisionId;
  if (patch.pointerVersion !== undefined) record.pointerVersion = patch.pointerVersion;
  if (patch.inFlight !== undefined) record.inFlight = patch.inFlight;
  return record;
}

const QUESTION_STATE_ORDER: readonly QuestionState[] = [
  "pending",
  "draft",
  "submitted",
  "approved",
  "published",
];

/**
 * Adopts the server's observed workflow state after a lost response. The
 * observed state may be ahead of the checkpoint (a call landed before the
 * crash) but never behind it; going backwards would mean the server forgot a
 * transition, which is not something the driver can explain.
 */
export function alignQuestionState(
  checkpoint: Checkpoint,
  key: string,
  observed: QuestionState,
  patch: Partial<Pick<QuestionRecord, "pointerVersion" | "inFlight">> = {},
): QuestionRecord {
  const record = findQuestion(checkpoint, key);
  if (QUESTION_STATE_ORDER.indexOf(observed) < QUESTION_STATE_ORDER.indexOf(record.state)) {
    throw new DriverError(
      "WORKFLOW_CONFLICT",
      `question ${key} is ${observed} on the server but ${record.state} in the checkpoint`,
    );
  }
  record.state = observed;
  if (patch.pointerVersion !== undefined) record.pointerVersion = patch.pointerVersion;
  if (patch.inFlight !== undefined) record.inFlight = patch.inFlight;
  return record;
}

export function setInFlight(
  checkpoint: Checkpoint,
  key: string,
  action: InFlightAction | null,
): void {
  findQuestion(checkpoint, key).inFlight = action;
}

export function recordFailure(
  checkpoint: Checkpoint,
  failure: { code: string; status?: number; requestId?: string },
): void {
  checkpoint.lastError = {
    code: failure.code,
    status: failure.status ?? null,
    requestId: failure.requestId ?? null,
  };
}

export function noteServerError(checkpoint: Checkpoint): void {
  checkpoint.counters.http5xx += 1;
}

export function noteConflict(checkpoint: Checkpoint): void {
  checkpoint.counters.conflicts += 1;
}

export function noteRecovery(checkpoint: Checkpoint): void {
  checkpoint.counters.recoveries += 1;
}

/** Units in scope for `--unit-limit`: a prefix of the run, never a skip. */
export function unitsInScope(checkpoint: Checkpoint, unitLimit: number | null): UnitRecord[] {
  if (unitLimit === null) return checkpoint.units;
  return checkpoint.units.filter((unit) => unit.unit <= unitLimit);
}

export function assertUnitLimit(unitLimit: number | null, unitCount: number): void {
  if (unitLimit === null) return;
  if (!Number.isInteger(unitLimit) || unitLimit < 1 || unitLimit > unitCount) {
    throw new DriverError(
      "UNIT_LIMIT_INVALID",
      `--unit-limit must be an integer from 1 to ${unitCount}`,
    );
  }
}
