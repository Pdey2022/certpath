CREATE TABLE learner_google_login_transactions (
  state_digest TEXT PRIMARY KEY NOT NULL
    CHECK (length(state_digest) = 64 AND state_digest NOT GLOB '*[^0-9a-f]*'),
  client_id TEXT NOT NULL,
  nonce_digest TEXT NOT NULL
    CHECK (length(nonce_digest) = 64 AND nonce_digest NOT GLOB '*[^0-9a-f]*'),
  browser_binding_digest TEXT NOT NULL
    CHECK (
      length(browser_binding_digest) = 64
      AND browser_binding_digest NOT GLOB '*[^0-9a-f]*'
    ),
  verifier_ciphertext TEXT NOT NULL,
  verifier_iv TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  consumed_at INTEGER,
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX learner_google_login_transactions_expiry_idx
  ON learner_google_login_transactions(expires_at);

CREATE TABLE learner_google_rate_limit_windows (
  scope TEXT NOT NULL CHECK (scope IN ('google_start_ip', 'google_callback_ip')),
  bucket_digest TEXT NOT NULL
    CHECK (length(bucket_digest) = 64 AND bucket_digest NOT GLOB '*[^0-9a-f]*'),
  window_started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > window_started_at),
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (scope, bucket_digest, window_started_at)
);

CREATE INDEX learner_google_rate_limit_windows_expiry_idx
  ON learner_google_rate_limit_windows(expires_at);
