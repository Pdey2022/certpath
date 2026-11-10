import { useEffect, useRef, useState } from "react";
import { Link, useBlocker, useNavigate } from "react-router";

import {
  createPracticeDemoState,
  demoQuestions,
  parsePracticeDemoState,
  practiceDemoStorageKey,
  savePracticeDemo,
  updatePracticeDemo,
  type PracticeDemoState,
} from "../lib/prototype-data";
import {
  createPracticeFlowState,
  getPracticePresentation,
  interactWithPractice,
  type PracticeFlowAction,
} from "../lib/practice-flow";

type SaveState = "loading" | "ready" | "saving" | "saved" | "error";

function pauseForDemo() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 350));
}

export function PracticeDemo() {
  const navigate = useNavigate();
  const isDevelopmentBuild =
    typeof import.meta.env !== "undefined" && import.meta.env.DEV;
  const [flow, setFlow] = useState(() =>
    createPracticeFlowState(createPracticeDemoState()),
  );
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [saveMessage, setSaveMessage] = useState("");
  const [savedAt, setSavedAt] = useState("");
  const [failNextSave, setFailNextSave] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const allowNavigationAfterSave = useRef(false);
  const blocker = useBlocker(
    () => hasUnsavedChanges && !allowNavigationAfterSave.current,
  );
  const session = flow.session;
  const presentation = getPracticePresentation(flow);

  useEffect(() => {
    try {
      const restored = parsePracticeDemoState(
        window.localStorage.getItem(practiceDemoStorageKey),
      );
      if (restored) {
        setFlow(createPracticeFlowState(restored));
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

  useEffect(() => {
    if (!hasUnsavedChanges) {
      return;
    }

    function warnBeforeLeaving(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    if (!hasUnsavedChanges && blocker.state === "blocked") {
      blocker.reset();
    }
  }, [hasUnsavedChanges, blocker]);

  async function save(next: PracticeDemoState) {
    setFlow((current) => ({ ...current, session: next }));
    setHasUnsavedChanges(true);
    setSaveState("saving");
    setSaveMessage("Saving this demo session to this browser.");
    await pauseForDemo();

    if (isDevelopmentBuild && failNextSave) {
      setFailNextSave(false);
      setSaveState("error");
      setSaveMessage(
        "Simulated save failure. Your unsaved change is still in this session, but is not saved in this browser. Retry before leaving.",
      );
      return false;
    }

    try {
      savePracticeDemo(next, {
        read: () => window.localStorage.getItem(practiceDemoStorageKey),
        write: (value) => window.localStorage.setItem(practiceDemoStorageKey, value),
        clear: () => window.localStorage.removeItem(practiceDemoStorageKey),
      });
      setSaveState("saved");
      setHasUnsavedChanges(false);
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
    const nextFlow = interactWithPractice(flow, action);
    if (nextFlow !== flow) {
      await save(nextFlow.session);
      setFlow(nextFlow);
    }
  }

  async function applyFlowAction(action: PracticeFlowAction) {
    const nextFlow = interactWithPractice(flow, action);
    if (nextFlow !== flow) {
      if (nextFlow.session !== flow.session) {
        await save(nextFlow.session);
      }
      setFlow(nextFlow);
    }
  }

  async function retrySave() {
    await save(session);
  }

  function stayInPractice() {
    setSaveMessage(
      "You are still in this practice session. The unsaved change remains here; retry before leaving.",
    );
    if (blocker.state === "blocked") {
      blocker.reset();
    }
    void applyFlowAction({ type: "stay-in-practice" });
  }

  async function saveAndExit() {
    if (await save(session)) {
      allowNavigationAfterSave.current = true;
      navigate("/app/practice");
    }
  }

  const questionIndex =
    presentation.screen === "results"
      ? session.questionIndex
      : presentation.questionIndex;
  const question = demoQuestions[questionIndex];
  const reviewing = presentation.screen === "review";
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
        {hasUnsavedChanges && (
          <p className="unsaved-warning" role="note">
            This change is unsaved. Staying here keeps it in the current
            session; leaving may discard it, and only the previous browser save
            (if any) can be restored.
          </p>
        )}

        {presentation.screen === "results" ? (
          <section className="card result-card" aria-labelledby="result-title">
            <p className="eyebrow">Sample session complete</p>
            <h2 id="result-title">Your practice summary</h2>
            <p>{presentation.correctCount} of {demoQuestions.length} illustrative questions correct.</p>
            <p>This synthetic result is not a pass prediction.</p>
            <h3>Review answered questions</h3>
            <ol className="review-question-list">
              {demoQuestions.map((item, index) => (
                <li key={item.id}>
                  <span>
                    {item.domain} ·{" "}
                    {session.answers[index] === item.correctIndex
                      ? "Correct"
                      : "Review"}
                  </span>
                  <button
                    className="button-secondary"
                    type="button"
                    onClick={() =>
                      setFlow(
                        interactWithPractice(flow, {
                          type: "review-question",
                          questionIndex: index,
                        }),
                      )
                    }
                  >
                    Review question {index + 1}
                  </button>
                </li>
              ))}
            </ol>
            <Link className="button-link" to="/app/practice">
              Back to practice
            </Link>
          </section>
        ) : (
          <article className="question-card" aria-labelledby="question-stem">
            {reviewing && (
              <p className="prototype-notice" role="note">
                Read-only review · answers and explanations cannot be changed.
              </p>
            )}
            <div className="question-meta">
              <span>
                Question {questionIndex + 1} of {demoQuestions.length}
              </span>
              <span>{question.domain}</span>
              <span>{question.difficulty}</span>
            </div>
            <h2 id="question-stem">{question.stem}</h2>

            <fieldset
              className="answer-list"
              disabled={reviewing || presentation.submitted || !isSaved}
            >
              <legend className="visually-hidden">Select one answer</legend>
              {question.options.map((option, index) => (
                <label
                  className={`answer-option${presentation.selectedAnswer === index ? " answer-option--selected" : ""}`}
                  key={option}
                >
                  <input
                    type="radio"
                    name={question.id}
                    value={index}
                    checked={presentation.selectedAnswer === index}
                    onChange={() =>
                      void applyAction({ type: "select", answerIndex: index })
                    }
                  />
                  <span>{option}</span>
                </label>
              ))}
            </fieldset>

            {presentation.submitted && (
              <section className="explanation" aria-labelledby="explanation-title">
                <h3 id="explanation-title">
                  {presentation.selectedAnswer === question.correctIndex
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
              {reviewing ? (
                <>
                  <button
                    className="button-secondary"
                    type="button"
                    disabled={questionIndex === 0}
                    onClick={() => void applyFlowAction({ type: "previous" })}
                  >
                    Previous review
                  </button>
                  <button
                    className="button-secondary"
                    type="button"
                    disabled={questionIndex === demoQuestions.length - 1}
                    onClick={() => void applyFlowAction({ type: "next" })}
                  >
                    Next review
                  </button>
                  <button
                    className="button-primary"
                    type="button"
                    onClick={() =>
                      void applyFlowAction({ type: "return-to-results" })
                    }
                  >
                    Back to results
                  </button>
                </>
              ) : !presentation.submitted ? (
                <button
                  className="button-primary"
                  type="button"
                  disabled={session.selectedAnswer === null || !isSaved}
                  onClick={() => void applyAction({ type: "submit" })}
                >
                  Submit answer
                </button>
              ) : presentation.canViewResults ? (
                <button
                  className="button-primary"
                  type="button"
                  disabled={!isSaved}
                  onClick={() =>
                    void applyFlowAction({ type: "view-results" })
                  }
                >
                  View results
                </button>
              ) : (
                <button
                  className="button-primary"
                  type="button"
                  disabled={!isSaved || questionIndex === demoQuestions.length - 1}
                  onClick={() => void applyAction({ type: "next" })}
                >
                  Next question
                </button>
              )}
              {!reviewing && (
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
              )}
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
                    onClick={stayInPractice}
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

      {blocker.state === "blocked" && (
        <section
          className="demo-panel unsaved-navigation"
          role="alertdialog"
          aria-labelledby="unsaved-navigation-title"
        >
          <h2 id="unsaved-navigation-title">Unsaved practice change</h2>
          <p>
            Leaving now may discard this change. Only the previous browser save,
            if any, can be restored. Retry saving or choose to stay, or confirm
            that you want to leave without saving.
          </p>
          <div className="button-row">
            <button
              className="button-secondary"
              type="button"
              onClick={stayInPractice}
            >
              Stay in practice
            </button>
            <button
              className="button-secondary"
              type="button"
              onClick={() => blocker.proceed()}
            >
              Leave without saving
            </button>
          </div>
        </section>
      )}

      {isDevelopmentBuild && (
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
        </aside>
      )}
    </div>
  );
}
