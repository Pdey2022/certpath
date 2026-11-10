import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  assignManagerCertification,
  assignManagerRole,
  createCertificationRoot,
  revokeManagerCertification,
} from "../src/security/mutations.ts";
import {
  authorizeCertification,
  authorizeGlobalAdmin,
} from "../src/security/repository.ts";
import type { StaffMfaPolicy } from "../src/security/mfa.ts";
import {
  createTestCertification,
  createTestIdentity,
  createTestSession,
  grantTestRole,
  testNow,
} from "./factories.ts";

const database: SecurityDatabase = env.DB;
const testMfaPolicy: StaffMfaPolicy = {
  maxAgeMs: 120_000,
  allowedMethods: ["totp"],
};

function operation(reason: string, now = testNow) {
  return {
    operationId: `${reason}:${crypto.randomUUID()}`,
    reason: `Synthetic test: ${reason}`,
    now,
  };
}

describe("default-deny roles and certification permissions", () => {
  it("allows only a manager's assigned certification or an MFA-verified Global Admin", async () => {
    const admin = await createTestIdentity(database);
    const manager = await createTestIdentity(database);
    const learner = await createTestIdentity(database);
    await grantTestRole(database, admin.userId, "global_admin");
    await grantTestRole(database, manager.userId, "manager");
    const adminDigest = await createTestSession(database, admin.userId, {
      mfaMethod: "totp",
    });
    const managerDigest = await createTestSession(database, manager.userId, {
      mfaMethod: "totp",
    });
    expect(
      await authorizeGlobalAdmin(
        database,
        adminDigest,
        testNow,
        testMfaPolicy,
      ),
    ).toMatchObject({ allowed: true, userId: admin.userId });
    const learnerDigest = await createTestSession(database, learner.userId, {
      mfaMethod: "totp",
    });
    const assignedCertification = await createTestCertification(
      database,
      admin.userId,
    );
    const otherCertification = await createTestCertification(
      database,
      admin.userId,
    );
    await database
      .prepare(
        `INSERT INTO manager_certification_assignments (
           manager_user_id, certification_id, active, changed_by_user_id,
           operation_id, reason, changed_at
         ) VALUES (?, ?, 1, ?, ?, 'Synthetic test fixture', ?)`,
      )
      .bind(
        manager.userId,
        assignedCertification,
        admin.userId,
        `fixture:${crypto.randomUUID()}`,
        testNow,
      )
      .run();

    expect(
      await authorizeCertification(
        database,
        managerDigest,
        assignedCertification,
        testNow,
        testMfaPolicy,
      ),
    ).toMatchObject({ allowed: true, role: "manager" });
    expect(
      await authorizeCertification(
        database,
        managerDigest,
        otherCertification,
        testNow,
        testMfaPolicy,
      ),
    ).toEqual({ allowed: false, reason: "certification-unassigned" });
    expect(
      await authorizeCertification(
        database,
        adminDigest,
        otherCertification,
        testNow,
        testMfaPolicy,
      ),
    ).toMatchObject({ allowed: true, role: "global_admin" });
    expect(
      await authorizeGlobalAdmin(
        database,
        learnerDigest,
        testNow,
        testMfaPolicy,
      ),
    ).toEqual({ allowed: false, reason: "not-staff" });
  });

  it("fails closed for unconfigured, missing, stale, and unsupported staff MFA assurance", async () => {
    const admin = await createTestIdentity(database);
    await grantTestRole(database, admin.userId, "global_admin");
    const missingDigest = await createTestSession(database, admin.userId);
    const staleDigest = await createTestSession(database, admin.userId, {
      now: testNow - testMfaPolicy.maxAgeMs - 10,
      expiresAt: testNow + 60_000,
      mfaMethod: "totp",
      mfaVerifiedAt: testNow - testMfaPolicy.maxAgeMs - 10,
    });
    const unsupportedDigest = await createTestSession(database, admin.userId, {
      mfaMethod: "email-link",
    });

    expect(
      await authorizeGlobalAdmin(database, missingDigest, testNow, undefined),
    ).toEqual({ allowed: false, reason: "mfa-policy-unconfigured" });
    expect(
      await authorizeGlobalAdmin(
        database,
        missingDigest,
        testNow,
        testMfaPolicy,
      ),
    ).toEqual({ allowed: false, reason: "mfa-assurance-missing" });
    expect(
      await authorizeGlobalAdmin(
        database,
        staleDigest,
        testNow,
        testMfaPolicy,
      ),
    ).toEqual({ allowed: false, reason: "mfa-assurance-stale" });
    expect(
      await authorizeGlobalAdmin(
        database,
        unsupportedDigest,
        testNow,
        testMfaPolicy,
      ),
    ).toEqual({ allowed: false, reason: "mfa-assurance-unsupported" });
  });

  it("audits only successful assignment writes and applies revocation on the next check", async () => {
    const admin = await createTestIdentity(database);
    const manager = await createTestIdentity(database);
    await grantTestRole(database, admin.userId, "global_admin");
    const adminDigest = await createTestSession(database, admin.userId, {
      mfaMethod: "totp",
    });
    const managerDigest = await createTestSession(database, manager.userId, {
      mfaMethod: "totp",
    });
    expect(
      await authorizeGlobalAdmin(database, adminDigest, testNow, testMfaPolicy),
    ).toMatchObject({ allowed: true, userId: admin.userId });

    const certificationAId = crypto.randomUUID();
    const certificationA = await createCertificationRoot(
      database,
      adminDigest,
      { id: certificationAId, slug: `local-${crypto.randomUUID()}`, displayName: "Local exam A" },
      operation("create-certification-a"),
      testMfaPolicy,
    );
    const certificationBId = crypto.randomUUID();
    const certificationB = await createCertificationRoot(
      database,
      adminDigest,
      { id: certificationBId, slug: `local-${crypto.randomUUID()}`, displayName: "Local exam B" },
      operation("create-certification-b"),
      testMfaPolicy,
    );
    expect(certificationA.applied).toBe(true);
    expect(certificationB.applied).toBe(true);

    const roleOperation = operation("assign-manager-role");
    expect(
      await assignManagerRole(
        database,
        adminDigest,
        manager.userId,
        roleOperation,
        testMfaPolicy,
      ),
    ).toEqual({ applied: true });

    const grantOperation = operation("grant-manager-exam");
    expect(
      await assignManagerCertification(
        database,
        adminDigest,
        manager.userId,
        certificationAId,
        grantOperation,
        testMfaPolicy,
      ),
    ).toEqual({ applied: true });

    const grantedCertification = await database
      .prepare(
        `SELECT certification_id
         FROM manager_certification_assignments
         WHERE manager_user_id = ? AND active = 1`,
      )
      .bind(manager.userId)
      .first<{ certification_id: string }>();
    expect(grantedCertification).not.toBeNull();

    const allowedBeforeRevoke = await authorizeCertification(
      database,
      managerDigest,
      grantedCertification!.certification_id,
      testNow,
      testMfaPolicy,
    );
    expect(allowedBeforeRevoke.allowed).toBe(true);

    const unassignedResult = await assignManagerCertification(
      database,
      managerDigest,
      manager.userId,
      certificationBId,
      operation("manager-cannot-assign"),
      testMfaPolicy,
    );
    expect(unassignedResult).toEqual({
      applied: false,
      reason: "insufficient-role",
    });

    expect(
      await revokeManagerCertification(
        database,
        adminDigest,
        manager.userId,
        grantedCertification!.certification_id,
        operation("revoke-manager-exam"),
        testMfaPolicy,
      ),
    ).toEqual({ applied: true });
    expect(
      await authorizeCertification(
        database,
        managerDigest,
        grantedCertification!.certification_id,
        testNow,
        testMfaPolicy,
      ),
    ).toEqual({ allowed: false, reason: "certification-unassigned" });

    const before = await database
      .prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE operation_id = ?",
      )
      .bind(roleOperation.operationId)
      .first<{ count: number }>();
    expect(before?.count).toBe(1);
    expect(
      await revokeManagerCertification(
        database,
        adminDigest,
        manager.userId,
        grantedCertification!.certification_id,
        operation("revoke-manager-exam-again"),
        testMfaPolicy,
      ),
    ).toEqual({ applied: false, reason: "conflict" });
  });

  it("ignores forged browser-style role and demo inputs", async () => {
    const learner = await createTestIdentity(database);
    const digest = await createTestSession(database, learner.userId, {
      mfaMethod: "totp",
    });
    const forged = {
      role: "global_admin",
      mfaVerified: true,
      email: "admin@example.test",
      demoRole: "global_admin",
    };

    expect(
      await authorizeGlobalAdmin(
        database,
        JSON.stringify({ ...forged, tokenDigest: digest }),
        testNow,
        testMfaPolicy,
      ),
    ).toEqual({ allowed: false, reason: "invalid-session" });
    expect(
      await authorizeGlobalAdmin(database, digest, testNow, testMfaPolicy),
    ).toEqual({ allowed: false, reason: "not-staff" });
  });
});
