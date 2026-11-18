import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import * as React from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://localhost/admin/sign-in" });
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
const { StaffSignIn } = await import("./staff-sign-in");
const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderSignIn() {
  const router = createMemoryRouter(
    [
      { path: "/admin/sign-in", element: createElement(StaffSignIn) },
      {
        path: "/admin/mfa/verify",
        element: createElement("p", null, "Second factor stub"),
      },
    ],
    { initialEntries: ["/admin/sign-in"] },
  );
  render(createElement(RouterProvider, { router }));
}

test("brands the staff header as CertPath", async () => {
  globalThis.fetch = async () =>
    jsonResponse({ signInEnabled: false, testerAssuranceEnabled: false });

  renderSignIn();

  const brand = screen.getByRole("link", { name: "CertPath" });
  assert.equal(brand.getAttribute("href"), "/");
});

test("explains that staff sign-in is unavailable when the Worker reports it disabled", async () => {
  globalThis.fetch = async (input) => {
    const path = new URL(String(input), browser.location.href).pathname;
    assert.equal(path, "/api/admin/auth/preflight");
    return jsonResponse({ signInEnabled: false, mfaMethods: [], testerAssuranceEnabled: false });
  };

  renderSignIn();

  await screen.findByText("Staff sign-in is not available on this deployment.");
  assert.equal(screen.queryByLabelText("Staff email address"), null);
});

test("posts the individual staff credentials and moves to the protected editor", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), browser.location.href).pathname;
    if (path === "/api/admin/auth/preflight") {
      return jsonResponse({ signInEnabled: true, mfaMethods: ["totp"], testerAssuranceEnabled: false });
    }
    calls.push({ path, body: JSON.parse(String(init?.body)) });
    return jsonResponse({ redirectTo: "/admin/mfa/verify" });
  };

  renderSignIn();
  fireEvent.change(await screen.findByLabelText("Staff email address"), {
    target: { value: "owner@example.test" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "synthetic-staff-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

  await screen.findByText("Second factor stub");
  assert.deepEqual(calls, [
    {
      path: "/api/admin/auth/sign-in",
      body: {
        email: "owner@example.test",
        password: "synthetic-staff-password",
      },
    },
  ]);
});

test("shows a generic message for rejected credentials", async () => {
  globalThis.fetch = async (input) => {
    const path = new URL(String(input), browser.location.href).pathname;
    if (path === "/api/admin/auth/preflight") {
      return jsonResponse({ signInEnabled: true, mfaMethods: ["totp"], testerAssuranceEnabled: false });
    }
    return jsonResponse({ error: { code: "invalid_credentials" } }, 401);
  };

  renderSignIn();
  fireEvent.change(await screen.findByLabelText("Staff email address"), {
    target: { value: "owner@example.test" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "wrong" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

  await screen.findByText("Email or password is incorrect.");
  assert.equal(screen.queryByText("Second factor stub"), null);
});
