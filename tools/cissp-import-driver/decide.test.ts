import assert from "node:assert/strict";
import test from "node:test";
import { decideConfirm, decideNextStep, mapWorkflowState } from "./decide.ts";

const IDS = [
  { key: "cissp-1", questionId: "q1", revisionId: "r1" },
  { key: "cissp-2", questionId: "q2", revisionId: "r2" },
];

test("a 2xx confirm is accepted without a reconciliation read", () => {
  assert.deepEqual(
    decideConfirm({
      outcome: "ok",
      observation: { kind: "none" },
      previewExpired: false,
      retried: false,
    }),
    { action: "accept" },
  );
});

test("all keys present is adopted, whatever the status code said", () => {
  for (const retried of [false, true]) {
    assert.deepEqual(
      decideConfirm({
        outcome: "ambiguous",
        observation: { kind: "all", ids: IDS },
        previewExpired: false,
        retried,
      }),
      { action: "adopt", ids: IDS },
    );
  }
});

test("some but not all keys stops the run and never records the unit as confirmed", () => {
  const decision = decideConfirm({
    outcome: "ambiguous",
    observation: { kind: "some", presentKeys: ["cissp-1"], missingKeys: ["cissp-2"] },
    previewExpired: false,
    retried: false,
  });
  assert.equal(decision.action, "stop");
  assert.equal(decision.action === "stop" ? decision.code : "", "PARTIAL_IMPORT");
});

test("no keys and an unexpired preview retries the same import once, then stops", () => {
  assert.deepEqual(
    decideConfirm({
      outcome: "ambiguous",
      observation: { kind: "none" },
      previewExpired: false,
      retried: false,
    }),
    { action: "retry" },
  );
  const second = decideConfirm({
    outcome: "ambiguous",
    observation: { kind: "none" },
    previewExpired: false,
    retried: true,
  });
  assert.equal(second.action, "stop");
  assert.equal(second.action === "stop" ? second.code : "", "CONFIRM_FAILED");
});

test("no keys and an expired preview re-previews the same bytes", () => {
  assert.deepEqual(
    decideConfirm({
      outcome: "ambiguous",
      observation: { kind: "none" },
      previewExpired: true,
      retried: true,
    }),
    { action: "re-preview" },
  );
});

test("the publish chain follows draft -> submitted -> approved -> publish", () => {
  assert.deepEqual(decideNextStep({ workflowState: "draft", publication: null, ourRevisionId: "r1" }), {
    action: "submit",
  });
  assert.deepEqual(decideNextStep({ workflowState: "submitted", publication: null, ourRevisionId: "r1" }), {
    action: "review",
  });
  assert.deepEqual(decideNextStep({ workflowState: "approved", publication: null, ourRevisionId: "r1" }), {
    action: "publish",
  });
  assert.deepEqual(
    decideNextStep({
      workflowState: "published",
      publication: { revisionId: "r1", state: "published", pointerVersion: 2 },
      ourRevisionId: "r1",
    }),
    { action: "done", pointerVersion: 2 },
  );
});

test("any publication that is not ours stops the run", () => {
  const decision = decideNextStep({
    workflowState: "approved",
    publication: { revisionId: "other", state: "published", pointerVersion: 1 },
    ourRevisionId: "r1",
  });
  assert.equal(decision.action, "stop");
  assert.equal(decision.action === "stop" ? decision.code : "", "PUBLICATION_CONFLICT");
});

test("a retired publication of our own revision is not republished", () => {
  const decision = decideNextStep({
    workflowState: "published",
    publication: { revisionId: "r1", state: "retired", pointerVersion: 3 },
    ourRevisionId: "r1",
  });
  assert.equal(decision.action, "stop");
});

test("rejected and unknown workflow states are never silently approved", () => {
  for (const state of ["rejected", "superseded", "retired", "unknown"] as const) {
    const decision = decideNextStep({ workflowState: state, publication: null, ourRevisionId: "r1" });
    assert.equal(decision.action, "stop");
  }
  assert.equal(mapWorkflowState("something-else"), "unknown");
  assert.equal(mapWorkflowState(undefined), "unknown");
});
