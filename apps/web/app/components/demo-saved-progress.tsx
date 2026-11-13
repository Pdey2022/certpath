import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  demoAdaptiveMockStorageKey,
  parseDemoAdaptiveMock,
  scoreDemoAdaptiveMock,
  type DemoAdaptiveMockAttempt,
} from "../lib/demo-adaptive-mock";
import {
  demoMockStorageKey,
  loadDemoMockAttempt,
  scoreDemoMock,
  type DemoMockAttempt,
  type DemoMockExam,
} from "../lib/demo-mock";
import {
  demoQuestions,
  parsePracticeDemoState,
  practiceDemoStorageKey,
  type PracticeDemoState,
} from "../lib/prototype-data";

const exams: { id: DemoMockExam; label: string }[] = [
  { id: "cissp", label: "CISSP" },
  { id: "cism", label: "CISM" },
];

interface SavedValue<T> {
  attempt: T | null;
  error: boolean;
}

interface ExamProgress {
  timedMock: SavedValue<DemoMockAttempt>;
  proMock: SavedValue<DemoAdaptiveMockAttempt>;
}

interface SavedProgress {
  practice: SavedValue<PracticeDemoState> | undefined;
  exams: Record<DemoMockExam, ExamProgress | undefined>;
}

function PracticeProgress({ saved }: { saved: SavedValue<PracticeDemoState> | undefined }) {
  return (
    <article className="card">
      <h3>Shared practice · exam not labelled</h3>
      {saved === undefined ? (
        <p role="status">Checking this browser for saved practice…</p>
      ) : saved.error ? (
        <p role="alert">This browser could not read the saved practice progress.</p>
      ) : saved.attempt ? (
        <>
          <p>
            Saved progress · Question {saved.attempt.questionIndex + 1} of{" "}
            {demoQuestions.length} ·{" "}
            {saved.attempt.answers.filter((answer) => answer !== null).length} answered
          </p>
          <Link className="button-primary" to="/app/practice/session">
            Resume practice
          </Link>
        </>
      ) : (
        <>
          <p>No valid shared practice save in this browser.</p>
          <Link className="button-secondary" to="/app/practice/setup">
            Start practice
          </Link>
        </>
      )}
    </article>
  );
}

function TimedMockProgress({
  exam,
  label,
  saved,
}: {
  exam: DemoMockExam;
  label: string;
  saved: ExamProgress | undefined;
}) {
  const attempt = saved?.timedMock.attempt;
  const basePath = `/app/exams/${exam}/mock`;

  return (
    <article className="card">
      <h3>{label} timed mock</h3>
      {saved === undefined ? (
        <p role="status">Checking this browser for the saved timed mock…</p>
      ) : saved.timedMock.error && !attempt ? (
        <p role="alert">This browser could not read the saved timed mock.</p>
      ) : attempt?.status === "in-progress" ? (
        <>
          <p>
            Active attempt · Question {attempt.questionIndex + 1} of{" "}
            {demoQuestions.length} ·{" "}
            {attempt.answers.filter((answer) => answer !== null).length} answered
          </p>
          {saved.timedMock.error && (
            <p role="alert">The expired timed mock could not be updated in this browser.</p>
          )}
          <Link className="button-primary" to={`${basePath}/active`}>
            Resume mock
          </Link>
        </>
      ) : attempt?.status === "submitted" ? (
        <>
          <p>
            Completed result ·{" "}
            {attempt.submitReason === "expired" ? "Time expired" : "Submitted"} ·{" "}
            {scoreDemoMock(attempt).correct} of {demoQuestions.length} correct ·{" "}
            {scoreDemoMock(attempt).answered} answered
          </p>
          {saved.timedMock.error && (
            <p role="alert">This browser could not update the saved timed mock.</p>
          )}
          <Link className="button-primary" to={`${basePath}/active`}>
            View result
          </Link>
        </>
      ) : (
        <>
          <p>No valid saved timed mock in this browser.</p>
          <Link className="button-secondary" to={basePath}>
            Start mock
          </Link>
        </>
      )}
    </article>
  );
}

function ProMockProgress({
  exam,
  label,
  saved,
}: {
  exam: DemoMockExam;
  label: string;
  saved: ExamProgress | undefined;
}) {
  const attempt = saved?.proMock.attempt;
  const setupPath = `/app/exams/${exam}/pro/preview`;
  const sessionPath = `${setupPath}/session`;

  return (
    <article className="card">
      <h3>{label} Pro mock</h3>
      {saved === undefined ? (
        <p role="status">Checking this browser for the saved Pro mock…</p>
      ) : saved.proMock.error && !attempt ? (
        <p role="alert">This browser could not read the saved Pro mock.</p>
      ) : attempt?.status === "in-progress" ? (
        <>
          <p>
            Active attempt · Question {attempt.currentPosition + 1} of{" "}
            {demoQuestions.length} · {attempt.submitted.filter(Boolean).length} answered
          </p>
          <Link className="button-primary" to={sessionPath}>
            Resume Pro mock
          </Link>
        </>
      ) : attempt?.status === "submitted" ? (
        <>
          <p>
            Completed result · {scoreDemoAdaptiveMock(attempt).correct} of{" "}
            {demoQuestions.length} correct
          </p>
          <Link className="button-primary" to={sessionPath}>
            View result
          </Link>
        </>
      ) : (
        <>
          <p>No valid saved Pro mock in this browser.</p>
          <Link className="button-secondary" to={setupPath}>
            Start Pro mock
          </Link>
        </>
      )}
    </article>
  );
}

export function DemoSavedProgress() {
  const [savedProgress, setSavedProgress] = useState<SavedProgress>({
    practice: undefined,
    exams: { cissp: undefined, cism: undefined },
  });

  useEffect(() => {
    let expiryTimer: number | undefined;

    const refresh = () => {
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
      const time = Date.now();
      const next = {} as Record<DemoMockExam, ExamProgress>;
      let nextExpiry: number | undefined;

      let practice: SavedValue<PracticeDemoState>;
      try {
        const serialized = window.localStorage.getItem(practiceDemoStorageKey);
        try {
          practice = { attempt: parsePracticeDemoState(serialized), error: false };
        } catch {
          practice = { attempt: null, error: false };
        }
      } catch {
        practice = { attempt: null, error: true };
      }

      for (const exam of exams) {
        let timedMock: SavedValue<DemoMockAttempt>;
        try {
          const storageKey = demoMockStorageKey(exam.id);
          const serialized = window.localStorage.getItem(storageKey);
          const attempt = loadDemoMockAttempt(serialized, time);
          let error = false;
          if (attempt && JSON.stringify(attempt) !== serialized) {
            try {
              window.localStorage.setItem(storageKey, JSON.stringify(attempt));
            } catch {
              error = true;
            }
          }
          timedMock = { attempt, error };
          if (attempt?.status === "in-progress") {
            const deadline = attempt.startedAt + attempt.durationMs;
            nextExpiry = nextExpiry === undefined ? deadline : Math.min(nextExpiry, deadline);
          }
        } catch {
          timedMock = { attempt: null, error: true };
        }

        let proMock: SavedValue<DemoAdaptiveMockAttempt>;
        try {
          proMock = {
            attempt: parseDemoAdaptiveMock(
              window.localStorage.getItem(demoAdaptiveMockStorageKey(exam.id)),
            ),
            error: false,
          };
        } catch {
          proMock = { attempt: null, error: true };
        }
        next[exam.id] = { timedMock, proMock };
      }

      setSavedProgress({ practice, exams: next });
      if (nextExpiry !== undefined) {
        expiryTimer = window.setTimeout(refresh, Math.max(0, nextExpiry - time));
      }
    };

    refresh();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  return (
    <>
      <section className="section-block" aria-labelledby="shared-practice-progress-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Not assigned to an exam</p>
            <h2 id="shared-practice-progress-title">Shared practice</h2>
          </div>
        </div>
        <div className="card-grid">
          <PracticeProgress saved={savedProgress.practice} />
        </div>
      </section>
      {exams.map((exam) => (
        <section
          className="section-block"
          aria-labelledby={`${exam.id}-saved-progress-title`}
          key={exam.id}
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">Saved in this browser</p>
              <h2 id={`${exam.id}-saved-progress-title`}>{exam.label} progress</h2>
            </div>
          </div>
          <div className="card-grid">
            <TimedMockProgress
              exam={exam.id}
              label={exam.label}
              saved={savedProgress.exams[exam.id]}
            />
            <ProMockProgress
              exam={exam.id}
              label={exam.label}
              saved={savedProgress.exams[exam.id]}
            />
          </div>
        </section>
      ))}
    </>
  );
}
