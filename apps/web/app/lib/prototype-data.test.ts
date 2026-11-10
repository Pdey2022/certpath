import assert from "node:assert/strict";
import test from "node:test";

import {
  addCalendarMonths,
  createPracticeDemoState,
  demoQuestions,
  getProAccessState,
  parsePracticeDemoState,
  proDurationMonths,
  savePracticeDemo,
  updatePracticeDemo,
} from "./prototype-data";

test("Pro eligibility requires same-exam Standard to cover three calendar months", () => {
  assert.equal(proDurationMonths, 3);
  const monthEndStart = new Date("2026-11-30T12:00:00.000Z");
  assert.equal(
    addCalendarMonths(monthEndStart, proDurationMonths).toISOString(),
    "2027-02-28T12:00:00.000Z",
  );
  assert.equal(
    getProAccessState(
      { standardEndsAt: "2027-02-28T12:00:00.000Z" },
      monthEndStart,
    ),
    "eligible",
  );
  assert.equal(
    getProAccessState({ standardEndsAt: "2027-06-30T00:00:00.000Z" }),
    "eligible",
  );
  assert.equal(
    getProAccessState({ standardEndsAt: "2026-12-15T00:00:00.000Z" }),
    "insufficient",
  );
  assert.equal(getProAccessState({ standardEndsAt: null }), "no-standard");
  assert.equal(
    getProAccessState({
      standardEndsAt: "2027-06-30T00:00:00.000Z",
      proStartsAt: "2026-10-10T00:00:00.000Z",
      proEndsAt: "2027-01-10T00:00:00.000Z",
    }),
    "active",
  );
  assert.equal(
    getProAccessState({
      standardEndsAt: "2027-06-30T00:00:00.000Z",
      proStartsAt: "2026-07-10T00:00:00.000Z",
      proEndsAt: "2026-10-10T00:00:00.000Z",
    }),
    "expired",
  );
});

test("practice selection, submission, explanation, bookmark, and resume state", () => {
  let state = createPracticeDemoState();
  state = updatePracticeDemo(state, { type: "select", answerIndex: 0 });
  assert.equal(state.submitted, false);
  state = updatePracticeDemo(state, { type: "submit" });
  assert.equal(state.submitted, true);
  assert.equal(state.answers[0], 0);
  assert.match(demoQuestions[0].explanations[state.answers[0]!], /^Correct\./);
  state = updatePracticeDemo(state, { type: "bookmark" });
  state = updatePracticeDemo(state, { type: "next" });
  assert.equal(state.questionIndex, 1);
  state = updatePracticeDemo(state, { type: "previous" });
  assert.equal(state.questionIndex, 0);
  assert.equal(state.submitted, true);
  assert.deepEqual(state.bookmarks, ["sample-001"]);

  let serialized = "";
  const storage = {
    read: () => serialized || null,
    write: (value: string) => {
      serialized = value;
    },
    clear: () => {
      serialized = "";
    },
  };
  assert.equal(savePracticeDemo(state, storage), true);
  assert.deepEqual(parsePracticeDemoState(storage.read()), state);
});

test("practice save failures remain errors rather than success-shaped saves", () => {
  const storage = {
    read: () => null,
    write: () => {
      throw new Error("Storage is unavailable.");
    },
    clear: () => {},
  };

  assert.throws(() => savePracticeDemo(createPracticeDemoState(), storage), {
    message: "Storage is unavailable.",
  });
});
