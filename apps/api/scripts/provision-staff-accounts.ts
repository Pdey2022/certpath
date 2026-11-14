// Operator script: provision the tester staff accounts.
//
// Creates exactly two individual Global Admins and one Manager scoped to one
// synthetic certification, each with its own password. Passwords are read
// privately from a terminal (or from stdin for automation), hashed in this Node
// process, and never printed, logged, or written outside the D1 database.
//
//   npx tsx apps/api/scripts/provision-staff-accounts.ts \
//     --admins owner@example.test,deputy@example.test \
//     --manager editor@example.test
//
// Local Miniflare D1 by default. Remote writes are opt-in and pinned:
//
//   npx tsx apps/api/scripts/provision-staff-accounts.ts \
//     --admins owner@example.test,deputy@example.test \
//     --manager editor@example.test \
//     --remote --expect-database-id <recorded certpath-admin UUID>
//
// Remote mode resolves `certpath-admin` by name exactly once. The verified UUID
// is written into a run-only Wrangler config as a binding, and every later read
// and write addresses that binding - so a database swapped behind the name after
// preflight receives nothing. The script refuses to continue unless the CLI is
// authenticated to the Certpath account and the name resolves to that exact UUID,
// and it refuses if any tester account or the synthetic certification exists.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashLearnerPassword } from "../src/security/password-hashing.ts";
import {
  ProvisioningAbort,
  applyProvisioning,
  assertNoExistingTesterRows,
  assertRemoteTarget,
  certpathAccountId,
  confirmProvisioning,
  pinRemoteTarget,
  pinnedDatabaseBinding,
  remoteStaffDatabaseName,
  selectProvisioningTarget,
  type ProvisioningIdentifiers,
  type ProvisioningTarget,
  type WranglerRunner,
} from "../src/staff-provisioning.ts";

const emailPattern = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const keyPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const minimumPasswordLength = 16;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function readSecret(promptText: string): Promise<string> {
  if (!process.stdin.isTTY) {
    fail("a terminal is required to enter passwords privately");
  }
  return new Promise((resolve) => {
    process.stdout.write(promptText);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    let value = "";
    const finish = (read: string) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(read);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish("");
          process.exit(130);
        }
        if (character === "\r" || character === "\n") {
          finish(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function readPasswordsFromStdin(): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  const lines = chunks.join("").split(/\r?\n/).filter(Boolean);
  if (lines.length !== 3) {
    fail("--password-stdin expects exactly three lines: admin one, admin two, manager");
  }
  return lines;
}

function findWrangler(): string {
  const candidates = [
    new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
    new URL("../../../node_modules/wrangler/bin/wrangler.js", import.meta.url),
  ];
  for (const candidate of candidates) {
    const file = fileURLToPath(candidate);
    if (existsSync(file)) return file;
  }
  throw new Error("Cannot find wrangler; run npm install first");
}

function createRunner(): WranglerRunner {
  const cwd = fileURLToPath(new URL("../../web", import.meta.url));
  return (args) => {
    const result = spawnSync(process.execPath, [findWrangler(), ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: certpathAccountId },
    });
    if (result.status !== 0) {
      throw new ProvisioningAbort(
        "wrangler-failed",
        (result.stderr || result.stdout || "wrangler failed").trim(),
      );
    }
    return result.stdout;
  };
}

/**
 * Writes the verified UUID into a run-only Wrangler config and reads it back.
 * Remote reads and writes address this binding, never the database name.
 */
function createPinnedConfig(databaseId: string): string {
  const configPath = join(
    tmpdir(),
    `certpath-staff-provisioning-${process.pid}-${Date.now()}.jsonc`,
  );
  const config = {
    name: "certpath-staff-provisioning",
    compatibility_date: "2026-11-10",
    d1_databases: [
      {
        binding: pinnedDatabaseBinding,
        database_name: remoteStaffDatabaseName,
        database_id: databaseId,
      },
    ],
  };
  try {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const written = JSON.parse(readFileSync(configPath, "utf8")) as {
      d1_databases?: { database_id?: unknown }[];
    };
    const pinned = written.d1_databases?.[0]?.database_id;
    if (typeof pinned !== "string" || pinned.toLowerCase() !== databaseId) {
      throw new ProvisioningAbort(
        "missing-database-id",
        "the pinned config does not carry the verified database UUID; nothing was written",
      );
    }
  } catch (error) {
    rmSync(configPath, { force: true });
    throw error instanceof ProvisioningAbort
      ? error
      : new ProvisioningAbort(
          "missing-pinned-config",
          `could not write the pinned database config: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
  }
  return configPath;
}

function validatePassword(
  password: string,
  label: string,
  email: string,
  others: string[],
): void {
  if (password.length < minimumPasswordLength) {
    fail(`${label}: use at least ${minimumPasswordLength} characters`);
  }
  if (password.length > 1024) fail(`${label}: use at most 1024 characters`);
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) =>
    pattern.test(password),
  ).length;
  if (classes < 3) {
    fail(`${label}: mix at least three of lower case, upper case, digits, symbols`);
  }
  if (password.toLowerCase().includes(email.split("@")[0] ?? "")) {
    fail(`${label}: do not reuse the account name inside the password`);
  }
  if (others.includes(password)) {
    fail(`${label}: each account needs a unique password`);
  }
}

const argv = process.argv.slice(2);
const selection = (() => {
  try {
    return selectProvisioningTarget(argv);
  } catch (error) {
    fail(error instanceof ProvisioningAbort ? error.message : String(error));
  }
})();

const adminsArg = option(argv, "--admins");
const managerArg = option(argv, "--manager");
if (!adminsArg || !managerArg) {
  fail(
    "usage: provision-staff-accounts.ts --admins <email>,<email> --manager <email> [--certification-slug <slug>] [--certification-name <name>] [--exam-version-key <key>] [--password-stdin] [--remote --expect-database-id <uuid>]",
  );
}

const adminEmails = adminsArg.split(",").map(normalizeEmail);
if (adminEmails.length !== 2 || new Set(adminEmails).size !== 2) {
  fail("--admins requires exactly two different email addresses");
}
const managerEmail = normalizeEmail(managerArg);
if (adminEmails.includes(managerEmail)) {
  fail("--manager must be a different person from both Global Admins");
}
for (const email of [...adminEmails, managerEmail]) {
  if (!emailPattern.test(email) || email.length > 254) {
    fail(`"${email}" is not a plain email address`);
  }
}

const certificationSlug = option(argv, "--certification-slug") ?? "synthetic-pilot";
const certificationName =
  option(argv, "--certification-name") ?? "Synthetic pilot certification";
const examVersionKey = option(argv, "--exam-version-key") ?? "v1";
if (!slugPattern.test(certificationSlug)) fail("--certification-slug is invalid");
if (!keyPattern.test(examVersionKey)) fail("--exam-version-key is invalid");
if (certificationName.trim().length === 0 || certificationName.length > 160) {
  fail("--certification-name must be 1-160 characters");
}

const emails: [string, string, string] = [
  adminEmails[0]!,
  adminEmails[1]!,
  managerEmail,
];
const labels = ["Global Admin 1", "Global Admin 2", "Manager"];
const run = createRunner();
let pinnedConfigPath: string | null = null;

async function main(): Promise<void> {
  let target: ProvisioningTarget = selection;
  try {
    if (selection.kind === "remote") {
      await assertRemoteTarget(run, selection.expectedDatabaseId);
      pinnedConfigPath = createPinnedConfig(selection.expectedDatabaseId);
      target = pinRemoteTarget(selection, pinnedConfigPath);
      console.error(
        `remote target pinned: ${remoteStaffDatabaseName} (${selection.expectedDatabaseId})`,
      );
    }
    await assertNoExistingTesterRows(run, target, { emails, certificationSlug });
  } catch (error) {
    fail(error instanceof ProvisioningAbort ? error.message : String(error));
  }

  let passwords: string[];
  if (argv.includes("--password-stdin")) {
    passwords = await readPasswordsFromStdin();
  } else {
    passwords = [];
    for (const [index, label] of labels.entries()) {
      const password = await readSecret(`${label} (${emails[index]}), password: `);
      const confirmation = await readSecret(`${label}, repeat password: `);
      if (password !== confirmation) fail(`${label}: the passwords did not match`);
      passwords.push(password);
    }
  }
  for (const [index, label] of labels.entries()) {
    validatePassword(
      passwords[index]!,
      label,
      emails[index]!,
      passwords.filter((_, other) => other !== index),
    );
  }

  const hashes: string[] = [];
  for (const [index, password] of passwords.entries()) {
    console.error(`hashing ${labels[index]} credential…`);
    hashes.push(await hashLearnerPassword(password));
  }

  const identifiers: ProvisioningIdentifiers = {
    emails,
    userIds: [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()],
    certificationId: crypto.randomUUID(),
    examVersionId: crypto.randomUUID(),
    certificationSlug,
    certificationName,
    examVersionKey,
    hashes: [hashes[0]!, hashes[1]!, hashes[2]!],
    now: Date.now(),
  };

  try {
    await applyProvisioning(run, target, identifiers);
    await confirmProvisioning(run, target, identifiers);
  } catch (error) {
    fail(error instanceof ProvisioningAbort ? error.message : String(error));
  }

  console.log(
    `Provisioned the tester staff accounts in ${target.kind === "remote" ? `${remoteStaffDatabaseName} (pinned ${target.expectedDatabaseId})` : `${target.databaseName} (local)`}.`,
  );
  console.log(`Global Admin 1: ${emails[0]} (${identifiers.userIds[0]})`);
  console.log(`Global Admin 2: ${emails[1]} (${identifiers.userIds[1]})`);
  console.log(`Manager:        ${emails[2]} (${identifiers.userIds[2]})`);
  console.log(
    `Synthetic exam: ${certificationSlug} (${identifiers.certificationId}), version ${examVersionKey} (${identifiers.examVersionId})`,
  );
  console.log(
    "Passwords were hashed in this process and were not printed. Store them in your password manager now; they cannot be recovered.",
  );
}

try {
  await main();
} finally {
  if (pinnedConfigPath) rmSync(pinnedConfigPath, { force: true });
}
