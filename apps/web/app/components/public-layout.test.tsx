import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import * as React from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://localhost/" });
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

const { cleanup, render, screen } = await import("@testing-library/react");
const { PublicLayout } = await import("./public-layout");
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

function renderPublicLayout() {
  globalThis.fetch = async () => jsonResponse({ signInEnabled: false });
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: createElement(PublicLayout, {
          children: createElement("h1", null, "Home page"),
        }),
      },
    ],
    { initialEntries: ["/"] },
  );
  return render(createElement(RouterProvider, { router }));
}

test("public header uses the CertPath brand, not a provisional name", async () => {
  renderPublicLayout();

  const brand = screen.getByRole("link", { name: "CertPath" });
  assert.equal(brand.getAttribute("href"), "/");
  assert.equal((document.querySelectorAll(".public-header .brand")).length, 1);
  assert.doesNotMatch(document.body.textContent ?? "", /working label/i);
});

test("public footer states only the content-review rule", async () => {
  renderPublicLayout();

  const footer = document.querySelector(".public-footer");
  assert.ok(footer, "expected the public footer to render");
  assert.equal(
    footer.textContent?.replace(/\s+/g, " ").trim(),
    "Certification listings and content require review before publication.",
  );
});
