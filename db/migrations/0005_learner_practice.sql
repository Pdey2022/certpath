CREATE TABLE learner_access_grants (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  certification_id TEXT NOT NULL REFERENCES certifications(id) ON DELETE RESTRICT,
  feature TEXT NOT NULL CHECK (feature = 'standard'),
  starts_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > starts_at),
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX learner_access_grants_active_idx
  ON learner_access_grants(user_id, certification_id, feature, starts_at, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE practice_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  certification_id TEXT NOT NULL,
  exam_version_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('creating', 'in_progress', 'completed')),
  version INTEGER NOT NULL CHECK (version > 0),
  question_count INTEGER NOT NULL CHECK (question_count BETWEEN 1 AND 20),
  current_position INTEGER NOT NULL CHECK (current_position BETWEEN 0 AND 20),
  correct_count INTEGER NOT NULL CHECK (correct_count BETWEEN 0 AND 20),
  filters_json TEXT NOT NULL CHECK (json_valid(filters_json)),
  create_request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (certification_id, exam_version_id)
    REFERENCES exam_versions(certification_id, id) ON DELETE RESTRICT,
  UNIQUE (user_id, create_request_id),
  UNIQUE (id, certification_id, exam_version_id)
);

CREATE INDEX practice_attempts_owner_scope_idx
  ON practice_attempts(user_id, certification_id, exam_version_id, created_at DESC);

CREATE TABLE practice_attempt_items (
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
    REFERENCES practice_attempts(id, certification_id, exam_version_id) ON DELETE RESTRICT,
  FOREIGN KEY (certification_id, exam_version_id, question_id, question_revision_id)
    REFERENCES question_revisions(certification_id, exam_version_id, question_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX practice_attempt_items_revision_idx
  ON practice_attempt_items(certification_id, question_revision_id);

CREATE TABLE practice_answer_events (
  attempt_id TEXT NOT NULL REFERENCES practice_attempts(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  item_position INTEGER NOT NULL CHECK (item_position BETWEEN 0 AND 19),
  selected_option_key TEXT NOT NULL,
  is_correct INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
  result_version INTEGER NOT NULL CHECK (result_version > 1),
  submitted_at INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, request_id),
  UNIQUE (attempt_id, item_position),
  FOREIGN KEY (attempt_id, item_position)
    REFERENCES practice_attempt_items(attempt_id, position) ON DELETE RESTRICT
);

CREATE INDEX practice_answer_events_attempt_idx
  ON practice_answer_events(attempt_id, item_position);

CREATE TRIGGER practice_attempts_validate_insert
BEFORE INSERT ON practice_attempts
WHEN NEW.state <> 'creating'
  OR NEW.version <> 1
  OR NEW.current_position <> 0
  OR NEW.correct_count <> 0
  OR NEW.completed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid practice attempt initialization');
END;

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

CREATE TRIGGER practice_attempt_items_validate_insert
BEFORE INSERT ON practice_attempt_items
WHEN NOT EXISTS (
  SELECT 1
  FROM practice_attempts AS attempt
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
  SELECT RAISE(ABORT, 'practice snapshots require currently published sealed revisions');
END;

CREATE TRIGGER practice_attempt_items_immutable_update
BEFORE UPDATE ON practice_attempt_items
BEGIN
  SELECT RAISE(ABORT, 'practice attempt snapshots are immutable');
END;

CREATE TRIGGER practice_attempt_items_immutable_delete
BEFORE DELETE ON practice_attempt_items
BEGIN
  SELECT RAISE(ABORT, 'practice attempt snapshots cannot be deleted');
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

CREATE TRIGGER practice_answer_events_advance_attempt
AFTER INSERT ON practice_answer_events
BEGIN
  UPDATE practice_attempts
  SET current_position = NEW.item_position + 1,
      correct_count = correct_count + NEW.is_correct,
      version = NEW.result_version,
      state = CASE
        WHEN NEW.item_position + 1 = question_count THEN 'completed'
        ELSE 'in_progress'
      END,
      updated_at = NEW.submitted_at,
      completed_at = CASE
        WHEN NEW.item_position + 1 = question_count THEN NEW.submitted_at
        ELSE NULL
      END
  WHERE id = NEW.attempt_id
    AND state = 'in_progress';
END;

CREATE TRIGGER practice_attempts_immutable_delete
BEFORE DELETE ON practice_attempts
BEGIN
  SELECT RAISE(ABORT, 'practice attempts are retained as history');
END;

CREATE TRIGGER practice_answer_events_immutable_update
BEFORE UPDATE ON practice_answer_events
BEGIN
  SELECT RAISE(ABORT, 'practice answer events are append-only');
END;

CREATE TRIGGER practice_answer_events_immutable_delete
BEFORE DELETE ON practice_answer_events
BEGIN
  SELECT RAISE(ABORT, 'practice answer events cannot be deleted');
END;
