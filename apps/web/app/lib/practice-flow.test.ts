import assert from "node:assert/strict";
import test from "node:test";

import {
  createPracticeFlowState,
  getPracticePresentation,
  interactWithPractice,
} from "./practice-flow";
import {
  demoQuestions,
  parsePracticeDemoState,
  savePracticeDemo,
} from "./prototype-data";

test("final submission keeps its explanation until results are requested", () => {
  let flow = createPracticeFlowState();

  for (let questionIndex = 0; questionIndex < demoQuestions.length; questionIndex += 1) {
    flow = interactWithPractice(flow, {
      type: "select",
      answerIndex: demoQuestions[questionIndex].correctIndex,
    });
    const pending = getPracticePresentation(flow);
    assert.ok(pending.screen === "question");
    assert.equal(pending.selectedAnswer, demoQuestions[questionIndex].correctIndex);
    flow = interactWithPractice(flow, { type: "submit" });

    const presentation = getPracticePresentation(flow);
    assert.ok(presentation.screen === "question");
    assert.equal(presentation.submitted, true);
    assert.equal(presentation.questionIndex, questionIndex);

    if (questionIndex < demoQuestions.length - 1) {
      flow = interactWithPractice(flow, { type: "next" });
    }
  }

  const finalExplanation = getPracticePresentation(flow);
  assert.ok(finalExplanation.screen === "question");
  assert.equal(finalExplanation.canViewResults, true);
  assert.equal(
    interactWithPractice(flow, { type: "view-results" }).screen,
    "results",
  );
});

test("results expose answered questions as read-only reviews", () => {
  let flow = createPracticeFlowState();

  for (const question of demoQuestions) {
    flow = interactWithPractice(flow, {
      type: "select",
      answerIndex: question.correctIndex,
    });
    flow = interactWithPractice(flow, { type: "submit" });
    if (question.id !== demoQuestions.at(-1)?.id) {
      flow = interactWithPractice(flow, { type: "next" });
    }
  }

  flow = interactWithPractice(flow, { type: "view-results" });
  for (let questionIndex = 0; questionIndex < demoQuestions.length; questionIndex += 1) {
    const review = interactWithPractice(flow, {
      type: "review-question",
      questionIndex,
    });
    const presentation = getPracticePresentation(review);
    assert.ok(presentation.screen === "review");
    assert.equal(presentation.questionIndex, questionIndex);
    assert.equal(presentation.submitted, true);

    const unchanged = interactWithPractice(review, {
      type: "select",
      answerIndex: (demoQuestions[questionIndex].correctIndex + 1) %
        demoQuestions[questionIndex].options.length,
    });
    assert.equal(unchanged, review);
    flow = interactWithPractice(review, { type: "return-to-results" });
    assert.equal(flow.screen, "results");
  }
});

test("staying after a failed save retains the unsaved answer for retry", () => {
  let flow = createPracticeFlowState();
  flow = interactWithPractice(flow, { type: "select", answerIndex: 1 });
  const unsavedFlow = flow;
  const failingStorage = {
    read: () => null,
    write: () => {
      throw new Error("Storage is unavailable.");
    },
    clear: () => {},
  };

  assert.throws(() => savePracticeDemo(flow.session, failingStorage), {
    message: "Storage is unavailable.",
  });
  flow = interactWithPractice(flow, { type: "stay-in-practice" });

  assert.equal(flow, unsavedFlow);
  assert.equal(getPracticePresentation(flow).screen, "question");
  assert.equal(flow.session.selectedAnswer, 1);

  let serialized = "";
  savePracticeDemo(flow.session, {
    read: () => serialized || null,
    write: (value) => {
      serialized = value;
    },
    clear: () => {
      serialized = "";
    },
  });
  assert.deepEqual(parsePracticeDemoState(serialized)?.selectedAnswer, 1);
});
