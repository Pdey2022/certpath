import { useEffect, useRef, useState } from "react";
import {
  getPracticeAttempt,
  LearnerPracticeApiError,
  listPracticeAttempts,
  listPracticeScopes,
  startPractice,
  submitPracticeAnswer,
  type PracticeAttempt,
  type PracticeAttemptSummary,
  type PracticeScope,
  type StartPracticeInput,
} from "../lib/learner-practice-api";

type PendingAnswer = {
  attemptId: string;
  expectedVersion: number;
  selectedOptionKey: string;
  requestId: string;
};

type SaveState = "idle" | "saving" | "saved" | "error";

function scopeKey(scope: Pick<PracticeScope, "certificationId" | "examVersionId">) {
  return `${scope.certificationId}:${scope.examVersionId}`;
}

function messageFor(error: unknown): string {
  if (!(error instanceof LearnerPracticeApiError)) {
    return "Practice is temporarily unavailable. Your current answer remains on this screen.";
  }
  if (error.status === 401) {
    return "Your session is missing or expired. Sign in through the configured account provider to continue.";
  }
  if (error.status === 403 && error.code === "access_required") {
    return "Active access for this certification is required. Your saved attempt remains on the server.";
  }
  if (error.status === 404) {
    return "This attempt is unavailable in your account.";
  }
  if (error.status === 409 && error.code === "insufficient_questions") {
    return "There are not enough published questions for these filters.";
  }
  if (error.status === 409) {
    return "Saved progress changed elsewhere. Reload the server copy before continuing.";
  }
  if (error.status === 0) {
    return "The network could not reach the server. Your selected answer remains here; retry before leaving.";
  }
  return "Practice is temporarily unavailable. Retry without leaving this screen.";
}

function SaveStatus({ state, message }: { state: SaveState; message: string }) {
  if (state === "idle" && !message) return null;
  return (
    <div
      className={`save-status save-status--${state === "idle" ? "saved" : state === "saving" ? "saving" : state === "saved" ? "saved" : "error"}`}
      role={state === "error" ? "alert" : "status"}
      aria-live="polite"
    >
      <strong>
        {state === "saving"
          ? "Saving"
          : state === "saved"
            ? "Saved"
            : state === "error"
              ? "Unable to save"
              : "Practice"}
      </strong>
      <span>{message}</span>
    </div>
  );
}

export function LearnerPractice() {
  const [scopes, setScopes] = useState<PracticeScope[]>([]);
  const [scopesReady, setScopesReady] = useState(false);
  const [selectedScopeKey, setSelectedScopeKey] = useState("");
  const [attempts, setAttempts] = useState<PracticeAttemptSummary[]>([]);
  const [attemptsLoading, setAttemptsLoading] = useState(false);
  const [attemptListRevision, setAttemptListRevision] = useState(0);
  const [questionCount, setQuestionCount] = useState(10);
  const [selectedDomain, setSelectedDomain] = useState("");
  const [difficulty, setDifficulty] = useState("");
  const [attempt, setAttempt] = useState<PracticeAttempt | null>(null);
  const [selectedOptionKey, setSelectedOptionKey] = useState("");
  const [pendingAnswer, setPendingAnswer] = useState<PendingAnswer | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMessage, setSaveMessage] = useState("");
  const [loadError, setLoadError] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [isLoadingAttempt, setIsLoadingAttempt] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [pendingStart, setPendingStart] = useState<StartPracticeInput | null>(null);
  const listRequest = useRef(0);
  const attemptRequest = useRef(0);
  const activeAttemptId = useRef<string | null>(null);
  const pendingAnswerRef = useRef<PendingAnswer | null>(null);

  const selectedScope =
    scopes.find((scope) => scopeKey(scope) === selectedScopeKey) ?? null;

  useEffect(() => {
    let active = true;
    setLoadError("");
    void listPracticeScopes()
      .then((response) => {
        if (!active) return;
        setScopes(response.items);
        if (response.items[0]) setSelectedScopeKey(scopeKey(response.items[0]));
      })
      .catch((error: unknown) => {
        if (active) setLoadError(messageFor(error));
      })
      .finally(() => {
        if (active) setScopesReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const requestId = ++listRequest.current;
    if (!selectedScope) {
      setAttempts([]);
      return;
    }
    let active = true;
    setAttemptsLoading(true);
    setLoadError("");
    void listPracticeAttempts(
      selectedScope.certificationId,
      selectedScope.examVersionId,
    )
      .then((response) => {
        if (active && listRequest.current === requestId) {
          setAttempts(response.items);
        }
      })
      .catch((error: unknown) => {
        if (active && listRequest.current === requestId) {
          setLoadError(messageFor(error));
          setAttempts([]);
        }
      })
      .finally(() => {
        if (active && listRequest.current === requestId) {
          setAttemptsLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [
    selectedScope?.certificationId,
    selectedScope?.examVersionId,
    attemptListRevision,
  ]);

  async function sendAnswer(operation: PendingAnswer) {
    if (activeAttemptId.current !== operation.attemptId) return;
    setSaveState("saving");
    setSaveMessage("Waiting for the server to acknowledge this answer.");
    setLoadError("");
    try {
      const saved = await submitPracticeAnswer(operation.attemptId, {
        expectedVersion: operation.expectedVersion,
        requestId: operation.requestId,
        selectedOptionKey: operation.selectedOptionKey,
      });
      if (activeAttemptId.current !== operation.attemptId) return;
      setAttempt(saved);
      setAttemptListRevision((current) => current + 1);
      setSelectedOptionKey("");
      setPendingAnswer(null);
      pendingAnswerRef.current = null;
      setConflict(false);
      setSaveState("saved");
      setSaveMessage(
        saved.attempt.state === "completed"
          ? "Your completed attempt and result are saved on the server."
          : "Your answer and new position are saved on the server.",
      );
    } catch (error) {
      if (activeAttemptId.current !== operation.attemptId) return;
      setSaveState("error");
      setSaveMessage(messageFor(error));
      setConflict(
        error instanceof LearnerPracticeApiError && error.status === 409,
      );
    }
  }

  async function beginPractice(input: StartPracticeInput) {
    if (isStarting) return;
    setIsStarting(true);
    setPendingStart(input);
    setLoadError("");
    try {
      const started = await startPractice(input);
      setAttempt(started);
      activeAttemptId.current = started.attempt.id;
      setSelectedOptionKey("");
      setPendingStart(null);
      setAttemptListRevision((current) => current + 1);
      setSaveState("saved");
      setSaveMessage("The attempt and question order are saved on the server.");
    } catch (error) {
      setLoadError(messageFor(error));
      if (
        error instanceof LearnerPracticeApiError &&
        error.status > 0 &&
        error.status < 500
      ) {
        setPendingStart(null);
      }
    } finally {
      setIsStarting(false);
    }
  }

  async function startNewAttempt() {
    if (!selectedScope) return;
    await beginPractice({
      certificationId: selectedScope.certificationId,
      examVersionId: selectedScope.examVersionId,
      questionCount,
      ...(selectedDomain ? { domainId: selectedDomain } : {}),
      ...(difficulty ? { difficulty: difficulty as "easy" | "medium" | "hard" } : {}),
      requestId: pendingStart?.requestId ?? crypto.randomUUID(),
    });
  }

  async function openAttempt(summary: PracticeAttemptSummary) {
    const requestId = ++attemptRequest.current;
    activeAttemptId.current = summary.id;
    setIsLoadingAttempt(true);
    setLoadError("");
    try {
      const restored = await getPracticeAttempt(summary.id);
      if (attemptRequest.current !== requestId || activeAttemptId.current !== summary.id) {
        return;
      }
      setAttempt(restored);
      setSelectedOptionKey("");
      setPendingAnswer(null);
      pendingAnswerRef.current = null;
      setSaveState("saved");
      setSaveMessage("The server restored this saved attempt.");
    } catch (error) {
      if (attemptRequest.current === requestId) {
        setLoadError(messageFor(error));
        activeAttemptId.current = null;
        setAttemptListRevision((current) => current + 1);
      }
    } finally {
      if (attemptRequest.current === requestId) setIsLoadingAttempt(false);
    }
  }

  function submitAnswer() {
    if (!attempt || !selectedOptionKey || pendingAnswer) return;
    const operation: PendingAnswer = {
      attemptId: attempt.attempt.id,
      expectedVersion: attempt.attempt.version,
      selectedOptionKey,
      requestId: crypto.randomUUID(),
    };
    pendingAnswerRef.current = operation;
    setPendingAnswer(operation);
    void sendAnswer(operation);
  }

  function chooseAnswer(optionKey: string) {
    setSelectedOptionKey(optionKey);
    setSaveState("idle");
    setSaveMessage("This selected answer is not saved until you submit it.");
  }

  function clearSelection() {
    setSelectedOptionKey("");
    if (!pendingAnswer) {
      setSaveState("saved");
      setSaveMessage("Previously acknowledged progress remains saved on the server.");
    }
  }

  function retryAnswer() {
    const operation = pendingAnswerRef.current;
    if (operation && !conflict) void sendAnswer(operation);
  }

  async function reloadSavedAttempt() {
    if (!attempt) return;
    if (
      pendingAnswer &&
      !window.confirm(
        "Reload saved progress? The selected answer that was not acknowledged will be discarded.",
      )
    ) {
      return;
    }
    const requestId = ++attemptRequest.current;
    setIsLoadingAttempt(true);
    try {
      const restored = await getPracticeAttempt(attempt.attempt.id);
      if (
        attemptRequest.current !== requestId ||
        activeAttemptId.current !== attempt.attempt.id
      ) {
        return;
      }
      setAttempt(restored);
      setSelectedOptionKey("");
      setPendingAnswer(null);
      pendingAnswerRef.current = null;
      setConflict(false);
      setSaveState("saved");
      setSaveMessage("Reloaded the latest server-acknowledged progress.");
    } catch (error) {
      if (attemptRequest.current === requestId) setLoadError(messageFor(error));
    } finally {
      if (attemptRequest.current === requestId) setIsLoadingAttempt(false);
    }
  }

  function exitAttempt() {
    if (pendingAnswer || selectedOptionKey || saveState === "saving") return;
    activeAttemptId.current = null;
    setAttempt(null);
    setSelectedOptionKey("");
    setPendingAnswer(null);
    pendingAnswerRef.current = null;
    setSaveState("saved");
    setSaveMessage("Your acknowledged progress remains saved on the server.");
  }

  const currentItem =
    attempt?.items.find(
      (item) => item.position === attempt.attempt.currentPosition,
    ) ?? null;
  const completed = attempt?.attempt.state === "completed";

  if (!scopesReady) {
    return (
      <section className="card" aria-busy="true">
        <p className="eyebrow">Protected practice</p>
        <h1>Loading practice</h1>
        <p>Checking your session and exam access.</p>
      </section>
    );
  }

  return (
    <section className="learner-practice">
      <p className="eyebrow">Protected practice · server-saved</p>
      <h1>Untimed practice</h1>
      <p className="intro">
        Your published questions and answers are loaded only after your session
        and exam access are checked. The separate <a href="/app/practice">synthetic
        prototype</a> does not save to this service.
      </p>

      {loadError && <p className="form-errors" role="alert">{loadError}</p>}

      {attempt ? (
        <div className="practice-column">
          <div className="section-heading">
            <div>
              <p className="eyebrow">
                {attempt.attempt.currentPosition < attempt.attempt.questionCount
                  ? `Question ${attempt.attempt.currentPosition + 1} of ${attempt.attempt.questionCount}`
                  : "Attempt complete"}
              </p>
              <h2>{completed ? "Practice summary" : "Your question"}</h2>
            </div>
            <button
              className="button-secondary"
              type="button"
              onClick={exitAttempt}
              disabled={
                Boolean(pendingAnswer) ||
                Boolean(selectedOptionKey) ||
                saveState === "saving"
              }
              title={
                selectedOptionKey || pendingAnswer
                  ? "Submit or clear the unacknowledged answer before exiting."
                  : undefined
              }
            >
              Save &amp; exit
            </button>
          </div>

          <SaveStatus state={saveState} message={saveMessage} />

          {completed ? (
            <article className="card">
              <p className="metric">
                {attempt.attempt.correctCount} / {attempt.attempt.questionCount} correct
              </p>
              <p>This attempt is complete and locked against further answers.</p>
            </article>
          ) : currentItem ? (
            <article className="card practice-question-card">
              <h2>{currentItem.stem}</h2>
              <fieldset className="answer-options" disabled={Boolean(pendingAnswer) || isLoadingAttempt}>
                <legend className="visually-hidden">Choose one answer</legend>
                {currentItem.options.map((option, index) => (
                  <label
                    className={`answer-option${selectedOptionKey === option.key ? " answer-option--selected" : ""}`}
                    key={option.key}
                  >
                    <input
                      type="radio"
                      name={`answer-${attempt.attempt.id}-${currentItem.position}`}
                      value={option.key}
                      checked={selectedOptionKey === option.key}
                      onChange={() => chooseAnswer(option.key)}
                    />
                    <span className="answer-option-label">
                      <strong>{String.fromCharCode(65 + index)}.</strong> {option.text}
                    </span>
                  </label>
                ))}
              </fieldset>
              <div className="practice-actions">
                <button
                  className="button-primary"
                  type="button"
                  onClick={submitAnswer}
                  disabled={!selectedOptionKey || Boolean(pendingAnswer) || isLoadingAttempt}
                >
                  {saveState === "saving" ? "Submitting answer…" : "Submit answer"}
                </button>
                <button
                  className="button-link"
                  type="button"
                  onClick={clearSelection}
                  disabled={!selectedOptionKey || Boolean(pendingAnswer) || isLoadingAttempt}
                >
                  Clear selection
                </button>
              </div>
              {selectedOptionKey && !pendingAnswer && (
                <p role="status">
                  This choice is still only on this screen. Submit it to save, or clear it before Save &amp; exit.
                </p>
              )}
            </article>
          ) : (
            <p className="empty-state" role="status">No question is available in this attempt.</p>
          )}

          {pendingAnswer && saveState === "error" && !conflict && (
            <button className="button-secondary" type="button" onClick={retryAnswer}>
              Retry the same answer safely
            </button>
          )}
          {conflict && (
            <button
              className="button-secondary"
              type="button"
              onClick={() => void reloadSavedAttempt()}
            >
              Reload saved progress
            </button>
          )}

          {attempt.items.some((item) => item.isCorrect !== undefined) && (
            <details className="card section-block">
              <summary>Review submitted answers</summary>
              <ol className="practice-review-list">
                {attempt.items
                  .filter((item) => item.isCorrect !== undefined)
                  .map((item) => (
                    <li key={`${item.position}-${item.revisionId}`}>
                      <h3>{item.stem}</h3>
                      <p>
                        Your answer: {item.options.find((option) => option.key === item.selectedOptionKey)?.text}
                        {" · "}
                        {item.isCorrect ? "Correct" : "Not correct"}
                      </p>
                      {item.options.map((option) => (
                        <p className="explanation" key={option.key}>
                          <strong>{option.key === item.correctOptionKey ? "Correct answer" : "Explanation"}</strong>
                          {" — "}{option.explanation}
                        </p>
                      ))}
                    </li>
                  ))}
              </ol>
            </details>
          )}
        </div>
      ) : (
        <>
          {scopes.length === 0 ? (
            <section className="empty-state">
              <h2>No active exam access</h2>
              <p>
                No time-limited Standard access is available for this session.
                Provider-backed sign-in and grant management are not part of this milestone.
              </p>
            </section>
          ) : (
            <>
              <section className="card practice-setup" aria-labelledby="practice-setup-title">
                <h2 id="practice-setup-title">Choose an exam</h2>
                <div className="practice-setup-grid">
                  <label>
                    Certification and version
                    <select
                      value={selectedScopeKey}
                      onChange={(event) => {
                        setSelectedScopeKey(event.currentTarget.value);
                        setSelectedDomain("");
                        setAttempts([]);
                      }}
                      disabled={isStarting || Boolean(pendingStart) || isLoadingAttempt}
                    >
                      {scopes.map((scope) => (
                        <option key={scopeKey(scope)} value={scopeKey(scope)}>
                          {scope.certificationName} · {scope.examVersionTitle}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Domain
                    <select
                      value={selectedDomain}
                      onChange={(event) => setSelectedDomain(event.currentTarget.value)}
                      disabled={isStarting || Boolean(pendingStart) || isLoadingAttempt}
                    >
                      <option value="">All available domains</option>
                      {selectedScope?.domains.map((domain) => (
                        <option key={domain.id} value={domain.id}>{domain.title}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Number of questions
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={questionCount}
                      onChange={(event) => {
                        const next = Number(event.currentTarget.value);
                        if (Number.isInteger(next) && next >= 1 && next <= 20) {
                          setQuestionCount(next);
                        }
                      }}
                      disabled={isStarting || Boolean(pendingStart) || isLoadingAttempt}
                    />
                  </label>
                  <label>
                    Difficulty
                    <select
                      value={difficulty}
                      onChange={(event) => setDifficulty(event.currentTarget.value)}
                      disabled={isStarting || Boolean(pendingStart) || isLoadingAttempt}
                    >
                      <option value="">Any difficulty</option>
                      <option value="easy">Easy</option>
                      <option value="medium">Medium</option>
                      <option value="hard">Hard</option>
                    </select>
                  </label>
                </div>
                <button
                  className="button-primary"
                  type="button"
                  onClick={() => void startNewAttempt()}
                  disabled={isStarting || Boolean(pendingStart) || isLoadingAttempt || attemptsLoading}
                >
                  {isStarting ? "Starting practice…" : "Start practice"}
                </button>
                {pendingStart && !isStarting && loadError && (
                  <button
                    className="button-secondary"
                    type="button"
                    onClick={() => void beginPractice(pendingStart)}
                  >
                    Retry starting the same attempt
                  </button>
                )}
              </section>

              <SaveStatus state={saveState} message={saveMessage} />

              <section className="section-block" aria-labelledby="saved-attempts-title">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Acknowledged by the server</p>
                    <h2 id="saved-attempts-title">Saved practice</h2>
                  </div>
                  {attemptsLoading && <span role="status">Loading saved attempts…</span>}
                </div>
                {attempts.length ? (
                  <ul className="saved-attempt-list">
                    {attempts.map((savedAttempt) => (
                      <li key={savedAttempt.id} className="card">
                        <div>
                          <strong>
                            {savedAttempt.state === "completed" ? "Completed" : "In progress"}
                          </strong>
                          <p>
                            {savedAttempt.currentPosition} of {savedAttempt.questionCount} answered
                          </p>
                        </div>
                        <button
                          className="button-secondary"
                          type="button"
                          onClick={() => void openAttempt(savedAttempt)}
                          disabled={isLoadingAttempt || isStarting}
                        >
                          {savedAttempt.state === "completed" ? "Review result" : "Resume"}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  !attemptsLoading && <p className="empty-state">No saved attempts for this exam yet.</p>
                )}
              </section>
            </>
          )}
        </>
      )}
      <p className="privacy-note">
        Answers and explanations are returned only after you submit that question.
        No practice content is written to browser storage.
      </p>
    </section>
  );
}
