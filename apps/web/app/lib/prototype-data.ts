export type ProAccessState =
  | "no-standard"
  | "eligible"
  | "insufficient"
  | "active"
  | "expired";

export interface DemoEntitlement {
  standardEndsAt: string | null;
  proStartsAt?: string;
  proEndsAt?: string;
}

export const demoToday = "2026-11-10T12:00:00.000Z";
export const proDurationMonths = 3;

export function addCalendarMonths(date: Date, months: number) {
  const day = date.getUTCDate();
  const result = new Date(date);
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

export function getProAccessState(
  entitlement: DemoEntitlement,
  now: Date = new Date(demoToday),
): ProAccessState {
  if (!entitlement.standardEndsAt) {
    return "no-standard";
  }

  if (entitlement.proEndsAt) {
    const proEnd = new Date(entitlement.proEndsAt);
    if (proEnd <= now) {
      return "expired";
    }

    if (
      entitlement.proStartsAt &&
      new Date(entitlement.proStartsAt) <= now
    ) {
      return "active";
    }
  }

  return addCalendarMonths(now, proDurationMonths) <=
    new Date(entitlement.standardEndsAt)
    ? "eligible"
    : "insufficient";
}

export interface DemoQuestion {
  id: string;
  domain: string;
  difficulty: "Foundational" | "Intermediate";
  stem: string;
  options: string[];
  correctIndex: number;
  explanations: string[];
  reference: string;
}

export const demoQuestions: DemoQuestion[] = [
  {
    id: "sample-001",
    domain: "Security and Risk Management",
    difficulty: "Foundational",
    stem: "A team is selecting safeguards for a new service. Which action should come first?",
    options: [
      "Identify the information assets and the risks they face",
      "Purchase the most expensive available monitoring tool",
      "Apply the same control set used by a different organization",
      "Document a response only after an incident occurs",
    ],
    correctIndex: 0,
    explanations: [
      "Correct. Understanding assets, threats, and business context helps make safeguards proportionate to risk.",
      "Tool selection before understanding risk can leave important needs unmet.",
      "Controls should be selected for the service's own context rather than copied without assessment.",
      "Preparation before an incident is part of effective risk treatment.",
    ],
    reference: "Illustrative reference: risk assessment and treatment concepts.",
  },
  {
    id: "sample-002",
    domain: "Asset Security",
    difficulty: "Intermediate",
    stem: "An organization retires storage media that held sensitive information. What is the most useful first check?",
    options: [
      "Confirm the approved sanitization method for the media and data class",
      "Rename the volume so it cannot be recognized",
      "Move the media to an unlocked cabinet",
      "Keep a copy of every file on a personal device",
    ],
    correctIndex: 0,
    explanations: [
      "Correct. Sanitization should follow the organization's data classification and media handling policy.",
      "A label change does not remove information from the media.",
      "Physical relocation alone does not sanitize stored data.",
      "Creating an unmanaged copy increases exposure rather than addressing disposal.",
    ],
    reference: "Illustrative reference: information lifecycle and media handling.",
  },
  {
    id: "sample-003",
    domain: "Information Security Governance",
    difficulty: "Foundational",
    stem: "A project owner requests an exception to a security policy. Which response best supports accountable governance?",
    options: [
      "Record the business justification, risk owner, compensating controls, and review date",
      "Approve it verbally and leave no record",
      "Disable the policy for every project",
      "Ask a developer to make the exception without notifying the owner",
    ],
    correctIndex: 0,
    explanations: [
      "Correct. A documented, time-bounded exception makes ownership and residual risk reviewable.",
      "An unrecorded exception prevents consistent oversight.",
      "A single request is not a reason to remove a control organization-wide.",
      "Exceptions require accountable review rather than undocumented implementation.",
    ],
    reference: "Illustrative reference: policy exception and risk ownership concepts.",
  },
];

export interface PracticeDemoState {
  version: 1;
  questionIndex: number;
  selectedAnswer: number | null;
  submitted: boolean;
  answers: (number | null)[];
  submittedQuestions: string[];
  bookmarks: string[];
}

export type PracticeDemoAction =
  | { type: "select"; answerIndex: number }
  | { type: "submit" }
  | { type: "bookmark" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "reset" };

export function createPracticeDemoState(): PracticeDemoState {
  return {
    version: 1,
    questionIndex: 0,
    selectedAnswer: null,
    submitted: false,
    answers: demoQuestions.map(() => null),
    submittedQuestions: [],
    bookmarks: [],
  };
}

export function updatePracticeDemo(
  state: PracticeDemoState,
  action: PracticeDemoAction,
): PracticeDemoState {
  const question = demoQuestions[state.questionIndex];

  switch (action.type) {
    case "select":
      if (state.submitted || action.answerIndex < 0 || action.answerIndex >= question.options.length) {
        return state;
      }
      return { ...state, selectedAnswer: action.answerIndex };
    case "submit":
      if (state.submitted || state.selectedAnswer === null) {
        return state;
      }
      return {
        ...state,
        submitted: true,
        answers: state.answers.map((answer, index) =>
          index === state.questionIndex ? state.selectedAnswer : answer,
        ),
        submittedQuestions: state.submittedQuestions.includes(question.id)
          ? state.submittedQuestions
          : [...state.submittedQuestions, question.id],
      };
    case "bookmark":
      return {
        ...state,
        bookmarks: state.bookmarks.includes(question.id)
          ? state.bookmarks.filter((id) => id !== question.id)
          : [...state.bookmarks, question.id],
      };
    case "next": {
      const questionIndex = Math.min(
        state.questionIndex + 1,
        demoQuestions.length - 1,
      );
      return {
        ...state,
        questionIndex,
        selectedAnswer: state.answers[questionIndex],
        submitted: state.submittedQuestions.includes(
          demoQuestions[questionIndex].id,
        ),
      };
    }
    case "previous": {
      const questionIndex = Math.max(state.questionIndex - 1, 0);
      return {
        ...state,
        questionIndex,
        selectedAnswer: state.answers[questionIndex],
        submitted: state.submittedQuestions.includes(
          demoQuestions[questionIndex].id,
        ),
      };
    }
    case "reset":
      return createPracticeDemoState();
  }
}

export function parsePracticeDemoState(
  serialized: string | null,
): PracticeDemoState | null {
  if (!serialized) {
    return null;
  }

  const candidate: unknown = JSON.parse(serialized);
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Saved demo practice data is not an object.");
  }

  const value = candidate as Partial<PracticeDemoState>;
  if (
    value.version !== 1 ||
    !Number.isInteger(value.questionIndex) ||
    (value.questionIndex as number) < 0 ||
    (value.questionIndex as number) >= demoQuestions.length ||
    !Array.isArray(value.answers) ||
    value.answers.length !== demoQuestions.length ||
    value.answers.some(
      (answer) =>
        answer !== null &&
        (!Number.isInteger(answer) ||
          answer < 0 ||
          answer >= demoQuestions[0].options.length),
    ) ||
    !Array.isArray(value.submittedQuestions) ||
    !value.submittedQuestions.every((id) => typeof id === "string") ||
    !Array.isArray(value.bookmarks) ||
    !value.bookmarks.every((id) => typeof id === "string") ||
    typeof value.submitted !== "boolean" ||
    (value.selectedAnswer !== null &&
      (!Number.isInteger(value.selectedAnswer) ||
        (value.selectedAnswer as number) < 0 ||
        (value.selectedAnswer as number) >= demoQuestions[0].options.length))
  ) {
    throw new Error("Saved demo practice data is invalid.");
  }

  return value as PracticeDemoState;
}

export interface PracticeDemoStorage {
  read(): string | null;
  write(value: string): void;
  clear(): void;
}

export function savePracticeDemo(
  state: PracticeDemoState,
  storage: PracticeDemoStorage,
): boolean {
  storage.write(JSON.stringify(state));
  return true;
}
