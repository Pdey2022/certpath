import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  assignManagerRole,
  revokeStaffRole,
} from "../src/security/mutations.ts";
import type { StaffMfaPolicy } from "../src/security/mfa.ts";
import {
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

function operation(operationId: string) {
  return {
    operationId,
    reason: `Synthetic test: ${operationId}`,
    now: testNow,
  };
}

async function createAdmin(status: "active" | "disabled" = "active") {
  const identity = await createTestIdentity(database, { status });
  await grantTestRole(database, identity.userId, "global_admin");
  const tokenDigest = await createTestSession(database, identity.userId, {
    mfaMethod: "totp",
  });
  return { ...identity, tokenDigest };
}

async function countAudit(operationId: string): Promise<number> {
  const row = await database
    .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE operation_id = ?")
    .bind(operationId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function countActiveAdmins(): Promise<number> {
  const row = await database
    .prepare(
      `SELECT COUNT(*) AS count
       FROM staff_roles AS role
       JOIN users AS user ON user.id = role.user_id
       WHERE role.role = 'global_admin'
         AND role.active = 1
         AND user.status = 'active'`,
    )
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function readRole(userId: string) {
  return database
    .prepare(
      "SELECT role, active FROM staff_roles WHERE user_id = ?",
    )
    .bind(userId)
    .first<{ role: string; active: number }>();
}

beforeEach(async () => {
  const activeAdminRoles = await database
    .prepare(
      `SELECT user_id
       FROM staff_roles
       WHERE role = 'global_admin' AND active = 1`,
    )
    .all<{ user_id: string }>();

  for (const { user_id: userId } of activeAdminRoles.results) {
    await database
      .prepare(
        `UPDATE staff_roles
         SET active = 0,
             changed_by_user_id = user_id,
             changed_by_ref = NULL,
             operation_id = ?,
             reason = 'Synthetic test fixture cleanup',
             changed_at = ?
         WHERE user_id = ? AND role = 'global_admin' AND active = 1`,
      )
      .bind(`cleanup:${crypto.randomUUID()}`, testNow, userId)
      .run();
  }
});

describe("atomic last-active-Global-Admin demotion protection", () => {
  it("denies sole-admin self-demotion without changing role, bootstrap, or audit", async () => {
    const admin = await createAdmin();
    const beforeRole = await readRole(admin.userId);
    const beforeBootstrap = await database
      .prepare("SELECT * FROM initial_admin_provisioning")
      .first();
    const operationId = "sole-admin-self-demotion";

    expect(
      await assignManagerRole(
        database,
        admin.tokenDigest,
        admin.userId,
        operation(operationId),
        testMfaPolicy,
      ),
    ).toEqual({ applied: false, reason: "conflict" });

    expect(await readRole(admin.userId)).toEqual(beforeRole);
    expect(
      await database
        .prepare("SELECT * FROM initial_admin_provisioning")
        .first(),
    ).toEqual(beforeBootstrap);
    expect(await countAudit(operationId)).toBe(0);
    expect(await countActiveAdmins()).toBe(1);
  });

  it("allows demotion when another active Global Admin remains", async () => {
    const demoted = await createAdmin();
    await createAdmin();
    const operationId = "demotion-with-active-peer";

    expect(
      await assignManagerRole(
        database,
        demoted.tokenDigest,
        demoted.userId,
        operation(operationId),
        testMfaPolicy,
      ),
    ).toEqual({ applied: true });

    expect(await readRole(demoted.userId)).toEqual({
      role: "manager",
      active: 1,
    });
    expect(await countAudit(operationId)).toBe(1);
    expect(await countActiveAdmins()).toBe(1);
  });

  it("does not count a disabled additional Global Admin as protection", async () => {
    const admin = await createAdmin();
    await createAdmin("disabled");
    const beforeRole = await readRole(admin.userId);
    const beforeBootstrap = await database
      .prepare("SELECT * FROM initial_admin_provisioning")
      .first();
    const operationId = "demotion-disabled-peer";

    expect(
      await assignManagerRole(
        database,
        admin.tokenDigest,
        admin.userId,
        operation(operationId),
        testMfaPolicy,
      ),
    ).toEqual({ applied: false, reason: "conflict" });

    expect(await readRole(admin.userId)).toEqual(beforeRole);
    expect(
      await database
        .prepare("SELECT * FROM initial_admin_provisioning")
        .first(),
    ).toEqual(beforeBootstrap);
    expect(await countAudit(operationId)).toBe(0);
    expect(await countActiveAdmins()).toBe(1);
  });

  it("preserves an active Global Admin under concurrent demotions", async () => {
    const first = await createAdmin();
    const second = await createAdmin();

    const results = await Promise.all([
      assignManagerRole(
        database,
        first.tokenDigest,
        first.userId,
        operation("concurrent-demotion-first"),
        testMfaPolicy,
      ),
      assignManagerRole(
        database,
        second.tokenDigest,
        second.userId,
        operation("concurrent-demotion-second"),
        testMfaPolicy,
      ),
    ]);

    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect(results.filter((result) => !result.applied)).toHaveLength(1);
    expect(await countActiveAdmins()).toBe(1);
    expect(
      await countAudit("concurrent-demotion-first") +
        await countAudit("concurrent-demotion-second"),
    ).toBe(1);
  });

  it("preserves an active Global Admin under concurrent demotion and removal", async () => {
    const demoted = await createAdmin();
    const removed = await createAdmin();

    const [demotion, removal] = await Promise.all([
      assignManagerRole(
        database,
        demoted.tokenDigest,
        demoted.userId,
        operation("mixed-demotion"),
        testMfaPolicy,
      ),
      revokeStaffRole(
        database,
        removed.tokenDigest,
        removed.userId,
        operation("mixed-removal"),
        testMfaPolicy,
      ),
    ]);

    expect([demotion, removal].filter((result) => result.applied)).toHaveLength(1);
    expect([demotion, removal].filter((result) => !result.applied)).toHaveLength(1);
    expect(await countActiveAdmins()).toBe(1);
    expect(
      await countAudit("mixed-demotion") + await countAudit("mixed-removal"),
    ).toBe(1);
  });

  it("creates no audit event for a rejected demotion", async () => {
    const admin = await createAdmin();
    const operationId = "rejected-demotion-no-audit";

    expect(
      await assignManagerRole(
        database,
        admin.tokenDigest,
        admin.userId,
        operation(operationId),
        testMfaPolicy,
      ),
    ).toEqual({ applied: false, reason: "conflict" });
    expect(await countAudit(operationId)).toBe(0);
    expect(await readRole(admin.userId)).toEqual({
      role: "global_admin",
      active: 1,
    });
  });
});
