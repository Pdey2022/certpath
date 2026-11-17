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
import { parseJsonc, sha256Hex, tablesFromDump } from "./lib/d1-targets.mjs";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const migrationsDir = path.join(repoRoot, "db", "migrations");

const SCRIPTS = {
  isolation: path.join(scriptsDir, "check-d1-isolation.mjs"),
  export: path.join(scriptsDir, "d1-export.mjs"),
  rehearse: path.join(scriptsDir, "d1-restore-rehearse.mjs"),
  chain: path.join(scriptsDir, "d1-chain-check.mjs"),
  preflight: path.join(scriptsDir, "d1-account-preflight.mjs"),
  preview: path.join(scriptsDir, "preview-command.mjs"),
};

const wranglerBin = (() => {
  for (const candidate of [
    path.join(webRoot, "node_modules", "wrangler", "bin", "wrangler.js"),
    path.join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Cannot find the Wrangler CLI in node_modules");
})();

// Synthetic only: one user, one certification root, one exam version, one
// domain. Applying it fires the audit triggers, which is the point of the
// data-bearing round trip below.
const FIXTURE = path.join(
  repoRoot,
  "db",
  "fixtures",
  "synthetic-provision-smoke.sql",
);

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

function writeFixture(
  directory,
  { dump = FIXTURE_DUMP, accountsInserts = 1, manifestTables = null } = {},
) {
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
    tables:
      manifestTables ??
      tablesFromDump(dump).map((table) =>
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

test("d1-export refuses the staging target while its database_id is the placeholder", (t) => {
  // The staging config still carries the placeholder (5C has not been run), but
  // the assertion is written against a temp copy so it keeps proving the guard
  // after 5C records a real id. Exit 3 happens before any network call.
  const directory = tempDir(t);
  const config = JSON.parse(
    readFileSync(path.join(webRoot, "wrangler.staging.jsonc"), "utf8"),
  );
  config.d1_databases[0].database_id = "00000000-0000-0000-0000-000000000000";
  const configPath = path.join(directory, "wrangler.staging.jsonc");
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const out = path.join(directory, "out");

  const result = run("export", [
    "--target",
    "staging",
    "--out",
    out,
    "--wrangler-config",
    configPath,
  ]);

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

test("preflight: both Wrangler reads are pinned to --expect-account", (t) => {
  // A stub Wrangler records the environment of each child process. Without the
  // pin, `d1 list` is scoped to whatever Wrangler resolved (config -> env ->
  // stored selection), so the preflight could assert account A and list account
  // B's databases; with it, both reads carry the asserted id.
  const directory = tempDir(t);
  const scriptsCopy = path.join(directory, "scripts");
  cpSync(scriptsDir, scriptsCopy, { recursive: true });
  const stubDirectory = path.join(directory, "node_modules", "wrangler", "bin");
  mkdirSync(stubDirectory, { recursive: true });
  const accountId = "aaaa1111bbbb2222cccc3333dddd4444";
  const logPath = path.join(directory, "child-env.log");
  writeFileSync(
    path.join(stubDirectory, "wrangler.js"),
    [
      'const { appendFileSync } = require("node:fs");',
      "const args = process.argv.slice(2);",
      "appendFileSync(",
      "  process.env.CERTPATH_STUB_LOG,",
      '  JSON.stringify({ args, accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? null }) + "\\n",',
      ");",
      'if (args[0] === "whoami") {',
      `  process.stdout.write(JSON.stringify({ accounts: [{ id: "${accountId}", name: "Fixture Account" }] }));`,
      "} else {",
      '  process.stdout.write("[]");',
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
  );

  const env = {
    ...process.env,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    CERTPATH_STUB_LOG: logPath,
  };
  // The parent deliberately carries no account id: that is the case where
  // Wrangler would fall back to a stored selection of some other account.
  delete env.CLOUDFLARE_ACCOUNT_ID;

  const result = spawnSync(
    process.execPath,
    [
      path.join(scriptsCopy, "d1-account-preflight.mjs"),
      "--expect-account",
      accountId,
      "--database",
      "certpath-learner-staging",
      "--expect-absent",
    ],
    { cwd: directory, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /preflight ok/);
  const calls = readFileSync(logPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.map((call) => call.args.slice(0, 2)),
    [["whoami", "--json"], ["d1", "list"]],
  );
  for (const call of calls) {
    assert.equal(
      call.accountId,
      accountId,
      "Wrangler must be told which account to read; a stored selection is not an answer",
    );
  }
});

test("preview deploy refuses another target's artefact before spawning Wrangler", (t) => {
  // build:pilot and build:site write the same build/server/wrangler.json, so
  // deploy:preview must check the artefact it is about to ship.
  const directory = tempDir(t);
  const buildDirectory = path.join(directory, "build", "server");
  mkdirSync(buildDirectory, { recursive: true });
  const generatedPath = path.join(buildDirectory, "wrangler.json");
  const deploy = () =>
    spawnSync(process.execPath, [SCRIPTS.preview, "deploy"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      maxBuffer: 64 * 1024 * 1024,
    });

  writeFileSync(
    generatedPath,
    JSON.stringify({
      name: "certpath-pilot",
      configPath: "C:\\repo\\apps\\web\\wrangler.pilot.jsonc",
      d1_databases: [
        {
          binding: "DB",
          database_name: "certpath-pilot",
          database_id: "00000000-0000-0000-0000-000000000000",
        },
      ],
    }),
  );
  const pilot = deploy();
  const pilotOutput = `${pilot.stdout ?? ""}\n${pilot.stderr ?? ""}`;
  assert.equal(pilot.status, 1, pilotOutput);
  assert.match(pilotOutput, /preview_binds_d1/);
  assert.doesNotMatch(pilotOutput, /wrangler \d+\.\d+\.\d+/);
  assert.doesNotMatch(pilotOutput, /⛅/);

  writeFileSync(
    generatedPath,
    JSON.stringify({
      name: "certpath-site",
      configPath: "C:\\repo\\apps\\web\\wrangler.site.jsonc",
    }),
  );
  const site = deploy();
  const siteOutput = `${site.stdout ?? ""}\n${site.stderr ?? ""}`;
  assert.equal(site.status, 1, siteOutput);
  assert.match(siteOutput, /preview_wrong_config/);
  assert.doesNotMatch(siteOutput, /wrangler \d+\.\d+\.\d+/);
  assert.doesNotMatch(siteOutput, /⛅/);
});

test("the staging database id copied into pilot, local and preview fails the isolation gate", (t) => {
  // Phase 5C: one database, one config. If the staging uuid is pasted anywhere
  // else, a provisioned id must be caught by duplicate_database_id, and the
  // preview Worker by preview_binds_d1. Simulated on temp copies: the configs in
  // the repository are not edited.
  const configDir = tempDir(t);
  const stagingId = "11111111-2222-4333-8444-555555555555";
  const databases = [
    ["wrangler.jsonc", "certpath-local"],
    ["wrangler.preview.jsonc", "certpath-preview"],
    ["wrangler.staging.jsonc", "certpath-learner-staging"],
    ["wrangler.pilot.jsonc", "certpath-pilot"],
  ];
  for (const [file, databaseName] of databases) {
    const config = parseJsonc(
      readFileSync(path.join(webRoot, file), "utf8"),
      file,
    );
    config.d1_databases = [
      {
        binding: "DB",
        database_name: databaseName,
        database_id: stagingId,
        migrations_dir: "../../db/migrations",
      },
    ];
    writeFileSync(path.join(configDir, file), JSON.stringify(config, null, 2));
  }

  const result = run("isolation", ["--config-dir", configDir]);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /duplicate_database_id/);
  assert.match(result.output, /preview_binds_d1/);
  // The shared id is reported once, naming every config that carries it.
  assert.match(
    result.output,
    /duplicate_database_id: database_id [0-9a-f-]+ is used by local and preview and staging and pilot/,
  );
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

test("rehearsal fails when the manifest names a table the restore does not have, even at zero rows", (t) => {
  // The first export of a freshly migrated database has every table at zero
  // rows, so a table that disappears from the restore must still fail.
  const dump = [
    'CREATE TABLE IF NOT EXISTS "d1_migrations" (',
    "\tid INTEGER PRIMARY KEY AUTOINCREMENT,",
    "\tname TEXT UNIQUE,",
    "\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL",
    ");",
    "INSERT INTO \"d1_migrations\" (\"id\",\"name\") VALUES(1,'0001_foundation.sql');",
    "",
  ].join("\n");
  const { dumpPath } = writeFixture(tempDir(t), {
    dump,
    manifestTables: [
      { name: "accounts", inserts: 0 },
      { name: "d1_migrations", inserts: 1 },
    ],
  });

  const result = run("rehearse", ["--file", dumpPath]);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /missing table: accounts/);
});

test("rehearsal reports an audit row count that disagrees with the manifest by name", (t) => {
  // The named assertion exists because audit_events is what triggers write to; a
  // doubled trigger must be diagnosed as such, not as a generic count diff. This
  // fixture's dump carries two audit rows while the manifest records one, which
  // is the shape a re-fired trigger produces.
  const dump = [
    'CREATE TABLE IF NOT EXISTS "d1_migrations" (',
    "\tid INTEGER PRIMARY KEY AUTOINCREMENT,",
    "\tname TEXT UNIQUE,",
    "\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL",
    ");",
    "INSERT INTO \"d1_migrations\" (\"id\",\"name\") VALUES(1,'0001_foundation.sql');",
    'CREATE TABLE "audit_events" (',
    "\tid INTEGER PRIMARY KEY,",
    "\taction TEXT NOT NULL",
    ");",
    "INSERT INTO \"audit_events\" (\"id\",\"action\") VALUES(1,'certification_created');",
    "INSERT INTO \"audit_events\" (\"id\",\"action\") VALUES(2,'certification_created');",
    "",
  ].join("\n");
  const { dumpPath } = writeFixture(tempDir(t), {
    dump,
    manifestTables: [
      { name: "audit_events", inserts: 1 },
      { name: "d1_migrations", inserts: 1 },
    ],
  });

  const result = run("rehearse", ["--file", dumpPath]);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /audit_events_replayed/);
  assert.match(result.output, /audit_events holds 2 rows/);
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
  // Phase 5B: the funnel table is exported and rehearsed like every other table,
  // with no allowlist to update. A fresh export lists it at zero rows.
  const funnel = manifest.tables.find((table) => table.name === "pilot_events");
  assert.deepEqual(funnel, { name: "pilot_events", inserts: 0 });
  assert.ok(
    manifest.tables.some((table) => table.name === "pilot_event_names"),
    "pilot_event_names must be in the manifest",
  );

  const rehearse = run("rehearse", ["--file", dumpPath]);
  assert.equal(rehearse.status, 0, rehearse.output);
  assert.match(rehearse.output, /integrity_check ok/);
});

test("a data-bearing dump of the smoke fixture rehearses through the three-phase replay", (t) => {
  // Reverting the rehearsal to one `wrangler d1 execute --file` call fails here.
  // Measured on 17 November 2026: the single call stops on foreign-key ordering
  // first — `no such table: main.certifications`, because the dump inserts into
  // `audit_events` before it creates `certifications` — so the trigger re-fire
  // that a single replay would also cause is never reached. The ordering failure
  // is what this test pins.
  const directory = tempDir(t);
  const work = path.join(directory, "work");
  mkdirSync(work);
  const out = path.join(directory, "exports");

  const chain = run("chain", ["--work-dir", work]);
  assert.equal(chain.status, 0, chain.output);

  // Applied the same way an operator applies it, through Wrangler.
  const applied = spawnSync(
    process.execPath,
    [
      wranglerBin,
      "d1",
      "execute",
      "certpath-local",
      "--local",
      "--persist-to",
      path.join(work, ".wrangler", "state"),
      "-c",
      path.join(work, "wrangler.jsonc"),
      "--file",
      FIXTURE,
      "-y",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  assert.equal(applied.status, 0, `${applied.stdout ?? ""}\n${applied.stderr ?? ""}`);

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
  const manifest = JSON.parse(readFileSync(`${dumpPath}.manifest.json`, "utf8"));

  // The dump really carries trigger-written rows; without them it would not be a
  // regression test for the replay at all.
  const audit = manifest.tables.find((table) => table.name === "audit_events");
  assert.ok(audit && audit.inserts >= 3, `expected audit rows, saw ${JSON.stringify(audit)}`);
  for (const name of ["users", "certifications", "exam_versions", "domains"]) {
    const table = manifest.tables.find((entry) => entry.name === name);
    assert.ok(table && table.inserts >= 1, `${name} must carry the fixture row`);
  }

  const rehearse = run("rehearse", ["--file", dumpPath]);
  assert.equal(rehearse.status, 0, rehearse.output);
  assert.match(rehearse.output, /replay: schema \d+, data \d+, triggers \d+/);
  assert.match(rehearse.output, /integrity_check ok/);
});
