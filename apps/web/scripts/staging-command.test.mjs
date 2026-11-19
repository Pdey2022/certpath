// End-to-end tests for the Phase 5D staging deploy guard (issue #149). Each
// case spawns the real `staging-command.mjs` in a temp directory, so it fails
// when the guard in scripts/lib/staging-deploy.mjs is removed rather than only
// when a helper changes. Nothing here reaches the network: every case drives
// `dry-run`, which builds locally and exits, so a case that wrongly passes the
// guard still cannot upload. `deploy` itself is never spawned by this suite.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CliError, deployEnv } from "./lib/d1-targets.mjs";
import {
  describeMigrationGate,
  exitCodeForAction,
  parseMigrationsList,
  planMigrationGate,
} from "./lib/migration-gate.mjs";
import {
  STAGING_PILOT_FLAGS,
  assertStagingDeployConfig,
  readStagingGeneratedConfig,
  wranglerArgs,
} from "./lib/staging-deploy.mjs";

const CLI = fileURLToPath(new URL("./staging-command.mjs", import.meta.url));
const STAGING_ID = "c52e398f-4280-40a6-8244-854186dc6ef2";
const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";

// Shaped like the artefact `npm run build:staging` writes, trimmed to the keys
// the guard reads.
function stagingConfig() {
  return {
    configPath: "C:\\repo\\apps\\web\\wrangler.staging.jsonc",
    name: "learner-auth-staging",
    main: "index.js",
    compatibility_date: "2026-11-10",
    triggers: { crons: ["*/5 * * * *"] },
    vars: {
      PILOT_EVENTS_ENABLED: "false",
      PILOT_SERVER_EVENTS_ENABLED: "false",
      PILOT_EVENTS_RETENTION_ENABLED: "false",
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: "certpath-learner-staging",
        database_id: STAGING_ID,
      },
    ],
  };
}

function withVars(vars) {
  const config = stagingConfig();
  config.vars = { ...config.vars, ...vars };
  return config;
}

function withoutVar(name) {
  const config = stagingConfig();
  delete config.vars[name];
  return config;
}

function withDatabase(entry) {
  const config = stagingConfig();
  config.d1_databases = [entry];
  return config;
}

function withCrons(crons) {
  const config = stagingConfig();
  config.triggers = { crons };
  return config;
}

function workspace(t, config) {
  const directory = mkdtempSync(path.join(tmpdir(), "certpath-staging-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const buildDirectory = path.join(directory, "build", "server");
  mkdirSync(buildDirectory, { recursive: true });
  const generated = path.join(buildDirectory, "wrangler.json");
  if (config !== undefined) {
    writeFileSync(
      generated,
      typeof config === "string" ? config : JSON.stringify(config),
    );
  }
  // A `dry-run` bundles `main`; the refusals must stop before that.
  writeFileSync(
    path.join(buildDirectory, "index.js"),
    'export default { fetch() { return new Response("ok"); } };\n',
  );
  return { directory, generated };
}

function runCli(directory, args, envOverrides = {}) {
  // The parent environment is made hermetic on purpose: CLOUDFLARE_ACCOUNT_ID is
  // deleted, because a value inherited from the developer's shell would make
  // every deploy case refuse with account_env_mismatch, and a test that passes
  // only on a clean machine is not a test. The account cases set it explicitly.
  const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" };
  delete env.CLOUDFLARE_ACCOUNT_ID;
  Object.assign(env, envOverrides);
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: directory,
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

test("the staging deploy guard refuses every artefact that is not the staging build, before Wrangler is spawned", (t) => {
  // Reverting any one rule in assertStagingDeployConfig fails its row: the run
  // then prints Wrangler's version banner, exits with Wrangler's status instead
  // of `error <code>:`, and the row fails on `0 !== 1`.
  //
  // Every row drives `dry-run`, never `deploy`: both actions run the same guard,
  // and a `dry-run` that wrongly passes can only build locally. A test that
  // drove `deploy` would upload on the day a guard regressed.
  const cases = [
    {
      code: "staging_config_missing",
      config: undefined,
    },
    {
      code: "staging_config_unparsed",
      config: '{"configPath": "C:\\\\repo\\\\apps\\\\web\\\\wrangler.staging.jsonc",',
    },
    {
      code: "staging_config_unparsed",
      config: "[]",
    },
    {
      code: "staging_wrong_config",
      config: {
        ...stagingConfig(),
        configPath: "C:\\repo\\apps\\web\\wrangler.pilot.jsonc",
      },
    },
    {
      code: "staging_wrong_config",
      config: { ...stagingConfig(), configPath: undefined },
    },
    {
      code: "staging_wrong_worker",
      config: { ...stagingConfig(), name: "certpath-pilot" },
    },
    {
      code: "staging_database_mismatch",
      config: withDatabase({
        binding: "DB",
        database_name: "certpath-pilot",
        database_id: STAGING_ID,
      }),
    },
    {
      // The Worker reads env.DB; a right database under another binding name is
      // still a mismatch.
      code: "staging_database_mismatch",
      config: withDatabase({
        binding: "STAGING_DB",
        database_name: "certpath-learner-staging",
        database_id: STAGING_ID,
      }),
    },
    {
      code: "staging_database_mismatch",
      config: {
        ...stagingConfig(),
        d1_databases: [
          ...stagingConfig().d1_databases,
          {
            binding: "DB2",
            database_name: "certpath-learner-staging",
            database_id: STAGING_ID,
          },
        ],
      },
    },
    {
      code: "staging_database_placeholder",
      // wrangler.pilot.jsonc still carries this id; a deploy of the pilot
      // artefact is exactly the accident this rule is for.
      config: withDatabase({
        binding: "DB",
        database_name: "certpath-learner-staging",
        database_id: PLACEHOLDER_ID,
      }),
    },
    {
      code: "staging_database_placeholder",
      config: withDatabase({
        binding: "DB",
        database_name: "certpath-learner-staging",
      }),
    },
    {
      code: "staging_pilot_flag_enabled",
      config: withVars({ PILOT_EVENTS_ENABLED: "true" }),
    },
    {
      code: "staging_schedule_mismatch",
      // wrangler.pilot.jsonc / the local config carry no cron; a staging
      // deploy that ships no schedule is not the artefact this runbook checks
      // afterwards ("cron listed").
      config: withCrons([]),
    },
    {
      code: "staging_schedule_mismatch",
      config: withCrons(["*/5 * * * *", "0 * * * *"]),
    },
    {
      code: "staging_schedule_mismatch",
      config: (() => {
        const config = stagingConfig();
        delete config.triggers;
        return config;
      })(),
    },
    {
      code: "staging_pilot_flag_enabled",
      config: withVars({ PILOT_EVENTS_RETENTION_ENABLED: "true" }),
    },
    {
      code: "staging_pilot_flag_missing",
      config: withoutVar("PILOT_SERVER_EVENTS_ENABLED"),
    },
  ];

  for (const { code, config } of cases) {
    const { directory } = workspace(t, config);
    const result = runCli(directory, ["dry-run"]);
    const label = `${code} for ${JSON.stringify(config)}`;
    assert.equal(result.status, 1, `${label}: ${result.output}`);
    assert.match(result.output, new RegExp(`error ${code}: `), label);
    // Wrangler's banner is the proof a spawn happened; a refused guard must not
    // reach it.
    assert.doesNotMatch(result.output, /wrangler \d+\.\d+\.\d+/, label);
    assert.doesNotMatch(result.output, /⛅/, label);
  }
});

test("the missing-flag rule survives --allow-pilot-flags", (t) => {
  // The override permits a value other than "false"; it does not permit the
  // variable to vanish from the artefact.
  const { directory } = workspace(t, withoutVar("PILOT_EVENTS_ENABLED"));

  const result = runCli(directory, ["dry-run", "--allow-pilot-flags"]);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /error staging_pilot_flag_missing: /);
  assert.doesNotMatch(result.output, /wrangler \d+\.\d+\.\d+/);
});

test("dry-run deploys nothing and reports the target it verified", (t) => {
  // The happy path: the flags are "false" and the guard passes, so the command
  // reaches Wrangler's local `--dry-run`, which builds and exits without an
  // upload. A guard that no longer prints the verified values fails here.
  const { directory } = workspace(t, stagingConfig());

  const result = runCli(directory, ["dry-run"]);

  assert.equal(result.status, 0, result.output);
  assert.match(
    result.output,
    /Verified staging deploy target: worker learner-auth-staging, database certpath-learner-staging \(binding DB\)/,
  );
  assert.match(result.output, /Verified cron schedule: \*\/5 \* \* \* \*/);
  for (const name of STAGING_PILOT_FLAGS) {
    assert.match(result.output, new RegExp(`Verified ${name}="false"`));
  }
  // No --expect-account and no CLOUDFLARE_ACCOUNT_ID: the command says the
  // account was not asserted rather than implying it was.
  assert.match(result.output, /Account: not asserted /);
  assert.match(result.output, /--dry-run: exiting now/);
  // A dry-run must not publish. Wrangler names the published Worker and its URL
  // on a real deploy; neither may appear.
  assert.doesNotMatch(result.output, /Published/);
  assert.doesNotMatch(result.output, /learner-auth-staging\.certpath\.workers\.dev/);
});

test("--allow-pilot-flags permits an enabled flag and says so", (t) => {
  const config = withVars({ PILOT_EVENTS_RETENTION_ENABLED: "true" });
  const { directory } = workspace(t, config);

  const refused = runCli(directory, ["dry-run"]);
  assert.equal(refused.status, 1, refused.output);
  assert.match(refused.output, /error staging_pilot_flag_enabled: /);
  assert.match(refused.output, /PILOT_EVENTS_RETENTION_ENABLED is "true"/);

  const allowed = runCli(directory, ["dry-run", "--allow-pilot-flags"]);
  assert.equal(allowed.status, 0, allowed.output);
  assert.match(
    allowed.output,
    /Pilot flag override: --allow-pilot-flags \(the flags above are not asserted false\)/,
  );
  assert.match(allowed.output, /Verified PILOT_EVENTS_RETENTION_ENABLED="true"/);
});

test("an unknown action is a usage error, exit 2", (t) => {
  const { directory } = workspace(t, stagingConfig());

  const result = runCli(directory, ["publish"]);

  assert.equal(result.status, 2, result.output);
  assert.match(
    result.output,
    /Usage: staging-command\.mjs \[build\|deploy\|dry-run\] \[--expect-account <account id>\] \[--allow-pilot-flags\]/,
  );
});

test("a mistyped option is refused, not ignored", (t) => {
  // A `--expect-acount` typo must not look like a pinned deploy: unknown
  // arguments are a usage error before the guard or Wrangler runs.
  const { directory } = workspace(t, stagingConfig());

  const result = runCli(directory, ["dry-run", "--expect-acount", "abc"]);

  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /error unknown_argument: /);
  assert.doesNotMatch(result.output, /wrangler \d+\.\d+\.\d+/);
});

test("a CLOUDFLARE_ACCOUNT_ID in the parent environment is never deployed to silently", (t) => {
  // ARC B1. Wrangler prefers CLOUDFLARE_ACCOUNT_ID over its stored selection,
  // so a stale value in the operator's shell would deploy learner-auth-staging
  // into that account, bound to a database id that does not exist there. The
  // assertion is local: it must refuse before Wrangler is spawned.
  const { directory } = workspace(t, stagingConfig());
  const stale = "11111111-2222-4333-8444-555555555555";
  const expected = "99999999-8888-4777-8666-555555555555";

  const unconfirmed = runCli(directory, ["dry-run"], {
    CLOUDFLARE_ACCOUNT_ID: stale,
  });
  assert.equal(unconfirmed.status, 1, unconfirmed.output);
  assert.match(unconfirmed.output, /error account_env_mismatch: /);
  assert.match(unconfirmed.output, /no --expect-account was given/);
  assert.doesNotMatch(unconfirmed.output, /wrangler \d+\.\d+\.\d+/);
  assert.doesNotMatch(unconfirmed.output, /⛅/);

  const mismatched = runCli(
    directory,
    ["dry-run", "--expect-account", expected],
    { CLOUDFLARE_ACCOUNT_ID: stale },
  );
  assert.equal(mismatched.status, 1, mismatched.output);
  assert.match(mismatched.output, /error account_env_mismatch: /);
  assert.doesNotMatch(mismatched.output, /wrangler \d+\.\d+\.\d+/);

  // Confirmed: the environment agrees with the flag, so the run proceeds and
  // says which account it pinned.
  const confirmed = runCli(
    directory,
    ["dry-run", "--expect-account", expected],
    { CLOUDFLARE_ACCOUNT_ID: expected },
  );
  assert.equal(confirmed.status, 0, confirmed.output);
  assert.match(
    confirmed.output,
    new RegExp(
      `Account: CLOUDFLARE_ACCOUNT_ID pinned to ${expected} for this run`,
    ),
  );
  assert.match(confirmed.output, /--dry-run: exiting now/);
});

test("deploy requires --expect-account, and a disagreeing environment still refuses", (t) => {
  // ARC round 3: `deploy` is the one irreversible action, so the account is
  // mandatory even when the environment is silent - otherwise Wrangler's stored
  // selection decides where the Worker and its cron are created.
  //
  // Both rows use an artefact the next guard refuses (the pilot Worker name).
  // The account guard runs first, so the assertion is about the account; and if
  // the account rule ever regressed, the run would stop at the artefact guard
  // instead of reaching a real `wrangler deploy`. This suite never uploads.
  const { directory } = workspace(t, {
    ...stagingConfig(),
    name: "certpath-pilot",
  });
  const expected = "99999999-8888-4777-8666-555555555555";
  const stale = "11111111-2222-4333-8444-555555555555";

  const missing = runCli(directory, ["deploy"]);
  assert.equal(missing.status, 2, missing.output);
  assert.match(missing.output, /error account_not_asserted: /);
  assert.match(missing.output, /pass --expect-account <account id>/);
  assert.doesNotMatch(missing.output, /wrangler \d+\.\d+\.\d+/);
  assert.doesNotMatch(missing.output, /⛅/);

  // The environment is set: still not a source of truth, and still refused when
  // it disagrees with the flag.
  const disagreeing = runCli(directory, ["deploy", "--expect-account", expected], {
    CLOUDFLARE_ACCOUNT_ID: stale,
  });
  assert.equal(disagreeing.status, 1, disagreeing.output);
  assert.match(disagreeing.output, /error account_env_mismatch: /);
  assert.doesNotMatch(disagreeing.output, /wrangler \d+\.\d+\.\d+/);
  assert.doesNotMatch(disagreeing.output, /⛅/);

  // With the account in order, the run reaches the artefact guard - which is
  // the ordering the two rows above rely on, stated as a positive.
  const agreed = runCli(
    directory,
    ["deploy", "--expect-account", expected],
    { CLOUDFLARE_ACCOUNT_ID: expected },
  );
  assert.equal(agreed.status, 1, agreed.output);
  assert.match(agreed.output, /error staging_wrong_worker: /);
  assert.doesNotMatch(agreed.output, /wrangler \d+\.\d+\.\d+/);
});

test("only dry-run carries --dry-run, and only deploy has no guard-free path", () => {
  // ARC: every CLI test spawns `dry-run`, so dropping `--dry-run` from the
  // deploy argument list would turn the happy-path test into an upload. The argv
  // is pure, so it is asserted here without spawning anything.
  assert.deepEqual(wranglerArgs("deploy"), [
    "deploy",
    "-c",
    "build/server/wrangler.json",
  ]);
  assert.deepEqual(wranglerArgs("dry-run"), [
    "deploy",
    "--dry-run",
    "-c",
    "build/server/wrangler.json",
  ]);
  assert.ok(!wranglerArgs("deploy").includes("--dry-run"));
  assert.ok(wranglerArgs("dry-run").includes("--dry-run"));
  for (const action of ["deploy", "dry-run"]) {
    const args = wranglerArgs(action);
    assert.deepEqual(args.slice(-2), ["-c", "build/server/wrangler.json"]);
    assert.equal(args[0], "deploy");
  }
  // Only the two guarded actions produce an argv at all.
  for (const action of ["build", undefined, ""]) {
    assert.throws(
      () => wranglerArgs(action),
      (error) => error instanceof CliError && error.code === "unknown_action",
    );
  }
});

test("deployEnv makes the account mandatory for deploy and optional for dry-run", () => {
  // The CLI-level rows above pin the ordering; these pin the rule itself.
  const missing = {
    parentEnv: {},
    expectAccount: null,
    requireAccount: true,
  };
  for (const parentEnv of [{}, { CLOUDFLARE_ACCOUNT_ID: "abc" }]) {
    assert.throws(
      () => deployEnv({ ...missing, parentEnv }),
      (error) =>
        error instanceof CliError &&
        error.code === "account_not_asserted" &&
        error.exitCode === 2,
    );
  }

  // `dry-run` may omit it: nothing is created, and the command says so.
  const unpinned = deployEnv({ parentEnv: {}, expectAccount: null });
  assert.equal(unpinned.expectAccount, null);
  assert.equal(unpinned.env.CLOUDFLARE_ACCOUNT_ID, undefined);

  // A supplied id is pinned into the child environment, and it must agree with
  // whatever the shell carries.
  const pinned = deployEnv({
    parentEnv: { CLOUDFLARE_ACCOUNT_ID: "abc" },
    expectAccount: "abc",
    requireAccount: true,
  });
  assert.equal(pinned.env.CLOUDFLARE_ACCOUNT_ID, "abc");
  assert.throws(
    () =>
      deployEnv({
        parentEnv: { CLOUDFLARE_ACCOUNT_ID: "abc" },
        expectAccount: "def",
        requireAccount: true,
      }),
    (error) =>
      error instanceof CliError &&
      error.code === "account_env_mismatch" &&
      error.exitCode === 1,
  );
});

test("the guard helper names each refusal code and returns what it verified", () => {
  // The same rules without the CLI layer, so a code that is renamed is caught
  // in one place.
  const codes = [
    [undefined, "staging_config_missing"],
    ["not json", "staging_config_unparsed"],
  ];
  const directory = mkdtempSync(path.join(tmpdir(), "certpath-staging-lib-"));
  try {
    for (const [content, code] of codes) {
      if (content !== undefined) {
        const file = path.join(directory, "wrangler.json");
        writeFileSync(file, content);
        assert.throws(
          () => readStagingGeneratedConfig(file),
          (error) => error instanceof CliError && error.code === code,
        );
      } else {
        assert.throws(
          () => readStagingGeneratedConfig(path.join(directory, "absent.json")),
          (error) => error instanceof CliError && error.code === code,
        );
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const verified = assertStagingDeployConfig(stagingConfig());
  assert.deepEqual(verified, {
    worker: "learner-auth-staging",
    database: "certpath-learner-staging",
    binding: "DB",
    schedule: ["*/5 * * * *"],
    flags: {
      PILOT_EVENTS_ENABLED: "false",
      PILOT_SERVER_EVENTS_ENABLED: "false",
      PILOT_EVENTS_RETENTION_ENABLED: "false",
    },
    allowPilotFlags: false,
  });

  // The binding and the schedule are refusals, not just return values.
  assert.throws(
    () =>
      assertStagingDeployConfig(
        withDatabase({
          binding: "STAGING_DB",
          database_name: "certpath-learner-staging",
          database_id: STAGING_ID,
        }),
      ),
    (error) =>
      error instanceof CliError && error.code === "staging_database_mismatch",
  );
  assert.throws(
    () => assertStagingDeployConfig(withCrons(["0 * * * *"])),
    (error) =>
      error instanceof CliError && error.code === "staging_schedule_mismatch",
  );

  const enabled = withVars({ PILOT_EVENTS_ENABLED: "true" });
  assert.throws(
    () => assertStagingDeployConfig(enabled),
    (error) => error instanceof CliError && error.code === "staging_pilot_flag_enabled",
  );
  assert.equal(
    assertStagingDeployConfig(enabled, { allowPilotFlags: true }).flags
      .PILOT_EVENTS_ENABLED,
    "true",
  );
});

// ---------------------------------------------------------------------------
// Continuous deployment schema gate (scripts/migration-gate.mjs and
// scripts/lib/migration-gate.mjs).
//
// Staging D1 sits at 22 applied migrations while `main` carries 23, so the
// publish job must stop instead of deploying code ahead of its schema. These
// rows are the gate's rules; the CLI rows below prove the refusals happen
// before Wrangler is spawned, so no case here reaches the network. The real
// `wrangler d1 migrations list --remote` output the parser is written for was
// captured from `certpath-learner-staging` on 19 November 2026.
// ---------------------------------------------------------------------------

const GATE_CLI = fileURLToPath(
  new URL("./migration-gate.mjs", import.meta.url),
);
const ACCOUNT_ID = "ef67137c4d1556f7f51f1cb3f1f420f3";

function runGate(args, envOverrides = {}) {
  const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" };
  delete env.CLOUDFLARE_ACCOUNT_ID;
  Object.assign(env, envOverrides);
  const result = spawnSync(process.execPath, [GATE_CLI, ...args], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

test("the schema gate reads the pending table and the clean line, and refuses anything else", () => {
  // The exact shape `wrangler d1 migrations list certpath-learner-staging
  // --remote` printed for the deferred 0023.
  const pendingOutput = [
    " ⛅️ wrangler 4.160.0 (update available 4.165.0)",
    "───────────────────────────────────────────────",
    "Resource location: remote ",
    "",
    "Migrations to be applied:",
    "┌──────────────────────────────┐",
    "│ Name                         │",
    "├──────────────────────────────┤",
    "│ 0023_staff_second_factor.sql │",
    "└──────────────────────────────┘",
  ].join("\n");
  assert.deepEqual(parseMigrationsList(pendingOutput), {
    pending: ["0023_staff_second_factor.sql"],
    clean: false,
  });

  // Two pending files are both named, and a repeated row is not counted twice.
  const two = parseMigrationsList(
    [
      "Migrations to be applied:",
      "┌──────────────────────────────────┐",
      "│ Name                             │",
      "├──────────────────────────────────┤",
      "│ 0022_pilot_events_retention.sql  │",
      "│ 0023_staff_second_factor.sql     │",
      "│ 0023_staff_second_factor.sql     │",
      "└──────────────────────────────────┘",
    ].join("\n"),
  );
  assert.deepEqual(two.pending, [
    "0022_pilot_events_retention.sql",
    "0023_staff_second_factor.sql",
  ]);

  // Wrangler's clean line.
  assert.deepEqual(
    parseMigrationsList("✅ No migrations to apply!"),
    { pending: [], clean: true },
  );

  // Colour codes must not hide a row.
  assert.deepEqual(
    parseMigrationsList("\u001b[1m│ 0023_staff_second_factor.sql │\u001b[0m").pending,
    ["0023_staff_second_factor.sql"],
  );
  // A banner alone is not evidence of anything.
  assert.throws(
    () => parseMigrationsList("Migrations to be applied:"),
    (error) =>
      error instanceof CliError && error.code === "migrations_list_unparsed",
  );
  // The clean line beside a pending row is contradictory, not resolvable.
  assert.throws(
    () =>
      parseMigrationsList(
        `${pendingOutput}\n✅ No migrations to apply!`,
      ),
    (error) =>
      error instanceof CliError && error.code === "migrations_list_ambiguous",
  );
});

test("the schema gate plans skip for staging and abort for production, and refuses a pending file this commit does not carry", () => {
  const available = ["0022_pilot_events_retention.sql", "0023_staff_second_factor.sql"];

  assert.deepEqual(
    planMigrationGate({ pending: [], available, mode: "skip" }),
    { action: "deploy", pending: [] },
  );
  assert.deepEqual(
    planMigrationGate({
      pending: ["0023_staff_second_factor.sql"],
      available,
      mode: "skip",
    }),
    { action: "skip", pending: ["0023_staff_second_factor.sql"] },
  );
  assert.deepEqual(
    planMigrationGate({
      pending: ["0023_staff_second_factor.sql"],
      available,
      mode: "abort",
    }),
    { action: "abort", pending: ["0023_staff_second_factor.sql"] },
  );

  // Exit codes are the workflow contract; the workflow reads 3 as "do not
  // deploy", so a rename here would silently deploy or fail the build.
  assert.equal(exitCodeForAction("deploy"), 0);
  assert.equal(exitCodeForAction("skip"), 3);
  assert.equal(exitCodeForAction("abort"), 4);

  assert.throws(
    () => planMigrationGate({ pending: [], available, mode: "apply" }),
    (error) => error instanceof CliError && error.code === "gate_mode_unknown",
  );
  assert.throws(
    () => planMigrationGate({ pending: [], available: [], mode: "skip" }),
    (error) => error instanceof CliError && error.code === "migrations_dir_empty",
  );
  // The database wants a migration this commit does not have: the schema is
  // from another revision, so neither skip nor abort is enough - it refuses.
  assert.throws(
    () =>
      planMigrationGate({
        pending: ["0099_from_the_future.sql"],
        available,
        mode: "skip",
      }),
    (error) => error instanceof CliError && error.code === "migration_not_in_repo",
  );
});

test("the schema gate notice names the pending file and says nothing was deployed", () => {
  const skipped = describeMigrationGate({
    action: "skip",
    pending: ["0023_staff_second_factor.sql"],
    database: "certpath-learner-staging",
  });
  assert.match(skipped.notice, /^::notice title=Staging deploy skipped::/);
  assert.match(skipped.notice, /0023_staff_second_factor\.sql/);
  assert.match(skipped.notice, /not deployed/);
  assert.match(skipped.summary, /Staging deploy skipped/);
  assert.match(skipped.summary, /\| `0023_staff_second_factor\.sql` \|/);

  const aborted = describeMigrationGate({
    action: "abort",
    pending: ["0023_staff_second_factor.sql"],
    database: "certpath-pilot",
  });
  assert.match(aborted.notice, /^::error title=Production deploy aborted::/);
  assert.match(aborted.summary, /nothing was deployed/);
});

test("the schema gate CLI refuses before Wrangler is spawned", () => {
  // A missing account assertion is a usage error: an unpinned remote read could
  // be about another account entirely.
  const unpinned = runGate([
    "--config",
    "wrangler.staging.jsonc",
    "--database",
    "certpath-learner-staging",
    "--mode",
    "skip",
  ]);
  assert.equal(unpinned.status, 2, unpinned.output);
  assert.match(unpinned.output, /error missing_option: --expect-account is required/);
  assert.doesNotMatch(unpinned.output, /⛅/);

  // A mistyped option is refused, not ignored.
  const mistyped = runGate(
    [
      "--config",
      "wrangler.staging.jsonc",
      "--database",
      "certpath-learner-staging",
      "--mode",
      "skip",
      "--expect-acount",
      ACCOUNT_ID,
    ],
    { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
  );
  assert.equal(mistyped.status, 2, mistyped.output);
  assert.match(mistyped.output, /error unknown_argument: /);
  assert.doesNotMatch(mistyped.output, /⛅/);

  // A disagreement between --expect-account and the environment is refused
  // rather than resolved in Wrangler's favour.
  const mismatch = runGate(
    [
      "--config",
      "wrangler.staging.jsonc",
      "--database",
      "certpath-learner-staging",
      "--mode",
      "skip",
      "--expect-account",
      ACCOUNT_ID,
    ],
    { CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000" },
  );
  assert.equal(mismatch.status, 1, mismatch.output);
  assert.match(mismatch.output, /error account_env_mismatch: /);
  assert.doesNotMatch(mismatch.output, /⛅/);

  // The gate must read the database it is about to gate: asking it about the
  // pilot database with the staging config is refused before the network.
  const wrongDatabase = runGate(
    [
      "--config",
      "wrangler.staging.jsonc",
      "--database",
      "certpath-pilot",
      "--mode",
      "skip",
      "--expect-account",
      ACCOUNT_ID,
    ],
    { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
  );
  assert.equal(wrongDatabase.status, 1, wrongDatabase.output);
  assert.match(wrongDatabase.output, /error database_mismatch: /);
  assert.doesNotMatch(wrongDatabase.output, /⛅/);

  // The pilot database is still the all-zero placeholder, so there is nothing
  // to compare: a production deploy is refused rather than shipped blind.
  const notProvisioned = runGate(
    [
      "--config",
      "wrangler.pilot.jsonc",
      "--database",
      "certpath-pilot",
      "--mode",
      "abort",
      "--expect-account",
      ACCOUNT_ID,
    ],
    { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
  );
  assert.equal(notProvisioned.status, 1, notProvisioned.output);
  assert.match(notProvisioned.output, /error database_not_provisioned: /);
  assert.doesNotMatch(notProvisioned.output, /⛅/);
});

test("the schema gate refuses a config that compares a different migrations directory", (t) => {
  // Wrangler prints "No migrations to apply!" relative to the config's own
  // migrations_dir. A config pointing elsewhere would give a clean line for a
  // chain this repository does not review, and the gate would pass a deploy
  // whose real migration is pending - so the directory is checked before the
  // read. The fixture is otherwise a valid target (real id, right database), so
  // the row fails if the directory rule is removed.
  const directory = mkdtempSync(path.join(tmpdir(), "certpath-gate-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "wrangler.staging.jsonc");
  writeFileSync(
    file,
    JSON.stringify({
      name: "learner-auth-staging",
      d1_databases: [
        {
          binding: "DB",
          database_name: "certpath-learner-staging",
          database_id: "c52e398f-4280-40a6-8244-854186dc6ef2",
          migrations_dir: "../somewhere-else",
        },
      ],
    }),
  );

  const result = runGate(
    [
      "--config",
      file,
      "--database",
      "certpath-learner-staging",
      "--mode",
      "skip",
      "--expect-account",
      ACCOUNT_ID,
    ],
    { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
  );
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /error migrations_dir_mismatch: /);
  assert.match(result.output, /somewhere-else/);
  assert.doesNotMatch(result.output, /⛅/);
});

// The publish jobs stamp the deployed commit into the generated config they
// deploy. The value becomes a public Worker var, so the rule that only a hex
// commit may be stamped is asserted here: without it, a mistyped CI variable
// (a token, an account id) would be shipped to the Worker as a var.
test("the deploy stamp writes DEPLOYED_COMMIT and refuses anything that is not a commit", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "certpath-stamp-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "wrangler.json");
  writeFileSync(
    file,
    JSON.stringify({ name: "certpath-site", vars: { INDEXING_ENABLED: "true" } }),
  );

  assert.equal(
    runStamp([file, "--commit", "280d53b"]).status,
    0,
  );
  const stamped = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(stamped.name, "certpath-site");
  assert.equal(stamped.vars.DEPLOYED_COMMIT, "280d53b");
  assert.equal(stamped.vars.INDEXING_ENABLED, "true");

  // A value that is not a commit never reaches the artefact. The account id
  // is the interesting row: it is 32 hex characters, so a length-only rule
  // would have shipped it as the deployed commit.
  for (const [commit, expected, marker] of [
    ["ef67137c4d1556f7f51f1cb3f1f420f3", 1, "commit_invalid"],
    ["zzzzzzz", 1, "commit_invalid"],
    ["280d53", 1, "commit_invalid"],
    ["", 2, "missing_option_value"],
  ]) {
    const result = runStamp([file, "--commit", commit]);
    assert.equal(result.status, expected, result.output);
    assert.match(result.output, new RegExp(`error ${marker}: `));
  }
  const absent = runStamp([file]);
  assert.equal(absent.status, 1, absent.output);
  assert.match(absent.output, /error commit_invalid: /);
  assert.equal(
    JSON.parse(readFileSync(file, "utf8")).vars.DEPLOYED_COMMIT,
    "280d53b",
  );

  // An artefact that names no Worker is not the build's output.
  writeFileSync(file, JSON.stringify({ vars: {} }));
  const unnamed = runStamp([file, "--commit", "280d53b"]);
  assert.equal(unnamed.status, 1, unnamed.output);
  assert.match(unnamed.output, /error config_unparsed: /);
});

function runStamp(args, envOverrides = {}) {
  const env = { ...process.env, NO_COLOR: "1", CI: "1" };
  delete env.DEPLOYED_COMMIT;
  Object.assign(env, envOverrides);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./stamp-deployed-commit.mjs", import.meta.url)), ...args],
    { encoding: "utf8", env },
  );
  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}
