import { demoQuestions } from "./prototype-data";

export const demoMockStorageKey = "certpath-demo-mock-v1";
export const demoMockDurationMs = 3 * 60 * 1000;

export interface DemoMockAttempt {
  version: 1;
  startedAt: number;
  durationMs: number;
  questionIndex: number;
  answers: (number | null)[];
  status: "in-progress" | "submitted";
  submittedAt: number | null;
  submitReason: "manual" | "expired" | null;
}

export function startDemoMock(now: number): DemoMockAttempt {
  return {
    version: 1,
    startedAt: now,
    durationMs: demoMockDurationMs,
    questionIndex: 0,
    answers: demoQuestions.map(() => null),
    status: "in-progress",
    submittedAt: null,
    submitReason: null,
  };
}

export function remainingMs(attempt: DemoMockAttempt, now: number) {
  return Math.max(0, attempt.startedAt + attempt.durationMs - now);
}

export function formatRemaining(ms: number) {
  const seconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function answerDemoMock(
  attempt: DemoMockAttempt,
  questionIndex: number,
  answerIndex: number,
): DemoMockAttempt {
  if (attempt.status !== "in-progress") return attempt;
  const answers = attempt.answers.slice();
  answers[questionIndex] = answerIndex;
  return { ...attempt, answers, questionIndex };
}

export function moveDemoMock(
  attempt: DemoMockAttempt,
  questionIndex: number,
): DemoMockAttempt {
  if (attempt.status !== "in-progress") return attempt;
  const next = Math.min(Math.max(questionIndex, 0), demoQuestions.length - 1);
  return { ...attempt, questionIndex: next };
}

// Submits once; an expired attempt is recorded at its deadline, not at load time.
export function submitDemoMock(
  attempt: DemoMockAttempt,
  now: number,
  reason: "manual" | "expired",
): DemoMockAttempt {
  if (attempt.status === "submitted") return attempt;
  const deadline = attempt.startedAt + attempt.durationMs;
  return {
    ...attempt,
    status: "submitted",
    submittedAt: reason === "expired" ? deadline : Math.min(now, deadline),
    submitReason: reason,
  };
}

// Applies expiry to an in-progress attempt whose deadline has passed.
export function settleDemoMock(
  attempt: DemoMockAttempt,
  now: number,
): DemoMockAttempt {
  return attempt.status === "in-progress" && remainingMs(attempt, now) === 0
    ? submitDemoMock(attempt, now, "expired")
    : attempt;
}

export function scoreDemoMock(attempt: DemoMockAttempt) {
  const correct = attempt.answers.filter(
    (answer, index) => answer === demoQuestions[index].correctIndex,
  ).length;
  const answered = attempt.answers.filter((answer) => answer !== null).length;
  return { correct, answered, total: demoQuestions.length };
}

function isChoice(value: unknown, optionCount: number) {
  return value === null || (Number.isInteger(value) && (value as number) >= 0 && (value as number) < optionCount);
}

export function parseDemoMock(serialized: string | null): DemoMockAttempt | null {
  if (!serialized) return null;
  let value: Partial<DemoMockAttempt>;
  try {
    value = JSON.parse(serialized) as Partial<DemoMockAttempt>;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const optionCount = demoQuestions[0].options.length;
  const valid =
    value.version === 1 &&
    Number.isFinite(value.startedAt) &&
    value.durationMs === demoMockDurationMs &&
    Number.isInteger(value.questionIndex) &&
    (value.questionIndex as number) >= 0 &&
    (value.questionIndex as number) < demoQuestions.length &&
    Array.isArray(value.answers) &&
    value.answers.length === demoQuestions.length &&
    value.answers.every((answer) => isChoice(answer, optionCount)) &&
    (value.status === "in-progress" || value.status === "submitted") &&
    (value.status === "in-progress"
      ? value.submittedAt === null && value.submitReason === null
      : Number.isFinite(value.submittedAt) &&
        (value.submitReason === "manual" || value.submitReason === "expired"));
  return valid ? (value as DemoMockAttempt) : null;
}
