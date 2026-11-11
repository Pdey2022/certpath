CREATE TABLE learner_password_credentials (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  email_normalized TEXT NOT NULL UNIQUE
    CHECK (length(email_normalized) BETWEEN 3 AND 254),
  subject TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
    CHECK (length(password_hash) BETWEEN 80 AND 256),
  email_verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX learner_password_credentials_verified_idx
  ON learner_password_credentials(email_normalized, email_verified_at);

CREATE TABLE learner_auth_tokens (
  token_digest TEXT PRIMARY KEY NOT NULL
    CHECK (length(token_digest) = 64 AND token_digest NOT GLOB '*[^0-9a-f]*'),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'password_reset')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  consumed_at INTEGER,
  consumed_operation_id TEXT UNIQUE,
  CHECK (
    (consumed_at IS NULL AND consumed_operation_id IS NULL)
    OR
    (consumed_at IS NOT NULL AND consumed_operation_id IS NOT NULL)
  )
);

CREATE INDEX learner_auth_tokens_user_purpose_idx
  ON learner_auth_tokens(user_id, purpose, expires_at);

CREATE TABLE local_auth_rate_limit_windows (
  scope TEXT NOT NULL CHECK (
    scope IN (
      'registration_ip', 'registration_email',
      'sign_in_ip', 'sign_in_email',
      'recovery_ip', 'recovery_email',
      'verification_ip', 'password_reset_ip'
    )
  ),
  bucket_digest TEXT NOT NULL
    CHECK (length(bucket_digest) = 64 AND bucket_digest NOT GLOB '*[^0-9a-f]*'),
  window_started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > window_started_at),
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (scope, bucket_digest, window_started_at)
);

CREATE INDEX local_auth_rate_limit_expiry_idx
  ON local_auth_rate_limit_windows(expires_at);
