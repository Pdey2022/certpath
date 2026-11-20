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
import { CliError, DEPLOYED_COMMIT_PATTERN } from "./lib/d1-targets.mjs";

// The shape rule is shared with the deploy guards (`DEPLOYED_COMMIT_PATTERN`),
// so tightening it here also tightens what they accept. This writer adds one
// refusal of its own, because it is the only thing that writes the var: a
// Cloudflare account id is exactly 32 hex characters and matches the shared
// pattern, so it is refused by length as well as by shape.
const ACCOUNT_ID_LENGTH = 32;

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
  if (
    !DEPLOYED_COMMIT_PATTERN.test(commit) ||
    commit.length === ACCOUNT_ID_LENGTH
  ) {
    throw new CliError(
      "commit_invalid",
      `DEPLOYED_COMMIT must be a 7-40 character commit and must not be a 32-character Cloudflare account id, not ${JSON.stringify(commit)}; the value becomes a Worker var`,
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
