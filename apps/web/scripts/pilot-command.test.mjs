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
  parsePilotDeployOptions,
  pilotWranglerArgs,
} from "./lib/pilot-deploy.mjs";

const CLI = fileURLToPath(new URL("./pilot-command.mjs", import.meta.url));

// Shaped like the artefact `npm run build:pilot` writes, trimmed to what
// Wrangler needs for a local `--dry-run`. The database id is still the all-zero
// placeholder, exactly as `wrangler.pilot.jsonc` carries it: the account guard
// is independent of provisioning, and the placeholder is the schema gate's
// refusal, not this one's.
function pilotConfig() {
  return {
    configPath: "C:\\repo\\apps\\web\\wrangler.pilot.jsonc",
    name: "certpath-pilot",
    main: "index.js",
    compatibility_date: "2026-11-10",
    vars: { INDEXING_ENABLED: "false" },
    d1_databases: [
      {
        binding: "DB",
        database_name: "certpath-pilot",
        database_id: "00000000-0000-0000-0000-000000000000",
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

// An artefact whose `main` does not exist: if a `deploy` row ever reaches
// Wrangler, it stops at bundling, locally, before the upload. Used only by rows
// that must not be able to deploy even if the guard under test regresses.
function brokenWorkspace(t) {
  const directory = workspace(t, { ...pilotConfig(), main: "missing-entry.js" });
  return directory;
}

function runCli(directory, args, envOverrides = {}) {
  // The parent environment is made hermetic on purpose: a CLOUDFLARE_ACCOUNT_ID
  // inherited from the developer's shell would make every case refuse with
  // account_env_mismatch, and a test that passes only on a clean machine is not
  // a test. The account cases set it explicitly.
  const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" };
  delete env.CLOUDFLARE_ACCOUNT_ID;
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
  // These rows drive `deploy`, unlike the staging suite's, because this CLI has
  // no artefact guard behind the account guard. Two locks keep a regression
  // from uploading: the artefact's entry point does not exist, so a spawned
  // Wrangler fails while bundling before any API call, and runCli supplies an
  // invalid API token, so it could not authenticate if it got that far. A
  // regression still fails the rows below - the banner appears - it just cannot
  // deploy anything on the way.
  const directory = brokenWorkspace(t);

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
