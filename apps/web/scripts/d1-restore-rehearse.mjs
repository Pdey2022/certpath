#!/usr/bin/env node
// Phase 5A rehearsed restore. Loads a dump into a throwaway local database and
// proves the manifest still describes it: integrity, foreign keys, table set,
// per-table row counts and the migration ledger. Nothing is repaired.
//
// The load is a three-phase replay of the verified dump — schema, then data,
// then triggers — so a dump that carries trigger-written rows neither inserts
// into a table that does not exist yet nor re-fires the triggers that wrote
// those rows. The dump file itself is never edited; the phases are copies.
//
// Usage:
//   node apps/web/scripts/d1-restore-rehearse.mjs --file <dump.sql>
//
// The sidecar manifest is `<dump>.manifest.json`. `--persist-to` is refused on
// purpose: a rehearsal must never read or write a real local database.
//
// Exit codes: 0 restores cleanly, 1 mismatch/verification failure, 2 usage.
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
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  CliError,
  assertManifestShape,
  diffTableCounts,
  diffTableSets,
  planReplay,
  readD1Entry,
  redactSecrets,
  sha256Hex,
  splitSqlStatements,
} from "./lib/d1-targets.mjs";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const SECRET_VALUES = [
  process.env.CLOUDFLARE_API_TOKEN,
  process.env.CLOUDFLARE_ACCOUNT_ID,
].filter((value) => typeof value === "string" && value !== "");

function usage() {
  return "Usage: node apps/web/scripts/d1-restore-rehearse.mjs --file <dump.sql>";
}

function parseArgs(argv) {
  const options = { file: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--file") {
      const value = argv[index + 1];
      index += 1;
      if (!value) {
        throw new CliError("missing_option_value", "--file needs a dump path", 2);
      }
      options.file = value;
      continue;
    }
    if (argument === "--persist-to") {
      throw new CliError(
        "persist_to_not_allowed",
        "A rehearsal always uses a fresh temporary database; --persist-to is refused so it can never touch a real one",
        2,
      );
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

function walkSqliteFiles(directory) {
  const files = [];
  if (!existsSync(directory)) return files;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkSqliteFiles(full));
    else if (entry.name.endsWith(".sqlite")) files.push(full);
  }
  return files;
}

function quoteIdentifier(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

function firstDifference(expected, actual) {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index += 1) {
    if (expected[index] !== actual[index]) {
      return `position ${index + 1}: manifest ${expected[index] ?? "(none)"}, restored ${actual[index] ?? "(none)"}`;
    }
  }
  return "no difference";
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!options.file) {
    throw new CliError("missing_file", `--file is required.\n${usage()}`, 2);
  }

  const dumpPath = path.resolve(options.file);
  if (!existsSync(dumpPath)) {
    throw new CliError("dump_missing", `${dumpPath} does not exist`, 2);
  }
  const manifestPath = `${dumpPath}.manifest.json`;
  if (!existsSync(manifestPath)) {
    throw new CliError(
      "manifest_missing",
      `${manifestPath} does not exist; a dump without its manifest cannot be trusted`,
      2,
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new CliError(
      "manifest_invalid",
      `Cannot parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      2,
    );
  }
  assertManifestShape(manifest);

  // 1. The bytes must be the bytes the manifest recorded, before anything is
  // loaded.
  const bytes = readFileSync(dumpPath);
  if (bytes.length !== manifest.byteLength) {
    throw new CliError(
      "dump_size_mismatch",
      `${path.basename(dumpPath)} is ${bytes.length} bytes, manifest recorded ${manifest.byteLength}`,
      1,
    );
  }
  const digest = sha256Hex(bytes);
  if (digest !== manifest.sha256) {
    throw new CliError(
      "dump_sha256_mismatch",
      `${path.basename(dumpPath)} hashes to ${digest}, manifest recorded ${manifest.sha256}`,
      1,
    );
  }

  // 2. Load into a throwaway database, the same way an operator would restore.
  const persistDir = mkdtempSync(path.join(tmpdir(), "certpath-rehearse-"));
  let database = null;
  try {
    const configPath = path.join(webRoot, "wrangler.jsonc");
    const entry = readD1Entry(readFileSync(configPath, "utf8"), configPath);
    const executeArgs = [
      "d1",
      "execute",
      entry.databaseName,
      "--local",
      "--persist-to",
      persistDir,
      "-c",
      configPath,
    ];

    // The dump is loaded in three derived phases (schema, data, triggers) so a
    // replay neither inserts into a table that does not exist yet nor re-fires
    // the AFTER INSERT triggers that wrote the rows in the first place. The
    // verified dump is only read: the phases are copies written into the
    // throwaway directory, so its sha256 still matches the manifest.
    const replayDirectory = path.join(persistDir, "replay");
    mkdirSync(replayDirectory, { recursive: true });
    const phases = planReplay(splitSqlStatements(bytes.toString("utf8")));
    const replayed = [];
    for (const phase of phases) {
      const phasePath = path.join(replayDirectory, `${phase.phase}.sql`);
      writeFileSync(phasePath, phase.sql);
      if (phase.statements === 0) continue;
      const loaded = runWrangler([...executeArgs, "--file", phasePath, "-y"]);
      if (loaded.status !== 0) {
        console.error(`Wrangler d1 execute failed on the ${phase.phase} phase:`);
        printDiagnostic(loaded.output);
        throw new CliError(
          "replay_failed",
          `The ${phase.phase} phase of the replay did not load into a fresh local database (exit ${loaded.status}); the dump itself was not edited`,
          1,
        );
      }
      replayed.push(`${phase.phase} ${phase.statements}`);
    }

    const files = walkSqliteFiles(path.join(persistDir, "v3", "d1")).filter(
      (file) => path.basename(file) !== "metadata.sqlite",
    );
    if (files.length !== 1) {
      throw new CliError(
        "restored_database_not_found",
        `Expected one restored database file, found ${files.length}`,
        1,
      );
    }

    database = new DatabaseSync(files[0], { readOnly: true });

    // 3. Structural integrity.
    const integrity = database.prepare("PRAGMA integrity_check").all();
    const integrityValues = integrity.map((row) => String(Object.values(row)[0]));
    if (integrityValues.length !== 1 || integrityValues[0] !== "ok") {
      throw new CliError(
        "integrity_check_failed",
        `PRAGMA integrity_check returned: ${integrityValues.join("; ")}`,
        1,
      );
    }

    const foreignKeyViolations = database
      .prepare("PRAGMA foreign_key_check")
      .all();
    if (foreignKeyViolations.length > 0) {
      for (const violation of foreignKeyViolations.slice(0, 20)) {
        console.error(
          `  foreign key: table ${violation.table} rowid ${violation.rowid} -> ${violation.parent}`,
        );
      }
      throw new CliError(
        "foreign_key_check_failed",
        `PRAGMA foreign_key_check reported ${foreignKeyViolations.length} violation(s)`,
        1,
      );
    }

    // 4. The table *set* first: a table the manifest lists with zero rows must
    // still exist after the restore, and the first export of a freshly migrated
    // database has every table at zero rows.
    const tableNames = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
    const restoredTables = tableNames.map((name) => ({
      name,
      inserts: Number(
        database
          .prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`)
          .get().count,
      ),
    }));
    const tableSetDiffs = diffTableSets(manifest.tables, restoredTables);
    if (tableSetDiffs.length > 0) {
      console.error(`table set diff (${manifestPath}):`);
      for (const line of tableSetDiffs) console.error(`  ${line}`);
      throw new CliError(
        "table_set_mismatch",
        `${tableSetDiffs.length} table(s) missing from or unexpected in the restore`,
        1,
      );
    }

    // 4b. The one table a trigger writes to gets a named assertion: replaying a
    // dump must not re-fire an audit trigger, so the restored count has to equal
    // what the dump carried. A doubled trigger fails here by name instead of
    // disappearing into a per-table diff.
    const manifestAuditEvents = manifest.tables.find(
      (table) => table.name === "audit_events",
    );
    if (manifestAuditEvents) {
      const restoredAuditEvents =
        restoredTables.find((table) => table.name === "audit_events")?.inserts ??
        0;
      if (restoredAuditEvents !== manifestAuditEvents.inserts) {
        throw new CliError(
          "audit_events_replayed",
          `audit_events holds ${restoredAuditEvents} rows after the replay; the manifest recorded ${manifestAuditEvents.inserts}. A trigger wrote rows the dump did not carry, so the replay fired it.`,
          1,
        );
      }
    }

    // 5. Then the per-table row counts.
    const tableDiffs = diffTableCounts(manifest.tables, restoredTables);
    if (tableDiffs.length > 0) {
      console.error(`per-table diff (${manifestPath}):`);
      for (const line of tableDiffs) console.error(`  ${line}`);
      throw new CliError(
        "restore_mismatch",
        `${tableDiffs.length} table(s) differ from the manifest`,
        1,
      );
    }

    // 6. The migration ledger must line up exactly.
    const restoredMigrations = tableNames.includes("d1_migrations")
      ? database
          .prepare("SELECT name FROM d1_migrations ORDER BY id")
          .all()
          .map((row) => String(row.name))
      : [];
    const ledgerMatches =
      restoredMigrations.length === manifest.migrations.length &&
      restoredMigrations.every(
        (name, index) => name === manifest.migrations[index],
      );
    if (!ledgerMatches) {
      console.error(
        `  d1_migrations: ${firstDifference(manifest.migrations, restoredMigrations)} (${restoredMigrations.length} restored rows for ${manifest.migrations.length} manifest entries)`,
      );
      throw new CliError(
        "migration_ledger_mismatch",
        "d1_migrations does not match the manifest",
        1,
      );
    }

    const insertTotal = restoredTables.reduce(
      (total, table) => total + table.inserts,
      0,
    );
    console.log(`rehearsal ok: ${path.basename(dumpPath)}`);
    console.log(
      `  replay: ${replayed.join(", ")} (schema, data, triggers)`,
    );
    console.log(
      `  integrity_check ok, foreign_key_check clean, ${restoredTables.length} tables, ${insertTotal} rows, ${restoredMigrations.length} migrations, sha256 ${digest}`,
    );
    return 0;
  } finally {
    if (database) database.close();
    rmSync(persistDir, { recursive: true, force: true });
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
