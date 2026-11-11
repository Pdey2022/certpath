import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import * as React from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://localhost/sign-in" });
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

const { cleanup, render, screen } =
  await import("@testing-library/react");
const { default: LearnerSignInRoute } = await import(
  "../routes/learner-sign-in"
);
const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function preflightResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderSignIn() {
  const router = createMemoryRouter(
    [
      {
        path: "/sign-in",
        element: createElement(LearnerSignInRoute),
      },
    ],
    { initialEntries: ["/sign-in"] },
  );
  render(createElement(RouterProvider, { router }));
}

test("shows disabled sign-in state without offering the sign-in link or action", async () => {
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    paths.push(new URL(String(input), browser.location.href).pathname);
    return preflightResponse({
      signInEnabled: false,
      localMailboxEnabled: false,
    });
  };

  renderSignIn();

  await screen.findByText("Learner sign-in is currently disabled.");
  assert.equal(
    screen.queryByRole("link", { name: "Learner sign in" }),
    null,
  );
  assert.equal(screen.queryByRole("button", { name: "Sign in" }), null);
  assert.deepEqual(paths, ["/api/auth/local/preflight"]);
});

test("offers the learner email and password entry when enabled", async () => {
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    paths.push(new URL(String(input), browser.location.href).pathname);
    return preflightResponse({
      signInEnabled: true,
      localMailboxEnabled: true,
    });
  };

  renderSignIn();

  const navigationLink = await screen.findByRole("link", {
    name: "Learner sign in",
  });
  await screen.findByRole("button", { name: "Create account" });
  assert.equal(navigationLink.getAttribute("href"), "/sign-in");
  assert.ok(screen.getByLabelText("Email address"));
  assert.ok(screen.getByLabelText("Password"));
  assert.ok(screen.getByRole("link", { name: "Open the synthetic local test inbox" }));
  assert.deepEqual(paths, ["/api/auth/local/preflight"]);
});

test("fails closed when sign-in availability cannot be checked", async () => {
  globalThis.fetch = async () => preflightResponse({}, 503);

  renderSignIn();

  await screen.findByText(
    "Sign-in availability could not be confirmed. No sign-in option is available right now.",
  );
  assert.equal(
    screen.queryByRole("link", { name: "Learner sign in" }),
    null,
  );
  assert.equal(screen.queryByRole("button", { name: "Sign in" }), null);
});
