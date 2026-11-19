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
import { CliError } from "./d1-targets.mjs";

export const PILOT_WORKER_NAME = "certpath-pilot";
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
