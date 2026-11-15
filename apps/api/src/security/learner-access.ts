import type {
  MaskedLearnerRecord,
  StaffRole,
} from "@certpath/contracts";
import type {
  D1PreparedStatement,
  D1Value,
  SecurityDatabase,
} from "./database.ts";
import type { StatementGuard } from "./capabilities.ts";
import { evaluateFeature } from "../entitlements.ts";
import type { StaffMfaPolicy } from "./mfa.ts";

// The one module that owns the learner contact column.
//
// Two rules keep it honest:
//
//   1. Every read returns `maskEmail(...)`-masked contact data. This module holds
//      exactly one unmasked value returned to a caller - `revealLearnerContact` -
//      and it writes its audit row in the same D1 batch as the select. The raw
//      column is also selected internally by `readContact`,
//      `readStoredCredentialEmail` and the reveal's own select; none of those
//      returns it to a caller.
//   2. Every write carries `learnerGuard(...)` in its own WHERE clause, so a
//      revoked role, a disabled staff account or a stale MFA assurance is refused
//      by the statement itself, not only by the route.
//
// Rules: docs/decisions/0004-staff-capabilities-and-learner-data.md and
// docs/admin-capabilities.md.

export const learnerRecordViewReason = "Learner record viewed by staff";
export const learnerContactRevealReason = "Learner contact revealed to staff";
export const learnerSupportHistoryViewReason =
  "Learner support history viewed by staff";

const supportActions = [
  "learner_record_viewed",
  "learner_contact_revealed",
  "learner_contact_corrected",
  "learner_deactivated",
  "learner_support_history_viewed",
] as const;

export type LearnerSupportAction = (typeof supportActions)[number];

export type ContactKind = "password-credential" | "sign-in-invite";

export interface SupportActor {
  tokenDigest: string;
  userId: string;
}

export interface SupportMutation {
  operationId: string;
  reason: string;
  now: number;
}

export type LearnerAccessFailure =
  | "invalid-input"
  | "not-found"
  // The subject exists but the guarded statement changed no row: the caller lost
  // a race, so the answer is a conflict rather than the not-found that hides a
  // missing subject.
  | "conflict"
  | "contact-not-available"
  | "contact-unchanged"
  | "contact-taken"
  | "contact-not-correctable"
  | "already-deactivated";

export type LearnerAccessResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: LearnerAccessFailure };

export const contactIdentityMessage =
  "a contact address may identify only one learner";

/**
 * Session, role, MFA and staff-subject guard, reused by every learner-support
 * statement. The final value is the subject id.
 */
export function learnerGuard(
  tokenDigest: string,
  learnerUserId: string,
  now: number,
  policy: StaffMfaPolicy,
): StatementGuard {
  const placeholders = policy.allowedMethods.map(() => "?").join(", ");
  return {
    sql: `EXISTS (
      SELECT 1
      FROM app_sessions AS support_session
      JOIN users AS support_actor ON support_actor.id = support_session.user_id
      JOIN staff_roles AS support_role ON support_role.user_id = support_actor.id
      WHERE support_session.token_digest = ?
        AND support_session.revoked_at IS NULL
        AND support_session.expires_at > ?
        AND support_actor.status = 'active'
        AND support_role.active = 1
        AND support_session.mfa_verified_at BETWEEN ? AND ?
        AND support_session.mfa_method IN (${placeholders})
        AND NOT EXISTS (
          SELECT 1
          FROM staff_roles AS subject_role
          WHERE subject_role.user_id = ? AND subject_role.active = 1
        )
    )`,
    values: [
      tokenDigest,
      now,
      now - policy.maxAgeMs,
      now,
      ...policy.allowedMethods,
      learnerUserId,
    ] as D1Value[],
  };
}

function maskLabel(label: string): string {
  return label.length > 2 ? `${label.slice(0, 1)}***` : "***";
}

/**
 * Masks an address without preserving label lengths: a label of one or two
 * characters is replaced entirely (`***`) and a longer one keeps its first
 * character (`a***`), so `alice@example.test` becomes `a***@e***.test` and
 * `a@mail.example.test` becomes `***@m***.test`. Case-insensitive for matching,
 * but the mask never carries a full label.
 */
export function maskEmail(email: string): string {
  const value = email.trim();
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return "***";
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const labels = domain.split(".").filter(Boolean);
  const maskedDomain =
    labels.length <= 1
      ? maskLabel(labels[0] ?? "")
      : `${maskLabel(labels[0]!)}.${labels[labels.length - 1]}`;
  return `${maskLabel(local)}@${maskedDomain}`.slice(0, 254);
}

/**
 * Contact lookup. A same-user address can legitimately appear in both tables
 * (the storage trigger compares `user_id`), so results are deduplicated by
 * `user_id`. Revoked invites keep reserving their address - no revoked filter.
 *
 * `LIMIT 1` has no tiebreak because it needs none: the upgrade pre-flight query
 * documented in `docs/admin-capabilities.md` §7 must return zero rows before
 * `0016` is applied, so one address can never identify two learners. That
 * pre-flight is a prerequisite of the contact-identity triggers, not an optional
 * check; without it this limit would pick an arbitrary learner.
 */
export async function findLearnerUserIdByEmail(
  database: SecurityDatabase,
  emailNormalized: string,
): Promise<string | null> {
  const row = await database
    .withSession("first-primary")
    .prepare(
      `SELECT holder.user_id AS user_id
       FROM (
         SELECT c.user_id AS user_id
         FROM learner_password_credentials AS c
         WHERE c.email_normalized = ?
         UNION
         SELECT i.user_id AS user_id
         FROM learner_email_sign_in_invites AS i
         WHERE i.email_normalized = ?
       ) AS holder
       JOIN users AS subject ON subject.id = holder.user_id
       WHERE NOT EXISTS (
         SELECT 1 FROM staff_roles AS subject_role
         WHERE subject_role.user_id = holder.user_id AND subject_role.active = 1
       )
       LIMIT 1`,
    )
    .bind(emailNormalized, emailNormalized)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

async function readContact(
  database: SecurityDatabase,
  learnerUserId: string,
): Promise<{ kind: ContactKind; email: string; emailVerified: boolean | null } | null> {
  const credential = await database
    .withSession("first-primary")
    .prepare(
      `SELECT email, email_verified_at
       FROM learner_password_credentials
       WHERE user_id = ?`,
    )
    .bind(learnerUserId)
    .first<{ email: string; email_verified_at: number | null }>();
  if (credential) {
    return {
      kind: "password-credential",
      email: credential.email,
      emailVerified: credential.email_verified_at !== null,
    };
  }
  const invite = await database
    .withSession("first-primary")
    .prepare(
      `SELECT email_normalized
       FROM learner_email_sign_in_invites
       WHERE user_id = ?`,
    )
    .bind(learnerUserId)
    .first<{ email_normalized: string }>();
  return invite
    ? {
        kind: "sign-in-invite",
        email: invite.email_normalized,
        emailVerified: null,
      }
    : null;
}

/** Whether the learner holds a password credential at all. */
export async function hasPasswordCredential(
  database: SecurityDatabase,
  learnerUserId: string,
): Promise<boolean> {
  const row = await database
    .withSession("first-primary")
    .prepare(
      `SELECT 1 AS present FROM learner_password_credentials WHERE user_id = ?`,
    )
    .bind(learnerUserId)
    .first<{ present: number }>();
  return row !== null;
}

export async function readStoredCredentialEmail(
  database: SecurityDatabase,
  learnerUserId: string,
): Promise<{ email: string; emailNormalized: string } | null> {
  const row = await database
    .withSession("first-primary")
    .prepare(
      `SELECT email, email_normalized FROM learner_password_credentials
       WHERE user_id = ?`,
    )
    .bind(learnerUserId)
    .first<{ email: string; email_normalized: string }>();
  return row ? { email: row.email, emailNormalized: row.email_normalized } : null;
}

interface MembershipRow {
  certification_id: string;
  feature: "standard" | "pro";
  starts_at: number;
  expires_at: number;
  revoked_at: number | null;
}

interface LearnerActivityRow {
  practice_count: number;
  mock_count: number;
  practice_activity: number | null;
  mock_activity: number | null;
  session_activity: number | null;
}

function buildMemberships(rows: MembershipRow[], now: number) {
  const groups = new Map<string, MembershipRow[]>();
  for (const row of rows) {
    const key = `${row.certification_id}\u0000${row.feature}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const entries = [...groups.values()].map((group) => {
    const first = group[0]!;
    const access = evaluateFeature(
      group.map((row) => ({
        feature: row.feature,
        startsAt: row.starts_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
      })),
      first.feature,
      now,
    );
    return {
      certificationId: first.certification_id,
      feature: first.feature,
      state: access.state,
      endsAt: access.state === "expired" ? null : access.endsAt,
    };
  });

  entries.sort((left, right) => {
    if (left.endsAt === null && right.endsAt === null) {
      return (
        left.certificationId.localeCompare(right.certificationId) ||
        left.feature.localeCompare(right.feature)
      );
    }
    if (left.endsAt === null) return 1;
    if (right.endsAt === null) return -1;
    if (right.endsAt !== left.endsAt) return right.endsAt - left.endsAt;
    return (
      left.certificationId.localeCompare(right.certificationId) ||
      left.feature.localeCompare(right.feature)
    );
  });

  return {
    memberships: entries.slice(0, 20),
    membershipsTruncated: entries.length > 20,
  };
}

/**
 * The single masked read model. No field here ever carries a stored address; the
 * only address-shaped value is `maskEmail(...)`.
 */
export async function readMaskedLearnerRecord(
  database: SecurityDatabase,
  learnerUserId: string,
  now: number,
): Promise<MaskedLearnerRecord | null> {
  const primary = database.withSession("first-primary");
  const user = await primary
    .prepare("SELECT id, status, created_at FROM users WHERE id = ?")
    .bind(learnerUserId)
    .first<{ id: string; status: "active" | "disabled"; created_at: number }>();
  if (!user) return null;

  const contact = await readContact(database, learnerUserId);
  const grants = await primary
    .prepare(
      `SELECT certification_id, feature, starts_at, expires_at, revoked_at
       FROM learner_access_grants
       WHERE user_id = ?`,
    )
    .bind(learnerUserId)
    .all<MembershipRow>();
  const activity = await primary
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM practice_attempts WHERE user_id = ?) AS practice_count,
         (SELECT COUNT(*) FROM timed_mock_attempts WHERE user_id = ?) AS mock_count,
         (SELECT MAX(updated_at) FROM practice_attempts WHERE user_id = ?)
           AS practice_activity,
         (SELECT MAX(updated_at) FROM timed_mock_attempts WHERE user_id = ?)
           AS mock_activity,
         (SELECT MAX(created_at) FROM app_sessions WHERE user_id = ?)
           AS session_activity`,
    )
    .bind(learnerUserId, learnerUserId, learnerUserId, learnerUserId, learnerUserId)
    .first<LearnerActivityRow>();

  const { memberships, membershipsTruncated } = buildMemberships(
    grants.results,
    now,
  );
  const activityTimes = [
    activity?.practice_activity ?? null,
    activity?.mock_activity ?? null,
    activity?.session_activity ?? null,
  ].filter((value): value is number => value !== null);

  return {
    userId: user.id,
    accountStatus: user.status === "disabled" ? "deactivated" : "active",
    maskedContact: contact ? maskEmail(contact.email) : null,
    contactKind: contact?.kind ?? null,
    emailVerified: contact ? contact.emailVerified : null,
    memberships,
    membershipsTruncated,
    attemptCounts: {
      practice: activity?.practice_count ?? 0,
      mock: activity?.mock_count ?? 0,
    },
    lastActivityAt:
      activityTimes.length === 0 ? null : Math.max(...activityTimes),
    createdAt: user.created_at,
  };
}

export async function learnerAccountStatus(
  database: SecurityDatabase,
  learnerUserId: string,
): Promise<"active" | "deactivated" | null> {
  const row = await database
    .withSession("first-primary")
    .prepare("SELECT status FROM users WHERE id = ?")
    .bind(learnerUserId)
    .first<{ status: "active" | "disabled" }>();
  if (!row) return null;
  return row.status === "disabled" ? "deactivated" : "active";
}

/**
 * Whether an account exists and holds no active staff role - the definition of a
 * learner subject. This is the same predicate `canCapability` uses for a learner
 * resource, kept here so the mutation error mapping cannot drift from it.
 */
export async function learnerSubjectExists(
  database: SecurityDatabase,
  learnerUserId: string,
): Promise<boolean> {
  const row = await database
    .withSession("first-primary")
    .prepare(
      `SELECT 1 AS present FROM users AS subject
       WHERE subject.id = ?
         AND NOT EXISTS (
           SELECT 1 FROM staff_roles AS subject_role
           WHERE subject_role.user_id = subject.id
             AND subject_role.active = 1
         )`,
    )
    .bind(learnerUserId)
    .first<{ present: number }>();
  return row !== null;
}

function auditStatement(
  database: SecurityDatabase,
  input: {
    operationId: string;
    actor: SupportActor;
    action: LearnerSupportAction;
    learnerUserId: string;
    reason: string;
    detailsJson: string | null;
    /**
     * Overrides `detailsJson` when the value can only be computed inside the
     * batch - the contact correction's revoked-invite count. Placeholders are
     * bound immediately after `reason`.
     */
    detailsExpression?: { sql: string; values: (string | number)[] };
    now: number;
    predicateSql: string;
    predicateValues: (string | number)[];
  },
): D1PreparedStatement {
  const detailsSql = input.detailsExpression?.sql ?? "?";
  const detailsValues = input.detailsExpression?.values ?? [input.detailsJson];
  return database
    .prepare(
      `INSERT INTO audit_events (
         operation_id, actor_user_id, actor_ref, action, subject_type,
         subject_id, certification_id, reason, details_json, occurred_at
       )
       SELECT ?, ?, NULL, ?, 'user', ?, NULL, ?, ${detailsSql}, ?
       WHERE ${input.predicateSql}
       RETURNING operation_id`,
    )
    .bind(
      input.operationId,
      input.actor.userId,
      input.action,
      input.learnerUserId,
      input.reason,
      ...detailsValues,
      input.now,
      ...input.predicateValues,
    );
}

export async function recordLearnerView(
  database: SecurityDatabase,
  input: {
    actor: SupportActor;
    learnerUserId: string;
    operationId: string;
    now: number;
    policy: StaffMfaPolicy;
  },
): Promise<boolean> {
  const guard = learnerGuard(
    input.actor.tokenDigest,
    input.learnerUserId,
    input.now,
    input.policy,
  );
  const result = await auditStatement(database, {
    operationId: input.operationId,
    actor: input.actor,
    action: "learner_record_viewed",
    learnerUserId: input.learnerUserId,
    reason: learnerRecordViewReason,
    detailsJson: null,
    now: input.now,
    predicateSql: guard.sql,
    predicateValues: guard.values as (string | number)[],
  }).all<{ operation_id: string }>();
  return result.results.length === 1;
}

/**
 * The only unmasked read. The audit insert and the select share both the contact
 * predicate and the statement guard, so a reveal either writes one audit row and
 * returns the address, or writes nothing at all.
 */
export async function revealLearnerContact(
  database: SecurityDatabase,
  input: {
    actor: SupportActor;
    learnerUserId: string;
    operationId: string;
    now: number;
    policy: StaffMfaPolicy;
  },
): Promise<LearnerAccessResult<{ contactKind: ContactKind; email: string }>> {
  const guard = learnerGuard(
    input.actor.tokenDigest,
    input.learnerUserId,
    input.now,
    input.policy,
  );
  const contactPredicate = `(
    EXISTS (
      SELECT 1 FROM learner_password_credentials AS contact_credential
      WHERE contact_credential.user_id = ?
    )
    OR EXISTS (
      SELECT 1 FROM learner_email_sign_in_invites AS contact_invite
      WHERE contact_invite.user_id = ?
    )
  )`;
  const results = await database.batch([
    auditStatement(database, {
      operationId: input.operationId,
      actor: input.actor,
      action: "learner_contact_revealed",
      learnerUserId: input.learnerUserId,
      reason: learnerContactRevealReason,
      detailsJson: '{"fields":["email"]}',
      now: input.now,
      predicateSql: `${contactPredicate} AND ${guard.sql}`,
      predicateValues: [
        input.learnerUserId,
        input.learnerUserId,
        ...guard.values,
      ] as (string | number)[],
    }),
    database
      .prepare(
        `SELECT contact.contact_kind AS contact_kind, contact.email AS email
         FROM (
           SELECT 'password-credential' AS contact_kind, c.email AS email,
                  0 AS preference
           FROM learner_password_credentials AS c
           WHERE c.user_id = ?
           UNION ALL
           SELECT 'sign-in-invite' AS contact_kind, i.email_normalized AS email,
                  1 AS preference
           FROM learner_email_sign_in_invites AS i
           WHERE i.user_id = ?
         ) AS contact
         WHERE ${guard.sql}
         ORDER BY contact.preference
         LIMIT 1`,
      )
      .bind(input.learnerUserId, input.learnerUserId, ...guard.values),
  ]);

  if ((results[0]?.meta.changes ?? 0) !== 1) {
    return { ok: false, reason: "contact-not-available" };
  }
  const row = (results[1]?.results ?? [])[0] as
    | { contact_kind: ContactKind; email: string }
    | undefined;
  if (!row) return { ok: false, reason: "not-found" };
  return { ok: true, value: { contactKind: row.contact_kind, email: row.email } };
}

export async function deactivateLearner(
  database: SecurityDatabase,
  input: {
    actor: SupportActor;
    learnerUserId: string;
    metadata: SupportMutation;
    policy: StaffMfaPolicy;
  },
): Promise<LearnerAccessResult<{ deactivatedAt: number }>> {
  const guard = learnerGuard(
    input.actor.tokenDigest,
    input.learnerUserId,
    input.metadata.now,
    input.policy,
  );
  const results = await database.batch([
    database
      .prepare(
        `UPDATE users
         SET status = 'disabled',
             deactivation_operation_id = ?,
             updated_at = ?
         WHERE id = ?
           AND status = 'active'
           AND ${guard.sql}
         RETURNING id`,
      )
      .bind(
        input.metadata.operationId,
        input.metadata.now,
        input.learnerUserId,
        ...guard.values,
      ),
    auditStatement(database, {
      operationId: input.metadata.operationId,
      actor: input.actor,
      action: "learner_deactivated",
      learnerUserId: input.learnerUserId,
      reason: input.metadata.reason,
      detailsJson: null,
      now: input.metadata.now,
      predicateSql: `EXISTS (
        SELECT 1 FROM users AS deactivated
        WHERE deactivated.id = ?
          AND deactivated.status = 'disabled'
          AND deactivated.deactivation_operation_id = ?
      )`,
      predicateValues: [input.learnerUserId, input.metadata.operationId],
    }),
  ]);

  const applied = results[0]?.meta.changes ?? 0;
  const audited = results[1]?.meta.changes ?? 0;
  if (applied !== 1 || audited !== 1) {
    // Zero rows changed and zero audit rows written: either the subject is gone
    // or it exists and the guarded update lost a race (the account was disabled
    // between the route's pre-check and this batch). Both are fail-closed; only
    // the existence probe distinguishes them, and it uses the same
    // staff-subject-excluding predicate as the capability layer.
    return {
      ok: false,
      reason: (await learnerSubjectExists(database, input.learnerUserId))
        ? "conflict"
        : "not-found",
    };
  }
  return { ok: true, value: { deactivatedAt: input.metadata.now } };
}

/**
 * Whether another account already holds this address, across both sign-in paths.
 * The predicate is identical for every case, so the 409 body cannot disclose
 * which path the other account uses.
 */
export async function contactHeldByAnotherLearner(
  database: SecurityDatabase,
  emailNormalized: string,
  learnerUserId: string,
): Promise<boolean> {
  const row = await database
    .withSession("first-primary")
    .prepare(
      `SELECT 1 AS held
       FROM (
         SELECT user_id FROM learner_password_credentials
         WHERE email_normalized = ?
         UNION
         SELECT user_id FROM learner_email_sign_in_invites
         WHERE email_normalized = ?
       ) AS holder
       WHERE holder.user_id <> ?
       LIMIT 1`,
    )
    .bind(emailNormalized, emailNormalized, learnerUserId)
    .first<{ held: number }>();
  return row !== null;
}

export function isContactIdentityAbort(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return message.includes(contactIdentityMessage);
}

export async function correctLearnerContact(
  database: SecurityDatabase,
  input: {
    actor: SupportActor;
    learnerUserId: string;
    email: string;
    emailNormalized: string;
    metadata: SupportMutation;
    policy: StaffMfaPolicy;
  },
): Promise<LearnerAccessResult<{ email: string }>> {
  const guard = learnerGuard(
    input.actor.tokenDigest,
    input.learnerUserId,
    input.metadata.now,
    input.policy,
  );
  // Owner decision (issue #46): moving the contact address must kill the old
  // address as a sign-in key. The invite row is the sign-in key, so a correction
  // revokes this learner's invite at the old address and consumes any token that
  // was already minted for it. Without this, correcting A -> B would leave a
  // live link keyed to A pointing at the same learner.
  //
  // The old address is read inside the transaction from the credential row
  // itself, never from a value the route read earlier, so the revocation cannot
  // target a stale address. `user_id` on every statement is what stops it from
  // touching another learner's invite, and the identity triggers reject any
  // attempt to create a second holder of one address.
  const changePending = `EXISTS (
    SELECT 1 FROM learner_password_credentials AS previous_credential
    WHERE previous_credential.user_id = ?
      AND previous_credential.email_normalized <> ?
  )`;
  try {
    const results = await database.batch([
      database
        .prepare(
          `UPDATE learner_email_sign_in_invites
           SET revoked_at = ?
           WHERE user_id = ?
             AND revoked_at IS NULL
             AND email_normalized = (
               SELECT email_normalized FROM learner_password_credentials
               WHERE user_id = ?
             )
             AND ${changePending}
             AND ${guard.sql}`,
        )
        .bind(
          input.metadata.now,
          input.learnerUserId,
          input.learnerUserId,
          input.learnerUserId,
          input.emailNormalized,
          ...guard.values,
        ),
      // Tokens have no revocation column, so `consumed_at` is the existing kill
      // switch, and a re-provision that clears `revoked_at` cannot revive an old
      // link. `consumed_operation_id` is UNIQUE, so every row needs its own
      // value: the attempt's operation id plus 8 random bytes. The suffix is
      // deliberately not the token digest — that column is documented as an
      // operation id, and copying a digest into a second place would widen the
      // number of rows that carry one.
      database
        .prepare(
          `UPDATE learner_email_sign_in_tokens
           SET consumed_at = ?,
               consumed_operation_id = ? || ':' || lower(hex(randomblob(8)))
           WHERE user_id = ?
             AND consumed_at IS NULL
             AND invite_email = (
               SELECT email_normalized FROM learner_password_credentials
               WHERE user_id = ?
             )
             AND ${changePending}
             AND ${guard.sql}`,
        )
        .bind(
          input.metadata.now,
          input.metadata.operationId,
          input.learnerUserId,
          input.learnerUserId,
          input.learnerUserId,
          input.emailNormalized,
          ...guard.values,
        ),
      database
        .prepare(
          `UPDATE learner_password_credentials
           SET email = ?,
               email_normalized = ?,
               contact_operation_id = ?,
               updated_at = ?
           WHERE user_id = ?
             AND email_normalized <> ?
             AND ${guard.sql}
           RETURNING user_id`,
        )
        .bind(
          input.email,
          input.emailNormalized,
          input.metadata.operationId,
          input.metadata.now,
          input.learnerUserId,
          input.emailNormalized,
          ...guard.values,
        ),
      auditStatement(database, {
        operationId: input.metadata.operationId,
        actor: input.actor,
        action: "learner_contact_corrected",
        learnerUserId: input.learnerUserId,
        reason: input.metadata.reason,
        detailsJson: null,
        // Field names plus the count of invites this operation revoked. No
        // address: `revoked_at = now` is this operation's own timestamp, so the
        // count is rows revoked at exactly this millisecond. The revocation
        // statement above is one writer of `revoked_at` but not the only one —
        // `provision-learner-sign-in-invite.mjs --revoke` writes it too — which
        // is why the count is scoped to this timestamp rather than to "revoked
        // invites on this learner".
        detailsExpression: {
          sql: `json_object(
            'fields', json_array('email'),
            'revokedInvites', (
              SELECT COUNT(*) FROM learner_email_sign_in_invites
              WHERE user_id = ? AND revoked_at = ?
            )
          )`,
          values: [input.learnerUserId, input.metadata.now],
        },
        now: input.metadata.now,
        predicateSql: `EXISTS (
          SELECT 1 FROM learner_password_credentials AS corrected
          WHERE corrected.user_id = ?
            AND corrected.contact_operation_id = ?
        )`,
        predicateValues: [input.learnerUserId, input.metadata.operationId],
      }),
    ]);

    const applied = results[2]?.meta.changes ?? 0;
    const audited = results[3]?.meta.changes ?? 0;
    if (applied !== 1 || audited !== 1) {
      // Subject gone, or the guarded write lost a race. Fail-closed either way;
      // existence decides 404 versus 409.
      return {
        ok: false,
        reason: (await learnerSubjectExists(database, input.learnerUserId))
          ? "conflict"
          : "not-found",
      };
    }
    return { ok: true, value: { email: input.email } };
  } catch (error) {
    // The storage trigger is the guarantee; this only turns it into the same 409
    // every other collision returns. Any other D1 failure stays a 503.
    if (isContactIdentityAbort(error)) {
      return { ok: false, reason: "contact-taken" };
    }
    throw error;
  }
}

interface HistoryRow {
  action: LearnerSupportAction;
  reason: string;
  occurred_at: number;
  operation_id: string;
  actor_role: StaffRole | null;
  actor_ref: string | null;
}

function historyActor(row: HistoryRow): "global_admin" | "manager" | "learner" | "system" {
  if (row.actor_role) return row.actor_role;
  return row.actor_ref === "learner-self-registration" ? "learner" : "system";
}

/**
 * The support history read. `cursor` is the last operation id of the previous
 * page; an unknown or foreign cursor is invalid input rather than an empty page.
 */
export async function listLearnerSupportHistory(
  database: SecurityDatabase,
  input: {
    actor: SupportActor;
    learnerUserId: string;
    now: number;
    policy: StaffMfaPolicy;
    limit: number;
    cursor: string | null;
    viewOperationId: string;
  },
): Promise<
  LearnerAccessResult<{
    items: Array<{
      action: LearnerSupportAction;
      actor: "global_admin" | "manager" | "learner" | "system";
      reason: string;
      occurredAt: number;
      operationId: string;
    }>;
    nextCursor: string | null;
  }>
> {
  const guard = learnerGuard(
    input.actor.tokenDigest,
    input.learnerUserId,
    input.now,
    input.policy,
  );
  const actions = supportActions.map(() => "?").join(", ");

  let cursorClause = "";
  const cursorValues: (string | number)[] = [];
  if (input.cursor !== null) {
    const anchor = await database
      .withSession("first-primary")
      .prepare(
        `SELECT occurred_at, operation_id FROM audit_events
         WHERE subject_type = 'user' AND subject_id = ? AND operation_id = ?`,
      )
      .bind(input.learnerUserId, input.cursor)
      .first<{ occurred_at: number; operation_id: string }>();
    if (!anchor) return { ok: false, reason: "invalid-input" };
    cursorClause = `AND (
      entry.occurred_at < ?
      OR (entry.occurred_at = ? AND entry.operation_id < ?)
    )`;
    cursorValues.push(
      anchor.occurred_at,
      anchor.occurred_at,
      anchor.operation_id,
    );
  }

  const select = database.prepare(
    `SELECT entry.action AS action,
            entry.reason AS reason,
            entry.occurred_at AS occurred_at,
            entry.operation_id AS operation_id,
            staff_role.role AS actor_role,
            entry.actor_ref AS actor_ref
     FROM audit_events AS entry
     LEFT JOIN staff_roles AS staff_role ON staff_role.user_id = entry.actor_user_id
     WHERE entry.subject_type = 'user'
       AND entry.subject_id = ?
       AND entry.action IN (${actions})
       ${cursorClause}
     ORDER BY entry.occurred_at DESC, entry.operation_id DESC
     LIMIT ?`,
  ).bind(
    input.learnerUserId,
    ...supportActions,
    ...cursorValues,
    input.limit + 1,
  );

  const results = await database.batch([
    select,
    auditStatement(database, {
      operationId: input.viewOperationId,
      actor: input.actor,
      action: "learner_support_history_viewed",
      learnerUserId: input.learnerUserId,
      reason: learnerSupportHistoryViewReason,
      detailsJson: null,
      now: input.now,
      predicateSql: guard.sql,
      predicateValues: guard.values as (string | number)[],
    }),
  ]);

  if ((results[1]?.meta.changes ?? 0) !== 1) {
    return { ok: false, reason: "not-found" };
  }

  const fetched = (results[0]?.results ?? []) as HistoryRow[];
  const items = fetched.slice(0, input.limit).map((row) => ({
    action: row.action,
    actor: historyActor(row),
    reason: row.reason,
    occurredAt: row.occurred_at,
    operationId: row.operation_id,
  }));
  return {
    ok: true,
    value: {
      items,
      nextCursor:
        fetched.length > input.limit && items.length > 0
          ? items[items.length - 1]!.operationId
          : null,
    },
  };
}
