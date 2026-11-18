import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import * as React from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://localhost/admin/mfa/verify" });
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
const { StaffMfaEnrol, StaffMfaVerify } = await import("./staff-mfa");
const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

// `csrfResponseSchema` fixes the shape: `v1.` and 43 base64url characters.
const csrfToken = `v1.${"a".repeat(43)}`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderAt(path: string, element: React.ReactElement) {
  const router = createMemoryRouter(
    [
      { path: "/admin/mfa/verify", element: createElement(StaffMfaVerify) },
      { path: "/admin/mfa/enrol", element: createElement(StaffMfaEnrol) },
      {
        path: "/admin/question-editor",
        element: createElement("p", null, "Editor stub"),
      },
    ],
    { initialEntries: [path] },
  );
  render(createElement(RouterProvider, { router }));
  return element;
}
test("posts the verification code with the admin CSRF token and opens the editor", async () => {
  const posts: Array<{ path: string; body: unknown; csrf: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), browser.location.href).pathname;
    if (path === "/api/admin/csrf") return jsonResponse({ csrfToken });
    posts.push({
      path,
      body: JSON.parse(String(init?.body)),
      csrf: new Headers(init?.headers).get("X-CSRF-Token"),
    });
    return jsonResponse({ redirectTo: "/admin/question-editor" });
  };

  renderAt("/admin/mfa/verify", createElement(StaffMfaVerify));
  fireEvent.change(await screen.findByLabelText("Verification code"), {
    target: { value: "123456" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Verify" }));

  await screen.findByText("Editor stub");
  assert.deepEqual(posts, [
    {
      path: "/api/admin/auth/mfa/verify",
      body: { code: "123456" },
      csrf: csrfToken,
    },
  ]);
});

test("never echoes a rejected code back into the page", async () => {
  globalThis.fetch = async (input) => {
    const path = new URL(String(input), browser.location.href).pathname;
    if (path === "/api/admin/csrf") return jsonResponse({ csrfToken });
    return jsonResponse({ error: { code: "invalid_code" } }, 400);
  };

  renderAt("/admin/mfa/verify", createElement(StaffMfaVerify));
  fireEvent.change(await screen.findByLabelText("Verification code"), {
    target: { value: "654321" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Verify" }));

  await screen.findByText(
    "That code was not accepted. Check your authenticator and enter the current code.",
  );
  assert.equal(browser.document.body.textContent?.includes("654321"), false);
});

test("enrols with a ticket, shows the secret once, then ten recovery codes", async () => {
  const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
  const recoveryCodes = Array.from(
    { length: 10 },
    (_, index) => `ABCDE-FGHJ${alphabet[index]}`,
  );
  const posts: string[] = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), browser.location.href).pathname;
    if (path === "/api/admin/csrf") return jsonResponse({ csrfToken });
    posts.push(`${path} ${String(init?.body)}`);
    if (path === "/api/admin/auth/mfa/enrol") {
      return jsonResponse({
        secret: "JBSWY3DPEHPK3PXPJBSWY3DP",
        otpauthUri:
          "otpauth://totp/Exam%20Prep:owner%40example.test?secret=JBSWY3DPEHPK3PXPJBSWY3DP&issuer=Exam%20Prep",
        keyVersion: 1,
      });
    }
    return jsonResponse({ recoveryCodes });
  };

  renderAt("/admin/mfa/enrol", createElement(StaffMfaEnrol));
  fireEvent.change(await screen.findByLabelText("Enrolment ticket"), {
    target: { value: "printed-ticket-value" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Begin enrolment" }));

  await screen.findByText("JBSWY3DPEHPK3PXPJBSWY3DP");
  fireEvent.change(screen.getByLabelText("Code from the authenticator"), {
    target: { value: "123456" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm enrolment" }));

  await screen.findByText(recoveryCodes[0]!);
  const text = browser.document.body.textContent ?? "";
  for (const recoveryCode of recoveryCodes) {
    assert.equal(text.includes(recoveryCode), true, recoveryCode);
  }
  assert.deepEqual(posts, [
    '/api/admin/auth/mfa/enrol {"ticket":"printed-ticket-value"}',
    '/api/admin/auth/mfa/enrol/confirm {"code":"123456"}',
  ]);
});
