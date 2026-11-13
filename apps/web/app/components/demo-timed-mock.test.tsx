import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import * as React from "react";
import { Window } from "happy-dom";
import {
  answerDemoMock,
  demoMockStorageKey,
  startDemoMock,
} from "../lib/demo-mock";
import { demoQuestions } from "../lib/prototype-data";

const browser = new Window({ url: "http://localhost/app/exams/cissp/mock/active" });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: browser },
  document: { configurable: true, value: browser.document },
  navigator: { configurable: true, value: browser.navigator },
  HTMLElement: { configurable: true, value: browser.HTMLElement },
  HTMLInputElement: { configurable: true, value: browser.HTMLInputElement },
  Node: { configurable: true, value: browser.Node },
  Event: { configurable: true, value: browser.Event },
  MouseEvent: { configurable: true, value: browser.MouseEvent },
  React: { configurable: true, value: React },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
});

const { act, cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { createMemoryRouter, RouterProvider, useParams } =
  await import("react-router");
const { DemoTimedMock } = await import("./demo-timed-mock");

afterEach(() => {
  cleanup();
  browser.localStorage.clear();
});

function renderMock(exam: "cissp" | "cism") {
  function ExamRoute() {
    const params = useParams();
    const currentExam = params.exam === "cism" ? "cism" : "cissp";
    return createElement(DemoTimedMock, {
      exam: currentExam,
      leaveTo: `/app/exams/${currentExam}/mock`,
    });
  }

  const router = createMemoryRouter(
    [
      { path: "/app/exams/:exam/mock/active", element: createElement(ExamRoute) },
      { path: "/app/exams/:exam/mock", element: createElement("p", null, "Instructions") },
    ],
    { initialEntries: [`/app/exams/${exam}/mock/active`] },
  );
  render(createElement(RouterProvider, { router }));
  return router;
}

function makeAttempt(startedAt: number, answers: (number | null)[], questionIndex: number) {
  let attempt = startDemoMock(startedAt);
  answers.forEach((answer, index) => {
    if (answer !== null) attempt = answerDemoMock(attempt, index, answer);
  });
  return { ...attempt, questionIndex };
}

test("switching exams and remounting restores each timed mock independently", async () => {
  const now = Date.now();
  const cisspAnswers = demoQuestions.map((question) => question.correctIndex);
  const cismAnswers = demoQuestions.map((question) =>
    question.correctIndex === 0 ? 1 : 0,
  );
  browser.localStorage.setItem(
    demoMockStorageKey("cissp"),
    JSON.stringify(makeAttempt(now - 30_000, cisspAnswers, 1)),
  );
  browser.localStorage.setItem(
    demoMockStorageKey("cism"),
    JSON.stringify(makeAttempt(now - 80_000, cismAnswers, 2)),
  );

  const router = renderMock("cissp");
  await screen.findByText(/Question 2 of 3 · 3 answered/);
  assert.match(screen.getByRole("timer").textContent ?? "", /2:3\d remaining/);
  assert.equal(
    (screen.getByRole("radio", {
      name: demoQuestions[1].options[cisspAnswers[1]],
    }) as HTMLInputElement).checked,
    true,
  );

  await act(async () => {
    await router.navigate("/app/exams/cism/mock/active");
  });
  await screen.findByText(/Question 3 of 3 · 3 answered/);
  assert.match(screen.getByRole("timer").textContent ?? "", /1:4\d remaining/);
  assert.equal(
    (screen.getByRole("radio", {
      name: demoQuestions[2].options[cismAnswers[2]],
    }) as HTMLInputElement).checked,
    true,
  );

  await act(async () => {
    await router.navigate("/app/exams/cissp/mock/active");
  });
  await screen.findByText(/Question 2 of 3 · 3 answered/);
  fireEvent.click(screen.getByRole("button", { name: "Submit mock" }));
  await screen.findByRole("heading", { name: /Score: 3 of 3/ });

  await act(async () => {
    await router.navigate("/app/exams/cism/mock/active");
  });
  await screen.findByText(/Question 3 of 3 · 3 answered/);
  fireEvent.click(screen.getByRole("button", { name: "Submit mock" }));
  await screen.findByRole("heading", { name: /Score: 0 of 3/ });

  await act(async () => {
    await router.navigate("/app/exams/cissp/mock/active");
  });
  await screen.findByRole("heading", { name: /Score: 3 of 3/ });

  cleanup();
  renderMock("cism");
  await screen.findByRole("heading", { name: /Score: 0 of 3/ });
  cleanup();
  renderMock("cissp");
  await screen.findByRole("heading", { name: /Score: 3 of 3/ });
});
