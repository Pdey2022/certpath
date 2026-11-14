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

const { cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { default: LearnerSignInRoute } = await import(
  "../routes/learner-sign-in"
);
const { LearnerVerifyEmailRoute } = await import("./learner-email-actions");
const originalFetch = globalThis.fetch;

const preflightPaths = [
  "/api/auth/local/preflight",
  "/api/auth/email-link/preflight",
];

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  browser.history.replaceState(null, "", "/sign-in");
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
  assert.deepEqual(paths, preflightPaths);
});

test("offers the email-link pilot first and keeps the local password proof", async () => {
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
  assert.equal(navigationLink.getAttribute("href"), "/sign-in");
  assert.ok(await screen.findByRole("button", { name: "Send sign-in link" }));
  assert.equal(screen.queryByLabelText("Password"), null);

  fireEvent.click(screen.getByRole("button", { name: "Password" }));

  assert.ok(screen.getByLabelText("Email address"));
  assert.ok(screen.getByLabelText("Password"));
  assert.ok(screen.getByRole("button", { name: "Create account" }));
  assert.ok(screen.getByRole("link", { name: "Open the synthetic local test inbox" }));
  assert.deepEqual(paths, preflightPaths);
});

test("requests a single-use sign-in link for the entered address", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), browser.location.href).pathname;
    if (preflightPaths.includes(path)) {
      return preflightResponse({
        signInEnabled: true,
        localMailboxEnabled: true,
      });
    }
    calls.push({ path, body: JSON.parse(String(init?.body)) });
    return preflightResponse({
      message: "If the address is eligible, check the local test inbox.",
    });
  };

  renderSignIn();
  fireEvent.change(await screen.findByLabelText("Email address"), {
    target: { value: "learner@example.test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send sign-in link" }));
  await screen.findByText("If the address is eligible, check the local test inbox.");

  assert.deepEqual(calls, [
    {
      path: "/api/auth/email-link/request",
      body: { email: "learner@example.test" },
    },
  ]);
  assert.equal(screen.queryByLabelText("Password"), null);
});

test("registration requests only an email and asks the learner to set a password after verification", async () => {
  const paths: string[] = [];
  const registrationBodies: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), browser.location.href).pathname;
    paths.push(path);
    if (preflightPaths.includes(path)) {
      return preflightResponse({
        signInEnabled: true,
        localMailboxEnabled: true,
      });
    }
    registrationBodies.push(JSON.parse(String(init?.body)));
    return preflightResponse({
      message: "If the address is eligible, check the local test inbox.",
    });
  };

  renderSignIn();
  fireEvent.click(await screen.findByRole("button", { name: "Create account" }));
  assert.equal(screen.queryByLabelText("Password"), null);
  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: "learner@example.test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send verification email" }));
  await screen.findByText("If the address is eligible, check the local test inbox.");

  assert.deepEqual(registrationBodies, [{ email: "learner@example.test" }]);
  assert.deepEqual(paths, [...preflightPaths, "/api/auth/local/register"]);
});

test("verification waits for password selection and submits token and password together", async () => {
  const token = "a".repeat(43);
  const calls: Array<{ path: string; body: unknown }> = [];
  browser.history.replaceState(null, "", `/verify-email#token=${token}`);
  globalThis.fetch = async (input, init) => {
    calls.push({
      path: new URL(String(input), browser.location.href).pathname,
      body: JSON.parse(String(init?.body)),
    });
    return preflightResponse({ message: "Email verified. You can now sign in." });
  };
  const router = createMemoryRouter(
    [{ path: "/verify-email", element: createElement(LearnerVerifyEmailRoute) }],
    { initialEntries: ["/verify-email"] },
  );
  render(createElement(RouterProvider, { router }));

  const password = await screen.findByLabelText("Choose a password");
  assert.deepEqual(calls, []);
  assert.equal(browser.location.hash, "");
  fireEvent.change(password, {
    target: { value: "synthetic-verified-password" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Verify email and set password" }),
  );
  await screen.findByText("Email verified. You can now sign in.");

  assert.deepEqual(calls, [
    {
      path: "/api/auth/local/verify-email",
      body: { token, password: "synthetic-verified-password" },
    },
  ]);
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