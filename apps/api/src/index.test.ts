import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { api } from "./index.ts";

test("health responds without exposing runtime or account data", async () => {
  const response = await api.request("/api/health?demoRole=global_admin");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { status: "ok" });
});

// AC-10 for Phase 5B: `pilot_events` has no runtime delete path. Retention is an
// owner decision (12 months, both sources) and its enforcement is a follow-up
// review, so 5B deliberately ships no `DELETE` and no delete-floor trigger. When
// the enforcement lands this test changes with it, on purpose.
const sourceRoot = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

test("no module under apps/api/src deletes from pilot_events", () => {
  const offenders = sourceFiles(sourceRoot)
    // This file names the statement it forbids; it must not count itself.
    .filter((file) => !file.endsWith(`${path.sep}index.test.ts`))
    .filter((file) =>
      /DELETE\s+FROM\s+pilot_events/i.test(readFileSync(file, "utf8")),
    )
    .map((file) => path.relative(sourceRoot, file));

  assert.deepEqual(offenders, []);
});
