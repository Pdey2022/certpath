import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { SecurityDatabase } from "../src/security/database.ts";
import { createTestIdentity, createTestSession, testNow } from "./factories.ts";

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
      .bind(identity.userId, identity.userId, "append-only-audit-test", testNow)
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
