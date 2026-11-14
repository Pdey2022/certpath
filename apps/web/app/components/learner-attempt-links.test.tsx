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
  HTMLInputElement: { configurable: true, value: browser.HTMLInputElement },
  HTMLSelectElement: { configurable: true, value: browser.HTMLSelectElement },
  Node: { configurable: true, value: browser.Node },
  Event: { configurable: true, value: browser.Event },
  MouseEvent: { configurable: true, value: browser.MouseEvent },
  React: { configurable: true, value: React },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
});

const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { LearnerDashboard } = await import("./learner-dashboard");
const { LearnerPractice } = await import("./learner-practice");
const { LearnerTimedMock } = await import("./learner-timed-mock");
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function dashboardResponse() {
  return {
    groups: [
      {
        certificationId: "cert-1",
        certificationName: "Synthetic certification",
        examVersionId: "version-1",
        versionKey: "v1",
        examVersionTitle: "Synthetic version",
        access: {
          state: "active",
          endsAt: null,
          graceEndsAt: null,
          graceDaysRemaining: 0,
        },
        readiness: null,
        resumable: [
          {
            id: "practice-resume",
            kind: "practice",
            state: "in_progress",
            questionCount: 2,
            answeredCount: 1,
            currentPosition: 1,
            createdAt: 100,
            updatedAt: 200,
            completedAt: null,
          },
          {
            id: "mock-resume",
            kind: "timed_mock",
            state: "in_progress",
            questionCount: 10,
            answeredCount: 1,
            currentPosition: 1,
            deadlineAt: 1_800_000_900_000,
            completionReason: null,
            createdAt: 100,
            updatedAt: 200,
            completedAt: null,
          },
        ],
        completed: [
          {
            id: "mock-result",
            kind: "timed_mock",
            state: "completed",
            questionCount: 10,
            answeredCount: 2,
            currentPosition: 4,
            correctCount: 7,
            deadlineAt: 1_800_000_800_000,
            completionReason: "timed_out",
            createdAt: 100,
            updatedAt: 300,
            completedAt: 300,
          },
        ],
      },
    ],
  };
}

function practiceAttempt(id: string) {
  return {
    attempt: {
      id,
      certificationId: "cert-1",
      examVersionId: "version-1",
      state: "in_progress",
      version: 2,
      questionCount: 2,
      currentPosition: 1,
      createdAt: 100,
      updatedAt: 200,
      completedAt: null,
      filters: {},
    },
    items: [
      {
        position: 0,
        revisionId: `${id}-revision-1`,
        stem: `${id} acknowledged question`,
        options: [
          { key: "A", text: "Acknowledged synthetic answer" },
          { key: "B", text: "Other synthetic answer" },
        ],
        selectedOptionKey: "A",
        correctOptionKey: "A",
        isCorrect: true,
      },
      {
        position: 1,
        revisionId: `${id}-revision-2`,
        stem: `${id} current question`,
        options: [
          { key: "A", text: "Current synthetic answer" },
          { key: "B", text: "Other current answer" },
        ],
      },
    ],
  };
}

function timedMockAttempt(
  id: string,
  completed: boolean,
  stemPrefix = id,
) {
  const now = 1_800_000_000_000;
  return {
    attempt: {
      id,
      certificationId: "cert-1",
      examVersionId: "version-1",
      state: completed ? "completed" : "in_progress",
      completionReason: completed ? "timed_out" : null,
      version: completed ? 3 : 2,
      profileVersion: 1,
      durationSeconds: 900,
      questionCount: 10,
      currentPosition: completed ? 4 : 0,
      answeredCount: completed ? 2 : 1,
      ...(completed ? { correctCount: 7 } : {}),
      startedAt: now - 901_000,
      deadlineAt: completed ? now - 1_000 : now + 899_000,
      completedAt: completed ? now : null,
      createdAt: now - 901_000,
      updatedAt: now,
    },
    serverNow: now,
    items: Array.from({ length: 10 }, (_, position) => ({
      position,
      revisionId: `${id}-revision-${position}`,
      stem: `${stemPrefix} question ${position + 1}`,
      options: [
        {
          key: "A",
          text: `${stemPrefix} answer ${position + 1}`,
          ...(completed ? { explanation: "Synthetic result explanation." } : {}),
        },
        {
          key: "B",
          text: `${stemPrefix} other answer ${position + 1}`,
          ...(completed ? { explanation: "Synthetic distractor explanation." } : {}),
        },
      ],
      ...(position === 0
        ? {
            selectedOptionKey: "A",
            ...(completed ? { correctOptionKey: "A", isCorrect: true } : {}),
          }
        : {}),
      ...(completed && position > 0
        ? { correctOptionKey: "A", isCorrect: false }
        : {}),
    })),
  };
}

const scopes = {
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
      domains: [{ id: "domain-1", title: "Synthetic domain" }],
    },
  ],
};

function renderWorkspace() {
  const router = createMemoryRouter(
    [
      { path: "/app/home", element: createElement(LearnerDashboard) },
      { path: "/app/practice/live", element: createElement(LearnerPractice) },
      { path: "/app/mock/live", element: createElement(LearnerTimedMock) },
    ],
    { initialEntries: ["/app/home"] },
  );
  render(createElement(RouterProvider, { router }));
  return { router };
}

function installFetch(
  overrides: {
    practice?: (id: string) => Promise<Response> | Response;
    timedMock?: (id: string) => Promise<Response> | Response;
  } = {},
) {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname === "/api/practice/dashboard") {
      return jsonResponse(dashboardResponse());
    }
    if (url.pathname === "/api/practice/scopes") return jsonResponse(scopes);
    if (url.pathname === "/api/practice/attempts") {
      return jsonResponse({ items: [] });
    }
    if (url.pathname.startsWith("/api/practice/attempts/")) {
      const attemptId = url.pathname.split("/").at(-1) ?? "";
      return overrides.practice?.(attemptId) ??
        (attemptId === "practice-resume"
          ? jsonResponse(practiceAttempt(attemptId))
          : jsonResponse({ error: { code: "not_found" } }, 404));
    }
    if (url.pathname === "/api/practice/mocks") {
      return jsonResponse({ items: [] });
    }
    if (url.pathname.startsWith("/api/practice/mocks/")) {
      const id = url.pathname.split("/").at(-1) ?? "";
      return overrides.timedMock?.(id) ??
        (id === "mock-resume"
          ? jsonResponse(timedMockAttempt(id, false))
          : id === "mock-result"
            ? jsonResponse(timedMockAttempt(id, true))
            : jsonResponse({ error: { code: "not_found" } }, 404));
    }
    if (url.pathname === "/api/practice/csrf") {
      return jsonResponse({ csrfToken: `v1.${"A".repeat(43)}` });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  };
}

test("dashboard Resume links load the selected practice and mock with acknowledged progress", async () => {
  installFetch();
  const { router } = renderWorkspace();

  fireEvent.click(await screen.findByRole("link", {
    name: /resume untimed practice for synthetic certification v1/i,
  }));
  await screen.findByText("practice-resume current question");
  assert.ok(screen.getByText("The selected attempt was loaded with server-acknowledged progress."));
  assert.ok(screen.getByText("practice-resume acknowledged question"));
  fireEvent.click(screen.getByText("Review submitted answers"));
  assert.ok(
    screen.getAllByText((_content, element) =>
      element?.textContent?.includes("Your answer: Acknowledged synthetic answer") ?? false,
    ).length > 0,
  );
  assert.equal(router.state.location.search, "?attemptId=practice-resume");

  await act(async () => {
    await router.navigate("/app/home");
  });
  fireEvent.click(await screen.findByRole("link", {
    name: /resume timed mock for synthetic certification v1/i,
  }));
  await screen.findByText("mock-resume question 1");
  assert.equal(
    (screen.getByRole("radio", { name: /mock-resume answer 1/ }) as HTMLInputElement)
      .checked,
    true,
  );
  assert.equal(router.state.location.search, "?attemptId=mock-resume");
});

test("dashboard View result loads the selected completed mock result", async () => {
  installFetch();
  const { router } = renderWorkspace();

  fireEvent.click(await screen.findByRole("link", {
    name: /view timed mock for synthetic certification v1/i,
  }));
  await screen.findByRole("heading", { name: "Mock results" });
  assert.ok(screen.getByText("7 / 10 correct"));
  assert.ok(screen.getByText("mock-result question 1"));
  assert.equal(router.state.location.search, "?attemptId=mock-result");
});

test("a failed practice deep link hides its previous attempt while loading and after failure", async () => {
  const missing = deferred<Response>();
  installFetch({
    practice: (id) =>
      id === "missing-practice"
        ? missing.promise
        : jsonResponse(practiceAttempt(id)),
  });
  const { router } = renderWorkspace();

  fireEvent.click(await screen.findByRole("link", {
    name: /resume untimed practice for synthetic certification v1/i,
  }));
  await screen.findByText("practice-resume current question");

  await act(async () => {
    await router.navigate("/app/practice/live?attemptId=missing-practice");
  });
  await screen.findByText("Loading the selected saved attempt…");
  assert.equal(screen.queryByText("practice-resume current question"), null);

  missing.resolve(jsonResponse({ error: { code: "not_found" } }, 404));
  await screen.findByRole("alert");
  assert.equal(screen.queryByText("practice-resume current question"), null);
  assert.equal(screen.queryByText("Practice summary"), null);
});

test("a failed result link hides the previous timed-mock result while loading and after failure", async () => {
  const missing = deferred<Response>();
  installFetch({
    timedMock: (id) =>
      id === "missing-mock"
        ? missing.promise
        : id === "mock-result"
          ? jsonResponse(timedMockAttempt(id, true))
          : jsonResponse(timedMockAttempt(id, false)),
  });
  const { router } = renderWorkspace();

  fireEvent.click(await screen.findByRole("link", {
    name: /view timed mock for synthetic certification v1/i,
  }));
  await screen.findByRole("heading", { name: "Mock results" });

  await act(async () => {
    await router.navigate("/app/mock/live?attemptId=missing-mock");
  });
  await screen.findByRole("heading", { name: "Loading timed mocks" });
  assert.equal(screen.queryByText("mock-result question 1"), null);
  assert.equal(screen.queryByRole("heading", { name: "Mock results" }), null);

  missing.resolve(jsonResponse({ error: { code: "not_found" } }, 404));
  await screen.findByRole("alert");
  assert.equal(screen.queryByText("mock-result question 1"), null);
  assert.equal(screen.queryByRole("heading", { name: "Mock results" }), null);
});

test("a late timed-mock link response cannot replace the currently selected attempt", async () => {
  const slow = deferred<Response>();
  installFetch({
    timedMock: (id) =>
      id === "slow-mock"
        ? slow.promise
        : id === "fast-mock"
          ? jsonResponse(timedMockAttempt(id, false))
          : jsonResponse({ error: { code: "not_found" } }, 404),
  });
  const { router } = renderWorkspace();
  await screen.findByRole("heading", { name: "Your learning dashboard" });

  await act(async () => {
    await router.navigate("/app/mock/live?attemptId=slow-mock");
  });
  await screen.findByRole("heading", { name: "Loading timed mocks" });
  await act(async () => {
    await router.navigate("/app/mock/live?attemptId=fast-mock");
  });
  await screen.findByText("fast-mock question 1");
  slow.resolve(jsonResponse(timedMockAttempt("slow-mock", false)));

  await waitFor(() => {
    assert.ok(screen.getByText("fast-mock question 1"));
    assert.equal(screen.queryByText("slow-mock question 1"), null);
  });
});

test("a late practice link response cannot replace the currently selected attempt", async () => {
  const slow = deferred<Response>();
  installFetch({
    practice: (id) =>
      id === "slow-practice"
        ? slow.promise
        : jsonResponse(practiceAttempt(id)),
  });
  const { router } = renderWorkspace();
  await screen.findByRole("heading", { name: "Your learning dashboard" });

  await act(async () => {
    await router.navigate("/app/practice/live?attemptId=slow-practice");
  });
  await screen.findByRole("heading", { name: "Loading practice" });
  assert.equal(screen.queryByText("slow-practice current question"), null);
  await act(async () => {
    await router.navigate("/app/practice/live?attemptId=fast-practice");
  });
  await screen.findByText("fast-practice current question");
  slow.resolve(jsonResponse(practiceAttempt("slow-practice")));

  await waitFor(() => {
    assert.ok(screen.getByText("fast-practice current question"));
    assert.equal(screen.queryByText("slow-practice current question"), null);
  });
});
