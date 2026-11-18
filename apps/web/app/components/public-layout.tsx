import { createContext, useContext, useEffect, useState } from "react";
import { Link } from "react-router";
import { isUiPreview } from "../lib/preview-mode";
import {
  getLearnerAuthPreflight,
  getLearnerEmailLinkPreflight,
  isPilotSite,
  isStagingLearnerAuth,
} from "../lib/learner-auth-api";
import { isPublicReleaseSite } from "../lib/release-mode";
import { demoLink, independenceNotice } from "../lib/site-content";

type LearnerAuthAvailability =
  | "checking"
  | "enabled"
  | "disabled"
  | "unavailable";

export type LearnerSignInAvailability = {
  password: LearnerAuthAvailability;
  emailLink: LearnerAuthAvailability;
};

const closedAvailability: LearnerSignInAvailability = {
  password: "unavailable",
  emailLink: "disabled",
};

const checkingAvailability: LearnerSignInAvailability = {
  password: "checking",
  emailLink: "checking",
};

const LearnerSignInAvailabilityContext =
  createContext<LearnerSignInAvailability>(closedAvailability);

/**
 * The email-link proof is local-only, so its preflight is skipped on the
 * release, pilot, preview, and staging origins where it cannot apply.
 */
function emailLinkApplies(): boolean {
  return (
    !isUiPreview &&
    !isPublicReleaseSite &&
    !isPilotSite() &&
    !isStagingLearnerAuth()
  );
}

function closedStatus(
  availability: LearnerSignInAvailability,
): "checking" | "disabled" | "unavailable" {
  if (
    availability.password === "checking" ||
    availability.emailLink === "checking"
  ) {
    return "checking";
  }
  if (
    availability.password === "unavailable" ||
    availability.emailLink === "unavailable"
  ) {
    return "unavailable";
  }
  return "disabled";
}

async function checkPasswordAvailability(): Promise<LearnerAuthAvailability> {
  try {
    const body = await getLearnerAuthPreflight();
    return body.signInEnabled ? "enabled" : "disabled";
  } catch {
    return "unavailable";
  }
}

async function checkEmailLinkAvailability(): Promise<LearnerAuthAvailability> {
  try {
    const body = await getLearnerEmailLinkPreflight();
    return body.signInEnabled ? "enabled" : "disabled";
  } catch {
    return "unavailable";
  }
}

export function useLearnerSignInAvailability() {
  return useContext(LearnerSignInAvailabilityContext);
}

export function PublicLayout({ children }: { children: React.ReactNode }) {
  const skippedSite = isUiPreview || isPublicReleaseSite || isPilotSite();
  const withEmailLink = emailLinkApplies();
  const [availability, setAvailability] = useState<LearnerSignInAvailability>(
    skippedSite
      ? closedAvailability
      : withEmailLink
        ? checkingAvailability
        : { password: "checking", emailLink: "disabled" },
  );

  useEffect(() => {
    if (skippedSite) return;
    let active = true;
    void (async () => {
      const password = await checkPasswordAvailability();
      const emailLink = withEmailLink
        ? await checkEmailLinkAvailability()
        : "disabled";
      if (active) setAvailability({ password, emailLink });
    })();
    return () => {
      active = false;
    };
  }, [skippedSite, withEmailLink]);

  const anyEnabled =
    availability.password === "enabled" || availability.emailLink === "enabled";

  return (
    <LearnerSignInAvailabilityContext.Provider value={availability}>
      <>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <header className="public-header">
          <div className="public-header-inner">
            <Link className="brand" to="/">
              CertPath
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
              ) : isPilotSite() ? (
                <Link to="/sign-in">Learner sign in</Link>
              ) : anyEnabled ? (
                <Link to="/sign-in">Learner sign in</Link>
              ) : (
                <span className="public-nav-status" role="status">
                  {closedStatus(availability) === "checking"
                    ? "Checking learner sign-in…"
                    : closedStatus(availability) === "disabled"
                      ? "Learner sign-in disabled"
                      : "Learner sign-in unavailable"}
                </span>
              )}
              {!isUiPreview && !isPublicReleaseSite && !isPilotSite() && (
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
                Certification listings and content require review before
                publication.
              </p>
            )}
          </div>
        </footer>
      </>
    </LearnerSignInAvailabilityContext.Provider>
  );
}