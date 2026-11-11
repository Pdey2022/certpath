import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import * as React from "react";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://localhost/admin/question-editor" });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: browser },
  document: { configurable: true, value: browser.document },
  navigator: { configurable: true, value: browser.navigator },
  HTMLElement: { configurable: true, value: browser.HTMLElement },
  HTMLInputElement: { configurable: true, value: browser.HTMLInputElement },
  HTMLSelectElement: { configurable: true, value: browser.HTMLSelectElement },
  HTMLTextAreaElement: { configurable: true, value: browser.HTMLTextAreaElement },
  Node: { configurable: true, value: browser.Node },
  Event: { configurable: true, value: browser.Event },
  MouseEvent: { configurable: true, value: browser.MouseEvent },
  React: { configurable: true, value: React },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
});

const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { default: AdminQuestionEditor } =
  await import("./admin-question-editor");
const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

const firstContent = {
  stem: "Synthetic original question stem?",
  difficulty: "medium",
  sourceReference: "Synthetic source",
  licenseReference: "Synthetic licence",
  options: [
    { key: "A", order: 1, text: "First answer", correct: true, explanation: "First explanation." },
    { key: "B", order: 2, text: "Second answer", correct: false, explanation: "Second explanation." },
  ],
};

function revision(
  revisionId: string,
  revisionNumber: number,
  stem: string,
) {
  return {
    revisionId,
    questionId: "question-1",
    certificationId: "cert-1",
    examVersionId: "version-1",
    domainId: "domain-1",
    topicId: "topic-1",
    revisionNumber,
    lockVersion: revisionNumber,
    stem,
    difficulty: firstContent.difficulty,
    sourceReference: firstContent.sourceReference,
    licenseReference: firstContent.licenseReference,
    workflowState: "draft",
    options: firstContent.options,
  };
}

test("renders a neutral shell and clearly explains a missing staff session", async () => {
  globalThis.fetch = async () => jsonResponse(
    { error: { code: "unauthenticated", requestId: "synthetic-request" } },
    401,
  );
  render(createElement(AdminQuestionEditor));
  assert.ok(screen.getByRole("status").textContent?.includes("Checking the current staff session"));
  const alert = await screen.findByRole("alert");
  assert.match(alert.textContent ?? "", /session is missing, expired, or revoked/);
  assert.equal(document.querySelector(".protected-demo-separation")?.textContent?.includes("do not grant access"), true);
});

test("keeps edits after a stale correction and retries only after explicitly loading the latest revision", async () => {
  let correctionCalls = 0;
  const correctionPayloads: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname.endsWith("/csrf")) {
      return jsonResponse({ csrfToken: `v1.${"A".repeat(43)}` });
    }
    if (url.pathname === "/api/admin/content/certifications") {
      return jsonResponse({
        items: [{ id: "cert-1", slug: "synthetic", displayName: "Synthetic certification" }],
        nextCursor: null,
      });
    }
    if (url.pathname.endsWith("/exam-versions")) {
      return jsonResponse({
        items: [{ id: "version-1", versionKey: "v1", title: "Synthetic version" }],
        nextCursor: null,
      });
    }
    if (url.pathname.endsWith("/domains")) {
      return jsonResponse({
        items: [{ id: "domain-1", domainKey: "domain", title: "Synthetic domain", order: 0 }],
        nextCursor: null,
      });
    }
    if (url.pathname.endsWith("/topics")) {
      return jsonResponse({
        items: [{ id: "topic-1", topicKey: "topic", title: "Synthetic topic", order: 0 }],
        nextCursor: null,
      });
    }
    if (url.pathname.endsWith("/questions") && init?.method !== "POST") {
      return jsonResponse({
        items: [{
          id: "question-1",
          questionKey: "SYNTHETIC-QUESTION-1",
          currentRevisionId: correctionCalls > 1 ? "revision-3" : "revision-1",
          revisionNumber: correctionCalls > 1 ? 3 : 1,
          lockVersion: correctionCalls > 1 ? 3 : 1,
          stem: correctionCalls > 1 ? "My unsaved revised stem?" : firstContent.stem,
          workflowState: "draft",
        }],
        nextCursor: null,
      });
    }
    if (url.pathname.endsWith("/questions/question-1/revisions") && init?.method !== "POST") {
      if (correctionCalls === 1) {
        return jsonResponse({
          items: [
            { id: "revision-2", revisionNumber: 2, workflowState: "draft", createdAt: 2 },
            { id: "revision-1", revisionNumber: 1, workflowState: "draft", createdAt: 1 },
          ],
          nextCursor: null,
        });
      }
      return jsonResponse({
        items: [{ id: "revision-1", revisionNumber: 1, workflowState: "draft", createdAt: 1 }],
        nextCursor: null,
      });
    }
    if (url.pathname.endsWith("/questions/question-1/revisions/revision-1")) {
      return jsonResponse(revision("revision-1", 1, firstContent.stem));
    }
    if (url.pathname.endsWith("/questions/question-1/revisions/revision-2")) {
      return jsonResponse(revision("revision-2", 2, "Concurrent server revision stem?"));
    }
    if (url.pathname.endsWith("/questions/question-1/revisions/revision-3")) {
      return jsonResponse(revision("revision-3", 3, "My unsaved revised stem?"));
    }
    if (url.pathname.endsWith("/questions/question-1/revisions") && init?.method === "POST") {
      correctionPayloads.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      correctionCalls += 1;
      if (correctionCalls === 1) {
        return jsonResponse(
          { error: { code: "conflict", requestId: "synthetic-conflict" } },
          409,
        );
      }
      return jsonResponse({ revisionId: "revision-3", revisionNumber: 3 }, 201);
    }
    throw new Error(`Unexpected synthetic editor request: ${url.pathname}`);
  };

  render(createElement(AdminQuestionEditor));
  await screen.findByRole("option", { name: /Synthetic certification/ });
  fireEvent.change(screen.getByLabelText("Certification"), { target: { value: "cert-1" } });
  await waitFor(() => assert.ok(screen.getByRole("option", { name: /Synthetic version/ })));
  fireEvent.change(screen.getByLabelText("Exam version"), { target: { value: "version-1" } });
  await waitFor(() => assert.ok(screen.getByRole("option", { name: /Synthetic domain/ })));
  fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "domain-1" } });
  await waitFor(() => assert.ok(screen.getByRole("option", { name: /Synthetic topic/ })));
  fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "topic-1" } });
  const questionChoice = await screen.findByRole("button", { name: /SYNTHETIC-QUESTION-1/ });
  fireEvent.click(questionChoice);
  const stemField = await screen.findByLabelText("Question stem") as HTMLTextAreaElement;
  fireEvent.change(stemField, { target: { value: "My unsaved revised stem?" } });
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  const staleNotice = await screen.findByRole("alert");
  assert.match(staleNotice.textContent ?? "", /changed since it was loaded/);
  assert.equal(stemField.value, "My unsaved revised stem?");

  fireEvent.click(screen.getByRole("button", { name: "Load latest revision" }));
  await screen.findByText("Concurrent server revision stem?");
  assert.equal(stemField.value, "My unsaved revised stem?");
  fireEvent.click(screen.getByRole("button", { name: /Use latest revision as base/ }));
  assert.equal(stemField.value, "My unsaved revised stem?");
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  await screen.findByText(/Saved as revision 3/);
  assert.equal(correctionCalls, 2);
  assert.equal(correctionPayloads[1]?.expectedLockVersion, 2);
  assert.equal(
    (correctionPayloads[1]?.content as { stem?: string } | undefined)?.stem,
    "My unsaved revised stem?",
  );
});
