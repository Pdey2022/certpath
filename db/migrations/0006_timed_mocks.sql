CREATE TABLE timed_mock_profiles (
  certification_id TEXT NOT NULL,
  exam_version_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 60 AND 14400),
  question_count INTEGER NOT NULL CHECK (question_count BETWEEN 1 AND 20),
  navigation_rule TEXT NOT NULL CHECK (navigation_rule = 'reviewable'),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (certification_id, exam_version_id, profile_version),
  FOREIGN KEY (certification_id, exam_version_id)
    REFERENCES exam_versions(certification_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX timed_mock_profiles_active_idx
  ON timed_mock_profiles(certification_id, exam_version_id)
  WHERE active = 1;

INSERT INTO timed_mock_profiles (
  certification_id, exam_version_id, profile_version, duration_seconds,
  question_count, navigation_rule, active, created_at
)
SELECT certification_id, id, 1, 900, 10, 'reviewable', 1, created_at
FROM exam_versions;

CREATE TRIGGER exam_versions_create_timed_mock_profile
AFTER INSERT ON exam_versions
BEGIN
  INSERT INTO timed_mock_profiles (
    certification_id, exam_version_id, profile_version, duration_seconds,
    question_count, navigation_rule, active, created_at
  ) VALUES (
    NEW.certification_id, NEW.id, 1, 900, 10, 'reviewable', 1, NEW.created_at
  );
END;

CREATE TABLE timed_mock_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  certification_id TEXT NOT NULL,
  exam_version_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('creating', 'in_progress', 'completed')),
  completion_reason TEXT CHECK (
    completion_reason IS NULL OR
    completion_reason IN ('learner_submitted', 'timed_out')
  ),
  version INTEGER NOT NULL CHECK (version > 0),
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 60 AND 14400),
  question_count INTEGER NOT NULL CHECK (question_count BETWEEN 1 AND 20),
  current_position INTEGER NOT NULL CHECK (current_position BETWEEN 0 AND 19),
  correct_count INTEGER NOT NULL DEFAULT 0 CHECK (correct_count BETWEEN 0 AND 20),
  started_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  create_request_id TEXT NOT NULL,
  completion_request_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (deadline_at = started_at + duration_seconds * 1000),
  CHECK (
    (state = 'completed' AND completion_reason IS NOT NULL AND completed_at IS NOT NULL)
    OR
    (state <> 'completed' AND completion_reason IS NULL AND completed_at IS NULL)
  ),
  FOREIGN KEY (certification_id, exam_version_id, profile_version)
    REFERENCES timed_mock_profiles(certification_id, exam_version_id, profile_version)
    ON DELETE RESTRICT,
  FOREIGN KEY (certification_id, exam_version_id)
    REFERENCES exam_versions(certification_id, id) ON DELETE RESTRICT,
  UNIQUE (user_id, create_request_id),
  UNIQUE (user_id, completion_request_id),
  UNIQUE (id, certification_id, exam_version_id)
);

CREATE INDEX timed_mock_attempts_owner_scope_idx
  ON timed_mock_attempts(user_id, certification_id, exam_version_id, created_at DESC);

CREATE TABLE timed_mock_items (
  attempt_id TEXT NOT NULL,
  certification_id TEXT NOT NULL,
  exam_version_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  question_revision_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 19),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  PRIMARY KEY (attempt_id, position),
  UNIQUE (attempt_id, question_id),
  FOREIGN KEY (attempt_id, certification_id, exam_version_id)
    REFERENCES timed_mock_attempts(id, certification_id, exam_version_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (certification_id, exam_version_id, question_id, question_revision_id)
    REFERENCES question_revisions(certification_id, exam_version_id, question_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE timed_mock_answers (
  attempt_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  selected_option_key TEXT NOT NULL,
  is_correct INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
  result_version INTEGER NOT NULL CHECK (result_version > 1),
  submitted_at INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, position),
  FOREIGN KEY (attempt_id, position)
    REFERENCES timed_mock_items(attempt_id, position) ON DELETE RESTRICT
);

CREATE TABLE timed_mock_commands (
  attempt_id TEXT NOT NULL REFERENCES timed_mock_attempts(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  command_type TEXT NOT NULL CHECK (command_type IN ('answer', 'navigate')),
  expected_version INTEGER NOT NULL CHECK (expected_version > 0),
  result_version INTEGER NOT NULL CHECK (result_version = expected_version + 1),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 19),
  selected_option_key TEXT,
  submitted_at INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, request_id),
  CHECK (
    (command_type = 'answer' AND selected_option_key IS NOT NULL)
    OR
    (command_type = 'navigate' AND selected_option_key IS NULL)
  ),
  FOREIGN KEY (attempt_id, position)
    REFERENCES timed_mock_items(attempt_id, position) ON DELETE RESTRICT
);

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

CREATE TRIGGER timed_mock_attempts_validate_update
BEFORE UPDATE ON timed_mock_attempts
WHEN OLD.state = 'completed'
  OR NEW.user_id <> OLD.user_id
  OR NEW.certification_id <> OLD.certification_id
  OR NEW.exam_version_id <> OLD.exam_version_id
  OR NEW.profile_version <> OLD.profile_version
  OR NEW.duration_seconds <> OLD.duration_seconds
  OR NEW.question_count <> OLD.question_count
  OR NEW.started_at <> OLD.started_at
  OR NEW.deadline_at <> OLD.deadline_at
  OR NEW.create_request_id <> OLD.create_request_id
  OR (
    NEW.state = 'completed'
    AND (
      (SELECT COUNT(*) FROM timed_mock_items WHERE attempt_id = NEW.id)
        <> NEW.question_count
      OR NEW.correct_count <> (
        SELECT COUNT(*) FROM timed_mock_answers
        WHERE attempt_id = NEW.id AND is_correct = 1
      )
      OR (
        NEW.completion_reason = 'timed_out'
        AND NEW.completed_at < NEW.deadline_at
      )
      OR (
        NEW.completion_reason = 'learner_submitted'
        AND NEW.completed_at >= NEW.deadline_at
      )
    )
  )
  OR (
    OLD.state = 'in_progress' AND NEW.state NOT IN ('in_progress', 'completed')
  )
  OR (
    OLD.state = 'creating' AND NEW.state NOT IN ('creating', 'in_progress')
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid timed mock state transition');
END;

CREATE TRIGGER timed_mock_items_validate_insert
BEFORE INSERT ON timed_mock_items
WHEN NOT EXISTS (
  SELECT 1 FROM timed_mock_attempts AS attempt
  JOIN exam_version_questions AS pointer
    ON pointer.certification_id = NEW.certification_id
   AND pointer.exam_version_id = NEW.exam_version_id
   AND pointer.question_id = NEW.question_id
   AND pointer.question_revision_id = NEW.question_revision_id
   AND pointer.publication_state = 'published'
  JOIN question_revision_seals AS seal
    ON seal.certification_id = NEW.certification_id
   AND seal.question_revision_id = NEW.question_revision_id
  WHERE attempt.id = NEW.attempt_id
    AND attempt.state = 'creating'
    AND attempt.certification_id = NEW.certification_id
    AND attempt.exam_version_id = NEW.exam_version_id
    AND NEW.position < attempt.question_count
    AND json_type(NEW.snapshot_json, '$.options') = 'array'
    AND json_array_length(NEW.snapshot_json, '$.options') BETWEEN 2 AND 8
    AND EXISTS (
      SELECT 1 FROM json_each(NEW.snapshot_json, '$.options') AS option
      WHERE json_extract(option.value, '$.key') =
        json_extract(NEW.snapshot_json, '$.correctOptionKey')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'timed mock snapshots require published sealed revisions');
END;

CREATE TRIGGER timed_mock_items_immutable_update
BEFORE UPDATE ON timed_mock_items
BEGIN
  SELECT RAISE(ABORT, 'timed mock snapshots are immutable');
END;

CREATE TRIGGER timed_mock_items_immutable_delete
BEFORE DELETE ON timed_mock_items
BEGIN
  SELECT RAISE(ABORT, 'timed mock snapshots cannot be deleted');
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

CREATE TRIGGER timed_mock_commands_apply
AFTER INSERT ON timed_mock_commands
BEGIN
  INSERT INTO timed_mock_answers (
    attempt_id, position, selected_option_key, is_correct,
    result_version, submitted_at
  )
  SELECT NEW.attempt_id, NEW.position, NEW.selected_option_key,
         CASE WHEN json_extract(item.snapshot_json, '$.correctOptionKey') =
                   NEW.selected_option_key THEN 1 ELSE 0 END,
         NEW.result_version, NEW.submitted_at
  FROM timed_mock_items AS item
  WHERE NEW.command_type = 'answer'
    AND item.attempt_id = NEW.attempt_id
    AND item.position = NEW.position
  ON CONFLICT(attempt_id, position) DO UPDATE SET
    selected_option_key = excluded.selected_option_key,
    is_correct = excluded.is_correct,
    result_version = excluded.result_version,
    submitted_at = excluded.submitted_at;

  UPDATE timed_mock_attempts
  SET current_position = NEW.position,
      version = NEW.result_version,
      updated_at = NEW.submitted_at
  WHERE id = NEW.attempt_id
    AND state = 'in_progress'
    AND version = NEW.expected_version;
END;

CREATE TRIGGER timed_mock_commands_immutable_update
BEFORE UPDATE ON timed_mock_commands
BEGIN
  SELECT RAISE(ABORT, 'timed mock commands are append-only');
END;

CREATE TRIGGER timed_mock_commands_immutable_delete
BEFORE DELETE ON timed_mock_commands
BEGIN
  SELECT RAISE(ABORT, 'timed mock commands cannot be deleted');
END;

CREATE TRIGGER timed_mock_attempts_immutable_delete
BEFORE DELETE ON timed_mock_attempts
BEGIN
  SELECT RAISE(ABORT, 'timed mock attempts are retained as history');
END;

CREATE TRIGGER timed_mock_answers_validate_update
BEFORE UPDATE ON timed_mock_answers
WHEN NOT EXISTS (
  SELECT 1 FROM timed_mock_attempts AS attempt
  JOIN timed_mock_items AS item
    ON item.attempt_id = attempt.id AND item.position = NEW.position
  JOIN json_each(item.snapshot_json, '$.options') AS option
    ON json_extract(option.value, '$.key') = NEW.selected_option_key
  WHERE attempt.id = NEW.attempt_id
    AND attempt.state = 'in_progress'
    AND attempt.deadline_at > NEW.submitted_at
    AND NEW.is_correct = CASE
      WHEN json_extract(item.snapshot_json, '$.correctOptionKey') =
           NEW.selected_option_key THEN 1 ELSE 0 END
)
BEGIN
  SELECT RAISE(ABORT, 'invalid timed mock answer update');
END;
