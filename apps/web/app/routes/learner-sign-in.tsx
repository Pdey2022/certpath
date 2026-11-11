import type { Route } from "./+types/learner-sign-in";
import {
  PublicLayout,
  useLearnerSignInAvailability,
} from "../components/public-layout";

export function headers() {
  return {
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Learner sign in | Exam Prep" },
    { name: "robots", content: "noindex,nofollow" },
  ];
}

function LearnerSignInContent() {
  const availability = useLearnerSignInAvailability();

  return (
    <main id="main-content" className="public-main">
      <section className="hero" aria-labelledby="learner-sign-in-title">
        <p className="eyebrow">Learner access</p>
        <h1 id="learner-sign-in-title">Learner sign in</h1>
        {availability === "enabled" && (
          <>
            <p className="intro">
              Registration, email verification, password recovery, and
              sign-in happen with our hosted identity provider. CertPath
              never asks for or stores your password.
            </p>
            <a className="primary-link" href="/api/auth/cognito/start">
              Continue with email
            </a>
          </>
        )}
        {availability === "checking" && (
          <p className="card" role="status">
            Checking whether learner sign-in is enabled…
          </p>
        )}
        {availability === "disabled" && (
          <p className="card" role="status">
            Learner sign-in is currently disabled.
          </p>
        )}
        {availability === "unavailable" && (
          <p className="form-errors" role="alert">
            Sign-in availability could not be confirmed. No sign-in option is
            available right now.
          </p>
        )}
      </section>
    </main>
  );
}

export default function LearnerSignInRoute() {
  return (
    <PublicLayout>
      <LearnerSignInContent />
    </PublicLayout>
  );
}
