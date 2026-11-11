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
  HTMLTextAreaElement: { configurable: true, value: browser.HTMLTextAreaElement },
  Node: { configurable: true, value: browser.Node },
  Event: { configurable: true, value: browser.Event },
  MouseEvent: { configurable: true, value: browser.MouseEvent },
  React: { configurable: true, value: React },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
});

const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { ProtectedCsvTools } = await import("./protected-csv-tools");
const originalFetch = globalThis.fetch;
const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;
const originalAnchorClick = browser.HTMLAnchorElement.prototype.click;

const scope = {
  certificationId: "cert-1",
  certificationName: "Synthetic certification",
  examVersionId: "version-1",
  examVersionName: "Synthetic version",
};

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

function previewResponse(importId = "import-1"): Response {
  return jsonResponse({
    importId,
    formatVersion: "certpath-question-v1",
    expiresAt: Date.now() + 10 * 60_000,
    summary: { parsedRows: 1, validRows: 1, invalidRows: 0 },
  }, 201);
}

function selectFile(name = "synthetic.csv", contents = "synthetic csv only") {
  const file = new browser.File([contents], name, { type: "text/csv" });
  fireEvent.change(screen.getByLabelText("CSV file"), {
    target: { files: [file] },
  });
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: originalCreateObjectUrl,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: originalRevokeObjectUrl,
  });
  browser.HTMLAnchorElement.prototype.click = originalAnchorClick;
});

test("shows row counts and actionable errors from a protected invalid preview", async () => {
  let uploadedFile = "";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname.endsWith("/csrf")) {
      return jsonResponse({ csrfToken: `v1.${"A".repeat(43)}` });
    }
    if (url.pathname.endsWith("/import-previews")) {
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("Content-Type"), "text/csv");
      uploadedFile = await (init?.body as Blob).text();
      return jsonResponse({
        error: {
          code: "validation_error",
          requestId: "synthetic",
          issues: [{ path: "row.2.content", code: "invalid_question_content" }],
          summary: { parsedRows: 2, validRows: 1, invalidRows: 1 },
        },
      }, 400);
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  render(createElement(ProtectedCsvTools, scope));
  selectFile();
  fireEvent.click(screen.getByRole("button", { name: "Preview selected CSV" }));

  await screen.findByText("Parsed 2 row(s): 1 valid, 1 invalid.");
  assert.ok(screen.getByText("Row 2, column content: review this field and the single-choice question rules."));
  assert.equal(screen.queryByRole("button", { name: "Confirm draft-only import" }), null);
  assert.equal(uploadedFile, "synthetic csv only");
  assert.equal(browser.localStorage.length, 0);
});

test("clears a successful preview when the selected file changes", async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname.endsWith("/csrf")) {
      return jsonResponse({ csrfToken: `v1.${"A".repeat(43)}` });
    }
    if (url.pathname.endsWith("/import-previews")) return previewResponse();
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  render(createElement(ProtectedCsvTools, scope));
  selectFile("first.csv", "first synthetic file");
  fireEvent.click(screen.getByRole("button", { name: "Preview selected CSV" }));
  await screen.findByRole("button", { name: "Confirm draft-only import" });

  selectFile("second.csv", "second synthetic file");
  assert.equal(screen.queryByRole("button", { name: "Confirm draft-only import" }), null);
  assert.equal(screen.queryByText(/Parsed 1 row/), null);
  assert.ok(screen.getByText(/Selected: second\.csv/));
});

test("retries a lost confirmation response using the same preview ID", async () => {
  let confirmCalls = 0;
  const confirmPaths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname.endsWith("/csrf")) {
      return jsonResponse({ csrfToken: `v1.${"A".repeat(43)}` });
    }
    if (url.pathname.endsWith("/import-previews")) return previewResponse();
    if (url.pathname.endsWith("/confirm")) {
      confirmCalls += 1;
      confirmPaths.push(url.pathname);
      if (confirmCalls === 1) throw new Error("synthetic lost response");
      return jsonResponse({
        importId: "import-1",
        questionIds: ["question-1"],
        revisionIds: ["revision-1"],
        questionKeys: ["SYNTHETIC-QUESTION"],
      });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  render(createElement(ProtectedCsvTools, scope));
  selectFile();
  fireEvent.click(screen.getByRole("button", { name: "Preview selected CSV" }));
  await screen.findByRole("button", { name: "Confirm draft-only import" });
  fireEvent.click(screen.getByRole("button", { name: "Confirm draft-only import" }));

  const retry = await screen.findByRole("button", { name: "Retry same preview" });
  assert.match(screen.getByRole("alert").textContent ?? "", /same preview ID/);
  fireEvent.click(retry);
  await screen.findByText(/Created 1 sealed draft/);
  assert.equal(confirmCalls, 2);
  assert.deepEqual(confirmPaths, [
    "/api/admin/content/certifications/cert-1/import-previews/import-1/confirm",
    "/api/admin/content/certifications/cert-1/import-previews/import-1/confirm",
  ]);
  assert.match(screen.getByText(/They are not published/).textContent ?? "", /not published/);
});

test("expired confirmation clears the preview and requires a fresh preview", async () => {
  let previews = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname.endsWith("/csrf")) {
      return jsonResponse({ csrfToken: `v1.${"A".repeat(43)}` });
    }
    if (url.pathname.endsWith("/import-previews")) {
      previews += 1;
      return previewResponse(`import-${previews}`);
    }
    if (url.pathname.endsWith("/confirm")) {
      return jsonResponse({ error: { code: "conflict", requestId: "expired" } }, 409);
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  render(createElement(ProtectedCsvTools, scope));
  selectFile();
  fireEvent.click(screen.getByRole("button", { name: "Preview selected CSV" }));
  await screen.findByRole("button", { name: "Confirm draft-only import" });
  fireEvent.click(screen.getByRole("button", { name: "Confirm draft-only import" }));
  await screen.findByRole("alert");
  assert.match(screen.getByRole("alert").textContent ?? "", /Preview the selected file again/);
  assert.equal(screen.queryByRole("button", { name: "Confirm draft-only import" }), null);
  fireEvent.click(screen.getByRole("button", { name: "Preview selected CSV" }));
  await waitFor(() => assert.equal(previews, 2));
  await screen.findByRole("button", { name: "Confirm draft-only import" });
});

test("reports a denied preview without exposing file or server details", async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname.endsWith("/csrf")) {
      return jsonResponse({ csrfToken: `v1.${"A".repeat(43)}` });
    }
    if (url.pathname.endsWith("/import-previews")) {
      return jsonResponse({
        error: {
          code: "not_found",
          requestId: "synthetic",
        },
      }, 404);
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  render(createElement(ProtectedCsvTools, scope));
  selectFile("private-synthetic.csv", "private synthetic question body");
  fireEvent.click(screen.getByRole("button", { name: "Preview selected CSV" }));
  const alert = await screen.findByRole("alert");
  assert.match(alert.textContent ?? "", /unavailable under your current staff access/);
  assert.doesNotMatch(alert.textContent ?? "", /private synthetic question body|not_found|synthetic/);
});

test("discards a late preview response after the selected exam version changes", async () => {
  let resolvePreview!: (response: Response) => void;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname.endsWith("/csrf")) {
      return jsonResponse({ csrfToken: `v1.${"A".repeat(43)}` });
    }
    if (url.pathname.endsWith("/import-previews")) {
      return new Promise<Response>((resolve) => {
        resolvePreview = resolve;
      });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  const view = render(createElement(ProtectedCsvTools, scope));
  selectFile();
  fireEvent.click(screen.getByRole("button", { name: "Preview selected CSV" }));
  await waitFor(() => assert.ok(resolvePreview));
  view.rerender(createElement(ProtectedCsvTools, {
    ...scope,
    examVersionId: "version-2",
    examVersionName: "Changed version",
  }));
  resolvePreview(previewResponse());
  await waitFor(() => {
    assert.equal(screen.queryByText(/Parsed 1 row/), null);
    assert.equal(screen.queryByRole("button", { name: "Confirm draft-only import" }), null);
  });
  assert.equal(screen.queryByText(/Selected:/), null);
  assert.equal(screen.getByRole("button", { name: "Preview selected CSV" }).hasAttribute("disabled"), true);
});

test("exports bounded pages and indicates when another page is available", async () => {
  const downloadedCsv: string[] = [];
  browser.HTMLAnchorElement.prototype.click = () => undefined;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      void blob.text().then((text) => downloadedCsv.push(text));
      return "blob:synthetic";
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: () => undefined,
  });
  const exportQueries: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), browser.location.href);
    exportQueries.push(url.searchParams.toString());
    if (exportQueries.length === 1) {
      return new Response("synthetic page one", {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "X-Export-Next-Cursor": "question-cursor",
        },
      });
    }
    return new Response("synthetic page two", {
      headers: { "Content-Type": "text/csv; charset=utf-8" },
    });
  };
  render(createElement(ProtectedCsvTools, scope));
  fireEvent.click(screen.getByRole("button", { name: "Download published page 1" }));
  await screen.findByText("Downloaded published-content page 1. Another page is available.");
  await waitFor(() => {
    assert.equal(
      (screen.getByRole("button", { name: "Download published page 2" }) as HTMLButtonElement).disabled,
      false,
    );
  });
  const secondButton = screen.getByRole("button", { name: "Download published page 2" }) as HTMLButtonElement;
  await act(async () => {
    secondButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() =>
    assert.deepEqual(exportQueries, ["limit=100", "limit=100&cursor=question-cursor"]),
  );
  await screen.findByText("Downloaded published-content page 2. There are no more pages.");
  assert.equal(screen.queryByRole("button", { name: "Download published page 3" }), null);
  await waitFor(() => assert.deepEqual(downloadedCsv, ["synthetic page one", "synthetic page two"]));
  assert.match(screen.getByText(/not a re-import file/).textContent ?? "", /not a re-import file/);
});

test("downloads the exact v1 template with a synthetic row bound to current taxonomy", async () => {
  let downloadedTemplate = "";
  browser.HTMLAnchorElement.prototype.click = () => undefined;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      void blob.text().then((text) => {
        downloadedTemplate = text;
      });
      return "blob:synthetic-template";
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: () => undefined,
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname.endsWith("/domains")) {
      return jsonResponse({
        items: [{ id: "domain-1", domainKey: "synthetic-domain", title: "Synthetic domain", order: 0 }],
        nextCursor: null,
      });
    }
    if (url.pathname.endsWith("/topics")) {
      return jsonResponse({
        items: [{ id: "topic-1", topicKey: "synthetic-topic", title: "Synthetic topic", order: 0 }],
        nextCursor: null,
      });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  render(createElement(ProtectedCsvTools, scope));
  fireEvent.click(screen.getByRole("button", { name: "Download exact v1 CSV template" }));
  await screen.findByText(/Downloaded the v1 template with a synthetic example row/);
  await waitFor(() => assert.match(downloadedTemplate, /SYNTHETIC-EXAMPLE-CHANGE-THIS-KEY/));
  assert.match(downloadedTemplate, /"format_version","question_key","exam_version_id"/);
  assert.match(downloadedTemplate, /"version-1","domain-1","topic-1"/);
  assert.match(downloadedTemplate, /"option_8_explanation"/);
  assert.match(downloadedTemplate, /"true","Synthetic explanation A"/);
});

test("rejects oversized files before any CSV upload request", async () => {
  let uploadCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname.endsWith("/csrf")) {
      return jsonResponse({ csrfToken: `v1.${"A".repeat(43)}` });
    }
    if (url.pathname.endsWith("/import-previews")) uploadCalls += 1;
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  render(createElement(ProtectedCsvTools, scope));
  selectFile("oversized.csv", "x".repeat(256 * 1024 + 1));
  fireEvent.click(screen.getByRole("button", { name: "Preview selected CSV" }));
  await screen.findByText("Parsed 0 row(s): 0 valid, 1 invalid.");
  assert.equal(uploadCalls, 0);
  assert.match(screen.getByRole("alert").textContent ?? "", /256 KiB/);
});
