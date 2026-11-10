import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  appointGlobalAdmin,
  provisionInitialGlobalAdmin,
  revokeStaffRole,
} from "../src/security/mutations.ts";
import type { StaffMfaPolicy } from "../src/security/mfa.ts";
import {
  createTestIdentity,
  createTestSession,
  testNow,
} from "./factories.ts";
import { findUserForIdentity } from "../src/security/repository.ts";

const database: SecurityDatabase = env.DB;
const testMfaPolicy: StaffMfaPolicy = {
  maxAgeMs: 120_000,
  allowedMethods: ["totp"],
};

function operation(operationId: string) {
  return {
    operationId,
    reason: `Synthetic test: ${operationId}`,
    now: testNow,
  };
}

describe("local Global Admin provisioning integrity", () => {
  it("consumes bootstrap once, permits later appointments, and preserves a last admin under races", async () => {
    const firstIdentity = await createTestIdentity(database);
    const secondIdentity = await createTestIdentity(database);
    expect(
      await findUserForIdentity(
        database,
        firstIdentity.issuer,
        firstIdentity.subject,
      ),
    ).toBe(firstIdentity.userId);

    const concurrentBootstrap = await Promise.all([
      provisionInitialGlobalAdmin(database, {
        ...firstIdentity,
        operatorRef: "synthetic-operator-1",
        operationId: "bootstrap:one",
        now: testNow,
      }),
      provisionInitialGlobalAdmin(database, {
        ...firstIdentity,
        operatorRef: "synthetic-operator-2",
        operationId: "bootstrap:two",
        now: testNow,
      }),
    ]);
    expect(concurrentBootstrap.filter((result) => result.applied)).toHaveLength(1);
    expect(concurrentBootstrap.filter((result) => !result.applied)).toHaveLength(1);

    const bootstrapState = await database
      .prepare("SELECT * FROM initial_admin_provisioning")
      .first<{
        consumed_at: number | null;
        operation_id: string | null;
        user_id: string | null;
      }>();
    expect(bootstrapState?.consumed_at).toBe(testNow);
    expect(bootstrapState?.user_id).toBe(firstIdentity.userId);

    expect(
      await provisionInitialGlobalAdmin(database, {
        ...secondIdentity,
        operatorRef: "synthetic-operator-replay",
        operationId: "bootstrap:replay",
        now: testNow,
      }),
    ).toEqual({ applied: false, reason: "conflict" });

    const firstDigest = await createTestSession(database, firstIdentity.userId, {
      mfaMethod: "totp",
    });
    expect(
      await appointGlobalAdmin(
        database,
        firstDigest,
        secondIdentity.userId,
        operation("appoint-second-admin"),
        testMfaPolicy,
      ),
    ).toEqual({ applied: true });

    const appointedAdmins = await database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM staff_roles
         WHERE role = 'global_admin' AND active = 1`,
      )
      .first<{ count: number }>();
    expect(appointedAdmins?.count).toBe(2);

    const appointmentAudit = await database
      .prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE operation_id = ?",
      )
      .bind("appoint-second-admin")
      .first<{ count: number }>();
    expect(appointmentAudit?.count).toBe(1);

    const [removeFirst, removeSecond] = await Promise.all([
      revokeStaffRole(
        database,
        firstDigest,
        firstIdentity.userId,
        operation("remove-first-admin"),
        testMfaPolicy,
      ),
      revokeStaffRole(
        database,
        firstDigest,
        secondIdentity.userId,
        operation("remove-second-admin"),
        testMfaPolicy,
      ),
    ]);
    expect([removeFirst, removeSecond].filter((result) => result.applied)).toHaveLength(1);

    const activeAdmins = await database
      .prepare(
        `SELECT role.user_id
         FROM staff_roles AS role
         JOIN users AS user ON user.id = role.user_id
         WHERE role.role = 'global_admin'
           AND role.active = 1
           AND user.status = 'active'`,
      )
      .all<{ user_id: string }>();
    expect(activeAdmins.results).toHaveLength(1);

    const survivor = activeAdmins.results[0]!.user_id;
    const survivorDigest =
      survivor === firstIdentity.userId
        ? firstDigest
        : await createTestSession(database, survivor, { mfaMethod: "totp" });
    const auditCountBefore = await database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM audit_events
         WHERE operation_id IN ('remove-first-admin', 'remove-second-admin')`,
      )
      .first<{ count: number }>();

    expect(
      await revokeStaffRole(
        database,
        survivorDigest,
        survivor,
        operation("remove-last-admin"),
        testMfaPolicy,
      ),
    ).toEqual({ applied: false, reason: "conflict" });
    const auditCountAfter = await database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM audit_events
         WHERE operation_id IN ('remove-first-admin', 'remove-second-admin', 'remove-last-admin')`,
      )
      .first<{ count: number }>();
    expect(auditCountBefore?.count).toBe(1);
    expect(auditCountAfter?.count).toBe(1);
  });
});
