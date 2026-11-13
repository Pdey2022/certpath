import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  demoMockStorageKey,
  loadDemoMockAttempt,
  scoreDemoMock,
  type DemoMockAttempt,
  type DemoMockExam,
} from "../lib/demo-mock";
import { demoQuestions } from "../lib/prototype-data";

const exams: { id: DemoMockExam; label: string }[] = [
  { id: "cissp", label: "CISSP" },
  { id: "cism", label: "CISM" },
];

interface SavedMock {
  attempt: DemoMockAttempt | null;
  error: boolean;
}

type SavedMocks = Record<DemoMockExam, SavedMock | undefined>;

function MockLinkCard({
  exam,
  label,
  saved,
}: {
  exam: DemoMockExam;
  label: string;
  saved: SavedMock | undefined;
}) {
  const basePath = `/app/exams/${exam}/mock`;
  const attempt = saved?.attempt;

  return (
    <article className="card">
      <h2>{label} timed mock</h2>
      {saved === undefined ? (
        <p role="status">Checking this browser for a saved mock…</p>
      ) : saved.error && !attempt ? (
        <p role="alert">This browser could not read the saved mock.</p>
      ) : attempt?.status === "in-progress" ? (
        <>
          <p>
            Question {attempt.questionIndex + 1} of {demoQuestions.length} ·{" "}
            {attempt.answers.filter((answer) => answer !== null).length} answered
          </p>
          {saved.error && <p role="alert">This browser could not update the saved mock.</p>}
          <Link className="button-primary" to={`${basePath}/active`}>
            Resume mock
          </Link>
        </>
      ) : attempt?.status === "submitted" ? (
        <>
          <p>
            {attempt.submitReason === "expired" ? "Time expired" : "Submitted"} ·{" "}
            {scoreDemoMock(attempt).correct} of {demoQuestions.length} correct
          </p>
          {saved.error && <p role="alert">This browser could not update the saved result.</p>}
          <Link className="button-primary" to={`${basePath}/active`}>
            View result
          </Link>
        </>
      ) : (
        <>
          <p>No valid saved attempt in this browser.</p>
          <Link className="button-primary" to={basePath}>
            Start mock
          </Link>
        </>
      )}
    </article>
  );
}

export function DemoMockDashboardLinks() {
  const [savedMocks, setSavedMocks] = useState<SavedMocks>({
    cissp: undefined,
    cism: undefined,
  });

  useEffect(() => {
    let expiryTimer: number | undefined;
    const refresh = () => {
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
      const time = Date.now();
      const next = {} as Record<DemoMockExam, SavedMock>;
      let nextExpiry: number | undefined;

      for (const exam of exams) {
        const storageKey = demoMockStorageKey(exam.id);
        try {
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
          next[exam.id] = { attempt, error };
          if (attempt?.status === "in-progress") {
            const deadline = attempt.startedAt + attempt.durationMs;
            nextExpiry = nextExpiry === undefined ? deadline : Math.min(nextExpiry, deadline);
          }
        } catch {
          next[exam.id] = { attempt: null, error: true };
        }
      }

      setSavedMocks((current) => {
        const unchanged = exams.every(({ id }) =>
          current[id]?.error === next[id].error &&
          JSON.stringify(current[id]?.attempt) === JSON.stringify(next[id].attempt),
        );
        return unchanged ? current : next;
      });

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

  return exams.map((exam) => (
    <MockLinkCard
      key={exam.id}
      exam={exam.id}
      label={exam.label}
      saved={savedMocks[exam.id]}
    />
  ));
}
