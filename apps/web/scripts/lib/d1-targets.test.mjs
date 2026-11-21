// Unit tests for the pure Phase 5A rules. These must fail when a guard in
// scripts/lib/d1-targets.mjs is removed: every assertion names the rule the
// guard exists for.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CliError,
  DEFER_FOREIGN_KEYS,
  ISOLATION_CONFIGS,
  MANIFEST_FIELDS,
  analyzeConfigs,
  assertExpectedAccountEnv,
  assertManifestShape,
  assertPreviewDeployConfig,
  assertPreviewGeneratedConfig,
  buildManifest,
  checkPreflightAccount,
  checkPreflightDatabase,
  diffTableCounts,
  diffTableSets,
  formatPreflightReport,
  idClass,
  isAuthFailure,
  migrationChecksum,
  normalizeDatabaseId,
  normalizeNewlines,
  parseChecksums,
  parseDatabaseList,
  parseJsonc,
  parseWhoamiAccounts,
  planReplay,
  redactSecrets,
  resolveExportTarget,
  sha256Hex,
  splitSqlStatements,
  stripJsonc,
  tablesFromDump,
  verifyChecksums,
  wranglerEnv,
} from "./d1-targets.mjs";

const PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const STAGING_ID = "11111111-2222-4333-8444-555555555555";
const PILOT_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
// The committed configs live one level above scripts/lib.
const webRoot = new URL("../../", import.meta.url);

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

test("every config that binds D1 declares the staff MFA policy with the owner's values", () => {
  // A config that binds D1 serves the admin API, and the staff security
  // configuration fails closed to null when the MFA policy is absent: every
  // /api/admin/auth/* route then answers 503. The owner decided TOTP only and
  // an 8-hour maximum age, so the exact values are asserted - 15 minutes is
  // the staleness #169 records in .dev.vars.example.
  let checked = 0;
  for (const config of ISOLATION_CONFIGS) {
    const parsed = parseJsonc(
      readFileSync(new URL(config.file, webRoot), "utf8"),
      config.file,
    );
    if (!Array.isArray(parsed.d1_databases) || parsed.d1_databases.length === 0) {
      continue;
    }
    checked += 1;
    const vars = parsed.vars ?? {};
    assert.equal(
      vars.STAFF_MFA_ALLOWED_METHODS,
      "totp",
      `${config.file} binds D1, so it must declare STAFF_MFA_ALLOWED_METHODS="totp"; without it every staff auth route answers 503`,
    );
    assert.equal(
      vars.STAFF_MFA_MAX_AGE_MS,
      "28800000",
      `${config.file} binds D1, so it must declare STAFF_MFA_MAX_AGE_MS="28800000"; the owner's maximum age is 8 hours`,
    );
  }
  assert.ok(
    checked >= 3,
    `expected at least 3 of the ${ISOLATION_CONFIGS.length} isolation configs to bind D1; checked ${checked}, so this test would otherwise pass vacuously`,
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

test("diffTableSets names a missing or unexpected table even when every count is zero", () => {
  const manifestTables = [
    { name: "accounts", inserts: 0 },
    { name: "d1_migrations", inserts: 20 },
  ];

  // A table listed at zero rows that the restore does not have is a diff; the
  // counts alone would have looked identical.
  assert.deepEqual(
    diffTableSets(manifestTables, [{ name: "d1_migrations", inserts: 20 }]),
    ["missing table: accounts"],
  );
  assert.deepEqual(
    diffTableSets(manifestTables, [
      { name: "accounts", inserts: 0 },
      { name: "d1_migrations", inserts: 20 },
      { name: "users", inserts: 0 },
    ]),
    ["unexpected table: users"],
  );
  assert.deepEqual(
    diffTableSets(manifestTables, [
      { name: "accounts", inserts: 0 },
      { name: "d1_migrations", inserts: 20 },
    ]),
    [],
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

// ---------------------------------------------------------------------------
// Phase 5C account preflight. Each case names the mistake it catches; removing
// the guard in scripts/lib/d1-targets.mjs makes exactly one of them fail.
// ---------------------------------------------------------------------------

const ACCOUNT_A = "aa11bb22cc33dd44ee55ff66aa77bb88";
const ACCOUNT_B = "bb22cc33dd44ee55ff66aa77bb88cc99";
const DATABASE = "certpath-learner-staging";
const DATABASE_UUID = "1234abcd-5678-4def-9012-3456789abcde";
const OTHER_UUID = "fedcba98-7654-4321-0fed-cba987654321";

function whoamiPayload(extra = {}) {
  return {
    accounts: [
      { id: ACCOUNT_A, name: "CertPath Staging" },
      { id: ACCOUNT_B, name: "Other Account" },
    ],
    ...extra,
  };
}

function expectCode(code, exitCode) {
  return (error) => {
    assert.ok(error instanceof CliError, `expected a CliError, got ${error}`);
    assert.equal(error.code, code);
    assert.equal(error.exitCode, exitCode);
    return true;
  };
}

test("preflight: a CLOUDFLARE_ACCOUNT_ID that disagrees with --expect-account is account_env_mismatch", () => {
  // Catches a stale exported account id silently retargeting every Wrangler
  // call, because Wrangler prefers the environment variable over its selection.
  assert.throws(
    () =>
      assertExpectedAccountEnv({
        expectAccount: ACCOUNT_A,
        envAccountId: ` ${ACCOUNT_B.toUpperCase()} `,
      }),
    expectCode("account_env_mismatch", 1),
  );
  // An agreeing environment id (any case) and an unset one are both fine.
  assert.equal(
    assertExpectedAccountEnv({ expectAccount: ACCOUNT_A, envAccountId: ACCOUNT_A.toUpperCase() }),
    ACCOUNT_A,
  );
  assert.equal(
    assertExpectedAccountEnv({ expectAccount: ACCOUNT_A, envAccountId: null }),
    ACCOUNT_A,
  );
});

test("preflight: an expected account that the credential cannot see is account_mismatch", () => {
  assert.deepEqual(
    checkPreflightAccount({ whoami: whoamiPayload(), expectAccount: ACCOUNT_A }),
    { id: ACCOUNT_A, name: "CertPath Staging" },
  );
  assert.throws(
    () =>
      checkPreflightAccount({
        whoami: whoamiPayload(),
        expectAccount: "00112233445566778899aabbccddeeff",
      }),
    expectCode("account_mismatch", 1),
  );
});

test("preflight: an unreadable whoami or d1 list payload is preflight_unparsed, never a pass", () => {
  // Catches a Wrangler shape change turning "I cannot see the database" into
  // "the database is absent", which would green-light a duplicate create.
  for (const payload of [{}, null, { result: [] }, { accounts: "nope" }, { accounts: [{}] }]) {
    assert.throws(
      () => parseWhoamiAccounts(payload),
      expectCode("preflight_unparsed", 1),
    );
  }
  for (const payload of [42, "[]", {}, { result: "nope" }, { result: [{ name: DATABASE }] }, [null]]) {
    assert.throws(
      () => parseDatabaseList(payload),
      expectCode("preflight_unparsed", 1),
    );
  }
});

test("preflight: absent and present are asserted against both d1 list JSON shapes", () => {
  const present = [{ uuid: DATABASE_UUID, name: DATABASE }, { uuid: OTHER_UUID, name: "certpath-pilot" }];
  const absent = [{ uuid: OTHER_UUID, name: "certpath-pilot" }];

  for (const payload of [present, { result: present }]) {
    const databases = parseDatabaseList(payload);
    assert.deepEqual(
      checkPreflightDatabase({ databases, database: DATABASE, expectPresent: true }),
      { name: DATABASE, present: true, uuid: DATABASE_UUID },
    );
    // --expect-absent over an existing database would be a second create.
    assert.throws(
      () => checkPreflightDatabase({ databases, database: DATABASE, expectPresent: false }),
      expectCode("database_already_exists", 1),
    );
  }

  for (const payload of [absent, { result: absent }]) {
    const databases = parseDatabaseList(payload);
    assert.deepEqual(
      checkPreflightDatabase({ databases, database: DATABASE, expectPresent: false }),
      { name: DATABASE, present: false, uuid: null },
    );
    // --expect-present over a missing database must not proceed to migrate it.
    assert.throws(
      () => checkPreflightDatabase({ databases, database: DATABASE, expectPresent: true }),
      expectCode("database_missing", 1),
    );
  }
});

test("preflight: a differently-cased match counts as present, so --expect-absent still refuses", () => {
  const databases = parseDatabaseList([{ uuid: DATABASE_UUID, name: DATABASE }]);
  assert.throws(
    () =>
      checkPreflightDatabase({
        databases,
        database: DATABASE.toUpperCase(),
        expectPresent: false,
      }),
    expectCode("database_already_exists", 1),
  );
});

test("preflight: the report carries the account name and id and never a token-shaped value", () => {
  const token = "v1.0-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  const account = checkPreflightAccount({
    whoami: whoamiPayload({ api_token: token, email: "operator@example.test", token_permissions: [token] }),
    expectAccount: ACCOUNT_A,
  });
  const report = formatPreflightReport({
    account,
    database: { name: DATABASE, present: false, uuid: null },
  });

  assert.equal(
    report,
    `account: CertPath Staging (${ACCOUNT_A})\ndatabase ${DATABASE}: absent`,
  );
  assert.doesNotMatch(report, /v1\.0-/);
  assert.equal(report.includes(token), false);
  assert.doesNotMatch(report, /@example\.test/);
});

test("preflight: wranglerEnv pins every read to --expect-account", () => {
  // Catches the preflight reading account B's databases while asserting account
  // A: Wrangler prefers CLOUDFLARE_ACCOUNT_ID, then a stored selection, so the
  // child environment must carry the asserted id and nothing else may win.
  const pinned = wranglerEnv({
    parentEnv: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_B, PATH: "/bin", HOME: "/home/x" },
    expectAccount: ACCOUNT_A,
  });
  assert.equal(pinned.CLOUDFLARE_ACCOUNT_ID, ACCOUNT_A);
  assert.equal(pinned.PATH, "/bin");
  assert.equal(pinned.HOME, "/home/x");

  // No parent value at all: still pinned, so a stale stored selection cannot be
  // used as the fallback.
  assert.equal(
    wranglerEnv({ parentEnv: { PATH: "/bin" }, expectAccount: ACCOUNT_A })
      .CLOUDFLARE_ACCOUNT_ID,
    ACCOUNT_A,
  );
  // Upper case and whitespace are normalised to the id Wrangler resolves.
  assert.equal(
    wranglerEnv({ parentEnv: {}, expectAccount: ` ${ACCOUNT_A.toUpperCase()} ` })
      .CLOUDFLARE_ACCOUNT_ID,
    ACCOUNT_A,
  );
  assert.throws(
    () => wranglerEnv({ parentEnv: {}, expectAccount: "" }),
    expectCode("missing_option_value", 2),
  );
});

test("preflight: a credential whose visible account is not the expected one exits with account_mismatch, not a pass", () => {
  // With the reads pinned to --expect-account, a stored selection of another
  // account cannot make this pass: the visible account list is what decides.
  assert.throws(
    () =>
      checkPreflightAccount({
        whoami: { accounts: [{ id: ACCOUNT_B, name: "Other Account" }] },
        expectAccount: ACCOUNT_A,
      }),
    expectCode("account_mismatch", 1),
  );
});

test("preview deploy guard: a pilot artefact fails as preview_binds_d1, a site artefact as preview_wrong_config", () => {
  // build:site, build:pilot, build:staging and build:preview all write the same
  // build/server/wrangler.json, so deploy:preview must refuse any of the other
  // targets' artefacts.
  assert.throws(
    () =>
      assertPreviewDeployConfig({
        name: "certpath-pilot",
        configPath: "C:\\repo\\apps\\web\\wrangler.pilot.jsonc",
        d1_databases: [
          { binding: "DB", database_name: "certpath-pilot", database_id: PLACEHOLDER },
        ],
      }),
    expectCode("preview_binds_d1", 1),
  );

  assert.throws(
    () =>
      assertPreviewDeployConfig({
        name: "certpath-site",
        configPath: "C:\\repo\\apps\\web\\wrangler.site.jsonc",
      }),
    expectCode("preview_wrong_config", 1),
  );

  // The right config path but the wrong Worker name is the same refusal.
  assert.throws(
    () =>
      assertPreviewDeployConfig({
        name: "certpath-staging",
        configPath: "C:\\repo\\apps\\web\\wrangler.preview.jsonc",
      }),
    expectCode("preview_wrong_config", 1),
  );

  assert.deepEqual(
    assertPreviewDeployConfig({
      name: "certpath-ui-preview",
      configPath: "C:/repo/apps/web/wrangler.preview.jsonc",
    }),
    {
      name: "certpath-ui-preview",
      configPath: "C:/repo/apps/web/wrangler.preview.jsonc",
    },
  );
});

test("preview build guard: a generated config that binds D1 fails as preview_binds_d1", () => {
  // Catches a build artefact that would deploy a D1 binding to the preview
  // Worker even though wrangler.preview.jsonc is clean.
  assert.throws(
    () =>
      assertPreviewGeneratedConfig({
        name: "certpath-ui-preview",
        d1_databases: [
          { binding: "DB", database_name: "certpath-preview", database_id: PLACEHOLDER },
        ],
      }),
    (error) => {
      expectCode("preview_binds_d1", 1)(error);
      assert.match(error.message, /certpath-preview/);
      return true;
    },
  );
});

test("preview build guard: a missing or empty d1_databases key passes, a non-object fails closed", () => {
  assert.equal(
    assertPreviewGeneratedConfig({ name: "certpath-ui-preview" }).name,
    "certpath-ui-preview",
  );
  assert.deepEqual(assertPreviewGeneratedConfig({ name: "certpath-ui-preview", d1_databases: [] }), {
    name: "certpath-ui-preview",
    d1_databases: [],
  });
  for (const payload of [null, [], "wrangler.json"]) {
    assert.throws(
      () => assertPreviewGeneratedConfig(payload),
      expectCode("preflight_unparsed", 1),
    );
  }
});

// ---------------------------------------------------------------------------
// Replay planning. These fail when the three-phase grouping is weakened: a
// trigger body split into pieces, a semicolon inside a literal treated as a
// statement boundary, or a data statement loaded before the schema.
// ---------------------------------------------------------------------------

const REPLAY_DUMP = [
  "PRAGMA defer_foreign_keys=TRUE;",
  'CREATE TABLE "a" (id INTEGER, note TEXT);',
  'INSERT INTO "a" ("id","note") VALUES(1,\'semi; colon and \'\'quote\'\'\');',
  "CREATE TRIGGER t_audit AFTER INSERT ON \"a\"",
  "BEGIN",
  '  INSERT INTO "b" (id) VALUES (NEW.id);',
  "  UPDATE \"a\" SET id = CASE WHEN NEW.id > 0 THEN NEW.id ELSE 0 END WHERE id = NEW.id;",
  "  SELECT RAISE(ABORT, 'no; way');",
  "END;",
  'CREATE INDEX a_idx ON "a" (id);',
  "INSERT INTO \"a\" (\"id\",\"note\") VALUES(2,'second');",
].join("\n");

test("splitSqlStatements keeps a trigger body whole and does not split inside literals or comments", () => {
  const statements = splitSqlStatements(REPLAY_DUMP);

  assert.deepEqual(
    statements.map((statement) => statement.kind),
    ["schema", "schema", "data", "triggers", "schema", "data"],
  );
  // A split trigger would end at the first semicolon inside BEGIN ... END.
  const trigger = statements[3].sql;
  assert.ok(trigger.startsWith("CREATE TRIGGER t_audit"));
  assert.ok(trigger.trimEnd().endsWith("END;"), trigger);
  assert.ok(trigger.includes("INSERT INTO \"b\""));
  assert.ok(trigger.includes("RAISE(ABORT, 'no; way')"));
  // A CASE ... END inside the body must not close it early either.
  assert.ok(trigger.includes("CASE WHEN NEW.id > 0 THEN NEW.id ELSE 0 END"));
  // Semicolons in string literals are content, not boundaries.
  assert.ok(statements[2].sql.includes("'semi; colon and ''quote'''"));
});

test("planReplay orders schema, data then triggers and defers foreign keys in the data phase", () => {
  const phases = planReplay(splitSqlStatements(REPLAY_DUMP));

  assert.deepEqual(
    phases.map((phase) => phase.phase),
    ["schema", "data", "triggers"],
  );
  assert.deepEqual(
    phases.map((phase) => phase.statements),
    [3, 2, 1],
  );
  // Every table exists before the first row is written.
  assert.equal(phases[0].sql.includes("INSERT INTO"), false);
  assert.ok(phases[0].sql.includes('CREATE TABLE "a"'));
  assert.ok(phases[0].sql.includes('CREATE INDEX a_idx'));
  // The dump's deferral belongs with the data, and triggers come last.
  assert.ok(phases[1].sql.startsWith(DEFER_FOREIGN_KEYS), phases[1].sql);
  assert.ok(phases[1].sql.includes('INSERT INTO "a"'));
  assert.ok(phases[2].sql.startsWith("CREATE TRIGGER"));
  assert.equal(phases[2].sql.includes('INSERT INTO "a"'), false);
});

test("planReplay refuses a statement it cannot place instead of silently dropping it", () => {
  assert.throws(
    () => planReplay([{ sql: "DELETE FROM a;", kind: "unplanned" }]),
    expectCode("replay_unplanned", 1),
  );
  assert.throws(
    () => planReplay([{ sql: "BEGIN TRANSACTION;", kind: "unplanned" }]),
    expectCode("replay_unplanned", 1),
  );
});

test("splitSqlStatements places Wrangler's sqlite_sequence reset with the data, not with the schema", () => {
  // Wrangler's export emits `DELETE FROM sqlite_sequence;` between the rows and
  // the triggers. Dropping it would leave AUTOINCREMENT counters at 0; running it
  // before the schema would fail outright.
  const dump = [
    'CREATE TABLE "t" (id INTEGER PRIMARY KEY AUTOINCREMENT);',
    'INSERT INTO "t" ("id") VALUES(1);',
    "DELETE FROM sqlite_sequence;",
    "CREATE TRIGGER t_audit AFTER INSERT ON \"t\" BEGIN SELECT 1; END;",
  ].join("\n");
  const statements = splitSqlStatements(dump);

  assert.deepEqual(
    statements.map((statement) => statement.kind),
    ["schema", "data", "data", "triggers"],
  );
  const phases = planReplay(statements);
  assert.equal(phases[1].statements, 2);
  assert.ok(phases[1].sql.includes("DELETE FROM sqlite_sequence;"));
});
