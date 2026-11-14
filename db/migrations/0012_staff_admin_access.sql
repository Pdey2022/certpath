-- Staff sign-in for the tester-only production admin panel.
--
-- Credentials are only accepted for an account that already holds an active
-- staff role, and only the password hash is stored. Provisioning happens
-- offline; no password material reaches the Worker.

CREATE TABLE staff_password_credentials (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  email_normalized TEXT NOT NULL UNIQUE
    CHECK (length(email_normalized) BETWEEN 3 AND 254),
  password_hash TEXT NOT NULL
    CHECK (length(password_hash) BETWEEN 80 AND 256),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX staff_password_credentials_email_idx
  ON staff_password_credentials(email_normalized);

-- The rate-limit window table keeps one bounded implementation; it is rebuilt
-- again to admit the staff sign-in scopes.

CREATE TABLE local_auth_rate_limit_windows_new (
  scope TEXT NOT NULL CHECK (
    scope IN (
      'registration_ip', 'registration_email',
      'sign_in_ip', 'sign_in_email',
      'recovery_ip', 'recovery_email',
      'verification_ip', 'password_reset_ip',
      'sign_in_link_request_ip', 'sign_in_link_request_email',
      'sign_in_link_inspect_ip', 'sign_in_link_redeem_ip',
      'staff_sign_in_ip', 'staff_sign_in_email'
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
