import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  advanceDemoAdaptiveMock,
  demoAdaptiveMockStorageKey,
  nextDemoAdaptiveQuestion,
  parseDemoAdaptiveMock,
  scoreDemoAdaptiveMock,
  selectDemoAdaptiveAnswer,
  startDemoAdaptiveMock,
  submitDemoAdaptiveAnswer,
  type DemoAdaptiveMockAttempt,
} from "../lib/demo-adaptive-mock";
import type { DemoMockExam } from "../lib/demo-mock";
import { demoQuestions } from "../lib/prototype-data";

const letters = ["A", "B", "C", "D", "E", "F"];

function load(storageKey: string): {
  attempt: DemoAdaptiveMockAttempt | null;
  error: boolean;
} {
  try {
    return {
      attempt: parseDemoAdaptiveMock(window.localStorage.getItem(storageKey)),
      error: false,
    };
  } catch {
    return { attempt: null, error: true };
  }
}

export function DemoAdaptiveMock({
  exam,
  leaveTo,
}: {
  exam: DemoMockExam;
  leaveTo: string;
}) {
  const storageKey = demoAdaptiveMockStorageKey(exam);
  const [stored, setStored] = useState<{
    storageKey: string;
    attempt: DemoAdaptiveMockAttempt | null | undefined;
  }>({ storageKey: "", attempt: undefined });
  const attempt = stored.storageKey === storageKey ? stored.attempt : undefined;
  const [storageError, setStorageError] = useState(false);

  function update(next: DemoAdaptiveMockAttempt | null) {
    setStored({ storageKey, attempt: next });
    try {
      if (next) window.localStorage.setItem(storageKey, JSON.stringify(next));
      else window.localStorage.removeItem(storageKey);
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }

  useEffect(() => {
    const saved = load(storageKey);
    setStored({ storageKey, attempt: saved.attempt });
    setStorageError(saved.error);
  }, [storageKey]);

  if (attempt === undefined) {
    return (
      <section className="card" aria-busy="true">
        <p role="status">Checking this browser for a saved CertPath demo attempt…</p>
      </section>
    );
  }

  if (attempt === null) {
    return (
      <section className="card setup-card">
        <p className="eyebrow">CertPath demo · adaptive Pro mock</p>
        <h2>Ready to begin?</h2>
        {storageError && (
          <p className="form-errors" role="alert">
            This browser could not read its saved attempt.
          </p>
        )}
        <p>
          Answer three existing synthetic questions. Each submitted answer guides the difficulty
          of the next available question, and this attempt is saved in this browser for this exam.
        </p>
        <div className="button-row">
          <button
            className="button-primary"
            type="button"
            disabled={storageError}
            onClick={() => update(startDemoAdaptiveMock())}
          >
            Start adaptive mock
          </button>
          <Link className="button-secondary" to={leaveTo}>
            Back to Pro setup
          </Link>
        </div>
      </section>
    );
  }

  if (attempt.status === "submitted") {
    const score = scoreDemoAdaptiveMock(attempt);
    return (
      <section className="card" aria-labelledby="adaptive-mock-results">
        <p className="eyebrow">CertPath demo · adaptive mock results</p>
        <h2 id="adaptive-mock-results">
          Final score: {score.correct} of {score.total}
        </h2>
        <p role="status">This is a synthetic demo result, not an official exam score.</p>
        {storageError && (
          <p className="form-errors" role="alert">
            This browser could not save the result.
          </p>
        )}
        {attempt.questionIndices.map((questionIndex, position) => {
          const question = demoQuestions[questionIndex];
          const chosen = attempt.answers[position];
          return (
            <article className="question-card" key={question.id}>
              <p className="eyebrow">
                Question {position + 1} · {question.difficulty} ·{" "}
                {chosen === question.correctIndex ? "Correct" : "Incorrect"}
              </p>
              <h3>{question.stem}</h3>
              <ul>
                {question.options.map((option, optionIndex) => (
                  <li key={option}>
                    <strong>
                      {letters[optionIndex]}.{" "}
                      {optionIndex === question.correctIndex
                        ? "Correct answer"
                        : optionIndex === chosen
                          ? "Your answer"
                          : "Option"}
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
          <button
            className="button-primary"
            type="button"
            onClick={() => update(startDemoAdaptiveMock())}
          >
            Start a new adaptive mock
          </button>
          <Link className="button-secondary" to={leaveTo}>
            Back to Pro setup
          </Link>
        </div>
      </section>
    );
  }

  const position = attempt.currentPosition;
  const question = demoQuestions[attempt.questionIndices[position]];
  const answer = attempt.answers[position];
  const locked = attempt.submitted[position];
  const next = locked ? nextDemoAdaptiveQuestion(attempt) : null;

  return (
    <section className="card" aria-labelledby="adaptive-mock-question">
      <p className="eyebrow">CertPath demo · adaptive Pro mock · saved in this browser</p>
      <p>
        Question {position + 1} of {demoQuestions.length} · Difficulty: {question.difficulty} ·{" "}
        {attempt.answers.filter((value) => value !== null).length} answered
      </p>
      {storageError && (
        <p className="form-errors" role="alert">
          This browser could not save the attempt. A refresh may lose the latest change.
        </p>
      )}
      <article className="question-card">
        <h2 id="adaptive-mock-question">{question.stem}</h2>
        <fieldset disabled={locked}>
          <legend>Select one answer</legend>
          {question.options.map((option, optionIndex) => (
            <label className="answer-option" key={option}>
              <input
                type="radio"
                name={`adaptive-${exam}-${question.id}`}
                checked={answer === optionIndex}
                onChange={() => update(selectDemoAdaptiveAnswer(attempt, optionIndex))}
              />
              <span>{option}</span>
            </label>
          ))}
        </fieldset>
      </article>
      {locked && answer !== null ? (
        <div>
          <p role="status">
            {answer === question.correctIndex ? "Correct" : "Not correct"}. Your answer is locked.
          </p>
          <p>{question.explanations[answer]}</p>
          {next && <p>Next question difficulty: {next.difficulty}.</p>}
        </div>
      ) : (
        <button
          className="button-primary"
          type="button"
          disabled={answer === null}
          onClick={() => update(submitDemoAdaptiveAnswer(attempt))}
        >
          Submit answer
        </button>
      )}
      {locked && next && (
        <button
          className="button-primary"
          type="button"
          onClick={() => update(advanceDemoAdaptiveMock(attempt))}
        >
          Next question
        </button>
      )}
      <p>
        <Link className="button-secondary" to={leaveTo}>
          Leave adaptive mock
        </Link>
      </p>
    </section>
  );
}
