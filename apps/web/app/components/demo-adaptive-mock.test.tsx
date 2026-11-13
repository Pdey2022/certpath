import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import * as React from "react";
import { Window } from "happy-dom";

const browser = new Window({
  url: "http://localhost/app/exams/cissp/pro/preview/session",
});
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
const { DemoAdaptiveMock } = await import("./demo-adaptive-mock");
const { demoAdaptiveMockStorageKey } = await import("../lib/demo-adaptive-mock");
const { demoQuestions } = await import("../lib/prototype-data");

afterEach(() => {
  cleanup();
  browser.localStorage.clear();
});

function renderMock(exam: "cissp" | "cism") {
  function ExamRoute() {
    const params = useParams();
    const currentExam = params.exam === "cism" ? "cism" : "cissp";
    return createElement(DemoAdaptiveMock, {
      exam: currentExam,
      leaveTo: `/app/exams/${currentExam}/pro/preview`,
    });
  }

  const router = createMemoryRouter(
    [
      {
        path: "/app/exams/:exam/pro/preview/session",
        element: createElement(ExamRoute),
      },
    ],
    { initialEntries: [`/app/exams/${exam}/pro/preview/session`] },
  );
  render(createElement(RouterProvider, { router }));
  return router;
}

test("CISSP and CISM resume separate adaptive paths and retain final results", async () => {
  let router = renderMock("cissp");
  fireEvent.click(await screen.findByRole("button", { name: "Start adaptive mock" }));
  await screen.findByRole("heading", { name: demoQuestions[0].stem });
  fireEvent.click(screen.getByRole("radio", { name: demoQuestions[0].options[1] }));
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  await screen.findByText(/Next question difficulty: Foundational/);
  assert.equal(
    (screen.getByRole("radio", { name: demoQuestions[0].options[1] }).closest("fieldset") as HTMLFieldSetElement).disabled,
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Next question" }));
  await screen.findByRole("heading", { name: demoQuestions[2].stem });

  await act(async () => {
    await router.navigate("/app/exams/cism/pro/preview/session");
  });
  fireEvent.click(await screen.findByRole("button", { name: "Start adaptive mock" }));
  await screen.findByRole("heading", { name: demoQuestions[0].stem });
  fireEvent.click(screen.getByRole("radio", { name: demoQuestions[0].options[0] }));
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  await screen.findByText(/Next question difficulty: Intermediate/);
  fireEvent.click(screen.getByRole("button", { name: "Next question" }));
  await screen.findByRole("heading", { name: demoQuestions[1].stem });
  assert.match(screen.getByText(/Difficulty: Intermediate/).textContent ?? "", /Intermediate/);

  await act(async () => {
    await router.navigate("/app/exams/cissp/pro/preview/session");
  });
  await screen.findByRole("heading", { name: demoQuestions[2].stem });
  fireEvent.click(screen.getByRole("radio", { name: demoQuestions[2].options[0] }));
  cleanup();
  renderMock("cissp");
  await screen.findByRole("heading", { name: demoQuestions[2].stem });
  assert.equal((screen.getByRole("radio", { name: demoQuestions[2].options[0] }) as HTMLInputElement).checked, true);
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  await screen.findByText(/Next question difficulty: Intermediate/);
  fireEvent.click(screen.getByRole("button", { name: "Next question" }));
  await screen.findByRole("heading", { name: demoQuestions[1].stem });
  fireEvent.click(screen.getByRole("radio", { name: demoQuestions[1].options[0] }));
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  await screen.findByRole("heading", { name: "Final score: 2 of 3" });
  assert.ok(screen.getByText(demoQuestions[0].explanations[1]));
  assert.equal(browser.localStorage.getItem(demoAdaptiveMockStorageKey("cism")) !== null, true);

  cleanup();
  router = renderMock("cism");
  await screen.findByRole("heading", { name: demoQuestions[1].stem });
  fireEvent.click(screen.getByRole("radio", { name: demoQuestions[1].options[1] }));
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  await screen.findByText(/Next question difficulty: Foundational/);
  fireEvent.click(screen.getByRole("button", { name: "Next question" }));
  await screen.findByRole("heading", { name: demoQuestions[2].stem });
  fireEvent.click(screen.getByRole("radio", { name: demoQuestions[2].options[0] }));
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  await screen.findByRole("heading", { name: "Final score: 2 of 3" });

  cleanup();
  renderMock("cissp");
  await screen.findByRole("heading", { name: "Final score: 2 of 3" });
});
