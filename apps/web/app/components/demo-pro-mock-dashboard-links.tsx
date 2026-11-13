import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  demoAdaptiveMockStorageKey,
  parseDemoAdaptiveMock,
  scoreDemoAdaptiveMock,
  type DemoAdaptiveMockAttempt,
} from "../lib/demo-adaptive-mock";
import type { DemoMockExam } from "../lib/demo-mock";
import { demoQuestions } from "../lib/prototype-data";

const exams: { id: DemoMockExam; label: string }[] = [
  { id: "cissp", label: "CISSP" },
  { id: "cism", label: "CISM" },
];

interface SavedProMock {
  attempt: DemoAdaptiveMockAttempt | null;
  error: boolean;
}

type SavedProMocks = Record<DemoMockExam, SavedProMock | undefined>;

function ProMockCard({
  exam,
  label,
  saved,
}: {
  exam: DemoMockExam;
  label: string;
  saved: SavedProMock | undefined;
}) {
  const setupPath = `/app/exams/${exam}/pro/preview`;
  const sessionPath = `${setupPath}/session`;
  const attempt = saved?.attempt;

  return (
    <article className="card">
      <h2>{label} Pro mock</h2>
      {saved === undefined ? (
        <p role="status">Checking this browser for a saved Pro mock…</p>
      ) : saved.error && !attempt ? (
        <p role="alert">This browser could not read the saved Pro mock.</p>
      ) : attempt?.status === "in-progress" ? (
        <>
          <p>
            Question {attempt.currentPosition + 1} of {demoQuestions.length} ·{" "}
            {attempt.submitted.filter(Boolean).length} answered
          </p>
          {saved.error && <p role="alert">This browser could not read the saved Pro mock.</p>}
          <Link className="button-primary" to={sessionPath}>
            Resume Pro mock
          </Link>
        </>
      ) : attempt?.status === "submitted" ? (
        <>
          <p>
            Completed · {scoreDemoAdaptiveMock(attempt).correct} of {demoQuestions.length} correct
          </p>
          {saved.error && <p role="alert">This browser could not read the saved result.</p>}
          <Link className="button-primary" to={sessionPath}>
            View result
          </Link>
        </>
      ) : (
        <>
          <p>No valid saved Pro mock in this browser.</p>
          <Link className="button-primary" to={setupPath}>
            Start Pro mock
          </Link>
        </>
      )}
    </article>
  );
}

export function DemoProMockDashboardLinks() {
  const [savedMocks, setSavedMocks] = useState<SavedProMocks>({
    cissp: undefined,
    cism: undefined,
  });

  useEffect(() => {
    const refresh = () => {
      const next = {} as Record<DemoMockExam, SavedProMock>;
      for (const exam of exams) {
        try {
          next[exam.id] = {
            attempt: parseDemoAdaptiveMock(
              window.localStorage.getItem(demoAdaptiveMockStorageKey(exam.id)),
            ),
            error: false,
          };
        } catch {
          next[exam.id] = { attempt: null, error: true };
        }
      }
      setSavedMocks(next);
    };

    refresh();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  return exams.map((exam) => (
    <ProMockCard
      key={exam.id}
      exam={exam.id}
      label={exam.label}
      saved={savedMocks[exam.id]}
    />
  ));
}
