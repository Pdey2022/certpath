import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import * as React from "react";
import { createMemoryRouter, Link, RouterProvider } from "react-router";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://localhost/app/mock/live" });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: browser },
  document: { configurable: true, value: browser.document },
  navigator: { configurable: true, value: browser.navigator },
  HTMLElement: { configurable: true, value: browser.HTMLElement },
  HTMLInputElement: { configurable: true, value: browser.HTMLInputElement },
  HTMLSelectElement: { configurable: true, value: browser.HTMLSelectElement },
  Node: { configurable: true, value: browser.Node },
  Event: { configurable: true, value: browser.Event },
  MouseEvent: { configurable: true, value: browser.MouseEvent },
  React: { configurable: true, value: React },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
});

const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { LearnerTimedMock } = await import("./learner-timed-mock");
const originalFetch = globalThis.fetch;
const startedAt = 1_800_000_000_000;

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

function makeAttempt(options: {
  version?: number;
  selectedOptionKey?: string;
  completed?: boolean;
} = {}) {
  const completed = options.completed ?? false;
  return {
    attempt: {
      id: "mock-1",
      certificationId: "cert-1",
      examVersionId: "version-1",
      state: completed ? "completed" : "in_progress",
      completionReason: completed ? "learner_submitted" : null,
      version: options.version ?? 1,
      profileVersion: 1,
      durationSeconds: 900,
      questionCount: 10,
      currentPosition: 0,
      answeredCount: options.selectedOptionKey ? 1 : 0,
      ...(completed ? { correctCount: 1 } : {}),
      startedAt,
      deadlineAt: startedAt + 900_000,
      completedAt: completed ? startedAt + 1000 : null,
      createdAt: startedAt,
      updatedAt: startedAt + (options.selectedOptionKey ? 1000 : 0),
    },
    serverNow: startedAt,
    items: Array.from({ length: 10 }, (_, position) => ({
      position,
      revisionId: `revision-${position + 1}`,
      stem: `Synthetic mock question ${position + 1}?`,
      options: [
        {
          key: "A",
          text: `Synthetic answer ${position + 1}`,
          ...(completed ? { explanation: "Synthetic answer explanation." } : {}),
        },
        {
          key: "B",
          text: `Another synthetic answer ${position + 1}`,
          ...(completed ? { explanation: "Synthetic distractor explanation." } : {}),
        },
      ],
      ...(position === 0 && options.selectedOptionKey
        ? { selectedOptionKey: options.selectedOptionKey }
        : {}),
      ...(completed
        ? {
            correctOptionKey: "A",
            ...(options.selectedOptionKey ? { isCorrect: options.selectedOptionKey === "A" } : {}),
          }
        : {}),
    })),
  };
}

const scopeResponse = {
  items: [
    {
      certificationId: "cert-1",
      certificationName: "Synthetic certification",
      examVersionId: "version-1",
      versionKey: "v1",
      examVersionTitle: "Synthetic version",
      mockProfile: {
        version: 1,
        durationSeconds: 900,
        questionCount: 10,
        navigation: "reviewable",
      },
      domains: [],
    },
  ],
};

function installFetch() {
  let saved = false;
  let completed = false;
  let answerPostCount = 0;
  let current = makeAttempt();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname === "/api/practice/csrf") {
      return jsonResponse({ csrfToken: `v1.${"A".repeat(43)}` });
    }
    if (url.pathname === "/api/practice/scopes") {
      return jsonResponse(scopeResponse);
    }
    if (
      url.pathname === "/api/practice/mocks" &&
      (init?.method === undefined || init.method === "GET")
    ) {
      return jsonResponse({
        items: saved
          ? [
              {
                ...current.attempt,
              },
            ]
          : [],
      });
    }
    if (url.pathname === "/api/practice/mocks" && init?.method === "POST") {
      saved = true;
      current = makeAttempt();
      return jsonResponse(current, 201);
    }
    if (url.pathname === "/api/practice/mocks/mock-1/answers") {
      answerPostCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        selectedOptionKey: string;
      };
      current = makeAttempt({
        version: 2,
        selectedOptionKey: body.selectedOptionKey,
      });
      return jsonResponse(current);
    }
    if (url.pathname === "/api/practice/mocks/mock-1/submit") {
      completed = true;
      current = makeAttempt({
        version: 3,
        selectedOptionKey: "A",
        completed: true,
      });
      return jsonResponse(current);
    }
    if (url.pathname === "/api/practice/mocks/mock-1") {
      return jsonResponse(
        completed
          ? makeAttempt({ version: 3, selectedOptionKey: "A", completed: true })
          : current,
      );
    }
    throw new Error(`Unexpected timed-mock request: ${init?.method} ${url.pathname}`);
  };
  return {
    get answerPostCount() {
      return answerPostCount;
    },
  };
}

function renderMock() {
  const router = createMemoryRouter(
    [
      {
        path: "/app/mock/live",
        element: createElement(
          React.Fragment,
          null,
          createElement(LearnerTimedMock),
          createElement(Link, { to: "/app", "aria-label": "Navigate away" }, "Home"),
        ),
      },
      { path: "/app", element: createElement("p", null, "Away page") },
    ],
    { initialEntries: ["/app/mock/live"] },
  );
  return render(createElement(RouterProvider, { router }));
}

async function startMock() {
  renderMock();
  assert.ok(screen.getByRole("heading", { name: "Loading timed mocks" }));
  await screen.findByRole("option", { name: /Synthetic certification/ });
  fireEvent.click(screen.getByRole("button", { name: "Start timed mock" }));
  await screen.findByRole("heading", { name: "CertPath practice mock" });
}

test("keeps a local answer through the leave warning and resumes acknowledged state and deadline", async () => {
  installFetch();
  await startMock();

  assert.equal(screen.getByRole("timer").textContent?.includes("15:00"), true);
  assert.equal(screen.queryByText("Synthetic answer explanation."), null);
  fireEvent.click(screen.getByRole("radio", { name: /Synthetic answer 1/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save & exit" }));
  await screen.findByRole("heading", { name: "Leave the timed mock?" });
  fireEvent.click(screen.getByRole("button", { name: "Stay in mock" }));
  assert.equal(
    (screen.getByRole("radio", { name: /Synthetic answer 1/ }) as HTMLInputElement).checked,
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
  await screen.findByText("Saved on the server.");

  fireEvent.click(screen.getByRole("button", { name: "Save & exit" }));
  await screen.findByRole("heading", { name: "Leave the timed mock?" });
  fireEvent.click(screen.getByRole("button", { name: "Leave mock" }));
  await screen.findByRole("heading", { name: "Choose an authorized exam" });
  assert.ok(screen.getByText(/1 of 10 answered/));
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  await screen.findByRole("heading", { name: "CertPath practice mock" });
  assert.equal(
    (screen.getByRole("radio", { name: /Synthetic answer 1/ }) as HTMLInputElement).checked,
    true,
  );
  assert.equal(screen.getByRole("timer").textContent?.includes("15:00"), true);
  assert.equal(screen.queryByText("Synthetic answer explanation."), null);
});

test("confirms submission and shows explanations only in the finalized result", async () => {
  const requests = installFetch();
  await startMock();
  fireEvent.click(screen.getByRole("radio", { name: /Synthetic answer 1/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
  await screen.findByText("Saved on the server.");
  fireEvent.click(screen.getByRole("button", { name: "Submit mock" }));
  await screen.findByRole("heading", { name: "Submit this mock?" });
  fireEvent.click(screen.getAllByRole("button", { name: "Submit mock" })[0]!);
  await screen.findByRole("heading", { name: "Mock results" });
  assert.ok(screen.getAllByText("Synthetic answer explanation.").length > 0);
  assert.equal(requests.answerPostCount, 1);
});

test("retains a selected answer after a failed network save and retries the same operation", async () => {
  let failOnce = true;
  installFetch();
  const currentFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname.endsWith("/answers") && failOnce) {
      failOnce = false;
      throw new TypeError("synthetic network loss");
    }
    return currentFetch(input, init);
  };
  await startMock();
  fireEvent.click(screen.getByRole("radio", { name: /Synthetic answer 1/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
  await screen.findByText(/network is unavailable/i);
  assert.equal(
    (screen.getByRole("radio", { name: /Synthetic answer 1/ }) as HTMLInputElement).checked,
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry the same save" }));
  await waitFor(() => assert.ok(screen.getByText("Saved on the server.")));
});
