import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/index.ts";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  canCapability,
  capabilityMatrix,
  capabilitiesForRole,
  certificationGuard,
  staffCapabilities,
  type CapabilityResource,
  type CapabilityResourceKind,
} from "../src/security/capabilities.ts";
import type { StaffMfaPolicy } from "../src/security/mfa.ts";
import {
  assignTestCertification,
  createTestCertification,
  createTestIdentity,
  createTestLearnerUser,
  createTestSession,
  grantTestRole,
  testNow,
} from "./factories.ts";

const database: SecurityDatabase = env.DB;

const managerOnly = "content.manage";

function resourceFor(
  kind: CapabilityResourceKind,
  values: { certificationId: string; learnerUserId: string },
): CapabilityResource {
  if (kind === "platform") return { kind: "platform" };
  if (kind === "certification") {
    return { kind: "certification", certificationId: values.certificationId };
  }
  return { kind: "learner", learnerUserId: values.learnerUserId };
}

describe("staff capability matrix", () => {
  it("answers every capability and role exactly as the matrix declares", async () => {
    const admin = await createTestIdentity(database);
    const manager = await createTestIdentity(database);
    await grantTestRole(database, admin.userId, "global_admin");
    await grantTestRole(database, manager.userId, "manager");
    const certificationId = await createTestCertification(database, admin.userId);
    await assignTestCertification(database, manager.userId, certificationId);
    const learnerUserId = await createTestLearnerUser(database);
    const values = { certificationId, learnerUserId };

    expect(staffCapabilities).toHaveLength(14);

    for (const capability of staffCapabilities) {
      const rule = capabilityMatrix[capability];
      const resource = resourceFor(rule.resource, values);
      for (const role of ["global_admin", "manager"] as const) {
        const actor =
          role === "global_admin"
            ? { userId: admin.userId, role }
            : { userId: manager.userId, role };
        expect(await canCapability(database, actor, capability, resource)).toEqual(
          rule.roles[role] ? { allowed: true } : { allowed: false, reason: "insufficient-role" },
        );
      }
    }

    const unknown = await canCapability(
      database,
      { userId: admin.userId, role: "global_admin" },
      "commerce.refund" as never,
      { kind: "platform" },
    );
    expect(unknown).toEqual({ allowed: false, reason: "unknown-capability" });
  });

  it("keeps a Manager inside assigned certifications, current and proposed", async () => {
    const admin = await createTestIdentity(database);
    const manager = await createTestIdentity(database);
    await grantTestRole(database, manager.userId, "manager");
    const assigned = await createTestCertification(database, admin.userId);
    const other = await createTestCertification(database, admin.userId);
    await assignTestCertification(database, manager.userId, assigned);
    const actor = { userId: manager.userId, role: "manager" as const };

    expect(
      await canCapability(database, actor, managerOnly, {
        kind: "certification",
        certificationId: assigned,
      }),
    ).toEqual({ allowed: true });

    expect(
      await canCapability(database, actor, managerOnly, {
        kind: "certification",
        certificationId: other,
      }),
    ).toEqual({ allowed: false, reason: "certification-unassigned" });

    // Moving content needs both ends: the source assignment alone is not enough.
    expect(
      await canCapability(database, actor, managerOnly, {
        kind: "certification",
        certificationId: assigned,
        proposedCertificationId: other,
      }),
    ).toEqual({ allowed: false, reason: "certification-unassigned" });

    await assignTestCertification(database, manager.userId, other);
    expect(
      await canCapability(database, actor, managerOnly, {
        kind: "certification",
        certificationId: assigned,
        proposedCertificationId: other,
      }),
    ).toEqual({ allowed: true });

    expect(
      await canCapability(database, actor, managerOnly, {
        kind: "certification",
        certificationId: assigned,
        proposedCertificationId: null,
      }),
    ).toEqual({ allowed: true });
  });

  it("reports unknown certifications and mismatched resource kinds", async () => {
    const admin = await createTestIdentity(database);
    await grantTestRole(database, admin.userId, "global_admin");
    const learnerUserId = await createTestLearnerUser(database);
    const actor = { userId: admin.userId, role: "global_admin" as const };

    expect(
      await canCapability(database, actor, "content.read", {
        kind: "certification",
        certificationId: crypto.randomUUID(),
      }),
    ).toEqual({ allowed: false, reason: "certification-not-found" });

    expect(
      await canCapability(database, actor, managerOnly, {
        kind: "learner",
        learnerUserId,
      }),
    ).toEqual({ allowed: false, reason: "resource-kind-mismatch" });
  });

  it("hides a staff account behind the same answer as a missing learner", async () => {
    const admin = await createTestIdentity(database);
    await grantTestRole(database, admin.userId, "global_admin");
    const plainLearner = await createTestLearnerUser(database);
    const actor = { userId: admin.userId, role: "global_admin" as const };

    expect(
      await canCapability(database, actor, "learner.read", {
        kind: "learner",
        learnerUserId: plainLearner,
      }),
    ).toEqual({ allowed: true });

    expect(
      await canCapability(database, actor, "learner.read", {
        kind: "learner",
        learnerUserId: admin.userId,
      }),
    ).toEqual({ allowed: false, reason: "learner-not-found" });

    expect(
      await canCapability(database, actor, "learner.read", {
        kind: "learner",
        learnerUserId: crypto.randomUUID(),
      }),
    ).toEqual({ allowed: false, reason: "learner-not-found" });
  });

  it("refuses the write when the role is revoked after the decision was made", async () => {
    const admin = await createTestIdentity(database);
    const manager = await createTestIdentity(database);
    await grantTestRole(database, manager.userId, "manager");
    const certificationId = await createTestCertification(database, admin.userId);
    await assignTestCertification(database, manager.userId, certificationId);
    const policy: StaffMfaPolicy = { maxAgeMs: 60_000, allowedMethods: ["totp"] };
    const digest = await createTestSession(database, manager.userId, {
      mfaMethod: "totp",
    });
    const actor = { userId: manager.userId, role: "manager" as const };

    // The decision function only knows what it was told.
    expect(
      await canCapability(database, actor, managerOnly, {
        kind: "certification",
        certificationId,
      }),
    ).toEqual({ allowed: true });

    await database
      .prepare(
        `UPDATE manager_certification_assignments
         SET active = 0, operation_id = ?
         WHERE manager_user_id = ? AND certification_id = ?`,
      )
      .bind(`revoke:${crypto.randomUUID()}`, manager.userId, certificationId)
      .run();

    const guard = certificationGuard(
      digest,
      certificationId,
      null,
      testNow,
      policy,
    );
    const guardedWrite = await database
      .prepare(
        `UPDATE users SET updated_at = updated_at
         WHERE id = ? AND ${guard.sql}
         RETURNING id`,
      )
      .bind(manager.userId, ...guard.values)
      .all<{ id: string }>();

    // The decision still says yes (it was computed from the passed role); the
    // statement says no. That is the guarantee that survives broken code.
    expect(guardedWrite.results).toHaveLength(0);
  });

  it("reports role capabilities without the Global Admin only set", () => {
    const manager = capabilitiesForRole("manager");
    expect(manager).toContain("content.read");
    expect(manager).toContain("learner.lookup");
    for (const capability of [
      "commerce.read",
      "access.grant",
      "staff.manage",
      "security.manage",
      "audit.read",
    ]) {
      expect(manager).not.toContain(capability);
    }
    const admin = capabilitiesForRole("global_admin");
    expect(admin).toEqual([...staffCapabilities].sort());
  });
});

describe("admin learner route surface", () => {
  const learnerPaths = new Set([
    "/api/admin/csrf",
    "/api/admin/capabilities",
    "/api/admin/learners/lookup",
    "/api/admin/learners/:learnerId",
    "/api/admin/learners/:learnerId/contact-reveal",
    "/api/admin/learners/:learnerId/deactivate",
    "/api/admin/learners/:learnerId/contact",
    "/api/admin/learners/:learnerId/password-reset",
    "/api/admin/learners/:learnerId/resend-verification",
    "/api/admin/learners/:learnerId/support-history",
  ]);

  it("exposes only the declared learner paths and no forbidden prefix", () => {
    const application = createApi();
    const routes = application.routes;
    const requestPaths = new Set(
      routes.filter((route) => route.method !== "ALL").map((route) => route.path),
    );

    for (const path of requestPaths) {
      if (path.startsWith("/api/admin/learners")) {
        expect(learnerPaths.has(path)).toBe(true);
      }
      expect(path).not.toMatch(
        /^\/api\/admin\/(staff|payments|prices|discounts|coupons|access-grants|entitlements)/,
      );
    }

    for (const path of learnerPaths) {
      expect(requestPaths.has(path)).toBe(true);
    }

    // The only wildcard entries this router registers are its three session
    // bootstrap hooks, so a new path cannot appear without opting in.
    const middlewarePaths = new Set(
      routes.filter((route) => route.method === "ALL").map((route) => route.path),
    );
    for (const path of [
      "/api/admin/csrf",
      "/api/admin/capabilities",
      "/api/admin/learners/*",
    ]) {
      expect(middlewarePaths.has(path)).toBe(true);
    }
    expect(
      [...middlewarePaths].filter((path) => path.startsWith("/api/admin/learners")),
    ).toEqual(["/api/admin/learners/*"]);
  });
});
