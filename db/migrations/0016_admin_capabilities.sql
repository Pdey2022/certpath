-- 0016: admin capability model and learner support.
--
-- Adds the audit detail column and its JSON guard, replaces the blanket
-- no-delete audit trigger with a twelve-month retention bound, records the
-- operation that deactivated an account, records the operation that corrected a
-- learner contact address, and closes the cross-table contact identity hole.
--
-- No table is rebuilt, no data is copied, and every added column is nullable.
--
-- Rules: docs/decisions/0004-staff-capabilities-and-learner-data.md and
-- docs/admin-capabilities.md.

-- 1. Audit detail. Field names only - never a value.
ALTER TABLE audit_events ADD COLUMN details_json TEXT;

CREATE TRIGGER audit_events_details_valid_insert
BEFORE INSERT ON audit_events
WHEN NEW.details_json IS NOT NULL AND NOT json_valid(NEW.details_json)
BEGIN
  SELECT RAISE(ABORT, 'audit details must be JSON');
END;

CREATE INDEX audit_events_occurred_at_idx ON audit_events(occurred_at);

-- 2. Retention. Replaces the blanket append-only delete trigger: a row is
-- deletable once D1's own clock says it is older than 365 days, and nothing
-- younger can be deleted from any code path.
DROP TRIGGER audit_events_no_delete;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
WHEN OLD.occurred_at >= (CAST(strftime('%s','now') AS INTEGER) * 1000 - 31536000000)
BEGIN
  SELECT RAISE(ABORT, 'audit events are retained for 12 months');
END;

-- 3. Deactivation is terminal and witnessed.
ALTER TABLE users ADD COLUMN deactivation_operation_id TEXT;

CREATE TRIGGER users_deactivation_requires_operation
BEFORE UPDATE OF status ON users
WHEN NEW.status = 'disabled'
  AND (
    NEW.deactivation_operation_id IS NULL
    OR length(NEW.deactivation_operation_id) NOT BETWEEN 1 AND 128
  )
BEGIN
  SELECT RAISE(ABORT, 'deactivation requires an operation id');
END;

CREATE TRIGGER users_no_reactivation
BEFORE UPDATE OF status ON users
WHEN OLD.status = 'disabled' AND NEW.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'a deactivated account cannot be reactivated');
END;

-- 4. Contact correction is witnessed.
ALTER TABLE learner_password_credentials ADD COLUMN contact_operation_id TEXT;

-- 5. A contact address may identify only one learner, across both tables.
--
-- The comparison is user_id, so the same learner may hold the same address in
-- both tables; only a different user_id aborts. Revoked invites still reserve
-- their address, which is what keeps re-provisioning idempotent.
CREATE TRIGGER learner_password_credentials_contact_identity_insert
BEFORE INSERT ON learner_password_credentials
WHEN EXISTS (SELECT 1 FROM learner_email_sign_in_invites AS invite
  WHERE invite.email_normalized = NEW.email_normalized AND invite.user_id <> NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'a contact address may identify only one learner'); END;

CREATE TRIGGER learner_password_credentials_contact_identity_update
BEFORE UPDATE OF email_normalized, user_id ON learner_password_credentials
WHEN EXISTS (SELECT 1 FROM learner_email_sign_in_invites AS invite
  WHERE invite.email_normalized = NEW.email_normalized AND invite.user_id <> NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'a contact address may identify only one learner'); END;

CREATE TRIGGER learner_email_sign_in_invites_contact_identity_insert
BEFORE INSERT ON learner_email_sign_in_invites
WHEN EXISTS (SELECT 1 FROM learner_password_credentials AS credential
  WHERE credential.email_normalized = NEW.email_normalized AND credential.user_id <> NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'a contact address may identify only one learner'); END;

CREATE TRIGGER learner_email_sign_in_invites_contact_identity_update
BEFORE UPDATE OF email_normalized, user_id ON learner_email_sign_in_invites
WHEN EXISTS (SELECT 1 FROM learner_password_credentials AS credential
  WHERE credential.email_normalized = NEW.email_normalized AND credential.user_id <> NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'a contact address may identify only one learner'); END;
