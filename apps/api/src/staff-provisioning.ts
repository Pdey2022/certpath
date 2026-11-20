// Shared planning and guard logic for the staff provisioning script.
//
// Kept free of Node builtins so the operator script and the tests run the same
// code: the tests execute it under workerd against an isolated D1 database with
// a mocked Cloudflare CLI.
//
// Remote safety model:
//   1. The operator names the database and its recorded UUID together, and both
//      must match one entry of `approvedRemoteDatabases`.
//   2. Preflight resolves that name once and re-checks the UUID it resolves to.
//   3. That UUID is written into a run-only Wrangler config as a binding.
//   4. Every later read and write addresses the binding, never the name, so a
//      database swapped behind the name after preflight receives nothing.

import {
  createEnrolmentTicket,
  enrolmentTicketLifetimeMs,
  sha256Hex,
} from "./security/totp.ts";

export const certpathAccountId = "ef67137c4d1556f7f51f1cb3f1f420f3";
export const localStaffDatabaseName = "certpath-local";
export const pinnedDatabaseBinding = "STAFF_PROVISIONING_DB";

/** A remote database this script may address, with its recorded UUID. */
export interface ApprovedRemoteDatabase {
  readonly name: string;
  readonly databaseId: string;
}

/**
 * The only databases a remote run may write to. The 5C posture is one database,
 * `certpath-learner-staging` (#134); a production database is not provisioned,
 * so it is not here. Naming a database is never enough on its own: the operator
 * must also pass the UUID recorded for that name, and both must agree.
 */
export const approvedRemoteDatabases: readonly ApprovedRemoteDatabase[] = [
  {
    name: "certpath-learner-staging",
    databaseId: "c52e398f-4280-40a6-8244-854186dc6ef2",
  },
];

/**
 * Names that appeared in an approved plan but were never provisioned. They are
 * refused with their own code, so an operator who types one is told why rather
 * than reading a generic "unapproved".
 */
export const unprovisionedRemoteDatabases: readonly string[] = [
  "certpath-admin",
];

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ProvisioningAbort extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProvisioningAbort";
    this.code = code;
  }
}

export type WranglerRunner = (args: string[]) => string | Promise<string>;

/** What the operator asked for, before the pinned config exists. */
export type ProvisioningSelection =
  | { kind: "local"; databaseName: string }
  | { kind: "remote"; databaseName: string; expectedDatabaseId: string };

/** Where reads and writes actually go. Remote targets are UUID-pinned. */
export type ProvisioningTarget =
  | { kind: "local"; databaseName: string }
  | {
      kind: "remote";
      databaseName: string;
      expectedDatabaseId: string;
      bindingName: string;
      configPath: string;
    };

export type ProvisioningIdentifiers = {
  emails: [string, string, string];
  userIds: [string, string, string];
  certificationId: string;
  examVersionId: string;
  certificationSlug: string;
  certificationName: string;
  examVersionKey: string;
  hashes: [string, string, string];
  /**
   * One 5F enrolment ticket per account: the printed half of "a password alone
   * cannot create a second factor". Only the digest is written to D1; the token
   * is printed once and never stored.
   */
  enrolmentTickets: [ProvisioningTicket, ProvisioningTicket, ProvisioningTicket];
  now: number;
};

export interface ProvisioningTicket {
  token: string;
  digest: string;
}

/** 256-bit tickets, digests ready for the SQL. Runs in Node and in workerd. */
export async function createProvisioningTickets(): Promise<
  [ProvisioningTicket, ProvisioningTicket, ProvisioningTicket]
> {
  const tokens: [string, string, string] = [
    createEnrolmentTicket(),
    createEnrolmentTicket(),
    createEnrolmentTicket(),
  ];
  const digests = await Promise.all(tokens.map((token) => sha256Hex(token)));
  return [
    { token: tokens[0], digest: digests[0]! },
    { token: tokens[1], digest: digests[1]! },
    { token: tokens[2], digest: digests[2]! },
  ];
}

/**
 * Resolves an operator-supplied name/UUID pair against the allowlist. Fail
 * closed: an unapproved name, a name that was never provisioned, a value that is
 * not a UUID, and a UUID recorded for a different database each abort with their
 * own code, before the CLI is spawned. Returns the allowlist's own copy, so the
 * caller can never carry a name and a UUID that disagree.
 */
export function resolveRemoteDatabase(
  name: string,
  databaseId: string,
): ApprovedRemoteDatabase {
  const approved = approvedRemoteDatabases.find(
    (database) => database.name === name,
  );
  if (!approved) {
    if (unprovisionedRemoteDatabases.includes(name)) {
      throw new ProvisioningAbort(
        "database-not-provisioned",
        `${name} was a proposed target that was never provisioned; the approved remote targets are ${approvedRemoteDatabases
          .map((database) => database.name)
          .join(", ")}; nothing was written`,
      );
    }
    throw new ProvisioningAbort(
      "unapproved-database",
      `${name || "(no name)"} is not an approved remote target; nothing was written`,
    );
  }
  const normalized = databaseId.trim().toLowerCase();
  if (!uuidPattern.test(normalized)) {
    throw new ProvisioningAbort(
      "invalid-database-id",
      `--expect-database-id must be a lowercase UUID recorded for ${approved.name}`,
    );
  }
  if (normalized !== approved.databaseId) {
    throw new ProvisioningAbort(
      "database-id-mismatch",
      `${approved.name} is recorded as ${approved.databaseId}, saw ${normalized}; nothing was written`,
    );
  }
  return approved;
}

/**
 * Remote writes are opt-in: `--remote` must name an approved database with
 * `--database` **and** its recorded UUID with `--expect-database-id`. A name
 * alone, a UUID alone, or a pair that does not match is refused. The local
 * database keeps its existing default.
 */
export function selectProvisioningTarget(
  argv: string[],
): ProvisioningSelection {
  const remote = argv.includes("--remote");
  const nameIndex = argv.indexOf("--database");
  const name = nameIndex === -1 ? undefined : argv[nameIndex + 1];
  if (nameIndex !== -1 && (!name || name.startsWith("--"))) {
    throw new ProvisioningAbort(
      "missing-database-name",
      "--database requires the recorded name of the target database",
    );
  }
  const idIndex = argv.indexOf("--expect-database-id");
  const expected = idIndex === -1 ? undefined : argv[idIndex + 1];
  if (idIndex !== -1 && (!expected || expected.startsWith("--"))) {
    throw new ProvisioningAbort(
      "missing-database-id",
      "--expect-database-id requires the UUID recorded for --database",
    );
  }
  if (!remote) {
    if (expected) {
      throw new ProvisioningAbort(
        "unexpected-database-id",
        "--expect-database-id only applies to --remote provisioning",
      );
    }
    if (name) {
      throw new ProvisioningAbort(
        "unexpected-database-name",
        "--database only applies to --remote provisioning",
      );
    }
    return { kind: "local", databaseName: localStaffDatabaseName };
  }
  if (!name) {
    throw new ProvisioningAbort(
      "missing-database-name",
      "--remote requires --database <recorded database name> together with --expect-database-id <recorded database UUID>",
    );
  }
  if (!expected) {
    throw new ProvisioningAbort(
      "missing-database-id",
      "--remote requires --expect-database-id <UUID recorded for --database>; a name on its own is not a target",
    );
  }
  const approved = resolveRemoteDatabase(name, expected);
  return {
    kind: "remote",
    databaseName: approved.name,
    expectedDatabaseId: approved.databaseId,
  };
}

/**
 * Builds the pinned execution target. The verified UUID is the only address
 * used from here on; the database name is never resolved again.
 */
export function pinRemoteTarget(
  selection: ProvisioningSelection,
  configPath: string,
): ProvisioningTarget {
  if (selection.kind === "local") return selection;
  if (!selection.expectedDatabaseId) {
    throw new ProvisioningAbort(
      "missing-database-id",
      "the verified database UUID is unavailable; refusing to write",
    );
  }
  const approved = resolveRemoteDatabase(
    selection.databaseName,
    selection.expectedDatabaseId,
  );
  if (!configPath) {
    throw new ProvisioningAbort(
      "missing-pinned-config",
      "the pinned Wrangler config for the verified database is unavailable",
    );
  }
  return {
    kind: "remote",
    databaseName: approved.name,
    expectedDatabaseId: approved.databaseId,
    bindingName: pinnedDatabaseBinding,
    configPath,
  };
}

function parseJson(stdout: string, label: string): unknown {
  const objectStart = stdout.indexOf("{");
  const arrayStart = stdout.indexOf("[");
  const candidates = [objectStart, arrayStart].filter((value) => value !== -1);
  const start = candidates.length === 0 ? -1 : Math.min(...candidates);
  if (start === -1) {
    throw new ProvisioningAbort("invalid-output", `${label} did not return JSON`);
  }
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    throw new ProvisioningAbort("invalid-output", `${label} returned invalid JSON`);
  }
}

function executeArguments(target: ProvisioningTarget, sql: string): string[] {
  if (target.kind === "local") {
    return [
      "d1",
      "execute",
      target.databaseName,
      "--local",
      "--json",
      "--command",
      sql,
    ];
  }
  if (!target.expectedDatabaseId || !target.bindingName || !target.configPath) {
    throw new ProvisioningAbort(
      "missing-database-id",
      "the verified database target is incomplete; refusing to run",
    );
  }
  // The binding name is the last thing standing between a run and an
  // unintended database: `pinRemoteTarget` builds it, but a hand-assembled
  // target must not be able to address some other binding in some other config.
  if (target.bindingName !== pinnedDatabaseBinding) {
    throw new ProvisioningAbort(
      "wrong-binding",
      `the pinned target must address the ${pinnedDatabaseBinding} binding, saw ${target.bindingName}; refusing to run`,
    );
  }
  return [
    "d1",
    "execute",
    target.bindingName,
    "--remote",
    "--config",
    target.configPath,
    "--json",
    "--command",
    sql,
  ];
}

async function runCounts(
  run: WranglerRunner,
  target: ProvisioningTarget,
  sql: string,
  label: string,
): Promise<number[]> {
  const stdout = await run(executeArguments(target, sql));
  const parsed = parseJson(stdout, label);
  if (!Array.isArray(parsed)) {
    throw new ProvisioningAbort("invalid-output", `${label} returned no result set`);
  }
  return parsed.map((entry) => {
    const rows = (entry as { results?: { count?: unknown }[] }).results ?? [];
    const value = rows[0]?.count;
    if (typeof value !== "number") {
      throw new ProvisioningAbort(
        "invalid-output",
        `${label} did not return a numeric count`,
      );
    }
    return value;
  });
}

/**
 * Fail closed unless the CLI is authenticated to the Certpath account and the
 * named database currently resolves to the exact UUID recorded for it. This is
 * the only name-based lookup in the whole run, and the pair is re-resolved
 * against the allowlist first so a hand-built target cannot skip the check.
 */
export async function assertRemoteTarget(
  run: WranglerRunner,
  database: ApprovedRemoteDatabase,
): Promise<void> {
  const approved = resolveRemoteDatabase(database.name, database.databaseId);
  const identity = parseJson(await run(["whoami", "--json"]), "wrangler whoami");
  const accounts = (identity as { accounts?: { id?: string; name?: string }[] })
    .accounts;
  const loggedIn = (identity as { loggedIn?: boolean }).loggedIn;
  if (loggedIn !== true) {
    throw new ProvisioningAbort(
      "not-authenticated",
      "wrangler is not authenticated; nothing was written",
    );
  }
  const ids = Array.isArray(accounts)
    ? accounts.map((account) => account.id).filter(Boolean)
    : [];
  if (!ids.includes(certpathAccountId)) {
    throw new ProvisioningAbort(
      "wrong-account",
      `the CLI is not authenticated to the Certpath account ${certpathAccountId} (saw ${ids.join(", ") || "none"}); nothing was written`,
    );
  }

  const info = parseJson(
    await run(["d1", "info", approved.name, "--json"]),
    "wrangler d1 info",
  ) as { uuid?: string; name?: string };
  if (info.name !== approved.name) {
    throw new ProvisioningAbort(
      "wrong-database-name",
      `expected database ${approved.name}, saw ${info.name ?? "none"}; nothing was written`,
    );
  }
  if (
    typeof info.uuid !== "string" ||
    info.uuid.toLowerCase() !== approved.databaseId
  ) {
    throw new ProvisioningAbort(
      "wrong-database-id",
      `expected database ${approved.databaseId}, saw ${info.uuid ?? "none"}; nothing was written`,
    );
  }
}

/**
 * Any existing tester credential or the synthetic certification aborts the run
 * before hashing or writing.
 */
export async function assertNoExistingTesterRows(
  run: WranglerRunner,
  target: ProvisioningTarget,
  identifiers: Pick<ProvisioningIdentifiers, "emails" | "certificationSlug">,
): Promise<void> {
  const quoted = identifiers.emails.map((email) => `'${email}'`).join(", ");
  const counts = await runCounts(
    run,
    target,
    `SELECT COUNT(*) AS count FROM staff_password_credentials
       WHERE email_normalized IN (${quoted});
     SELECT COUNT(*) AS count FROM certifications
       WHERE slug = '${identifiers.certificationSlug}';`,
    "existing tester check",
  );
  if (counts.some((count) => count > 0)) {
    throw new ProvisioningAbort(
      "existing-tester-rows",
      "a staff account or the synthetic certification already exists; nothing was written",
    );
  }
}

const operationId = (prefix: string) =>
  `staff-provision:${prefix}:${crypto.randomUUID()}`;

export function buildProvisioningStatements(
  identifiers: ProvisioningIdentifiers,
): string[] {
  const { emails, userIds, hashes, now } = identifiers;
  const text = (value: string) => value.replaceAll("'", "''");
  const examVersionTitle = text(
    `${identifiers.certificationName} ${identifiers.examVersionKey}`
      .trim()
      .slice(0, 160),
  );
  return [
    `INSERT INTO users (id, status, created_at, updated_at) VALUES
       ('${userIds[0]}', 'active', ${now}, ${now}),
       ('${userIds[1]}', 'active', ${now}, ${now}),
       ('${userIds[2]}', 'active', ${now}, ${now});`,
    `INSERT INTO staff_roles (
       user_id, role, active, changed_by_user_id, changed_by_ref, operation_id,
       reason, changed_at
     ) VALUES
       ('${userIds[0]}', 'global_admin', 1, NULL, 'owner-provisioning-script', '${operationId("admin-one-role")}', 'Tester Global Admin', ${now}),
       ('${userIds[1]}', 'global_admin', 1, NULL, 'owner-provisioning-script', '${operationId("admin-two-role")}', 'Tester Global Admin', ${now}),
       ('${userIds[2]}', 'manager', 1, NULL, 'owner-provisioning-script', '${operationId("manager-role")}', 'Tester Manager', ${now});`,
    `INSERT INTO certifications (
       id, slug, display_name, created_by_user_id, created_operation_id, created_at
     ) VALUES (
       '${identifiers.certificationId}', '${identifiers.certificationSlug}', '${text(identifiers.certificationName)}',
       '${userIds[0]}', '${operationId("certification")}', ${now}
     );`,
    `INSERT INTO exam_versions (
       id, certification_id, version_key, title, syllabus_reference,
       effective_from, effective_until, created_by_user_id, created_operation_id,
       creation_reason, created_at
     ) VALUES (
       '${identifiers.examVersionId}', '${identifiers.certificationId}', '${identifiers.examVersionKey}',
       '${examVersionTitle}',
       'Synthetic tester syllabus',
       NULL, NULL, '${userIds[0]}', '${operationId("exam-version")}',
       'Synthetic exam for tester access', ${now}
     );`,
    `INSERT INTO manager_certification_assignments (
       manager_user_id, certification_id, active, changed_by_user_id,
       operation_id, reason, changed_at
     ) VALUES (
       '${userIds[2]}', '${identifiers.certificationId}', 1, '${userIds[0]}',
       '${operationId("manager-assignment")}', 'Tester scoped to the synthetic exam', ${now}
     );`,
    `INSERT INTO staff_password_credentials (
       user_id, email, email_normalized, password_hash, created_at, updated_at
     ) VALUES
       ('${userIds[0]}', '${emails[0]}', '${emails[0]}', '${hashes[0]}', ${now}, ${now}),
       ('${userIds[1]}', '${emails[1]}', '${emails[1]}', '${hashes[1]}', ${now}, ${now}),
       ('${userIds[2]}', '${emails[2]}', '${emails[2]}', '${hashes[2]}', ${now}, ${now});`,
    `INSERT INTO audit_events (
       operation_id, actor_user_id, actor_ref, action, subject_type, subject_id,
       certification_id, reason, occurred_at
     ) VALUES
       ('${operationId("audit-admin-one")}', NULL, 'owner-provisioning-script', 'staff_provisioned', 'user', '${userIds[0]}', NULL, 'Tester Global Admin provisioned', ${now}),
       ('${operationId("audit-admin-two")}', NULL, 'owner-provisioning-script', 'staff_provisioned', 'user', '${userIds[1]}', NULL, 'Tester Global Admin provisioned', ${now}),
       ('${operationId("audit-manager")}', NULL, 'owner-provisioning-script', 'staff_provisioned', 'user', '${userIds[2]}', '${identifiers.certificationId}', 'Tester Manager provisioned for one synthetic exam', ${now});`,
    `INSERT INTO staff_mfa_enrolment_tickets (
       ticket_digest, user_id, created_by_user_id, created_by_ref, created_at,
       expires_at, consumed_at, consumed_operation_id, revoked_at
     ) VALUES
       ('${identifiers.enrolmentTickets[0].digest}', '${userIds[0]}', NULL, 'owner-provisioning-script', ${now}, ${now + enrolmentTicketLifetimeMs}, NULL, NULL, NULL),
       ('${identifiers.enrolmentTickets[1].digest}', '${userIds[1]}', NULL, 'owner-provisioning-script', ${now}, ${now + enrolmentTicketLifetimeMs}, NULL, NULL, NULL),
       ('${identifiers.enrolmentTickets[2].digest}', '${userIds[2]}', NULL, 'owner-provisioning-script', ${now}, ${now + enrolmentTicketLifetimeMs}, NULL, NULL, NULL);`,
  ];
}

export async function applyProvisioning(
  run: WranglerRunner,
  target: ProvisioningTarget,
  identifiers: ProvisioningIdentifiers,
): Promise<void> {
  await run(
    executeArguments(
      target,
      buildProvisioningStatements(identifiers).join("\n"),
    ),
  );
}

/** Confirms exactly two Global Admins and one scoped Manager were written. */
export async function confirmProvisioning(
  run: WranglerRunner,
  target: ProvisioningTarget,
  identifiers: ProvisioningIdentifiers,
): Promise<void> {
  const quotedEmails = identifiers.emails.map((email) => `'${email}'`).join(", ");
  const quotedUsers = identifiers.userIds
    .map((userId) => `'${userId}'`)
    .join(", ");
  const counts = await runCounts(
    run,
    target,
    `SELECT COUNT(*) AS count FROM staff_password_credentials
       WHERE email_normalized IN (${quotedEmails});
     SELECT COUNT(*) AS count FROM staff_roles
       WHERE active = 1 AND user_id IN (${quotedUsers})
         AND role IN ('global_admin', 'manager');
     SELECT COUNT(*) AS count FROM manager_certification_assignments
       WHERE active = 1 AND manager_user_id = '${identifiers.userIds[2]}'
         AND certification_id = '${identifiers.certificationId}';
     SELECT COUNT(*) AS count FROM staff_mfa_enrolment_tickets
       WHERE consumed_at IS NULL AND revoked_at IS NULL
         AND user_id IN (${quotedUsers});`,
    "provisioning confirmation",
  );
  const [credentials, roles, assignments, tickets] = counts;
  if (
    credentials !== 3 ||
    roles !== 3 ||
    assignments !== 1 ||
    tickets !== 3
  ) {
    throw new ProvisioningAbort(
      "unconfirmed",
      `expected 3 credentials, 3 active roles, 1 assignment and 3 enrolment tickets, saw ${credentials ?? 0}, ${roles ?? 0}, ${assignments ?? 0}, ${tickets ?? 0}`,
    );
  }
}
