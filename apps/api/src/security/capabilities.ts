import type { StaffCapability, StaffRole } from "@certpath/contracts";
import type { D1Value, SecurityDatabase } from "./database.ts";
import type { StaffMfaPolicy } from "./mfa.ts";

// One closed capability table for the two staff roles.
//
// Every admin route asks `canCapability(...)` for a decision, and every admin
// write additionally carries a statement guard (`certificationGuard` for content,
// `learnerGuard` for learner support) so a revoked assignment or a disabled
// account takes effect on the next request even if a route forgot to ask.
//
// Naming note: this module exports `canCapability`, not `can`. `entitlements.ts`
// already exports `can(access, capability)` for learners; a second `can` with a
// different signature in every module that needs both is a readability trap.
//
// Rules: docs/decisions/0004-staff-capabilities-and-learner-data.md and
// docs/admin-capabilities.md.

export type { StaffCapability, StaffRole };

export type CapabilityResourceKind = "platform" | "certification" | "learner";

export type CapabilityResource =
  | { kind: "platform" }
  | {
      kind: "certification";
      certificationId: string;
      /** The destination certification, when content is being moved. */
      proposedCertificationId?: string | null;
    }
  | { kind: "learner"; learnerUserId: string };

export interface StaffActor {
  userId: string;
  role: StaffRole;
}

export type CapabilityFailure =
  | "insufficient-role"
  | "unknown-capability"
  | "resource-kind-mismatch"
  | "certification-not-found"
  | "certification-unassigned"
  | "learner-not-found";

export type CapabilityDecision =
  | { allowed: true }
  | { allowed: false; reason: CapabilityFailure };

interface CapabilityRule {
  resource: CapabilityResourceKind;
  roles: Record<StaffRole, boolean>;
}

const platform: CapabilityRule = {
  resource: "platform",
  roles: { global_admin: true, manager: true },
};
const content: CapabilityRule = {
  resource: "certification",
  roles: { global_admin: true, manager: true },
};
const learnerSupport: CapabilityRule = {
  resource: "learner",
  roles: { global_admin: true, manager: true },
};
const globalAdminOnly = (resource: CapabilityResourceKind): CapabilityRule => ({
  resource,
  roles: { global_admin: true, manager: false },
});

/**
 * `Record<StaffCapability, CapabilityRule>` on purpose: a new capability without
 * a rule is a type error, and an unknown string at runtime is denied.
 */
export const capabilityMatrix: Record<StaffCapability, CapabilityRule> = {
  "content.read": content,
  "content.manage": content,
  "learner.lookup": platform,
  "learner.read": learnerSupport,
  "learner.reveal": learnerSupport,
  "learner.deactivate": learnerSupport,
  "learner.contact.correct": learnerSupport,
  "learner.support.email": learnerSupport,
  "learner.support.history": learnerSupport,
  "commerce.read": globalAdminOnly("platform"),
  "access.grant": globalAdminOnly("platform"),
  "staff.manage": globalAdminOnly("platform"),
  "security.manage": globalAdminOnly("platform"),
  "audit.read": globalAdminOnly("platform"),
};

export const staffCapabilities = Object.keys(
  capabilityMatrix,
) as StaffCapability[];

export function capabilitiesForRole(role: StaffRole): StaffCapability[] {
  return staffCapabilities
    .filter((capability) => capabilityMatrix[capability].roles[role])
    .sort();
}

async function certificationExists(
  database: SecurityDatabase,
  certificationId: string,
): Promise<boolean> {
  const row = await database
    .withSession("first-primary")
    .prepare("SELECT 1 AS present FROM certifications WHERE id = ?")
    .bind(certificationId)
    .first<{ present: number }>();
  return row !== null;
}

async function managerAssigned(
  database: SecurityDatabase,
  managerUserId: string,
  certificationId: string,
): Promise<boolean> {
  const row = await database
    .withSession("first-primary")
    .prepare(
      `SELECT 1 AS assigned
       FROM manager_certification_assignments
       WHERE manager_user_id = ?
         AND certification_id = ?
         AND active = 1`,
    )
    .bind(managerUserId, certificationId)
    .first<{ assigned: number }>();
  return row !== null;
}

/**
 * A learner subject is any account that does not hold an active staff role, so a
 * staff account is reported as `learner-not-found` - indistinguishable from a
 * missing account.
 */
async function learnerSubjectExists(
  database: SecurityDatabase,
  learnerUserId: string,
): Promise<boolean> {
  const row = await database
    .withSession("first-primary")
    .prepare(
      `SELECT 1 AS present
       FROM users AS subject
       WHERE subject.id = ?
         AND NOT EXISTS (
           SELECT 1 FROM staff_roles AS subject_role
           WHERE subject_role.user_id = subject.id AND subject_role.active = 1
         )`,
    )
    .bind(learnerUserId)
    .first<{ present: number }>();
  return row !== null;
}

/**
 * The single capability decision. It never reads the session; the session is
 * validated by `requireCapability` and by the statement guards.
 */
export async function canCapability(
  database: SecurityDatabase,
  actor: StaffActor,
  capability: string,
  resource: CapabilityResource,
): Promise<CapabilityDecision> {
  const rule = capabilityMatrix[capability as StaffCapability] as
    | CapabilityRule
    | undefined;
  if (!rule) return { allowed: false, reason: "unknown-capability" };
  if (!rule.roles[actor.role]) {
    return { allowed: false, reason: "insufficient-role" };
  }
  if (rule.resource !== resource.kind) {
    return { allowed: false, reason: "resource-kind-mismatch" };
  }

  if (resource.kind === "platform") return { allowed: true };

  if (resource.kind === "learner") {
    return (await learnerSubjectExists(database, resource.learnerUserId))
      ? { allowed: true }
      : { allowed: false, reason: "learner-not-found" };
  }

  if (!(await certificationExists(database, resource.certificationId))) {
    return { allowed: false, reason: "certification-not-found" };
  }
  if (actor.role === "global_admin") return { allowed: true };
  if (
    !(await managerAssigned(
      database,
      actor.userId,
      resource.certificationId,
    ))
  ) {
    return { allowed: false, reason: "certification-unassigned" };
  }

  const proposed = resource.proposedCertificationId ?? null;
  if (proposed !== null && proposed !== resource.certificationId) {
    if (!(await certificationExists(database, proposed))) {
      return { allowed: false, reason: "certification-not-found" };
    }
    if (!(await managerAssigned(database, actor.userId, proposed))) {
      return { allowed: false, reason: "certification-unassigned" };
    }
  }
  return { allowed: true };
}

export interface StatementGuard {
  sql: string;
  values: D1Value[];
}

/**
 * Statement-level content scope: the live session, the active role and the
 * assignment are re-read inside the write itself, for the current certification
 * and, when it differs, for the proposed one. This is the one truth for content
 * scope; `content.ts#createScopeGuard` delegates here with no proposed value.
 */
export function certificationGuard(
  tokenDigest: string,
  certificationId: string,
  proposedCertificationId: string | null,
  now: number,
  policy: StaffMfaPolicy,
): StatementGuard {
  const placeholders = policy.allowedMethods.map(() => "?").join(", ");
  const hasProposed =
    proposedCertificationId !== null &&
    proposedCertificationId !== certificationId;
  const proposedClause = hasProposed
    ? `
        AND (
          scope_role.role = 'global_admin'
          OR EXISTS (
            SELECT 1
            FROM manager_certification_assignments AS proposed_assignment
            WHERE proposed_assignment.manager_user_id = scope_user.id
              AND proposed_assignment.certification_id = ?
              AND proposed_assignment.active = 1
          )
        )`
    : "";
  return {
    sql: `EXISTS (
      SELECT 1
      FROM app_sessions AS scope_session
      JOIN users AS scope_user ON scope_user.id = scope_session.user_id
      JOIN staff_roles AS scope_role ON scope_role.user_id = scope_user.id
      WHERE scope_session.token_digest = ?
        AND scope_session.revoked_at IS NULL
        AND scope_session.expires_at > ?
        AND scope_user.status = 'active'
        AND scope_role.active = 1
        AND scope_session.mfa_verified_at BETWEEN ? AND ?
        AND scope_session.mfa_method IN (${placeholders})
        AND (
          scope_role.role = 'global_admin'
          OR (
            scope_role.role = 'manager'
            AND EXISTS (
              SELECT 1
              FROM manager_certification_assignments AS scope_assignment
              WHERE scope_assignment.manager_user_id = scope_user.id
                AND scope_assignment.certification_id = ?
                AND scope_assignment.active = 1
            )
          )
        )${proposedClause}
    )`,
    values: [
      tokenDigest,
      now,
      now - policy.maxAgeMs,
      now,
      ...policy.allowedMethods,
      certificationId,
      ...(hasProposed ? [proposedCertificationId] : []),
    ],
  };
}
