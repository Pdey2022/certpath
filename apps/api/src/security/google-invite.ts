export const googleIdentityIssuer = "https://accounts.google.com";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const subjectPattern = /^[A-Za-z0-9_-]{1,255}$/;

export interface GoogleInviteLinkInput {
  userId: string;
  subject: string;
  now?: number;
}

/**
 * Builds the operator statement that links one Google subject to one existing
 * learner. It never creates a user, never links by email, refuses a learner
 * that already has an identity, and refuses a subject that is already linked.
 */
export function buildGoogleInviteLinkSql({
  userId,
  subject,
  now = Date.now(),
}: GoogleInviteLinkInput): string {
  if (!uuidPattern.test(userId)) {
    throw new Error("userId must be a UUID");
  }
  if (!subjectPattern.test(subject)) {
    throw new Error("subject must be 1-255 base64url characters");
  }
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new Error("now must be a positive integer epoch millisecond");
  }
  return `INSERT INTO auth_identities (issuer, subject, user_id, created_at)
SELECT '${googleIdentityIssuer}', '${subject}', users.id, ${now}
FROM users
WHERE users.id = '${userId}'
  AND users.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM auth_identities AS existing WHERE existing.user_id = users.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM auth_identities AS linked
    WHERE linked.issuer = '${googleIdentityIssuer}' AND linked.subject = '${subject}'
  )
RETURNING issuer, subject, user_id;`;
}
