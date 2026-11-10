import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";

import {
  createPracticeDemoState,
  demoQuestions,
  parsePracticeDemoState,
  savePracticeDemo,
  updatePracticeDemo,
  type PracticeDemoState,
} from "../lib/prototype-data";

const storageKey = "certpath-demo-practice-v1";

type SaveState = "loading" | "ready" | "saving" | "saved" | "error";

function pauseForDemo() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 350));
}

export function PracticeDemo() {
  const navigate = useNavigate();
  const [session, setSession] = useState(createPracticeDemoState);
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [saveMessage, setSaveMessage] = useState("");
  const [savedAt, setSavedAt] = useState("");
  const [failNextSave, setFailNextSave] = useState(false);

  useEffect(() => {
    try {
      const restored = parsePracticeDemoState(
        window.localStorage.getItem(storageKey),
      );
      if (restored) {
        setSession(restored);
        setSaveState("saved");
        setSaveMessage(
          "Restored from this browser only. This is demo storage, not a server acknowledgement or sync.",
        );
        setSavedAt("Previously saved in this browser");
      } else {
        setSaveState("ready");
      }
    } catch (error) {
      setSaveState("error");
      setSaveMessage(
        error instanceof Error
          ? error.message
          : "Browser demo storage could not be read.",
      );
    }
  }, []);

  async function save(next: PracticeDemoState) {
    setSession(next);
    setSaveState("saving");
    setSaveMessage("Saving this demo session to this browser.");
    await pauseForDemo();

    if (failNextSave) {
      setFailNextSave(false);
      setSaveState("error");
      setSaveMessage("Simulated save failure. Your change is not saved yet.");
      return false;
    }

    try {
      savePracticeDemo(next, {
        read: () => window.localStorage.getItem(storageKey),
        write: (value) => window.localStorage.setItem(storageKey, value),
        clear: () => window.localStorage.removeItem(storageKey),
      });
      setSaveState("saved");
      setSavedAt(new Date().toLocaleTimeString());
      setSaveMessage(
        "Saved in this browser only. No server acknowledgement or cross-device sync.",
      );
      return true;
    } catch (error) {
      setSaveState("error");
      setSaveMessage(
        error instanceof Error
          ? error.message
          : "Browser demo storage is unavailable.",
      );
      return false;
    }
  }

  async function applyAction(
    action: Parameters<typeof updatePracticeDemo>[1],
  ) {
    await save(updatePracticeDemo(session, action));
  }

  async function retrySave() {
    await save(session);
  }

  async function saveAndExit() {
    if (await save(session)) {
      navigate("/app/practice");
    }
  }

  async function resetDemo() {
    try {
      window.localStorage.removeItem(storageKey);
      setFailNextSave(false);
      setSession(createPracticeDemoState());
      setSaveState("ready");
      setSaveMessage("Demo practice progress cleared from this browser.");
      setSavedAt("");
    } catch (error) {
      setSaveState("error");
      setSaveMessage(
        error instanceof Error
          ? error.message
          : "Browser demo storage could not be cleared.",
      );
    }
  }

  const question = demoQuestions[session.questionIndex];
  const completed = session.submittedQuestions.length === demoQuestions.length;
  const isSaved =
    saveState === "saved" || saveState === "ready";

  return (
    <div className="practice-layout">
      <section className="practice-column" aria-labelledby="practice-title">
        <p className="eyebrow">Sample content · synthetic demo</p>
        <h1 id="practice-title">Practice session</h1>
        <p className="intro">
          These original illustrative questions are not an official exam bank
          or production assessment.
        </p>

        <div className={`save-status save-status--${saveState}`} role="status" aria-live="polite">
          <strong>
            {saveState === "loading" && "Loading demo state"}
            {saveState === "ready" && "Not saved yet"}
            {saveState === "saving" && "Saving (demo)"}
            {saveState === "saved" && "Saved on this browser (demo)"}
            {saveState === "error" && "Unable to save—retry"}
          </strong>
          <span>{saveMessage}</span>
          {savedAt && <span>{savedAt}</span>}
        </div>

        {completed ? (
          <section className="card result-card" aria-labelledby="result-title">
            <p className="eyebrow">Sample session complete</p>
            <h2 id="result-title">Your practice summary</h2>
            <p>
              {session.answers.filter(
                (answer, index) => answer === demoQuestions[index].correctIndex,
              ).length}{" "}
              of {demoQuestions.length} illustrative questions correct.
            </p>
            <p>This synthetic result is not a pass prediction.</p>
            <Link className="button-link" to="/app/practice">
              Back to practice
            </Link>
          </section>
        ) : (
          <article className="question-card" aria-labelledby="question-stem">
            <div className="question-meta">
              <span>
                Question {session.questionIndex + 1} of {demoQuestions.length}
              </span>
              <span>{question.domain}</span>
              <span>{question.difficulty}</span>
            </div>
            <h2 id="question-stem">{question.stem}</h2>

            <fieldset className="answer-list" disabled={session.submitted || !isSaved}>
              <legend className="visually-hidden">Select one answer</legend>
              {question.options.map((option, index) => (
                <label
                  className={`answer-option${session.selectedAnswer === index ? " answer-option--selected" : ""}`}
                  key={option}
                >
                  <input
                    type="radio"
                    name={question.id}
                    value={index}
                    checked={session.selectedAnswer === index}
                    onChange={() =>
                      void applyAction({ type: "select", answerIndex: index })
                    }
                  />
                  <span>{option}</span>
                </label>
              ))}
            </fieldset>

            {session.submitted && (
              <section className="explanation" aria-labelledby="explanation-title">
                <h3 id="explanation-title">
                  {session.answers[session.questionIndex] === question.correctIndex
                    ? "Correct"
                    : "Review the answer"}
                </h3>
                {question.options.map((option, index) => (
                  <p
                    className={
                      index === question.correctIndex
                        ? "explanation-correct"
                        : undefined
                    }
                    key={option}
                  >
                    <strong>
                      {index === question.correctIndex
                        ? "Best answer"
                        : `Option ${String.fromCharCode(65 + index)}`}
                      :
                    </strong>{" "}
                    {question.explanations[index]}
                  </p>
                ))}
                <p className="muted">{question.reference}</p>
              </section>
            )}

            <div className="practice-actions">
              {!session.submitted ? (
                <button
                  className="button-primary"
                  type="button"
                  disabled={session.selectedAnswer === null || !isSaved}
                  onClick={() => void applyAction({ type: "submit" })}
                >
                  Submit answer
                </button>
              ) : (
                <button
                  className="button-primary"
                  type="button"
                  disabled={!isSaved || session.questionIndex === demoQuestions.length - 1}
                  onClick={() => void applyAction({ type: "next" })}
                >
                  Next question
                </button>
              )}
              <button
                className="button-secondary"
                type="button"
                aria-pressed={session.bookmarks.includes(question.id)}
                disabled={!isSaved}
                onClick={() => void applyAction({ type: "bookmark" })}
              >
                {session.bookmarks.includes(question.id)
                  ? "Remove bookmark"
                  : "Bookmark question"}
              </button>
              {saveState === "error" && (
                <>
                  <button
                    className="button-secondary"
                    type="button"
                    onClick={() => void retrySave()}
                  >
                    Retry save
                  </button>
                  <button
                    className="button-secondary"
                    type="button"
                    onClick={() => navigate("/app/practice")}
                  >
                    Stay in practice
                  </button>
                </>
              )}
              <button
                className="button-secondary"
                type="button"
                disabled={!isSaved}
                onClick={() => void saveAndExit()}
              >
                Save &amp; exit
              </button>
            </div>
          </article>
        )}
      </section>

      <aside className="demo-panel" aria-labelledby="practice-demo-title">
        <p className="eyebrow">Development-only</p>
        <h2 id="practice-demo-title">Demo controls</h2>
        <p>
          These controls simulate browser behavior only. Nothing is sent to a
          server or saved to an account.
        </p>
        <button
          className="button-secondary"
          type="button"
          aria-pressed={failNextSave}
          onClick={() => setFailNextSave((value) => !value)}
        >
          {failNextSave ? "Next save will fail" : "Simulate next save failure"}
        </button>
        <button className="button-secondary" type="button" onClick={() => void resetDemo()}>
          Reset demo
        </button>
      </aside>
    </div>
  );
}
