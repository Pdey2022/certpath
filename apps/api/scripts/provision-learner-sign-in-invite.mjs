// Local-only operator helper: pre-provision one invite for email-link sign-in.
//
// Nothing here can reach a deployed database: only `--local` is ever passed to
// Wrangler, so the target is the local Miniflare D1 file.
//
//   node apps/api/scripts/provision-learner-sign-in-invite.mjs --email learner@example.test
//   node apps/api/scripts/provision-learner-sign-in-invite.mjs --email learner@example.test --user-id <uuid>
//   node apps/api/scripts/provision-learner-sign-in-invite.mjs --email learner@example.test --revoke

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const emailPattern = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

const argv = process.argv.slice(2);
const revoke = argv.includes("--revoke");
const rawEmail = readOption(argv, "--email");
const rawUserId = readOption(argv, "--user-id");

if (!rawEmail) {
  fail(
    "usage: provision-learner-sign-in-invite.mjs --email <address> [--user-id <uuid>] [--revoke]",
  );
}
if (!emailPattern.test(rawEmail) || rawEmail.length > 254) {
  fail("--email must be a plain email address");
}
if (rawUserId !== undefined && !uuidPattern.test(rawUserId)) {
  fail("--user-id must be a UUID");
}

const email = rawEmail.trim().toLowerCase();
const now = Date.now();

if (!email.endsWith("@example.test")) {
  console.warn(
    "warning: the local test inbox only serves @example.test addresses, so this address cannot receive a link locally",
  );
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
  throw new Error("Cannot find wrangler; run npm install first");
}

function runSql(statements) {
  const wrangler = findWrangler();
  const result = spawnSync(
    process.execPath,
    [
      wrangler,
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
  const start = result.stdout.indexOf("[");
  if (start === -1) fail("wrangler did not return JSON output");
  const parsed = JSON.parse(result.stdout.slice(start));
  return parsed.flatMap((entry) => entry.results ?? []);
}

if (revoke) {
  const revoked = runSql([
    `UPDATE learner_email_sign_in_invites
     SET revoked_at = ${now}
     WHERE email_normalized = '${email}' AND revoked_at IS NULL
     RETURNING email_normalized;`,
  ]);
  if (revoked.length === 0) {
    fail(`no active invite for ${email}`);
  }
  console.log(`Revoked the sign-in invite for ${email}.`);
  process.exit(0);
}

const sql = [];
let userId = rawUserId;

if (userId === undefined) {
  userId = crypto.randomUUID();
  sql.push(
    `INSERT INTO users (id, status, created_at, updated_at)
     SELECT '${userId}', 'active', ${now}, ${now}
     WHERE NOT EXISTS (
       SELECT 1 FROM learner_email_sign_in_invites
       WHERE email_normalized = '${email}'
     )
     RETURNING id;`,
  );
}

sql.push(
  `INSERT INTO learner_email_sign_in_invites (
     email_normalized, user_id, created_at, revoked_at
   )
   SELECT '${email}', u.id, ${now}, NULL
   FROM users AS u
   WHERE u.id = '${userId}'
     AND u.status = 'active'
     AND NOT EXISTS (
       SELECT 1 FROM learner_email_sign_in_invites AS i
       WHERE i.user_id = u.id AND i.email_normalized <> '${email}'
     )
     AND NOT EXISTS (
       SELECT 1 FROM learner_password_credentials AS c
       WHERE c.email_normalized = '${email}'
     )
   ON CONFLICT(email_normalized) DO UPDATE SET revoked_at = NULL
   WHERE revoked_at IS NOT NULL
   RETURNING user_id;`,
);

const created = runSql(sql);
if (created.length === 0) {
  fail(
    `no invite was created for ${email}; it may already be active, the account may be missing, inactive, or already hold another invite. Pass --user-id <uuid> to re-provision a revoked invite.`,
  );
}

console.log(`Provisioned the email sign-in invite for ${email}.`);
console.log(`User: ${userId}`);
console.log(
  "Next: set LOCAL_LEARNER_EMAIL_LINK_ENABLED=true and LOCAL_TEST_MAIL_ENABLED=true in apps/web/.dev.vars, then request a link from /sign-in and open /local-inbox.",
);
