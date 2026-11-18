// Phase 5D staging deploy guard (issue #149). `build:staging` writes
// `build/server/wrangler.json`, the file `wrangler deploy -c
// build/server/wrangler.json` ships — and every build target writes that one
// path. The guard therefore reads the artefact it is about to deploy and names
// the staging target it must be: wrangler.staging.jsonc, the
// learner-auth-staging Worker, exactly one D1 binding for the provisioned
// certpath-learner-staging database, and the three pilot event flags "false".
//
// The rules live here rather than in the CLI so they can be tested without
// spawning Wrangler; `readStagingGeneratedConfig` is the only function that
// touches the file system and it fails closed on a missing or unparseable file.
import { existsSync, readFileSync } from "node:fs";
import {
  CliError,
  assertExpectedAccountEnv,
  idClass,
  normalizeAccountId,
  normalizeDatabaseId,
  wranglerEnv,
} from "./d1-targets.mjs";

export const STAGING_CONFIG_SUFFIX = "/wrangler.staging.jsonc";
export const STAGING_WORKER_NAME = "learner-auth-staging";
export const STAGING_DATABASE_NAME = "certpath-learner-staging";
export const STAGING_D1_BINDING = "DB";
// The Worker's only schedule. `wrangler.staging.jsonc` declares it in #141; the
// deploy ships it, so the guard asserts it rather than trusting the claim.
export const STAGING_CRON = Object.freeze(["*/5 * * * *"]);

// The flags #141 declared all "false" in wrangler.staging.jsonc. A
// deployment must not turn any of them on: the retention prune runs against a
// table whose floor only exists once 0022 is applied, and the funnel events are
// gated on a consent path that staging does not exercise yet.
export const STAGING_PILOT_FLAGS = Object.freeze([
  "PILOT_EVENTS_ENABLED",
  "PILOT_SERVER_EVENTS_ENABLED",
  "PILOT_EVENTS_RETENTION_ENABLED",
]);

/**
 * Parse the arguments of `deploy` / `dry-run`. Unknown arguments are refused
 * rather than ignored: a mistyped `--expect-acount` would otherwise leave the
 * deploy unpinned while looking pinned.
 */
export function parseDeployOptions(argv) {
  const options = { allowPilotFlags: false, expectAccount: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-pilot-flags") {
      options.allowPilotFlags = true;
      continue;
    }
    if (argument === "--expect-account") {
      const value = argv[index + 1];
      index += 1;
      if (!value || value.startsWith("--")) {
        throw new CliError(
          "missing_option_value",
          "--expect-account needs an account id; it is the only source of the expected id",
          2,
        );
      }
      options.expectAccount = value;
      continue;
    }
    throw new CliError(
      "unknown_argument",
      `Unknown argument ${JSON.stringify(argument)}; usage: staging-command.mjs <build|deploy|dry-run> [--expect-account <account id>] [--allow-pilot-flags]`,
      2,
    );
  }
  return options;
}

/**
 * The child environment for Wrangler, and the account the deploy is pinned to.
 *
 * Wrangler resolves the target account from the config, then
 * `CLOUDFLARE_ACCOUNT_ID`, then a stored selection. An id that is only in the
 * operator's shell therefore wins over anything the operator believes they
 * selected, and the deploy lands in that account — bound to a database id that
 * does not exist there. So a set `CLOUDFLARE_ACCOUNT_ID` is never accepted
 * silently: it must be confirmed by `--expect-account`, and the child gets that
 * id pinned (`wranglerEnv`), which removes both fallbacks. The rule and its
 * helpers are the ones `d1-account-preflight.mjs` already uses.
 */
export function deployEnv({ parentEnv = {}, expectAccount = null }) {
  const envAccountId = normalizeAccountId(parentEnv.CLOUDFLARE_ACCOUNT_ID);
  const expected = normalizeAccountId(expectAccount);

  if (expected === "") {
    if (envAccountId !== "") {
      throw new CliError(
        "account_env_mismatch",
        `CLOUDFLARE_ACCOUNT_ID is set to ${envAccountId} and no --expect-account was given; Wrangler prefers the environment variable, so the deploy could land in an account nobody asserted. Pass --expect-account <account id> (or unset the variable) and run again`,
        1,
      );
    }
    // Nothing to pin and nothing to contradict: Wrangler uses its stored
    // selection, and the command says so on stdout.
    return { env: { ...parentEnv }, expectAccount: null, envAccountId: null };
  }

  // Refuses account_env_mismatch when the environment variable disagrees.
  assertExpectedAccountEnv({ expectAccount: expected, envAccountId });
  return {
    env: wranglerEnv({ parentEnv, expectAccount: expected }),
    expectAccount: expected,
    envAccountId: envAccountId === "" ? null : envAccountId,
  };
}

/**
 * The Wrangler argument list, pure so the `--dry-run` that keeps a test run
 * local cannot be dropped without a test failing. Only `deploy` may upload.
 */
export function wranglerArgs(action) {
  if (action !== "deploy" && action !== "dry-run") {
    throw new CliError(
      "unknown_action",
      `wranglerArgs received ${JSON.stringify(action)}; only deploy and dry-run spawn Wrangler`,
      2,
    );
  }
  const config = ["-c", "build/server/wrangler.json"];
  return action === "deploy"
    ? ["deploy", ...config]
    : ["deploy", "--dry-run", ...config];
}

/**
 * Read the generated config, refusing to guess when it is unusable. A missing
 * file means no staging build ran; an unparseable one means the artefact cannot
 * be identified at all. Both are refusals, never a pass.
 */
export function readStagingGeneratedConfig(file) {
  if (!existsSync(file)) {
    throw new CliError(
      "staging_config_missing",
      `${file} does not exist; run npm run build:staging first (deploy:staging ships build/server/wrangler.json, and it must be the staging build)`,
      1,
    );
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliError(
      "staging_config_unparsed",
      `Cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
      1,
    );
  }
}

/**
 * Assert that the generated config is the staging target, then return what was
 * verified so the operator can see it. `allowPilotFlags` permits a pilot flag
 * to be something other than "false"; it does not permit a flag to be absent,
 * because a build that dropped the vars is not the artefact this guard checked.
 */
export function assertStagingDeployConfig(
  generatedConfig,
  { allowPilotFlags = false } = {},
) {
  if (
    generatedConfig === null ||
    typeof generatedConfig !== "object" ||
    Array.isArray(generatedConfig)
  ) {
    throw new CliError(
      "staging_config_unparsed",
      "The generated staging config is not a JSON object; nothing about the artefact can be proven",
      1,
    );
  }

  const configPath =
    typeof generatedConfig.configPath === "string"
      ? generatedConfig.configPath.replaceAll("\\", "/")
      : "";
  if (!configPath.endsWith(STAGING_CONFIG_SUFFIX)) {
    throw new CliError(
      "staging_wrong_config",
      `The generated config selected ${configPath || "(no configPath)"}, not wrangler.staging.jsonc; run npm run build:staging before deploy:staging`,
      1,
    );
  }

  if (generatedConfig.name !== STAGING_WORKER_NAME) {
    throw new CliError(
      "staging_wrong_worker",
      `The generated config names the ${JSON.stringify(generatedConfig.name)} Worker, not ${STAGING_WORKER_NAME}; run npm run build:staging before deploy:staging`,
      1,
    );
  }

  const databases = Array.isArray(generatedConfig.d1_databases)
    ? generatedConfig.d1_databases
    : [];
  if (databases.length !== 1) {
    throw new CliError(
      "staging_database_mismatch",
      `The generated config declares ${databases.length} d1_databases entries; the staging Worker carries exactly one binding to ${STAGING_DATABASE_NAME}`,
      1,
    );
  }
  const entry = databases[0];
  const databaseName =
    entry && typeof entry === "object" && typeof entry.database_name === "string"
      ? entry.database_name
      : "";
  if (databaseName !== STAGING_DATABASE_NAME) {
    throw new CliError(
      "staging_database_mismatch",
      `The generated config binds ${JSON.stringify(databaseName)}, not ${STAGING_DATABASE_NAME}; a staging deploy must not ship another target's database`,
      1,
    );
  }
  const binding =
    entry && typeof entry === "object" && typeof entry.binding === "string"
      ? entry.binding
      : "";
  if (binding !== STAGING_D1_BINDING) {
    throw new CliError(
      "staging_database_mismatch",
      `The generated config names the D1 binding ${JSON.stringify(binding)}, not ${STAGING_D1_BINDING}; the Worker reads env.DB, so a differently named binding is a database mismatch even when the database is right`,
      1,
    );
  }
  // `idClass` is the shared rule from lib/d1-targets.mjs: it applies
  // PLACEHOLDER_DATABASE_ID and treats a missing id as a placeholder, so this
  // guard fails closed instead of shipping an artefact whose id is not a
  // provisioned database.
  if (idClass(entry.database_id) !== "real") {
    throw new CliError(
      "staging_database_placeholder",
      `The generated config binds ${JSON.stringify(normalizeDatabaseId(entry.database_id))} as the ${STAGING_DATABASE_NAME} database_id, which is the all-zero placeholder; record the provisioned id (docs/pilot-provisioning.md) before deploy:staging`,
      1,
    );
  }

  // The cron is part of what the deploy ships, so it is asserted here rather
  // than left to the operator's memory: a staging Worker with the retention
  // schedule and no floor, or with someone's probe schedule, is not this target.
  const crons = generatedConfig.triggers?.crons;
  const schedule = Array.isArray(crons) ? crons : [];
  if (
    schedule.length !== STAGING_CRON.length ||
    STAGING_CRON.some((cron, index) => schedule[index] !== cron)
  ) {
    throw new CliError(
      "staging_schedule_mismatch",
      `The generated config carries the cron schedule ${JSON.stringify(schedule)}, not ${JSON.stringify([...STAGING_CRON])}; wrangler.staging.jsonc declares exactly that one schedule (docs/pilot-provisioning.md)`,
      1,
    );
  }

  const vars =
    generatedConfig.vars &&
    typeof generatedConfig.vars === "object" &&
    !Array.isArray(generatedConfig.vars)
      ? generatedConfig.vars
      : {};
  const flags = {};
  for (const name of STAGING_PILOT_FLAGS) {
    if (!(name in vars)) {
      throw new CliError(
        "staging_pilot_flag_missing",
        `The generated staging config does not carry ${name}; all three pilot event flags must be present and "false" before deploy:staging`,
        1,
      );
    }
    const value = vars[name];
    if (value !== "false" && !allowPilotFlags) {
      throw new CliError(
        "staging_pilot_flag_enabled",
        `${name} is ${JSON.stringify(value)}, not "false"; the staging deploy must not enable pilot events (pass --allow-pilot-flags only for a deliberate, approved flag change)`,
        1,
      );
    }
    flags[name] = value;
  }

  return {
    worker: generatedConfig.name,
    database: databaseName,
    binding,
    schedule: [...schedule],
    flags,
    allowPilotFlags,
  };
}
