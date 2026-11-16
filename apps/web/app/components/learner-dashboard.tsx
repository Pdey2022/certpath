import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  getLearnerDashboard,
  LearnerPracticeApiError,
  signOutLearner,
  type LearnerDashboard,
} from "../lib/learner-practice-api";

function errorMessage(error: unknown): string {
  if (!(error instanceof LearnerPracticeApiError)) {
    return "Your progress is temporarily unavailable. Try loading it again.";
  }
  if (error.status === 401) {
    return "Your session is missing or expired. Sign in through the configured account provider to continue.";
  }
  if (error.status === 403 && error.code === "access_required") {
    return "Active Standard access is required to view protected progress.";
  }
  if (error.status === 0) return "The network is unavailable. Try loading your progress again.";
  return "Your progress is temporarily unavailable. Try loading it again.";
}

function attemptUrl(kind: "practice" | "timed_mock", attemptId: string): string {
  const path =
    kind === "practice" ? "/app/practice/live" : "/app/mock/live";
  return `${path}?attemptId=${encodeURIComponent(attemptId)}`;
}

function deadlineLabel(deadlineAt: number, now: number): string {
  if (deadlineAt <= now) {
    return "Deadline passed. Open this mock to check its finalized result.";
  }
  const date = new Date(deadlineAt);
  return `Deadline ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)}`;
}

function AttemptCard({
  group,
  attempt,
}: {
  group: LearnerDashboard["groups"][number];
  attempt: LearnerDashboard["groups"][number]["resumable"][number] |
    LearnerDashboard["groups"][number]["completed"][number];
}) {
  const timedMock = attempt.kind === "timed_mock";
  const label = timedMock ? "Timed mock" : "Untimed practice";
  const completed = attempt.state === "completed";
  const href = attemptUrl(attempt.kind, attempt.id);

  return (
    <article className="card learner-dashboard-attempt">
      <div>
        <p className="eyebrow">{label}</p>
        <h4>
          {completed
            ? "Completed attempt"
            : `${attempt.answeredCount} of ${attempt.questionCount} answered`}
        </h4>
        <p>
          {completed
            ? `${attempt.correctCount ?? 0} / ${attempt.questionCount} correct`
            : `Question ${Math.min(attempt.currentPosition + 1, attempt.questionCount)} of ${attempt.questionCount}`}
        </p>
        {timedMock && attempt.deadlineAt !== undefined && !completed && (
          <p>{deadlineLabel(attempt.deadlineAt, Date.now())}</p>
        )}
        {completed && attempt.completedAt !== null && (
          <p>
            Completed{" "}
            {new Intl.DateTimeFormat(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(attempt.completedAt)}
          </p>
        )}
        {!completed && (
          <progress
            value={attempt.answeredCount}
            max={attempt.questionCount}
            aria-label={`${label}: ${attempt.answeredCount} of ${attempt.questionCount} questions answered`}
          />
        )}
      </div>
      <Link
        className="button-primary learner-dashboard-open"
        to={href}
        aria-label={`${completed ? "View" : "Resume"} ${label.toLowerCase()} for ${group.certificationName} ${group.versionKey}`}
      >
        {completed ? "View result" : "Resume"}
      </Link>
    </article>
  );
}

function readinessBandLabel(band: "low" | "medium" | "ready"): string {
  if (band === "ready") return "In form";
  return band === "medium" ? "Building up" : "Early days";
}

function basisLine(basis: {
  mocks: number;
  questions: number;
  blueprintWeighted: boolean;
}): string {
  const mocks = basis.mocks === 1 ? "1 mock" : `${basis.mocks} mocks`;
  const questions =
    basis.questions === 1 ? "1 question" : `${basis.questions} questions`;
  return `${mocks}, ${questions}${
    basis.blueprintWeighted ? ", blueprint-weighted" : ""
  }`;
}

function ReadinessPanel({
  group,
}: {
  group: LearnerDashboard["groups"][number];
}) {
  const readiness = group.readiness;

  if (!readiness) {
    return (
      <section className="card learner-dashboard-section">
        <h3>Readiness</h3>
        <p>
          No timed mock yet. Readiness appears once you have completed one —
          practice alone cannot raise it.
        </p>
      </section>
    );
  }

  if (!readiness.isCurrent) {
    return (
      <section className="card learner-dashboard-section">
        <h3>Readiness</h3>
        <p>
          Your last readiness check is more than 14 days old, so it no longer
          counts. Sit another timed mock to refresh it.
        </p>
      </section>
    );
  }

  return (
    <section className="card learner-dashboard-section">
      <h3>Readiness</h3>
      <p>
        <strong>{readinessBandLabel(readiness.band)}</strong> ·{" "}
        {readiness.score}% · {basisLine(readiness.basis)}
      </p>
      <p>
        {readiness.isReady
          ? "You have met the readiness rule for this exam."
          : "Keep going: the readiness rule needs more consistent mock results."}
      </p>
      {readiness.nextAction && (
        <p>
          Focus next: <strong>{readiness.nextAction.title}</strong> (
          {readiness.nextAction.accuracy}% across{" "}
          {readiness.nextAction.questions} questions)
        </p>
      )}
      {readiness.proPrompt && (
        <p>
          Pro is available for this exam while your Standard access covers a
          full Pro term.
        </p>
      )}
    </section>
  );
}

export function LearnerDashboard() {
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState<LearnerDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");

  async function loadDashboard() {
    setLoading(true);
    setError("");
    try {
      setDashboard(await getLearnerDashboard());
    } catch (cause) {
      setError(errorMessage(cause));
      setDashboard(null);
    } finally {
      setLoading(false);
    }
  }

  async function signOut() {
    setSigningOut(true);
    setSignOutError("");
    try {
      await signOutLearner();
      navigate("/sign-in", { replace: true });
    } catch {
      setSignOutError("Unable to sign out right now. Please try again.");
    } finally {
      setSigningOut(false);
    }
  }

  useEffect(() => {
    void loadDashboard();
  }, []);

  return (
    <section className="learner-dashboard" aria-busy={loading}>
      <p className="eyebrow">Protected learner workspace</p>
      <h1>Your learning dashboard</h1>
      <p className="intro">
        Resume saved attempts or review your recent results by certification
        and exam version.
      </p>
      <button
        className="button-secondary"
        type="button"
        onClick={() => void signOut()}
        disabled={signingOut}
      >
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
      {signOutError && (
        <p className="form-errors" role="alert">
          {signOutError}
        </p>
      )}

      {loading && (
        <p className="card" role="status">Loading your authorized progress…</p>
      )}

      {error && (
        <div className="form-errors" role="alert">
          <p>{error}</p>
          <button
            className="button-secondary"
            type="button"
            onClick={() => void loadDashboard()}
          >
            Retry loading progress
          </button>
        </div>
      )}

      {!loading && !error && dashboard?.groups.length === 0 && (
        <section className="card learner-dashboard-empty">
          <h2>No active exam access</h2>
          <p>
            No certification currently has active Standard access. Protected
            progress is retained, but is unavailable until access is restored.
          </p>
        </section>
      )}

      {!loading && !error && dashboard && dashboard.groups.length > 0 && (
        <div className="learner-dashboard-groups">
          {dashboard.groups.map((group) => (
            <section
              className="learner-dashboard-group"
              key={`${group.certificationId}:${group.examVersionId}`}
              aria-labelledby={`dashboard-${group.certificationId}-${group.examVersionId}`}
            >
              <header className="learner-dashboard-group-heading">
                <p className="eyebrow">Authorized exam</p>
                <h2 id={`dashboard-${group.certificationId}-${group.examVersionId}`}>
                  {group.certificationName}
                </h2>
                <p>{group.versionKey} · {group.examVersionTitle}</p>
              </header>

              {group.access.state !== "active" && (
                <p className="card" role="status">
                  Your access ended. Read-only for{" "}
                  {group.access.graceDaysRemaining}{" "}
                  {group.access.graceDaysRemaining === 1 ? "day" : "days"} — renew
                  to start new practice or mocks.
                </p>
              )}

              <ReadinessPanel group={group} />

              {group.resumable.length > 0 && (
                <div className="learner-dashboard-section">
                  <h3>Continue where you left off</h3>
                  <div className="learner-dashboard-attempts">
                    {group.resumable.map((attempt) => (
                      <AttemptCard
                        key={`${attempt.kind}:${attempt.id}`}
                        group={group}
                        attempt={attempt}
                      />
                    ))}
                  </div>
                </div>
              )}

              {group.completed.length > 0 && (
                <div
                  className="learner-dashboard-section"
                  id="recent-history"
                >
                  <h3>Recent completed attempts</h3>
                  <div className="learner-dashboard-attempts">
                    {group.completed.map((attempt) => (
                      <AttemptCard
                        key={`${attempt.kind}:${attempt.id}`}
                        group={group}
                        attempt={attempt}
                      />
                    ))}
                  </div>
                </div>
              )}

              {group.resumable.length === 0 && group.completed.length === 0 && (
                <p className="card">No practice or mock attempts for this exam yet.</p>
              )}
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
