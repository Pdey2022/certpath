#!/usr/bin/env node
// Stamps the deployed commit into the generated Wrangler config the publish
// jobs deploy, so a running Worker can be matched to the commit that built it.
//
// The stamp is a Worker var named DEPLOYED_COMMIT, added at deploy time rather
// than committed in wrangler.*.jsonc: a committed value would describe one
// commit forever, and the public `/api/health` response is deliberately not
// widened to report it (the Worker may read the var; no route exposes it).
//
// Usage:
//   node apps/web/scripts/stamp-deployed-commit.mjs <generated config>
//        [--commit <short sha>]
//
// `--commit` defaults to $DEPLOYED_COMMIT. Exit codes: 0 stamped, 1 refusal,
// 2 usage.
import { readFileSync, writeFileSync } from "node:fs";
import { CliError } from "./lib/d1-targets.mjs";

// A short (7-12) or full (40) git commit, nothing else. The value becomes a
// Worker var, so a mistyped CI variable is refused instead of shipped — and a
// Cloudflare account id is exactly 32 hex characters, which is why the middle
// of the range is not accepted: it would let an account id through as a commit.
const SHORT_COMMIT = /^[0-9a-f]{7,12}$/;
const FULL_COMMIT = /^[0-9a-f]{40}$/;

function usage() {
  return [
    "Usage: node apps/web/scripts/stamp-deployed-commit.mjs <generated config>",
    "         [--commit <short sha>]",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { file: null, commit: process.env.DEPLOYED_COMMIT ?? null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--commit") {
      const value = argv[index + 1];
      index += 1;
      if (!value || value.startsWith("--")) {
        throw new CliError(
          "missing_option_value",
          `--commit needs a value.\n${usage()}`,
          2,
        );
      }
      options.commit = value;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new CliError(
        "unknown_argument",
        `Unknown argument ${JSON.stringify(argument)}.\n${usage()}`,
        2,
      );
    }
    if (options.file) {
      throw new CliError(
        "unexpected_argument",
        `Only one config path is accepted; got ${JSON.stringify(argument)}.\n${usage()}`,
        2,
      );
    }
    options.file = argument;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!options.file) {
    throw new CliError("missing_argument", usage(), 2);
  }
  const commit = typeof options.commit === "string" ? options.commit.trim() : "";
  if (!SHORT_COMMIT.test(commit) && !FULL_COMMIT.test(commit)) {
    throw new CliError(
      "commit_invalid",
      `DEPLOYED_COMMIT must be a 7-12 character short commit or a full 40-character commit, not ${JSON.stringify(commit)}; the value becomes a Worker var, and a Cloudflare account id (32 characters) is not a commit`,
      1,
    );
  }

  let config;
  try {
    config = JSON.parse(readFileSync(options.file, "utf8"));
  } catch (error) {
    throw new CliError(
      "config_unreadable",
      `Cannot read ${options.file}: ${error instanceof Error ? error.message : String(error)}; run the target's build first`,
      1,
    );
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new CliError(
      "config_unparsed",
      `${options.file} is not a JSON object, so it is not a generated Wrangler config`,
      1,
    );
  }
  if (typeof config.name !== "string" || config.name === "") {
    throw new CliError(
      "config_unparsed",
      `${options.file} names no Worker; stamping an unnamed artefact would not prove what was deployed`,
      1,
    );
  }

  config.vars = { ...(config.vars ?? {}), DEPLOYED_COMMIT: commit };
  writeFileSync(options.file, JSON.stringify(config));
  console.log(
    `Stamped DEPLOYED_COMMIT=${commit} on ${config.name} (${options.file})`,
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
