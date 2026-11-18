import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  confirmStaffMfaEnrolment,
  enrolStaffMfa,
  redeemStaffMfaRecoveryCode,
  StaffAuthApiError,
  verifyStaffMfa,
} from "../lib/staff-auth-api";

// The staff second factor, client side.
//
// These forms are presentation only: the Worker decides whether a ticket is
// valid, whether a code matches, and whether the session may be upgraded. No
// code, secret, ticket or recovery code is ever echoed into a DOM error - the
// messages below are fixed strings - so a shoulder-surfer cannot read back what
// was typed from the page's own feedback.

function messageForFailure(error: unknown, fallback: string): string {
  if (!(error instanceof StaffAuthApiError)) return fallback;
  if (error.code === "rate_limited") {
    return "Too many attempts. Wait a while before trying again.";
  }
  if (error.code === "invalid_code") {
    return "That code was not accepted. Check your authenticator and enter the current code.";
  }
  if (error.code === "recovery_code_used") {
    return "That recovery code has already been used.";
  }
  if (error.code === "ticket_expired") {
    return "That enrolment ticket has expired. Ask a Global Admin for a new one.";
  }
  if (error.code === "mfa_already_enrolled") {
    return "A second factor is already enrolled for this account.";
  }
  if (error.status === 401) {
    return "Your staff session has ended. Sign in again.";
  }
  if (error.status === 403) {
    return "That request is not allowed for this account.";
  }
  if (error.status === 503) {
    return "The second-factor service is unavailable on this deployment.";
  }
  return fallback;
}

export function StaffMfaVerify() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"code" | "recovery">("code");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await verifyStaffMfa(code.trim());
      setCode("");
      navigate(result.redirectTo, { replace: true });
    } catch (cause) {
      setError(
        messageForFailure(
          cause,
          "The code could not be checked. Please try again.",
        ),
      );
    } finally {
      setCode("");
      setBusy(false);
    }
  }

  async function submitRecovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await redeemStaffMfaRecoveryCode(recoveryCode.trim());
      setRecoveryCode("");
      // The one-time ticket travels in router state, never in storage: the
      // enrolment page pre-fills it, the user confirms, and it is gone.
      navigate("/admin/mfa/enrol", {
        replace: true,
        state: { ticket: result.ticket },
      });
    } catch (cause) {
      setError(
        messageForFailure(
          cause,
          "The recovery code could not be checked. Please try again.",
        ),
      );
    } finally {
      setRecoveryCode("");
      setBusy(false);
    }
  }

  return (
    <main className="protected-editor-page">
      <a className="skip-link" href="#staff-mfa-main">
        Skip to second-factor verification
      </a>
      <header className="protected-editor-header">
        <Link className="brand" to="/">
          Exam Prep
        </Link>
        <span>Tester-only staff area</span>
      </header>
      <div id="staff-mfa-main" className="protected-editor-main">
        <p className="eyebrow">Staff access</p>
        <h1>Second factor</h1>
        <p className="protected-editor-intro">
          Your password is not enough on its own. Enter the six-digit code from
          your authenticator app to finish signing in.
        </p>
        {error && (
          <p className="form-errors" role="alert">
            {error}
          </p>
        )}
        {mode === "code" ? (
          <section className="card setup-card" aria-label="Second factor code">
            <form className="editor-form" autoComplete="off" onSubmit={submitCode}>
              <div className="form-grid">
                <label>
                  Verification code
                  <input
                    type="text"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    value={code}
                    onChange={(event) => setCode(event.currentTarget.value)}
                  />
                </label>
              </div>
              <div className="button-row">
                <button className="button-primary" type="submit" disabled={busy}>
                  {busy ? "Please wait…" : "Verify"}
                </button>
                <button
                  className="button-secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setError("");
                    setMode("recovery");
                  }}
                >
                  Use a recovery code
                </button>
              </div>
            </form>
          </section>
        ) : (
          <section className="card setup-card" aria-label="Use a recovery code">
            <form
              className="editor-form"
              autoComplete="off"
              onSubmit={submitRecovery}
            >
              <div className="form-grid">
                <label>
                  Recovery code
                  <input
                    type="text"
                    name="recoveryCode"
                    autoComplete="off"
                    maxLength={32}
                    required
                    value={recoveryCode}
                    onChange={(event) =>
                      setRecoveryCode(event.currentTarget.value)
                    }
                  />
                </label>
              </div>
              <p>
                A recovery code does not sign you in. It removes the current
                authenticator so you can enrol a new one.
              </p>
              <div className="button-row">
                <button className="button-primary" type="submit" disabled={busy}>
                  {busy ? "Please wait…" : "Use recovery code"}
                </button>
                <button
                  className="button-secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setError("");
                    setMode("code");
                  }}
                >
                  Back to the code
                </button>
              </div>
            </form>
          </section>
        )}
        <p>
          <Link to="/">Return to the public site</Link>
        </p>
      </div>
    </main>
  );
}

type EnrolmentStep =
  | { step: "ticket" }
  | { step: "confirm"; secret: string; otpauthUri: string }
  | { step: "codes"; recoveryCodes: string[] };

export function StaffMfaEnrol() {
  const location = useLocation();
  const [state, setState] = useState<EnrolmentStep>({ step: "ticket" });
  const [ticket, setTicket] = useState(() => {
    // A ticket issued by a recovery redemption arrives in router state and is
    // pre-filled; the user may still paste a printed one instead.
    const handedOver = (location.state as { ticket?: unknown } | null)?.ticket;
    return typeof handedOver === "string" ? handedOver : "";
  });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submitTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await enrolStaffMfa(ticket.trim());
      setTicket("");
      setState({
        step: "confirm",
        secret: result.secret,
        otpauthUri: result.otpauthUri,
      });
    } catch (cause) {
      setError(
        messageForFailure(
          cause,
          "The enrolment ticket could not be used. Please try again.",
        ),
      );
      setTicket("");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await confirmStaffMfaEnrolment(code.trim());
      setState({ step: "codes", recoveryCodes: result.recoveryCodes });
    } catch (cause) {
      setError(
        messageForFailure(
          cause,
          "The code could not be checked. Please try again.",
        ),
      );
    } finally {
      setCode("");
      setBusy(false);
    }
  }

  return (
    <main className="protected-editor-page">
      <a className="skip-link" href="#staff-mfa-main">
        Skip to second-factor enrolment
      </a>
      <header className="protected-editor-header">
        <Link className="brand" to="/">
          Exam Prep
        </Link>
        <span>Tester-only staff area</span>
      </header>
      <div id="staff-mfa-main" className="protected-editor-main">
        <p className="eyebrow">Staff access</p>
        <h1>Enrol a second factor</h1>
        {error && (
          <p className="form-errors" role="alert">
            {error}
          </p>
        )}
        {state.step === "ticket" && (
          <section className="card setup-card" aria-label="Start enrolment">
            <p className="protected-editor-intro">
              A password alone cannot create a second factor. Enter the
              enrolment ticket that was printed for you by the owner's
              provisioning run or by a Global Admin reset.
            </p>
            <form
              className="editor-form"
              autoComplete="off"
              onSubmit={submitTicket}
            >
              <div className="form-grid">
                <label>
                  Enrolment ticket
                  <input
                    type="text"
                    name="ticket"
                    autoComplete="off"
                    maxLength={128}
                    required
                    value={ticket}
                    onChange={(event) => setTicket(event.currentTarget.value)}
                  />
                </label>
              </div>
              <div className="button-row">
                <button className="button-primary" type="submit" disabled={busy}>
                  {busy ? "Please wait…" : "Begin enrolment"}
                </button>
              </div>
            </form>
          </section>
        )}
        {state.step === "confirm" && (
          <section className="card setup-card" aria-label="Confirm enrolment">
            <p className="protected-editor-intro">
              Add this secret to your authenticator app now. It is shown once
              and cannot be recovered.
            </p>
            <dl>
              <dt>Secret</dt>
              <dd>
                <code>{state.secret}</code>
              </dd>
              <dt>Setup link</dt>
              <dd>
                <code>{state.otpauthUri}</code>
              </dd>
            </dl>
            <form className="editor-form" autoComplete="off" onSubmit={submitCode}>
              <div className="form-grid">
                <label>
                  Code from the authenticator
                  <input
                    type="text"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    value={code}
                    onChange={(event) => setCode(event.currentTarget.value)}
                  />
                </label>
              </div>
              <div className="button-row">
                <button className="button-primary" type="submit" disabled={busy}>
                  {busy ? "Please wait…" : "Confirm enrolment"}
                </button>
              </div>
            </form>
          </section>
        )}
        {state.step === "codes" && (
          <section className="card setup-card" aria-label="Recovery codes">
            <p className="protected-editor-intro">
              These ten recovery codes are shown once. Print or store them
              offline. Each one works one time and only removes your current
              authenticator.
            </p>
            <ul>
              {state.recoveryCodes.map((recoveryCode) => (
                <li key={recoveryCode}>
                  <code>{recoveryCode}</code>
                </li>
              ))}
            </ul>
            <Link className="button-primary" to="/admin/mfa/verify">
              I have saved them — verify now
            </Link>
          </section>
        )}
        <p>
          <Link to="/">Return to the public site</Link>
        </p>
      </div>
    </main>
  );
}
