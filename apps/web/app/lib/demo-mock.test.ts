import assert from "node:assert/strict";
import test from "node:test";
import {
  answerDemoMock,
  demoMockDurationMs,
  formatRemaining,
  parseDemoMock,
  remainingMs,
  scoreDemoMock,
  settleDemoMock,
  startDemoMock,
  submitDemoMock,
} from "./demo-mock";
import { demoQuestions } from "./prototype-data";

test("countdown is derived from the saved start time", () => {
  const attempt = startDemoMock(1_000);
  assert.equal(remainingMs(attempt, 1_000 + 60_000), demoMockDurationMs - 60_000);
  assert.equal(remainingMs(attempt, 1_000 + demoMockDurationMs + 5_000), 0);
  assert.equal(formatRemaining(61_000), "1:01");
});

test("an expired attempt auto-submits at its deadline with the saved answers", () => {
  let attempt = startDemoMock(0);
  attempt = answerDemoMock(attempt, 0, demoQuestions[0].correctIndex);
  const settled = settleDemoMock(attempt, demoMockDurationMs + 99_000);
  assert.equal(settled.status, "submitted");
  assert.equal(settled.submitReason, "expired");
  assert.equal(settled.submittedAt, demoMockDurationMs);
  assert.deepEqual(scoreDemoMock(settled), { correct: 1, answered: 1, total: demoQuestions.length });
  assert.equal(settleDemoMock(attempt, 1_000), attempt);
});

test("submission is final and ignores later answers", () => {
  const submitted = submitDemoMock(startDemoMock(0), 5_000, "manual");
  assert.equal(submitted.submittedAt, 5_000);
  assert.equal(answerDemoMock(submitted, 0, 1), submitted);
  assert.equal(submitDemoMock(submitted, 9_000, "expired"), submitted);
});

test("saved attempts round-trip and invalid data is rejected", () => {
  const attempt = answerDemoMock(startDemoMock(42), 1, 2);
  assert.deepEqual(parseDemoMock(JSON.stringify(attempt)), attempt);
  assert.equal(parseDemoMock("{bad"), null);
  assert.equal(parseDemoMock(JSON.stringify({ ...attempt, answers: [9, null, null] })), null);
  assert.equal(parseDemoMock(JSON.stringify({ ...attempt, status: "submitted" })), null);
  assert.equal(parseDemoMock(null), null);
});
