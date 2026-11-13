import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import * as React from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://localhost/app/home" });
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
const { LearnerDashboard } = await import("./learner-dashboard");
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

function installDashboardFetch(response: Response) {
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    paths.push(new URL(String(input), browser.location.href).pathname);
    return response.clone();
  };
  return paths;
}

function renderDashboard() {
  const router = createMemoryRouter(
    [{ path: "*", element: createElement(LearnerDashboard) }],
    { initialEntries: ["/app/home"] },
  );
  render(createElement(RouterProvider, { router }));
  return router;
}

test("shows acknowledged progress and opens the selected timed-out mock result", async () => {
  const paths = installDashboardFetch(
    jsonResponse({
      groups: [
        {
          certificationId: "cert-1",
          certificationName: "Synthetic certification",
          examVersionId: "version-1",
          versionKey: "v1",
          examVersionTitle: "Synthetic exam",
          resumable: [
            {
              id: "practice-1",
              kind: "practice",
              state: "in_progress",
              questionCount: 2,
              answeredCount: 1,
              currentPosition: 1,
              createdAt: 100,
              updatedAt: 200,
              completedAt: null,
            },
          ],
          completed: [
            {
              id: "mock-1",
              kind: "timed_mock",
              state: "completed",
              questionCount: 10,
              answeredCount: 2,
              currentPosition: 4,
              correctCount: 7,
              createdAt: 100,
              updatedAt: 300,
              completedAt: 300,
              deadlineAt: 250,
              completionReason: "timed_out",
            },
          ],
        },
      ],
    }),
  );
  const router = renderDashboard();

  await screen.findByText("1 of 2 answered");
  await screen.findByText("7 / 10 correct");
  assert.equal(screen.queryByText(/question text|answer key|explanation/i), null);
  fireEvent.click(
    screen.getByRole("link", {
      name: /view timed mock for synthetic certification v1/i,
    }),
  );
  assert.equal(router.state.location.pathname, "/app/mock/live");
  assert.equal(router.state.location.search, "?attemptId=mock-1");
  assert.deepEqual(paths, ["/api/practice/dashboard"]);
});

test("shows an empty state and a retryable failure", async () => {
  installDashboardFetch(jsonResponse({ groups: [] }));
  renderDashboard();
  await screen.findByRole("heading", { name: "No active exam access" });

  cleanup();
  installDashboardFetch(jsonResponse({ error: { code: "service_unavailable" } }, 503));
  renderDashboard();
  await screen.findByRole("alert");
  assert.ok(screen.getByRole("button", { name: "Retry loading progress" }));
});

test("signs out through the CSRF-protected session revocation endpoint", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), browser.location.href).pathname;
    calls.push({ path, init });
    if (path === "/api/practice/dashboard") {
      return jsonResponse({ groups: [] });
    }
    if (path === "/api/auth/session/csrf") {
      return jsonResponse({ csrfToken: `v1.${"a".repeat(43)}` });
    }
    if (path === "/api/auth/session/logout") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const router = createMemoryRouter(
    [
      { path: "/app/home", element: createElement(LearnerDashboard) },
      { path: "/sign-in", element: createElement("p", null, "Sign-in entry") },
    ],
    { initialEntries: ["/app/home"] },
  );
  render(createElement(RouterProvider, { router }));

  await screen.findByRole("heading", { name: "No active exam access" });
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByText("Sign-in entry");

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      "/api/practice/dashboard",
      "/api/auth/session/csrf",
      "/api/auth/session/logout",
    ],
  );
  assert.equal(router.state.location.pathname, "/sign-in");
  const logoutCall = calls.find(
    (call) => call.path === "/api/auth/session/logout",
  );
  assert.equal(logoutCall?.init?.method, "POST");
  assert.equal(
    new Headers(logoutCall?.init?.headers).get("X-CSRF-Token"),
    `v1.${"a".repeat(43)}`,
  );
});
