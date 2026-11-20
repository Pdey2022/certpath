// The provisioning allowlist and the staging Worker's own config must name the
// same database. If `wrangler.staging.jsonc` is recreated with a new UUID and the
// allowlist in `apps/api/src/staff-provisioning.ts` is not updated, remote
// provisioning refuses at run time with `database-id-mismatch` - or, worse, a
// stale allowlist aims at a database that no longer exists. This test makes that
// drift fail `npm run verify` instead.
//
// It runs under Node rather than workerd because it reads the committed config
// from disk, and it imports the allowlist from the API source so the two halves
// cannot disagree silently.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  approvedRemoteDatabases,
  resolveRemoteDatabase,
} from "../../api/src/staff-provisioning.ts";
import { parseJsonc } from "./lib/d1-targets.mjs";

const configUrl = new URL("../wrangler.staging.jsonc", import.meta.url);

function stagingDatabaseEntry() {
  const config = parseJsonc(
    readFileSync(configUrl, "utf8"),
    "apps/web/wrangler.staging.jsonc",
  );
  const databases = Array.isArray(config.d1_databases)
    ? config.d1_databases
    : [];
  assert.equal(
    databases.length,
    1,
    "wrangler.staging.jsonc must bind exactly one D1 database",
  );
  return databases[0];
}

test("the staging config's database is the provisioning allowlist's only entry", () => {
  const entry = stagingDatabaseEntry();

  assert.equal(entry.binding, "DB");
  assert.equal(entry.database_name, "certpath-learner-staging");
  assert.equal(
    approvedRemoteDatabases.length,
    1,
    "the 5C posture is one database; a second target needs its own decision",
  );
  assert.equal(
    String(entry.database_id).toLowerCase(),
    approvedRemoteDatabases[0].databaseId,
    "wrangler.staging.jsonc and approvedRemoteDatabases disagree about the staging UUID; update both in the same commit",
  );
});

test("the pair recorded in the staging config is the pair the script accepts", () => {
  const entry = stagingDatabaseEntry();

  // No throw: the exact name and UUID the deployed Worker uses is an allowed
  // remote target, so provisioning can address staging without any other flag.
  assert.deepEqual(
    resolveRemoteDatabase(entry.database_name, entry.database_id),
    approvedRemoteDatabases[0],
  );

  // Any other UUID for the same name is refused before the CLI is spawned.
  assert.throws(
    () =>
      resolveRemoteDatabase(
        entry.database_name,
        "00000000-0000-4000-8000-000000000001",
      ),
    (error) => error?.code === "database-id-mismatch",
  );
});
