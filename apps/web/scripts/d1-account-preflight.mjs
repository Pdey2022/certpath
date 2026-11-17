#!/usr/bin/env node
// Phase 5C account preflight: the read-only assertions that run before any D1
// resource is created. It reads `wrangler whoami --json` and
// `wrangler d1 list --json`, asserts the account and the presence/absence of one
// database, and prints three lines. It never creates, changes or deletes
// anything, never prints whoami output, and never prints a token.
//
// Usage:
//   node apps/web/scripts/d1-account-preflight.mjs
//        --expect-account <account id> --database <name>
//        <--expect-absent|--expect-present>
//
// The expected account id comes only from --expect-account. CLOUDFLARE_ACCOUNT_ID
// is not a source of truth: Wrangler prefers it over its stored selection, so a
// stale value there is reported as account_env_mismatch instead of being used.
//
// Exit codes: 0 both assertions true, 1 assertion failed or the answer was
// unparseable (named code), 2 usage, 4 remote_auth_failed.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CliError,
  assertExpectedAccountEnv,
  checkPreflightAccount,
  checkPreflightDatabase,
  formatPreflightReport,
  isAuthFailure,
  parseDatabaseList,
  parseWhoamiAccounts,
  redactSecrets,
} from "./lib/d1-targets.mjs";

// The account id is the subject of the assertion and is printed on purpose; a
// token is not. Only token-shaped environment values are redacted here.
const SECRET_VALUES = [
  process.env.CLOUDFLARE_API_TOKEN,
  process.env.CLOUDFLARE_API_KEY,
].filter((value) => typeof value === "string" && value !== "");

function usage() {
  return [
    "Usage: node apps/web/scripts/d1-account-preflight.mjs",
    "         --expect-account <account id> --database <name>",
    "         <--expect-absent|--expect-present>",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    expectAccount: null,
    database: null,
    expectPresent: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (
      argument === "--expect-account" ||
      argument === "--database"
    ) {
      const value = argv[index + 1];
      index += 1;
      if (!value) {
        throw new CliError(
          "missing_option_value",
          `${argument} needs a value.\n${usage()}`,
          2,
        );
      }
      if (argument === "--expect-account") options.expectAccount = value;
      if (argument === "--database") options.database = value;
      continue;
    }
    if (argument === "--expect-absent" || argument === "--expect-present") {
      const wanted = argument === "--expect-present";
      if (options.expectPresent !== null && options.expectPresent !== wanted) {
        throw new CliError(
          "conflicting_assertion",
          "--expect-absent and --expect-present are mutually exclusive.\n" +
            usage(),
          2,
        );
      }
      options.expectPresent = wanted;
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

/**
 * A remote read that Wrangler refused for authentication is exit 4; anything
 * else it failed on means no authoritative answer was obtained, which is exit 1
 * with the unparsed code rather than a guess about the account.
 */
function requireWranglerResult(result, label) {
  if (result.status === 0) return result.output;
  if (isAuthFailure(result.output)) {
    throw new CliError(
      "remote_auth_failed",
      `Wrangler was not authenticated for ${label}; nothing was read and nothing was created`,
      4,
    );
  }
  console.error(`Wrangler ${label} failed (exit ${result.status}):`);
  printDiagnostic(result.output);
  throw new CliError(
    "preflight_unparsed",
    `Wrangler ${label} exited ${result.status} without an answer that can be parsed; the assertion did not run`,
    1,
  );
}

/** Pull the JSON value out of Wrangler output that may carry a preamble line. */
function parseWranglerJson(text, label) {
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (start === -1 || end <= start) {
    throw new CliError(
      "preflight_unparsed",
      `Wrangler returned no JSON for ${label}`,
      1,
    );
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new CliError(
      "preflight_unparsed",
      `Cannot parse the ${label} JSON: ${error instanceof Error ? error.message : String(error)}`,
      1,
    );
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!options.expectAccount) {
    throw new CliError(
      "missing_option_value",
      `--expect-account is required.\n${usage()}`,
      2,
    );
  }
  if (!options.database) {
    throw new CliError(
      "missing_option_value",
      `--database is required.\n${usage()}`,
      2,
    );
  }
  if (typeof options.expectPresent !== "boolean") {
    throw new CliError(
      "missing_assertion",
      `Pass exactly one of --expect-absent or --expect-present.\n${usage()}`,
      2,
    );
  }

  // Local check first: an environment id that disagrees with the flag would
  // silently retarget both Wrangler calls below.
  assertExpectedAccountEnv({
    expectAccount: options.expectAccount,
    envAccountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? null,
  });

  const whoamiOutput = requireWranglerResult(
    runWrangler(["whoami", "--json"]),
    "whoami --json",
  );
  const whoami = parseWranglerJson(whoamiOutput, "whoami --json");
  // Validate the shape before the assertion so an unreadable payload is always
  // preflight_unparsed, not account_mismatch.
  parseWhoamiAccounts(whoami);
  const account = checkPreflightAccount({
    whoami,
    expectAccount: options.expectAccount,
  });

  const listOutput = requireWranglerResult(
    runWrangler(["d1", "list", "--json"]),
    "d1 list --json",
  );
  const databases = parseDatabaseList(
    parseWranglerJson(listOutput, "d1 list --json"),
  );
  const database = checkPreflightDatabase({
    databases,
    database: options.database,
    expectPresent: options.expectPresent,
  });

  console.log(formatPreflightReport({ account, database }));
  console.log("preflight ok");
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
