// Local-only operator script: provision the tester staff accounts.
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
// Local Miniflare D1 only: `--remote` is intentionally not implemented. Remote
// provisioning is a separate step that requires owner approval and review.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hashLearnerPassword } from "../src/security/password-hashing.ts";

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

function runSql(statements: string[]): void {
  const result = spawnSync(
    process.execPath,
    [
      findWrangler(),
      "d1",
      "execute",
      "certpath-local",
      "--local",
      "--json",
      "--command",
      statements.join("\n"),
    ],
    {
      cwd: fileURLToPath(new URL("../../web", import.meta.url)),
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    fail((result.stderr || result.stdout || "wrangler failed").trim());
  }
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
if (argv.includes("--remote")) {
  fail("remote provisioning is not implemented; this script only writes the local database");
}

const adminsArg = option(argv, "--admins");
const managerArg = option(argv, "--manager");
if (!adminsArg || !managerArg) {
  fail(
    "usage: provision-staff-accounts.ts --admins <email>,<email> --manager <email> [--certification-slug <slug>] [--certification-name <name>] [--exam-version-key <key>] [--password-stdin]",
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

const emails = [adminEmails[0]!, adminEmails[1]!, managerEmail];
const labels = ["Global Admin 1", "Global Admin 2", "Manager"];

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

const now = Date.now();
const examVersionTitle = `${certificationName} ${examVersionKey}`
  .trim()
  .slice(0, 160);
const rows = {
  userIds: [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()],
  certificationId: crypto.randomUUID(),
  examVersionId: crypto.randomUUID(),
};

const existing = runSqlCheck(
  `SELECT email_normalized FROM staff_password_credentials
   WHERE email_normalized IN (${emails.map((email) => `'${email}'`).join(", ")});
   SELECT id FROM certifications WHERE slug = '${certificationSlug}';`,
);
if (existing > 0) {
  fail(
    "a staff account or the synthetic certification already exists; nothing was written",
  );
}

const hashes: string[] = [];
for (const [index, password] of passwords.entries()) {
  console.error(`hashing ${labels[index]} credential…`);
  hashes.push(await hashLearnerPassword(password));
}

const operationId = (prefix: string) => `staff-provision:${prefix}:${crypto.randomUUID()}`;
const statements = [
  `INSERT INTO users (id, status, created_at, updated_at) VALUES
     ('${rows.userIds[0]}', 'active', ${now}, ${now}),
     ('${rows.userIds[1]}', 'active', ${now}, ${now}),
     ('${rows.userIds[2]}', 'active', ${now}, ${now});`,
  `INSERT INTO staff_roles (
     user_id, role, active, changed_by_user_id, changed_by_ref, operation_id,
     reason, changed_at
   ) VALUES
     ('${rows.userIds[0]}', 'global_admin', 1, NULL, 'owner-provisioning-script', '${operationId("admin-one-role")}', 'Tester Global Admin', ${now}),
     ('${rows.userIds[1]}', 'global_admin', 1, NULL, 'owner-provisioning-script', '${operationId("admin-two-role")}', 'Tester Global Admin', ${now}),
     ('${rows.userIds[2]}', 'manager', 1, NULL, 'owner-provisioning-script', '${operationId("manager-role")}', 'Tester Manager', ${now});`,
  `INSERT INTO certifications (
     id, slug, display_name, created_by_user_id, created_operation_id, created_at
   ) VALUES (
     '${rows.certificationId}', '${certificationSlug}', '${certificationName}',
     '${rows.userIds[0]}', '${operationId("certification")}', ${now}
   );`,
  `INSERT INTO exam_versions (
     id, certification_id, version_key, title, syllabus_reference,
     effective_from, effective_until, created_by_user_id, created_operation_id,
     creation_reason, created_at
   ) VALUES (
     '${rows.examVersionId}', '${rows.certificationId}', '${examVersionKey}',
     '${examVersionTitle}', 'Synthetic tester syllabus',
     NULL, NULL, '${rows.userIds[0]}', '${operationId("exam-version")}',
     'Synthetic exam for tester access', ${now}
   );`,
  `INSERT INTO manager_certification_assignments (
     manager_user_id, certification_id, active, changed_by_user_id,
     operation_id, reason, changed_at
   ) VALUES (
     '${rows.userIds[2]}', '${rows.certificationId}', 1, '${rows.userIds[0]}',
     '${operationId("manager-assignment")}', 'Tester scoped to the synthetic exam', ${now}
   );`,
  `INSERT INTO staff_password_credentials (
     user_id, email, email_normalized, password_hash, created_at, updated_at
   ) VALUES
     ('${rows.userIds[0]}', '${emails[0]}', '${emails[0]}', '${hashes[0]}', ${now}, ${now}),
     ('${rows.userIds[1]}', '${emails[1]}', '${emails[1]}', '${hashes[1]}', ${now}, ${now}),
     ('${rows.userIds[2]}', '${emails[2]}', '${emails[2]}', '${hashes[2]}', ${now}, ${now});`,
  `INSERT INTO audit_events (
     operation_id, actor_user_id, actor_ref, action, subject_type, subject_id,
     certification_id, reason, occurred_at
   ) VALUES
     ('${operationId("audit-admin-one")}', NULL, 'owner-provisioning-script', 'staff_provisioned', 'user', '${rows.userIds[0]}', NULL, 'Tester Global Admin provisioned', ${now}),
     ('${operationId("audit-admin-two")}', NULL, 'owner-provisioning-script', 'staff_provisioned', 'user', '${rows.userIds[1]}', NULL, 'Tester Global Admin provisioned', ${now}),
     ('${operationId("audit-manager")}', NULL, 'owner-provisioning-script', 'staff_provisioned', 'user', '${rows.userIds[2]}', '${rows.certificationId}', 'Tester Manager provisioned for one synthetic exam', ${now});`,
];

runSql(statements);
const written = runSqlCheck(
  `SELECT COUNT(*) AS count FROM staff_password_credentials;
   SELECT COUNT(*) AS count FROM staff_roles WHERE active = 1;
   SELECT COUNT(*) AS count FROM manager_certification_assignments WHERE active = 1;`,
);
if (written < 3) fail("the provisioning write could not be confirmed");

console.log("Provisioned the tester staff accounts.");
console.log(`Global Admin 1: ${emails[0]} (${rows.userIds[0]})`);
console.log(`Global Admin 2: ${emails[1]} (${rows.userIds[1]})`);
console.log(`Manager:        ${emails[2]} (${rows.userIds[2]})`);
console.log(`Synthetic exam: ${certificationSlug} (${rows.certificationId}), version ${examVersionKey} (${rows.examVersionId})`);
console.log(
  "Passwords were hashed in this process and were not printed. Store them in your password manager now; they cannot be recovered.",
);

function runSqlCheck(sql: string): number {
  const result = spawnSync(
    process.execPath,
    [
      findWrangler(),
      "d1",
      "execute",
      "certpath-local",
      "--local",
      "--json",
      "--command",
      sql,
    ],
    {
      cwd: fileURLToPath(new URL("../../web", import.meta.url)),
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    fail((result.stderr || result.stdout || "wrangler failed").trim());
  }
  const start = result.stdout.indexOf("[");
  if (start === -1) fail("wrangler did not return JSON output");
  const parsed = JSON.parse(result.stdout.slice(start));
  return parsed.reduce(
    (total: number, entry: { results?: unknown[] }) =>
      total + (entry.results?.length ?? 0),
    0,
  );
}
