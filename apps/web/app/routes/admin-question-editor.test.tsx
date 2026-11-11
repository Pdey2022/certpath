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

function questionRow(
  id: string,
  questionKey: string,
  revisionId: string,
  revisionNumber: number,
  lockVersion = revisionNumber,
) {
  return {
    id,
    questionKey,
    currentRevisionId: revisionId,
    revisionNumber,
    lockVersion,
    stem: `Question ${questionKey}`,
    workflowState: "draft",
  };
}

async function openQuestionList() {
  render(createElement(AdminQuestionEditor));
  await screen.findByRole("option", { name: /Synthetic certification/ });
  fireEvent.change(screen.getByLabelText("Certification"), { target: { value: "cert-1" } });
  await waitFor(() => assert.ok(screen.getByRole("option", { name: /Synthetic version/ })));
  fireEvent.change(screen.getByLabelText("Exam version"), { target: { value: "version-1" } });
  await waitFor(() => assert.ok(screen.getByRole("option", { name: /Synthetic domain/ })));
  fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "domain-1" } });
  await waitFor(() => assert.ok(screen.getByRole("option", { name: /Synthetic topic/ })));
  fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "topic-1" } });
}

function installEditorFetch(options: {
  questions: (url: URL) => Promise<ReturnType<typeof questionRow>[]> | ReturnType<typeof questionRow>[];
  revisions: (questionId: string) => Array<{
    id: string;
    revisionNumber: number;
    workflowState: string;
    createdAt: number;
  }>;
  detail: (questionId: string, revisionId: string) => Promise<unknown> | unknown;
  correct?: (body: Record<string, unknown>) => Promise<Response> | Response;
}) {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), browser.location.href);
    const path = url.pathname;
    if (path.endsWith("/csrf")) {
      return jsonResponse({ csrfToken: `v1.${"A".repeat(43)}` });
    }
    if (path === "/api/admin/content/certifications") {
      return jsonResponse({
        items: [{ id: "cert-1", slug: "synthetic", displayName: "Synthetic certification" }],
        nextCursor: null,
      });
    }
    if (path.endsWith("/exam-versions")) {
      return jsonResponse({
        items: [{ id: "version-1", versionKey: "v1", title: "Synthetic version" }],
        nextCursor: null,
      });
    }
    if (path.endsWith("/domains")) {
      return jsonResponse({
        items: [{ id: "domain-1", domainKey: "domain", title: "Synthetic domain", order: 0 }],
        nextCursor: null,
      });
    }
    if (path.endsWith("/topics")) {
      return jsonResponse({
        items: [{ id: "topic-1", topicKey: "topic", title: "Synthetic topic", order: 0 }],
        nextCursor: null,
      });
    }
    const exactRevision = path.match(/\/questions\/([^/]+)\/revisions\/([^/]+)$/);
    if (exactRevision && init?.method !== "POST") {
      return jsonResponse(await options.detail(exactRevision[1], exactRevision[2]));
    }
    const revisions = path.match(/\/questions\/([^/]+)\/revisions$/);
    if (revisions && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return await (options.correct?.(body) ?? jsonResponse({ revisionId: "revision-new", revisionNumber: 2 }, 201));
    }
    if (revisions) {
      return jsonResponse({
        items: options.revisions(revisions[1]),
        nextCursor: null,
      });
    }
    if (path.endsWith("/questions")) {
      return jsonResponse({ items: await options.questions(url), nextCursor: null });
    }
    throw new Error(`Unexpected synthetic editor request: ${path}`);
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

test("requires explicit latest-revision recovery when detail shows the question advanced after listing", async () => {
  const savedVersions: unknown[] = [];
  installEditorFetch({
    questions: () => [questionRow("question-1", "SYNTHETIC-QUESTION-1", "revision-1", 1)],
    revisions: () => [
      { id: "revision-2", revisionNumber: 2, workflowState: "draft", createdAt: 2 },
      { id: "revision-1", revisionNumber: 1, workflowState: "draft", createdAt: 1 },
    ],
    detail: (questionId, revisionId) => {
      if (revisionId === "revision-1") {
        return { ...revision(revisionId, 1, firstContent.stem), lockVersion: 2 };
      }
      if (revisionId === "revision-2") {
        return { ...revision(revisionId, 2, "Latest synthetic question?"), lockVersion: 2 };
      }
      if (revisionId === "revision-3") {
        return { ...revision(revisionId, 3, "Corrected synthetic question?"), lockVersion: 3 };
      }
      throw new Error(`Unexpected revision ${questionId}/${revisionId}`);
    },
    correct: (body) => {
      savedVersions.push(body.expectedLockVersion);
      return jsonResponse({ revisionId: "revision-3", revisionNumber: 3 }, 201);
    },
  });

  await openQuestionList();
  fireEvent.click(await screen.findByRole("button", { name: /SYNTHETIC-QUESTION-1/ }));
  const stemField = await screen.findByLabelText("Question stem") as HTMLTextAreaElement;
  assert.equal(stemField.value, firstContent.stem);
  assert.match((await screen.findByRole("note")).textContent ?? "", /advanced after this revision/);
  assert.equal(screen.getByRole("button", { name: "Save correction" }).hasAttribute("disabled"), true);

  fireEvent.click(screen.getByRole("button", { name: "Load latest revision" }));
  await screen.findByText(/Loaded server revision 2/);
  assert.equal(stemField.value, firstContent.stem);
  fireEvent.click(screen.getByRole("button", { name: /Use latest revision as base/ }));
  fireEvent.change(stemField, { target: { value: "A reviewed correction to the latest revision?" } });
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  await screen.findByText(/Saved as revision 3/);
  assert.deepEqual(savedVersions, [2]);
});

test("out-of-order question detail responses cannot replace the active selection", async () => {
  let resolveFirst!: (value: unknown) => void;
  const firstDetail = new Promise<unknown>((resolve) => {
    resolveFirst = resolve;
  });
  installEditorFetch({
    questions: () => [
      questionRow("question-1", "SYNTHETIC-QUESTION-1", "revision-1", 1),
      questionRow("question-2", "SYNTHETIC-QUESTION-2", "revision-2", 1),
    ],
    revisions: (questionId) => [{
      id: questionId === "question-1" ? "revision-1" : "revision-2",
      revisionNumber: 1,
      workflowState: "draft",
      createdAt: 1,
    }],
    detail: (questionId) => {
      if (questionId === "question-1") return firstDetail;
      return {
        ...revision("revision-2", 1, "Question two's exact loaded stem?"),
        questionId: "question-2",
      };
    },
  });

  await openQuestionList();
  fireEvent.click(await screen.findByRole("button", { name: /SYNTHETIC-QUESTION-1/ }));
  fireEvent.click(await screen.findByRole("button", { name: /SYNTHETIC-QUESTION-2/ }));
  const stemField = await screen.findByLabelText("Question stem") as HTMLTextAreaElement;
  await waitFor(() => assert.equal(stemField.value, "Question two's exact loaded stem?"));

  resolveFirst({
    ...revision("revision-1", 1, "Question one's late response stem?"),
    questionId: "question-1",
  });
  await waitFor(() => assert.equal(stemField.value, "Question two's exact loaded stem?"));
  assert.match(screen.getByRole("heading", { name: /Edit SYNTHETIC-QUESTION-2/ }).textContent ?? "", /QUESTION-2/);
});

test("out-of-order question search results cannot replace the newest query", async () => {
  let resolveFirstSearch!: (items: ReturnType<typeof questionRow>[]) => void;
  const firstSearch = new Promise<ReturnType<typeof questionRow>[]>((resolve) => {
    resolveFirstSearch = resolve;
  });
  installEditorFetch({
    questions: (url) => {
      const search = url.searchParams.get("search");
      if (search === "alpha") return firstSearch;
      if (search === "beta") {
        return [questionRow("question-beta", "SYNTHETIC-BETA", "revision-beta", 1)];
      }
      return [];
    },
    revisions: () => [],
    detail: () => {
      throw new Error("No revision details are expected in the search test");
    },
  });

  await openQuestionList();
  await screen.findByText("No questions match this topic and search.");
  const search = screen.getByLabelText("Find by question key or stem");
  fireEvent.change(search, { target: { value: "alpha" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  fireEvent.change(search, { target: { value: "beta" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByRole("button", { name: /SYNTHETIC-BETA/ });

  resolveFirstSearch([
    questionRow("question-alpha", "SYNTHETIC-ALPHA", "revision-alpha", 1),
  ]);
  await waitFor(() => {
    assert.ok(screen.getByRole("button", { name: /SYNTHETIC-BETA/ }));
    assert.equal(screen.queryByRole("button", { name: /SYNTHETIC-ALPHA/ }), null);
  });
});

test("out-of-order exact revision loads cannot replace the selected revision", async () => {
  let resolveOlderRevision!: (detail: unknown) => void;
  const olderRevision = new Promise<unknown>((resolve) => {
    resolveOlderRevision = resolve;
  });
  installEditorFetch({
    questions: () => [questionRow("question-1", "SYNTHETIC-QUESTION-1", "revision-3", 3)],
    revisions: () => [
      { id: "revision-3", revisionNumber: 3, workflowState: "draft", createdAt: 3 },
      { id: "revision-2", revisionNumber: 2, workflowState: "draft", createdAt: 2 },
      { id: "revision-1", revisionNumber: 1, workflowState: "draft", createdAt: 1 },
    ],
    detail: (_questionId, revisionId) => {
      if (revisionId === "revision-1") return olderRevision;
      return {
        ...revision(revisionId, revisionId === "revision-3" ? 3 : 2, `Loaded ${revisionId}?`),
        lockVersion: 3,
      };
    },
  });

  await openQuestionList();
  fireEvent.click(await screen.findByRole("button", { name: /SYNTHETIC-QUESTION-1/ }));
  await screen.findByLabelText("Exact revision");
  const revisionSelect = screen.getByLabelText("Exact revision");
  fireEvent.change(revisionSelect, { target: { value: "revision-1" } });
  fireEvent.change(revisionSelect, { target: { value: "revision-2" } });
  const stemField = await screen.findByLabelText("Question stem") as HTMLTextAreaElement;
  await waitFor(() => assert.equal(stemField.value, "Loaded revision-2?"));

  resolveOlderRevision({
    ...revision("revision-1", 1, "Late revision 1 response?"),
    lockVersion: 3,
  });
  await waitFor(() => assert.equal(stemField.value, "Loaded revision-2?"));
  assert.ok(screen.getByRole("option", { name: "Revision 2 · draft", selected: true }));
});

test("a save response cannot overwrite a different question selected while it is in flight", async () => {
  let resolveSave!: (response: Response) => void;
  const pendingSave = new Promise<Response>((resolve) => {
    resolveSave = resolve;
  });
  installEditorFetch({
    questions: () => [
      questionRow("question-1", "SYNTHETIC-QUESTION-1", "revision-1", 1),
      questionRow("question-2", "SYNTHETIC-QUESTION-2", "revision-2", 1),
    ],
    revisions: (questionId) => [{
      id: questionId === "question-1" ? "revision-1" : "revision-2",
      revisionNumber: 1,
      workflowState: "draft",
      createdAt: 1,
    }],
    detail: (questionId, revisionId) => ({
      ...revision(revisionId, 1, questionId === "question-1"
        ? "Question one's loaded stem?"
        : "Question two's loaded stem?"),
      questionId,
    }),
    correct: () => pendingSave,
  });

  await openQuestionList();
  fireEvent.click(await screen.findByRole("button", { name: /SYNTHETIC-QUESTION-1/ }));
  const stemField = await screen.findByLabelText("Question stem") as HTMLTextAreaElement;
  fireEvent.change(stemField, { target: { value: "Question one's pending correction?" } });
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  await screen.findByRole("button", { name: "Saving…" });

  fireEvent.click(screen.getByRole("button", { name: /SYNTHETIC-QUESTION-2/ }));
  await waitFor(() => assert.equal(stemField.value, "Question two's loaded stem?"));
  resolveSave(jsonResponse({ revisionId: "revision-created", revisionNumber: 2 }, 201));
  await waitFor(() => assert.equal(stemField.value, "Question two's loaded stem?"));
  assert.match(screen.getByRole("heading", { name: /Edit SYNTHETIC-QUESTION-2/ }).textContent ?? "", /QUESTION-2/);
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
      if (correctionCalls === 2) {
        return jsonResponse({
          items: [
            { id: "revision-3", revisionNumber: 3, workflowState: "draft", createdAt: 3 },
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
    if (url.pathname.endsWith("/questions/question-1/revisions/revision-4")) {
      return jsonResponse(revision("revision-4", 4, "My unsaved revised stem?"));
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
      return jsonResponse(
        { error: { code: "conflict", requestId: "later-synthetic-conflict" } },
        409,
      );
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
  const secondStaleNotice = await screen.findByRole("alert");
  assert.match(secondStaleNotice.textContent ?? "", /changed since it was loaded/);
  assert.equal(stemField.value, "My unsaved revised stem?");
  assert.equal(correctionCalls, 2);
  assert.equal(correctionPayloads[1]?.expectedLockVersion, 2);
  assert.equal(
    (correctionPayloads[1]?.content as { stem?: string } | undefined)?.stem,
    "My unsaved revised stem?",
  );
});
