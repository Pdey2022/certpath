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
import { demoQuestions } from "../lib/prototype-data";

const browser = new Window({ url: "http://localhost/app" });
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

const { cleanup, fireEvent, render, screen, within } =
  await import("@testing-library/react");
const { DemoProMockDashboardLinks } =
  await import("./demo-pro-mock-dashboard-links");

afterEach(() => {
  cleanup();
  browser.localStorage.clear();
});

function renderLinks() {
  const router = createMemoryRouter(
    [
      { path: "/app", element: createElement(DemoProMockDashboardLinks) },
      {
        path: "/app/exams/:exam/pro/preview",
        element: createElement("p", null, "Pro mock setup"),
      },
      {
        path: "/app/exams/:exam/pro/preview/session",
        element: createElement("p", null, "Pro mock session"),
      },
    ],
    { initialEntries: ["/app"] },
  );
  render(createElement(RouterProvider, { router }));
  return router;
}

function proCard(exam: "CISSP" | "CISM") {
  const heading = screen.getByRole("heading", { name: `${exam} Pro mock` });
  return within(heading.closest("article")!);
}

function createInProgressAttempt() {
  let attempt = startDemoAdaptiveMock();
  attempt = selectDemoAdaptiveAnswer(attempt, demoQuestions[0].correctIndex);
  attempt = submitDemoAdaptiveAnswer(attempt);
  attempt = advanceDemoAdaptiveMock(attempt);
  return selectDemoAdaptiveAnswer(attempt, demoQuestions[1].correctIndex);
}

function createCompletedAttempt() {
  let attempt = startDemoAdaptiveMock();
  attempt = selectDemoAdaptiveAnswer(attempt, 1);
  attempt = submitDemoAdaptiveAnswer(attempt);
  attempt = advanceDemoAdaptiveMock(attempt);
  attempt = selectDemoAdaptiveAnswer(attempt, demoQuestions[2].correctIndex);
  attempt = submitDemoAdaptiveAnswer(attempt);
  attempt = advanceDemoAdaptiveMock(attempt);
  attempt = selectDemoAdaptiveAnswer(attempt, demoQuestions[1].correctIndex);
  return submitDemoAdaptiveAnswer(attempt);
}

test("CISSP and CISM dashboard cards resume and show their own saved Pro attempts", async () => {
  browser.localStorage.setItem(
    demoAdaptiveMockStorageKey("cissp"),
    JSON.stringify(createInProgressAttempt()),
  );
  browser.localStorage.setItem(
    demoAdaptiveMockStorageKey("cism"),
    JSON.stringify(createCompletedAttempt()),
  );

  let router = renderLinks();
  const cissp = proCard("CISSP");
  const cism = proCard("CISM");
  await cissp.findByRole("link", { name: "Resume Pro mock" });
  await cism.findByRole("link", { name: "View result" });
  assert.ok(cissp.getByText(/Question 2 of 3 · 1 answered/));
  assert.match(cism.getByText(/Completed · 2 of 3 correct/).textContent ?? "", /2 of 3/);
  assert.equal(
    cissp.getByRole("link", { name: "Resume Pro mock" }).getAttribute("href"),
    "/app/exams/cissp/pro/preview/session",
  );
  assert.equal(
    cism.getByRole("link", { name: "View result" }).getAttribute("href"),
    "/app/exams/cism/pro/preview/session",
  );
  fireEvent.click(cism.getByRole("link", { name: "View result" }));
  assert.equal(router.state.location.pathname, "/app/exams/cism/pro/preview/session");

  cleanup();
  router = renderLinks();
  await proCard("CISSP").findByRole("link", { name: "Resume Pro mock" });
  await proCard("CISM").findByRole("link", { name: "View result" });
  assert.equal(router.state.location.pathname, "/app");
});

test("missing and invalid Pro attempts offer the matching exam's setup link", async () => {
  browser.localStorage.setItem(demoAdaptiveMockStorageKey("cissp"), "{bad");
  const router = renderLinks();
  const cissp = proCard("CISSP");
  const cism = proCard("CISM");
  await cissp.findByRole("link", { name: "Start Pro mock" });
  await cism.findByRole("link", { name: "Start Pro mock" });
  assert.equal(
    cissp.getByRole("link", { name: "Start Pro mock" }).getAttribute("href"),
    "/app/exams/cissp/pro/preview",
  );
  assert.equal(
    cism.getByRole("link", { name: "Start Pro mock" }).getAttribute("href"),
    "/app/exams/cism/pro/preview",
  );
  fireEvent.click(cissp.getByRole("link", { name: "Start Pro mock" }));
  assert.equal(router.state.location.pathname, "/app/exams/cissp/pro/preview");
});
