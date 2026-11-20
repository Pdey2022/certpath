// Pilot deploy CLI rules (`pilot-command.mjs`). Issue #149 gave the staging
// deploy an account assertion; the production workflow deploys the app through
// `deploy:pilot`, so the pilot path carries the same rule rather than relying on
// the workflow's environment check alone.
//
// The account rule itself is `deployEnv` in ./d1-targets.mjs - the same helper
// `staging-command.mjs` uses, with the same codes and exit codes. What lives
// here is only what is pilot-specific: the arguments this CLI accepts and the
// Wrangler argv, kept pure so the `--dry-run` that keeps a test run local cannot
// be dropped without a test failing.
import { existsSync, readFileSync } from "node:fs";
import {
  CliError,
  DEPLOYED_COMMIT_PATTERN,
  idClass,
  normalizeDatabaseId,
} from "./d1-targets.mjs";

export const PILOT_WORKER_NAME = "certpath-pilot";
export const PILOT_DATABASE_NAME = "certpath-pilot";
export const PILOT_D1_BINDING = "DB";
export const PILOT_CONFIG_SUFFIX = "/wrangler.pilot.jsonc";
export const PILOT_USAGE =
  "pilot-command.mjs <build|deploy|dry-run> [--expect-account <account id>]";

/**
 * Parse the arguments of `deploy` / `dry-run`. Unknown arguments are refused
 * rather than ignored: a mistyped `--expect-acount` would otherwise leave the
 * deploy unpinned while looking pinned. There is no `--allow-pilot-flags` here
 * - that override belongs to the staging guard, and a pilot deploy must not
 * inherit a way to waive an assertion.
 */
export function parsePilotDeployOptions(argv) {
  const options = { expectAccount: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
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
      `Unknown argument ${JSON.stringify(argument)}; usage: ${PILOT_USAGE}`,
      2,
    );
  }
  return options;
}

/**
 * Read the generated config, refusing to guess when it is unusable. The codes
 * are pilot-specific so a refusal names the pilot build; the staging reader
 * (`readStagingGeneratedConfig`) keeps its own pair for the same reason.
 */
export function readPilotGeneratedConfig(file) {
  if (!existsSync(file)) {
    throw new CliError(
      "pilot_config_missing",
      `${file} does not exist; run npm run build:pilot first (deploy:pilot ships build/server/wrangler.json, and it must be the pilot build)`,
      1,
    );
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliError(
      "pilot_config_unparsed",
      `Cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
      1,
    );
  }
}

/**
 * Assert that the generated config is the pilot target, then return what was
 * verified. This mirrors `assertStagingDeployConfig` (#149): every build target
 * writes the same `build/server/wrangler.json`, so `npm run build:staging &&
 * npm run deploy:pilot` would otherwise ship learner-auth-staging while the
 * operator believes they deployed certpath-pilot.
 *
 * The pilot database is still the all-zero placeholder, so this refuses today.
 * That is the point: there is no provisioned database to deploy against, and
 * the refusal names it rather than shipping a Worker bound to nothing.
 */
export function assertPilotDeployConfig(generatedConfig) {
  if (
    generatedConfig === null ||
    typeof generatedConfig !== "object" ||
    Array.isArray(generatedConfig)
  ) {
    throw new CliError(
      "pilot_config_unparsed",
      "The generated pilot config is not a JSON object; nothing about the artefact can be proven",
      1,
    );
  }

  const configPath =
    typeof generatedConfig.configPath === "string"
      ? generatedConfig.configPath.replaceAll("\\", "/")
      : "";
  if (!configPath.endsWith(PILOT_CONFIG_SUFFIX)) {
    throw new CliError(
      "pilot_wrong_config",
      `The generated config selected ${configPath || "(no configPath)"}, not wrangler.pilot.jsonc; run npm run build:pilot before deploy:pilot`,
      1,
    );
  }

  if (generatedConfig.name !== PILOT_WORKER_NAME) {
    throw new CliError(
      "pilot_wrong_worker",
      `The generated config names the ${JSON.stringify(generatedConfig.name)} Worker, not ${PILOT_WORKER_NAME}; run npm run build:pilot before deploy:pilot`,
      1,
    );
  }

  const databases = Array.isArray(generatedConfig.d1_databases)
    ? generatedConfig.d1_databases
    : [];
  if (databases.length !== 1) {
    throw new CliError(
      "pilot_database_mismatch",
      `The generated config declares ${databases.length} d1_databases entries; the pilot Worker carries exactly one binding to ${PILOT_DATABASE_NAME}`,
      1,
    );
  }
  const entry = databases[0];
  const databaseName =
    entry && typeof entry === "object" && typeof entry.database_name === "string"
      ? entry.database_name
      : "";
  const binding =
    entry && typeof entry === "object" && typeof entry.binding === "string"
      ? entry.binding
      : "";
  if (databaseName !== PILOT_DATABASE_NAME || binding !== PILOT_D1_BINDING) {
    throw new CliError(
      "pilot_database_mismatch",
      `The generated config binds ${JSON.stringify(databaseName)} as ${JSON.stringify(binding)}, not ${PILOT_DATABASE_NAME} as ${PILOT_D1_BINDING}; a pilot deploy must not ship another target's database`,
      1,
    );
  }
  // `idClass` applies PLACEHOLDER_DATABASE_ID and treats a missing id as a
  // placeholder, so a pilot deploy fails closed instead of creating a Worker
  // bound to a database that does not exist.
  if (idClass(entry.database_id) !== "real") {
    throw new CliError(
      "pilot_database_placeholder",
      `The generated config binds ${JSON.stringify(normalizeDatabaseId(entry.database_id))} as the ${PILOT_DATABASE_NAME} database_id, which is the all-zero placeholder; record the provisioned id (docs/pilot-provisioning.md) before deploy:pilot`,
      1,
    );
  }

  const vars =
    generatedConfig.vars &&
    typeof generatedConfig.vars === "object" &&
    !Array.isArray(generatedConfig.vars)
      ? generatedConfig.vars
      : {};
  if (vars["INDEXING_ENABLED"] !== "false") {
    throw new CliError(
      "pilot_indexing_enabled",
      `INDEXING_ENABLED is ${JSON.stringify(vars["INDEXING_ENABLED"] ?? null)}, not "false"; the pilot Worker is non-indexable and a deploy must not change that`,
      1,
    );
  }

  const stamp = vars["DEPLOYED_COMMIT"];
  if (typeof stamp !== "string" || !DEPLOYED_COMMIT_PATTERN.test(stamp)) {
    throw new CliError(
      "pilot_deploy_stamp_missing",
      `The generated pilot config carries DEPLOYED_COMMIT ${JSON.stringify(stamp ?? null)}; the publish job stamps the deployed commit (apps/web/scripts/stamp-deployed-commit.mjs) before it deploys, and an artefact without one cannot be tied to a commit`,
      1,
    );
  }

  return {
    worker: generatedConfig.name,
    database: databaseName,
    binding,
    indexing: vars["INDEXING_ENABLED"],
    stamp,
  };
}

/**
 * The Wrangler argument list. Only `deploy` may upload; `dry-run` builds
 * locally and exits.
 */
export function pilotWranglerArgs(action) {
  if (action !== "deploy" && action !== "dry-run") {
    throw new CliError(
      "unknown_action",
      `pilotWranglerArgs received ${JSON.stringify(action)}; only deploy and dry-run spawn Wrangler`,
      2,
    );
  }
  const config = ["-c", "build/server/wrangler.json"];
  return action === "deploy"
    ? ["deploy", ...config]
    : ["deploy", "--dry-run", ...config];
}
