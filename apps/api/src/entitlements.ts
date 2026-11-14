// Entitlement evaluation for learner access.
//
// Pure and runtime-neutral so the same predicates run in the Worker, in tests,
// and in any future admin reporting. Storage lives in `learner_access_grants`;
// this module answers "what may this learner do, right now?".
//
// Rules: docs/decisions/0005-readiness-and-access-lifecycle.md.

export const graceWindowMs = 15 * 24 * 60 * 60 * 1000;

export type EntitlementFeature = "standard" | "pro";

/** `grace` is read-only: results and explanations, never new work. */
export type AccessState = "active" | "grace" | "expired";

export type Capability =
  | "practice"
  | "mock"
  | "adaptive-mock"
  | "results"
  | "explanations";

export type AccessGrantRecord = {
  feature: EntitlementFeature;
  startsAt: number;
  expiresAt: number;
  revokedAt: number | null;
};

export type FeatureAccess = {
  state: AccessState;
  /** Earliest start of the grant providing the state, when one exists. */
  startsAt: number | null;
  /** Latest end of the grant providing the state, when one exists. */
  endsAt: number | null;
  /** End of the read-only window; only set while `state` is `grace`. */
  graceEndsAt: number | null;
};

export type AccessSummary = {
  standard: FeatureAccess;
  pro: FeatureAccess;
};

const expired: FeatureAccess = {
  state: "expired",
  startsAt: null,
  endsAt: null,
  graceEndsAt: null,
};

export function evaluateFeature(
  grants: readonly AccessGrantRecord[],
  feature: EntitlementFeature,
  at: number,
): FeatureAccess {
  const relevant = grants.filter(
    (grant) => grant.feature === feature && grant.revokedAt === null,
  );
  if (relevant.length === 0) return expired;

  const active = relevant
    .filter((grant) => grant.startsAt <= at && at < grant.expiresAt)
    .sort((left, right) => left.startsAt - right.startsAt);
  if (active.length > 0) {
    return {
      state: "active",
      startsAt: active[0]!.startsAt,
      endsAt: active.reduce(
        (latest, grant) => Math.max(latest, grant.expiresAt),
        active[0]!.expiresAt,
      ),
      graceEndsAt: null,
    };
  }

  const inGrace = relevant
    .filter(
      (grant) =>
        grant.expiresAt <= at && grant.expiresAt + graceWindowMs > at,
    )
    .sort((left, right) => right.expiresAt - left.expiresAt);
  if (inGrace.length > 0) {
    const latest = inGrace[0]!;
    return {
      state: "grace",
      startsAt: latest.startsAt,
      endsAt: latest.expiresAt,
      graceEndsAt: latest.expiresAt + graceWindowMs,
    };
  }

  return expired;
}

export function evaluateAccess(
  grants: readonly AccessGrantRecord[],
  at: number,
): AccessSummary {
  return {
    standard: evaluateFeature(grants, "standard", at),
    pro: evaluateFeature(grants, "pro", at),
  };
}

/**
 * Grace is deliberately excluded from `practice` and `mock`: a learner in grace
 * may re-read what they already answered, and nothing more.
 */
export function can(
  access: AccessSummary,
  capability: Capability,
): boolean {
  const standard = access.standard.state;
  const pro = access.pro.state;
  switch (capability) {
    case "results":
    case "explanations":
      return standard !== "expired" || pro !== "expired";
    case "practice":
    case "mock":
      return standard === "active";
    case "adaptive-mock":
      return standard === "active" && pro === "active";
  }
}

/** Whole days left in the read-only window, or 0 when not in grace. */
export function graceDaysRemaining(
  feature: FeatureAccess,
  at: number,
): number {
  if (feature.state !== "grace" || feature.graceEndsAt === null) return 0;
  return Math.max(0, Math.ceil((feature.graceEndsAt - at) / 86_400_000));
}
