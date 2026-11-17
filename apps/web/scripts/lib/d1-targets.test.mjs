// Unit tests for the pure Phase 5A rules. These must fail when a guard in
// scripts/lib/d1-targets.mjs is removed: every assertion names the rule the
// guard exists for.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CliError,
  MANIFEST_FIELDS,
  analyzeConfigs,
  assertManifestShape,
  buildManifest,
  diffTableCounts,
  idClass,
  isAuthFailure,
  migrationChecksum,
  normalizeDatabaseId,
  normalizeNewlines,
  parseChecksums,
  parseJsonc,
  redactSecrets,
  resolveExportTarget,
  sha256Hex,
  stripJsonc,
  tablesFromDump,
  verifyChecksums,
} from "./d1-targets.mjs";

const PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const STAGING_ID = "11111111-2222-4333-8444-555555555555";
const PILOT_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";

function configText({ name, databaseName, databaseId }) {
  return JSON.stringify({
    name,
    d1_databases: [
      { binding: "DB", database_name: databaseName, database_id: databaseId },
    ],
  });
}

function configs(overrides = {}) {
  return [
    {
      key: "local",
      file: "wrangler.jsonc",
      remote: false,
      text: configText({
        name: "certpath-foundation",
        databaseName: "certpath-local",
        databaseId: PLACEHOLDER,
      }),
    },
    {
      key: "preview",
      file: "wrangler.preview.jsonc",
      remote: true,
      text: JSON.stringify({ name: "certpath-ui-preview" }),
    },
    {
      key: "staging",
      file: "wrangler.staging.jsonc",
      remote: true,
      text: configText({
        name: "learner-auth-staging",
        databaseName: "certpath-learner-staging",
        databaseId: STAGING_ID,
      }),
    },
    {
      key: "pilot",
      file: "wrangler.pilot.jsonc",
      remote: true,
      text: configText({
        name: "certpath-pilot",
        databaseName: "certpath-pilot",
        databaseId: PILOT_ID,
      }),
    },
    ...(overrides.extra ?? []),
  ];
}

function sampleManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    target: "local",
    binding: "DB",
    databaseName: "certpath-local",
    databaseIdClass: "placeholder",
    wranglerConfig: "apps/web/wrangler.jsonc",
    capturedAt: "2026-11-17T00:00:00Z",
    gitCommit: "0123456789abcdef0123456789abcdef01234567",
    wranglerVersion: "4.160.0",
    file: "certpath-local-20261117T000000Z.sql",
    byteLength: 128,
    sha256: "a".repeat(64),
    tables: [
      { name: "accounts", inserts: 2 },
      { name: "d1_migrations", inserts: 20 },
    ],
    migrations: ["0001_foundation.sql"],
    ...overrides,
  };
}

test("idClass treats the placeholder, its brace form, upper case and a missing id as not provisioned", () => {
  assert.equal(idClass(PLACEHOLDER), "placeholder");
  assert.equal(idClass(`{${PLACEHOLDER}}`), "placeholder");
  assert.equal(idClass(` { ${PLACEHOLDER.toUpperCase()} } `), "placeholder");
  assert.equal(idClass(""), "placeholder");
  assert.equal(idClass(undefined), "placeholder");

  assert.equal(idClass(STAGING_ID), "real");
  assert.equal(idClass(STAGING_ID.toUpperCase()), "real");
  assert.equal(idClass(`{${STAGING_ID.toUpperCase()}}`), "real");
});

test("normalizeDatabaseId strips braces, quotes and whitespace", () => {
  assert.equal(normalizeDatabaseId(" { 11111111-2222-4333-8444-555555555555 } "), STAGING_ID);
  assert.equal(normalizeDatabaseId(`"${PLACEHOLDER}"`), PLACEHOLDER);
});

test("jsonc configs with comments and trailing commas still parse", () => {
  const text = `/**
 * config comment with a "quoted" word and a // slash pair
 */
{
  // line comment
  "name": "certpath-foundation",
  "vars": { "A": "http://example.test/x", },
  "d1_databases": [
    { "binding": "DB", "database_name": "certpath-local", "database_id": "${PLACEHOLDER}", },
  ],
}`;
  const parsed = parseJsonc(text, "sample");
  assert.equal(parsed.name, "certpath-foundation");
  assert.equal(parsed.vars.A, "http://example.test/x");
  assert.equal(parsed.d1_databases.length, 1);
  assert.equal(stripJsonc(text).includes("// line comment"), false);
});

test("a clean set of configs produces one row per binding and no violations", () => {
  const { rows, violations } = analyzeConfigs(configs());
  assert.deepEqual(violations, []);
  assert.deepEqual(
    rows.map((row) => [row.config, row.databaseName, row.idClass]),
    [
      ["local", "certpath-local", "placeholder"],
      ["preview", null, "none"],
      ["staging", "certpath-learner-staging", "real"],
      ["pilot", "certpath-pilot", "real"],
    ],
  );
});

test("preview_binds_d1 fires for any d1_databases entry in wrangler.preview.jsonc", () => {
  const preview = configs()[1];
  const { violations } = analyzeConfigs([
    ...configs().slice(0, 1),
    {
      ...preview,
      text: configText({
        name: "certpath-ui-preview",
        databaseName: "certpath-preview",
        databaseId: PLACEHOLDER,
      }),
    },
    ...configs().slice(2),
  ]);
  assert.deepEqual(
    violations.map((violation) => violation.code),
    ["preview_binds_d1"],
  );
});

test("duplicate_database_name ignores the local config but fails two remote targets sharing a name", () => {
  const [local, preview, , pilot] = configs();
  const shared = configText({
    name: "learner-auth-staging",
    databaseName: "certpath-pilot",
    databaseId: STAGING_ID,
  });

  assert.deepEqual(
    analyzeConfigs([
      { ...local, text: configText({ name: "certpath-foundation", databaseName: "certpath-local", databaseId: PLACEHOLDER }) },
      preview,
      { ...local, key: "staging", file: "wrangler.staging.jsonc", remote: true, text: shared },
      pilot,
    ]).violations.map((violation) => violation.code),
    ["duplicate_database_name"],
  );
});

test("duplicate_database_name does not fire when local shares a database_name with a remote target", () => {
  const [local, preview, staging, pilot] = configs();
  const { violations } = analyzeConfigs([
    { ...local, text: configText({ name: "certpath-foundation", databaseName: "certpath-pilot", databaseId: PLACEHOLDER }) },
    preview,
    staging,
    pilot,
  ]);
  assert.deepEqual(violations, []);
});

test("duplicate_database_id fires for two real ids and ignores shared placeholders", () => {
  const [local, preview, staging, pilot] = configs();
  const { violations } = analyzeConfigs([
    local,
    preview,
    { ...staging, text: configText({ name: "learner-auth-staging", databaseName: "certpath-learner-staging", databaseId: STAGING_ID }) },
    { ...pilot, text: configText({ name: "certpath-pilot", databaseName: "certpath-pilot", databaseId: `{${STAGING_ID.toUpperCase()}}` }) },
  ]);
  assert.deepEqual(
    violations.map((violation) => violation.code),
    ["duplicate_database_id"],
  );

  const placeholders = analyzeConfigs([
    local,
    preview,
    { ...staging, text: configText({ name: "learner-auth-staging", databaseName: "certpath-learner-staging", databaseId: PLACEHOLDER }) },
    { ...pilot, text: configText({ name: "certpath-pilot", databaseName: "certpath-pilot", databaseId: PLACEHOLDER }) },
  ]);
  assert.deepEqual(placeholders.violations, []);
});

test("an unknown export target is a usage error, not a silent local export", () => {
  assert.throws(
    () => resolveExportTarget("nope"),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "unknown_target");
      assert.equal(error.exitCode, 2);
      return true;
    },
  );
  assert.equal(resolveExportTarget("local").mode, "local");
  assert.equal(resolveExportTarget("pilot").mode, "remote");
});

test("buildManifest emits exactly the documented non-nullable fields", () => {
  const manifest = buildManifest(sampleManifest());
  assert.deepEqual(Object.keys(manifest).sort(), [...MANIFEST_FIELDS].sort());
  for (const field of MANIFEST_FIELDS) {
    assert.notEqual(manifest[field], null, field);
    assert.notEqual(manifest[field], undefined, field);
  }
  assert.deepEqual(
    assertManifestShape(sampleManifest()),
    sampleManifest(),
  );
});

test("assertManifestShape rejects a missing field, a wrong type and an unsorted table list", () => {
  const missing = sampleManifest();
  delete missing.sha256;
  assert.throws(() => assertManifestShape(missing), /sha256/);

  assert.throws(
    () => assertManifestShape(sampleManifest({ databaseIdClass: "unknown" })),
    /databaseIdClass/,
  );
  assert.throws(
    () => assertManifestShape(sampleManifest({ gitCommit: "abc" })),
    /gitCommit/,
  );
  assert.throws(
    () =>
      assertManifestShape(
        sampleManifest({
          tables: [
            { name: "zeta", inserts: 1 },
            { name: "alpha", inserts: 1 },
          ],
        }),
      ),
    /ordered by name/,
  );
  assert.throws(
    () => assertManifestShape(sampleManifest({ tables: [{ name: "a", inserts: -1 }] })),
    /non-negative integer/,
  );
});

test("tablesFromDump covers every table, counts INSERT INTO \"<name>\", and orders by name", () => {
  const dump = [
    'CREATE TABLE "zeta" (id INTEGER);',
    "CREATE TABLE alpha (id INTEGER);",
    'CREATE TABLE IF NOT EXISTS "beta" (id INTEGER);',
    'INSERT INTO "zeta" ("id") VALUES (1);',
    'INSERT INTO "alpha" ("id") VALUES (1);',
    'INSERT INTO "beta" ("id") VALUES (1);',
    'INSERT INTO "beta" ("id") VALUES (2);',
    "-- INSERT INTO \"beta\" inside a comment is still counted by the documented rule",
    'INSERT INTO "beta" ("id") VALUES (3);',
  ].join("\n");
  assert.deepEqual(tablesFromDump(dump), [
    { name: "alpha", inserts: 1 },
    { name: "beta", inserts: 4 },
    { name: "zeta", inserts: 1 },
  ]);
});

test("sha256Hex is the lowercase hex digest of the exact bytes", () => {
  assert.equal(
    sha256Hex(Buffer.from("abc", "utf8")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    sha256Hex(Buffer.from("abc\n", "utf8")),
    "edeaaff3f1774ad2888673770c6d64097e391bc362d7d6fb34982ddf0efd18cb",
  );
});

test("diffTableCounts prints one exact line per differing table", () => {
  assert.deepEqual(
    diffTableCounts(
      [
        { name: "accounts", inserts: 1 },
        { name: "d1_migrations", inserts: 20 },
        { name: "users", inserts: 3 },
      ],
      [
        { name: "accounts", inserts: 2 },
        { name: "d1_migrations", inserts: 20 },
        { name: "users", inserts: 2 },
        { name: "zz_extra", inserts: 1 },
      ],
    ),
    [
      "accounts: manifest 1, restored 2 (+1)",
      "users: manifest 3, restored 2 (-1)",
      "zz_extra: manifest 0, restored 1 (+1)",
    ],
  );
});

test("migrationChecksum ignores line-ending differences but not a changed byte", () => {
  const lf = Buffer.from("CREATE TABLE a (\n  id INTEGER\n);\n", "utf8");
  const crlf = Buffer.from("CREATE TABLE a (\r\n  id INTEGER\r\n);\r\n", "utf8");
  const changed = Buffer.from("CREATE TABLE a (\n  id  INTEGER\n);\n", "utf8");

  assert.equal(migrationChecksum(lf), migrationChecksum(crlf));
  assert.notEqual(migrationChecksum(lf), migrationChecksum(changed));
  assert.deepEqual(normalizeNewlines(crlf), lf);
});

test("verifyChecksums names the file whose bytes changed", () => {
  const files = ["0001_foundation.sql", "0002_local_security.sql"];
  const checksums = parseChecksums(
    `${"a".repeat(64)}  0001_foundation.sql\n${"b".repeat(64)}  0002_local_security.sql\n`,
  );
  const unchanged = verifyChecksums({
    files,
    checksums,
    hashes: new Map([
      ["0001_foundation.sql", "a".repeat(64)],
      ["0002_local_security.sql", "b".repeat(64)],
    ]),
  });
  assert.deepEqual(unchanged, []);

  const changed = verifyChecksums({
    files,
    checksums,
    hashes: new Map([
      ["0001_foundation.sql", "a".repeat(64)],
      ["0002_local_security.sql", "c".repeat(64)],
    ]),
  });
  assert.equal(changed.length, 1);
  assert.equal(changed[0].code, "migration_checksum_changed");
  assert.equal(changed[0].file, "0002_local_security.sql");

  const missingFile = verifyChecksums({
    files: [...files, "0003_versioned_content.sql"],
    checksums,
    hashes: new Map(),
  });
  assert.ok(
    missingFile.some(
      (violation) =>
        violation.code === "migration_checksum_missing" &&
        violation.file === "0003_versioned_content.sql",
    ),
  );
});

test("isAuthFailure only fires on auth wording and redactSecrets removes values", () => {
  assert.equal(isAuthFailure("You must be logged in to use wrangler"), true);
  assert.equal(isAuthFailure("Authentication error [code: 10000]"), true);
  assert.equal(isAuthFailure("Caused by: the account is not authorized"), false);
  assert.equal(
    redactSecrets("token abcdef123456 was used", ["abcdef123456"]),
    "token [redacted] was used",
  );
});

test("analyzeConfigs reports a config it cannot parse instead of assuming it is safe", () => {
  const { violations } = analyzeConfigs([
    { key: "local", file: "wrangler.jsonc", remote: false, text: "{ not json" },
  ]);
  assert.deepEqual(
    violations.map((violation) => violation.code),
    ["config_parse_failed"],
  );
});
