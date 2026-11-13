import { useState, type FormEvent } from "react";
import type { Route } from "./+types/learner-sign-in";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  isStagingLearnerAuth,
  LearnerAuthApiError,
  registerLearner,
  signInLearner,
} from "../lib/learner-auth-api";
import {
  PublicLayout,
  useLearnerSignInAvailability,
} from "../components/public-layout";

export function headers() {
  return {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Learner sign in | Exam Prep" },
    { name: "robots", content: "noindex,nofollow" },
  ];
}

type AuthMode = "sign_in" | "register";

function messageForError(error: unknown): string {
  if (!(error instanceof LearnerAuthApiError)) {
    return "Sign-in could not be completed. Please try again.";
  }
  if (error.code === "invalid_credentials") {
    return "Email or password is incorrect, or the email has not been verified.";
  }
  if (error.code === "rate_limited") {
    return "Too many attempts. Wait a while before trying again.";
  }
  if (error.code === "synthetic_email_required") {
    return isStagingLearnerAuth()
      ? "Use the pre-provisioned synthetic staging learner account."
      : "Use a synthetic address ending in @example.test for this local proof.";
  }
  return "Sign-in could not be completed. Please try again.";
}

function googleErrorMessage(code: string): string {
  if (code === "not_invited") {
    return "This Google account is not invited to the CertPath pilot.";
  }
  if (code === "invalid_identity_token") {
    return "Google sign-in could not be verified. Please try again.";
  }
  if (code === "provider_error") {
    return "Google sign-in did not complete. Please try again.";
  }
  return "Google sign-in could not be completed. Please try again.";
}

function LearnerSignInContent() {
  const availability = useLearnerSignInAvailability();
  const isStaging = isStagingLearnerAuth();
  const [searchParams] = useSearchParams();
  const googleError = searchParams.get("error");
  const navigate = useNavigate();
  const [mode, setMode] = useState<AuthMode>("sign_in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (mode === "register") {
        const result = await registerLearner(email);
        setMessage(result.message);
      } else {
        const result = await signInLearner(email, password);
        navigate(result.redirectTo, { replace: true });
      }
    } catch (cause) {
      setError(messageForError(cause));
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <main id="main-content" className="public-main">
      <section className="hero" aria-labelledby="learner-sign-in-title">
        <p className="eyebrow">Learner access</p>
        <h1 id="learner-sign-in-title">Learner sign in</h1>
        {availability === "enabled" && (
          <section className="card setup-card" aria-label="Email and password sign-in">
            <p className="intro">
              {isStaging
                ? "Sign in with the pre-provisioned synthetic staging learner. Passwords are verified by the isolated staging service."
                : "This local proof accepts synthetic addresses ending in @example.test. Passwords are verified by CertPath in the local Worker; email is delivered only to the local test inbox. Choose a password when you verify your email."}
            </p>
            {!isStaging && (
              <div className="button-row" role="group" aria-label="Account action">
                <button
                  type="button"
                  className={mode === "sign_in" ? "button-primary" : "button-secondary"}
                  aria-pressed={mode === "sign_in"}
                  onClick={() => {
                    setMode("sign_in");
                    setPassword("");
                    setError("");
                    setMessage("");
                  }}
                >
                  Sign in
                </button>
                <button
                  type="button"
                  className={mode === "register" ? "button-primary" : "button-secondary"}
                  aria-pressed={mode === "register"}
                  onClick={() => {
                    setMode("register");
                    setPassword("");
                    setError("");
                    setMessage("");
                  }}
                >
                  Create account
                </button>
              </div>
            )}
            {googleError && (
              <p className="form-errors" role="alert">
                {googleErrorMessage(googleError)}
              </p>
            )}
            {isStaging && (
              <div
                className="button-row"
                role="group"
                aria-label="Google sign-in"
              >
                <a className="button-primary" href="/api/auth/google/start">
                  Continue with Google
                </a>
              </div>
            )}
            {error && <p className="form-errors" role="alert">{error}</p>}
            {message && (
              <p className="card" role="status">
                {message}
              </p>
            )}
            <form className="editor-form" autoComplete="off" onSubmit={submit}>
              <div className="form-grid">
                <label>
                  Email address
                  <input
                    type="email"
                    name="email"
                    autoComplete="off"
                    required
                    maxLength={254}
                    value={email}
                    onChange={(event) => setEmail(event.currentTarget.value)}
                  />
                </label>
                {(mode === "sign_in" || isStaging) && (
                  <label>
                    Password
                    <input
                      type="password"
                      name="password"
                      autoComplete="off"
                      required
                      minLength={1}
                      maxLength={1024}
                      value={password}
                      onChange={(event) => setPassword(event.currentTarget.value)}
                    />
                  </label>
                )}
              </div>
              <div className="button-row">
                <button className="button-primary" type="submit" disabled={busy}>
                  {busy
                    ? "Please wait…"
                    : mode === "register" && !isStaging
                      ? "Send verification email"
                      : "Sign in"}
                </button>
                {!isStaging && mode === "sign_in" && (
                  <Link className="button-link" to="/recover-password">
                    Forgot password?
                  </Link>
                )}
              </div>
            </form>
            {!isStaging && (
              <p>
                <Link to="/local-inbox">Open the synthetic local test inbox</Link>
              </p>
            )}
          </section>
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
