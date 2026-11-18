import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import {
  getStaffAuthPreflight,
  signInStaff,
  signOutStaff,
  StaffAuthApiError,
} from "../lib/staff-auth-api";

type Availability = "checking" | "enabled" | "disabled" | "unavailable";

function messageForError(error: unknown): string {
  if (!(error instanceof StaffAuthApiError)) {
    return "Sign-in could not be completed. Please try again.";
  }
  if (error.code === "invalid_credentials") {
    return "Email or password is incorrect.";
  }
  if (error.code === "rate_limited") {
    return "Too many attempts. Wait a while before trying again.";
  }
  if (error.code === "staff_mfa_unavailable") {
    return "Staff sign-in is not available: no approved assurance is configured.";
  }
  return "Sign-in could not be completed. Please try again.";
}

export function StaffSignIn() {
  const navigate = useNavigate();
  const [availability, setAvailability] = useState<Availability>("checking");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    void getStaffAuthPreflight()
      .then((result) => {
        if (active) {
          setAvailability(result.signInEnabled ? "enabled" : "disabled");
        }
      })
      .catch((cause) => {
        if (!active) return;
        setAvailability(
          cause instanceof StaffAuthApiError && cause.status === 0
            ? "unavailable"
            : "disabled",
        );
      });
    return () => {
      active = false;
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await signInStaff(email, password);
      setPassword("");
      navigate(result.redirectTo, { replace: true });
    } catch (cause) {
      setError(messageForError(cause));
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await signOutStaff();
      setMessage("Signed out of the current staff session.");
    } catch {
      setError("Sign-out could not be completed. Close the browser to end the session.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="protected-editor-page">
      <a className="skip-link" href="#staff-sign-in-main">
        Skip to staff sign-in
      </a>
      <header className="protected-editor-header">
        <Link className="brand" to="/">
          CertPath
        </Link>
        <span>Tester-only staff area</span>
      </header>
      <div id="staff-sign-in-main" className="protected-editor-main">
        <p className="eyebrow">Staff access</p>
        <h1>Staff sign in</h1>
        <p className="protected-editor-intro">
          This panel is restricted to approved testers. Use the individual staff
          account that was provisioned for you; accounts are not shared.
        </p>
        {availability === "checking" && (
          <p role="status">Checking whether staff sign-in is enabled…</p>
        )}
        {availability === "disabled" && (
          <p className="form-errors" role="alert">
            Staff sign-in is not available on this deployment.
          </p>
        )}
        {availability === "unavailable" && (
          <p className="form-errors" role="alert">
            Staff sign-in availability could not be confirmed.
          </p>
        )}
        {availability === "enabled" && (
          <section className="card setup-card" aria-label="Staff sign-in">
            {error && (
              <p className="form-errors" role="alert">
                {error}
              </p>
            )}
            {message && (
              <p className="card" role="status">
                {message}
              </p>
            )}
            <form className="editor-form" autoComplete="off" onSubmit={submit}>
              <div className="form-grid">
                <label>
                  Staff email address
                  <input
                    type="email"
                    name="email"
                    autoComplete="username"
                    required
                    maxLength={254}
                    value={email}
                    onChange={(event) => setEmail(event.currentTarget.value)}
                  />
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    name="password"
                    autoComplete="current-password"
                    required
                    minLength={1}
                    maxLength={1024}
                    value={password}
                    onChange={(event) => setPassword(event.currentTarget.value)}
                  />
                </label>
              </div>
              <div className="button-row">
                <button className="button-primary" type="submit" disabled={busy}>
                  {busy ? "Please wait…" : "Sign in"}
                </button>
                <button
                  className="button-secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void signOut();
                  }}
                >
                  Sign out of current session
                </button>
              </div>
            </form>
            <p>
              Passwords are created during approved provisioning and are never
              shown in this panel. Ask the owner for a replacement if yours is
              lost.
            </p>
          </section>
        )}
        <p>
          <Link to="/">Return to the public site</Link>
        </p>
      </div>
    </main>
  );
}
