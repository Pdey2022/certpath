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
import { addCalendarMonths, addTerm, termLengthDays } from "../src/calendar.ts";
import {
  canPurchasePro,
  priceList,
  proTerm,
  proTermMonths,
  requiresBundle,
  standardCoversProWindow,
  termFor,
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
    const grants = [standard(start, addCalendarMonths(start, 3))];
    expect(evaluateFeature(grants, "standard", start - 1).state).toBe("expired");
    expect(evaluateFeature(grants, "standard", start).state).toBe("active");
    expect(
      evaluateFeature(grants, "standard", addCalendarMonths(start, 3) - 1).state,
    ).toBe("active");
    expect(evaluateFeature(grants, "standard", addCalendarMonths(start, 3)).state).toBe(
      "grace",
    );
  });

  it("keeps a 15-day read-only grace window and then expires", () => {
    const grants = [standard(start, addCalendarMonths(start, 3))];
    const expiry = addCalendarMonths(start, 3);
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
      { ...standard(start, addCalendarMonths(start, 3)), revokedAt: start + day },
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
    const expiry = addCalendarMonths(start, 3);
    const grace = evaluateFeature([standard(start, expiry)], "standard", expiry);
    expect(graceDaysRemaining(grace, expiry)).toBe(15);
    expect(graceDaysRemaining(grace, expiry + 14 * day)).toBe(1);
    expect(graceDaysRemaining(grace, expiry + graceWindowMs)).toBe(0);
  });
});

describe("capabilities", () => {
  it("allows the full Standard surface only while active", () => {
    const active = evaluateAccess([standard(start, addCalendarMonths(start, 3))], start);
    expect(can(active, "practice")).toBe(true);
    expect(can(active, "mock")).toBe(true);
    expect(can(active, "results")).toBe(true);
    expect(can(active, "explanations")).toBe(true);
    expect(can(active, "adaptive-mock")).toBe(false);
  });

  it("allows adaptive mocks only with Standard and Pro both active", () => {
    const grants = [
      standard(start, addCalendarMonths(start, 3)),
      pro(start, addCalendarMonths(start, 3)),
    ];
    expect(can(evaluateAccess(grants, start), "adaptive-mock")).toBe(true);
  });

  it("allows reading but not new work during grace", () => {
    const expiry = addCalendarMonths(start, 3);
    const access = evaluateAccess([standard(start, expiry)], expiry + day);
    expect(access.standard.state).toBe("grace");
    expect(can(access, "results")).toBe(true);
    expect(can(access, "explanations")).toBe(true);
    expect(can(access, "practice")).toBe(false);
    expect(can(access, "mock")).toBe(false);
    expect(can(access, "adaptive-mock")).toBe(false);
  });

  it("denies everything once expired", () => {
    const expiry = addCalendarMonths(start, 3);
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
  const now = Date.parse("2026-02-01T00:00:00.000Z");
  // The end of a Standard grant that covers a full Pro term bought at `now`.
  const coveringEnd = addTerm(now, proTerm);

  it("refuses pro where the exam is not adaptive", () => {
    expect(
      canPurchasePro({
        proOffered: false,
        standardCoverageEndMs: coveringEnd,
        activeProEndsAtMs: null,
        now,
      }),
    ).toEqual({
      allowed: false,
      reason: "pro-not-offered",
      requiresBundle: false,
    });
  });

  it("refuses pro when standard cannot cover a full pro term", () => {
    expect(
      canPurchasePro({
        proOffered: true,
        standardCoverageEndMs: coveringEnd - 1,
        activeProEndsAtMs: null,
        now,
      }),
    ).toEqual({
      allowed: false,
      reason: "standard-too-short",
      requiresBundle: true,
    });
    expect(requiresBundle(coveringEnd - 1, now)).toBe(true);
    expect(requiresBundle(coveringEnd, now)).toBe(false);
  });

  it("allows pro when standard ends exactly at the end of a full pro term", () => {
    // Equality is allowed: 0013 tests `standard.expires_at >= pro.expires_at`.
    expect(standardCoversProWindow(coveringEnd, now)).toBe(true);
    expect(standardCoversProWindow(coveringEnd - 1, now)).toBe(false);
    expect(
      canPurchasePro({
        proOffered: true,
        standardCoverageEndMs: coveringEnd,
        activeProEndsAtMs: null,
        now,
      }),
    ).toEqual({ allowed: true, requiresBundle: false });
  });

  it("allows pro on an 89-day standard term bought on 1 February", () => {
    // The case the flat 90-day gate refused: a full, untouched 3-month term.
    const term = termFor("standard-3m");
    expect(termLengthDays(now, term)).toBe(89);
    expect(
      canPurchasePro({
        proOffered: true,
        standardCoverageEndMs: addTerm(now, term),
        activeProEndsAtMs: null,
        now,
      }),
    ).toEqual({ allowed: true, requiresBundle: false });
  });

  it("refuses pro with no standard coverage at all", () => {
    expect(
      canPurchasePro({
        proOffered: true,
        standardCoverageEndMs: null,
        activeProEndsAtMs: null,
        now,
      }),
    ).toMatchObject({ allowed: false, reason: "standard-too-short" });
  });

  it("refuses a second pro while the stored pro window is live", () => {
    const activeProEndsAtMs = addTerm(now, proTerm);
    expect(
      canPurchasePro({
        proOffered: true,
        standardCoverageEndMs: coveringEnd,
        activeProEndsAtMs,
        now,
      }),
    ).toEqual({
      allowed: false,
      reason: "pro-window-active",
      requiresBundle: false,
    });
    // One millisecond before the stored expiry is still inside the window.
    expect(
      canPurchasePro({
        proOffered: true,
        standardCoverageEndMs: coveringEnd,
        activeProEndsAtMs: activeProEndsAtMs - 1,
        now,
      }),
    ).toMatchObject({ allowed: false, reason: "pro-window-active" });
  });

  it("allows pro once the stored window has ended", () => {
    expect(
      canPurchasePro({
        proOffered: true,
        standardCoverageEndMs: coveringEnd,
        activeProEndsAtMs: now,
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
    // Derived from the term, never from a literal month count, so a term change
    // cannot leave this assertion measuring something else.
    const months = (sku: "standard-3m" | "standard-12m"): number => {
      const term = termFor(sku);
      if (term.unit !== "calendar_months") {
        throw new Error(`${sku} is no longer a calendar-month term`);
      }
      return term.months;
    };
    const three = priceList["standard-3m"].amountMinor / months("standard-3m");
    const twelve =
      priceList["standard-12m"].amountMinor / months("standard-12m");
    expect(twelve).toBeLessThan(three);
  });

  it("prices Standard terms in calendar months and keeps the extension in days", () => {
    expect(termFor("standard-3m")).toEqual({
      unit: "calendar_months",
      months: 3,
    });
    expect(termFor("standard-6m")).toEqual({
      unit: "calendar_months",
      months: 6,
    });
    expect(termFor("standard-12m")).toEqual({
      unit: "calendar_months",
      months: 12,
    });
    expect(termFor("standard-topup-3m")).toEqual({
      unit: "calendar_months",
      months: 3,
    });
    // ADR 0003 names the SKU "Standard extension (30 days)": 30 days is not a
    // calendar month, and no later "consistency" sweep may convert it.
    expect(termFor("standard-extension-30d")).toEqual({
      unit: "days",
      days: 30,
    });
  });

  it("gives Pro a three-month calendar term, and the bundle a Standard leg that covers it", () => {
    expect(proTermMonths).toBe(3);
    expect(proTerm).toEqual({ unit: "calendar_months", months: 3 });
    expect(termFor("pro-3m")).toEqual(proTerm);
    const bundleLeg = termFor("bundle-standard-3m-pro");
    expect(bundleLeg.unit).toBe("calendar_months");
    if (bundleLeg.unit !== "calendar_months") {
      throw new Error("the bundle's Standard leg must be calendar months");
    }
    expect(bundleLeg.months).toBeGreaterThanOrEqual(proTermMonths);
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
  createdByUserId?: string | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO learner_access_grants (
       id, user_id, certification_id, feature, starts_at, expires_at,
       revoked_at, created_at, sku, source, operation_id, created_by_user_id
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'purchase', ?, ?)`,
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
      options.createdByUserId ?? null,
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
        expiresAt: addCalendarMonths(start, 3),
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

  it("audits a purchase made by a named actor", async () => {
    const { userId, certificationId } = await seedUserAndCertification();
    const operationId = `test-access:${crypto.randomUUID()}`;
    await insertGrant({
      id: crypto.randomUUID(),
      userId,
      certificationId,
      feature: "standard",
      startsAt: start,
      expiresAt: addCalendarMonths(start, 3),
      operationId,
      createdByUserId: userId,
    });

    const audit = await env.DB.prepare(
      `SELECT action, actor_user_id, actor_ref FROM audit_events
       WHERE operation_id = ?`,
    )
      .bind(operationId)
      .first<{ action: string; actor_user_id: string; actor_ref: string }>();
    expect(audit).toMatchObject({
      action: "access_granted",
      actor_user_id: userId,
      actor_ref: null,
    });
  });

  it("audits a revocation made by a named actor", async () => {
    const { userId, certificationId } = await seedUserAndCertification();
    const grantId = crypto.randomUUID();
    const operationId = `test-revoke:${crypto.randomUUID()}`;
    await insertGrant({
      id: grantId,
      userId,
      certificationId,
      feature: "standard",
      startsAt: start,
      expiresAt: addCalendarMonths(start, 3),
    });

    await env.DB.prepare(
      `UPDATE learner_access_grants
       SET revoked_at = ?, revocation_operation_id = ?, revoked_by_user_id = ?
       WHERE id = ?`,
    )
      .bind(start + day, operationId, userId, grantId)
      .run();

    const audit = await env.DB.prepare(
      `SELECT action, actor_user_id, actor_ref FROM audit_events
       WHERE operation_id = ?`,
    )
      .bind(operationId)
      .first<{ action: string; actor_user_id: string; actor_ref: string }>();
    expect(audit).toMatchObject({
      action: "access_revoked",
      actor_user_id: userId,
      actor_ref: null,
    });
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

async function revokeGrant(
  grantId: string,
  userId: string,
  operationId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE learner_access_grants
     SET revoked_at = ?, revocation_operation_id = ?, revoked_by_user_id = ?
     WHERE id = ?`,
  )
    .bind(start + day, operationId, userId, grantId)
    .run();
}

describe("grant update guards", () => {
  it("rejects editing a window in place", async () => {
    const { userId, certificationId } = await seedUserAndCertification();
    const grantId = crypto.randomUUID();
    await insertGrant({
      id: grantId,
      userId,
      certificationId,
      feature: "standard",
      startsAt: start,
      expiresAt: addCalendarMonths(start, 3),
    });

    await expect(
      env.DB.prepare(
        "UPDATE learner_access_grants SET expires_at = ? WHERE id = ?",
      )
        .bind(start + 365 * day, grantId)
        .run(),
    ).rejects.toThrow(/access grants are immutable/);
  });

  it("rejects un-revoking a refunded grant", async () => {
    const { userId, certificationId } = await seedUserAndCertification();
    const grantId = crypto.randomUUID();
    await insertGrant({
      id: grantId,
      userId,
      certificationId,
      feature: "standard",
      startsAt: start,
      expiresAt: addCalendarMonths(start, 3),
    });
    await revokeGrant(grantId, userId, `test-revoke:${crypto.randomUUID()}`);

    await expect(
      env.DB.prepare(
        `UPDATE learner_access_grants
         SET revoked_at = NULL, revocation_operation_id = NULL,
             revoked_by_user_id = NULL
         WHERE id = ?`,
      )
        .bind(grantId)
        .run(),
    ).rejects.toThrow(/access grants are immutable/);
  });

  it("rejects deleting a grant", async () => {
    const { userId, certificationId } = await seedUserAndCertification();
    const grantId = crypto.randomUUID();
    await insertGrant({
      id: grantId,
      userId,
      certificationId,
      feature: "standard",
      startsAt: start,
      expiresAt: addCalendarMonths(start, 3),
    });

    await expect(
      env.DB.prepare("DELETE FROM learner_access_grants WHERE id = ?")
        .bind(grantId)
        .run(),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it("rejects revoking the only standard grant that covers a pro grant", async () => {
    const { userId, certificationId } = await seedUserAndCertification();
    const standardId = crypto.randomUUID();
    await insertGrant({
      id: standardId,
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
    });

    await expect(
      revokeGrant(standardId, userId, `test-revoke:${crypto.randomUUID()}`),
    ).rejects.toThrow(/would leave a pro grant uncovered/);
  });

  it("allows revoking standard when a second grant still covers pro", async () => {
    const { userId, certificationId } = await seedUserAndCertification();
    const firstStandardId = crypto.randomUUID();
    await insertGrant({
      id: firstStandardId,
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
      feature: "standard",
      startsAt: start,
      expiresAt: start + 365 * day,
    });
    await insertGrant({
      id: crypto.randomUUID(),
      userId,
      certificationId,
      feature: "pro",
      startsAt: start + 30 * day,
      expiresAt: start + 120 * day,
    });

    await revokeGrant(
      firstStandardId,
      userId,
      `test-revoke:${crypto.randomUUID()}`,
    );

    const surviving = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM learner_access_grants
       WHERE user_id = ? AND revoked_at IS NULL`,
    )
      .bind(userId)
      .first<{ count: number }>();
    expect(surviving?.count).toBe(2);
  });

  it("allows revoking standard after the pro grant is revoked first", async () => {
    const { userId, certificationId } = await seedUserAndCertification();
    const standardId = crypto.randomUUID();
    const proId = crypto.randomUUID();
    await insertGrant({
      id: standardId,
      userId,
      certificationId,
      feature: "standard",
      startsAt: start,
      expiresAt: start + 180 * day,
    });
    await insertGrant({
      id: proId,
      userId,
      certificationId,
      feature: "pro",
      startsAt: start + 30 * day,
      expiresAt: start + 120 * day,
    });

    await revokeGrant(proId, userId, `test-revoke:${crypto.randomUUID()}`);
    await revokeGrant(standardId, userId, `test-revoke:${crypto.randomUUID()}`);

    const revoked = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM learner_access_grants
       WHERE user_id = ? AND revoked_at IS NOT NULL`,
    )
      .bind(userId)
      .first<{ count: number }>();
    expect(revoked?.count).toBe(2);
  });
});
