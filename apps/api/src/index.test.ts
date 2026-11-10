import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "./index.ts";

test("health responds without exposing runtime or account data", async () => {
  const response = await api.request("/api/health?demoRole=global_admin");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { status: "ok" });
});
