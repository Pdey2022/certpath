import type { SecurityDatabase } from "./database.ts";
import { createOpaqueToken } from "./local-learner-request.ts";
import { sessionDigest } from "./http-session.ts";

export const emailSignInLinkLifetimeMs = 15 * 60 * 1000;
export const learnerSessionLifetimeMs = 8 * 60 * 60 * 1000;

// A link is usable only while the invite is not revoked, the account is active,
// and the account holds no staff role that must not reach the learner surface.
const usableInvitePredicate = `
  i.revoked_at IS NULL
  AND u.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM staff_roles WHERE user_id = u.id AND active = 1
  )`;

export async function issueEmailSignInToken(
  database: SecurityDatabase,
  emailNormalized: string,
  now: number,
): Promise<{ token: string; expiresAt: number } | null> {
  const token = createOpaqueToken();
  const tokenDigest = await sessionDigest(token);
  const expiresAt = now + emailSignInLinkLifetimeMs;
  const results = await database.batch([
    database
      .prepare("DELETE FROM learner_email_sign_in_tokens WHERE expires_at <= ?")
      .bind(now),
    database
      .prepare(
        `INSERT INTO learner_email_sign_in_tokens (
           token_digest, invite_email, user_id, created_at, expires_at
         )
         SELECT ?, i.email_normalized, i.user_id, ?, ?
         FROM learner_email_sign_in_invites AS i
         JOIN users AS u ON u.id = i.user_id
         WHERE i.email_normalized = ?
           AND ${usableInvitePredicate}
         RETURNING user_id`,
      )
      .bind(tokenDigest, now, expiresAt, emailNormalized),
  ]);
  return results[1]?.meta.changes === 1 ? { token, expiresAt } : null;
}

export async function isEmailSignInTokenUsable(
  database: SecurityDatabase,
  token: string,
  now: number,
): Promise<boolean> {
  const tokenDigest = await sessionDigest(token);
  const row = await database
    .withSession("first-primary")
    .prepare(
      `SELECT 1 AS usable
       FROM learner_email_sign_in_tokens AS t
       JOIN learner_email_sign_in_invites AS i
         ON i.email_normalized = t.invite_email
        AND i.user_id = t.user_id
       JOIN users AS u ON u.id = t.user_id
       WHERE t.token_digest = ?
         AND t.expires_at > ?
         AND t.consumed_at IS NULL
         AND ${usableInvitePredicate}`,
    )
    .bind(tokenDigest, now)
    .first<{ usable: number }>();
  return row !== null;
}

export async function redeemEmailSignInToken(
  database: SecurityDatabase,
  token: string,
  now: number,
): Promise<{ rawSessionToken: string } | null> {
  const tokenDigest = await sessionDigest(token);
  const rawSessionToken = createOpaqueToken();
  const sessionTokenDigest = await sessionDigest(rawSessionToken);
  const operationId = `email-sign-in:${crypto.randomUUID()}`;
  const expiresAt = now + learnerSessionLifetimeMs;

  const results = await database.batch([
    database
      .prepare(
        `UPDATE learner_email_sign_in_tokens
         SET consumed_at = ?, consumed_operation_id = ?
         WHERE token_digest = ?
           AND expires_at > ?
           AND consumed_at IS NULL
           AND EXISTS (
             SELECT 1
             FROM learner_email_sign_in_invites AS i
             JOIN users AS u ON u.id = i.user_id
             WHERE i.email_normalized =
                     learner_email_sign_in_tokens.invite_email
               AND i.user_id = learner_email_sign_in_tokens.user_id
               AND ${usableInvitePredicate}
           )
         RETURNING user_id`,
      )
      .bind(now, operationId, tokenDigest, now),
    database
      .prepare(
        `INSERT INTO app_sessions (
           token_digest, user_id, created_at, expires_at, revoked_at,
           revocation_operation_id, revoked_by_user_id, mfa_method,
           mfa_verified_at
         )
         SELECT ?, t.user_id, ?, ?, NULL, NULL, NULL, NULL, NULL
         FROM learner_email_sign_in_tokens AS t
         JOIN users AS u ON u.id = t.user_id
         WHERE t.consumed_operation_id = ?
           AND t.token_digest = ?
           AND u.status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM staff_roles
             WHERE user_id = u.id AND active = 1
           )
         RETURNING token_digest`,
      )
      .bind(sessionTokenDigest, now, expiresAt, operationId, tokenDigest),
    database
      .prepare(
        `INSERT INTO audit_events (
           operation_id, actor_user_id, actor_ref, action, subject_type,
           subject_id, certification_id, reason, occurred_at
         )
         SELECT ?, t.user_id, NULL, 'learner_signed_in', 'user', t.user_id,
                NULL, 'Learner signed in by email link', ?
         FROM learner_email_sign_in_tokens AS t
         WHERE t.consumed_operation_id = ? AND t.token_digest = ?
         RETURNING operation_id`,
      )
      .bind(operationId, now, operationId, tokenDigest),
  ]);

  return results.every((result) => result.meta.changes === 1)
    ? { rawSessionToken }
    : null;
}
