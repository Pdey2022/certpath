import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { SecurityDatabase } from "../src/security/database.ts";
import { authorizeStaffSession } from "../src/security/repository.ts";
import type { StaffMfaPolicy } from "../src/security/mfa.ts";
import { createTestIdentity, grantTestRole, testNow } from "./factories.ts";

// 0023 over a database that already holds a `tester-gate` session.
//
// The migration itself is proven against a bare D1 by `npm run db:chain` and by
// the 0022 -> 0023 replay recorded in the pull request. What this file proves is
// the *consequence* the design asks for, and it has to reconstruct the pre-0023
// state to do it: the two `app_sessions_no_tester_gate_*` triggers are dropped,
// one legacy row is written exactly as 0022 would have written it, and the
// triggers are put back. From that point on the database is in the post-0023
// shape with a legacy row in place - no trigger is weakened for any other
// assertion here.

const database: SecurityDatabase = env.DB;
const policy: StaffMfaPolicy = {
  maxAgeMs: 8 * 60 * 60 * 1000,
  allowedMethods: ["totp"],
};

async function dropTesterGateTriggers(): Promise<void> {
  await database
    .prepare("DROP TRIGGER app_sessions_no_tester_gate_insert")
    .run();
  await database
    .prepare("DROP TRIGGER app_sessions_no_tester_gate_update")
    .run();
}

/** Restores the exact 0023 definitions. */
async function restoreTesterGateTriggers(): Promise<void> {
  await database
    .prepare(
      `CREATE TRIGGER app_sessions_no_tester_gate_insert
       BEFORE INSERT ON app_sessions
       WHEN NEW.mfa_method = 'tester-gate'
       BEGIN
         SELECT RAISE(ABORT, 'the tester-gate assurance is retired');
       END`,
    )
    .run();
  await database
    .prepare(
      `CREATE TRIGGER app_sessions_no_tester_gate_update
       BEFORE UPDATE OF mfa_method ON app_sessions
       WHEN NEW.mfa_method = 'tester-gate'
       BEGIN
         SELECT RAISE(ABORT, 'the tester-gate assurance is retired');
       END`,
    )
    .run();
}

function tokenDigestFor(index: number): string {
  return index.toString(16).padStart(64, "0");
}

describe("0023 over existing tester-gate sessions", () => {
  // This test is deliberately first: it is the only one that exercises the
  // migration's own triggers rather than the copy the next test restores by
  // hand. Neutralising `app_sessions_no_tester_gate_*` in `0023` turns it red.
  it("refuses the retired label with the migration's own trigger", async () => {
    const identity = await createTestIdentity(database);
    await grantTestRole(database, identity.userId, "global_admin");

    await expect(
      database
        .prepare(
          `INSERT INTO app_sessions (
             token_digest, user_id, created_at, expires_at, mfa_method,
             mfa_verified_at
           ) VALUES (?, ?, ?, ?, 'tester-gate', ?)`,
        )
        .bind(
          tokenDigestFor(0x11),
          identity.userId,
          testNow,
          testNow + 60 * 60 * 1000,
          testNow,
        )
        .run(),
    ).rejects.toThrow(/tester-gate assurance is retired/);

    await database
      .prepare(
        `INSERT INTO app_sessions (
           token_digest, user_id, created_at, expires_at, mfa_method,
           mfa_verified_at
         ) VALUES (?, ?, ?, ?, 'totp', ?)`,
      )
      .bind(
        tokenDigestFor(0x12),
        identity.userId,
        testNow,
        testNow + 60 * 60 * 1000,
        testNow,
      )
      .run();
    await expect(
      database
        .prepare(
          `UPDATE app_sessions SET mfa_method = 'tester-gate' WHERE token_digest = ?`,
        )
        .bind(tokenDigestFor(0x12))
        .run(),
    ).rejects.toThrow(/tester-gate assurance is retired/);
  });

  it("keeps the row, refuses the assurance and blocks a new label", async () => {
    const identity = await createTestIdentity(database);
    await grantTestRole(database, identity.userId, "global_admin");
    const legacyDigest = tokenDigestFor(0xa1);

    await dropTesterGateTriggers();
    try {
      await database
        .prepare(
          `INSERT INTO app_sessions (
             token_digest, user_id, created_at, expires_at, mfa_method,
             mfa_verified_at
           ) VALUES (?, ?, ?, ?, 'tester-gate', ?)`,
        )
        .bind(
          legacyDigest,
          identity.userId,
          testNow,
          testNow + 60 * 60 * 1000,
          testNow,
        )
        .run();
    } finally {
      await restoreTesterGateTriggers();
    }

    // 1. The row survives: nothing in 0023 deletes or rewrites history.
    const kept = await database
      .prepare(
        `SELECT user_id, mfa_method FROM app_sessions WHERE token_digest = ?`,
      )
      .bind(legacyDigest)
      .first<{ user_id: string; mfa_method: string }>();
    expect(kept).toEqual({
      user_id: identity.userId,
      mfa_method: "tester-gate",
    });

    // 2. It simply stops authenticating, with the precise reason.
    expect(
      await authorizeStaffSession(database, legacyDigest, testNow, policy),
    ).toEqual({ allowed: false, reason: "mfa-assurance-unsupported" });
  });

  it("leaves every session in place when the label is absent", async () => {
    const identity = await createTestIdentity(database);
    await grantTestRole(database, identity.userId, "manager");
    const digest = tokenDigestFor(0xd4);
    await database
      .prepare(
        `INSERT INTO app_sessions (
           token_digest, user_id, created_at, expires_at, mfa_method,
           mfa_verified_at
         ) VALUES (?, ?, ?, ?, NULL, NULL)`,
      )
      .bind(digest, identity.userId, testNow, testNow + 60 * 60 * 1000)
      .run();

    expect(
      await authorizeStaffSession(database, digest, testNow, policy),
    ).toEqual({ allowed: false, reason: "mfa-assurance-missing" });

    // The upgrade path is a plain UPDATE on that same row.
    const upgraded = await database
      .prepare(
        `UPDATE app_sessions SET mfa_method = 'totp', mfa_verified_at = ?
         WHERE token_digest = ?`,
      )
      .bind(testNow, digest)
      .run();
    expect(upgraded.meta.changes).toBe(1);
    expect(
      await authorizeStaffSession(database, digest, testNow, policy),
    ).toMatchObject({ allowed: true, role: "manager" });
  });

  it("refuses a step that moves backwards or sideways", async () => {
    const identity = await createTestIdentity(database);
    await grantTestRole(database, identity.userId, "global_admin");
    const credentialId = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO staff_totp_credentials (
           credential_id, user_id, secret_ciphertext, secret_iv, key_version,
           digits, period_seconds, algorithm, last_used_step, created_at,
           confirmed_at, created_operation_id, revoked_at, revoked_operation_id
         ) VALUES (?, ?, 'cipher text placeholder', 'aaaaaaaaaaaaaaaa', 1,
                   6, 30, 'SHA1', 10, ?, ?, ?, NULL, NULL)`,
      )
      .bind(
        credentialId,
        identity.userId,
        testNow,
        testNow,
        `test-mfa-enrol:${credentialId}`,
      )
      .run();

    for (const step of [10, 9, 0]) {
      await expect(
        database
          .prepare(
            `UPDATE staff_totp_credentials SET last_used_step = ?
             WHERE credential_id = ?`,
          )
          .bind(step, credentialId)
          .run(),
      ).rejects.toThrow(/can only move forward/);
    }

    const forward = await database
      .prepare(
        `UPDATE staff_totp_credentials SET last_used_step = ?
         WHERE credential_id = ?`,
      )
      .bind(11, credentialId)
      .run();
    expect(forward.meta.changes).toBe(1);
  });

  it("refuses to un-revoke a recovery code", async () => {
    const identity = await createTestIdentity(database);
    await grantTestRole(database, identity.userId, "global_admin");
    const digest = "1".repeat(64);
    await database
      .prepare(
        `INSERT INTO staff_recovery_codes (
           code_digest, user_id, set_operation_id, created_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .bind(digest, identity.userId, `test-set:${crypto.randomUUID()}`, testNow)
      .run();

    const revoked = await database
      .prepare(
        `UPDATE staff_recovery_codes SET revoked_at = ?
         WHERE code_digest = ?
         RETURNING code_digest`,
      )
      .bind(testNow, digest)
      .all<{ code_digest: string }>();
    // Rows, not `meta.changes`: the revoked-set audit trigger adds to that count.
    expect(revoked.results).toHaveLength(1);

    const audited = await database
      .prepare(
        `SELECT actor_user_id, action FROM audit_events
         WHERE action = 'staff_recovery_codes_revoked' AND subject_id = ?`,
      )
      .bind(identity.userId)
      .all<{ actor_user_id: string | null; action: string }>();
    expect(audited.results).toEqual([
      { actor_user_id: null, action: "staff_recovery_codes_revoked" },
    ]);

    // "Exactly one live set" is a storage invariant, not a code convention.
    await expect(
      database
        .prepare(
          `UPDATE staff_recovery_codes SET revoked_at = NULL
           WHERE code_digest = ?`,
        )
        .bind(digest)
        .run(),
    ).rejects.toThrow(/revoked recovery code stays revoked/);
  });

  it("refuses a policy that still names tester-gate", async () => {
    const identity = await createTestIdentity(database);
    await grantTestRole(database, identity.userId, "global_admin");
    const digest = tokenDigestFor(0xe5);
    await database
      .prepare(
        `INSERT INTO app_sessions (
           token_digest, user_id, created_at, expires_at, mfa_method,
           mfa_verified_at
         ) VALUES (?, ?, ?, ?, 'totp', ?)`,
      )
      .bind(digest, identity.userId, testNow, testNow + 60 * 60 * 1000, testNow)
      .run();

    const legacyPolicy = {
      maxAgeMs: 60_000,
      allowedMethods: ["tester-gate"],
    } as unknown as StaffMfaPolicy;
    expect(
      await authorizeStaffSession(database, digest, testNow, legacyPolicy),
    ).toEqual({ allowed: false, reason: "mfa-policy-invalid" });
  });
});
