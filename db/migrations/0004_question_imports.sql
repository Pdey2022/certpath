CREATE TABLE question_import_previews (
  id TEXT PRIMARY KEY NOT NULL,
  certification_id TEXT NOT NULL,
  exam_version_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  format_version TEXT NOT NULL CHECK (format_version = 'certpath-question-v1'),
  state TEXT NOT NULL CHECK (
    state IN ('constructing', 'previewed', 'confirming', 'confirmed', 'expired')
  ),
  row_count INTEGER NOT NULL CHECK (row_count BETWEEN 1 AND 10),
  payload_digest TEXT NOT NULL CHECK (
    length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (
    expires_at > created_at AND expires_at <= created_at + 900000
  ),
  confirmed_at INTEGER,
  expired_at INTEGER,
  CHECK (
    (state = 'confirmed') = (confirmed_at IS NOT NULL)
    AND (state = 'expired') = (expired_at IS NOT NULL)
    AND (confirmed_at IS NULL OR confirmed_at <= expires_at)
    AND (expired_at IS NULL OR expired_at >= expires_at)
  ),
  FOREIGN KEY (certification_id, exam_version_id)
    REFERENCES exam_versions(certification_id, id) ON DELETE RESTRICT,
  UNIQUE (id, certification_id, exam_version_id)
);

CREATE INDEX question_import_previews_expiry_idx
  ON question_import_previews(state, expires_at, id);

CREATE TABLE question_import_rows (
  import_id TEXT NOT NULL REFERENCES question_import_previews(id) ON DELETE RESTRICT,
  row_number INTEGER NOT NULL CHECK (row_number BETWEEN 1 AND 10),
  question_key TEXT NOT NULL CHECK (length(trim(question_key)) BETWEEN 1 AND 120),
  question_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  content_json TEXT CHECK (
    content_json IS NULL
    OR (json_valid(content_json) AND length(CAST(content_json AS BLOB)) <= 524288)
  ),
  PRIMARY KEY (import_id, row_number),
  UNIQUE (question_id),
  UNIQUE (revision_id)
);

CREATE TABLE question_import_results (
  import_id TEXT NOT NULL,
  row_number INTEGER NOT NULL,
  certification_id TEXT NOT NULL,
  exam_version_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  PRIMARY KEY (import_id, row_number),
  UNIQUE (question_id),
  UNIQUE (revision_id),
  FOREIGN KEY (import_id, row_number)
    REFERENCES question_import_rows(import_id, row_number) ON DELETE RESTRICT,
  FOREIGN KEY (certification_id, question_id)
    REFERENCES questions(certification_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (certification_id, exam_version_id, question_id, revision_id)
    REFERENCES question_revisions(certification_id, exam_version_id, question_id, id)
    ON DELETE RESTRICT
);

CREATE TRIGGER question_import_results_validate_insert
BEFORE INSERT ON question_import_results
WHEN NOT EXISTS (
  SELECT 1
  FROM question_import_previews AS preview
  JOIN question_import_rows AS import_row
    ON import_row.import_id = preview.id
   AND import_row.row_number = NEW.row_number
  JOIN questions AS question
    ON question.id = NEW.question_id
   AND question.id = import_row.question_id
   AND question.certification_id = NEW.certification_id
   AND question.question_key = import_row.question_key
   AND question.created_by_user_id = preview.actor_user_id
   AND question.created_operation_id = preview.id || ':row:' || NEW.row_number || ':question'
  JOIN question_revisions AS revision
    ON revision.id = NEW.revision_id
   AND revision.id = import_row.revision_id
   AND revision.certification_id = NEW.certification_id
   AND revision.exam_version_id = NEW.exam_version_id
   AND revision.question_id = question.id
   AND revision.authored_by_user_id = preview.actor_user_id
   AND revision.created_operation_id = preview.id || ':row:' || NEW.row_number || ':revision'
  JOIN question_revision_seals AS seal
    ON seal.certification_id = revision.certification_id
   AND seal.question_revision_id = revision.id
  WHERE preview.id = NEW.import_id
    AND preview.state = 'confirming'
    AND preview.certification_id = NEW.certification_id
    AND preview.exam_version_id = NEW.exam_version_id
    AND import_row.content_json IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'question import result does not match a sealed draft');
END;

CREATE TRIGGER question_import_results_immutable_update
BEFORE UPDATE ON question_import_results
BEGIN
  SELECT RAISE(ABORT, 'question import outcomes are immutable');
END;

CREATE TRIGGER question_import_results_immutable_delete
BEFORE DELETE ON question_import_results
BEGIN
  SELECT RAISE(ABORT, 'question import outcomes are permanent');
END;

CREATE TRIGGER question_import_rows_validate_insert
BEFORE INSERT ON question_import_rows
WHEN NOT EXISTS (
  SELECT 1
  FROM question_import_previews AS preview
  WHERE preview.id = NEW.import_id
    AND preview.state = 'constructing'
    AND NEW.row_number <= preview.row_count
)
OR NEW.content_json IS NULL
OR json_extract(NEW.content_json, '$.questionKey') <> NEW.question_key
OR json_extract(NEW.content_json, '$.questionId') <> NEW.question_id
OR json_extract(NEW.content_json, '$.revisionId') <> NEW.revision_id
BEGIN
  SELECT RAISE(ABORT, 'question import rows require a matching construction');
END;

CREATE TRIGGER question_import_rows_validate_update
BEFORE UPDATE ON question_import_rows
WHEN OLD.content_json IS NULL
  OR NEW.content_json IS NOT NULL
  OR NEW.import_id <> OLD.import_id
  OR NEW.row_number <> OLD.row_number
  OR NEW.question_key <> OLD.question_key
  OR NEW.question_id <> OLD.question_id
  OR NEW.revision_id <> OLD.revision_id
  OR NOT EXISTS (
    SELECT 1 FROM question_import_previews
    WHERE id = OLD.import_id AND state = 'confirmed'
  )
BEGIN
  SELECT RAISE(ABORT, 'question import rows are immutable');
END;

CREATE TRIGGER question_import_rows_validate_delete
BEFORE DELETE ON question_import_rows
WHEN NOT EXISTS (
  SELECT 1 FROM question_import_previews
  WHERE id = OLD.import_id AND state = 'expired'
)
BEGIN
  SELECT RAISE(ABORT, 'question import rows may only expire');
END;

CREATE TRIGGER question_import_previews_validate_update
BEFORE UPDATE ON question_import_previews
WHEN NEW.id <> OLD.id
  OR NEW.certification_id <> OLD.certification_id
  OR NEW.exam_version_id <> OLD.exam_version_id
  OR NEW.actor_user_id <> OLD.actor_user_id
  OR NEW.format_version <> OLD.format_version
  OR NEW.row_count <> OLD.row_count
  OR NEW.payload_digest <> OLD.payload_digest
  OR NEW.created_at <> OLD.created_at
  OR NEW.expires_at <> OLD.expires_at
  OR (
    NEW.confirmed_at IS NOT OLD.confirmed_at
    AND NOT (OLD.state = 'confirming' AND NEW.state = 'confirmed')
  )
  OR (
    NEW.expired_at IS NOT OLD.expired_at
    AND NOT (OLD.state = 'previewed' AND NEW.state = 'expired')
  )
  OR NOT (
    (OLD.state = 'constructing' AND NEW.state = 'previewed')
    OR (OLD.state = 'previewed' AND NEW.state IN ('confirming', 'expired'))
    OR (OLD.state = 'confirming' AND NEW.state = 'confirmed')
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid question import transition');
END;

CREATE TRIGGER question_import_previews_validate_preview
BEFORE UPDATE OF state ON question_import_previews
WHEN NEW.state = 'previewed'
  AND (
    (SELECT COUNT(*) FROM question_import_rows WHERE import_id = NEW.id) <> NEW.row_count
    OR (SELECT MIN(row_number) FROM question_import_rows WHERE import_id = NEW.id) <> 1
    OR (SELECT MAX(row_number) FROM question_import_rows WHERE import_id = NEW.id) <> NEW.row_count
    OR EXISTS (
      SELECT 1 FROM question_import_rows
      WHERE import_id = NEW.id AND content_json IS NULL
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'question import preview construction is incomplete');
END;

CREATE TRIGGER question_import_previews_validate_confirmation
BEFORE UPDATE OF state ON question_import_previews
WHEN NEW.state = 'confirmed'
  AND (
    NEW.confirmed_at IS NULL
    OR (SELECT COUNT(*) FROM question_import_rows WHERE import_id = NEW.id) <> NEW.row_count
    OR (SELECT COUNT(*) FROM question_import_results WHERE import_id = NEW.id) <> NEW.row_count
    OR (SELECT MIN(row_number) FROM question_import_results WHERE import_id = NEW.id) <> 1
    OR (SELECT MAX(row_number) FROM question_import_results WHERE import_id = NEW.id) <> NEW.row_count
    OR EXISTS (
      SELECT 1
      FROM question_import_rows AS import_row
      LEFT JOIN questions AS question
        ON question.id = import_row.question_id
      LEFT JOIN question_revisions AS revision
        ON revision.id = import_row.revision_id
       AND revision.question_id = question.id
      LEFT JOIN question_revision_seals AS seal
        ON seal.question_revision_id = revision.id
       AND seal.certification_id = revision.certification_id
      LEFT JOIN question_revision_events AS draft_event
        ON draft_event.question_revision_id = revision.id
       AND draft_event.sequence_number = 1
       AND draft_event.event_type = 'draft'
      WHERE import_row.import_id = NEW.id
        AND (
          import_row.content_json IS NULL
          OR question.id IS NULL
          OR question.certification_id <> NEW.certification_id
          OR question.question_key <> import_row.question_key
          OR question.created_by_user_id <> NEW.actor_user_id
          OR question.created_operation_id <> NEW.id || ':row:' || import_row.row_number || ':question'
          OR revision.id IS NULL
          OR revision.certification_id <> NEW.certification_id
          OR revision.exam_version_id <> NEW.exam_version_id
          OR revision.authored_by_user_id <> NEW.actor_user_id
          OR revision.created_operation_id <> NEW.id || ':row:' || import_row.row_number || ':revision'
          OR revision.exam_version_id <> json_extract(import_row.content_json, '$.examVersionId')
          OR revision.domain_id <> json_extract(import_row.content_json, '$.domainId')
          OR revision.topic_id <> json_extract(import_row.content_json, '$.topicId')
          OR seal.question_revision_id IS NULL
          OR draft_event.question_revision_id IS NULL
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'question import confirmation is incomplete');
END;

CREATE TRIGGER question_import_previews_audit_preview
AFTER UPDATE OF state ON question_import_previews
WHEN OLD.state = 'constructing' AND NEW.state = 'previewed'
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, action, subject_type, subject_id,
    certification_id, reason, occurred_at
  )
  VALUES (
    NEW.id || ':previewed', NEW.actor_user_id, 'question_import_previewed',
    'question_import', NEW.id, NEW.certification_id,
    'format=' || NEW.format_version || '; rows=' || NEW.row_count,
    NEW.created_at
  );
END;

CREATE TRIGGER question_import_previews_audit_confirmation
AFTER UPDATE OF state ON question_import_previews
WHEN OLD.state = 'confirming' AND NEW.state = 'confirmed'
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, action, subject_type, subject_id,
    certification_id, reason, occurred_at
  )
  VALUES (
    NEW.id || ':confirmed', NEW.actor_user_id, 'question_import_confirmed',
    'question_import', NEW.id, NEW.certification_id,
    'drafts=' || NEW.row_count, NEW.confirmed_at
  );
END;

CREATE TRIGGER question_import_previews_audit_expiry
AFTER UPDATE OF state ON question_import_previews
WHEN OLD.state = 'previewed' AND NEW.state = 'expired'
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, actor_ref, action, subject_type, subject_id,
    certification_id, reason, occurred_at
  )
  VALUES (
    NEW.id || ':expired', NULL, 'system:question-import-cleanup',
    'question_import_preview_expired', 'question_import', NEW.id, NEW.certification_id,
    'expired validated payload removed', NEW.expired_at
  );
END;

CREATE TRIGGER question_import_previews_immutable_delete
BEFORE DELETE ON question_import_previews
BEGIN
  SELECT RAISE(ABORT, 'question import audit history is permanent');
END;
