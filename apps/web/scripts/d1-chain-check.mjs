#!/usr/bin/env node
// Phase 5A fresh-chain check: every migration applies in order to an empty
// database, the ledger matches the files exactly, a second apply is a no-op,
// and no migration on disk has changed since it was recorded in
// db/migrations/checksums.txt.
//
// Usage:
//   node apps/web/scripts/d1-chain-check.mjs
//        [--migrations-dir <dir>] [--work-dir <empty dir>]
//
// Exit codes: 0 chain reproduced, 1 failure (named code), 2 usage.
import { spawnSync } from "node:child_process";
import {
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
import { fileURLToPath } from "node:url";
import {
  CliError,
  migrationChecksum,
  parseChecksums,
  parseJsonc,
  parseMigrationNames,
  redactSecrets,
  verifyChecksums,
} from "./lib/d1-targets.mjs";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const SECRET_VALUES = [
  process.env.CLOUDFLARE_API_TOKEN,
  process.env.CLOUDFLARE_ACCOUNT_ID,
].filter((value) => typeof value === "string" && value !== "");

function usage() {
  return [
    "Usage: node apps/web/scripts/d1-chain-check.mjs",
    "         [--migrations-dir <dir>] [--work-dir <empty dir>]",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    migrationsDir: path.join(repoRoot, "db", "migrations"),
    workDir: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--migrations-dir" || argument === "--work-dir") {
      const value = argv[index + 1];
      index += 1;
      if (!value) {
        throw new CliError(
          "missing_option_value",
          `${argument} needs a value`,
          2,
        );
      }
      if (argument === "--migrations-dir") options.migrationsDir = path.resolve(value);
      if (argument === "--work-dir") options.workDir = path.resolve(value);
      continue;
    }
    throw new CliError(
      "unknown_argument",
      `Unknown argument ${JSON.stringify(argument)}.\n${usage()}`,
      2,
    );
  }
  return options;
}

function findWrangler() {
  const candidates = [
    new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
    new URL("../../../node_modules/wrangler/bin/wrangler.js", import.meta.url),
  ];
  for (const candidate of candidates) {
    const file = fileURLToPath(candidate);
    if (existsSync(file)) return file;
  }
  throw new CliError(
    "wrangler_missing",
    "Cannot find the Wrangler CLI in node_modules",
    1,
  );
}

function runWrangler(args) {
  const result = spawnSync(process.execPath, [findWrangler(), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    output: redactSecrets(
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
      SECRET_VALUES,
    ),
  };
}

function printDiagnostic(output, lines = 15) {
  const tail = output
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-lines);
  for (const line of tail) console.error(`  ${line}`);
}

function compareNames(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function firstDifference(expected, actual) {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index += 1) {
    if (expected[index] !== actual[index]) {
      return `position ${index + 1}: expected ${expected[index] ?? "(none)"}, found ${actual[index] ?? "(none)"}`;
    }
  }
  return "no difference";
}

/**
 * Write a Wrangler config into the work dir that keeps the local database name
 * and id but points migrations at the directory under test. Wrangler resolves
 * local persistence next to the config file, so the export script can read the
 * same database with `--wrangler-config <work-dir>/wrangler.jsonc`.
 */
function writeWorkConfig(workDir, migrationsDir) {
  const source = path.join(webRoot, "wrangler.jsonc");
  const config = parseJsonc(readFileSync(source, "utf8"), source);
  const databases = Array.isArray(config.d1_databases)
    ? config.d1_databases
    : [];
  if (databases.length !== 1) {
    throw new CliError(
      "d1_binding_missing",
      "apps/web/wrangler.jsonc must declare exactly one d1_databases entry",
      1,
    );
  }
  databases[0].migrations_dir = migrationsDir.split(path.sep).join("/");
  const configPath = path.join(workDir, "wrangler.jsonc");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return {
    configPath,
    databaseName: databases[0].database_name,
    databaseId: databases[0].database_id,
  };
}

function readLedger({ configPath, persistPath, databaseName }) {
  const result = runWrangler([
    "d1",
    "execute",
    databaseName,
    "--local",
    "--persist-to",
    persistPath,
    "-c",
    configPath,
    "--json",
    "--command",
    "SELECT name FROM d1_migrations ORDER BY id",
  ]);
  if (result.status !== 0) {
    console.error("Wrangler d1 execute failed:");
    printDiagnostic(result.output);
    throw new CliError(
      "migration_ledger_unreadable",
      "Cannot read d1_migrations from the freshly migrated database",
      1,
    );
  }
  return parseMigrationNames(result.output);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const migrationsDir = options.migrationsDir;
  if (!existsSync(migrationsDir)) {
    throw new CliError(
      "migrations_dir_missing",
      `${migrationsDir} does not exist`,
      2,
    );
  }

  // 1. Checksums first: a changed byte in an already-applied migration is a
  // schema divergence, not a reason to run anything.
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort(compareNames);
  if (files.length === 0) {
    throw new CliError(
      "no_migrations_found",
      `${migrationsDir} contains no .sql migrations`,
      1,
    );
  }
  const checksumPath = path.join(migrationsDir, "checksums.txt");
  if (!existsSync(checksumPath)) {
    throw new CliError(
      "migration_checksums_missing",
      `${checksumPath} does not exist; every migration needs a recorded sha256`,
      1,
    );
  }
  const checksums = parseChecksums(readFileSync(checksumPath, "utf8"));
  const hashes = new Map(
    files.map((file) => [
      file,
      migrationChecksum(readFileSync(path.join(migrationsDir, file))),
    ]),
  );
  const checksumViolations = verifyChecksums({ files, checksums, hashes });
  if (checksumViolations.length > 0) {
    for (const violation of checksumViolations) {
      console.error(`violation ${violation.code}: ${violation.message}`);
    }
    console.error(
      `chain check FAILED: ${checksumViolations.length} checksum violation(s)`,
    );
    return 1;
  }
  console.log(
    `chain check: ${files.length} migrations, checksums verified (${files[0]} ... ${files[files.length - 1]})`,
  );

  // 2. Apply the whole chain to an empty database.
  const workDir = options.workDir ?? mkdtempSync(path.join(tmpdir(), "certpath-chain-"));
  const persistPath = path.join(workDir, ".wrangler", "state");
  const cleanup = options.workDir === null;
  try {
    if (options.workDir) mkdirSync(workDir, { recursive: true });
    const work = writeWorkConfig(workDir, migrationsDir);
    if (existsSync(persistPath)) {
      throw new CliError(
        "work_dir_not_empty",
        `${workDir} already holds a local database; the chain must start empty`,
        2,
      );
    }

    const applied = runWrangler([
      "d1",
      "migrations",
      "apply",
      work.databaseName,
      "--local",
      "--persist-to",
      persistPath,
      "-c",
      work.configPath,
    ]);
    if (applied.status !== 0) {
      console.error("Wrangler d1 migrations apply failed:");
      printDiagnostic(applied.output);
      throw new CliError(
        "migration_apply_failed",
        `The migration chain did not apply cleanly (exit ${applied.status})`,
        1,
      );
    }

    // 3. The ledger must equal the files, in order, with nothing extra.
    const ledger = readLedger({
      configPath: work.configPath,
      persistPath,
      databaseName: work.databaseName,
    });
    if (
      ledger.length !== files.length ||
      ledger.some((name, index) => name !== files[index])
    ) {
      console.error(
        `  d1_migrations: ${firstDifference(files, ledger)} (${ledger.length} rows for ${files.length} files)`,
      );
      throw new CliError(
        "migration_ledger_mismatch",
        "d1_migrations does not match db/migrations/*.sql",
        1,
      );
    }

    // 4. A second apply must do nothing at all.
    const reapplied = runWrangler([
      "d1",
      "migrations",
      "apply",
      work.databaseName,
      "--local",
      "--persist-to",
      persistPath,
      "-c",
      work.configPath,
    ]);
    if (reapplied.status !== 0) {
      console.error("Wrangler d1 migrations apply failed:");
      printDiagnostic(reapplied.output);
      throw new CliError(
        "second_apply_failed",
        `The second migrations apply exited ${reapplied.status}`,
        1,
      );
    }
    if (!/no migrations to apply/i.test(reapplied.output)) {
      console.error("  Wrangler did not report an empty second apply:");
      printDiagnostic(reapplied.output);
      throw new CliError(
        "second_apply_not_noop",
        "The second migrations apply was not a no-op",
        1,
      );
    }
    const secondLedger = readLedger({
      configPath: work.configPath,
      persistPath,
      databaseName: work.databaseName,
    });
    if (
      secondLedger.length !== ledger.length ||
      secondLedger.some((name, index) => name !== ledger[index])
    ) {
      throw new CliError(
        "second_apply_not_noop",
        `The second apply changed d1_migrations (${firstDifference(ledger, secondLedger)})`,
        1,
      );
    }

    console.log(
      `chain check: applied ${ledger.length} migrations in order, second apply was a no-op`,
    );
    if (options.workDir) {
      console.log(`chain check: local database kept at ${workDir}`);
    }
    return 0;
  } finally {
    if (cleanup) rmSync(workDir, { recursive: true, force: true });
  }
}

try {
  process.exit(main());
} catch (error) {
  if (error instanceof CliError) {
    console.error(`error ${error.code}: ${error.message}`);
    process.exit(error.exitCode);
  }
  console.error(error);
  process.exit(1);
}
