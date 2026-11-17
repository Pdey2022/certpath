#!/usr/bin/env node
// Phase 5A D1 export with a sidecar manifest.
//
// A published dump (`<db>-<stamp>.sql`) is only ever created by renaming a
// verified `.sql.partial` after `<dump>.manifest.json` is on disk, so a dump
// without its manifest cannot exist.
//
// Usage:
//   node apps/web/scripts/d1-export.mjs --target <local|staging|pilot>
//        [--out <dir>] [--wrangler-config <path>]
//
// Exit codes: 0 exported, 1 verification failed, 2 usage/unknown target,
// 3 d1_not_provisioned, 4 remote_auth_failed.
//
// This script never prints a row value, an email address or dump contents, and
// never echoes CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CliError,
  buildManifest,
  isAuthFailure,
  parseMigrationNames,
  readD1Entry,
  redactSecrets,
  resolveExportTarget,
  sha256Hex,
  tablesFromDump,
} from "./lib/d1-targets.mjs";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const SECRET_VALUES = [
  process.env.CLOUDFLARE_API_TOKEN,
  process.env.CLOUDFLARE_ACCOUNT_ID,
].filter((value) => typeof value === "string" && value !== "");

function usage() {
  return [
    "Usage: node apps/web/scripts/d1-export.mjs --target <local|staging|pilot>",
    "         [--out <dir>] [--wrangler-config <path>]",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { target: null, out: null, wranglerConfig: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (
      argument === "--target" ||
      argument === "--out" ||
      argument === "--wrangler-config"
    ) {
      const value = argv[index + 1];
      index += 1;
      if (!value) {
        throw new CliError(
          "missing_option_value",
          `${argument} needs a value`,
          2,
        );
      }
      if (argument === "--target") options.target = value;
      if (argument === "--out") options.out = value;
      if (argument === "--wrangler-config") options.wranglerConfig = value;
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

function printDiagnostic(output, lines = 20) {
  const tail = output
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-lines);
  for (const line of tail) console.error(`  ${line}`);
}

function gitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const commit = (result.stdout ?? "").trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new CliError(
      "git_commit_unavailable",
      "Cannot read the git commit; a manifest must name the code that produced the dump",
      1,
    );
  }
  return commit;
}

function wranglerVersion() {
  const result = spawnSync(process.execPath, [findWrangler(), "--version"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const match = /(\d+\.\d+\.\d+)/.exec(result.stdout ?? "");
  if (!match) {
    throw new CliError(
      "wrangler_version_unavailable",
      "Cannot read the Wrangler version; a manifest must record it",
      1,
    );
  }
  return match[1];
}

function utcStamp(date) {
  return `${date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
}

function defaultOutDir() {
  const configured = process.env.CERTPATH_D1_EXPORT_DIR;
  if (typeof configured === "string" && configured.trim() !== "") {
    return path.resolve(configured);
  }
  return path.join(homedir(), ".certpath", "exports");
}

function displayConfigPath(configPath) {
  const relative = path.relative(repoRoot, configPath);
  if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return configPath.split(path.sep).join("/");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!options.target) {
    throw new CliError("missing_target", `--target is required.\n${usage()}`, 2);
  }

  const target = resolveExportTarget(options.target);
  const configPath = options.wranglerConfig
    ? path.resolve(options.wranglerConfig)
    : path.join(webRoot, target.configFile);
  if (!existsSync(configPath)) {
    throw new CliError(
      "config_missing",
      `Wrangler config ${configPath} does not exist`,
      2,
    );
  }

  // Resolve the database id before any network call. A remote target without a
  // real id must not be exported: that is how a run would silently capture the
  // wrong (or no) database.
  const entry = readD1Entry(readFileSync(configPath, "utf8"), configPath);
  if (target.mode === "remote" && entry.idClass === "placeholder") {
    throw new CliError(
      "d1_not_provisioned",
      `${target.target} still carries the placeholder database_id; create the database and record its id in ${displayConfigPath(configPath)} before exporting`,
      3,
    );
  }

  const outDir = options.out ? path.resolve(options.out) : defaultOutDir();
  mkdirSync(outDir, { recursive: true });

  const stamp = utcStamp(new Date());
  const baseName = `${entry.databaseName}-${stamp}`;
  const partialPath = path.join(outDir, `${baseName}.sql.partial`);
  const publishedPath = path.join(outDir, `${baseName}.sql`);
  const manifestPath = `${publishedPath}.manifest.json`;
  const manifestPartialPath = `${manifestPath}.partial`;
  if (
    existsSync(publishedPath) ||
    existsSync(manifestPath) ||
    existsSync(partialPath)
  ) {
    throw new CliError(
      "output_exists",
      `${publishedPath} already exists; refusing to overwrite a dump`,
      1,
    );
  }

  // Capture the code and tool version before the dump so they describe the
  // binary that produced it.
  const commit = gitCommit();
  const version = wranglerVersion();
  const locationFlag = target.mode === "local" ? "--local" : "--remote";

  const exported = runWrangler([
    "d1",
    "export",
    entry.databaseName,
    locationFlag,
    "-c",
    configPath,
    "--output",
    partialPath,
    "--skip-confirmation",
  ]);
  if (exported.status !== 0) {
    rmSync(partialPath, { force: true });
    if (target.mode === "remote" && isAuthFailure(exported.output)) {
      throw new CliError(
        "remote_auth_failed",
        `Wrangler was not authenticated for the ${target.target} export; the partial file was deleted`,
        4,
      );
    }
    console.error("Wrangler export failed:");
    printDiagnostic(exported.output);
    throw new CliError(
      "export_failed",
      `Wrangler d1 export exited ${exported.status}; the partial file was deleted`,
      1,
    );
  }

  let bytes;
  try {
    bytes = readFileSync(partialPath);
  } catch (error) {
    throw new CliError(
      "export_failed",
      `Wrangler reported success but no dump was written: ${error instanceof Error ? error.message : String(error)}`,
      1,
    );
  }
  const tables = tablesFromDump(bytes.toString("utf8"));
  if (bytes.length === 0 || tables.length === 0) {
    rmSync(partialPath, { force: true });
    throw new CliError(
      "empty_export",
      `The ${target.target} export is empty (${bytes.length} bytes, ${tables.length} tables); nothing was published`,
      1,
    );
  }

  const migrationsQuery = runWrangler([
    "d1",
    "execute",
    entry.databaseName,
    locationFlag,
    "-c",
    configPath,
    "--json",
    "--command",
    "SELECT name FROM d1_migrations ORDER BY id",
  ]);
  if (migrationsQuery.status !== 0) {
    rmSync(partialPath, { force: true });
    if (target.mode === "remote" && isAuthFailure(migrationsQuery.output)) {
      throw new CliError(
        "remote_auth_failed",
        `Wrangler was not authenticated for the ${target.target} migration ledger; the partial file was deleted`,
        4,
      );
    }
    console.error("Wrangler d1 execute failed:");
    printDiagnostic(migrationsQuery.output);
    throw new CliError(
      "migrations_query_failed",
      "Cannot read d1_migrations, so the manifest cannot record the schema; the partial file was deleted",
      1,
    );
  }
  const migrations = parseMigrationNames(migrationsQuery.output);

  const manifest = buildManifest({
    target: target.target,
    binding: entry.binding,
    databaseName: entry.databaseName,
    databaseIdClass: entry.idClass,
    wranglerConfig: displayConfigPath(configPath),
    capturedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    gitCommit: commit,
    wranglerVersion: version,
    file: path.basename(publishedPath),
    byteLength: statSync(partialPath).size,
    sha256: sha256Hex(bytes),
    tables,
    migrations,
  });

  writeFileSync(manifestPartialPath, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(manifestPartialPath, manifestPath);
  try {
    renameSync(partialPath, publishedPath);
  } catch (error) {
    rmSync(manifestPath, { force: true });
    throw new CliError(
      "publish_failed",
      `Cannot publish the dump: ${error instanceof Error ? error.message : String(error)}`,
      1,
    );
  }

  const insertTotal = tables.reduce((total, table) => total + table.inserts, 0);
  console.log(`export ok: ${target.target} -> ${publishedPath}`);
  console.log(
    `  ${manifest.byteLength} bytes, sha256 ${manifest.sha256}, ${tables.length} tables, ${insertTotal} insert statements, ${migrations.length} migrations`,
  );
  console.log(`  manifest: ${manifestPath}`);
  return 0;
}

try {
  const code = await main();
  process.exit(code);
} catch (error) {
  if (error instanceof CliError) {
    console.error(`error ${error.code}: ${error.message}`);
    process.exit(error.exitCode);
  }
  console.error(error);
  process.exit(1);
}
