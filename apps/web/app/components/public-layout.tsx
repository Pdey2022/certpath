import { createContext, useContext, useEffect, useState } from "react";
import { Link } from "react-router";
import { isUiPreview } from "../lib/preview-mode";
import { isPublicReleaseSite } from "../lib/release-mode";
import { demoLink, independenceNotice } from "../lib/site-content";
import { getLearnerAuthPreflight } from "../lib/learner-auth-api";

type LearnerSignInAvailability =
  | "checking"
  | "enabled"
  | "disabled"
  | "unavailable";

const LearnerSignInAvailabilityContext =
  createContext<LearnerSignInAvailability>("unavailable");

async function checkLearnerSignInAvailability(): Promise<LearnerSignInAvailability> {
  try {
    const body = await getLearnerAuthPreflight();
    return body.signInEnabled ? "enabled" : "disabled";
  } catch {
    return "unavailable";
  }
}

export function useLearnerSignInAvailability() {
  return useContext(LearnerSignInAvailabilityContext);
}

export function PublicLayout({ children }: { children: React.ReactNode }) {
  const [availability, setAvailability] = useState<LearnerSignInAvailability>(
    isUiPreview || isPublicReleaseSite ? "unavailable" : "checking",
  );

  useEffect(() => {
    if (isUiPreview || isPublicReleaseSite) return;
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
              {isPublicReleaseSite ? "CertPath" : "Exam Prep"}
            </Link>
            <nav className="public-nav" aria-label="Public navigation">
              <Link to="/exams">Exams</Link>
              {isPublicReleaseSite ? (
                <a href={demoLink.href}>{demoLink.label}</a>
              ) : isUiPreview ? (
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
              {!isUiPreview && !isPublicReleaseSite && (
                <Link to="/app">Learner preview</Link>
              )}
            </nav>
          </div>
        </header>
        {children}
        <footer className="public-footer">
          <div className="public-footer-inner">
            {isPublicReleaseSite ? (
              <p>{independenceNotice}</p>
            ) : (
              <p>
                Exam Prep is a working label. Certification listings and content
                require review before publication.
              </p>
            )}
          </div>
        </footer>
      </>
    </LearnerSignInAvailabilityContext.Provider>
  );
}
