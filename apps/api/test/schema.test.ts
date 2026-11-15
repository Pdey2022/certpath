import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { SecurityDatabase } from "../src/security/database.ts";
import { createTestIdentity, createTestSession, testNow } from "./factories.ts";
import {
  createTestEmailSignInInvite,
  createTestLearnerUser,
} from "./factories.ts";

const database: SecurityDatabase = env.DB;

describe("local security D1 schema", () => {
  it("applies all migrations repeatedly and keeps the initial bootstrap singleton", async () => {
    const bootstrap = await database
      .prepare("SELECT * FROM initial_admin_provisioning")
      .all();
    expect(bootstrap.results).toHaveLength(1);

    const tables = await database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all<{ name: string }>();
    const names = tables.results.map((table) => table.name);
    expect(names).toContain("users");
    expect(names).toContain("auth_identities");
    expect(names).toContain("app_sessions");
    expect(names).toContain("learner_password_credentials");
    expect(names).toContain("learner_auth_tokens");
    expect(names).toContain("learner_email_sign_in_invites");
    expect(names).toContain("learner_email_sign_in_tokens");
    expect(names).toContain("staff_password_credentials");
    expect(names).toContain("local_auth_rate_limit_windows");
    expect(names).toContain("staff_roles");
    expect(names).toContain("certifications");
    expect(names).toContain("manager_certification_assignments");
    expect(names).toContain("audit_events");
    expect(names).toContain("exam_versions");
    expect(names).toContain("domains");
    expect(names).toContain("topics");
    expect(names).toContain("questions");
    expect(names).toContain("question_option_construction");
    expect(names).toContain("question_revisions");
    expect(names).toContain("answer_options");
    expect(names).toContain("question_revision_seals");
    expect(names).toContain("question_revision_events");
    expect(names).toContain("content_reviews");
    expect(names).toContain("exam_version_questions");
    expect(names).toContain("content_publication_events");
    expect(names).toContain("question_derivations");
    expect(names).toContain("question_import_previews");
    expect(names).toContain("question_import_rows");
    expect(names).toContain("question_import_results");
    expect(names).toContain("learner_access_grants");
    expect(names).toContain("practice_attempts");
    expect(names).toContain("practice_attempt_items");
    expect(names).toContain("practice_answer_events");
    expect(names).not.toContain("provider_events");
  });

  it("enforces unique provider identities and valid foreign keys", async () => {
    const identity = await createTestIdentity(database);
    await expect(
      database
        .prepare(
          "INSERT INTO auth_identities (issuer, subject, user_id, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(identity.issuer, identity.subject, identity.userId, testNow)
        .run(),
    ).rejects.toThrow();

    await expect(
      database
        .prepare(
          "INSERT INTO auth_identities (issuer, subject, user_id, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(identity.issuer, "unknown-subject", "missing-user", testNow)
        .run(),
    ).rejects.toThrow();
    await expect(
      createTestSession(database, "missing-user"),
    ).rejects.toThrow();
  });

  it("constrains roles and keeps the audit log append-only", async () => {
    const identity = await createTestIdentity(database);
    await expect(
      database
        .prepare(
          `INSERT INTO staff_roles (
             user_id, role, active, changed_by_user_id, operation_id, reason, changed_at
           ) VALUES (?, 'administrator', 1, ?, ?, 'invalid role', ?)`,
        )
        .bind(identity.userId, identity.userId, crypto.randomUUID(), testNow)
        .run(),
    ).rejects.toThrow();

    await database
      .prepare(
        `INSERT INTO staff_roles (
           user_id, role, active, changed_by_user_id, operation_id, reason, changed_at
         ) VALUES (?, 'manager', 1, ?, ?, 'test audit', ?)`,
      )
      .bind(
        identity.userId,
        identity.userId,
        "append-only-audit-test",
        // The audit row this insert writes carries this timestamp, and the delete
        // below must be refused as inside the retention window. `testNow` is a
        // fixed future instant, so it would stop being "recent" and turn this
        // assertion into a time bomb; the wall clock is always inside the window.
        Date.now(),
      )
      .run();

    await expect(
      database
        .prepare("UPDATE audit_events SET reason = 'changed' WHERE operation_id = ?")
        .bind("append-only-audit-test")
        .run(),
    ).rejects.toThrow();
    await expect(
      database
        .prepare("DELETE FROM audit_events WHERE operation_id = ?")
        .bind("append-only-audit-test")
        .run(),
    ).rejects.toThrow();
  });

  it("stores only session digests and rejects malformed digest values", async () => {
    const identity = await createTestIdentity(database);
    const digest = await createTestSession(database, identity.userId);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);

    const columns = await database
      .prepare("PRAGMA table_info(app_sessions)")
      .all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).not.toContain("raw_token");
    expect(columns.results.map((column) => column.name)).not.toContain("password");

    await expect(
      database
        .prepare(
          "INSERT INTO app_sessions (token_digest, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        )
        .bind("plain-token", identity.userId, testNow, testNow + 1000)
        .run(),
    ).rejects.toThrow();
  });

  it("keeps local credentials and action tokens in hash-only tables", async () => {
    const credentialColumns = await database
      .prepare("PRAGMA table_info(learner_password_credentials)")
      .all<{ name: string; notnull: number }>();
    expect(credentialColumns.results.map((column) => column.name)).toContain(
      "password_hash",
    );
    expect(credentialColumns.results.map((column) => column.name)).not.toContain(
      "password",
    );
    expect(credentialColumns.results.map((column) => column.name)).not.toContain(
      "raw_password",
    );
    expect(
      credentialColumns.results.find((column) => column.name === "password_hash")
        ?.notnull,
    ).toBe(0);

    const tokenColumns = await database
      .prepare("PRAGMA table_info(learner_auth_tokens)")
      .all<{ name: string }>();
    expect(tokenColumns.results.map((column) => column.name)).toContain(
      "token_digest",
    );
    expect(tokenColumns.results.map((column) => column.name)).not.toContain(
      "raw_token",
    );
    expect(tokenColumns.results.map((column) => column.name)).not.toContain(
      "token",
    );
  });
});

const passwordHashFixture = "a".repeat(90);

function uniqueAddress(label = "identity"): string {
  return `${label}-${crypto.randomUUID()}@example.test`;
}

async function createCredential(
  userId: string,
  emailNormalized: string,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO learner_password_credentials (
         user_id, email, email_normalized, subject, password_hash,
         email_verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .bind(
      userId,
      emailNormalized,
      emailNormalized,
      crypto.randomUUID(),
      testNow,
      testNow,
    )
    .run();
}

async function credentialCount(): Promise<number> {
  const row = await database
    .prepare("SELECT COUNT(*) AS count FROM learner_password_credentials")
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function inviteCount(): Promise<number> {
  const row = await database
    .prepare("SELECT COUNT(*) AS count FROM learner_email_sign_in_invites")
    .first<{ count: number }>();
  return row?.count ?? 0;
}

describe("admin capability schema guarantees", () => {
  it("adds the audit detail column, the retention index and the new triggers", async () => {
    const auditColumns = await database
      .prepare("PRAGMA table_info(audit_events)")
      .all<{ name: string }>();
    expect(auditColumns.results.map((column) => column.name)).toContain(
      "details_json",
    );

    const userColumns = await database
      .prepare("PRAGMA table_info(users)")
      .all<{ name: string }>();
    expect(userColumns.results.map((column) => column.name)).toContain(
      "deactivation_operation_id",
    );

    const credentialColumns = await database
      .prepare("PRAGMA table_info(learner_password_credentials)")
      .all<{ name: string }>();
    expect(credentialColumns.results.map((column) => column.name)).toContain(
      "contact_operation_id",
    );

    const indexes = await database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_events'",
      )
      .all<{ name: string }>();
    expect(indexes.results.map((index) => index.name)).toContain(
      "audit_events_occurred_at_idx",
    );

    const triggers = await database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all<{ name: string }>();
    const triggerNames = triggers.results.map((trigger) => trigger.name);
    for (const name of [
      "audit_events_no_delete",
      "audit_events_no_replace",
      "audit_events_details_valid_insert",
      "users_deactivation_requires_operation",
      "users_no_reactivation",
      "learner_password_credentials_contact_identity_insert",
      "learner_password_credentials_contact_identity_update",
      "learner_email_sign_in_invites_contact_identity_insert",
      "learner_email_sign_in_invites_contact_identity_update",
    ]) {
      expect(triggerNames).toContain(name);
    }
  });

  it("still refuses to update or delete a recent audit row", async () => {
    const identity = await createTestIdentity(database);
    await database
      .prepare(
        `INSERT INTO audit_events (
           operation_id, actor_user_id, actor_ref, action, subject_type,
           subject_id, certification_id, reason, occurred_at
         ) VALUES (?, ?, NULL, 'learner_record_viewed', 'user', ?, NULL, ?, ?)`,
      )
      .bind(
        "schema-audit-append-only",
        identity.userId,
        identity.userId,
        "Schema probe",
        Date.now(),
      )
      .run();

    await expect(
      database
        .prepare("UPDATE audit_events SET reason = 'changed' WHERE operation_id = ?")
        .bind("schema-audit-append-only")
        .run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      database
        .prepare("DELETE FROM audit_events WHERE operation_id = ?")
        .bind("schema-audit-append-only")
        .run(),
    ).rejects.toThrow(/retained for 12 months/);
  });

  it("refuses INSERT OR REPLACE that would rewrite an audit row", async () => {
    const identity = await createTestIdentity(database);
    const operationId = `schema-audit-no-replace-${crypto.randomUUID()}`;
    const insert = (reason: string) =>
      database
        .prepare(
          `INSERT OR REPLACE INTO audit_events (
             operation_id, actor_user_id, actor_ref, action, subject_type,
             subject_id, certification_id, reason, occurred_at
           ) VALUES (?, ?, NULL, 'learner_record_viewed', 'user', ?, NULL, ?, ?)`,
        )
        .bind(
          operationId,
          identity.userId,
          identity.userId,
          reason,
          Date.now(),
        )
        .run();

    await insert("Original reason");

    // SQLite resolves the primary-key conflict by deleting the existing row,
    // which fires no delete trigger unless recursive triggers are enabled. The
    // explicit `audit_events_no_replace` guard must abort instead.
    await expect(insert("Replaced reason")).rejects.toThrow(/append-only/);
    const row = await database
      .prepare("SELECT reason, occurred_at FROM audit_events WHERE operation_id = ?")
      .bind(operationId)
      .first<{ reason: string }>();
    expect(row?.reason).toBe("Original reason");
  });

  it("requires an operation id for deactivation and forbids reactivation", async () => {
    const identity = await createTestIdentity(database);

    await expect(
      database
        .prepare("UPDATE users SET status = 'disabled' WHERE id = ?")
        .bind(identity.userId)
        .run(),
    ).rejects.toThrow(/deactivation requires an operation id/);

    await database
      .prepare(
        `UPDATE users
         SET status = 'disabled', deactivation_operation_id = ?
         WHERE id = ?`,
      )
      .bind("schema-deactivation-probe", identity.userId)
      .run();

    await expect(
      database
        .prepare("UPDATE users SET status = 'active' WHERE id = ?")
        .bind(identity.userId)
        .run(),
    ).rejects.toThrow(/a deactivated account cannot be reactivated/);
  });

  it("rejects a credential insert that would give one address two learners", async () => {
    const learnerA = await createTestLearnerUser(database);
    const address = uniqueAddress("shared-insert");
    await createTestEmailSignInInvite(database, learnerA, { email: address });
    const learnerB = await createTestLearnerUser(database);

    const credentialsBefore = await credentialCount();
    await expect(
      // Test 1: the new registration path can no longer create a second account
      // for an address that is already provisioned as a sign-in invite.
      createCredential(learnerB, address),
    ).rejects.toThrow(/a contact address may identify only one learner/);

    expect(await credentialCount()).toBe(credentialsBefore);
    const invite = await database
      .prepare(
        `SELECT user_id, revoked_at FROM learner_email_sign_in_invites
         WHERE email_normalized = ?`,
      )
      .bind(address)
      .first<{ user_id: string; revoked_at: number | null }>();
    expect(invite).toEqual({ user_id: learnerA, revoked_at: null });
  });

  it("rejects a credential address update onto another learner's invite address", async () => {
    const learnerA = await createTestLearnerUser(database);
    const learnerB = await createTestLearnerUser(database);
    const addressOfA = uniqueAddress("invite-holder");
    const addressOfB = uniqueAddress("credential-holder");
    await createTestEmailSignInInvite(database, learnerA, { email: addressOfA });
    await createCredential(learnerB, addressOfB);

    // Test 2: the actual defect - an existing credential moving its address.
    await expect(
      database
        .prepare(
          `UPDATE learner_password_credentials
           SET email = ?, email_normalized = ?
           WHERE user_id = ?`,
        )
        .bind(addressOfA, addressOfA, learnerB)
        .run(),
    ).rejects.toThrow(/a contact address may identify only one learner/);

    const kept = await database
      .prepare(
        "SELECT email_normalized FROM learner_password_credentials WHERE user_id = ?",
      )
      .bind(learnerB)
      .first<{ email_normalized: string }>();
    expect(kept?.email_normalized).toBe(addressOfB);
  });

  it("rejects moving a credential to another user when that address is also an invite", async () => {
    const learnerA = await createTestLearnerUser(database);
    const learnerB = await createTestLearnerUser(database);
    const address = uniqueAddress("dual-holder");
    // The same learner may hold one address in both tables.
    await createCredential(learnerA, address);
    await createTestEmailSignInInvite(database, learnerA, { email: address });

    // Test 3: the user_id arm - the address matches, only the owner differs.
    await expect(
      database
        .prepare("UPDATE learner_password_credentials SET user_id = ? WHERE user_id = ?")
        .bind(learnerB, learnerA)
        .run(),
    ).rejects.toThrow(/a contact address may identify only one learner/);

    const owner = await database
      .prepare(
        "SELECT user_id FROM learner_password_credentials WHERE email_normalized = ?",
      )
      .bind(address)
      .first<{ user_id: string }>();
    expect(owner?.user_id).toBe(learnerA);
  });

  it("rejects an invite insert at another learner's credential address", async () => {
    const learnerA = await createTestLearnerUser(database);
    const learnerB = await createTestLearnerUser(database);
    const address = uniqueAddress("credential-taken");
    await createCredential(learnerA, address);

    const invitesBefore = await inviteCount();
    await expect(
      database
        .prepare(
          `INSERT INTO learner_email_sign_in_invites (
             email_normalized, user_id, created_at, revoked_at
           ) VALUES (?, ?, ?, NULL)`,
        )
        .bind(address, learnerB, testNow)
        .run(),
    ).rejects.toThrow(/a contact address may identify only one learner/);
    expect(await inviteCount()).toBe(invitesBefore);
  });

  it("rejects an invite address update onto another learner's credential address", async () => {
    const learnerA = await createTestLearnerUser(database);
    const learnerB = await createTestLearnerUser(database);
    const addressOfA = uniqueAddress("credential-holder-2");
    const addressOfB = uniqueAddress("invite-holder-2");
    await createCredential(learnerA, addressOfA);
    await createTestEmailSignInInvite(database, learnerB, { email: addressOfB });

    await expect(
      database
        .prepare(
          `UPDATE learner_email_sign_in_invites
           SET email_normalized = ?
           WHERE user_id = ?`,
        )
        .bind(addressOfA, learnerB)
        .run(),
    ).rejects.toThrow(/a contact address may identify only one learner/);
  });

  it("rejects moving an invite to another user when that address is also a credential", async () => {
    const learnerA = await createTestLearnerUser(database);
    const learnerB = await createTestLearnerUser(database);
    const address = uniqueAddress("dual-holder-2");
    await createCredential(learnerA, address);
    await createTestEmailSignInInvite(database, learnerA, { email: address });

    await expect(
      database
        .prepare(
          "UPDATE learner_email_sign_in_invites SET user_id = ? WHERE email_normalized = ?",
        )
        .bind(learnerB, address)
        .run(),
    ).rejects.toThrow(/a contact address may identify only one learner/);

    const owner = await database
      .prepare(
        "SELECT user_id FROM learner_email_sign_in_invites WHERE email_normalized = ?",
      )
      .bind(address)
      .first<{ user_id: string }>();
    expect(owner?.user_id).toBe(learnerA);
  });

  it("allows one learner to hold the same address in both tables, insert and update", async () => {
    const learner = await createTestLearnerUser(database);
    const address = uniqueAddress("same-learner");
    const second = uniqueAddress("same-learner-moved");

    await createCredential(learner, address);
    await createTestEmailSignInInvite(database, learner, { email: address });

    await database
      .prepare(
        `UPDATE learner_email_sign_in_invites
         SET email_normalized = ?
         WHERE user_id = ?`,
      )
      .bind(second, learner)
      .run();
    await database
      .prepare(
        `UPDATE learner_email_sign_in_invites
         SET email_normalized = ?
         WHERE user_id = ?`,
      )
      .bind(address, learner)
      .run();
    await database
      .prepare(
        `UPDATE learner_password_credentials
         SET email_normalized = email_normalized
         WHERE user_id = ?`,
      )
      .bind(learner)
      .run();

    const rows = await database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM learner_email_sign_in_invites
            WHERE email_normalized = ? AND user_id = ?) AS invites,
           (SELECT COUNT(*) FROM learner_password_credentials
            WHERE email_normalized = ? AND user_id = ?) AS credentials`,
      )
      .bind(address, learner, address, learner)
      .first<{ invites: number; credentials: number }>();
    expect(rows).toEqual({ invites: 1, credentials: 1 });
  });

  it("allows revoking and re-provisioning an invite with ON CONFLICT DO UPDATE", async () => {
    const learner = await createTestLearnerUser(database);
    const address = uniqueAddress("reprovision");
    await createTestEmailSignInInvite(database, learner, { email: address });
    await database
      .prepare(
        `UPDATE learner_email_sign_in_invites
         SET revoked_at = ?
         WHERE email_normalized = ?`,
      )
      .bind(testNow, address)
      .run();

    // Regression guard for npm run learner:provision.
    const result = await database
      .prepare(
        `INSERT INTO learner_email_sign_in_invites (
           email_normalized, user_id, created_at, revoked_at
         )
         SELECT ?, ?, ?, NULL
         ON CONFLICT(email_normalized) DO UPDATE SET revoked_at = NULL
         WHERE revoked_at IS NOT NULL
         RETURNING user_id`,
      )
      .bind(address, learner, testNow)
      .all<{ user_id: string }>();
    expect(result.results).toHaveLength(1);

    const row = await database
      .prepare(
        `SELECT revoked_at FROM learner_email_sign_in_invites
         WHERE email_normalized = ?`,
      )
      .bind(address)
      .first<{ revoked_at: number | null }>();
    expect(row?.revoked_at).toBeNull();
  });

  it("allows a credential password and verification update", async () => {
    const learner = await createTestLearnerUser(database);
    const address = uniqueAddress("password-update");
    await createCredential(learner, address);

    await database
      .prepare(
        `UPDATE learner_password_credentials
         SET password_hash = ?, email_verified_at = ?
         WHERE user_id = ?`,
      )
      .bind(passwordHashFixture, testNow, learner)
      .run();

    const row = await database
      .prepare(
        `SELECT password_hash, email_verified_at FROM learner_password_credentials
         WHERE user_id = ?`,
      )
      .bind(learner)
      .first<{ password_hash: string; email_verified_at: number }>();
    expect(row?.password_hash).toBe(passwordHashFixture);
    expect(row?.email_verified_at).toBe(testNow);
  });
});
