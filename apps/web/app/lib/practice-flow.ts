import {
  createPracticeDemoState,
  demoQuestions,
  updatePracticeDemo,
  type PracticeDemoAction,
  type PracticeDemoState,
} from "./prototype-data";

export interface PracticeFlowState {
  session: PracticeDemoState;
  screen: "practice" | "results";
  reviewQuestionIndex: number | null;
}

export type PracticeFlowAction =
  | PracticeDemoAction
  | { type: "view-results" }
  | { type: "review-question"; questionIndex: number }
  | { type: "return-to-results" }
  | { type: "stay-in-practice" };

export function createPracticeFlowState(
  session: PracticeDemoState = createPracticeDemoState(),
): PracticeFlowState {
  return { session, screen: "practice", reviewQuestionIndex: null };
}

export function isPracticeComplete(session: PracticeDemoState) {
  return demoQuestions.every((question) =>
    session.submittedQuestions.includes(question.id),
  );
}

export function interactWithPractice(
  state: PracticeFlowState,
  action: PracticeFlowAction,
): PracticeFlowState {
  if (action.type === "stay-in-practice") {
    return state;
  }

  if (action.type === "view-results") {
    return isPracticeComplete(state.session)
      ? { ...state, screen: "results", reviewQuestionIndex: null }
      : state;
  }

  if (action.type === "review-question") {
    if (
      state.screen !== "results" ||
      !Number.isInteger(action.questionIndex) ||
      action.questionIndex < 0 ||
      action.questionIndex >= demoQuestions.length ||
      !state.session.submittedQuestions.includes(
        demoQuestions[action.questionIndex].id,
      )
    ) {
      return state;
    }

    return {
      ...state,
      screen: "practice",
      reviewQuestionIndex: action.questionIndex,
    };
  }

  if (action.type === "return-to-results") {
    return state.reviewQuestionIndex === null
      ? state
      : { ...state, screen: "results", reviewQuestionIndex: null };
  }

  if (state.reviewQuestionIndex !== null) {
    if (action.type === "previous") {
      return {
        ...state,
        reviewQuestionIndex: Math.max(state.reviewQuestionIndex - 1, 0),
      };
    }

    if (action.type === "next") {
      return {
        ...state,
        reviewQuestionIndex: Math.min(
          state.reviewQuestionIndex + 1,
          demoQuestions.length - 1,
        ),
      };
    }

    return state;
  }

  return {
    ...state,
    session: updatePracticeDemo(state.session, action),
  };
}

export type PracticePresentation =
  | {
      screen: "results";
      correctCount: number;
    }
  | {
      screen: "question" | "review";
      questionIndex: number;
      submitted: boolean;
      selectedAnswer: number | null;
      canViewResults: boolean;
    };

export function getPracticePresentation(
  state: PracticeFlowState,
): PracticePresentation {
  if (state.screen === "results") {
    return {
      screen: "results",
      correctCount: state.session.answers.filter(
        (answer, index) => answer === demoQuestions[index].correctIndex,
      ).length,
    };
  }

  const questionIndex = state.reviewQuestionIndex ?? state.session.questionIndex;
  const question = demoQuestions[questionIndex];
  const submitted = state.session.submittedQuestions.includes(question.id);

  return {
    screen: state.reviewQuestionIndex === null ? "question" : "review",
    questionIndex,
    submitted,
    selectedAnswer:
      state.reviewQuestionIndex === null && !submitted
        ? state.session.selectedAnswer
        : state.session.answers[questionIndex],
    canViewResults:
      state.reviewQuestionIndex === null && isPracticeComplete(state.session),
  };
}
