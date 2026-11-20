import assert from "node:assert/strict";
import test from "node:test";
import {
  alignQuestionState,
  assertCheckpointMatches,
  assertUnitLimit,
  beginStage,
  createCheckpoint,
  finishStage,
  loadCheckpoint,
  saveCheckpoint,
  setQuestionState,
  setUnitState,
  unitsInScope,
  type Checkpoint,
  type CheckpointIo,
} from "./checkpoint.ts";
import { DriverError } from "./errors.ts";

function baseCheckpoint(): Checkpoint {
  const checkpoint = createCheckpoint({
    runId: "run-1",
    now: 1_700_000_000_000,
    target: {
      origin: "http://localhost:5173",
      actorUserId: "user-1",
      certificationId: "cert-1",
      certificationSlug: "synthetic-pilot",
      examVersionKey: "driver-test-v1",
      examVersionId: "version-1",
    },
    inputs: {
      taxonomySha256: "a".repeat(64),
      proseSha256: "b".repeat(64),
      converterManifestSha256: "c".repeat(64),
      uploadManifestSha256: null,
      batchSize: 5,
      converterDeclaredExamVersionId: "cissp-exam-v1",
      unitLimit: null,
    },
  });
  checkpoint.units = [
    { unit: 1, file: "upload-001.csv", sha256: "1".repeat(64), rows: 5, state: "pending", importId: null, expiresAt: null },
    { unit: 2, file: "upload-002.csv", sha256: "2".repeat(64), rows: 5, state: "pending", importId: null, expiresAt: null },
  ];
  checkpoint.questions = [
    {
      key: "cissp-1",
      unit: 1,
      domainKey: "cissp-d1",
      topicKey: "cissp-d1-topic-1",
      questionId: "question-1",
      revisionId: "revision-1",
      state: "draft",
      pointerVersion: null,
      inFlight: null,
    },
  ];
  return checkpoint;
}

function expectCode(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof DriverError, `expected DriverError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("a unit walks pending -> previewing -> previewed -> confirmed", () => {
  const checkpoint = baseCheckpoint();
  setUnitState(checkpoint, 1, "previewing");
  setUnitState(checkpoint, 1, "previewed", { importId: "import-1", expiresAt: 123 });
  setUnitState(checkpoint, 1, "confirmed");
  const unit = checkpoint.units[0]!;
  assert.equal(unit.state, "confirmed");
  assert.equal(unit.importId, "import-1");
});

test("illegal unit transitions are refused", () => {
  const checkpoint = baseCheckpoint();
  expectCode(() => setUnitState(checkpoint, 1, "confirmed"), "TRANSITION_INVALID");
  setUnitState(checkpoint, 1, "previewing");
  setUnitState(checkpoint, 1, "previewed");
  setUnitState(checkpoint, 1, "confirmed");
  expectCode(() => setUnitState(checkpoint, 1, "previewing"), "TRANSITION_INVALID");
});

test("a question may not skip a workflow transition", () => {
  const checkpoint = baseCheckpoint();
  expectCode(() => setQuestionState(checkpoint, "cissp-1", "approved"), "TRANSITION_INVALID");
  setQuestionState(checkpoint, "cissp-1", "submitted");
  setQuestionState(checkpoint, "cissp-1", "approved");
  setQuestionState(checkpoint, "cissp-1", "published", { pointerVersion: 1 });
  assert.equal(checkpoint.questions[0]!.state, "published");
  expectCode(() => setQuestionState(checkpoint, "cissp-1", "approved"), "TRANSITION_INVALID");
});

test("a stage refuses to run before its predecessors are complete", () => {
  const checkpoint = baseCheckpoint();
  expectCode(() => beginStage(checkpoint, "upload"), "STAGE_ORDER");
  beginStage(checkpoint, "taxonomy");
  finishStage(checkpoint, "taxonomy");
  beginStage(checkpoint, "transform");
  finishStage(checkpoint, "transform");
  beginStage(checkpoint, "upload");
  assert.equal(checkpoint.stages.upload, "in-progress");
});

test("a completed upload cannot be restarted, but taxonomy and transform can", () => {
  const checkpoint = baseCheckpoint();
  beginStage(checkpoint, "taxonomy");
  finishStage(checkpoint, "taxonomy");
  beginStage(checkpoint, "transform");
  finishStage(checkpoint, "transform");
  beginStage(checkpoint, "upload");
  finishStage(checkpoint, "upload");
  expectCode(() => beginStage(checkpoint, "upload"), "TRANSITION_INVALID");
  beginStage(checkpoint, "taxonomy");
  assert.equal(checkpoint.stages.taxonomy, "in-progress");
});

test("a checkpoint with a different target or different inputs is refused", () => {
  const checkpoint = baseCheckpoint();
  const expectation = {
    origin: "http://localhost:5173",
    certificationSlug: "synthetic-pilot",
    examVersionKey: "driver-test-v1",
    taxonomySha256: "a".repeat(64),
    proseSha256: "b".repeat(64),
    converterManifestSha256: "c".repeat(64),
    batchSize: 5,
  };
  assertCheckpointMatches(checkpoint, expectation);
  for (const override of [
    { origin: "http://127.0.0.1:5173" },
    { certificationSlug: "cissp" },
    { examVersionKey: "cissp-exam-v1" },
    { proseSha256: "d".repeat(64) },
    { batchSize: 10 },
  ]) {
    expectCode(() => assertCheckpointMatches(checkpoint, { ...expectation, ...override }), "CHECKPOINT_MISMATCH");
  }
});

function memoryIo(files: Map<string, string>): CheckpointIo {
  return {
    exists: (path) => files.has(path),
    read: (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    write: (path, text) => {
      files.set(path, text);
    },
    rename: (from, to) => {
      const value = files.get(from);
      if (value === undefined) throw new Error("missing");
      files.delete(from);
      files.set(to, value);
    },
  };
}

test("the checkpoint is replaced atomically and only after serialisation succeeds", () => {
  const files = new Map<string, string>();
  const io = memoryIo(files);
  const checkpoint = baseCheckpoint();
  saveCheckpoint("/state/checkpoint.json", checkpoint, io, 1);
  const previous = files.get("/state/checkpoint.json")!;
  assert.ok(previous.includes('"runId": "run-1"'));

  const broken = { ...checkpoint, runId: 1n } as unknown as Checkpoint;
  assert.throws(() => saveCheckpoint("/state/checkpoint.json", broken, io, 2));
  assert.equal(files.get("/state/checkpoint.json"), previous);
  assert.equal(files.has("/state/checkpoint.json.tmp"), false);
});

test("a loaded checkpoint with an unknown stage state is refused", () => {
  const files = new Map<string, string>();
  const io = memoryIo(files);
  const checkpoint = baseCheckpoint();
  saveCheckpoint("/state/checkpoint.json", checkpoint, io, 1);
  const text = files.get("/state/checkpoint.json")!;
  files.set("/state/checkpoint.json", text.replace('"taxonomy": "pending"', '"taxonomy": "done"'));
  expectCode(() => loadCheckpoint("/state/checkpoint.json", io), "CHECKPOINT_INVALID");
});

test("an observed state may move forward but never back", () => {
  const checkpoint = baseCheckpoint();
  alignQuestionState(checkpoint, "cissp-1", "approved");
  assert.equal(checkpoint.questions[0]!.state, "approved");
  expectCode(() => alignQuestionState(checkpoint, "cissp-1", "submitted"), "WORKFLOW_CONFLICT");
});

test("a unit limit selects a prefix of the run and refuses a skip", () => {
  const checkpoint = baseCheckpoint();
  assert.deepEqual(
    unitsInScope(checkpoint, 1).map((unit) => unit.unit),
    [1],
  );
  assert.deepEqual(
    unitsInScope(checkpoint, null).map((unit) => unit.unit),
    [1, 2],
  );
  expectCode(() => assertUnitLimit(3, 2), "UNIT_LIMIT_INVALID");
  expectCode(() => assertUnitLimit(0, 2), "UNIT_LIMIT_INVALID");
  assertUnitLimit(2, 2);
});
