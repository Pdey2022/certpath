import { createContext, useContext, useEffect, useState } from "react";
import { Link } from "react-router";
import { isUiPreview } from "../lib/preview-mode";

type LearnerSignInAvailability =
  | "checking"
  | "enabled"
  | "disabled"
  | "unavailable";

const LearnerSignInAvailabilityContext =
  createContext<LearnerSignInAvailability>("unavailable");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function checkLearnerSignInAvailability(): Promise<LearnerSignInAvailability> {
  let response: Response;
  try {
    response = await fetch("/api/auth/local/preflight", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch {
    return "unavailable";
  }
  if (!response.ok) return "unavailable";

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return "unavailable";
  }
  if (
    !isRecord(body) ||
    typeof body.signInEnabled !== "boolean" ||
    typeof body.localMailboxEnabled !== "boolean"
  ) {
    return "unavailable";
  }
  return body.signInEnabled ? "enabled" : "disabled";
}

export function useLearnerSignInAvailability() {
  return useContext(LearnerSignInAvailabilityContext);
}

export function PublicLayout({ children }: { children: React.ReactNode }) {
  const [availability, setAvailability] = useState<LearnerSignInAvailability>(
    isUiPreview ? "unavailable" : "checking",
  );

  useEffect(() => {
    if (isUiPreview) return;
    let active = true;
    void checkLearnerSignInAvailability().then((result) => {
      if (active) setAvailability(result);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <LearnerSignInAvailabilityContext.Provider value={availability}>
      <>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <header className="public-header">
          <div className="public-header-inner">
            <Link className="brand" to="/">
              Exam Prep
            </Link>
            <nav className="public-nav" aria-label="Public navigation">
              <Link to="/exams">Exams</Link>
              {isUiPreview ? (
                <>
                  <Link to="/app">Learner demo</Link>
                  <Link to="/admin?demoRole=manager">Manager demo</Link>
                  <Link to="/admin">Global Admin demo</Link>
                </>
              ) : availability === "enabled" ? (
                <Link to="/sign-in">Learner sign in</Link>
              ) : (
                <span className="public-nav-status" role="status">
                  {availability === "checking"
                    ? "Checking learner sign-in…"
                    : availability === "disabled"
                      ? "Learner sign-in disabled"
                      : "Learner sign-in unavailable"}
                </span>
              )}
              {!isUiPreview && <Link to="/app">Learner preview</Link>}
            </nav>
          </div>
        </header>
        {children}
        <footer className="public-footer">
          <div className="public-footer-inner">
            <p>
              Exam Prep is a working label. Certification listings and content
              require review before publication.
            </p>
          </div>
        </footer>
      </>
    </LearnerSignInAvailabilityContext.Provider>
  );
}
