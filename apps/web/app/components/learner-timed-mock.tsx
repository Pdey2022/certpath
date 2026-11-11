import { useEffect, useRef, useState } from "react";
import { useBlocker, useLocation, useNavigate } from "react-router";
import {
  getTimedMockAttempt,
  LearnerPracticeApiError,
  listPracticeScopes,
  listTimedMockAttempts,
  saveTimedMockAnswer,
  saveTimedMockPosition,
  startTimedMock,
  submitTimedMock,
  type PracticeScope,
  type TimedMockAttempt,
  type TimedMockAttemptSummary,
} from "../lib/learner-practice-api";

type PendingOperation =
  | {
      kind: "answer";
      expectedVersion: number;
      position: number;
      selectedOptionKey: string;
      requestId: string;
    }
  | {
      kind: "navigate";
      expectedVersion: number;
      position: number;
      requestId: string;
    };

interface DeadlineRecovery {
    attemptId: string;
    active: boolean;
    checking: boolean;
    waitingForIdle: boolean;
    retries: number;
    retryTimer: number | null;
}

const deadlineRetryDelays = [500, 1000, 2000] as const;

function scopeKey(scope: Pick<PracticeScope, "certificationId" | "examVersionId">) {
  return `${scope.certificationId}:${scope.examVersionId}`;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof LearnerPracticeApiError)) {
    return "CertPath practice is temporarily unavailable. Your acknowledged work remains on the server.";
  }
  if (error.status === 401) {
    return "Your session is missing or expired. Sign in through the configured account provider to continue.";
  }
  if (error.status === 403 && error.code === "access_required") {
    return "Active Standard access is required for this certification. Your mock remains stored, but is unavailable until access is restored.";
  }
  if (error.status === 404) return "This mock is unavailable in your account.";
  if (error.status === 409 && error.code === "deadline_reached") {
    return "The server deadline has passed. Checking the finalized result.";
  }
  if (error.status === 409 && error.code === "mock_not_configured") {
    return "A CertPath practice mock profile is not configured for this exam version.";
  }
  if (error.status === 409) {
    return "Saved progress changed in another session. Reload the server copy before continuing.";
  }
  if (error.status === 0) return "The network is unavailable. Keep this page open and retry the same operation.";
  return "CertPath practice is temporarily unavailable. Retry without leaving this page.";
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function LearnerTimedMock() {
  const location = useLocation();
  const navigate = useNavigate();
  const [scopes, setScopes] = useState<PracticeScope[]>([]);
  const [scopeKeyValue, setScopeKeyValue] = useState("");
  const [attempts, setAttempts] = useState<TimedMockAttemptSummary[]>([]);
  const [attempt, setAttempt] = useState<TimedMockAttempt | null>(null);
  const [linkedAttemptId, setLinkedAttemptId] = useState<string | null>(null);
  const [selectedOptionKey, setSelectedOptionKey] = useState("");
  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [submitConfirmation, setSubmitConfirmation] = useState(false);
  const [leaveConfirmation, setLeaveConfirmation] = useState(false);
  const [clearLinkedAttemptOnExit, setClearLinkedAttemptOnExit] = useState(false);
  const [unansweredNavigation, setUnansweredNavigation] = useState<number | null>(null);
  const submitRequestId = useRef<string | null>(null);
  const saveAttemptId = useRef<string | null>(null);
  const receivedAt = useRef(0);
  const requestSequence = useRef(0);
  const linkedRequestSequence = useRef(0);
  const deadlineCheckAttempt = useRef<string | null>(null);
  const deadlineRecovery = useRef<DeadlineRecovery | null>(null);

  const scope =
    scopes.find((item) => scopeKey(item) === scopeKeyValue) ?? null;
  const requestedAttemptId = new URLSearchParams(location.search).get("attemptId");
  const linkIsCurrent =
    linkedAttemptId === requestedAttemptId &&
    (requestedAttemptId === null || attempt?.attempt.id === requestedAttemptId);
  const linkIsPending = !linkIsCurrent && !error;
  const currentItem =
    attempt?.items.find((item) => item.position === attempt.attempt.currentPosition) ?? null;
  const acknowledgedKey = currentItem?.selectedOptionKey ?? "";
  const dirty = Boolean(attempt && selectedOptionKey !== acknowledgedKey);
  const completed = attempt?.attempt.state === "completed";
  const hasPendingWork = dirty || Boolean(pendingOperation) || busy;
  const blocker = useBlocker(hasPendingWork && !completed);

  function stopDeadlineRecovery(attemptId?: string) {
    const recovery = deadlineRecovery.current;
    if (!recovery || (attemptId && recovery.attemptId !== attemptId)) return;
    recovery.active = false;
    if (recovery.retryTimer !== null) {
      window.clearTimeout(recovery.retryTimer);
    }
    deadlineRecovery.current = null;
  }

  function updateBusy(value: boolean) {
    busyRef.current = value;
    setBusy(value);
    if (!value) {
      const recovery = deadlineRecovery.current;
      if (recovery?.active && recovery.waitingForIdle) {
        recovery.waitingForIdle = false;
        queueMicrotask(() => void checkAutomaticDeadlineResult(recovery));
      }
    }
  }

  function scheduleDeadlineRetry(recovery: DeadlineRecovery) {
    if (!recovery.active || deadlineRecovery.current !== recovery) return;
    const delay = deadlineRetryDelays[recovery.retries];
    if (delay === undefined) {
      setStatus(
        "Automatic result checks are paused. Use Refresh server state to check again.",
      );
      return;
    }
    recovery.retries += 1;
    recovery.retryTimer = window.setTimeout(() => {
      recovery.retryTimer = null;
      void checkAutomaticDeadlineResult(recovery);
    }, delay);
  }

  async function checkAutomaticDeadlineResult(recovery: DeadlineRecovery) {
    if (!recovery.active || deadlineRecovery.current !== recovery) return;
    if (saveAttemptId.current !== recovery.attemptId) {
      stopDeadlineRecovery(recovery.attemptId);
      return;
    }
    if (busyRef.current) {
      recovery.waitingForIdle = true;
      return;
    }

    recovery.checking = true;
    updateBusy(true);
    try {
      const restored = await getTimedMockAttempt(recovery.attemptId);
      if (
        !recovery.active ||
        deadlineRecovery.current !== recovery ||
        saveAttemptId.current !== recovery.attemptId
      ) return;
      installAttempt(restored);
      setPendingOperation(null);
      setError("");
      if (restored.attempt.state === "completed") {
        setStatus("The server finalized this mock. Its result is shown below.");
        stopDeadlineRecovery(recovery.attemptId);
      } else {
        setStatus("The deadline passed. Checking again for the finalized result.");
        scheduleDeadlineRetry(recovery);
      }
    } catch (cause) {
      if (recovery.active && deadlineRecovery.current === recovery) {
        setError(errorMessage(cause));
        setStatus("The result check failed temporarily. CertPath practice will retry.");
        scheduleDeadlineRetry(recovery);
      }
    } finally {
      recovery.checking = false;
      updateBusy(false);
    }
  }

  function startDeadlineRecovery(attemptId: string) {
    let recovery = deadlineRecovery.current;
    if (!recovery || recovery.attemptId !== attemptId) {
      stopDeadlineRecovery();
      recovery = {
        attemptId,
        active: true,
        checking: false,
        waitingForIdle: false,
        retries: 0,
        retryTimer: null,
      };
      deadlineRecovery.current = recovery;
    } else if (
      recovery.checking ||
      recovery.waitingForIdle ||
      recovery.retryTimer !== null ||
      recovery.retries >= deadlineRetryDelays.length
    ) {
      return;
    }

    if (busyRef.current) {
      recovery.waitingForIdle = true;
      return;
    }
    void checkAutomaticDeadlineResult(recovery);
  }

  function installAttempt(value: TimedMockAttempt) {
    setAttempt(value);
    setSelectedOptionKey(
      value.items.find((item) => item.position === value.attempt.currentPosition)
        ?.selectedOptionKey ?? "",
    );
    receivedAt.current = performance.now();
    setRemainingSeconds(
      Math.max(0, Math.ceil((value.attempt.deadlineAt - value.serverNow) / 1000)),
    );
    if (value.attempt.state === "completed") {
      stopDeadlineRecovery(value.attempt.id);
    }
  }

  async function refreshAttempts(scopeValue = scope) {
    if (!scopeValue) {
      setAttempts([]);
      return;
    }
    const response = await listTimedMockAttempts(
      scopeValue.certificationId,
      scopeValue.examVersionId,
    );
    setAttempts(response.items);
  }

  useEffect(() => {
    let active = true;
    const requestId = ++linkedRequestSequence.current;
    const requestedAttemptId = new URLSearchParams(location.search).get("attemptId");
    setLoading(true);
    setAttempt(null);
    setLinkedAttemptId(null);
    saveAttemptId.current = null;
    stopDeadlineRecovery();
    deadlineCheckAttempt.current = null;
    setSelectedOptionKey("");
    setPendingOperation(null);
    setError("");
    setStatus("");
    void listPracticeScopes()
      .then(async (response) => {
        if (!active) return;
        const available = response.items.filter((item) => item.mockProfile);
        setScopes(available);
        if (available[0]) setScopeKeyValue(scopeKey(available[0]));
        if (!requestedAttemptId) return;
        try {
          const restored = await getTimedMockAttempt(requestedAttemptId);
          if (
            !active ||
            linkedRequestSequence.current !== requestId
          ) return;
          installAttempt(restored);
          setLinkedAttemptId(requestedAttemptId);
          saveAttemptId.current = restored.attempt.id;
          const linkedScope = available.find(
            (item) =>
              item.certificationId === restored.attempt.certificationId &&
              item.examVersionId === restored.attempt.examVersionId,
          );
          if (linkedScope) setScopeKeyValue(scopeKey(linkedScope));
          setStatus(
            restored.attempt.state === "completed"
              ? "The selected server-finalized result was loaded."
              : "The selected mock and its server deadline were loaded.",
          );
        } catch (cause) {
          if (active && linkedRequestSequence.current === requestId) {
            setAttempt(null);
            setLinkedAttemptId(null);
            saveAttemptId.current = null;
            setError(errorMessage(cause));
          }
        }
      })
      .catch((cause: unknown) => {
        if (active && linkedRequestSequence.current === requestId) {
          setAttempt(null);
          setLinkedAttemptId(null);
          saveAttemptId.current = null;
          setError(errorMessage(cause));
        }
      })
      .finally(() => {
        if (active && linkedRequestSequence.current === requestId) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [location.search]);

  useEffect(() => () => stopDeadlineRecovery(), []);

  useEffect(() => {
    let active = true;
    setAttempts([]);
    if (!scope) return;
    void listTimedMockAttempts(scope.certificationId, scope.examVersionId)
      .then((response) => {
        if (active) setAttempts(response.items);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [scope?.certificationId, scope?.examVersionId]);

  useEffect(() => {
    if (!attempt || completed || !linkIsCurrent) return;
    const tick = () => {
      const elapsedSeconds = Math.floor((performance.now() - receivedAt.current) / 1000);
      const left = Math.max(
        0,
        Math.ceil((attempt.attempt.deadlineAt - attempt.serverNow) / 1000) -
          elapsedSeconds,
      );
      setRemainingSeconds(left);
      if (left === 0 && deadlineCheckAttempt.current !== attempt.attempt.id) {
        deadlineCheckAttempt.current = attempt.attempt.id;
        startDeadlineRecovery(attempt.attempt.id);
      }
    };
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [
    attempt?.attempt.id,
    attempt?.attempt.deadlineAt,
    attempt?.attempt.version,
    completed,
    linkIsCurrent,
  ]);

  useEffect(() => {
    if (!hasPendingWork || completed) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasPendingWork, completed]);

  useEffect(() => {
    if (!clearLinkedAttemptOnExit || hasPendingWork) return;
    setClearLinkedAttemptOnExit(false);
    if (requestedAttemptId) {
      void navigate("/app/mock/live", { replace: true });
    }
  }, [clearLinkedAttemptOnExit, hasPendingWork, navigate, requestedAttemptId]);

  async function startMock() {
    if (requestedAttemptId) {
      await navigate("/app/mock/live", { replace: true });
    }
    if (!scope || busy) return;
    stopDeadlineRecovery();
    deadlineCheckAttempt.current = null;
    updateBusy(true);
    setError("");
    setStatus("");
    try {
      const started = await startTimedMock({
        certificationId: scope.certificationId,
        examVersionId: scope.examVersionId,
        requestId: crypto.randomUUID(),
      });
      installAttempt(started);
      saveAttemptId.current = started.attempt.id;
      setStatus("The mock and question order are saved. The server timer is running.");
      await refreshAttempts(scope);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      updateBusy(false);
    }
  }

  async function openMock(summary: TimedMockAttemptSummary) {
    if (requestedAttemptId && requestedAttemptId !== summary.id) {
      await navigate(
        `/app/mock/live?attemptId=${encodeURIComponent(summary.id)}`,
      );
      return;
    }
    stopDeadlineRecovery();
    deadlineCheckAttempt.current = null;
    const requestId = ++requestSequence.current;
    updateBusy(true);
    setError("");
    try {
      const restored = await getTimedMockAttempt(summary.id);
      if (requestSequence.current !== requestId) return;
      installAttempt(restored);
      setLinkedAttemptId(
        requestedAttemptId === summary.id ? summary.id : null,
      );
      saveAttemptId.current = summary.id;
      setStatus(
        restored.attempt.state === "completed"
          ? "The server restored the finalized result."
          : "The server restored acknowledged answers and the running deadline.",
      );
      await refreshAttempts();
    } catch (cause) {
      if (requestSequence.current === requestId) setError(errorMessage(cause));
    } finally {
      if (requestSequence.current === requestId) updateBusy(false);
    }
  }

  async function reloadAttempt(checkExpiry = false) {
    if (!attempt || busyRef.current) return;
    const id = attempt.attempt.id;
    const requestId = ++requestSequence.current;
    updateBusy(true);
    setError("");
    try {
      const restored = await getTimedMockAttempt(id);
      if (requestSequence.current !== requestId || saveAttemptId.current !== id) return;
      installAttempt(restored);
      setPendingOperation(null);
      setStatus(
        restored.attempt.state === "completed"
          ? "The server finalized this mock. Its result is shown below."
          : checkExpiry
            ? "The deadline is checked with the server; the mock remains in progress."
            : "Reloaded the latest server-acknowledged progress.",
      );
      await refreshAttempts();
    } catch (cause) {
      if (requestSequence.current === requestId) setError(errorMessage(cause));
    } finally {
      if (requestSequence.current === requestId) updateBusy(false);
    }
  }

  async function sendPendingOperation(operation: PendingOperation) {
    if (!attempt || saveAttemptId.current !== attempt.attempt.id) return;
    updateBusy(true);
    setError("");
    setStatus("Saving this answer and position on the server.");
    try {
      const updated =
        operation.kind === "answer"
          ? await saveTimedMockAnswer(attempt.attempt.id, {
              expectedVersion: operation.expectedVersion,
              requestId: operation.requestId,
              position: operation.position,
              selectedOptionKey: operation.selectedOptionKey,
            })
          : await saveTimedMockPosition(attempt.attempt.id, {
              expectedVersion: operation.expectedVersion,
              requestId: operation.requestId,
              position: operation.position,
            });
      if (saveAttemptId.current !== attempt.attempt.id) return;
      installAttempt(updated);
      setPendingOperation(null);
      setStatus("Saved on the server.");
    } catch (cause) {
      setError(errorMessage(cause));
      if (
        cause instanceof LearnerPracticeApiError &&
        cause.status === 409 &&
        cause.code === "deadline_reached"
      ) {
        try {
          const finalized = await getTimedMockAttempt(attempt.attempt.id);
          installAttempt(finalized);
          setPendingOperation(null);
          setStatus("The server finalized the timed-out mock from acknowledged answers.");
          await refreshAttempts();
        } catch (refreshError) {
          setError(errorMessage(refreshError));
        }
      }
    } finally {
      updateBusy(false);
    }
  }

  function saveAnswer() {
    if (!attempt || !currentItem || !selectedOptionKey || !dirty || busy) return;
    const operation: PendingOperation = {
      kind: "answer",
      expectedVersion: attempt.attempt.version,
      position: currentItem.position,
      selectedOptionKey,
      requestId: crypto.randomUUID(),
    };
    setPendingOperation(operation);
    void sendPendingOperation(operation);
  }

  function retrySave() {
    if (pendingOperation) void sendPendingOperation(pendingOperation);
  }

  async function navigateTo(position: number) {
    if (!attempt || busy || position === attempt.attempt.currentPosition) return;
    if (dirty) {
      setUnansweredNavigation(position);
      return;
    }
    const operation: PendingOperation = {
      kind: "navigate",
      expectedVersion: attempt.attempt.version,
      position,
      requestId: crypto.randomUUID(),
    };
    setPendingOperation(operation);
    await sendPendingOperation(operation);
  }

  async function confirmNavigation() {
    if (unansweredNavigation === null || !attempt) return;
    const position = unansweredNavigation;
    setUnansweredNavigation(null);
    setSelectedOptionKey(acknowledgedKey);
    const operation: PendingOperation = {
      kind: "navigate",
      expectedVersion: attempt.attempt.version,
      position,
      requestId: crypto.randomUUID(),
    };
    setPendingOperation(operation);
    await sendPendingOperation(operation);
  }

  async function submitMock() {
    if (!attempt || busy || dirty || pendingOperation) return;
    setSubmitConfirmation(false);
    updateBusy(true);
    setError("");
    const requestId = submitRequestId.current ?? crypto.randomUUID();
    submitRequestId.current = requestId;
    try {
      const result = await submitTimedMock(attempt.attempt.id, {
        expectedVersion: attempt.attempt.version,
        requestId,
      });
      installAttempt(result);
      setStatus(
        result.attempt.completionReason === "timed_out"
          ? "Time expired. The server finalized your acknowledged answers."
          : "Your mock is submitted and locked.",
      );
      submitRequestId.current = null;
      await refreshAttempts();
    } catch (cause) {
      setError(errorMessage(cause));
      if (
        cause instanceof LearnerPracticeApiError &&
        cause.status === 409 &&
        cause.code === "deadline_reached"
      ) {
        try {
          const finalized = await getTimedMockAttempt(attempt.attempt.id);
          installAttempt(finalized);
          setStatus("The server finalized the timed-out mock from acknowledged answers.");
          submitRequestId.current = null;
          await refreshAttempts();
        } catch (refreshError) {
          setError(errorMessage(refreshError));
        }
      }
    } finally {
      updateBusy(false);
    }
  }

  function exitMock() {
    stopDeadlineRecovery();
    deadlineCheckAttempt.current = null;
    if (attempt) {
      setAttempts((current) =>
        current.map((summary) =>
          summary.id === attempt.attempt.id ? attempt.attempt : summary,
        ),
      );
    }
    setAttempt(null);
    setLinkedAttemptId(null);
    saveAttemptId.current = null;
    setSelectedOptionKey("");
    setPendingOperation(null);
    setLeaveConfirmation(false);
    setStatus("Your acknowledged mock progress and deadline remain saved on the server.");
    if (requestedAttemptId) setClearLinkedAttemptOnExit(true);
  }

  if (loading || linkIsPending) {
    return (
      <section className="card" aria-busy="true">
        <p className="eyebrow">CertPath practice</p>
        <h1>Loading timed mocks</h1>
        <p>Checking your session and Standard access.</p>
      </section>
    );
  }

  return (
    <section className="learner-practice timed-mock">
      <p className="eyebrow">CertPath practice · server-timed</p>
      <h1>Timed mock exam</h1>
      <p className="intro">
        A fixed 15-minute, 10-question practice mock. Your timer continues while
        you are away. This is CertPath practice, not an official certification exam.
      </p>

      {error && <p className="form-errors" role="alert">{error}</p>}
      {status && <p className="save-status" role="status">{status}</p>}

      {blocker.state === "blocked" && (
        <section className="card navigation-warning" role="alertdialog" aria-labelledby="mock-leave-title">
          <h2 id="mock-leave-title">Leave this mock?</h2>
          <p>
            This answer is not acknowledged by the server yet. Leaving may
            discard the selected answer; the deadline continues.
          </p>
          <div className="practice-actions">
            <button className="button-secondary" type="button" onClick={() => blocker.reset()}>
              Stay on this page
            </button>
            <button className="button-primary" type="button" onClick={() => blocker.proceed()}>
              Leave mock
            </button>
          </div>
        </section>
      )}

      {unansweredNavigation !== null && (
        <section className="card navigation-warning" role="alertdialog" aria-labelledby="mock-answer-leave-title">
          <h2 id="mock-answer-leave-title">Discard this unsaved answer?</h2>
          <p>The selected answer has not been acknowledged. Staying keeps it selected.</p>
          <div className="practice-actions">
            <button
              className="button-secondary"
              type="button"
              onClick={() => setUnansweredNavigation(null)}
            >
              Stay on this question
            </button>
            <button className="button-primary" type="button" onClick={() => void confirmNavigation()}>
              Discard and change question
            </button>
          </div>
        </section>
      )}

      {leaveConfirmation && (
        <section className="card navigation-warning" role="alertdialog" aria-labelledby="mock-exit-title">
          <h2 id="mock-exit-title">Leave the timed mock?</h2>
          <p>
            {dirty
              ? "Your selected answer is not saved and will be discarded. The timer continues and acknowledged answers remain saved."
              : "The timer continues while you are away. Acknowledged answers and the deadline are saved."}
          </p>
          <div className="practice-actions">
            <button className="button-secondary" type="button" onClick={() => setLeaveConfirmation(false)}>
              Stay in mock
            </button>
            <button className="button-primary" type="button" onClick={exitMock}>
              Leave mock
            </button>
          </div>
        </section>
      )}

      {submitConfirmation && attempt && (
        <section className="card navigation-warning" role="alertdialog" aria-labelledby="mock-submit-title">
          <h2 id="mock-submit-title">Submit this mock?</h2>
          <p>
            {attempt.attempt.questionCount - attempt.attempt.answeredCount} unanswered
            {" "}question(s) will be scored as unanswered. Submission locks the result.
          </p>
          <div className="practice-actions">
            <button className="button-secondary" type="button" onClick={() => setSubmitConfirmation(false)}>
              Continue mock
            </button>
            <button className="button-primary" type="button" onClick={() => void submitMock()}>
              Submit mock
            </button>
          </div>
        </section>
      )}

      {!attempt ? (
        <div className="card mock-setup">
          <h2>Choose an authorized exam</h2>
          {scopes.length === 0 ? (
            <p>
              No active Standard access or configured CertPath practice mock is
              available for this session.
            </p>
          ) : (
            <>
              <label>
                Certification and exam version
                <select
                  value={scopeKeyValue}
                  onChange={(event) => setScopeKeyValue(event.currentTarget.value)}
                >
                  {scopes.map((item) => (
                    <option key={scopeKey(item)} value={scopeKey(item)}>
                      {item.certificationName} · {item.examVersionTitle}
                    </option>
                  ))}
                </select>
              </label>
              {scope?.mockProfile && (
                <p>
                  CertPath practice · {Math.floor(scope.mockProfile.durationSeconds / 60)} minutes
                  {" · "}{scope.mockProfile.questionCount} questions · revisit and
                  change acknowledged answers until you submit.
                </p>
              )}
              <button
                className="button-primary"
                type="button"
                disabled={!scope?.mockProfile || busy}
                onClick={() => void startMock()}
              >
                {busy ? "Starting…" : "Start timed mock"}
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="practice-column">
          {completed ? (
            <>
              <header className="mock-results-heading">
                <p className="eyebrow">
                  {attempt.attempt.completionReason === "timed_out"
                    ? "Time expired"
                    : "Submitted"}
                </p>
                <h2>Mock results</h2>
                <p className="mock-score">
                  {attempt.attempt.correctCount} / {attempt.attempt.questionCount} correct
                </p>
                <p role="status">
                  {attempt.attempt.completionReason === "timed_out"
                    ? "Finalized automatically from answers acknowledged before the deadline."
                    : "This result is finalized and cannot be changed."}
                </p>
              </header>
              {attempt.items.map((item) => (
                <article className="card practice-question-card" key={item.position}>
                  <p className="eyebrow">Question {item.position + 1}</p>
                  <h3>{item.stem}</h3>
                  <ul className="mock-result-options">
                    {item.options.map((option) => (
                      <li
                        key={option.key}
                        className={
                          option.key === item.correctOptionKey
                            ? "mock-result-option--correct"
                            : option.key === item.selectedOptionKey
                              ? "mock-result-option--incorrect"
                              : undefined
                        }
                      >
                        <strong>{option.key}.</strong> {option.text}
                        {option.key === item.selectedOptionKey && " · Your answer"}
                        {option.key === item.correctOptionKey && " · Correct answer"}
                        {option.explanation && <p>{option.explanation}</p>}
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
              <button className="button-secondary" type="button" onClick={exitMock}>
                Back to timed mocks
              </button>
            </>
          ) : (
            <>
              <div className="timed-mock-header">
                <div>
                  <p className="eyebrow">
                    Question {attempt.attempt.currentPosition + 1} of {attempt.attempt.questionCount}
                  </p>
                  <h2>CertPath practice mock</h2>
                </div>
                <div
                  className={`mock-countdown${remainingSeconds <= 60 ? " mock-countdown--urgent" : ""}`}
                  role="timer"
                  aria-label={`${Math.floor(remainingSeconds / 60)} minutes ${remainingSeconds % 60} seconds remaining`}
                  aria-live="off"
                >
                  <span>Time remaining</span>
                  <strong>{formatTime(remainingSeconds)}</strong>
                </div>
              </div>

              <div className="mock-question-navigation" aria-label="Mock questions">
                {attempt.items.map((item) => (
                  <button
                    className={
                      item.position === attempt.attempt.currentPosition
                        ? "mock-question-index mock-question-index--current"
                        : item.selectedOptionKey
                          ? "mock-question-index mock-question-index--answered"
                          : "mock-question-index"
                    }
                    key={item.position}
                    type="button"
                    aria-current={
                      item.position === attempt.attempt.currentPosition ? "step" : undefined
                    }
                    aria-label={`Question ${item.position + 1}${item.selectedOptionKey ? ", answered" : ", unanswered"}`}
                    disabled={busy}
                    onClick={() => void navigateTo(item.position)}
                  >
                    {item.position + 1}
                  </button>
                ))}
              </div>

              {currentItem && (
                <article className="card practice-question-card">
                  <h3>{currentItem.stem}</h3>
                  <fieldset className="answer-options" disabled={busy}>
                    <legend>Choose one answer</legend>
                    {currentItem.options.map((option) => (
                      <label className="answer-option-label" key={option.key}>
                        <input
                          type="radio"
                          name={`mock-answer-${currentItem.position}`}
                          value={option.key}
                          checked={selectedOptionKey === option.key}
                          onChange={() => setSelectedOptionKey(option.key)}
                        />
                        <span><strong>{option.key}.</strong> {option.text}</span>
                      </label>
                    ))}
                  </fieldset>
                  <div className="practice-actions">
                    <button
                      className="button-primary"
                      type="button"
                      disabled={!dirty || !selectedOptionKey || busy}
                      onClick={saveAnswer}
                    >
                      {busy ? "Saving…" : "Save answer"}
                    </button>
                    <button
                      className="button-secondary"
                      type="button"
                      disabled={busy || attempt.attempt.currentPosition === 0}
                      onClick={() => void navigateTo(attempt.attempt.currentPosition - 1)}
                    >
                      Previous
                    </button>
                    <button
                      className="button-secondary"
                      type="button"
                      disabled={
                        busy ||
                        attempt.attempt.currentPosition + 1 >= attempt.attempt.questionCount
                      }
                      onClick={() => void navigateTo(attempt.attempt.currentPosition + 1)}
                    >
                      Next
                    </button>
                  </div>
                  {pendingOperation && error && (
                    <button className="button-secondary" type="button" disabled={busy} onClick={retrySave}>
                      Retry the same save
                    </button>
                  )}
                  {error.includes("changed in another session") && (
                    <button
                      className="button-secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (
                          dirty &&
                          !window.confirm(
                            "Reload saved progress? Your currently selected answer is not acknowledged and will be discarded.",
                          )
                        ) return;
                        void reloadAttempt();
                      }}
                    >
                      Reload saved progress
                    </button>
                  )}
                </article>
              )}

              <div className="mock-actions">
                <button
                  className="button-secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => setLeaveConfirmation(true)}
                >
                  Save &amp; exit
                </button>
                <button
                  className="button-primary"
                  type="button"
                  disabled={busy || dirty || Boolean(pendingOperation)}
                  onClick={() => setSubmitConfirmation(true)}
                >
                  Submit mock
                </button>
                <button
                  className="button-secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => void reloadAttempt(true)}
                >
                  Refresh server state
                </button>
              </div>
              {dirty && (
                <p className="mock-unsaved" role="status">
                  This answer is not saved. Save it before leaving or submitting.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {!attempt && attempts.length > 0 && (
        <section className="card mock-attempt-list">
          <h2>Saved CertPath practice mocks</h2>
          <ul>
            {attempts.map((summary) => (
              <li key={summary.id}>
                <span>
                  <strong>{summary.state === "completed" ? "Completed" : "In progress"}</strong>
                  {" · "}{summary.answeredCount} of {summary.questionCount} answered
                  {" · "}{summary.state === "completed"
                    ? summary.completionReason === "timed_out" ? "Time expired" : "Submitted"
                    : "Timer continues while away"}
                </span>
                <button
                  className="button-secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => void openMock(summary)}
                >
                  {summary.state === "completed" ? "View results" : "Resume"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
