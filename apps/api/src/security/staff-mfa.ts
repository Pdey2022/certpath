import type { SecurityDatabase } from "./database.ts";
import {
  base32Encode,
  createEnrolmentTicket,
  createRecoveryCode,
  createTotpSeed,
  enrolmentTicketLifetimeMs,
  matchTotpStep,
  normalizeRecoveryCode,
  openTotpSeed,
  otpauthUri,
  recoveryCodeCount,
  sealTotpSeed,
  sha256Hex,
} from "./totp.ts";

// The 5F staff second factor, as storage operations.
//
// Every function here assumes the caller has already checked the transport
// (origin, JSON, CSRF) and, for `resetStaffMfa`, the actor's own assurance and
// Global-Admin role. What is left is the state machine, and each step of it is
// backed by a `0023` constraint or trigger:
//
//   * a password-only session may call `enrolStaffTotp`, and only a valid
//     enrolment ticket gets a factor created;
//   * `confirmStaffTotp` publishes ten recovery codes exactly once;
//   * `verifyStaffTotp` burns a time step with a conditional update whose
//     `meta.changes` is the replay decision;
//   * `redeemStaffRecoveryCode` revokes the factor and mints no assurance;
//   * `resetStaffMfa` is a Global Admin act that revokes credentials, codes and
//     sessions and returns a printed ticket.
//
// No secret, ticket or recovery code is ever written to an audit row, an error
// or a return value outside its single one-time display.

export type StaffMfaFailure = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 410 | 503;
  code: string;
};

export interface StaffMfaAccount {
  userId: string;
  role: "global_admin" | "manager";
  email: string | null;
}

const operationId = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;
const serviceUnavailable: StaffMfaFailure = {
  ok: false,
  status: 503,
  code: "service_unavailable",
};
const invalidCode: StaffMfaFailure = {
  ok: false,
  status: 400,
  code: "invalid_code",
};
const forbidden: StaffMfaFailure = {
  ok: false,
  status: 403,
  code: "forbidden",
};

/**
 * The live session plus the active staff role, with no assurance requirement.
 * This is what the MFA routes themselves authenticate with: a password-only
 * session can enrol and verify, and nothing else.
 */
export async function readStaffMfaAccount(
  database: SecurityDatabase,
  tokenDigest: string,
  now: number,
): Promise<StaffMfaAccount | null> {
  const row = await database
    .withSession("first-primary")
    .prepare(
      `SELECT session.user_id, role.role,
              credentials.email_normalized AS email
       FROM app_sessions AS session
       JOIN users AS account ON account.id = session.user_id
       JOIN staff_roles AS role
         ON role.user_id = session.user_id AND role.active = 1
       LEFT JOIN staff_password_credentials AS credentials
         ON credentials.user_id = session.user_id
       WHERE session.token_digest = ?
         AND session.revoked_at IS NULL
         AND session.expires_at > ?
         AND account.status = 'active'`,
    )
    .bind(tokenDigest, now)
    .first<{
      user_id: string;
      role: "global_admin" | "manager";
      email: string | null;
    }>();
  return row ? { userId: row.user_id, role: row.role, email: row.email } : null;
}

interface CredentialRow {
  credential_id: string;
  secret_ciphertext: string;
  secret_iv: string;
  key_version: number;
  last_used_step: number;
  confirmed_at: number | null;
}

export type EnrolResult =
  | { ok: true; secret: string; otpauthUri: string; keyVersion: number }
  | StaffMfaFailure;

/**
 * Starts an enrolment. A ticket is not optional: a stolen password must not be
 * able to beat the account holder to the first factor, and it must not be able
 * to replace a factor that already exists.
 *
 * An *unconfirmed* credential is the one case a ticket may replace, so a user
 * who lost the QR code before confirming can start again with a new ticket. A
 * confirmed credential is never overwritten - that is the reset path, which
 * revokes first and is audited as its own act.
 */
export async function enrolStaffTotp(
  database: SecurityDatabase,
  options: {
    userId: string;
    email: string | null;
    ticket: string | undefined;
    sealKey: CryptoKey;
    now: number;
  },
): Promise<EnrolResult> {
  const { userId, now } = options;
  if (!options.ticket) return forbidden;

  const ticketDigest = await sha256Hex(options.ticket);
  const ticket = await database
    .withSession("first-primary")
    .prepare(
      `SELECT user_id, expires_at, consumed_at, revoked_at
       FROM staff_mfa_enrolment_tickets
       WHERE ticket_digest = ? AND user_id = ?`,
    )
    .bind(ticketDigest, userId)
    .first<{
      user_id: string;
      expires_at: number;
      consumed_at: number | null;
      revoked_at: number | null;
    }>();
  if (!ticket || ticket.revoked_at !== null || ticket.consumed_at !== null) {
    return forbidden;
  }
  if (ticket.expires_at <= now) {
    return { ok: false, status: 410, code: "ticket_expired" };
  }

  const active = await database
    .withSession("first-primary")
    .prepare(
      `SELECT credential_id, confirmed_at
       FROM staff_totp_credentials
       WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .bind(userId)
    .first<{ credential_id: string; confirmed_at: number | null }>();
  if (active && active.confirmed_at !== null) {
    return { ok: false, status: 409, code: "mfa_already_enrolled" };
  }

  // The ticket is burned before anything is written, with its own conditional
  // update: two concurrent enrolments cannot both pass, and a failure after
  // this point needs a fresh ticket rather than silently reusing this one.
  //
  // The decision is read from RETURNING rows, not `meta.changes`: D1 counts the
  // audit row this update's trigger writes as a change, so `meta.changes` is 2
  // on success. `RETURNING ticket_digest` names exactly the row the predicate
  // matched.
  const consumed = await database
    .prepare(
      `UPDATE staff_mfa_enrolment_tickets
       SET consumed_at = ?, consumed_operation_id = ?
       WHERE ticket_digest = ? AND user_id = ?
         AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
       RETURNING ticket_digest`,
    )
    .bind(now, operationId("staff-mfa-enrolment"), ticketDigest, userId, now)
    .all<{ ticket_digest: string }>();
  if (consumed.results.length !== 1) return forbidden;

  const seed = createTotpSeed();
  const sealed = await sealTotpSeed(options.sealKey, seed);
  const statements = [];
  if (active) {
    statements.push(
      database
        .prepare(
          `UPDATE staff_totp_credentials
           SET revoked_at = ?, revoked_operation_id = ?
           WHERE credential_id = ? AND revoked_at IS NULL`,
        )
        .bind(now, operationId("staff-mfa-replace"), active.credential_id),
    );
  }
  statements.push(
    database
      .prepare(
        `INSERT INTO staff_totp_credentials (
           credential_id, user_id, secret_ciphertext, secret_iv, key_version,
           digits, period_seconds, algorithm, last_used_step, created_at,
           confirmed_at, created_operation_id, revoked_at, revoked_operation_id
         ) VALUES (?, ?, ?, ?, 1, 6, 30, 'SHA1', 0, ?, NULL, ?, NULL, NULL)
         RETURNING credential_id`,
      )
      .bind(
        crypto.randomUUID(),
        userId,
        sealed.ciphertext,
        sealed.iv,
        now,
        operationId("staff-mfa-enrol"),
      ),
  );
  const results = await database.batch(statements);
  if (results[results.length - 1]?.results?.length !== 1) {
    return serviceUnavailable;
  }

  const secret = base32Encode(seed);
  return {
    ok: true,
    secret,
    otpauthUri: otpauthUri(
      "Exam Prep",
      options.email ?? `staff-${userId}`,
      secret,
    ),
    keyVersion: 1,
  };
}

export type ConfirmResult =
  | { ok: true; recoveryCodes: string[] }
  | StaffMfaFailure;

/**
 * Confirms the pending credential and publishes ten recovery codes once.
 *
 * The confirmation code does not advance `last_used_step`: `confirmed_at` is a
 * one-way transition, so replaying the confirm request cannot do anything, and
 * leaving the step alone means the code the user just typed still works for the
 * `verify` call that follows.
 */
export async function confirmStaffTotp(
  database: SecurityDatabase,
  options: { userId: string; code: string; sealKey: CryptoKey; now: number },
): Promise<ConfirmResult> {
  const credential = await database
    .withSession("first-primary")
    .prepare(
      `SELECT credential_id, secret_ciphertext, secret_iv, key_version,
              last_used_step, confirmed_at
       FROM staff_totp_credentials
       WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .bind(options.userId)
    .first<CredentialRow>();
  if (!credential) return invalidCode;
  if (credential.confirmed_at !== null) {
    return { ok: false, status: 409, code: "mfa_already_enrolled" };
  }
  if (credential.key_version !== 1) return serviceUnavailable;

  const seed = await openTotpSeed(
    options.sealKey,
    credential.secret_ciphertext,
    credential.secret_iv,
  );
  if (!seed) return invalidCode;
  if ((await matchTotpStep(seed, options.code, options.now)) === null) {
    return invalidCode;
  }

  const codes = Array.from({ length: recoveryCodeCount }, createRecoveryCode);
  // The digest is over the canonical ten characters, exactly as redemption
  // normalises them: the separator and any lower-casing are the user's typing
  // problem, not part of the secret.
  const digests = await Promise.all(
    codes.map((code) => sha256Hex(normalizeRecoveryCode(code))),
  );
  const setOperationId = operationId("staff-recovery-issue");
  const values: Array<string | number> = [];
  for (const digest of digests) {
    values.push(digest, options.userId, setOperationId, options.now);
  }

  const results = await database.batch([
    database
      .prepare(
        `UPDATE staff_totp_credentials
         SET confirmed_at = ?
         WHERE credential_id = ? AND confirmed_at IS NULL
         RETURNING credential_id`,
      )
      .bind(options.now, credential.credential_id),
    // One live recovery-code set per account. A confirmation supersedes the
    // previous set (revoked, never deleted), which is what lets a replacement
    // factor after a recovery redemption publish its own ten codes without
    // tripping `staff_recovery_codes_max_ten_active`. The unused codes stay
    // valid during the gap, so an account that loses the ticket it was handed
    // can still redeem another one.
    database
      .prepare(
        `UPDATE staff_recovery_codes
         SET revoked_at = ?
         WHERE user_id = ? AND revoked_at IS NULL AND used_at IS NULL`,
      )
      .bind(options.now, options.userId),
    database
      .prepare(
        `INSERT INTO staff_recovery_codes (
           code_digest, user_id, set_operation_id, created_at
         ) VALUES ${digests.map(() => "(?, ?, ?, ?)").join(", ")}
         RETURNING code_digest`,
      )
      .bind(...values),
  ]);
  // Rows, not `meta.changes`: the recovery-code trigger writes its own audit row
  // into the same statement's change count.
  if (results[0]?.results?.length !== 1) {
    return { ok: false, status: 409, code: "mfa_already_enrolled" };
  }
  if (results[2]?.results?.length !== recoveryCodeCount) {
    return serviceUnavailable;
  }
  return { ok: true, recoveryCodes: codes };
}

export type VerifyResult = { ok: true } | StaffMfaFailure;

/**
 * Verifies a code and upgrades *this* session row to `('totp', now)`.
 *
 * Replay is decided by `meta.changes` on the conditional step update, which runs
 * before the session is touched: a replay burns nothing and grants nothing. If
 * the session update then fails, the step is spent and the caller retries with
 * the next code - fail closed.
 */
export async function verifyStaffTotp(
  database: SecurityDatabase,
  options: {
    userId: string;
    tokenDigest: string;
    code: string;
    sealKey: CryptoKey;
    now: number;
  },
): Promise<VerifyResult> {
  const credential = await database
    .withSession("first-primary")
    .prepare(
      `SELECT credential_id, secret_ciphertext, secret_iv, key_version,
              last_used_step, confirmed_at
       FROM staff_totp_credentials
       WHERE user_id = ? AND revoked_at IS NULL AND confirmed_at IS NOT NULL`,
    )
    .bind(options.userId)
    .first<CredentialRow>();
  if (!credential) return invalidCode;
  if (credential.key_version !== 1) return serviceUnavailable;

  const seed = await openTotpSeed(
    options.sealKey,
    credential.secret_ciphertext,
    credential.secret_iv,
  );
  if (!seed) return invalidCode;

  const step = await matchTotpStep(seed, options.code, options.now);
  if (step === null || step <= credential.last_used_step) return invalidCode;

  const burned = await database
    .prepare(
      `UPDATE staff_totp_credentials
       SET last_used_step = ?
       WHERE credential_id = ? AND revoked_at IS NULL
         AND confirmed_at IS NOT NULL AND last_used_step < ?`,
    )
    .bind(step, credential.credential_id, step)
    .run();
  if (burned.meta.changes !== 1) return invalidCode;

  const upgraded = await database
    .prepare(
      `UPDATE app_sessions
       SET mfa_method = 'totp', mfa_verified_at = ?
       WHERE token_digest = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .bind(options.now, options.tokenDigest, options.now)
    .run();
  if (upgraded.meta.changes !== 1) {
    return { ok: false, status: 401, code: "unauthenticated" };
  }
  return { ok: true };
}

export type RecoveryResult =
  | { ok: true; ticket: string; expiresAt: number }
  | StaffMfaFailure;

/**
 * Redeems one recovery code. It mints **no** assurance: it revokes the current
 * credential, issues exactly one printed enrolment ticket so the account can
 * enrol a replacement, and sends the caller back to enrolment. A paper code that
 * granted admin access would be a weaker second factor than the TOTP it
 * replaces; a paper code that led nowhere would make the ten codes a dead end.
 *
 * The ticket and the revocation are one batch, so a redemption either leaves the
 * account with no factor *and* a way back, or with neither.
 */
export async function redeemStaffRecoveryCode(
  database: SecurityDatabase,
  options: { userId: string; recoveryCode: string; now: number },
): Promise<RecoveryResult> {
  const digest = await sha256Hex(normalizeRecoveryCode(options.recoveryCode));
  const used = await database
    .prepare(
      `UPDATE staff_recovery_codes
       SET used_at = ?, used_operation_id = ?
       WHERE code_digest = ? AND user_id = ?
         AND used_at IS NULL AND revoked_at IS NULL
       RETURNING code_digest`,
    )
    .bind(
      options.now,
      operationId("staff-recovery-redeem"),
      digest,
      options.userId,
    )
    .all<{ code_digest: string }>();
  if (used.results.length !== 1) {
    const existing = await database
      .withSession("first-primary")
      .prepare(
        `SELECT used_at FROM staff_recovery_codes
         WHERE code_digest = ? AND user_id = ?`,
      )
      .bind(digest, options.userId)
      .first<{ used_at: number | null }>();
    return existing?.used_at != null
      ? { ok: false, status: 409, code: "recovery_code_used" }
      : invalidCode;
  }

  const ticket = createEnrolmentTicket();
  const ticketDigest = await sha256Hex(ticket);
  const expiresAt = options.now + enrolmentTicketLifetimeMs;
  const results = await database.batch([
    database
      .prepare(
        `UPDATE staff_totp_credentials
         SET revoked_at = ?, revoked_operation_id = ?
         WHERE user_id = ? AND revoked_at IS NULL`,
      )
      .bind(options.now, operationId("staff-recovery-reset"), options.userId),
    // `created_by_ref` rather than `created_by_user_id`: the account holder
    // produced this ticket with a code they held, and no privileged actor was
    // involved. It is a printed secret like any other, valid for 24 h and once.
    database
      .prepare(
        `INSERT INTO staff_mfa_enrolment_tickets (
           ticket_digest, user_id, created_by_user_id, created_by_ref,
           created_at, expires_at, consumed_at, consumed_operation_id,
           revoked_at
         ) VALUES (?, ?, NULL, 'recovery-code', ?, ?, NULL, NULL, NULL)
         RETURNING ticket_digest`,
      )
      .bind(ticketDigest, options.userId, options.now, expiresAt),
  ]);
  if (results[1]?.results?.length !== 1) return serviceUnavailable;
  return { ok: true, ticket, expiresAt };
}

export type ResetResult =
  | { ok: true; ticket: string; expiresAt: number }
  | StaffMfaFailure;

/**
 * A Global Admin resets another staff account's second factor.
 *
 * Revokes the credential, the outstanding recovery codes and every live session,
 * then returns one printed enrolment ticket. A retry while that ticket is still
 * live answers 409 rather than minting a second printed secret.
 *
 * The `staff_mfa_reset` audit row is written here, with the actor and the
 * operator's own words. The trigger that fires on the revocation asserts no
 * actor deliberately (see `0023`): it cannot tell a reset from a self-service
 * recovery redemption, and naming the subject as the actor would be a false
 * record of a privileged act.
 */
export async function resetStaffMfa(
  database: SecurityDatabase,
  options: {
    actorUserId: string;
    targetUserId: string;
    reason: string;
    now: number;
  },
): Promise<ResetResult> {
  if (options.actorUserId === options.targetUserId) return forbidden;

  const target = await database
    .withSession("first-primary")
    .prepare(`SELECT role, active FROM staff_roles WHERE user_id = ?`)
    .bind(options.targetUserId)
    .first<{ role: string; active: number }>();
  if (!target || target.active !== 1) {
    return { ok: false, status: 404, code: "not_found" };
  }

  const liveTicket = await database
    .withSession("first-primary")
    .prepare(
      `SELECT ticket_digest FROM staff_mfa_enrolment_tickets
       WHERE user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL
         AND expires_at > ?`,
    )
    .bind(options.targetUserId, options.now)
    .first<{ ticket_digest: string }>();
  if (liveTicket) {
    return { ok: false, status: 409, code: "conflict" };
  }

  const ticket = createEnrolmentTicket();
  const ticketDigest = await sha256Hex(ticket);
  const expiresAt = options.now + enrolmentTicketLifetimeMs;

  const results = await database.batch([
    database
      .prepare(
        `UPDATE staff_totp_credentials
         SET revoked_at = ?, revoked_operation_id = ?
         WHERE user_id = ? AND revoked_at IS NULL`,
      )
      .bind(options.now, operationId("staff-mfa-reset"), options.targetUserId),
    database
      .prepare(
        `UPDATE staff_recovery_codes
         SET revoked_at = ?
         WHERE user_id = ? AND revoked_at IS NULL AND used_at IS NULL`,
      )
      .bind(options.now, options.targetUserId),
    // `revocation_operation_id` is unique per row, so each revoked session is
    // named after its own token digest rather than the request.
    database
      .prepare(
        `UPDATE app_sessions
         SET revoked_at = ?,
             revocation_operation_id = 'staff-mfa-reset-session:' || token_digest,
             revoked_by_user_id = ?
         WHERE user_id = ? AND revoked_at IS NULL`,
      )
      .bind(options.now, options.actorUserId, options.targetUserId),
    database
      .prepare(
        `INSERT INTO staff_mfa_enrolment_tickets (
           ticket_digest, user_id, created_by_user_id, created_by_ref,
           created_at, expires_at, consumed_at, consumed_operation_id,
           revoked_at
         ) VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, NULL)
         RETURNING ticket_digest`,
      )
      .bind(
        ticketDigest,
        options.targetUserId,
        options.actorUserId,
        options.now,
        expiresAt,
      ),
    database
      .prepare(
        `INSERT INTO audit_events (
           operation_id, actor_user_id, actor_ref, action, subject_type,
           subject_id, certification_id, reason, occurred_at
         ) VALUES (?, ?, NULL, 'staff_mfa_reset', 'staff_mfa', ?, NULL, ?, ?)
         RETURNING operation_id`,
      )
      .bind(
        operationId("staff-mfa-reset-audit"),
        options.actorUserId,
        options.targetUserId,
        options.reason,
        options.now,
      ),
  ]);
  if (results[3]?.results?.length !== 1) return serviceUnavailable;
  if (results[4]?.results?.length !== 1) return serviceUnavailable;
  return { ok: true, ticket, expiresAt };
}
