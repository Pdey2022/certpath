-- 5F: the staff second factor. See docs/5f-staff-second-factor.md.
--
-- `tester-gate` is retired as an assurance label here, at the storage layer, and
-- replaced by `totp` (RFC 6238, HMAC-SHA1, 6 digits, 30 s). Password sign-in no
-- longer mints assurance at all: it inserts `mfa_method = NULL` and
-- `POST /admin/auth/mfa/verify` upgrades the same session row to `('totp', now)`.
-- Sessions still carrying `tester-gate` keep their rows and stop authenticating
-- (`mfa-assurance-unsupported`, 403) exactly as the 0016 convention says; nothing
-- here deletes or rewrites `app_sessions`.
--
-- Every invariant below is a constraint or a trigger, not a TypeScript check: one
-- live secret per person, a secret that is replaced rather than rewritten, a step
-- that only moves forward, ten recovery codes used once each, an enrolment ticket
-- consumed once, and an audit row for every act. The Worker can be wrong; the
-- storage cannot.

-- ---------------------------------------------------------------------------
-- 1. The TOTP seed, sealed at rest
-- ---------------------------------------------------------------------------
--
-- `secret_ciphertext` is AES-256-GCM under `STAFF_MFA_SEAL_KEY` with a per-row
-- 12-byte IV, so a reader of a `db:export` dump holds ciphertext and not a
-- factor. `key_version` exists for a future re-wrap; the secret columns are
-- immutable so a rotation is a new row, never an edit in place.

CREATE TABLE staff_totp_credentials (
  credential_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  secret_ciphertext TEXT NOT NULL
    CHECK (length(secret_ciphertext) BETWEEN 16 AND 512),
  secret_iv TEXT NOT NULL CHECK (length(secret_iv) BETWEEN 16 AND 64),
  key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version > 0),
  digits INTEGER NOT NULL CHECK (digits = 6),
  period_seconds INTEGER NOT NULL CHECK (period_seconds = 30),
  algorithm TEXT NOT NULL CHECK (algorithm = 'SHA1'),
  last_used_step INTEGER NOT NULL CHECK (last_used_step >= 0),
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  created_operation_id TEXT NOT NULL UNIQUE,
  revoked_at INTEGER,
  revoked_operation_id TEXT UNIQUE,
  CHECK ((confirmed_at IS NULL) OR (confirmed_at >= created_at)),
  CHECK ((revoked_at IS NULL) = (revoked_operation_id IS NULL))
);

-- One live secret per person. History is revoked, never deleted, so the partial
-- index is what stops a second enrolment from quietly creating a second factor.
CREATE UNIQUE INDEX staff_totp_credentials_active_idx
  ON staff_totp_credentials(user_id) WHERE revoked_at IS NULL;

CREATE INDEX staff_totp_credentials_user_idx
  ON staff_totp_credentials(user_id, created_at);

-- ---------------------------------------------------------------------------
-- 2. One-time recovery codes, stored only as digests
-- ---------------------------------------------------------------------------

CREATE TABLE staff_recovery_codes (
  code_digest TEXT PRIMARY KEY NOT NULL
    CHECK (length(code_digest) = 64 AND code_digest NOT GLOB '*[^0-9a-f]*'),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  set_operation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  used_at INTEGER,
  used_operation_id TEXT UNIQUE,
  CHECK ((used_at IS NULL) = (used_operation_id IS NULL))
);

CREATE INDEX staff_recovery_codes_user_idx
  ON staff_recovery_codes(user_id, set_operation_id);

-- ---------------------------------------------------------------------------
-- 3. Enrolment tickets: the printed half of "a password alone cannot enrol"
-- ---------------------------------------------------------------------------
--
-- The provisioning script and a Global-Admin reset mint one 256-bit token per
-- account. Only its SHA-256 digest is stored. `created_by_*` records the
-- authorising act, which is why a reset's authority is auditable even though the
-- `staff_mfa_reset` audit row names the subject rather than the actor.

CREATE TABLE staff_mfa_enrolment_tickets (
  ticket_digest TEXT PRIMARY KEY NOT NULL
    CHECK (length(ticket_digest) = 64 AND ticket_digest NOT GLOB '*[^0-9a-f]*'),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  created_by_ref TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_operation_id TEXT UNIQUE,
  revoked_at INTEGER,
  CHECK (expires_at > created_at),
  CHECK (expires_at - created_at <= 86400000),
  CHECK ((consumed_at IS NULL) = (consumed_operation_id IS NULL)),
  CHECK (
    (created_by_user_id IS NOT NULL AND created_by_ref IS NULL)
    OR
    (created_by_user_id IS NULL AND created_by_ref IS NOT NULL AND length(created_by_ref) BETWEEN 1 AND 128)
  )
);

CREATE INDEX staff_mfa_enrolment_tickets_user_idx
  ON staff_mfa_enrolment_tickets(user_id, expires_at);

-- ---------------------------------------------------------------------------
-- 4. `tester-gate` is retired
-- ---------------------------------------------------------------------------
--
-- This is the guarantee the design asks for: nothing - not a route, not
-- `d1 execute`, not a future module that got it wrong - can mint the label again.
-- Re-opening it requires an owner-approved migration that drops these triggers.

CREATE TRIGGER app_sessions_no_tester_gate_insert
BEFORE INSERT ON app_sessions
WHEN NEW.mfa_method = 'tester-gate'
BEGIN
  SELECT RAISE(ABORT, 'the tester-gate assurance is retired');
END;

CREATE TRIGGER app_sessions_no_tester_gate_update
BEFORE UPDATE OF mfa_method ON app_sessions
WHEN NEW.mfa_method = 'tester-gate'
BEGIN
  SELECT RAISE(ABORT, 'the tester-gate assurance is retired');
END;

-- ---------------------------------------------------------------------------
-- 5. TOTP credential invariants
-- ---------------------------------------------------------------------------

CREATE TRIGGER staff_totp_credentials_no_delete
BEFORE DELETE ON staff_totp_credentials
BEGIN
  SELECT RAISE(ABORT, 'a TOTP credential is revoked, never deleted');
END;

CREATE TRIGGER staff_totp_credentials_secret_immutable
BEFORE UPDATE OF secret_ciphertext, secret_iv, key_version ON staff_totp_credentials
BEGIN
  SELECT RAISE(ABORT, 'a TOTP secret is replaced, never rewritten');
END;

-- The replay backstop. The route compares `meta.changes` on its own conditional
-- update; this trigger is what holds when that route is wrong.
CREATE TRIGGER staff_totp_credentials_step_monotonic
BEFORE UPDATE OF last_used_step ON staff_totp_credentials
WHEN NEW.last_used_step <= OLD.last_used_step
BEGIN
  SELECT RAISE(ABORT, 'a TOTP step can only move forward');
END;

CREATE TRIGGER staff_totp_credentials_no_unrevoke
BEFORE UPDATE OF revoked_at ON staff_totp_credentials
WHEN OLD.revoked_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a revoked TOTP credential stays revoked');
END;

CREATE TRIGGER staff_totp_credentials_audit_insert
AFTER INSERT ON staff_totp_credentials
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, actor_ref, action, subject_type, subject_id,
    certification_id, reason, occurred_at
  ) VALUES (
    NEW.created_operation_id, NEW.user_id, NULL, 'staff_mfa_enrolled',
    'staff_mfa', NEW.user_id, NULL,
    'Staff second factor enrolled', NEW.created_at
  );
END;

CREATE TRIGGER staff_totp_credentials_audit_revoke
AFTER UPDATE OF revoked_at ON staff_totp_credentials
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, actor_ref, action, subject_type, subject_id,
    certification_id, reason, occurred_at
  ) VALUES (
    NEW.revoked_operation_id, NEW.user_id, NULL, 'staff_mfa_reset',
    'staff_mfa', NEW.user_id, NULL,
    'Staff second factor reset', NEW.revoked_at
  );
END;

-- ---------------------------------------------------------------------------
-- 6. Recovery-code invariants
-- ---------------------------------------------------------------------------

CREATE TRIGGER staff_recovery_codes_no_delete
BEFORE DELETE ON staff_recovery_codes
BEGIN
  SELECT RAISE(ABORT, 'a recovery code is revoked, never deleted');
END;

CREATE TRIGGER staff_recovery_codes_no_reuse
BEFORE UPDATE OF used_at ON staff_recovery_codes
WHEN OLD.used_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a recovery code is single-use');
END;

CREATE TRIGGER staff_recovery_codes_max_ten_active
BEFORE INSERT ON staff_recovery_codes
WHEN (
  SELECT COUNT(*) FROM staff_recovery_codes
  WHERE user_id = NEW.user_id AND revoked_at IS NULL AND used_at IS NULL
) >= 10
BEGIN
  SELECT RAISE(ABORT, 'at most ten active recovery codes per staff account');
END;

-- One audit row per issued *set*, not one per code: the ten rows share
-- `set_operation_id`, and `audit_events.operation_id` is the primary key, so the
-- first row of the set writes it and the rest see it and stand down.
CREATE TRIGGER staff_recovery_codes_audit_issued
AFTER INSERT ON staff_recovery_codes
WHEN NOT EXISTS (
  SELECT 1 FROM audit_events WHERE operation_id = NEW.set_operation_id
)
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, actor_ref, action, subject_type, subject_id,
    certification_id, reason, occurred_at
  ) VALUES (
    NEW.set_operation_id, NEW.user_id, NULL, 'staff_recovery_codes_issued',
    'staff_mfa', NEW.user_id, NULL,
    'Staff recovery codes issued', NEW.created_at
  );
END;

CREATE TRIGGER staff_recovery_codes_audit_used
AFTER UPDATE OF used_at ON staff_recovery_codes
WHEN OLD.used_at IS NULL AND NEW.used_at IS NOT NULL
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, actor_ref, action, subject_type, subject_id,
    certification_id, reason, occurred_at
  ) VALUES (
    NEW.used_operation_id, NEW.user_id, NULL, 'staff_recovery_code_used',
    'staff_mfa', NEW.user_id, NULL,
    'Staff recovery code redeemed', NEW.used_at
  );
END;

-- ---------------------------------------------------------------------------
-- 7. Enrolment-ticket invariants
-- ---------------------------------------------------------------------------

CREATE TRIGGER staff_mfa_enrolment_tickets_no_delete
BEFORE DELETE ON staff_mfa_enrolment_tickets
BEGIN
  SELECT RAISE(ABORT, 'an enrolment ticket is revoked, never deleted');
END;

CREATE TRIGGER staff_mfa_enrolment_tickets_consume_once
BEFORE UPDATE ON staff_mfa_enrolment_tickets
WHEN OLD.consumed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'the enrolment ticket is already consumed');
END;

CREATE TRIGGER staff_mfa_enrolment_tickets_audit_consume
AFTER UPDATE OF consumed_at ON staff_mfa_enrolment_tickets
WHEN OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, actor_ref, action, subject_type, subject_id,
    certification_id, reason, occurred_at
  ) VALUES (
    NEW.consumed_operation_id, NEW.user_id, NULL, 'staff_mfa_enrolment_authorised',
    'staff_mfa', NEW.user_id, NULL,
    'Staff MFA enrolment authorised', NEW.consumed_at
  );
END;

-- ---------------------------------------------------------------------------
-- 8. Rate-limit scopes, rebuilt as 0011 and 0012 rebuilt them
-- ---------------------------------------------------------------------------
--
-- Owner decision 1: rate limits are the *only* lockout control, so these scopes
-- carry real weight. Rows are preserved; only the closed scope list widens.

CREATE TABLE local_auth_rate_limit_windows_new (
  scope TEXT NOT NULL CHECK (
    scope IN (
      'registration_ip', 'registration_email',
      'sign_in_ip', 'sign_in_email',
      'recovery_ip', 'recovery_email',
      'verification_ip', 'password_reset_ip',
      'sign_in_link_request_ip', 'sign_in_link_request_email',
      'sign_in_link_inspect_ip', 'sign_in_link_redeem_ip',
      'staff_sign_in_ip', 'staff_sign_in_email',
      'staff_mfa_verify_ip', 'staff_mfa_verify_email',
      'staff_mfa_enrol_ip', 'staff_mfa_enrol_email',
      'staff_recovery_redeem_ip', 'staff_recovery_redeem_email'
    )
  ),
  bucket_digest TEXT NOT NULL
    CHECK (length(bucket_digest) = 64 AND bucket_digest NOT GLOB '*[^0-9a-f]*'),
  window_started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > window_started_at),
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (scope, bucket_digest, window_started_at)
);

INSERT INTO local_auth_rate_limit_windows_new (
  scope, bucket_digest, window_started_at, expires_at, request_count
)
SELECT scope, bucket_digest, window_started_at, expires_at, request_count
FROM local_auth_rate_limit_windows;

DROP TABLE local_auth_rate_limit_windows;
ALTER TABLE local_auth_rate_limit_windows_new
  RENAME TO local_auth_rate_limit_windows;

CREATE INDEX local_auth_rate_limit_expiry_idx
  ON local_auth_rate_limit_windows(expires_at);
