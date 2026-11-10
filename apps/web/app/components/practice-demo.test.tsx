import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import * as React from "react";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://localhost" });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: browser },
  document: { configurable: true, value: browser.document },
  navigator: { configurable: true, value: browser.navigator },
  HTMLElement: { configurable: true, value: browser.HTMLElement },
  HTMLInputElement: { configurable: true, value: browser.HTMLInputElement },
  HTMLFieldSetElement: { configurable: true, value: browser.HTMLFieldSetElement },
  Node: { configurable: true, value: browser.Node },
  Event: { configurable: true, value: browser.Event },
  MouseEvent: { configurable: true, value: browser.MouseEvent },
  React: { configurable: true, value: React },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
});

const { cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { PracticeDemo } = await import("./practice-demo");
const { WorkspaceShell } = await import("./workspace-shell");
const { default: Admin } = await import("../routes/admin");
const originalSetItem = browser.localStorage.setItem.bind(browser.localStorage);

afterEach(() => {
  cleanup();
  browser.localStorage.clear();
  Object.defineProperty(browser.localStorage, "setItem", {
    configurable: true,
    value: originalSetItem,
  });
});

const workspaceLinks = [
  { label: "Home", to: "/app" },
  { label: "Practice", to: "/app/practice" },
];

function renderPractice() {
  const router = createMemoryRouter(
    [
      {
        path: "/app/practice/session",
        element: createElement(
          WorkspaceShell,
          {
            title: "Learner preview · synthetic data",
            mobileNavigation: "learner",
            links: workspaceLinks,
            children: createElement(PracticeDemo),
          },
        ),
      },
      { path: "/app", element: createElement("h1", null, "Learner home") },
      {
        path: "/app/practice",
        element: createElement("h1", null, "Practice hub"),
      },
    ],
    { initialEntries: ["/app/practice/session"] },
  );
  const rendered = render(createElement(RouterProvider, { router }));
  return { router, ...rendered };
}

function renderManagerAdmin() {
  const router = createMemoryRouter(
    [{ path: "/admin/*", element: createElement(Admin) }],
    { initialEntries: ["/admin/security?demoRole=manager"] },
  );
  const rendered = render(createElement(RouterProvider, { router }));
  return { router, ...rendered };
}

async function waitForSaved() {
  await screen.findByText("Saved on this browser (demo)");
}

test("failed save stays in the session, warns before leaving, retries, and exits only after save", async () => {
  browser.localStorage.clear();
  const originalSetItem = browser.localStorage.setItem.bind(browser.localStorage);
  let failFirstWrite = true;
  Object.defineProperty(browser.localStorage, "setItem", {
    configurable: true,
    value(key: string, value: string) {
      if (failFirstWrite) {
        failFirstWrite = false;
        throw new Error("Storage is unavailable.");
      }
      originalSetItem(key, value);
    },
  });

  const { router } = renderPractice();
  await screen.findByText("Not saved yet");
  const answer = screen.getByRole("radio", {
    name: "Purchase the most expensive available monitoring tool",
  });
  fireEvent.click(answer);
  await screen.findByText("Unable to save—retry");
  assert.equal((answer as HTMLInputElement).checked, true);
  assert.match(screen.getByRole("note").textContent ?? "", /This change is unsaved/);

  fireEvent.click(screen.getAllByRole("button", { name: "Stay in practice" })[0]);
  assert.equal(router.state.location.pathname, "/app/practice/session");
  assert.equal((answer as HTMLInputElement).checked, true);
  assert.match(screen.getByRole("status").textContent ?? "", /unsaved change remains here/);

  fireEvent.click(screen.getAllByRole("link", { name: "Home" })[0]);
  const dialog = await screen.findByRole("alertdialog");
  assert.match(dialog.textContent ?? "", /may discard this change/);
  fireEvent.click(within(dialog).getByRole("button", { name: "Stay in practice" }));
  assert.equal(router.state.location.pathname, "/app/practice/session");

  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await waitForSaved();
  fireEvent.click(screen.getByRole("button", { name: "Save & exit" }));
  await waitFor(() => {
    assert.equal(router.state.location.pathname, "/app/practice");
  });
  assert.ok(browser.localStorage.getItem("certpath-demo-practice-v1"));

});

test("last explanation requires View results and results provide read-only answer review", async () => {
  browser.localStorage.clear();
  const { router } = renderPractice();
  await screen.findByText("Not saved yet");

  for (let questionIndex = 0; questionIndex < 3; questionIndex += 1) {
    const option = screen.getByRole("radio", {
      name:
        questionIndex === 0
          ? "Identify the information assets and the risks they face"
          : questionIndex === 1
            ? "Confirm the approved sanitization method for the media and data class"
            : "Record the business justification, risk owner, compensating controls, and review date",
    });

    fireEvent.click(option);
    await waitForSaved();
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    await waitFor(() => {
      assert.ok(document.querySelector(".explanation"));
    });
    await waitForSaved();

    if (questionIndex < 2) {
      fireEvent.click(screen.getByRole("button", { name: "Next question" }));
      await screen.findByText(`Question ${questionIndex + 2} of 3`);
      await waitForSaved();
    }
  }

  assert.equal(router.state.location.pathname, "/app/practice/session");
  assert.equal(screen.getByRole("button", { name: "View results" }) !== null, true);
  assert.equal(screen.queryByRole("heading", { name: "Your practice summary" }), null);

  fireEvent.click(screen.getByRole("button", { name: "View results" }));
  assert.equal(screen.getAllByRole("button", { name: /Review question/ }).length, 3);
  fireEvent.click(screen.getByRole("button", { name: "Review question 2" }));

  const radio = screen.getByRole("radio", {
    name: "Confirm the approved sanitization method for the media and data class",
  }) as HTMLInputElement;
  const fieldset = radio.closest("fieldset") as HTMLFieldSetElement;
  assert.equal(fieldset.disabled, true);
  assert.equal(radio.checked, true);
  fireEvent.click(radio);
  assert.equal(radio.checked, true);
  assert.equal(screen.queryByRole("button", { name: "Submit answer" }), null);

  fireEvent.click(screen.getByRole("button", { name: "Back to results" }));
  assert.ok(screen.getByRole("heading", { name: "Your practice summary" }));
});

test("Manager permission recovery and content navigation preserve the preview query", async () => {
  const { router } = renderManagerAdmin();
  await screen.findByRole("heading", {
    name: "Not available in the Manager preview",
  });
  assert.equal(
    screen.getByRole("link", { name: "Return to assigned CISSP content" }).getAttribute("href"),
    "/admin/questions?demoRole=manager",
  );

  fireEvent.click(screen.getByRole("link", { name: "Return to assigned CISSP content" }));
  await screen.findByRole("heading", { name: "Question editor" });
  assert.equal(router.state.location.search, "?demoRole=manager");
  assert.equal(screen.queryByRole("heading", { name: "Preview role selector" }), null);

  fireEvent.click(screen.getAllByRole("link", { name: "Certifications" })[0]);
  await screen.findByRole("heading", {
    name: "Certifications and exam modules",
  });
  assert.equal(router.state.location.search, "?demoRole=manager");
  assert.equal(
    screen.getByRole("link", { name: "Manage modules" }).getAttribute("href"),
    "/admin/modules?demoRole=manager",
  );
});
