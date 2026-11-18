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

// AC-10 for Phase 5B, narrowed by 0022: exactly one module may issue
// `DELETE FROM pilot_events` - the twelve-month retention prune - and every other
// module in `apps/api/src` must keep writing no delete. The allowlist is pinned
// both ways, so it cannot grow silently and cannot go stale.
const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const pilotEventsDeleteAllowlist = new Set([
  path.join("analytics", "pilot-events-retention.ts"),
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

test("only the retention prune deletes from pilot_events", () => {
  const offenders = sourceFiles(sourceRoot)
    // This file names the statement it allows; it must not count itself.
    .filter((file) => !file.endsWith(`${path.sep}index.test.ts`))
    .filter((file) =>
      /DELETE\s+FROM\s+pilot_events/i.test(readFileSync(file, "utf8")),
    )
    .map((file) => path.relative(sourceRoot, file))
    .filter((file) => !pilotEventsDeleteAllowlist.has(file));

  assert.deepEqual(offenders, []);
});

test("the deletion allowlist names the module that actually deletes", () => {
  for (const relative of pilotEventsDeleteAllowlist) {
    assert.match(
      readFileSync(path.join(sourceRoot, relative), "utf8"),
      /DELETE\s+FROM\s+pilot_events/i,
      `${relative} is allowlisted but issues no DELETE`,
    );
  }
});
