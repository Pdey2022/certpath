// Continuous deployment schema gate. Staging D1 is at 22 applied migrations
// while `main` carries 23, so a deploy must never run ahead of its schema and
// must never apply a migration on its own: a pending migration stops the
// deploy and says which file stopped it.
//
// Nothing here touches the network, the file system or the environment. The
// CLI (../migration-gate.mjs) runs `wrangler d1 migrations list --remote` and
// reads `db/migrations/`; the rules below can be tested without an account.
import { CliError } from "./d1-targets.mjs";

// `wrangler d1 migrations list` prints this exact line when the database holds
// every migration its migrations_dir offers, and otherwise prints a one-column
// table of the unapplied names. Both shapes are handled; anything else is a
// refusal, because "I cannot tell" must never become "go ahead".
const NO_MIGRATIONS = /No migrations to apply!/;

// The naming rule `db:chain` enforces. A pending name that does not match it is
// not a migration this repository could have shipped.
const MIGRATION_NAME = /^[0-9]{4}_[A-Za-z0-9_]+\.sql$/;

// Wrangler may colour the table when it thinks it is talking to a terminal.
const ANSI = /\x1b\[[0-9;]*m/g;

/** What each mode does when something is pending. Both refuse to deploy. */
export const GATE_MODES = Object.freeze(["skip", "abort"]);

/**
 * Exit codes are the workflow's contract:
 *   0 nothing pending, deploy
 *   3 pending, deploy skipped (staging: a deliberate, visible skip)
 *   4 pending, deploy aborted (production: a human is watching, so fail)
 *   1 refusal (unknown state), 2 usage.
 */
export const EXIT_NOTHING_PENDING = 0;
export const EXIT_PENDING_SKIPPED = 3;
export const EXIT_PENDING_ABORTED = 4;

/**
 * Read the pending list from `wrangler d1 migrations list` output.
 *
 * Only table cells are read, so the banner ("Migrations to be applied:",
 * "Resource location: remote") cannot be mistaken for a name. A contradictory
 * output — the clean line *and* a pending row — is refused rather than
 * resolved in either direction.
 */
export function parseMigrationsList(output) {
  const text = (typeof output === "string" ? output : "").replace(ANSI, "");
  const pending = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("│")) continue;
    for (const cell of trimmed.split("│")) {
      const name = cell.trim();
      if (MIGRATION_NAME.test(name) && !pending.includes(name)) {
        pending.push(name);
      }
    }
  }

  const clean = NO_MIGRATIONS.test(text);
  if (pending.length > 0 && clean) {
    throw new CliError(
      "migrations_list_ambiguous",
      "Wrangler printed both \"No migrations to apply!\" and a pending migration table; the state of the database cannot be determined, so nothing is deployed",
      1,
    );
  }
  if (pending.length === 0 && !clean) {
    throw new CliError(
      "migrations_list_unparsed",
      "Wrangler neither reported \"No migrations to apply!\" nor listed a pending migration; the gate cannot tell whether the schema matches this commit, so nothing is deployed",
      1,
    );
  }
  return { pending, clean };
}

/**
 * Decide what the deploy job does. `available` is `db/migrations/*.sql` from
 * this commit; a pending name that is not in it means the database wants a
 * migration this commit does not carry, and deploying that code would run
 * against a schema nothing describes.
 */
export function planMigrationGate({ pending, available, mode }) {
  if (!GATE_MODES.includes(mode)) {
    throw new CliError(
      "gate_mode_unknown",
      `The gate mode must be one of ${GATE_MODES.join(", ")}, not ${JSON.stringify(mode)}`,
      2,
    );
  }
  if (!Array.isArray(available) || available.length === 0) {
    throw new CliError(
      "migrations_dir_empty",
      "No .sql migration was found under db/migrations; a gate that compares against nothing would pass everything",
      1,
    );
  }
  const known = new Set(available);
  const unknown = pending.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new CliError(
      "migration_not_in_repo",
      `The database has ${unknown.join(", ")} pending but this commit does not carry ${unknown.length === 1 ? "it" : "them"} under db/migrations; refusing to guess which revision the schema belongs to`,
      1,
    );
  }
  if (pending.length === 0) {
    return { action: "deploy", pending: [] };
  }
  return {
    action: mode === "skip" ? "skip" : "abort",
    pending: [...pending],
  };
}

/**
 * The annotation and job-summary text. Kept beside the rules so the skip is
 * named the same way in the log, the annotation and the summary.
 */
export function describeMigrationGate({ action, pending, database }) {
  const names = pending.join(", ");
  const count = `${pending.length} migration${pending.length === 1 ? "" : "s"}`;
  if (action === "skip") {
    return {
      notice: `::notice title=Staging deploy skipped::${database} has ${count} pending (${names}); the Worker was not deployed and no migration was applied`,
      summary: [
        `## Staging deploy skipped`,
        "",
        `\`${database}\` has ${count} pending, so the staging Worker was **not** deployed.`,
        "",
        "| Pending migration |",
        "| --- |",
        ...pending.map((name) => `| \`${name}\` |`),
        "",
        "This workflow never applies a migration. Apply the pending file deliberately",
        "(owner-approved, by hand) and merge again, or revert the commit that added it.",
        "",
      ].join("\n"),
    };
  }
  if (action === "abort") {
    return {
      notice: `::error title=Production deploy aborted::${database} has ${count} pending (${names}); nothing was deployed and no migration was applied`,
      summary: [
        `## Production deploy aborted`,
        "",
        `\`${database}\` has ${count} pending, so nothing was deployed.`,
        "",
        "| Pending migration |",
        "| --- |",
        ...pending.map((name) => `| \`${name}\` |`),
        "",
        "Apply the pending file deliberately (owner-approved, by hand) and dispatch again.",
        "This workflow never applies a migration.",
        "",
      ].join("\n"),
    };
  }
  return {
    notice: `::notice title=Schema gate clear::${database} has no pending migration`,
    summary: [
      `## Schema gate clear`,
      "",
      `\`${database}\` has no pending migration.`,
      "",
    ].join("\n"),
  };
}

/** Exit code for the planned action; the workflow reads 3 as `deploy=false`. */
export function exitCodeForAction(action) {
  if (action === "deploy") return EXIT_NOTHING_PENDING;
  if (action === "skip") return EXIT_PENDING_SKIPPED;
  if (action === "abort") return EXIT_PENDING_ABORTED;
  throw new CliError(
    "gate_action_unknown",
    `Unknown gate action ${JSON.stringify(action)}`,
    1,
  );
}
