-- 0013: entitlements - Pro features, grant provenance, and coverage rules.
--
-- Widens learner_access_grants from Standard-only to Standard + Pro, records how
-- each grant was created (sku, source, operation) and audits it, and enforces at
-- the storage layer that a Pro grant is fully covered by a Standard grant.
--
-- Five existing triggers on practice and timed-mock tables read this table, so
-- they are dropped and recreated verbatim around the rebuild (SQLite refuses to
-- drop a table that a trigger body references).
--
-- Rules: docs/decisions/0003-pricing-pro-and-refunds.md and
-- docs/decisions/0005-readiness-and-access-lifecycle.md.
-- Dependent triggers, recreated verbatim after the rebuild.
DROP TRIGGER practice_attempts_finalize;
DROP TRIGGER practice_answer_events_validate_insert;
DROP TRIGGER timed_mock_attempts_validate_insert;
DROP TRIGGER timed_mock_attempts_finalize;
DROP TRIGGER timed_mock_commands_validate_insert;

CREATE TABLE learner_access_grants_new (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  certification_id TEXT NOT NULL REFERENCES certifications(id) ON DELETE RESTRICT,
  feature TEXT NOT NULL CHECK (feature IN ('standard', 'pro')),
  starts_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > starts_at),
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  sku TEXT,
  source TEXT CHECK (
    source IS NULL
    OR source IN ('purchase', 'grant', 'extension', 'bundle', 'migration')
  ),
  operation_id TEXT UNIQUE,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  revocation_operation_id TEXT UNIQUE,
  revoked_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  CHECK (
    (revoked_at IS NULL AND revocation_operation_id IS NULL
      AND revoked_by_user_id IS NULL)
    OR
    (revoked_at IS NOT NULL AND revocation_operation_id IS NOT NULL
      AND revoked_by_user_id IS NOT NULL)
  )
);

INSERT INTO learner_access_grants_new (
  id, user_id, certification_id, feature, starts_at, expires_at, revoked_at,
  created_at, source
)
SELECT
  id, user_id, certification_id, feature, starts_at, expires_at, revoked_at,
  created_at, 'migration'
FROM learner_access_grants;

DROP TABLE learner_access_grants;

ALTER TABLE learner_access_grants_new RENAME TO learner_access_grants;

CREATE INDEX learner_access_grants_active_idx
  ON learner_access_grants(
    user_id, certification_id, feature, starts_at, expires_at
  )
  WHERE revoked_at IS NULL;

CREATE INDEX learner_access_grants_certification_feature_idx
  ON learner_access_grants(certification_id, feature, starts_at, expires_at);
CREATE TRIGGER practice_attempts_finalize
BEFORE UPDATE OF state ON practice_attempts
WHEN OLD.state = 'creating'
  AND NEW.state = 'in_progress'
  AND (
    (SELECT COUNT(*) FROM practice_attempt_items WHERE attempt_id = NEW.id)
      <> NEW.question_count
    OR NOT EXISTS (
      SELECT 1
      FROM app_sessions AS session
      JOIN users AS user ON user.id = session.user_id
      JOIN learner_access_grants AS access_grant
        ON access_grant.user_id = session.user_id
       AND access_grant.certification_id = NEW.certification_id
       AND access_grant.feature = 'standard'
      WHERE session.user_id = NEW.user_id
        AND session.revoked_at IS NULL
        AND session.expires_at > NEW.updated_at
        AND user.status = 'active'
        AND access_grant.revoked_at IS NULL
        AND access_grant.starts_at <= NEW.updated_at
        AND access_grant.expires_at > NEW.updated_at
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'practice attempt snapshot is incomplete or unauthorized');
END;

CREATE TRIGGER practice_answer_events_validate_insert
BEFORE INSERT ON practice_answer_events
WHEN NOT EXISTS (
  SELECT 1
  FROM practice_attempts AS attempt
  JOIN practice_attempt_items AS item
    ON item.attempt_id = attempt.id
   AND item.position = NEW.item_position
  JOIN learner_access_grants AS access_grant
    ON access_grant.user_id = attempt.user_id
   AND access_grant.certification_id = attempt.certification_id
   AND access_grant.feature = 'standard'
  WHERE attempt.id = NEW.attempt_id
    AND attempt.state = 'in_progress'
    AND attempt.version + 1 = NEW.result_version
    AND attempt.current_position = NEW.item_position
    AND access_grant.revoked_at IS NULL
    AND access_grant.starts_at <= NEW.submitted_at
    AND access_grant.expires_at > NEW.submitted_at
    AND EXISTS (
      SELECT 1 FROM json_each(item.snapshot_json, '$.options') AS option
      WHERE json_extract(option.value, '$.key') = NEW.selected_option_key
    )
    AND NEW.is_correct = CASE
      WHEN json_extract(item.snapshot_json, '$.correctOptionKey') = NEW.selected_option_key
        THEN 1 ELSE 0 END
)
BEGIN
  SELECT RAISE(ABORT, 'invalid or unauthorized practice answer');
END;

CREATE TRIGGER timed_mock_attempts_validate_insert
BEFORE INSERT ON timed_mock_attempts
WHEN NEW.state <> 'creating'
  OR NEW.version <> 1
  OR NEW.completion_reason IS NOT NULL
  OR NEW.current_position <> 0
  OR NEW.correct_count <> 0
  OR NEW.completed_at IS NOT NULL
  OR NOT EXISTS (
    SELECT 1 FROM timed_mock_profiles AS profile
    JOIN learner_access_grants AS grant_record
      ON grant_record.certification_id = profile.certification_id
     AND grant_record.user_id = NEW.user_id
     AND grant_record.feature = 'standard'
    JOIN app_sessions AS session ON session.user_id = NEW.user_id
    JOIN users AS user ON user.id = NEW.user_id
    WHERE profile.certification_id = NEW.certification_id
      AND profile.exam_version_id = NEW.exam_version_id
      AND profile.profile_version = NEW.profile_version
      AND profile.active = 1
      AND profile.duration_seconds = NEW.duration_seconds
      AND profile.question_count = NEW.question_count
      AND session.revoked_at IS NULL
      AND session.expires_at > NEW.started_at
      AND user.status = 'active'
      AND grant_record.revoked_at IS NULL
      AND grant_record.starts_at <= NEW.started_at
      AND grant_record.expires_at > NEW.started_at
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid or unauthorized timed mock initialization');
END;

CREATE TRIGGER timed_mock_attempts_finalize
BEFORE UPDATE OF state ON timed_mock_attempts
WHEN OLD.state = 'creating'
  AND NEW.state = 'in_progress'
  AND (
    (SELECT COUNT(*) FROM timed_mock_items WHERE attempt_id = NEW.id)
      <> NEW.question_count
    OR NEW.version <> 1
    OR NOT EXISTS (
      SELECT 1 FROM learner_access_grants AS grant_record
      JOIN app_sessions AS session ON session.user_id = NEW.user_id
      JOIN users AS user ON user.id = NEW.user_id
      WHERE grant_record.user_id = NEW.user_id
        AND grant_record.certification_id = NEW.certification_id
        AND grant_record.feature = 'standard'
        AND grant_record.revoked_at IS NULL
        AND grant_record.starts_at <= NEW.updated_at
        AND grant_record.expires_at > NEW.updated_at
        AND session.revoked_at IS NULL
        AND session.expires_at > NEW.updated_at
        AND user.status = 'active'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'timed mock snapshot is incomplete or unauthorized');
END;

CREATE TRIGGER timed_mock_commands_validate_insert
BEFORE INSERT ON timed_mock_commands
WHEN NOT EXISTS (
  SELECT 1 FROM timed_mock_attempts AS attempt
  WHERE attempt.id = NEW.attempt_id
    AND attempt.state = 'in_progress'
    AND attempt.version = NEW.expected_version
    AND attempt.deadline_at > NEW.submitted_at
    AND NEW.position < attempt.question_count
    AND EXISTS (
      SELECT 1 FROM learner_access_grants AS grant_record
      WHERE grant_record.user_id = attempt.user_id
        AND grant_record.certification_id = attempt.certification_id
        AND grant_record.feature = 'standard'
        AND grant_record.revoked_at IS NULL
        AND grant_record.starts_at <= NEW.submitted_at
        AND grant_record.expires_at > NEW.submitted_at
    )
    AND EXISTS (
      SELECT 1 FROM app_sessions AS session
      JOIN users AS user ON user.id = session.user_id
      WHERE session.user_id = attempt.user_id
        AND session.revoked_at IS NULL
        AND session.expires_at > NEW.submitted_at
        AND user.status = 'active'
    )
    AND (
      NEW.command_type = 'navigate'
      OR EXISTS (
        SELECT 1 FROM json_each(
          (SELECT snapshot_json FROM timed_mock_items
           WHERE attempt_id = attempt.id AND position = NEW.position),
          '$.options'
        ) AS option
        WHERE json_extract(option.value, '$.key') = NEW.selected_option_key
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid, stale, or unauthorized timed mock command');
END;

CREATE TRIGGER learner_access_grants_pro_requires_standard
BEFORE INSERT ON learner_access_grants
WHEN NEW.feature = 'pro'
BEGIN
  SELECT RAISE(
    ABORT,
    'a pro grant requires a standard grant covering the same window'
  )
  WHERE NOT EXISTS (
    SELECT 1
    FROM learner_access_grants AS standard
    WHERE standard.user_id = NEW.user_id
      AND standard.certification_id = NEW.certification_id
      AND standard.feature = 'standard'
      AND standard.revoked_at IS NULL
      AND standard.starts_at <= NEW.starts_at
      AND standard.expires_at >= NEW.expires_at
  );
END;

CREATE TRIGGER learner_access_grants_audit_insert
AFTER INSERT ON learner_access_grants
WHEN NEW.operation_id IS NOT NULL
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, actor_ref, action, subject_type, subject_id,
    certification_id, reason, occurred_at
  )
  VALUES (
    NEW.operation_id, NEW.created_by_user_id,
    CASE WHEN NEW.created_by_user_id IS NULL THEN 'access-grant' END,
    'access_granted', 'learner_access_grant', NEW.id, NEW.certification_id,
    NEW.sku, NEW.created_at
  );
END;

CREATE TRIGGER learner_access_grants_audit_revoke
AFTER UPDATE OF revoked_at ON learner_access_grants
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, actor_ref, action, subject_type, subject_id,
    certification_id, reason, occurred_at
  )
  VALUES (
    NEW.revocation_operation_id, NEW.revoked_by_user_id, NULL,
    'access_revoked', 'learner_access_grant', NEW.id, NEW.certification_id,
    'Access revoked', NEW.revoked_at
  );
END;
