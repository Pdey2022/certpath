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
  bundleWindows,
  canPurchasePro,
  priceList,
  proTerm,
  proTermMonths,
  requiresBundle,
  standardCoversProWindow,
  standardCoverageEndMs,
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
  // One Standard grant, live at `now`, that covers a full Pro term. The gate is
  // handed grants rather than a window, so this is the 0013 witness itself.
  const covering = [standard(now - 90 * day, coveringEnd)];

  it("refuses pro where the exam is not adaptive", () => {
    expect(
      canPurchasePro({
        proOffered: false,
        standardGrants: covering,
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
    const short = [standard(now - 90 * day, coveringEnd - 1)];
    expect(
      canPurchasePro({
        proOffered: true,
        standardGrants: short,
        activeProEndsAtMs: null,
        now,
      }),
    ).toEqual({
      allowed: false,
      reason: "standard-too-short",
      requiresBundle: true,
    });
    expect(requiresBundle(short, now)).toBe(true);
    expect(requiresBundle(covering, now)).toBe(false);
  });

  it("refuses pro when the standard grant has not started yet", () => {
    // The gate, not the caller, tests the start. An end-only test would allow
    // this window - it reaches well past a full Pro term - and 0013 would then
    // abort the Pro insert (`standard.starts_at <= pro.starts_at` fails).
    const futureStart = standard(
      now + 1,
      addTerm(now + 1, { unit: "calendar_months", months: 3 }),
    );
    expect(standardCoversProWindow([futureStart], now)).toBe(false);
    expect(requiresBundle([futureStart], now)).toBe(true);
    expect(
      canPurchasePro({
        proOffered: true,
        standardGrants: [futureStart],
        activeProEndsAtMs: null,
        now,
      }),
    ).toEqual({
      allowed: false,
      reason: "standard-too-short",
      requiresBundle: true,
    });
    // Exactly at `now` the window is live: the boundary is inclusive, matching
    // `standard.starts_at <= NEW.starts_at` in 0013.
    expect(
      standardCoversProWindow([{ ...futureStart, startsAt: now }], now),
    ).toBe(true);
    expect(
      standardCoversProWindow([standard(now, addTerm(now, proTerm))], now),
    ).toBe(true);
  });

  it("refuses a pair assembled from two different grants (#66)", () => {
    // The failure the grants-typed gate eliminates: g1 is live now but ends
    // inside the Pro term, g2 covers the Pro term but starts after `now`. Their
    // `(min starts_at, max expires_at)` pair looks like a full covering window,
    // yet 0013 accepts no single row for the Pro insert - money taken, grant
    // refused. The gate must refuse the pair, so it never reaches 0013.
    const g1 = standard(now - 90 * day, now + 10 * day);
    const g2 = standard(now + day, addTerm(now, proTerm) + 30 * day);
    expect(g1.expiresAt).toBeLessThan(addTerm(now, proTerm));
    expect(g2.startsAt).toBeGreaterThan(now);
    expect(standardCoversProWindow([g1, g2], now)).toBe(false);
    expect(requiresBundle([g1, g2], now)).toBe(true);
    expect(
      canPurchasePro({
        proOffered: true,
        standardGrants: [g1, g2],
        activeProEndsAtMs: null,
        now,
      }),
    ).toEqual({
      allowed: false,
      reason: "standard-too-short",
      requiresBundle: true,
    });
  });

  it("allows pro when standard ends exactly at the end of a full pro term", () => {
    // Equality is allowed: 0013 tests `standard.expires_at >= pro.expires_at`.
    expect(standardCoversProWindow(covering, now)).toBe(true);
    expect(
      canPurchasePro({
        proOffered: true,
        standardGrants: covering,
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
        standardGrants: [standard(now, addTerm(now, term))],
        activeProEndsAtMs: null,
        now,
      }),
    ).toEqual({ allowed: true, requiresBundle: false });
  });

  it("refuses pro with no standard coverage at all", () => {
    expect(
      canPurchasePro({
        proOffered: true,
        standardGrants: [],
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
        standardGrants: covering,
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
        standardGrants: covering,
        activeProEndsAtMs: activeProEndsAtMs - 1,
        now,
      }),
    ).toMatchObject({ allowed: false, reason: "pro-window-active" });
  });

  it("allows pro once the stored window has ended", () => {
    expect(
      canPurchasePro({
        proOffered: true,
        standardGrants: covering,
        activeProEndsAtMs: now,
        now,
      }),
    ).toEqual({ allowed: true, requiresBundle: false });
  });
});

describe("standard coverage end", () => {
  const now = Date.parse("2026-02-01T00:00:00.000Z");

  it("is null when there is no standard grant at all", () => {
    expect(standardCoverageEndMs([], now)).toBeNull();
    expect(standardCoverageEndMs([pro(now - day, now + day)], now)).toBeNull();
  });

  it("is the expiry of the one live grant", () => {
    const endsAt = addTerm(now, termFor("standard-3m"));
    expect(standardCoverageEndMs([standard(now, endsAt)], now)).toBe(endsAt);
  });

  it("ignores a revoked grant", () => {
    const endsAt = addTerm(now, termFor("standard-3m"));
    const revoked = { ...standard(now, endsAt), revokedAt: now };
    expect(standardCoverageEndMs([revoked], now)).toBeNull();
  });

  it("takes the furthest expiry across overlapping grants", () => {
    const near = now + 30 * day;
    const far = addTerm(now, termFor("standard-12m"));
    expect(
      standardCoverageEndMs([standard(now, near), standard(now + day, far)], now),
    ).toBe(far);
  });

  it("counts a grant that has not started yet, and never returns a past instant", () => {
    // Coverage is contiguous by construction - a top-up appends to the end of the
    // current window - so the furthest expiry is the answer even when the row
    // that carries it has not begun. An expired term floors at `now`, which is
    // what keeps `standardRemainingDays` at `0` rather than negative.
    const future = addTerm(now, termFor("standard-6m"));
    expect(standardCoverageEndMs([standard(now + day, future)], now)).toBe(
      future,
    );
    expect(
      standardCoverageEndMs([standard(now - 90 * day, now - day)], now),
    ).toBe(now);
  });
});

describe("bundle purchase windows", () => {
  const iso = (instant: number): string => new Date(instant).toISOString();
  const term = termFor("bundle-standard-3m-pro");

  it("stacks the standard leg on 11 months of coverage", () => {
    // The case the withdrawn cap got wrong: $99 must add three months, not
    // leave the learner where they were.
    const now = Date.parse("2026-02-01T00:00:00.000Z");
    const coverageEnd = Date.parse("2027-01-01T00:00:00.000Z"); // 11 months
    const windows = bundleWindows(coverageEnd, now);
    expect(iso(windows.standard.startsAt)).toBe("2026-02-01T00:00:00.000Z");
    expect(iso(windows.standard.endsAt)).toBe("2027-04-01T00:00:00.000Z");
    expect(windows.standard.endsAt).toBe(
      addTerm(now, { unit: "calendar_months", months: 14 }),
    );
  });

  it("stacks on 2 months and stands alone with no coverage", () => {
    const now = Date.parse("2026-02-01T00:00:00.000Z");
    expect(bundleWindows(Date.parse("2026-04-01T00:00:00.000Z"), now)
      .standard.endsAt).toBe(Date.parse("2026-07-01T00:00:00.000Z"));
    // null-as-now: a first-time buyer gets a plain three-month term.
    const none = bundleWindows(null, now);
    expect(none.standard).toEqual(none.pro);
    expect(none.standard.startsAt).toBe(now);
    expect(none.standard.endsAt).toBe(addTerm(now, term));
  });

  it("covers the pro leg in the inversion case, where calendar arithmetic inverts", () => {
    // addTerm(coverageEnd, 3 months) is EARLIER than addTerm(now, 3 months) here,
    // because both clamp onto 30 April and the time of day decides. Without the
    // `max` the Standard leg would end before the Pro leg and 0013 would abort.
    const now = Date.parse("2026-01-30T18:00:00.000Z");
    const coverageEnd = Date.parse("2026-01-31T00:00:00.000Z");
    expect(addTerm(coverageEnd, term)).toBeLessThan(addTerm(now, term));
    const windows = bundleWindows(coverageEnd, now);
    expect(iso(windows.standard.endsAt)).toBe("2026-04-30T18:00:00.000Z");
    expect(windows.standard.endsAt).toBeGreaterThan(addTerm(coverageEnd, term));
    expect(windows.standard.endsAt).toBe(windows.pro.endsAt);
  });

  it("always starts both legs at one instant and never writes a short standard leg", () => {
    // AC-5's invariant, stated over coverage ends either side of `now` and
    // across a clamp, without any ordering assumption about month arithmetic.
    const now = Date.parse("2026-01-30T18:00:00.000Z");
    for (const coverageEnd of [
      null,
      now - 365 * day,
      now - day,
      now,
      now + day,
      Date.parse("2026-01-31T00:00:00.000Z"),
      Date.parse("2027-01-01T00:00:00.000Z"),
    ]) {
      const windows = bundleWindows(coverageEnd, now);
      expect(windows.standard.startsAt).toBe(windows.pro.startsAt);
      expect(windows.standard.startsAt).toBe(now);
      expect(windows.standard.endsAt).toBeGreaterThanOrEqual(
        windows.pro.endsAt,
      );
      // ...and 0013's own predicate agrees, through the gate's own function.
      expect(
        standardCoversProWindow(
          [
            standard(
              windows.standard.startsAt,
              windows.standard.endsAt,
            ),
          ],
          now,
        ),
      ).toBe(true);
    }
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
    // The bundle's Pro line is the residual `bundle - standard-3m`, and a line
    // amount is CHECKed `> 0`. Without this bound a price edit that dropped the
    // bundle to (or below) the Standard price would surface as a 500 from that
    // CHECK instead of as a failed test.
    expect(bundle).toBeGreaterThan(priceList["standard-3m"].amountMinor);
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

  it("refuses a pro grant whose standard coverage starts after the pro window", async () => {
    // The storage half of the gate's `startsAt <= now` test: a future-dated
    // Standard grant has an end that covers a full Pro term, so only the start
    // condition can refuse this insert - and 0013 does.
    const { userId, certificationId } = await seedUserAndCertification();
    const now = Date.parse("2026-02-01T00:00:00.000Z");
    const proExpires = addTerm(now, proTerm);
    await insertGrant({
      id: crypto.randomUUID(),
      userId,
      certificationId,
      feature: "standard",
      startsAt: now + day,
      expiresAt: proExpires,
    });
    // The gate refuses that same window, so gate and trigger agree.
    expect(
      standardCoversProWindow([standard(now + day, proExpires)], now),
    ).toBe(false);
    await expect(
      insertGrant({
        id: crypto.randomUUID(),
        userId,
        certificationId,
        feature: "pro",
        startsAt: now,
        expiresAt: proExpires,
      }),
    ).rejects.toThrow(/pro grant requires a standard grant/);
  });

  it("accepts both bundle legs written from one anchor, in the inversion case", async () => {
    // AC-5 at the storage layer. `coverageEnd` clamps into the same target day as
    // `now`, so `addTerm(coverageEnd, term)` is EARLIER than
    // `addTerm(now, term)`; only the `max` makes 0013 accept this pair.
    const { userId, certificationId } = await seedUserAndCertification();
    const now = Date.parse("2026-01-30T18:00:00.000Z");
    const coverageEnd = Date.parse("2026-01-31T00:00:00.000Z");
    await insertGrant({
      id: crypto.randomUUID(),
      userId,
      certificationId,
      feature: "standard",
      startsAt: Date.parse("2025-02-28T00:00:00.000Z"), // 11 months to coverageEnd
      expiresAt: coverageEnd,
    });
    const windows = bundleWindows(coverageEnd, now);
    expect(addTerm(coverageEnd, termFor("bundle-standard-3m-pro"))).toBeLessThan(
      windows.pro.endsAt,
    );

    const legInsert = (feature: "standard" | "pro", window: typeof windows.pro) =>
      env.DB.prepare(
        `INSERT INTO learner_access_grants (
           id, user_id, certification_id, feature, starts_at, expires_at,
           revoked_at, created_at, sku, source, operation_id, created_by_user_id
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'bundle-standard-3m-pro', 'bundle', ?, NULL)`,
      ).bind(
        crypto.randomUUID(),
        userId,
        certificationId,
        feature,
        window.startsAt,
        window.endsAt,
        now,
        `test-bundle:${feature}:${crypto.randomUUID()}`,
      );
    await env.DB.batch([legInsert("standard", windows.standard), legInsert("pro", windows.pro)]);

    const rows = await env.DB.prepare(
      `SELECT feature, starts_at, expires_at FROM learner_access_grants
       WHERE user_id = ? AND sku = 'bundle-standard-3m-pro'
       ORDER BY feature`,
    )
      .bind(userId)
      .all<{ feature: string; starts_at: number; expires_at: number }>();
    expect(rows.results).toHaveLength(2);
    const [pro, standard] = rows.results; // "pro" sorts before "standard"
    expect(standard!.starts_at).toBe(pro!.starts_at);
    expect(standard!.starts_at).toBe(now);
    expect(standard!.expires_at).toBeGreaterThanOrEqual(pro!.expires_at);
    expect(standard!.expires_at).toBe(windows.standard.endsAt);
  });

  it("refuses one operation id for two grant rows", async () => {
    // AC-5 says both bundle legs carry one operation id. They cannot: the column
    // is UNIQUE and `audit_events.operation_id` is a primary key. Recorded here
    // so settlement cannot ship a shared id and discover it in production.
    const { userId, certificationId } = await seedUserAndCertification();
    const shared = `test-access:${crypto.randomUUID()}`;
    await insertGrant({
      id: crypto.randomUUID(),
      userId,
      certificationId,
      feature: "standard",
      startsAt: start,
      expiresAt: start + 180 * day,
      operationId: shared,
    });
    await expect(
      insertGrant({
        id: crypto.randomUUID(),
        userId,
        certificationId,
        feature: "pro",
        startsAt: start,
        expiresAt: start + 90 * day,
        operationId: shared,
      }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
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
