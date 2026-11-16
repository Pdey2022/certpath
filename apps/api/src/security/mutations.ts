import type { SecurityDatabase } from "./database.ts";
import { isValidTokenDigest } from "./database.ts";
import type {
  AuthorizationFailure,
  AuthorizationResult,
} from "./repository.ts";
import {
  authorizeGlobalAdmin,
  findActiveApplicationSession,
} from "./repository.ts";
import type { StaffMfaPolicy } from "./mfa.ts";
import { isConfiguredMfaPolicy } from "./mfa.ts";
import { globalAdminGuard } from "./capabilities.ts";

export type MutationResult =
  | { applied: true }
  | {
      applied: false;
      reason:
        | AuthorizationFailure
        | "invalid-operation"
        | "invalid-input"
        | "conflict";
    };

export interface MutationMetadata {
  operationId: string;
  reason: string;
  now: number;
}

interface AdminActor {
  userId: string;
}

function isValidOperation(metadata: MutationMetadata): boolean {
  return (
    /^[a-zA-Z0-9:_-]{1,128}$/.test(metadata.operationId) &&
    metadata.reason.trim().length > 0 &&
    metadata.reason.length <= 500 &&
    Number.isSafeInteger(metadata.now)
  );
}

async function authorizeMutation(
  database: SecurityDatabase,
  tokenDigest: string,
  metadata: MutationMetadata,
  policy: StaffMfaPolicy | undefined,
): Promise<
  | { allowed: true; actor: AdminActor; policy: StaffMfaPolicy }
  | { allowed: false; result: MutationResult }
> {
  if (!isValidOperation(metadata)) {
    return { allowed: false, result: { applied: false, reason: "invalid-operation" } };
  }
  if (!isConfiguredMfaPolicy(policy)) {
    return {
      allowed: false,
      result: { applied: false, reason: "mfa-policy-unconfigured" },
    };
  }
  const authorization: AuthorizationResult = await authorizeGlobalAdmin(
    database,
    tokenDigest,
    metadata.now,
    policy,
  );
  if (!authorization.allowed) {
    return {
      allowed: false,
      result: { applied: false, reason: authorization.reason },
    };
  }
  return {
    allowed: true,
    actor: { userId: authorization.userId },
    policy,
  };
}

export async function provisionInitialGlobalAdmin(
  database: SecurityDatabase,
  input: {
    issuer: string;
    subject: string;
    operatorRef: string;
    operationId: string;
    now: number;
  },
): Promise<MutationResult> {
  if (
    !/^[a-zA-Z0-9:_-]{1,128}$/.test(input.operationId) ||
    input.issuer.length === 0 ||
    input.issuer.length > 512 ||
    input.subject.length === 0 ||
    input.subject.length > 512 ||
    input.operatorRef.trim().length === 0 ||
    input.operatorRef.length > 128 ||
    !Number.isSafeInteger(input.now)
  ) {
    return { applied: false, reason: "invalid-input" };
  }

  const result = await database
    .prepare(
      `INSERT INTO staff_roles (
         user_id, role, active, changed_by_user_id, changed_by_ref,
         operation_id, reason, changed_at
       )
       SELECT identity.user_id, 'global_admin', 1, NULL, ?, ?, ? , ?
       FROM auth_identities AS identity
       JOIN users AS target ON target.id = identity.user_id
       JOIN initial_admin_provisioning AS bootstrap
         ON bootstrap.bootstrap_key = 'initial-global-admin'
       WHERE identity.issuer = ?
         AND identity.subject = ?
         AND target.status = 'active'
         AND bootstrap.consumed_at IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM staff_roles AS existing_admin
           JOIN users AS admin_user ON admin_user.id = existing_admin.user_id
           WHERE existing_admin.role = 'global_admin'
             AND existing_admin.active = 1
             AND admin_user.status = 'active'
         )
         AND NOT EXISTS (
           SELECT 1 FROM staff_roles WHERE user_id = identity.user_id
         )
       RETURNING user_id`,
    )
    .bind(
      input.operatorRef,
      input.operationId,
      "Initial Global Admin provisioning",
      input.now,
      input.issuer,
      input.subject,
    )
    .all<{ user_id: string }>();

  return result.results.length === 1
    ? { applied: true }
    : { applied: false, reason: "conflict" };
}

async function appointStaffRole(
  database: SecurityDatabase,
  tokenDigest: string,
  targetUserId: string,
  role: "global_admin" | "manager",
  metadata: MutationMetadata,
  policy: StaffMfaPolicy | undefined,
): Promise<MutationResult> {
  if (!isValidTokenDigest(tokenDigest)) {
    return { applied: false, reason: "invalid-session" };
  }
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(targetUserId)) {
    return { applied: false, reason: "invalid-input" };
  }
  const auth = await authorizeMutation(database, tokenDigest, metadata, policy);
  if (!auth.allowed) return auth.result;

  const guard = globalAdminGuard(tokenDigest, metadata.now, auth.policy);
  const result = await database
    .prepare(
      `INSERT INTO staff_roles (
         user_id, role, active, changed_by_user_id, changed_by_ref,
         operation_id, reason, changed_at
       )
       SELECT target.id, ?, 1, actor_session.user_id, NULL, ?, ?, ?
       FROM users AS target
       JOIN app_sessions AS actor_session
         ON actor_session.token_digest = ?
       WHERE target.id = ?
         AND target.status = 'active'
         AND ${guard.sql}
       ON CONFLICT(user_id) DO UPDATE SET
         role = excluded.role,
         active = 1,
         changed_by_user_id = excluded.changed_by_user_id,
         changed_by_ref = NULL,
         operation_id = excluded.operation_id,
         reason = excluded.reason,
         changed_at = excluded.changed_at
       WHERE (staff_roles.active = 0 OR staff_roles.role <> excluded.role)
         AND (
           excluded.role <> 'manager'
           OR staff_roles.role <> 'global_admin'
           OR staff_roles.active <> 1
           OR EXISTS (
             SELECT 1
             FROM staff_roles AS other_role
             JOIN users AS other_user ON other_user.id = other_role.user_id
             WHERE other_role.role = 'global_admin'
               AND other_role.active = 1
               AND other_role.user_id <> staff_roles.user_id
               AND other_user.status = 'active'
           )
         )
       RETURNING user_id`,
    )
    .bind(
      role,
      metadata.operationId,
      metadata.reason,
      metadata.now,
      tokenDigest,
      targetUserId,
      ...guard.values,
    )
    .all<{ user_id: string }>();

  return result.results.length === 1
    ? { applied: true }
    : { applied: false, reason: "conflict" };
}

export function appointGlobalAdmin(
  database: SecurityDatabase,
  tokenDigest: string,
  targetUserId: string,
  metadata: MutationMetadata,
  policy: StaffMfaPolicy | undefined,
): Promise<MutationResult> {
  return appointStaffRole(
    database,
    tokenDigest,
    targetUserId,
    "global_admin",
    metadata,
    policy,
  );
}

export function assignManagerRole(
  database: SecurityDatabase,
  tokenDigest: string,
  targetUserId: string,
  metadata: MutationMetadata,
  policy: StaffMfaPolicy | undefined,
): Promise<MutationResult> {
  return appointStaffRole(
    database,
    tokenDigest,
    targetUserId,
    "manager",
    metadata,
    policy,
  );
}

export async function revokeStaffRole(
  database: SecurityDatabase,
  tokenDigest: string,
  targetUserId: string,
  metadata: MutationMetadata,
  policy: StaffMfaPolicy | undefined,
): Promise<MutationResult> {
  if (!isValidTokenDigest(tokenDigest)) {
    return { applied: false, reason: "invalid-session" };
  }
  const auth = await authorizeMutation(database, tokenDigest, metadata, policy);
  if (!auth.allowed) return auth.result;

  const guard = globalAdminGuard(tokenDigest, metadata.now, auth.policy);
  const result = await database
    .prepare(
      `UPDATE staff_roles
       SET active = 0,
           changed_by_user_id = ?,
           changed_by_ref = NULL,
           operation_id = ?,
           reason = ?,
           changed_at = ?
       WHERE user_id = ?
         AND active = 1
         AND ${guard.sql}
         AND (
           role <> 'global_admin'
           OR EXISTS (
             SELECT 1
             FROM staff_roles AS other_role
             JOIN users AS other_user ON other_user.id = other_role.user_id
             WHERE other_role.role = 'global_admin'
               AND other_role.active = 1
               AND other_role.user_id <> staff_roles.user_id
               AND other_user.status = 'active'
           )
         )
       RETURNING user_id`,
    )
    .bind(
      auth.actor.userId,
      metadata.operationId,
      metadata.reason,
      metadata.now,
      targetUserId,
      ...guard.values,
    )
    .all<{ user_id: string }>();

  return result.results.length === 1
    ? { applied: true }
    : { applied: false, reason: "conflict" };
}

export async function createCertificationRoot(
  database: SecurityDatabase,
  tokenDigest: string,
  input: {
    id: string;
    slug: string;
    displayName: string;
  },
  metadata: MutationMetadata,
  policy: StaffMfaPolicy | undefined,
): Promise<MutationResult> {
  if (
    !/^[a-zA-Z0-9:_-]{1,128}$/.test(input.id) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug) ||
    input.displayName.trim().length === 0 ||
    input.displayName.length > 160
  ) {
    return { applied: false, reason: "invalid-input" };
  }
  const auth = await authorizeMutation(database, tokenDigest, metadata, policy);
  if (!auth.allowed) return auth.result;
  const guard = globalAdminGuard(tokenDigest, metadata.now, auth.policy);
  const result = await database
    .prepare(
      `INSERT INTO certifications (
         id, slug, display_name, created_by_user_id, created_operation_id, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?
       WHERE ${guard.sql}
       RETURNING id`,
    )
    .bind(
      input.id,
      input.slug,
      input.displayName,
      auth.actor.userId,
      metadata.operationId,
      metadata.now,
      ...guard.values,
    )
    .all<{ id: string }>();

  return result.results.length === 1
    ? { applied: true }
    : { applied: false, reason: "conflict" };
}

export async function assignManagerCertification(
  database: SecurityDatabase,
  tokenDigest: string,
  managerUserId: string,
  certificationId: string,
  metadata: MutationMetadata,
  policy: StaffMfaPolicy | undefined,
): Promise<MutationResult> {
  if (
    !/^[a-zA-Z0-9:_-]{1,128}$/.test(managerUserId) ||
    !/^[a-zA-Z0-9:_-]{1,128}$/.test(certificationId)
  ) {
    return { applied: false, reason: "invalid-input" };
  }
  const auth = await authorizeMutation(database, tokenDigest, metadata, policy);
  if (!auth.allowed) return auth.result;
  const guard = globalAdminGuard(tokenDigest, metadata.now, auth.policy);
  const result = await database
    .prepare(
      `INSERT INTO manager_certification_assignments (
         manager_user_id, certification_id, active, changed_by_user_id,
         operation_id, reason, changed_at
       )
       SELECT manager.id, certification.id, 1, ?, ?, ?, ?
       FROM users AS manager
       JOIN staff_roles AS manager_role
         ON manager_role.user_id = manager.id
        AND manager_role.role = 'manager'
        AND manager_role.active = 1
       JOIN certifications AS certification ON certification.id = ?
       WHERE manager.id = ?
         AND manager.status = 'active'
         AND ${guard.sql}
       ON CONFLICT(manager_user_id, certification_id) DO UPDATE SET
         active = 1,
         changed_by_user_id = excluded.changed_by_user_id,
         operation_id = excluded.operation_id,
         reason = excluded.reason,
         changed_at = excluded.changed_at
       WHERE manager_certification_assignments.active = 0
       RETURNING manager_user_id`,
    )
    .bind(
      auth.actor.userId,
      metadata.operationId,
      metadata.reason,
      metadata.now,
      certificationId,
      managerUserId,
      ...guard.values,
    )
    .all<{ manager_user_id: string }>();

  return result.results.length === 1
    ? { applied: true }
    : { applied: false, reason: "conflict" };
}

export async function revokeManagerCertification(
  database: SecurityDatabase,
  tokenDigest: string,
  managerUserId: string,
  certificationId: string,
  metadata: MutationMetadata,
  policy: StaffMfaPolicy | undefined,
): Promise<MutationResult> {
  if (
    !/^[a-zA-Z0-9:_-]{1,128}$/.test(managerUserId) ||
    !/^[a-zA-Z0-9:_-]{1,128}$/.test(certificationId)
  ) {
    return { applied: false, reason: "invalid-input" };
  }
  const auth = await authorizeMutation(database, tokenDigest, metadata, policy);
  if (!auth.allowed) return auth.result;
  const guard = globalAdminGuard(tokenDigest, metadata.now, auth.policy);
  const result = await database
    .prepare(
      `UPDATE manager_certification_assignments
       SET active = 0,
           changed_by_user_id = ?,
           operation_id = ?,
           reason = ?,
           changed_at = ?
       WHERE manager_user_id = ?
         AND certification_id = ?
         AND active = 1
         AND ${guard.sql}
         AND EXISTS (
           SELECT 1 FROM staff_roles AS manager_role
           JOIN users AS manager ON manager.id = manager_role.user_id
           WHERE manager_role.user_id = manager_certification_assignments.manager_user_id
             AND manager_role.role = 'manager'
             AND manager_role.active = 1
             AND manager.status = 'active'
         )
       RETURNING manager_user_id`,
    )
    .bind(
      auth.actor.userId,
      metadata.operationId,
      metadata.reason,
      metadata.now,
      managerUserId,
      certificationId,
      ...guard.values,
    )
    .all<{ manager_user_id: string }>();

  return result.results.length === 1
    ? { applied: true }
    : { applied: false, reason: "conflict" };
}

export async function revokeOwnApplicationSession(
  database: SecurityDatabase,
  tokenDigest: string,
  now: number,
  operationId: string,
): Promise<boolean> {
  if (
    !isValidTokenDigest(tokenDigest) ||
    !/^[a-zA-Z0-9:_-]{1,128}$/.test(operationId) ||
    !Number.isSafeInteger(now)
  ) {
    return false;
  }

  const result = await database
    .prepare(
      `UPDATE app_sessions
       SET revoked_at = ?,
           revocation_operation_id = ?,
           revoked_by_user_id = user_id
       WHERE token_digest = ?
         AND revoked_at IS NULL
       RETURNING token_digest`,
    )
    .bind(now, operationId, tokenDigest)
    .all<{ token_digest: string }>();
  return result.results.length === 1;
}

export async function hasActiveSession(
  database: SecurityDatabase,
  tokenDigest: string,
  now: number,
): Promise<boolean> {
  return (await findActiveApplicationSession(database, tokenDigest, now)) !== null;
}
