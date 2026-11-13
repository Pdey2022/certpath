import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  answerDemoMock,
  demoMockDurationMs,
  demoMockStorageKey,
  formatRemaining,
  moveDemoMock,
  parseDemoMock,
  remainingMs,
  scoreDemoMock,
  settleDemoMock,
  startDemoMock,
  submitDemoMock,
  type DemoMockExam,
  type DemoMockAttempt,
} from "../lib/demo-mock";
import { demoQuestions } from "../lib/prototype-data";

const letters = ["A", "B", "C", "D", "E", "F"];

function load(storageKey: string): DemoMockAttempt | null {
  try {
    const attempt = parseDemoMock(window.localStorage.getItem(storageKey));
    return attempt ? settleDemoMock(attempt, Date.now()) : null;
  } catch {
    return null;
  }
}

export function DemoTimedMock({
  exam,
  leaveTo,
}: {
  exam: DemoMockExam;
  leaveTo: string;
}) {
  const storageKey = demoMockStorageKey(exam);
  const [mockState, setMockState] = useState<{
    storageKey: string;
    attempt: DemoMockAttempt | null | undefined;
  }>({ storageKey: "", attempt: undefined });
  const attempt = mockState.storageKey === storageKey ? mockState.attempt : undefined;
  const [now, setNow] = useState(() => Date.now());
  const [storageError, setStorageError] = useState(false);

  function update(next: DemoMockAttempt | null) {
    setMockState({ storageKey, attempt: next });
    try {
      if (next) window.localStorage.setItem(storageKey, JSON.stringify(next));
      else window.localStorage.removeItem(storageKey);
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }

  useEffect(() => {
    const loaded = load(storageKey);
    setMockState({ storageKey, attempt: loaded });
    setNow(Date.now());
    setStorageError(false);
    if (loaded) {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(loaded));
      } catch {
        setStorageError(true);
      }
    }
  }, [storageKey]);

  const inProgress = attempt?.status === "in-progress";
  useEffect(() => {
    if (!inProgress) return;
    const tick = () => {
      const time = Date.now();
      setNow(time);
      setMockState((current) => {
        if (current.storageKey !== storageKey || !current.attempt) return current;
        const settled = settleDemoMock(current.attempt, time);
        if (settled !== current.attempt) {
          try {
            window.localStorage.setItem(storageKey, JSON.stringify(settled));
          } catch {
            setStorageError(true);
          }
        }
        return { storageKey, attempt: settled };
      });
    };
    tick();
    const id = window.setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [inProgress, storageKey]);

  if (attempt === undefined) {
    return (
      <section className="card" aria-busy="true">
        <p role="status">Checking this browser for a saved mock attempt…</p>
      </section>
    );
  }

  if (attempt === null) {
    return (
      <section className="card setup-card">
        <p className="eyebrow">Timed mock · synthetic sample</p>
        <h2>Ready to start?</h2>
        <p>
          {demoQuestions.length} original sample questions in {Math.round(demoMockDurationMs / 60000)} minutes.
          The countdown keeps running if you refresh or leave, and the attempt is saved in this
          browser only.
        </p>
        <div className="button-row">
          <button className="button-primary" type="button" onClick={() => update(startDemoMock(Date.now()))}>
            Start timed mock
          </button>
          <Link className="button-secondary" to={leaveTo}>
            Back to instructions
          </Link>
        </div>
      </section>
    );
  }

  if (attempt.status === "submitted") {
    const score = scoreDemoMock(attempt);
    const percent = Math.round((score.correct / score.total) * 100);
    return (
      <section className="card" aria-labelledby="mock-results-title">
        <p className="eyebrow">Mock results · synthetic sample · not an official exam result</p>
        <h2 id="mock-results-title">
          Score: {score.correct} of {score.total} ({percent}%)
        </h2>
        <p role="status">
          {attempt.submitReason === "expired"
            ? "Time expired, so your saved answers were submitted automatically."
            : "You submitted this mock."}{" "}
          {score.answered} of {score.total} answered.
        </p>
        {demoQuestions.map((question, index) => {
          const chosen = attempt.answers[index];
          const correct = chosen === question.correctIndex;
          return (
            <article className="question-card" key={question.id}>
              <p className="eyebrow">
                Question {index + 1} · {question.domain} ·{" "}
                {chosen === null ? "Unanswered" : correct ? "Correct" : "Incorrect"}
              </p>
              <h3>{question.stem}</h3>
              <ul>
                {question.options.map((option, optionIndex) => (
                  <li key={option}>
                    <strong>
                      {letters[optionIndex]}.{" "}
                      {optionIndex === question.correctIndex ? "Correct answer" : optionIndex === chosen ? "Your answer" : "Option"}
                      :
                    </strong>{" "}
                    {option}
                    <br />
                    <span className="muted">{question.explanations[optionIndex]}</span>
                  </li>
                ))}
              </ul>
              <p className="muted">{question.reference}</p>
            </article>
          );
        })}
        <div className="button-row">
          <button className="button-primary" type="button" onClick={() => update(null)}>
            Start a new mock
          </button>
          <Link className="button-secondary" to={leaveTo}>
            Back to instructions
          </Link>
        </div>
      </section>
    );
  }

  const question = demoQuestions[attempt.questionIndex];
  const remaining = remainingMs(attempt, now);
  const answered = attempt.answers.filter((answer) => answer !== null).length;
  const lastQuestion = attempt.questionIndex === demoQuestions.length - 1;

  return (
    <section className="card" aria-labelledby="mock-question-title">
      <p className="eyebrow">Timed mock · synthetic sample · saved in this browser</p>
      <p>
        <strong role="timer" aria-live="off">
          {formatRemaining(remaining)} remaining
        </strong>{" "}
        · Question {attempt.questionIndex + 1} of {demoQuestions.length} · {answered} answered
      </p>
      {storageError && (
        <p className="form-errors" role="alert">
          This browser could not save the attempt. Keep this tab open; a refresh may lose progress.
        </p>
      )}
      <article className="question-card">
        <h2 id="mock-question-title">{question.stem}</h2>
        <fieldset>
          <legend>Select one answer</legend>
          {question.options.map((option, optionIndex) => (
            <label className="answer-option" key={option}>
              <input
                type="radio"
                name={`mock-${question.id}`}
                checked={attempt.answers[attempt.questionIndex] === optionIndex}
                onChange={() => update(answerDemoMock(attempt, attempt.questionIndex, optionIndex))}
              />
              <span>{option}</span>
            </label>
          ))}
        </fieldset>
      </article>
      <div className="button-row">
        <button
          className="button-secondary"
          type="button"
          disabled={attempt.questionIndex === 0}
          onClick={() => update(moveDemoMock(attempt, attempt.questionIndex - 1))}
        >
          Previous
        </button>
        {!lastQuestion && (
          <button
            className="button-secondary"
            type="button"
            onClick={() => update(moveDemoMock(attempt, attempt.questionIndex + 1))}
          >
            Next
          </button>
        )}
        <button
          className="button-primary"
          type="button"
          onClick={() => {
            if (
              answered === demoQuestions.length ||
              window.confirm(`Submit with ${demoQuestions.length - answered} unanswered?`)
            ) {
              update(submitDemoMock(attempt, Date.now(), "manual"));
            }
          }}
        >
          Submit mock
        </button>
        <Link className="button-secondary" to={leaveTo}>
          Leave (timer keeps running)
        </Link>
      </div>
    </section>
  );
}
