import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceDemoAdaptiveMock,
  demoAdaptiveMockStorageKey,
  nextDemoAdaptiveQuestion,
  parseDemoAdaptiveMock,
  scoreDemoAdaptiveMock,
  selectDemoAdaptiveAnswer,
  startDemoAdaptiveMock,
  submitDemoAdaptiveAnswer,
} from "./demo-adaptive-mock";
import { demoQuestions } from "./prototype-data";

test("the next question difficulty follows the submitted answer", () => {
  const first = startDemoAdaptiveMock();
  const correct = submitDemoAdaptiveAnswer(
    selectDemoAdaptiveAnswer(first, demoQuestions[0].correctIndex),
  );
  assert.equal(nextDemoAdaptiveQuestion(correct)?.difficulty, "Intermediate");
  assert.equal(nextDemoAdaptiveQuestion(correct)?.questionIndex, 1);

  const incorrect = submitDemoAdaptiveAnswer(
    selectDemoAdaptiveAnswer(first, 1),
  );
  assert.equal(nextDemoAdaptiveQuestion(incorrect)?.difficulty, "Foundational");
  assert.equal(nextDemoAdaptiveQuestion(incorrect)?.questionIndex, 2);
});

test("submitted answers are locked, attempts round-trip, and final scoring is stable", () => {
  let attempt = startDemoAdaptiveMock();
  attempt = selectDemoAdaptiveAnswer(attempt, demoQuestions[0].correctIndex);
  attempt = submitDemoAdaptiveAnswer(attempt);
  assert.equal(selectDemoAdaptiveAnswer(attempt, 1), attempt);
  assert.deepEqual(parseDemoAdaptiveMock(JSON.stringify(attempt)), attempt);

  attempt = advanceDemoAdaptiveMock(attempt);
  attempt = selectDemoAdaptiveAnswer(attempt, demoQuestions[1].correctIndex);
  attempt = submitDemoAdaptiveAnswer(attempt);
  attempt = advanceDemoAdaptiveMock(attempt);
  attempt = selectDemoAdaptiveAnswer(attempt, demoQuestions[2].correctIndex);
  attempt = submitDemoAdaptiveAnswer(attempt);

  assert.equal(attempt.status, "submitted");
  assert.deepEqual(scoreDemoAdaptiveMock(attempt), { correct: 3, total: 3 });
  assert.equal(demoAdaptiveMockStorageKey("cissp"), "certpath-demo-pro-adaptive-mock-cissp-v1");
  assert.notEqual(demoAdaptiveMockStorageKey("cissp"), demoAdaptiveMockStorageKey("cism"));
});

test("rejects malformed adaptive attempts", () => {
  const attempt = startDemoAdaptiveMock();
  assert.equal(parseDemoAdaptiveMock("{bad"), null);
  assert.equal(
    parseDemoAdaptiveMock(
      JSON.stringify({ ...attempt, questionIndices: [0, 0], answers: [null, null], submitted: [false, false], currentPosition: 1 }),
    ),
    null,
  );
});
