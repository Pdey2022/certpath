CREATE TABLE cognito_login_transactions (
  state_digest TEXT PRIMARY KEY NOT NULL
    CHECK (length(state_digest) = 64 AND state_digest NOT GLOB '*[^0-9a-f]*'),
  audience TEXT NOT NULL CHECK (audience IN ('learner', 'staff')),
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

CREATE INDEX cognito_login_transactions_expiry_idx
  ON cognito_login_transactions(expires_at);
