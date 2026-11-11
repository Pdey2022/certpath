import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import * as React from "react";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://localhost/app/practice/live" });
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
const { LearnerPractice } = await import("./learner-practice");
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

const scopes = {
  items: [
    {
      certificationId: "cert-1",
      certificationName: "Synthetic certification",
      examVersionId: "version-1",
      versionKey: "v1",
      examVersionTitle: "Synthetic version",
      domains: [{ id: "domain-1", title: "Synthetic domain" }],
    },
  ],
};

function attemptResponse(options: { answered?: boolean; completed?: boolean } = {}) {
  const answered = options.answered ?? false;
  const completed = options.completed ?? false;
  return {
    attempt: {
      id: "attempt-1",
      certificationId: "cert-1",
      examVersionId: "version-1",
      state: completed ? "completed" : "in_progress",
      version: answered ? 2 : 1,
      questionCount: 1,
      currentPosition: answered ? 1 : 0,
      ...(completed ? { correctCount: 1 } : {}),
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_001,
      completedAt: completed ? 1_800_000_000_001 : null,
      filters: { domainId: "domain-1" },
    },
    items: [
      {
        position: 0,
        revisionId: "revision-1",
        stem: "Which synthetic choice is correct?",
        options: [
          {
            key: "A",
            text: "Synthetic answer",
            ...(answered ? { explanation: "Synthetic explanation." } : {}),
          },
          {
            key: "B",
            text: "Another synthetic answer",
            ...(answered ? { explanation: "Synthetic distractor explanation." } : {}),
          },
        ],
        ...(answered
          ? {
              selectedOptionKey: "A",
              correctOptionKey: "A",
              isCorrect: true,
            }
          : {}),
      },
    ],
  };
}

function installFetch(options: {
  answer?: (body: Record<string, unknown>, call: number) => Promise<Response>;
} = {}) {
  const answerBodies: Array<Record<string, unknown>> = [];
  let answerCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname === "/api/practice/csrf") {
      return jsonResponse({ csrfToken: `v1.${"A".repeat(43)}` });
    }
    if (url.pathname === "/api/practice/scopes") {
      return jsonResponse(scopes);
    }
    if (
      url.pathname === "/api/practice/attempts" &&
      (init?.method === undefined || init.method === "GET")
    ) {
      return jsonResponse({ items: [] });
    }
    if (url.pathname === "/api/practice/attempts" && init?.method === "POST") {
      return jsonResponse(attemptResponse(), 201);
    }
    if (url.pathname === "/api/practice/attempts/attempt-1/answers") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      answerBodies.push(body);
      answerCalls += 1;
      return options.answer
        ? options.answer(body, answerCalls)
        : jsonResponse(attemptResponse({ answered: true, completed: true }));
    }
    throw new Error(`Unexpected practice request: ${init?.method} ${url.pathname}`);
  };
  return answerBodies;
}

async function startOneQuestionPractice() {
  render(createElement(LearnerPractice));
  await screen.findByRole("option", { name: /Synthetic certification/ });
  await waitFor(() => {
    assert.equal(
      (screen.getByRole("button", { name: "Start practice" }) as HTMLButtonElement).disabled,
      false,
    );
  });
  fireEvent.change(screen.getByLabelText("Number of questions"), {
    target: { value: "1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start practice" }));
  await screen.findByRole("heading", { name: "Your question" });
}

test("keeps the first render neutral, hides answers, and shows Saved only after acknowledgement", async () => {
  installFetch();
  render(createElement(LearnerPractice));
  assert.ok(screen.getByRole("heading", { name: "Loading practice" }));
  await screen.findByRole("option", { name: /Synthetic certification/ });
  await waitFor(() => {
    assert.equal(
      (screen.getByRole("button", { name: "Start practice" }) as HTMLButtonElement).disabled,
      false,
    );
  });
  fireEvent.change(screen.getByLabelText("Number of questions"), {
    target: { value: "1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start practice" }));
  await screen.findByRole("heading", { name: "Your question" });
  assert.ok(screen.getByText("Saved"));
  assert.equal(screen.queryByText("Synthetic explanation."), null);
  assert.equal(screen.queryByText("Correct answer"), null);

  const radio = screen.getByRole("radio", { name: /Synthetic answer/ });
  fireEvent.click(radio);
  assert.equal(screen.getByRole("button", { name: "Save & exit" }).hasAttribute("disabled"), true);
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  await screen.findByRole("heading", { name: "Practice summary" });
  fireEvent.click(screen.getByText("Review submitted answers"));
  assert.ok(screen.getByText(/Synthetic explanation\./));
  assert.ok(screen.getByText("1 / 1 correct"));
  assert.equal(screen.getByRole("button", { name: "Save & exit" }).hasAttribute("disabled"), false);
  fireEvent.click(screen.getByRole("button", { name: "Save & exit" }));
  await screen.findByRole("heading", { name: "Choose an exam" });
  assert.ok(
    screen.getByText("Your acknowledged progress remains saved on the server."),
  );
});

test("retains an unacknowledged answer and retries with the same idempotency key", async () => {
  const bodies = installFetch({
    answer: async (_body, call) => {
      if (call === 1) throw new TypeError("simulated network loss");
      return jsonResponse(attemptResponse({ answered: true, completed: true }));
    },
  });
  await startOneQuestionPractice();
  fireEvent.click(screen.getByRole("radio", { name: /Synthetic answer/ }));
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  await screen.findByText("Unable to save");
  assert.equal(
    (screen.getByRole("radio", { name: /Synthetic answer/ }) as HTMLInputElement).checked,
    true,
  );
  assert.ok(screen.getByRole("button", { name: "Retry the same answer safely" }));

  fireEvent.click(screen.getByRole("button", { name: "Retry the same answer safely" }));
  await screen.findByRole("heading", { name: "Practice summary" });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0]?.requestId, bodies[1]?.requestId);
  assert.equal(bodies[0]?.expectedVersion, bodies[1]?.expectedVersion);
  assert.equal(bodies[0]?.selectedOptionKey, bodies[1]?.selectedOptionKey);
});

test("explains missing session or active exam access without treating a demo role as authority", async () => {
  globalThis.fetch = async () =>
    jsonResponse({ error: { code: "unauthenticated", requestId: "synthetic" } }, 401);
  render(createElement(LearnerPractice));
  await screen.findByRole("alert");
  assert.match(
    screen.getByRole("alert").textContent ?? "",
    /session is missing or expired/i,
  );
});
