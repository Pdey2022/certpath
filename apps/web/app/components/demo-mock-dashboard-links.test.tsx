import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import * as React from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Window } from "happy-dom";
import {
  answerDemoMock,
  demoMockDurationMs,
  demoMockStorageKey,
  parseDemoMock,
  startDemoMock,
  submitDemoMock,
} from "../lib/demo-mock";
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

const { cleanup, render, screen, within } =
  await import("@testing-library/react");
const { DemoMockDashboardLinks } = await import("./demo-mock-dashboard-links");

afterEach(() => {
  cleanup();
  browser.localStorage.clear();
});

function renderLinks() {
  const router = createMemoryRouter(
    [
      { path: "/app", element: createElement(DemoMockDashboardLinks) },
      {
        path: "/app/exams/:exam/mock",
        element: createElement("p", null, "Mock setup"),
      },
      {
        path: "/app/exams/:exam/mock/active",
        element: createElement("p", null, "Mock attempt"),
      },
    ],
    { initialEntries: ["/app"] },
  );
  render(createElement(RouterProvider, { router }));
  return router;
}

function mockCard(exam: "CISSP" | "CISM") {
  const heading = screen.getByRole("heading", { name: `${exam} timed mock` });
  return within(heading.closest("article")!);
}

test("dashboard links resume or show each exam's own saved attempt after refresh", async () => {
  const now = Date.now();
  let cissp = startDemoMock(now - 20_000);
  cissp = answerDemoMock(cissp, 0, demoQuestions[0].correctIndex);
  cissp = answerDemoMock(cissp, 1, 0);
  browser.localStorage.setItem(demoMockStorageKey("cissp"), JSON.stringify(cissp));

  let cism = startDemoMock(now - 40_000);
  cism = answerDemoMock(cism, 0, demoQuestions[0].correctIndex);
  cism = answerDemoMock(cism, 1, demoQuestions[1].correctIndex);
  cism = submitDemoMock(cism, now, "manual");
  browser.localStorage.setItem(demoMockStorageKey("cism"), JSON.stringify(cism));

  let router = renderLinks();
  const cisspCard = mockCard("CISSP");
  const cismCard = mockCard("CISM");
  await cisspCard.findByRole("link", { name: "Resume mock" });
  await cismCard.findByRole("link", { name: "View result" });
  assert.ok(cisspCard.getByText(/Question 2 of 3 · 2 answered/));
  assert.match(cismCard.getByText(/Submitted · 2 of 3 correct/).textContent ?? "", /Submitted/);
  assert.equal(cisspCard.getByRole("link", { name: "Resume mock" }).getAttribute("href"), "/app/exams/cissp/mock/active");
  assert.equal(cismCard.getByRole("link", { name: "View result" }).getAttribute("href"), "/app/exams/cism/mock/active");

  cleanup();
  router = renderLinks();
  await mockCard("CISSP").findByRole("link", { name: "Resume mock" });
  await mockCard("CISM").findByRole("link", { name: "View result" });
  assert.equal(router.state.location.pathname, "/app");
});

test("expired attempts become results and corrupt or missing saves offer exam-specific starts", async () => {
  const now = Date.now();
  const expired = startDemoMock(now - demoMockDurationMs - 1_000);
  browser.localStorage.setItem(demoMockStorageKey("cism"), JSON.stringify(expired));
  browser.localStorage.setItem(demoMockStorageKey("cissp"), "{bad");

  renderLinks();
  await mockCard("CISSP").findByRole("link", { name: "Start mock" });
  await mockCard("CISM").findByRole("link", { name: "View result" });
  assert.equal(
    parseDemoMock(browser.localStorage.getItem(demoMockStorageKey("cism")))?.submitReason,
    "expired",
  );
  assert.equal(mockCard("CISSP").getByRole("link", { name: "Start mock" }).getAttribute("href"), "/app/exams/cissp/mock");
  assert.equal(mockCard("CISM").getByRole("link", { name: "View result" }).getAttribute("href"), "/app/exams/cism/mock/active");

  browser.localStorage.removeItem(demoMockStorageKey("cism"));
  cleanup();
  renderLinks();
  await mockCard("CISSP").findByRole("link", { name: "Start mock" });
  await mockCard("CISM").findByRole("link", { name: "Start mock" });
  assert.equal(mockCard("CISM").getByRole("link", { name: "Start mock" }).getAttribute("href"), "/app/exams/cism/mock");
});

test("updates an active dashboard link to View result when the attempt expires", async () => {
  const now = Date.now();
  const cissp = startDemoMock(now - demoMockDurationMs + 300);
  const cism = startDemoMock(now);
  browser.localStorage.setItem(demoMockStorageKey("cissp"), JSON.stringify(cissp));
  browser.localStorage.setItem(demoMockStorageKey("cism"), JSON.stringify(cism));

  renderLinks();
  await mockCard("CISSP").findByRole("link", { name: "Resume mock" });
  await mockCard("CISSP").findByRole("link", { name: "View result" }, { timeout: 2000 });
  await mockCard("CISM").findByRole("link", { name: "Resume mock" });
  assert.equal(
    parseDemoMock(browser.localStorage.getItem(demoMockStorageKey("cissp")))?.submitReason,
    "expired",
  );
  assert.equal(
    parseDemoMock(browser.localStorage.getItem(demoMockStorageKey("cism")))?.status,
    "in-progress",
  );
});
