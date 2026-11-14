import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  LearnerAuthApiError,
  readLocalTestInbox,
  requestLearnerPasswordReset,
  resetLearnerPassword,
  verifyLearnerEmail,
} from "../lib/learner-auth-api";
import { PublicLayout } from "./public-layout";

function errorText(error: unknown): string {
  if (error instanceof LearnerAuthApiError && error.code === "rate_limited") {
    return "Too many attempts. Wait a while before trying again.";
  }
  if (
    error instanceof LearnerAuthApiError &&
    error.code === "invalid_or_expired_link"
  ) {
    return "This link is invalid, expired, or has already been used.";
  }
  return "The request could not be completed. Please try again.";
}

export function takeFragmentToken(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
  return token;
}

export function LearnerVerifyEmailRoute() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const verificationToken = takeFragmentToken();
    if (!verificationToken) {
      setError("This verification link is missing or invalid.");
      return;
    }
    setToken(verificationToken);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const result = await verifyLearnerEmail(token, password);
      setMessage(result.message);
      setToken(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <PublicLayout>
      <main id="main-content" className="public-main">
        <section className="card setup-card">
          <h1>Verify your email</h1>
          {message && <p role="status">{message}</p>}
          {error && <p className="form-errors" role="alert">{error}</p>}
          {token && (
            <form className="editor-form" autoComplete="off" onSubmit={submit}>
              <label>
                Choose a password
                <input
                  type="password"
                  name="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={1024}
                  value={password}
                  onChange={(event) => setPassword(event.currentTarget.value)}
                />
              </label>
              <button className="button-primary" type="submit" disabled={busy}>
                {busy ? "Please wait…" : "Verify email and set password"}
              </button>
            </form>
          )}
          <Link to="/sign-in">Return to learner sign in</Link>
        </section>
      </main>
    </PublicLayout>
  );
}

export function LearnerRecoveryRoute() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const result = await requestLearnerPasswordReset(email);
      setMessage(result.message);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicLayout>
      <main id="main-content" className="public-main">
        <section className="card setup-card">
          <h1>Reset your password</h1>
          <p>Enter your synthetic learner address to request a reset link.</p>
          {message && <p role="status">{message}</p>}
          {error && <p className="form-errors" role="alert">{error}</p>}
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
            </div>
            <button className="button-primary" type="submit" disabled={busy}>
              {busy ? "Please wait…" : "Send reset link"}
            </button>
          </form>
          <p><Link to="/local-inbox">Open the synthetic local test inbox</Link></p>
        </section>
      </main>
    </PublicLayout>
  );
}

export function LearnerResetPasswordRoute() {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const resetToken = takeFragmentToken();
    if (resetToken) setToken(resetToken);
    else setError("This reset link is missing or invalid.");
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const result = await resetLearnerPassword(token, password);
      setMessage(result.message);
      setToken("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <PublicLayout>
      <main id="main-content" className="public-main">
        <section className="card setup-card">
          <h1>Choose a new password</h1>
          {message && <p role="status">{message}</p>}
          {error && <p className="form-errors" role="alert">{error}</p>}
          {!token && !message && !error && (
            <p role="status">Checking the reset link…</p>
          )}
          {token && (
            <form className="editor-form" autoComplete="off" onSubmit={submit}>
              <div className="form-grid">
                <label>
                  New password
                  <input
                    type="password"
                    name="password"
                    autoComplete="off"
                    required
                    minLength={12}
                    maxLength={1024}
                    value={password}
                    onChange={(event) => setPassword(event.currentTarget.value)}
                  />
                </label>
              </div>
              <button className="button-primary" type="submit" disabled={busy}>
                {busy ? "Please wait…" : "Update password"}
              </button>
            </form>
          )}
          <p><Link to="/sign-in">Return to learner sign in</Link></p>
        </section>
      </main>
    </PublicLayout>
  );
}

export function LearnerLocalInboxRoute() {
  const [email, setEmail] = useState("");
  const [messages, setMessages] = useState<
    Awaited<ReturnType<typeof readLocalTestInbox>>["messages"]
  >([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setBusy(true);
    setError("");
    try {
      setMessages((await readLocalTestInbox(email)).messages);
    } catch (cause) {
      setMessages([]);
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicLayout>
      <main id="main-content" className="public-main">
        <section className="card setup-card">
          <h1>Local synthetic inbox</h1>
          <p>
            Messages exist only in this local Worker process and expire after
            24 hours. Use only addresses ending in @example.test.
          </p>
          {error && <p className="form-errors" role="alert">{error}</p>}
          <form className="editor-form" autoComplete="off" onSubmit={refresh}>
            <div className="form-grid">
              <label>
                Synthetic email address
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
            </div>
            <button className="button-primary" type="submit" disabled={busy}>
              {busy ? "Loading…" : "Show messages"}
            </button>
          </form>
          <ul aria-label="Local inbox messages">
            {messages.map((message) => (
              <li key={message.id}>
                {message.kind === "verify_email"
                  ? "Verify email"
                  : message.kind === "sign_in_link"
                    ? "Sign in link"
                    : "Reset password"}{" "}
                <a href={message.link}>Open single-use link</a>
              </li>
            ))}
          </ul>
          {messages.length === 0 && !busy && (
            <p role="status">No unexpired messages for this address.</p>
          )}
          <p><Link to="/sign-in">Return to learner sign in</Link></p>
        </section>
      </main>
    </PublicLayout>
  );
}
