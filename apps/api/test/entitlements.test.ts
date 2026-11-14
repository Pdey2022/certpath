import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  can,
  evaluateAccess,
  evaluateFeature,
  graceDaysRemaining,
  graceWindowMs,
  type AccessGrantRecord,
} from "../src/entitlements.ts";
import {
  canPurchasePro,
  priceList,
  proMinimumStandardDays,
  proWindowDays,
  requiresBundle,
} from "../src/pricing.ts";

const day = 86_400_000;
const start = 1_763_000_000_000;

function standard(startsAt: number, expiresAt: number): AccessGrantRecord {
  return { feature: "standard", startsAt, expiresAt, revokedAt: null };
}

function pro(startsAt: number, expiresAt: number): AccessGrantRecord {
  return { feature: "pro", startsAt, expiresAt, revokedAt: null };
}

describe("feature access states", () => {
  it("is active only inside the grant window", () => {
    const grants = [standard(start, start + 90 * day)];
    expect(evaluateFeature(grants, "standard", start - 1).state).toBe("expired");
    expect(evaluateFeature(grants, "standard", start).state).toBe("active");
    expect(
      evaluateFeature(grants, "standard", start + 90 * day - 1).state,
    ).toBe("active");
    expect(evaluateFeature(grants, "standard", start + 90 * day).state).toBe(
      "grace",
    );
  });

  it("keeps a 15-day read-only grace window and then expires", () => {
    const grants = [standard(start, start + 90 * day)];
    const expiry = start + 90 * day;
    const grace = evaluateFeature(grants, "standard", expiry);
    expect(grace.state).toBe("grace");
    expect(grace.graceEndsAt).toBe(expiry + graceWindowMs);
    expect(
      evaluateFeature(grants, "standard", expiry + graceWindowMs - 1).state,
    ).toBe("grace");
    expect(
      evaluateFeature(grants, "standard", expiry + graceWindowMs).state,
    ).toBe("expired");
  });

  it("ignores revoked grants entirely", () => {
    const grants: AccessGrantRecord[] = [
      { ...standard(start, start + 90 * day), revokedAt: start + day },
    ];
    expect(evaluateFeature(grants, "standard", start + 2 * day).state).toBe(
      "expired",
    );
  });

  it("uses the furthest expiry when grants overlap", () => {
    const grants = [
      standard(start, start + 30 * day),
      standard(start + day, start + 120 * day),
    ];
    const access = evaluateFeature(grants, "standard", start + 10 * day);
    expect(access.state).toBe("active");
    expect(access.endsAt).toBe(start + 120 * day);
  });

  it("counts grace days downwards", () => {
    const expiry = start + 90 * day;
    const grace = evaluateFeature([standard(start, expiry)], "standard", expiry);
    expect(graceDaysRemaining(grace, expiry)).toBe(15);
    expect(graceDaysRemaining(grace, expiry + 14 * day)).toBe(1);
    expect(graceDaysRemaining(grace, expiry + graceWindowMs)).toBe(0);
  });
});

describe("capabilities", () => {
  it("allows the full Standard surface only while active", () => {
    const active = evaluateAccess([standard(start, start + 90 * day)], start);
    expect(can(active, "practice")).toBe(true);
    expect(can(active, "mock")).toBe(true);
    expect(can(active, "results")).toBe(true);
    expect(can(active, "explanations")).toBe(true);
    expect(can(active, "adaptive-mock")).toBe(false);
  });

  it("allows adaptive mocks only with Standard and Pro both active", () => {
    const grants = [
      standard(start, start + 90 * day),
      pro(start, start + 90 * day),
    ];
    expect(can(evaluateAccess(grants, start), "adaptive-mock")).toBe(true);
  });

  it("allows reading but not new work during grace", () => {
    const expiry = start + 90 * day;
    const access = evaluateAccess([standard(start, expiry)], expiry + day);
    expect(access.standard.state).toBe("grace");
    expect(can(access, "results")).toBe(true);
    expect(can(access, "explanations")).toBe(true);
    expect(can(access, "practice")).toBe(false);
    expect(can(access, "mock")).toBe(false);
    expect(can(access, "adaptive-mock")).toBe(false);
  });

  it("denies everything once expired", () => {
    const expiry = start + 90 * day;
    const access = evaluateAccess(
      [standard(start, expiry)],
      expiry + graceWindowMs,
    );
    for (const capability of [
      "practice",
      "mock",
      "adaptive-mock",
      "results",
      "explanations",
    ] as const) {
      expect(can(access, capability)).toBe(false);
    }
  });
});

describe("pro purchase rules", () => {
  const now = start + 10 * day;

  it("refuses pro where the exam is not adaptive", () => {
    expect(
      canPurchasePro({
        proOffered: false,
        standardRemainingDays: 180,
        lastProStartAt: null,
        now,
      }),
    ).toEqual({
      allowed: false,
      reason: "pro-not-offered",
      requiresBundle: false,
    });
  });

  it("refuses pro when standard cannot cover the window", () => {
    expect(
      canPurchasePro({
        proOffered: true,
        standardRemainingDays: proMinimumStandardDays - 1,
        lastProStartAt: null,
        now,
      }),
    ).toEqual({
      allowed: false,
      reason: "standard-too-short",
      requiresBundle: true,
    });
    expect(requiresBundle(proMinimumStandardDays - 1)).toBe(true);
    expect(requiresBundle(proMinimumStandardDays)).toBe(false);
  });

  it("refuses a second pro inside the rolling window", () => {
    expect(
      canPurchasePro({
        proOffered: true,
        standardRemainingDays: 200,
        lastProStartAt: now - (proWindowDays - 1) * day,
        now,
      }),
    ).toMatchObject({ allowed: false, reason: "pro-window-active" });
  });

  it("allows pro once the previous window has closed", () => {
    expect(
      canPurchasePro({
        proOffered: true,
        standardRemainingDays: 200,
        lastProStartAt: now - proWindowDays * day,
        now,
      }),
    ).toEqual({ allowed: true, requiresBundle: false });
  });

  it("allows the first pro purchase on a long enough membership", () => {
    expect(
      canPurchasePro({
        proOffered: true,
        standardRemainingDays: 90,
        lastProStartAt: null,
        now,
      }),
    ).toEqual({ allowed: true, requiresBundle: false });
  });
});

describe("price list", () => {
  it("keeps money in integer minor units", () => {
    for (const entry of Object.values(priceList)) {
      expect(Number.isInteger(entry.amountMinor)).toBe(true);
      expect(entry.amountMinor).toBeGreaterThan(0);
    }
  });

  it("prices the bundle below its parts and pro below a standard term", () => {
    const bundle = priceList["bundle-standard-3m-pro"].amountMinor;
    const parts =
      priceList["standard-3m"].amountMinor + priceList["pro-3m"].amountMinor;
    expect(bundle).toBeLessThan(parts);
    expect(priceList["pro-3m"].amountMinor).toBeLessThan(
      priceList["standard-3m"].amountMinor,
    );
  });

  it("discounts longer terms without making them cheaper per month", () => {
    const three = priceList["standard-3m"].amountMinor / 3;
    const twelve = priceList["standard-12m"].amountMinor / 12;
    expect(twelve).toBeLessThan(three);
  });
});

async function seedUserAndCertification(): Promise<{
  userId: string;
  certificationId: string;
}> {
  const now = Date.now();
  const userId = crypto.randomUUID();
  const certificationId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO users (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)",
  )
    .bind(userId, now, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO certifications (
       id, slug, display_name, created_by_user_id, created_operation_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      certificationId,
      `entitlement-${certificationId.slice(0, 8)}`,
      "Entitlement test",
      userId,
      `test-certification:${certificationId}`,
      now,
    )
    .run();
  return { userId, certificationId };
}

async function insertGrant(options: {
  id: string;
  userId: string;
  certificationId: string;
  feature: "standard" | "pro";
  startsAt: number;
  expiresAt: number;
  operationId?: string | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO learner_access_grants (
       id, user_id, certification_id, feature, starts_at, expires_at,
       revoked_at, created_at, sku, source, operation_id
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'purchase', ?)`,
  )
    .bind(
      options.id,
      options.userId,
      options.certificationId,
      options.feature,
      options.startsAt,
      options.expiresAt,
      options.startsAt,
      options.feature === "pro" ? "pro-3m" : "standard-3m",
      options.operationId ?? null,
    )
    .run();
}

describe("storage layer guarantees", () => {
  it("rejects a pro grant that no standard grant covers", async () => {
    const { userId, certificationId } = await seedUserAndCertification();
    await expect(
      insertGrant({
        id: crypto.randomUUID(),
        userId,
        certificationId,
        feature: "pro",
        startsAt: start,
        expiresAt: start + 90 * day,
      }),
    ).rejects.toThrow(/pro grant requires a standard grant/);
  });

  it("accepts a pro grant fully covered by standard and audits it", async () => {
    const { userId, certificationId } = await seedUserAndCertification();
    const operationId = `test-access:${crypto.randomUUID()}`;
    await insertGrant({
      id: crypto.randomUUID(),
      userId,
      certificationId,
      feature: "standard",
      startsAt: start,
      expiresAt: start + 180 * day,
    });
    await insertGrant({
      id: crypto.randomUUID(),
      userId,
      certificationId,
      feature: "pro",
      startsAt: start + 30 * day,
      expiresAt: start + 120 * day,
      operationId,
    });

    const audit = await env.DB.prepare(
      "SELECT action FROM audit_events WHERE operation_id = ?",
    )
      .bind(operationId)
      .first<{ action: string }>();
    expect(audit?.action).toBe("access_granted");
  });

  it("still accepts legacy-shaped inserts without provenance", async () => {
    const { userId, certificationId } = await seedUserAndCertification();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO learner_access_grants (
         id, user_id, certification_id, feature, starts_at, expires_at,
         revoked_at, created_at
       ) VALUES (?, ?, ?, 'standard', ?, ?, NULL, ?)`,
    )
      .bind(crypto.randomUUID(), userId, certificationId, now, now + day, now)
      .run();
  });
});
