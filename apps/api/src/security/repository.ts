import type {
  D1ReadSession,
  SecurityDatabase,
} from "./database.ts";
import { isValidTokenDigest } from "./database.ts";
import type { MfaAssurance, StaffMfaPolicy } from "./mfa.ts";
import { getMfaFailure } from "./mfa.ts";

export interface ActiveApplicationSession extends MfaAssurance {
  userId: string;
  tokenDigest: string;
  expiresAt: number;
}

export type AuthorizationFailure =
  | "invalid-session"
  | "not-staff"
  | "insufficient-role"
  | "mfa-policy-unconfigured"
  | "mfa-policy-invalid"
  | "mfa-assurance-missing"
  | "mfa-assurance-unsupported"
  | "mfa-assurance-stale"
  | "certification-not-found"
  | "certification-unassigned";

export type AuthorizationResult =
  | { allowed: true; userId: string; role: "global_admin" | "manager" }
  | { allowed: false; reason: AuthorizationFailure };

interface SessionRow {
  token_digest: string;
  user_id: string;
  expires_at: number;
  mfa_method: string | null;
  mfa_verified_at: number | null;
}

interface RoleRow {
  role: "global_admin" | "manager";
}

export async function findUserForIdentity(
  database: SecurityDatabase,
  issuer: string,
  subject: string,
): Promise<string | null> {
  const session = database.withSession("first-primary");
  const identity = await session
    .prepare(
      `SELECT user_id
       FROM auth_identities
       WHERE issuer = ? AND subject = ?`,
    )
    .bind(issuer, subject)
    .first<{ user_id: string }>();

  return identity?.user_id ?? null;
}

export async function findActiveApplicationSession(
  database: SecurityDatabase,
  tokenDigest: string,
  now: number,
): Promise<ActiveApplicationSession | null> {
  if (!isValidTokenDigest(tokenDigest)) return null;

  const session = database.withSession("first-primary");
  const row = await session
    .prepare(
      `SELECT s.token_digest, s.user_id, s.expires_at,
              s.mfa_method, s.mfa_verified_at
       FROM app_sessions AS s
       JOIN users AS u ON u.id = s.user_id
       WHERE s.token_digest = ?
         AND s.revoked_at IS NULL
         AND s.expires_at > ?
         AND u.status = 'active'`,
    )
    .bind(tokenDigest, now)
    .first<SessionRow>();

  if (!row) return null;
  return {
    tokenDigest: row.token_digest,
    userId: row.user_id,
    expiresAt: row.expires_at,
    method: row.mfa_method,
    verifiedAt: row.mfa_verified_at,
  };
}

async function findActiveRole(
  session: D1ReadSession,
  userId: string,
): Promise<RoleRow | null> {
  return session
    .prepare(
      `SELECT role
       FROM staff_roles
       WHERE user_id = ? AND active = 1`,
    )
    .bind(userId)
    .first<RoleRow>();
}

function mfaFailure(
  session: ActiveApplicationSession,
  now: number,
  policy: StaffMfaPolicy | undefined,
): AuthorizationFailure | null {
  const failure = getMfaFailure(session, now, policy);
  if (!failure) return null;
  return `mfa-${failure}` as AuthorizationFailure;
}

export async function authorizeGlobalAdmin(
  database: SecurityDatabase,
  tokenDigest: string,
  now: number,
  policy: StaffMfaPolicy | undefined,
): Promise<AuthorizationResult> {
  const session = await findActiveApplicationSession(database, tokenDigest, now);
  if (!session) return { allowed: false, reason: "invalid-session" };

  const primary = database.withSession("first-primary");
  const role = await findActiveRole(primary, session.userId);
  if (!role) return { allowed: false, reason: "not-staff" };
  if (role.role !== "global_admin") {
    return { allowed: false, reason: "insufficient-role" };
  }

  const failure = mfaFailure(session, now, policy);
  if (failure) return { allowed: false, reason: failure };
  return { allowed: true, userId: session.userId, role: role.role };
}

export async function authorizeCertification(
  database: SecurityDatabase,
  tokenDigest: string,
  certificationId: string,
  now: number,
  policy: StaffMfaPolicy | undefined,
): Promise<AuthorizationResult> {
  const session = await findActiveApplicationSession(database, tokenDigest, now);
  if (!session) return { allowed: false, reason: "invalid-session" };

  const primary = database.withSession("first-primary");
  const role = await findActiveRole(primary, session.userId);
  if (!role) return { allowed: false, reason: "not-staff" };

  const failure = mfaFailure(session, now, policy);
  if (failure) return { allowed: false, reason: failure };

  const certification = await primary
    .prepare("SELECT id FROM certifications WHERE id = ?")
    .bind(certificationId)
    .first<{ id: string }>();
  if (!certification) {
    return { allowed: false, reason: "certification-not-found" };
  }

  if (role.role === "global_admin") {
    return { allowed: true, userId: session.userId, role: role.role };
  }

  const assignment = await primary
    .prepare(
      `SELECT 1 AS assigned
       FROM manager_certification_assignments
       WHERE manager_user_id = ?
         AND certification_id = ?
         AND active = 1`,
    )
    .bind(session.userId, certificationId)
    .first<{ assigned: number }>();

  return assignment
    ? { allowed: true, userId: session.userId, role: role.role }
    : { allowed: false, reason: "certification-unassigned" };
}
