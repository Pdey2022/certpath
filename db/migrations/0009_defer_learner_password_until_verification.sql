CREATE TABLE learner_password_credentials_new (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  email_normalized TEXT NOT NULL UNIQUE
    CHECK (length(email_normalized) BETWEEN 3 AND 254),
  subject TEXT NOT NULL UNIQUE,
  password_hash TEXT
    CHECK (
      password_hash IS NULL OR length(password_hash) BETWEEN 80 AND 256
    ),
  email_verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (email_verified_at IS NULL AND password_hash IS NULL)
    OR (email_verified_at IS NOT NULL AND password_hash IS NOT NULL)
  )
);

INSERT INTO learner_password_credentials_new (
  user_id, email, email_normalized, subject, password_hash,
  email_verified_at, created_at, updated_at
)
SELECT user_id, email, email_normalized, subject,
       CASE WHEN email_verified_at IS NULL THEN NULL ELSE password_hash END,
       email_verified_at, created_at, updated_at
FROM learner_password_credentials;

DROP TABLE learner_password_credentials;
ALTER TABLE learner_password_credentials_new
  RENAME TO learner_password_credentials;

CREATE INDEX learner_password_credentials_verified_idx
  ON learner_password_credentials(email_normalized, email_verified_at);
