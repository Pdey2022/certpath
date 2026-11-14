import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import * as React from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://localhost/sign-in/link" });
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
const { LearnerSignInLinkConfirm } = await import("./learner-sign-in-link");
const originalFetch = globalThis.fetch;

const token = "b".repeat(43);

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  browser.history.replaceState(null, "", "/sign-in/link");
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderConfirmation() {
  const router = createMemoryRouter(
    [
      {
        path: "/sign-in/link",
        element: createElement(LearnerSignInLinkConfirm),
      },
      {
        path: "/app/home",
        element: createElement("p", null, "Dashboard stub"),
      },
    ],
    { initialEntries: ["/sign-in/link"] },
  );
  render(createElement(RouterProvider, { router }));
}

test("checks the link without spending it until the learner confirms", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  browser.history.replaceState(null, "", `/sign-in/link#token=${token}`);
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), browser.location.href).pathname;
    calls.push({ path, body: JSON.parse(String(init?.body)) });
    if (path === "/api/auth/email-link/inspect") {
      return jsonResponse({ status: "valid" });
    }
    return jsonResponse({ redirectTo: "/app/home" });
  };

  renderConfirmation();

  const confirmButton = await screen.findByRole("button", {
    name: "Sign in to my learner account",
  });
  assert.deepEqual(calls, [
    { path: "/api/auth/email-link/inspect", body: { token } },
  ]);
  assert.equal(browser.location.hash, "");

  fireEvent.click(confirmButton);
  await screen.findByText("Dashboard stub");
  assert.deepEqual(calls, [
    { path: "/api/auth/email-link/inspect", body: { token } },
    { path: "/api/auth/email-link/redeem", body: { token } },
  ]);
});

test("shows an expired or already used link without offering confirmation", async () => {
  const paths: string[] = [];
  browser.history.replaceState(null, "", `/sign-in/link#token=${token}`);
  globalThis.fetch = async (input) => {
    paths.push(new URL(String(input), browser.location.href).pathname);
    return jsonResponse({ status: "invalid" });
  };

  renderConfirmation();

  await screen.findByText(
    "This sign-in link is invalid, expired, or has already been used.",
  );
  assert.equal(
    screen.queryByRole("button", { name: "Sign in to my learner account" }),
    null,
  );
  assert.deepEqual(paths, ["/api/auth/email-link/inspect"]);
});

test("reports a missing token without contacting the server", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({ status: "valid" });
  };

  renderConfirmation();

  await screen.findByText(
    "This sign-in link is invalid, expired, or has already been used.",
  );
  assert.equal(calls, 0);
});

test("does not offer confirmation when the check itself fails", async () => {
  browser.history.replaceState(null, "", `/sign-in/link#token=${token}`);
  globalThis.fetch = async () =>
    jsonResponse({ error: { code: "service_unavailable" } }, 503);

  renderConfirmation();

  await screen.findByText(
    "The sign-in link could not be checked. Please try again.",
  );
  assert.equal(
    screen.queryByRole("button", { name: "Sign in to my learner account" }),
    null,
  );
});

test("surfaces a link that was spent by another request", async () => {
  browser.history.replaceState(null, "", `/sign-in/link#token=${token}`);
  globalThis.fetch = async (input) => {
    const path = new URL(String(input), browser.location.href).pathname;
    if (path === "/api/auth/email-link/inspect") {
      return jsonResponse({ status: "valid" });
    }
    return jsonResponse({ error: { code: "invalid_or_expired_link" } }, 400);
  };

  renderConfirmation();
  fireEvent.click(
    await screen.findByRole("button", { name: "Sign in to my learner account" }),
  );

  await screen.findByText(
    "This sign-in link is invalid, expired, or has already been used.",
  );
});
