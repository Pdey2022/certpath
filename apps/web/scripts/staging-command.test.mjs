// End-to-end tests for the Phase 5D staging deploy guard (issue #149). Each
// case spawns the real `staging-command.mjs` in a temp directory, so it fails
// when the guard in scripts/lib/staging-deploy.mjs is removed rather than only
// when a helper changes. Nothing here reaches the network: every case drives
// `dry-run`, which builds locally and exits, so a case that wrongly passes the
// guard still cannot upload. `deploy` itself is never spawned by this suite.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CliError } from "./lib/d1-targets.mjs";
import {
  STAGING_PILOT_FLAGS,
  assertStagingDeployConfig,
  readStagingGeneratedConfig,
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

function runCli(directory, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
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
    /Verified staging deploy target: worker learner-auth-staging, database certpath-learner-staging/,
  );
  for (const name of STAGING_PILOT_FLAGS) {
    assert.match(result.output, new RegExp(`Verified ${name}="false"`));
  }
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
    /Usage: staging-command\.mjs \[build\|deploy\|dry-run\] \[--allow-pilot-flags\]/,
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
    flags: {
      PILOT_EVENTS_ENABLED: "false",
      PILOT_SERVER_EVENTS_ENABLED: "false",
      PILOT_EVENTS_RETENTION_ENABLED: "false",
    },
    allowPilotFlags: false,
  });

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
