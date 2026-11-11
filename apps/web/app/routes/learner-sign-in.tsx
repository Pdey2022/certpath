import type { Route } from "./+types/learner-sign-in";
import { PublicLayout } from "../components/public-layout";

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

export default function LearnerSignInRoute() {
  return (
    <PublicLayout>
      <main id="main-content" className="public-main">
        <section className="hero" aria-labelledby="learner-sign-in-title">
          <p className="eyebrow">Learner access</p>
          <h1 id="learner-sign-in-title">Sign in or create your account.</h1>
          <p className="intro">
            Registration, email verification, password recovery, and sign-in
            happen with our hosted identity provider. CertPath never asks for
            or stores your password.
          </p>
          <a className="primary-link" href="/api/auth/cognito/start">
            Continue with email
          </a>
        </section>
      </main>
    </PublicLayout>
  );
}
