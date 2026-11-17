// End-to-end tests for the Phase 5A scripts. Each test spawns the real CLI, so
// it fails when the guard inside the script is removed, not just when a helper
// changes. Everything is written to a fresh temp directory; nothing in the
// repository is read/written except the configs and migrations under test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sha256Hex, tablesFromDump } from "./lib/d1-targets.mjs";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const migrationsDir = path.join(repoRoot, "db", "migrations");

const SCRIPTS = {
  isolation: path.join(scriptsDir, "check-d1-isolation.mjs"),
  export: path.join(scriptsDir, "d1-export.mjs"),
  rehearse: path.join(scriptsDir, "d1-restore-rehearse.mjs"),
  chain: path.join(scriptsDir, "d1-chain-check.mjs"),
};

function run(script, args) {
  const result = spawnSync(process.execPath, [SCRIPTS[script], ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

function tempDir(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "certpath-5a-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// A tiny dump shaped like Wrangler's export: one INSERT per row, explicit
// column lists, and a d1_migrations ledger. No learner data of any kind.
const FIXTURE_DUMP = [
  'CREATE TABLE IF NOT EXISTS "d1_migrations" (',
  "\tid INTEGER PRIMARY KEY AUTOINCREMENT,",
  "\tname TEXT UNIQUE,",
  "\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL",
  ");",
  "INSERT INTO \"d1_migrations\" (\"id\",\"name\") VALUES(1,'0001_foundation.sql');",
  'CREATE TABLE "accounts" (',
  "\tid INTEGER PRIMARY KEY,",
  "\tlabel TEXT NOT NULL",
  ");",
  "INSERT INTO \"accounts\" (\"id\",\"label\") VALUES(1,'first');",
  "",
].join("\n");

function writeFixture(directory, { dump = FIXTURE_DUMP, accountsInserts = 1 } = {}) {
  const file = "certpath-local-20260101T000000Z.sql";
  const dumpPath = path.join(directory, file);
  writeFileSync(dumpPath, dump);
  const bytes = readFileSync(dumpPath);
  const manifest = {
    schemaVersion: 1,
    target: "local",
    binding: "DB",
    databaseName: "certpath-local",
    databaseIdClass: "placeholder",
    wranglerConfig: "apps/web/wrangler.jsonc",
    capturedAt: "2026-01-01T00:00:00Z",
    gitCommit: "0".repeat(40),
    wranglerVersion: "4.160.0",
    file,
    byteLength: bytes.length,
    sha256: sha256Hex(bytes),
    tables: tablesFromDump(dump).map((table) =>
      table.name === "accounts"
        ? { name: "accounts", inserts: accountsInserts }
        : table,
    ),
    migrations: ["0001_foundation.sql"],
  };
  writeFileSync(`${dumpPath}.manifest.json`, JSON.stringify(manifest, null, 2));
  return { dumpPath, manifest };
}

test("d1-export refuses an unprovisioned remote target with exit 3 and writes no file", (t) => {
  const out = path.join(tempDir(t), "out");
  const result = run("export", ["--target", "pilot", "--out", out]);

  assert.equal(result.status, 3, result.output);
  assert.match(result.output, /d1_not_provisioned/);
  assert.deepEqual(existsSync(out) ? readdirSync(out) : [], []);
});

test("d1-export rejects an unknown target with exit 2 and writes no file", (t) => {
  const out = path.join(tempDir(t), "out");
  const result = run("export", ["--target", "nope", "--out", out]);

  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /unknown_target/);
  assert.deepEqual(existsSync(out) ? readdirSync(out) : [], []);
});

test("rehearsal reports a manifest count that is one too high with an exact diff", (t) => {
  // The dump holds one accounts row; the manifest claims two.
  const { dumpPath } = writeFixture(tempDir(t), { accountsInserts: 2 });
  const before = readFileSync(dumpPath);

  const result = run("rehearse", ["--file", dumpPath]);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /per-table diff/);
  assert.match(result.output, /accounts: manifest 2, restored 1 \(-1\)/);
  // Nothing is auto-repaired: the dump is byte-identical afterwards.
  assert.equal(sha256Hex(readFileSync(dumpPath)), sha256Hex(before));
});

test("rehearsal without a sidecar manifest exits 2 and never guesses", (t) => {
  const directory = tempDir(t);
  const dumpPath = path.join(directory, "certpath-local-20260101T000000Z.sql");
  writeFileSync(dumpPath, FIXTURE_DUMP);

  const result = run("rehearse", ["--file", dumpPath]);

  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /manifest_missing/);
});

test("rehearsal refuses --persist-to so it can never touch a real database", (t) => {
  const { dumpPath } = writeFixture(tempDir(t));

  const result = run("rehearse", [
    "--file",
    dumpPath,
    "--persist-to",
    path.join(tempDir(t), "state"),
  ]);

  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /persist_to_not_allowed/);
});

test("a preview config that binds D1 fails the isolation gate", (t) => {
  const configDir = tempDir(t);
  for (const file of [
    "wrangler.jsonc",
    "wrangler.preview.jsonc",
    "wrangler.staging.jsonc",
    "wrangler.pilot.jsonc",
  ]) {
    cpSync(path.join(webRoot, file), path.join(configDir, file));
  }
  const previewPath = path.join(configDir, "wrangler.preview.jsonc");
  const preview = JSON.parse(readFileSync(previewPath, "utf8"));
  preview.d1_databases = [
    {
      binding: "DB",
      database_name: "certpath-preview",
      database_id: "00000000-0000-0000-0000-000000000000",
    },
  ];
  writeFileSync(previewPath, JSON.stringify(preview, null, 2));

  const result = run("isolation", ["--config-dir", configDir]);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /preview_binds_d1/);
});

test("the real configs pass the isolation gate", () => {
  const result = run("isolation", []);

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /D1 isolation OK/);
});

test("a changed byte in an applied migration fails with migration_checksum_changed", (t) => {
  const copyDir = path.join(tempDir(t), "migrations");
  cpSync(migrationsDir, copyDir, { recursive: true });
  const target = path.join(copyDir, "0007_cognito_login_transactions.sql");
  const original = readFileSync(target, "utf8");
  writeFileSync(target, original.replace("CREATE TABLE", "CREATE  TABLE"));

  const result = run("chain", ["--migrations-dir", copyDir]);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /migration_checksum_changed/);
  assert.match(result.output, /0007_cognito_login_transactions\.sql/);
});

test("a truncated dump fails the rehearsal instead of restoring part of it", (t) => {
  const { dumpPath } = writeFixture(tempDir(t));
  const bytes = readFileSync(dumpPath);
  writeFileSync(dumpPath, bytes.subarray(0, Math.floor(bytes.length * 0.9)));

  const result = run("rehearse", ["--file", dumpPath]);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /dump_size_mismatch/);
});

test("one extra INSERT INTO accounts fails the rehearsal with an exact diff", (t) => {
  const directory = tempDir(t);
  const tampered = `${FIXTURE_DUMP}INSERT INTO "accounts" ("id","label") VALUES(2,'second');\n`;
  // Re-hash the dump so the manifest matches the bytes: the count, not the
  // hash, is what must catch this.
  const { dumpPath, manifest } = writeFixture(directory, {
    dump: tampered,
    accountsInserts: 1,
  });
  assert.equal(manifest.sha256, sha256Hex(readFileSync(dumpPath)));

  const result = run("rehearse", ["--file", dumpPath]);

  assert.equal(result.status, 1, result.output);
  assert.doesNotMatch(result.output, /dump_sha256_mismatch/);
  assert.match(result.output, /accounts: manifest 1, restored 2 \(\+1\)/);
});

test("chain, export local and rehearse round-trip the whole schema", (t) => {
  const directory = tempDir(t);
  const work = path.join(directory, "work");
  mkdirSync(work);
  const out = path.join(directory, "exports");

  const chain = run("chain", ["--work-dir", work]);
  assert.equal(chain.status, 0, chain.output);

  const exported = run("export", [
    "--target",
    "local",
    "--out",
    out,
    "--wrangler-config",
    path.join(work, "wrangler.jsonc"),
  ]);
  assert.equal(exported.status, 0, exported.output);

  const dumps = readdirSync(out).filter((name) => name.endsWith(".sql"));
  assert.equal(dumps.length, 1, `expected exactly one dump, found ${dumps.join(", ")}`);
  const dumpPath = path.join(out, dumps[0]);
  assert.ok(existsSync(`${dumpPath}.manifest.json`));

  const manifest = JSON.parse(readFileSync(`${dumpPath}.manifest.json`, "utf8"));
  const migrations = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.deepEqual(manifest.migrations, migrations);
  assert.equal(manifest.sha256, sha256Hex(readFileSync(dumpPath)));
  assert.equal(manifest.byteLength, readFileSync(dumpPath).length);
  const ledger = manifest.tables.find((table) => table.name === "d1_migrations");
  assert.equal(ledger?.inserts, migrations.length);
  assert.ok(
    manifest.tables.length >= migrations.length + 10,
    `expected the full schema, saw ${manifest.tables.length} tables`,
  );

  const rehearse = run("rehearse", ["--file", dumpPath]);
  assert.equal(rehearse.status, 0, rehearse.output);
  assert.match(rehearse.output, /integrity_check ok/);
});
