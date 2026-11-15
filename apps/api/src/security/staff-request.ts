import type { StaffRole } from "@certpath/contracts";
import type { SecurityDatabase } from "./database.ts";
import {
  canCapability,
  type CapabilityFailure,
  type CapabilityResource,
} from "./capabilities.ts";
import type { StaffMfaPolicy } from "./mfa.ts";
import { sessionCookieToken, sessionDigest } from "./http-session.ts";
import {
  authorizeStaffSession,
  findActiveApplicationSession,
  type AuthorizationFailure,
} from "./repository.ts";

// Session plus capability, in that order, for every admin learner-support route.
//
// `canCapability` decides; this module re-validates the live session, the active
// role and the MFA assurance first, so a disabled account or a revoked role is
// refused before any read.

export interface StaffRequester {
  tokenDigest: string;
  userId: string;
  role: StaffRole;
}

export type StaffRequestFailure = AuthorizationFailure | CapabilityFailure;

export type StaffRequestResult =
  | { ok: true; requester: StaffRequester }
  | { ok: false; reason: StaffRequestFailure };

export async function requireCapability(
  database: SecurityDatabase,
  cookieHeader: string | null,
  capability: string,
  resource: CapabilityResource,
  now: number,
  policy: StaffMfaPolicy | undefined,
): Promise<StaffRequestResult> {
  const rawToken = sessionCookieToken(cookieHeader);
  if (!rawToken) return { ok: false, reason: "invalid-session" };
  const tokenDigest = await sessionDigest(rawToken);
  const session = await findActiveApplicationSession(database, tokenDigest, now);
  if (!session) return { ok: false, reason: "invalid-session" };

  const authorization = await authorizeStaffSession(
    database,
    tokenDigest,
    now,
    policy,
  );
  if (!authorization.allowed) return { ok: false, reason: authorization.reason };

  const decision = await canCapability(
    database,
    { userId: authorization.userId, role: authorization.role },
    capability,
    resource,
  );
  if (!decision.allowed) return { ok: false, reason: decision.reason };

  return {
    ok: true,
    requester: {
      tokenDigest,
      userId: authorization.userId,
      role: authorization.role,
    },
  };
}

export interface StaffRoleRecord {
  role: StaffRole;
  active: boolean;
}

/**
 * The role row for a live session, active or not. `GET /api/admin/capabilities`
 * distinguishes "never staff" (401) from "staff role withdrawn" (404) with it.
 */
export async function findStaffRoleRecord(
  database: SecurityDatabase,
  userId: string,
): Promise<StaffRoleRecord | null> {
  const row = await database
    .withSession("first-primary")
    .prepare("SELECT role, active FROM staff_roles WHERE user_id = ?")
    .bind(userId)
    .first<{ role: StaffRole; active: number }>();
  return row ? { role: row.role, active: row.active === 1 } : null;
}
