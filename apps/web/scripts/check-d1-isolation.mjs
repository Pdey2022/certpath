#!/usr/bin/env node
// Phase 5A isolation gate: no preview D1 binding, no two targets sharing a
// database name, no two configs sharing a real database id. Read-only and
// offline; it only reads the four Wrangler configs.
//
// Usage:
//   node apps/web/scripts/check-d1-isolation.mjs [--config-dir <dir>]
//
// Exit codes: 0 isolated, 1 violation (named code), 2 usage.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CliError,
  ISOLATION_CONFIGS,
  analyzeConfigs,
  formatIsolationTable,
} from "./lib/d1-targets.mjs";

const webRoot = fileURLToPath(new URL("../", import.meta.url));

function parseArgs(argv) {
  const options = { configDir: webRoot };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--config-dir") {
      const value = argv[index + 1];
      index += 1;
      if (!value) {
        throw new CliError(
          "missing_option_value",
          "--config-dir needs a directory",
          2,
        );
      }
      options.configDir = path.resolve(value);
      continue;
    }
    throw new CliError(
      "unknown_argument",
      `Unknown argument ${JSON.stringify(argument)}. Usage: check-d1-isolation.mjs [--config-dir <dir>]`,
      2,
    );
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: node apps/web/scripts/check-d1-isolation.mjs [--config-dir <dir>]",
    );
    return 0;
  }

  const configs = [];
  const missing = [];
  for (const config of ISOLATION_CONFIGS) {
    const file = path.join(options.configDir, config.file);
    if (!existsSync(file)) {
      missing.push(config.file);
      continue;
    }
    configs.push({ ...config, text: readFileSync(file, "utf8") });
  }

  const { rows, violations } = analyzeConfigs(configs);
  for (const file of missing) {
    violations.push({
      code: "config_missing",
      message: `${file} is missing from ${options.configDir}; the isolation gate cannot verify what it cannot read`,
    });
  }

  console.log(formatIsolationTable(rows));

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`violation ${violation.code}: ${violation.message}`);
    }
    console.error(
      `D1 isolation FAILED: ${violations.length} violation(s) across ${ISOLATION_CONFIGS.length} configs`,
    );
    return 1;
  }

  console.log(
    `D1 isolation OK: ${ISOLATION_CONFIGS.length} configs, 0 violations`,
  );
  return 0;
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
