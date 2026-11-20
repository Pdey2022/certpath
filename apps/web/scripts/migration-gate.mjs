#!/usr/bin/env node
// Continuous deployment schema gate (staging and production publish jobs).
//
// Compares what `wrangler d1 migrations list <database> --remote` reports as
// pending against `db/migrations/`, and refuses to let a deploy run ahead of
// the schema. It never applies a migration: the gate reads, reports and stops.
//
// Usage:
//   node apps/web/scripts/migration-gate.mjs
//        --config <wrangler config> --database <database name>
//        --mode <skip|abort> --expect-account <account id>
//
// `--config` is resolved against apps/web (the deploy scripts' working
// directory). `--expect-account` is mandatory: the read is about the account
// the deploy will write to, and Wrangler would otherwise prefer whatever
// CLOUDFLARE_ACCOUNT_ID or a stored selection points at.
//
// Exit codes: 0 nothing pending (deploy), 3 pending and skipped, 4 pending and
// aborted, 1 refusal, 2 usage.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CliError,
  assertExpectedAccountEnv,
  idClass,
  normalizeAccountId,
  readD1Entry,
  redactSecrets,
  wranglerEnv,
} from "./lib/d1-targets.mjs";
import {
  describeMigrationGate,
  exitCodeForAction,
  parseMigrationsList,
  planMigrationGate,
} from "./lib/migration-gate.mjs";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const migrationsDir = path.join(repoRoot, "db", "migrations");
const SECRET_VALUES = [process.env.CLOUDFLARE_API_TOKEN];

const OPTIONS = new Map([
  ["--config", "config"],
  ["--database", "database"],
  ["--mode", "mode"],
  ["--expect-account", "expectAccount"],
]);

function usage() {
  return [
    "Usage: node apps/web/scripts/migration-gate.mjs",
    "         --config <wrangler config> --database <database name>",
    "         --mode <skip|abort> --expect-account <account id>",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    config: null,
    database: null,
    mode: null,
    expectAccount: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const key = OPTIONS.get(argument);
    if (!key) {
      throw new CliError(
        "unknown_argument",
        `Unknown argument ${JSON.stringify(argument)}; a mistyped option would otherwise leave the gate unpinned.\n${usage()}`,
        2,
      );
    }
    const value = argv[index + 1];
    index += 1;
    if (!value || value.startsWith("--")) {
      throw new CliError(
        "missing_option_value",
        `${argument} needs a value.\n${usage()}`,
        2,
      );
    }
    options[key] = value;
  }
  return options;
}

function wranglerBin() {
  for (const candidate of [
    "../node_modules/wrangler/bin/wrangler.js",
    "../../../node_modules/wrangler/bin/wrangler.js",
  ]) {
    const file = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(file)) return file;
  }
  throw new CliError(
    "wrangler_missing",
    "Cannot find the Wrangler CLI; run npm ci from the repository root",
    1,
  );
}

/**
 * The config must be the target's own config, name the database the caller
 * expects and carry a provisioned id. A placeholder id means there is no
 * database to compare against, so there is nothing a gate could prove.
 */
function readTarget(configPath, database) {
  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    throw new CliError(
      "config_unreadable",
      `Cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      1,
    );
  }
  const entry = readD1Entry(text, path.basename(configPath));

  // Wrangler compares the database against the config's own migrations_dir. If
  // that points anywhere but this repository's db/migrations, the clean line it
  // prints is about a different chain, and the gate would pass a deploy whose
  // real migration is pending. The config's value is relative to the config
  // file, which is how Wrangler resolves it.
  const declaredDir =
    entry.migrationsDir === ""
      ? "(none)"
      : path.resolve(path.dirname(configPath), entry.migrationsDir);
  if (declaredDir !== migrationsDir) {
    throw new CliError(
      "migrations_dir_mismatch",
      `${path.basename(configPath)} declares migrations_dir ${JSON.stringify(entry.migrationsDir)}, which resolves to ${declaredDir}, not ${migrationsDir}; the gate would compare against a chain this repository does not review`,
      1,
    );
  }

  if (entry.databaseName !== database) {
    throw new CliError(
      "database_mismatch",
      `${path.basename(configPath)} binds ${JSON.stringify(entry.databaseName)}, not ${JSON.stringify(database)}; the gate would compare the wrong database`,
      1,
    );
  }
  if (idClass(entry.databaseId) !== "real") {
    throw new CliError(
      "database_not_provisioned",
      `${database} still carries the all-zero placeholder database_id in ${path.basename(configPath)}; there is no database to gate a deploy against (docs/pilot-provisioning.md)`,
      1,
    );
  }
  return entry;
}

function listPending({ configArg, database, env }) {
  const result = spawnSync(
    process.execPath,
    [
      wranglerBin(),
      "d1",
      "migrations",
      "list",
      database,
      "--remote",
      "-c",
      configArg,
    ],
    { cwd: webRoot, env, encoding: "utf8" },
  );
  const stdout = redactSecrets(result.stdout ?? "", SECRET_VALUES);
  const stderr = redactSecrets(result.stderr ?? "", SECRET_VALUES);
  if (stdout.trim() !== "") console.log(stdout.trimEnd());
  if (stderr.trim() !== "") console.error(stderr.trimEnd());
  if (result.status !== 0) {
    throw new CliError(
      "migrations_list_failed",
      `wrangler d1 migrations list ${database} --remote exited ${result.status}; a gate that cannot read the schema must not let a deploy through`,
      1,
    );
  }
  return parseMigrationsList(stdout);
}

function appendSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (typeof file !== "string" || file === "") return;
  appendFileSync(file, markdown, "utf8");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  for (const [flag, key] of OPTIONS) {
    if (!options[key]) {
      throw new CliError(
        "missing_option",
        `${flag} is required.\n${usage()}`,
        2,
      );
    }
  }

  const configPath = path.resolve(webRoot, options.config);
  const configArg = path.relative(webRoot, configPath).replaceAll("\\", "/");
  readTarget(configPath, options.database);

  // Same rule as a deploy: the account is asserted on the command line and the
  // environment must agree with it, so the read is about that account or fails.
  const expectAccount = assertExpectedAccountEnv({
    expectAccount: options.expectAccount,
    envAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  });
  const env = wranglerEnv({ parentEnv: process.env, expectAccount });

  const available = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  console.log(
    `Schema gate: ${options.database} via ${configArg} (account ${normalizeAccountId(expectAccount)}), ${available.length} migration(s) under db/migrations`,
  );

  const { pending } = listPending({
    configArg,
    database: options.database,
    env,
  });
  const plan = planMigrationGate({
    pending,
    available,
    mode: options.mode,
  });
  const message = describeMigrationGate({
    action: plan.action,
    pending: plan.pending,
    database: options.database,
  });

  console.log(
    plan.action === "deploy"
      ? "Schema gate clear: no pending migration"
      : `Schema gate: ${plan.pending.length} pending — ${plan.pending.join(", ")}`,
  );
  console.log(message.notice);
  appendSummary(message.summary);
  return exitCodeForAction(plan.action);
}

try {
  process.exit(main());
} catch (error) {
  const failure =
    error instanceof CliError
      ? `error ${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  console.error(redactSecrets(failure, SECRET_VALUES));
  if (!(error instanceof CliError) || error.exitCode !== 3) {
    const first = redactSecrets(failure, SECRET_VALUES).split("\n")[0];
    console.error(`::error title=Schema gate refused::${first}`);
  }
  process.exit(error instanceof CliError ? error.exitCode : 1);
}
