import type { DemoMockExam } from "./demo-mock";
import { demoQuestions } from "./prototype-data";

export function demoAdaptiveMockStorageKey(exam: DemoMockExam) {
  return `certpath-demo-pro-adaptive-mock-${exam}-v1`;
}

export interface DemoAdaptiveMockAttempt {
  version: 1;
  questionIndices: number[];
  currentPosition: number;
  answers: (number | null)[];
  submitted: boolean[];
  status: "in-progress" | "submitted";
}

export function startDemoAdaptiveMock(): DemoAdaptiveMockAttempt {
  return {
    version: 1,
    questionIndices: [0],
    currentPosition: 0,
    answers: [null],
    submitted: [false],
    status: "in-progress",
  };
}

export function selectDemoAdaptiveAnswer(
  attempt: DemoAdaptiveMockAttempt,
  answerIndex: number,
): DemoAdaptiveMockAttempt {
  const position = attempt.currentPosition;
  if (
    attempt.status !== "in-progress" ||
    attempt.submitted[position] ||
    !Number.isInteger(answerIndex) ||
    answerIndex < 0 ||
    answerIndex >= demoQuestions[attempt.questionIndices[position]].options.length
  ) {
    return attempt;
  }
  const answers = attempt.answers.slice();
  answers[position] = answerIndex;
  return { ...attempt, answers };
}

export function submitDemoAdaptiveAnswer(
  attempt: DemoAdaptiveMockAttempt,
): DemoAdaptiveMockAttempt {
  const position = attempt.currentPosition;
  if (
    attempt.status !== "in-progress" ||
    attempt.answers[position] === null ||
    attempt.submitted[position]
  ) {
    return attempt;
  }
  const submitted = attempt.submitted.slice();
  submitted[position] = true;
  const isFinal = position === demoQuestions.length - 1;
  return { ...attempt, submitted, status: isFinal ? "submitted" : "in-progress" };
}

export function nextDemoAdaptiveQuestion(
  attempt: DemoAdaptiveMockAttempt,
): { questionIndex: number; difficulty: (typeof demoQuestions)[number]["difficulty"] } | null {
  const position = attempt.currentPosition;
  if (
    attempt.status !== "in-progress" ||
    !attempt.submitted[position] ||
    position >= demoQuestions.length - 1
  ) {
    return null;
  }
  const currentQuestion = demoQuestions[attempt.questionIndices[position]];
  const correct = attempt.answers[position] === currentQuestion.correctIndex;
  const targetDifficulty = correct ? "Intermediate" : "Foundational";
  const remaining = demoQuestions
    .map((question, questionIndex) => ({ question, questionIndex }))
    .filter(({ questionIndex }) => !attempt.questionIndices.includes(questionIndex));
  const next =
    remaining.find(({ question }) => question.difficulty === targetDifficulty) ??
    remaining[0];
  return next
    ? { questionIndex: next.questionIndex, difficulty: next.question.difficulty }
    : null;
}

export function advanceDemoAdaptiveMock(
  attempt: DemoAdaptiveMockAttempt,
): DemoAdaptiveMockAttempt {
  const next = nextDemoAdaptiveQuestion(attempt);
  if (!next) return attempt;
  return {
    ...attempt,
    questionIndices: [...attempt.questionIndices, next.questionIndex],
    currentPosition: attempt.currentPosition + 1,
    answers: [...attempt.answers, null],
    submitted: [...attempt.submitted, false],
  };
}

export function scoreDemoAdaptiveMock(attempt: DemoAdaptiveMockAttempt) {
  const correct = attempt.answers.filter(
    (answer, position) =>
      answer === demoQuestions[attempt.questionIndices[position]].correctIndex,
  ).length;
  return { correct, total: attempt.questionIndices.length };
}

function isAnswer(value: unknown, optionCount: number) {
  return value === null ||
    (Number.isInteger(value) &&
      (value as number) >= 0 &&
      (value as number) < optionCount);
}

function isQuestionIndices(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every(
      (index: unknown) =>
        Number.isInteger(index) && (index as number) >= 0 && (index as number) < demoQuestions.length,
    )
  );
}

function isAnswers(value: unknown): value is (number | null)[] {
  return (
    Array.isArray(value) &&
    value.every((answer: unknown) => isAnswer(answer, demoQuestions[0].options.length))
  );
}

function isSubmittedFlags(value: unknown): value is boolean[] {
  return Array.isArray(value) && value.every((submitted: unknown) => typeof submitted === "boolean");
}

export function parseDemoAdaptiveMock(
  serialized: string | null,
): DemoAdaptiveMockAttempt | null {
  if (!serialized) return null;
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const questionIndices = record.questionIndices;
  const answers = record.answers;
  const submitted = record.submitted;
  const currentPosition = record.currentPosition;
  const status = record.status;
  if (
    record.version !== 1 ||
    !isQuestionIndices(questionIndices) ||
    questionIndices.length === 0 ||
    questionIndices.length > demoQuestions.length ||
    new Set(questionIndices).size !== questionIndices.length ||
    typeof currentPosition !== "number" ||
    !Number.isInteger(currentPosition) ||
    currentPosition !== questionIndices.length - 1 ||
    !isAnswers(answers) ||
    answers.length !== questionIndices.length ||
    !isSubmittedFlags(submitted) ||
    submitted.length !== questionIndices.length ||
    (status !== "in-progress" && status !== "submitted")
  ) {
    return null;
  }
  const priorAnswersLocked = submitted
    .slice(0, -1)
    .every((isSubmitted, index) => isSubmitted && answers[index] !== null);
  const currentAnswerValid = submitted[currentPosition]
    ? answers[currentPosition] !== null
    : true;
  const finalStateValid =
    status !== "submitted" ||
    (questionIndices.length === demoQuestions.length &&
      submitted.every(Boolean) &&
      answers.every((answer) => answer !== null));
  return priorAnswersLocked && currentAnswerValid && finalStateValid
    ? {
        version: 1,
        questionIndices,
        currentPosition,
        answers,
        submitted,
        status,
      }
    : null;
}
