// Tests for the pilot deploy guard (`pilot-command.mjs`). The account rule is
// the one the staging deploy got in #149, now on the path the production
// workflow uses for the `app` target; these rows are the same rows
// staging-command.test.mjs asserts, against the pilot CLI.
//
// Nothing here reaches the network and nothing here can upload: every case that
// gets past the guard drives `dry-run`, and `deploy` is never spawned. The
// refusal rows assert Wrangler's banner never appears, which is the proof the
// guard stopped the run before a spawn.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CliError } from "./lib/d1-targets.mjs";
import {
  assertPilotDeployConfig,
  parsePilotDeployOptions,
  pilotWranglerArgs,
  readPilotGeneratedConfig,
} from "./lib/pilot-deploy.mjs";

const CLI = fileURLToPath(new URL("./pilot-command.mjs", import.meta.url));

// Shaped like the artefact `npm run build:pilot` writes once the pilot database
// is provisioned: the stamp the publish job adds, the non-indexable flag and a
// real database id. The real `wrangler.pilot.jsonc` still carries the all-zero
// placeholder, which is why the guard's placeholder refusal is tested
// separately below and why `npm run dry-run:pilot` refuses today.
function pilotConfig() {
  return {
    configPath: "C:\\repo\\apps\\web\\wrangler.pilot.jsonc",
    name: "certpath-pilot",
    main: "index.js",
    compatibility_date: "2026-11-10",
    vars: {
      INDEXING_ENABLED: "false",
      DEPLOYED_COMMIT: "280d53b",
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: "certpath-pilot",
        database_id: "11111111-1111-4111-8111-111111111111",
      },
    ],
  };
}

function workspace(t, config = pilotConfig()) {
  const directory = mkdtempSync(path.join(tmpdir(), "certpath-pilot-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const buildDirectory = path.join(directory, "build", "server");
  mkdirSync(buildDirectory, { recursive: true });
  writeFileSync(
    path.join(buildDirectory, "wrangler.json"),
    JSON.stringify(config),
  );
  // `dry-run` bundles `main`; the refusals must stop before that.
  writeFileSync(
    path.join(buildDirectory, "index.js"),
    'export default { fetch() { return new Response("ok"); } };\n',
  );
  return directory;
}

// An artefact the *next* guard refuses (the staging Worker name): if the
// account rule under test regresses, the run stops at the artefact guard
// instead of spawning a real `wrangler deploy`. Same trick as the staging suite.
function workspaceRefusedByArtefactGuard(t) {
  return workspace(t, { ...pilotConfig(), name: "learner-auth-staging" });
}

function runCli(directory, args, envOverrides = {}) {
  // The parent environment is made hermetic on purpose: a CLOUDFLARE_ACCOUNT_ID
  // inherited from the developer's shell would make every case refuse with
  // account_env_mismatch, and a test that passes only on a clean machine is not
  // a test. The account cases set it explicitly.
  const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" };
  delete env.CLOUDFLARE_ACCOUNT_ID;
  delete env.CLOUDFLARE_API_KEY;
  delete env.CLOUDFLARE_EMAIL;
  delete env.CLOUDFLARE_API_BASE_URL;
  // Second lock on the same door: an invalid API token, so that even if the
  // account rule regressed and a `deploy` row spawned Wrangler, the spawn could
  // not authenticate - it fails at the API instead of uploading. The staging
  // suite relies on its artefact guard for this; the pilot CLI has no artefact
  // guard, so the guarantee is stated here rather than inferred.
  env.CLOUDFLARE_API_TOKEN = "certpath-test-token-not-a-credential";
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

const EXPECTED = "99999999-8888-4777-8666-555555555555";
const STALE = "11111111-2222-4333-8444-555555555555";

test("pilot deploy requires --expect-account, before Wrangler is spawned", (t) => {
  // `deploy` is the one irreversible action, so the account is mandatory even
  // when the environment is silent - otherwise Wrangler's stored selection
  // decides where certpath-pilot is created. A silent environment is not an
  // assertion, and neither is a populated one.
  //
  // These rows drive `deploy`, and the artefact is one the artefact guard
  // refuses, so a regression in the account rule stops at the next guard rather
  // than at a real upload. runCli's invalid API token is a second lock.
  const directory = workspaceRefusedByArtefactGuard(t);

  const missing = runCli(directory, ["deploy"]);
  assert.equal(missing.status, 2, missing.output);
  assert.match(missing.output, /error account_not_asserted: /);
  assert.match(missing.output, /pass --expect-account <account id>/);
  assert.doesNotMatch(missing.output, /wrangler \d+\.\d+\.\d+/);
  assert.doesNotMatch(missing.output, /⛅/);

  // A value in the environment does not replace the flag; it is only the value
  // to confirm.
  const fromEnvironment = runCli(directory, ["deploy"], {
    CLOUDFLARE_ACCOUNT_ID: STALE,
  });
  assert.equal(fromEnvironment.status, 2, fromEnvironment.output);
  assert.match(fromEnvironment.output, /error account_not_asserted: /);
  assert.match(fromEnvironment.output, /CLOUDFLARE_ACCOUNT_ID is set to /);
  assert.doesNotMatch(fromEnvironment.output, /⛅/);

  // Flag and environment disagreeing is a refusal, not a preference for the
  // environment variable.
  const disagreeing = runCli(
    directory,
    ["deploy", "--expect-account", EXPECTED],
    { CLOUDFLARE_ACCOUNT_ID: STALE },
  );
  assert.equal(disagreeing.status, 1, disagreeing.output);
  assert.match(disagreeing.output, /error account_env_mismatch: /);
  assert.doesNotMatch(disagreeing.output, /wrangler \d+\.\d+\.\d+/);
  assert.doesNotMatch(disagreeing.output, /⛅/);

  // With the account in order, the run reaches the artefact guard - which is
  // the ordering the rows above rely on, stated as a positive.
  const agreed = runCli(
    directory,
    ["deploy", "--expect-account", EXPECTED],
    { CLOUDFLARE_ACCOUNT_ID: EXPECTED },
  );
  assert.equal(agreed.status, 1, agreed.output);
  assert.match(agreed.output, /error pilot_wrong_worker: /);
  assert.doesNotMatch(agreed.output, /⛅/);
});

test("a CLOUDFLARE_ACCOUNT_ID in the parent environment is never deployed to silently", (t) => {
  // Wrangler prefers CLOUDFLARE_ACCOUNT_ID over its stored selection, so a
  // stale value in the operator's shell would deploy certpath-pilot into that
  // account. The assertion is local: it refuses before Wrangler is spawned.
  const directory = workspace(t);

  const unconfirmed = runCli(directory, ["dry-run"], {
    CLOUDFLARE_ACCOUNT_ID: STALE,
  });
  assert.equal(unconfirmed.status, 1, unconfirmed.output);
  assert.match(unconfirmed.output, /error account_env_mismatch: /);
  assert.match(unconfirmed.output, /no --expect-account was given/);
  assert.doesNotMatch(unconfirmed.output, /⛅/);

  const mismatched = runCli(
    directory,
    ["dry-run", "--expect-account", EXPECTED],
    { CLOUDFLARE_ACCOUNT_ID: STALE },
  );
  assert.equal(mismatched.status, 1, mismatched.output);
  assert.match(mismatched.output, /error account_env_mismatch: /);
  assert.doesNotMatch(mismatched.output, /⛅/);

  // Confirmed: the environment agrees with the flag, so the run proceeds and
  // says which account it pinned.
  const confirmed = runCli(
    directory,
    ["dry-run", "--expect-account", EXPECTED],
    { CLOUDFLARE_ACCOUNT_ID: EXPECTED },
  );
  assert.equal(confirmed.status, 0, confirmed.output);
  assert.match(
    confirmed.output,
    new RegExp(`Account: CLOUDFLARE_ACCOUNT_ID pinned to ${EXPECTED} for this run`),
  );
  assert.match(confirmed.output, /--dry-run: exiting now/);
  assert.doesNotMatch(confirmed.output, /Published/);
});

test("pilot dry-run succeeds without --expect-account and says the account was not asserted", (t) => {
  // `dry-run` uploads nothing, so the rule that makes the flag mandatory for
  // `deploy` must not make it mandatory here - and the command must say the
  // account was not asserted rather than implying it was.
  const directory = workspace(t);

  const result = runCli(directory, ["dry-run"]);

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Account: not asserted /);
  assert.match(result.output, /--dry-run: exiting now/);
  // A dry-run must not publish. Wrangler names the published Worker and its URL
  // on a real deploy; neither may appear.
  assert.doesNotMatch(result.output, /Published/);
  assert.doesNotMatch(result.output, /certpath-pilot\.certpath\.workers\.dev/);
});

test("a mistyped option is refused, not ignored, and pilot has no flag override", (t) => {
  // A `--expect-acount` typo must not look like a pinned deploy. Neither may the
  // staging guard's `--allow-pilot-flags`: it waives a staging assertion, and a
  // pilot deploy must not inherit a way to waive the account assertion.
  const directory = workspace(t);

  for (const args of [
    ["dry-run", "--expect-acount", "abc"],
    ["dry-run", "--allow-pilot-flags"],
  ]) {
    const result = runCli(directory, args);
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /error unknown_argument: /);
    assert.doesNotMatch(result.output, /⛅/);
  }

  const noValue = runCli(directory, ["dry-run", "--expect-account"]);
  assert.equal(noValue.status, 2, noValue.output);
  assert.match(noValue.output, /error missing_option_value: /);
  assert.doesNotMatch(noValue.output, /⛅/);
});

test("an unknown action is a usage error, exit 2", (t) => {
  const directory = workspace(t);

  const result = runCli(directory, ["publish"]);

  assert.equal(result.status, 2, result.output);
  assert.match(
    result.output,
    /Usage: pilot-command\.mjs <build\|deploy\|dry-run> \[--expect-account <account id>\]/,
  );
});

test("the pilot artefact guard refuses anything that is not the pilot build", (t) => {
  // `npm run build:staging && npm run deploy:pilot` is the accident this guard
  // exists for: every build target writes build/server/wrangler.json. Reverting
  // any rule below fails its row, and the placeholder row is the one that keeps
  // this refusal loud until certpath-pilot is provisioned.
  const config = pilotConfig();
  assert.deepEqual(assertPilotDeployConfig(config), {
    worker: "certpath-pilot",
    database: "certpath-pilot",
    binding: "DB",
    indexing: "false",
    stamp: "280d53b",
  });

  const cases = [
    [{ ...config, configPath: "C:\\repo\\apps\\web\\wrangler.staging.jsonc" }, "pilot_wrong_config"],
    [{ ...config, configPath: undefined }, "pilot_wrong_config"],
    [{ ...config, name: "learner-auth-staging" }, "pilot_wrong_worker"],
    [{ ...config, d1_databases: [] }, "pilot_database_mismatch"],
    [
      {
        ...config,
        d1_databases: [
          {
            binding: "STAGING_DB",
            database_name: "certpath-pilot",
            database_id: "11111111-1111-4111-8111-111111111111",
          },
        ],
      },
      "pilot_database_mismatch",
    ],
    [
      {
        ...config,
        d1_databases: [
          {
            binding: "DB",
            database_name: "certpath-learner-staging",
            database_id: "11111111-1111-4111-8111-111111111111",
          },
        ],
      },
      "pilot_database_mismatch",
    ],
    [
      {
        ...config,
        d1_databases: [
          {
            binding: "DB",
            database_name: "certpath-pilot",
            database_id: "00000000-0000-0000-0000-000000000000",
          },
        ],
      },
      "pilot_database_placeholder",
    ],
    [
      { ...config, d1_databases: [{ binding: "DB", database_name: "certpath-pilot" }] },
      "pilot_database_placeholder",
    ],
    [{ ...config, vars: { ...config.vars, INDEXING_ENABLED: "true" } }, "pilot_indexing_enabled"],
    [{ ...config, vars: { INDEXING_ENABLED: "false" } }, "pilot_deploy_stamp_missing"],
    // `280d53` is one character short of the shortest commit the stamp writes.
    [{ ...config, vars: { ...config.vars, DEPLOYED_COMMIT: "280d53" } }, "pilot_deploy_stamp_missing"],
  ];
  for (const [value, code] of cases) {
    assert.throws(
      () => assertPilotDeployConfig(value),
      (error) => error instanceof CliError && error.code === code,
      `expected ${code} for ${JSON.stringify(value)}`,
    );
  }

  // The reader names its own refusals, so a deploy with no pilot build fails
  // loudly instead of shipping whatever the previous build left behind.
  const directory = mkdtempSync(path.join(tmpdir(), "certpath-pilot-lib-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.throws(
    () => readPilotGeneratedConfig(path.join(directory, "absent.json")),
    (error) => error instanceof CliError && error.code === "pilot_config_missing",
  );
  const unparseable = path.join(directory, "wrangler.json");
  writeFileSync(unparseable, "not json");
  assert.throws(
    () => readPilotGeneratedConfig(unparseable),
    (error) => error instanceof CliError && error.code === "pilot_config_unparsed",
  );
});

test("only dry-run carries --dry-run, and only deploy has no guard-free path", () => {
  // The CLI tests never spawn `deploy`, so the argv is asserted here: dropping
  // `--dry-run` from the dry-run path would turn the happy-path row into an
  // upload.
  assert.deepEqual(pilotWranglerArgs("deploy"), [
    "deploy",
    "-c",
    "build/server/wrangler.json",
  ]);
  assert.deepEqual(pilotWranglerArgs("dry-run"), [
    "deploy",
    "--dry-run",
    "-c",
    "build/server/wrangler.json",
  ]);
  for (const action of ["build", undefined, ""]) {
    assert.throws(
      () => pilotWranglerArgs(action),
      (error) => error instanceof CliError && error.code === "unknown_action",
    );
  }

  assert.throws(
    () => parsePilotDeployOptions(["--expect-acount", "abc"]),
    (error) => error instanceof CliError && error.code === "unknown_argument",
  );
  assert.throws(
    () => parsePilotDeployOptions(["--expect-account"]),
    (error) => error instanceof CliError && error.code === "missing_option_value",
  );
  assert.deepEqual(parsePilotDeployOptions([]), { expectAccount: null });
  assert.deepEqual(
    parsePilotDeployOptions(["--expect-account", EXPECTED]),
    { expectAccount: EXPECTED },
  );
});
