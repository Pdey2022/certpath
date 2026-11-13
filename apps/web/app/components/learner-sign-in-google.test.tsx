import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import * as React from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Window } from "happy-dom";

const stagingOrigin = "https://learner-auth-staging.certpath.workers.dev";
const browser = new Window({ url: `${stagingOrigin}/sign-in` });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: browser },
  document: { configurable: true, value: browser.document },
  navigator: { configurable: true, value: browser.navigator },
  HTMLElement: { configurable: true, value: browser.HTMLElement },
  Node: { configurable: true, value: browser.Node },
  Event: { configurable: true, value: browser.Event },
  MouseEvent: { configurable: true, value: browser.MouseEvent },
  React: { configurable: true, value: React },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
});

const { cleanup, render, screen } = await import("@testing-library/react");
const { default: LearnerSignInRoute } = await import(
  "../routes/learner-sign-in"
);
const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  browser.history.replaceState(null, "", "/sign-in");
});

function preflightResponse(): Response {
  return new Response(
    JSON.stringify({ signInEnabled: true, localMailboxEnabled: false }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function renderSignIn(path = "/sign-in") {
  const router = createMemoryRouter(
    [{ path: "/sign-in", element: createElement(LearnerSignInRoute) }],
    { initialEntries: [path] },
  );
  render(createElement(RouterProvider, { router }));
}

test("offers Google sign-in on the staging origin and keeps the synthetic learner form", async () => {
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    paths.push(new URL(String(input), browser.location.href).pathname);
    return preflightResponse();
  };

  renderSignIn();

  const google = await screen.findByRole("link", {
    name: "Continue with Google",
  });
  assert.equal(google.getAttribute("href"), "/api/auth/google/start");
  assert.ok(screen.getByLabelText("Email address"));
  assert.deepEqual(paths.slice().sort(), [
    "/api/auth/google/preflight",
    "/api/auth/staging/preflight",
  ]);
  assert.equal(
    screen.queryByRole("link", { name: "Open the synthetic local test inbox" }),
    null,
  );
});

test("offers Google sign-in when password sign-in is unavailable", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const path = new URL(String(input), browser.location.href).pathname;
    calls.push(path);
    if (path === "/api/auth/google/preflight") {
      return new Response(
        JSON.stringify({ signInEnabled: true, localMailboxEnabled: false }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ signInEnabled: false, localMailboxEnabled: false }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  renderSignIn();

  const google = await screen.findByRole("link", {
    name: "Continue with Google",
  });
  assert.equal(google.getAttribute("href"), "/api/auth/google/start");
  assert.equal(screen.queryByLabelText("Email address"), null);
  assert.equal(screen.queryByLabelText("Password"), null);
  assert.equal(
    screen.queryByText("Learner sign-in is currently disabled."),
    null,
  );
  assert.deepEqual(calls.sort(), [
    "/api/auth/google/preflight",
    "/api/auth/staging/preflight",
  ]);
});

test("explains that an uninvited Google account cannot sign in", async () => {
  globalThis.fetch = async () => preflightResponse();

  renderSignIn("/sign-in?error=not_invited");

  const alert = await screen.findByRole("alert");
  assert.match(
    alert.textContent ?? "",
    /not invited to the CertPath pilot/,
  );
  assert.ok(screen.getByRole("link", { name: "Continue with Google" }));
});

test("explains a failed identity token check without leaking details", async () => {
  globalThis.fetch = async () => preflightResponse();

  renderSignIn("/sign-in?error=invalid_identity_token");

  const alert = await screen.findByRole("alert");
  assert.match(alert.textContent ?? "", /could not be verified/);
  assert.doesNotMatch(alert.textContent ?? "", /token|issuer|signature/i);
});
