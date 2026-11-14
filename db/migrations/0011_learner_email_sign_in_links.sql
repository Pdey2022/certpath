-- Invite-only email sign-in links for pre-provisioned learners.
--
-- Only a SHA-256 digest of each single-use link token is stored. The invited
-- address is the only lookup key, so an address that was never provisioned can
-- never receive a link and can never create an account here.

CREATE TABLE learner_email_sign_in_invites (
  email_normalized TEXT PRIMARY KEY NOT NULL
    CHECK (length(email_normalized) BETWEEN 3 AND 254),
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE learner_email_sign_in_tokens (
  token_digest TEXT PRIMARY KEY NOT NULL
    CHECK (length(token_digest) = 64 AND token_digest NOT GLOB '*[^0-9a-f]*'),
  invite_email TEXT NOT NULL
    REFERENCES learner_email_sign_in_invites(email_normalized)
    ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_operation_id TEXT UNIQUE,
  CHECK (expires_at > created_at),
  CHECK (expires_at - created_at <= 900000),
  CHECK (
    (consumed_at IS NULL AND consumed_operation_id IS NULL)
    OR
    (consumed_at IS NOT NULL AND consumed_operation_id IS NOT NULL)
  )
);

CREATE INDEX learner_email_sign_in_tokens_invite_idx
  ON learner_email_sign_in_tokens(invite_email, expires_at);

CREATE INDEX learner_email_sign_in_tokens_expiry_idx
  ON learner_email_sign_in_tokens(expires_at);

-- The existing local proof window table has a closed scope list, so it is
-- rebuilt to admit the email-link scopes and keep one bounded rate-limit table.

CREATE TABLE local_auth_rate_limit_windows_new (
  scope TEXT NOT NULL CHECK (
    scope IN (
      'registration_ip', 'registration_email',
      'sign_in_ip', 'sign_in_email',
      'recovery_ip', 'recovery_email',
      'verification_ip', 'password_reset_ip',
      'sign_in_link_request_ip', 'sign_in_link_request_email',
      'sign_in_link_inspect_ip', 'sign_in_link_redeem_ip'
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
