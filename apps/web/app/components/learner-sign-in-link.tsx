import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  LearnerAuthApiError,
  inspectLearnerSignInLink,
  redeemLearnerSignInLink,
} from "../lib/learner-auth-api";
import { takeFragmentToken } from "./learner-email-actions";

type ConfirmationState =
  | "checking"
  | "ready"
  | "signing_in"
  | "invalid"
  | "unavailable";

function errorText(error: unknown): string {
  if (error instanceof LearnerAuthApiError && error.code === "rate_limited") {
    return "Too many attempts. Wait a while before trying again.";
  }
  return "The sign-in link could not be checked. Please try again.";
}

export function LearnerSignInLinkConfirm() {
  const navigate = useNavigate();
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<ConfirmationState>("checking");
  const [error, setError] = useState("");

  useEffect(() => {
    const linkToken = takeFragmentToken();
    if (!linkToken) {
      setState("invalid");
      return;
    }
    setToken(linkToken);
    let active = true;
    void inspectLearnerSignInLink(linkToken)
      .then((result) => {
        if (active) setState(result.status === "valid" ? "ready" : "invalid");
      })
      .catch((cause) => {
        if (!active) return;
        setError(errorText(cause));
        setState("unavailable");
      });
    return () => {
      active = false;
    };
  }, []);

  async function confirm() {
    if (!token) return;
    setState("signing_in");
    setError("");
    try {
      const result = await redeemLearnerSignInLink(token);
      setToken(null);
      navigate(result.redirectTo, { replace: true });
    } catch (cause) {
      if (
        cause instanceof LearnerAuthApiError &&
        cause.code === "invalid_or_expired_link"
      ) {
        setState("invalid");
        return;
      }
      setError(errorText(cause));
      setState("unavailable");
    }
  }

  return (
    <main id="main-content" className="public-main">
      <section className="card setup-card" aria-labelledby="sign-in-link-title">
        <h1 id="sign-in-link-title">Confirm your sign-in</h1>
        <p>
          Opening this link did not sign you in. Confirm below to use it once;
          this keeps automated link scanners from spending it.
        </p>
        {state === "checking" && <p role="status">Checking this sign-in link…</p>}
        {state === "signing_in" && <p role="status">Signing you in…</p>}
        {state === "invalid" && (
          <p className="form-errors" role="alert">
            This sign-in link is invalid, expired, or has already been used.
          </p>
        )}
        {state === "unavailable" && (
          <p className="form-errors" role="alert">
            {error}
          </p>
        )}
        {state === "ready" && (
          <form
            className="editor-form"
            onSubmit={(event) => {
              event.preventDefault();
              void confirm();
            }}
          >
            <button className="button-primary" type="submit">
              Sign in to my learner account
            </button>
          </form>
        )}
        <p>
          <Link to="/sign-in">Request a new sign-in link</Link>
        </p>
      </section>
    </main>
  );
}
