import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import * as React from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Window } from "happy-dom";
import {
  advanceDemoAdaptiveMock,
  demoAdaptiveMockStorageKey,
  selectDemoAdaptiveAnswer,
  startDemoAdaptiveMock,
  submitDemoAdaptiveAnswer,
} from "../lib/demo-adaptive-mock";
import {
  answerDemoMock,
  demoMockStorageKey,
  startDemoMock,
  submitDemoMock,
} from "../lib/demo-mock";
import {
  createPracticeDemoState,
  demoQuestions,
  practiceDemoStorageKey,
  updatePracticeDemo,
} from "../lib/prototype-data";

const browser = new Window({ url: "http://localhost/app/progress" });
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

const { cleanup, render, screen, within } =
  await import("@testing-library/react");
const { DemoSavedProgress } = await import("./demo-saved-progress");

afterEach(() => {
  cleanup();
  browser.localStorage.clear();
});

function renderProgress() {
  const router = createMemoryRouter(
    [{ path: "*", element: createElement(DemoSavedProgress) }],
    { initialEntries: ["/app/progress"] },
  );
  render(createElement(RouterProvider, { router }));
  return router;
}

function card(title: string) {
  const heading = screen.getByRole("heading", { name: title });
  return within(heading.closest("article")!);
}

function createCompletedProMock() {
  let attempt = startDemoAdaptiveMock();
  for (let position = 0; position < demoQuestions.length; position += 1) {
    const questionIndex = attempt.questionIndices[position];
    attempt = selectDemoAdaptiveAnswer(attempt, demoQuestions[questionIndex].correctIndex);
    attempt = submitDemoAdaptiveAnswer(attempt);
    if (position < demoQuestions.length - 1) {
      attempt = advanceDemoAdaptiveMock(attempt);
    }
  }
  return attempt;
}

test("keeps shared practice separate and shows each exam's active and completed saves", async () => {
  const now = Date.now();
  let practice = createPracticeDemoState();
  practice = updatePracticeDemo(practice, { type: "select", answerIndex: 0 });
  practice = updatePracticeDemo(practice, { type: "submit" });
  practice = updatePracticeDemo(practice, { type: "next" });
  browser.localStorage.setItem(practiceDemoStorageKey, JSON.stringify(practice));

  let cisspTimed = startDemoMock(now);
  cisspTimed = answerDemoMock(cisspTimed, 0, demoQuestions[0].correctIndex);
  browser.localStorage.setItem(demoMockStorageKey("cissp"), JSON.stringify(cisspTimed));

  let cismTimed = startDemoMock(now - 20_000);
  cismTimed = answerDemoMock(cismTimed, 0, demoQuestions[0].correctIndex);
  cismTimed = answerDemoMock(cismTimed, 1, 1);
  cismTimed = submitDemoMock(cismTimed, now, "manual");
  browser.localStorage.setItem(demoMockStorageKey("cism"), JSON.stringify(cismTimed));

  browser.localStorage.setItem(
    demoAdaptiveMockStorageKey("cissp"),
    JSON.stringify(createCompletedProMock()),
  );
  let cismPro = startDemoAdaptiveMock();
  cismPro = selectDemoAdaptiveAnswer(cismPro, demoQuestions[0].correctIndex);
  cismPro = submitDemoAdaptiveAnswer(cismPro);
  cismPro = advanceDemoAdaptiveMock(cismPro);
  browser.localStorage.setItem(demoAdaptiveMockStorageKey("cism"), JSON.stringify(cismPro));

  renderProgress();
  const practiceCard = card("Shared practice · exam not labelled");
  const cisspTimedCard = card("CISSP timed mock");
  const cismTimedCard = card("CISM timed mock");
  const cisspProCard = card("CISSP Pro mock");
  const cismProCard = card("CISM Pro mock");

  await practiceCard.findByRole("link", { name: "Resume practice" });
  assert.ok(practiceCard.getByText(/Question 2 of 3 · 1 answered/));

  await cisspTimedCard.findByRole("link", { name: "Resume mock" });
  assert.ok(cisspTimedCard.getByText(/Active attempt/));
  assert.equal(cisspTimedCard.queryByRole("link", { name: "View result" }), null);

  await cismTimedCard.findByRole("link", { name: "View result" });
  assert.ok(cismTimedCard.getByText(/Completed result · Submitted · 1 of 3 correct · 2 answered/));
  assert.equal(cismTimedCard.queryByRole("link", { name: "Resume mock" }), null);

  await cisspProCard.findByRole("link", { name: "View result" });
  assert.ok(cisspProCard.getByText(/Completed result · 3 of 3 correct/));

  await cismProCard.findByRole("link", { name: "Resume Pro mock" });
  assert.ok(cismProCard.getByText(/Active attempt · Question 2 of 3 · 1 answered/));

  assert.equal(
    practiceCard.getByRole("link", { name: "Resume practice" }).getAttribute("href"),
    "/app/practice/session",
  );
  assert.equal(
    cismTimedCard.getByRole("link", { name: "View result" }).getAttribute("href"),
    "/app/exams/cism/mock/active",
  );
  assert.equal(
    cisspProCard.getByRole("link", { name: "View result" }).getAttribute("href"),
    "/app/exams/cissp/pro/preview/session",
  );

  cleanup();
  renderProgress();
  await card("Shared practice · exam not labelled").findByRole("link", {
    name: "Resume practice",
  });
  await card("CISSP timed mock").findByRole("link", { name: "Resume mock" });
  await card("CISM timed mock").findByRole("link", { name: "View result" });
  await card("CISSP Pro mock").findByRole("link", { name: "View result" });
  await card("CISM Pro mock").findByRole("link", { name: "Resume Pro mock" });
});

test("shows clear empty states for missing and invalid saves", async () => {
  browser.localStorage.setItem(practiceDemoStorageKey, "{bad");
  browser.localStorage.setItem(demoMockStorageKey("cissp"), "{bad");
  browser.localStorage.setItem(demoAdaptiveMockStorageKey("cism"), "{bad");

  renderProgress();
  await card("Shared practice · exam not labelled").findByRole("link", {
    name: "Start practice",
  });
  await card("CISSP timed mock").findByRole("link", { name: "Start mock" });
  await card("CISM timed mock").findByRole("link", { name: "Start mock" });
  await card("CISSP Pro mock").findByRole("link", { name: "Start Pro mock" });
  await card("CISM Pro mock").findByRole("link", { name: "Start Pro mock" });
  assert.ok(card("Shared practice · exam not labelled").getByText(/No valid shared practice save/));
  assert.ok(card("CISSP timed mock").getByText(/No valid saved timed mock/));
  assert.ok(card("CISM Pro mock").getByText(/No valid saved Pro mock/));
});
