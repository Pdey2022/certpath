import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import * as React from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Window } from "happy-dom";

const pilotOrigin = "https://certpath-pilot.certpath.workers.dev";
const browser = new Window({ url: `${pilotOrigin}/sign-in` });
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
});

function renderSignIn() {
  const router = createMemoryRouter(
    [{ path: "/sign-in", element: createElement(LearnerSignInRoute) }],
    { initialEntries: ["/sign-in"] },
  );
  render(createElement(RouterProvider, { router }));
}

test("the pilot offers Google sign-in only, with no password request", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const path = new URL(String(input), browser.location.href).pathname;
    calls.push(path);
    return new Response(
      JSON.stringify({ signInEnabled: true, localMailboxEnabled: false }),
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
  assert.deepEqual(calls, ["/api/auth/google/preflight"]);
});

test("the pilot hides Google sign-in when the Worker reports it disabled", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ signInEnabled: false, localMailboxEnabled: false }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  renderSignIn();

  await screen.findByText("Learner sign-in is currently disabled.");
  assert.equal(
    screen.queryByRole("link", { name: "Continue with Google" }),
    null,
  );
});

test("the pilot shows a neutral message when Google rejects the account", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ signInEnabled: true, localMailboxEnabled: false }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  const router = createMemoryRouter(
    [{ path: "/sign-in", element: createElement(LearnerSignInRoute) }],
    { initialEntries: ["/sign-in?error=not_invited"] },
  );
  render(createElement(RouterProvider, { router }));

  const alert = await screen.findByRole("alert");
  assert.match(alert.textContent ?? "", /not invited to the CertPath pilot/);
});
