CREATE TABLE exam_versions (
  id TEXT PRIMARY KEY NOT NULL,
  certification_id TEXT NOT NULL REFERENCES certifications(id) ON DELETE RESTRICT,
  version_key TEXT NOT NULL CHECK (length(version_key) BETWEEN 1 AND 80),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  syllabus_reference TEXT NOT NULL CHECK (length(trim(syllabus_reference)) BETWEEN 1 AND 500),
  effective_from INTEGER,
  effective_until INTEGER,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_operation_id TEXT NOT NULL UNIQUE,
  creation_reason TEXT NOT NULL CHECK (length(trim(creation_reason)) BETWEEN 1 AND 500),
  created_at INTEGER NOT NULL,
  CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until > effective_from),
  UNIQUE (certification_id, version_key),
  UNIQUE (certification_id, id)
);

CREATE INDEX exam_versions_certification_idx
  ON exam_versions(certification_id, created_at, id);

CREATE TABLE domains (
  id TEXT PRIMARY KEY NOT NULL,
  certification_id TEXT NOT NULL,
  exam_version_id TEXT NOT NULL,
  domain_key TEXT NOT NULL CHECK (length(domain_key) BETWEEN 1 AND 80),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  meaning TEXT NOT NULL CHECK (length(trim(meaning)) BETWEEN 1 AND 2000),
  display_order INTEGER NOT NULL CHECK (display_order >= 0),
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_operation_id TEXT NOT NULL UNIQUE,
  creation_reason TEXT NOT NULL CHECK (length(trim(creation_reason)) BETWEEN 1 AND 500),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (certification_id, exam_version_id)
    REFERENCES exam_versions(certification_id, id) ON DELETE RESTRICT,
  UNIQUE (exam_version_id, domain_key),
  UNIQUE (certification_id, exam_version_id, id)
);

CREATE INDEX domains_version_order_idx
  ON domains(certification_id, exam_version_id, display_order, id);

CREATE TABLE topics (
  id TEXT PRIMARY KEY NOT NULL,
  certification_id TEXT NOT NULL,
  exam_version_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  topic_key TEXT NOT NULL CHECK (length(topic_key) BETWEEN 1 AND 80),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  meaning TEXT NOT NULL CHECK (length(trim(meaning)) BETWEEN 1 AND 2000),
  display_order INTEGER NOT NULL CHECK (display_order >= 0),
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_operation_id TEXT NOT NULL UNIQUE,
  creation_reason TEXT NOT NULL CHECK (length(trim(creation_reason)) BETWEEN 1 AND 500),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (certification_id, exam_version_id, domain_id)
    REFERENCES domains(certification_id, exam_version_id, id) ON DELETE RESTRICT,
  UNIQUE (domain_id, topic_key),
  UNIQUE (certification_id, exam_version_id, domain_id, id)
);

CREATE INDEX topics_domain_order_idx
  ON topics(certification_id, exam_version_id, domain_id, display_order, id);

CREATE TABLE questions (
  id TEXT PRIMARY KEY NOT NULL,
  certification_id TEXT NOT NULL REFERENCES certifications(id) ON DELETE RESTRICT,
  question_key TEXT NOT NULL CHECK (length(trim(question_key)) BETWEEN 1 AND 120),
  lock_version INTEGER NOT NULL DEFAULT 0 CHECK (lock_version >= 0),
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_operation_id TEXT NOT NULL UNIQUE,
  creation_reason TEXT NOT NULL CHECK (length(trim(creation_reason)) BETWEEN 1 AND 500),
  created_at INTEGER NOT NULL,
  UNIQUE (certification_id, id),
  UNIQUE (certification_id, question_key)
);

CREATE INDEX questions_certification_idx
  ON questions(certification_id, created_at, id);

CREATE TABLE question_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  certification_id TEXT NOT NULL,
  exam_version_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  base_lock_version INTEGER NOT NULL CHECK (base_lock_version >= 0),
  domain_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type = 'single_choice'),
  stem TEXT NOT NULL CHECK (length(trim(stem)) BETWEEN 5 AND 4000),
  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  source_reference TEXT NOT NULL CHECK (length(trim(source_reference)) BETWEEN 1 AND 1000),
  license_reference TEXT NOT NULL CHECK (length(trim(license_reference)) BETWEEN 1 AND 200),
  authored_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_operation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  CHECK (revision_number = base_lock_version + 1),
  FOREIGN KEY (certification_id, question_id)
    REFERENCES questions(certification_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (certification_id, exam_version_id)
    REFERENCES exam_versions(certification_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (certification_id, exam_version_id, domain_id)
    REFERENCES domains(certification_id, exam_version_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (certification_id, exam_version_id, domain_id, topic_id)
    REFERENCES topics(certification_id, exam_version_id, domain_id, id) ON DELETE RESTRICT,
  UNIQUE (question_id, revision_number),
  UNIQUE (certification_id, id),
  UNIQUE (certification_id, exam_version_id, question_id, id),
  UNIQUE (certification_id, question_id, id)
);

CREATE INDEX question_revisions_question_idx
  ON question_revisions(certification_id, question_id, revision_number DESC);

CREATE INDEX question_revisions_scope_idx
  ON question_revisions(certification_id, exam_version_id, domain_id, topic_id);

CREATE TABLE answer_options (
  id TEXT PRIMARY KEY NOT NULL,
  certification_id TEXT NOT NULL,
  question_revision_id TEXT NOT NULL,
  option_key TEXT NOT NULL CHECK (length(option_key) BETWEEN 1 AND 32),
  option_order INTEGER NOT NULL CHECK (option_order BETWEEN 1 AND 8),
  option_text TEXT NOT NULL CHECK (length(trim(option_text)) BETWEEN 1 AND 1000),
  is_correct INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
  explanation TEXT NOT NULL CHECK (length(trim(explanation)) BETWEEN 1 AND 3000),
  FOREIGN KEY (certification_id, question_revision_id)
    REFERENCES question_revisions(certification_id, id) ON DELETE RESTRICT,
  UNIQUE (question_revision_id, option_key),
  UNIQUE (question_revision_id, option_order)
);

CREATE INDEX answer_options_revision_order_idx
  ON answer_options(certification_id, question_revision_id, option_order);

CREATE TABLE question_revision_events (
  id TEXT PRIMARY KEY NOT NULL,
  certification_id TEXT NOT NULL,
  question_revision_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('draft', 'submitted', 'approved', 'rejected', 'published', 'superseded', 'retired')
  ),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  occurred_at INTEGER NOT NULL,
  FOREIGN KEY (certification_id, question_revision_id)
    REFERENCES question_revisions(certification_id, id) ON DELETE RESTRICT,
  UNIQUE (question_revision_id, sequence_number)
);

CREATE INDEX question_revision_events_latest_idx
  ON question_revision_events(question_revision_id, sequence_number DESC);

CREATE TABLE content_reviews (
  id TEXT PRIMARY KEY NOT NULL,
  certification_id TEXT NOT NULL,
  question_revision_id TEXT NOT NULL,
  reviewer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  notes TEXT NOT NULL CHECK (length(trim(notes)) BETWEEN 1 AND 3000),
  operation_id TEXT NOT NULL UNIQUE,
  reviewed_at INTEGER NOT NULL,
  FOREIGN KEY (certification_id, question_revision_id)
    REFERENCES question_revisions(certification_id, id) ON DELETE RESTRICT
);

CREATE INDEX content_reviews_revision_idx
  ON content_reviews(certification_id, question_revision_id, reviewed_at, id);

CREATE TABLE exam_version_questions (
  certification_id TEXT NOT NULL,
  exam_version_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  question_revision_id TEXT NOT NULL,
  publication_state TEXT NOT NULL CHECK (publication_state IN ('published', 'retired')),
  lock_version INTEGER NOT NULL CHECK (lock_version > 0),
  changed_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  changed_operation_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  changed_at INTEGER NOT NULL,
  PRIMARY KEY (exam_version_id, question_id),
  FOREIGN KEY (certification_id, exam_version_id)
    REFERENCES exam_versions(certification_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (certification_id, question_id)
    REFERENCES questions(certification_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (certification_id, exam_version_id, question_id, question_revision_id)
    REFERENCES question_revisions(certification_id, exam_version_id, question_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX exam_version_questions_selection_idx
  ON exam_version_questions(certification_id, exam_version_id, publication_state, question_id);

CREATE TABLE content_publication_events (
  operation_id TEXT PRIMARY KEY NOT NULL,
  certification_id TEXT NOT NULL,
  exam_version_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  question_revision_id TEXT NOT NULL,
  previous_revision_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('published', 'retired')),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  occurred_at INTEGER NOT NULL,
  FOREIGN KEY (certification_id, exam_version_id, question_id, question_revision_id)
    REFERENCES question_revisions(certification_id, exam_version_id, question_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (certification_id, exam_version_id, question_id, previous_revision_id)
    REFERENCES question_revisions(certification_id, exam_version_id, question_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX content_publication_history_idx
  ON content_publication_events(certification_id, exam_version_id, question_id, occurred_at);

CREATE TABLE question_derivations (
  id TEXT PRIMARY KEY NOT NULL,
  source_certification_id TEXT NOT NULL,
  source_question_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  destination_certification_id TEXT NOT NULL,
  destination_question_id TEXT NOT NULL,
  destination_revision_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  created_at INTEGER NOT NULL,
  CHECK (source_certification_id <> destination_certification_id),
  FOREIGN KEY (source_certification_id, source_question_id)
    REFERENCES questions(certification_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (source_certification_id, source_question_id, source_revision_id)
    REFERENCES question_revisions(certification_id, question_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (destination_certification_id, destination_question_id)
    REFERENCES questions(certification_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (destination_certification_id, destination_question_id, destination_revision_id)
    REFERENCES question_revisions(certification_id, question_id, id) ON DELETE RESTRICT,
  UNIQUE (destination_question_id, destination_revision_id)
);

CREATE INDEX question_derivations_source_idx
  ON question_derivations(source_certification_id, source_question_id, source_revision_id);

CREATE TRIGGER exam_versions_immutable_update
BEFORE UPDATE ON exam_versions
BEGIN
  SELECT RAISE(ABORT, 'exam versions are immutable');
END;

CREATE TRIGGER exam_versions_immutable_delete
BEFORE DELETE ON exam_versions
BEGIN
  SELECT RAISE(ABORT, 'exam versions are immutable');
END;

CREATE TRIGGER domains_immutable_update
BEFORE UPDATE ON domains
BEGIN
  SELECT RAISE(ABORT, 'domain identity and meaning are immutable');
END;

CREATE TRIGGER domains_immutable_delete
BEFORE DELETE ON domains
BEGIN
  SELECT RAISE(ABORT, 'domain history is immutable');
END;

CREATE TRIGGER topics_immutable_update
BEFORE UPDATE ON topics
BEGIN
  SELECT RAISE(ABORT, 'topic identity and meaning are immutable');
END;

CREATE TRIGGER topics_immutable_delete
BEFORE DELETE ON topics
BEGIN
  SELECT RAISE(ABORT, 'topic history is immutable');
END;

CREATE TRIGGER questions_immutable_update
BEFORE UPDATE ON questions
WHEN NEW.id IS NOT OLD.id
  OR NEW.certification_id IS NOT OLD.certification_id
  OR NEW.question_key IS NOT OLD.question_key
  OR NEW.created_by_user_id IS NOT OLD.created_by_user_id
  OR NEW.created_operation_id IS NOT OLD.created_operation_id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.lock_version <> OLD.lock_version + 1
  OR NOT EXISTS (
    SELECT 1
    FROM question_revisions AS revision
    WHERE revision.question_id = OLD.id
      AND revision.revision_number = NEW.lock_version
      AND revision.base_lock_version = OLD.lock_version
  )
BEGIN
  SELECT RAISE(ABORT, 'question identity is immutable; revisions advance its lock');
END;

CREATE TRIGGER questions_immutable_delete
BEFORE DELETE ON questions
BEGIN
  SELECT RAISE(ABORT, 'question history is immutable');
END;

CREATE TRIGGER question_revisions_validate_lock
BEFORE INSERT ON question_revisions
WHEN NOT EXISTS (
  SELECT 1
  FROM questions
  WHERE id = NEW.question_id
    AND certification_id = NEW.certification_id
    AND lock_version = NEW.base_lock_version
)
BEGIN
  SELECT RAISE(ABORT, 'stale question revision');
END;

CREATE TRIGGER question_revisions_advance_lock
AFTER INSERT ON question_revisions
BEGIN
  UPDATE questions
  SET lock_version = NEW.revision_number
  WHERE id = NEW.question_id
    AND lock_version = NEW.base_lock_version;
  SELECT RAISE(ABORT, 'question revision lock conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM questions
    WHERE id = NEW.question_id AND lock_version = NEW.revision_number
  );
  INSERT INTO question_revision_events (
    id, certification_id, question_revision_id, sequence_number,
    event_type, actor_user_id, operation_id, reason, occurred_at
  )
  VALUES (
    lower(hex(randomblob(16))), NEW.certification_id, NEW.id, 1,
    'draft', NEW.authored_by_user_id, NEW.created_operation_id || ':draft',
    'Draft revision created', NEW.created_at
  );
END;

CREATE TRIGGER question_revisions_immutable_update
BEFORE UPDATE ON question_revisions
BEGIN
  SELECT RAISE(ABORT, 'question revisions are immutable');
END;

CREATE TRIGGER question_revisions_immutable_delete
BEFORE DELETE ON question_revisions
BEGIN
  SELECT RAISE(ABORT, 'question revision history is immutable');
END;

CREATE TRIGGER answer_options_immutable_update
BEFORE UPDATE ON answer_options
BEGIN
  SELECT RAISE(ABORT, 'answer options are immutable');
END;

CREATE TRIGGER answer_options_immutable_delete
BEFORE DELETE ON answer_options
BEGIN
  SELECT RAISE(ABORT, 'answer option history is immutable');
END;

CREATE TRIGGER question_revision_events_validate_transition
BEFORE INSERT ON question_revision_events
BEGIN
  SELECT RAISE(ABORT, 'invalid question revision workflow transition')
  WHERE NEW.sequence_number <> COALESCE((
    SELECT MAX(sequence_number) + 1
    FROM question_revision_events
    WHERE question_revision_id = NEW.question_revision_id
  ), 1)
  OR (
    NEW.event_type = 'draft'
    AND EXISTS (
      SELECT 1 FROM question_revision_events
      WHERE question_revision_id = NEW.question_revision_id
    )
  )
  OR (
    NEW.event_type = 'submitted'
    AND COALESCE((
      SELECT event_type FROM question_revision_events
      WHERE question_revision_id = NEW.question_revision_id
      ORDER BY sequence_number DESC LIMIT 1
    ), '') NOT IN ('draft', 'rejected')
  )
  OR (
    NEW.event_type IN ('approved', 'rejected')
    AND COALESCE((
      SELECT event_type FROM question_revision_events
      WHERE question_revision_id = NEW.question_revision_id
      ORDER BY sequence_number DESC LIMIT 1
    ), '') <> 'submitted'
  )
  OR (
    NEW.event_type = 'published'
    AND COALESCE((
      SELECT event_type FROM question_revision_events
      WHERE question_revision_id = NEW.question_revision_id
      ORDER BY sequence_number DESC LIMIT 1
    ), '') <> 'approved'
  )
  OR (
    NEW.event_type = 'superseded'
    AND COALESCE((
      SELECT event_type FROM question_revision_events
      WHERE question_revision_id = NEW.question_revision_id
      ORDER BY sequence_number DESC LIMIT 1
    ), '') <> 'published'
  )
  OR (
    NEW.event_type = 'retired'
    AND COALESCE((
      SELECT event_type FROM question_revision_events
      WHERE question_revision_id = NEW.question_revision_id
      ORDER BY sequence_number DESC LIMIT 1
    ), '') <> 'published'
  );

  SELECT RAISE(ABORT, 'question content is incomplete')
  WHERE NEW.event_type = 'submitted'
    AND (
      (SELECT COUNT(*) FROM answer_options
       WHERE question_revision_id = NEW.question_revision_id) NOT BETWEEN 2 AND 8
      OR (SELECT COUNT(*) FROM answer_options
          WHERE question_revision_id = NEW.question_revision_id AND is_correct = 1) <> 1
      OR EXISTS (
        SELECT 1 FROM answer_options
        WHERE question_revision_id = NEW.question_revision_id
          AND (length(trim(option_text)) = 0 OR length(trim(explanation)) = 0)
      )
      OR EXISTS (
        SELECT 1 FROM answer_options
        WHERE question_revision_id = NEW.question_revision_id
        GROUP BY question_revision_id
        HAVING MIN(option_order) <> 1
          OR MAX(option_order) <> COUNT(*)
      )
      OR NOT EXISTS (
        SELECT 1 FROM question_revisions
        WHERE id = NEW.question_revision_id
          AND length(trim(stem)) >= 5
          AND length(trim(source_reference)) > 0
          AND length(trim(license_reference)) > 0
      )
    );
END;

CREATE TRIGGER question_revision_events_audit_insert
AFTER INSERT ON question_revision_events
WHEN NEW.event_type IN ('draft', 'submitted', 'approved', 'rejected')
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, action, subject_type, subject_id,
    certification_id, reason, occurred_at
  )
  VALUES (
    NEW.operation_id, NEW.actor_user_id,
    'question_revision_' || NEW.event_type, 'question_revision',
    NEW.question_revision_id, NEW.certification_id, NEW.reason, NEW.occurred_at
  );
END;

CREATE TRIGGER question_revision_events_immutable_update
BEFORE UPDATE ON question_revision_events
BEGIN
  SELECT RAISE(ABORT, 'question revision events are append-only');
END;

CREATE TRIGGER question_revision_events_immutable_delete
BEFORE DELETE ON question_revision_events
BEGIN
  SELECT RAISE(ABORT, 'question revision events are append-only');
END;

CREATE TRIGGER content_reviews_validate_insert
BEFORE INSERT ON content_reviews
WHEN COALESCE((
  SELECT event_type FROM question_revision_events
  WHERE question_revision_id = NEW.question_revision_id
  ORDER BY sequence_number DESC LIMIT 1
), '') <> 'submitted'
BEGIN
  SELECT RAISE(ABORT, 'only a submitted revision can be reviewed');
END;

CREATE TRIGGER content_reviews_append_decision
AFTER INSERT ON content_reviews
BEGIN
  INSERT INTO question_revision_events (
    id, certification_id, question_revision_id, sequence_number,
    event_type, actor_user_id, operation_id, reason, occurred_at
  )
  SELECT lower(hex(randomblob(16))), NEW.certification_id, NEW.question_revision_id,
         COALESCE(MAX(sequence_number), 0) + 1, NEW.decision, NEW.reviewer_user_id,
         NEW.operation_id || ':decision', NEW.notes, NEW.reviewed_at
  FROM question_revision_events
  WHERE question_revision_id = NEW.question_revision_id;
END;

CREATE TRIGGER content_reviews_immutable_update
BEFORE UPDATE ON content_reviews
BEGIN
  SELECT RAISE(ABORT, 'content reviews are append-only');
END;

CREATE TRIGGER content_reviews_immutable_delete
BEFORE DELETE ON content_reviews
BEGIN
  SELECT RAISE(ABORT, 'content reviews are append-only');
END;

CREATE TRIGGER exam_version_questions_validate_insert
BEFORE INSERT ON exam_version_questions
WHEN NEW.publication_state <> 'published'
  OR COALESCE((
    SELECT event_type FROM question_revision_events
    WHERE question_revision_id = NEW.question_revision_id
    ORDER BY sequence_number DESC LIMIT 1
  ), '') <> 'approved'
BEGIN
  SELECT RAISE(ABORT, 'only the exact approved revision can be published');
END;

CREATE TRIGGER exam_version_questions_validate_update
BEFORE UPDATE ON exam_version_questions
WHEN NEW.certification_id IS NOT OLD.certification_id
  OR NEW.exam_version_id IS NOT OLD.exam_version_id
  OR NEW.question_id IS NOT OLD.question_id
  OR NEW.lock_version <> OLD.lock_version + 1
  OR (
    NEW.publication_state = 'published'
    AND COALESCE((
      SELECT event_type FROM question_revision_events
      WHERE question_revision_id = NEW.question_revision_id
      ORDER BY sequence_number DESC LIMIT 1
    ), '') <> 'approved'
  )
  OR (
    NEW.publication_state = 'retired'
    AND (
      OLD.publication_state <> 'published'
      OR NEW.question_revision_id IS NOT OLD.question_revision_id
    )
  )
  OR NEW.publication_state NOT IN ('published', 'retired')
BEGIN
  SELECT RAISE(ABORT, 'invalid publication pointer transition');
END;

CREATE TRIGGER exam_version_questions_record_insert
AFTER INSERT ON exam_version_questions
BEGIN
  INSERT INTO content_publication_events (
    operation_id, certification_id, exam_version_id, question_id,
    question_revision_id, previous_revision_id, action, actor_user_id,
    reason, occurred_at
  )
  VALUES (
    NEW.changed_operation_id, NEW.certification_id, NEW.exam_version_id,
    NEW.question_id, NEW.question_revision_id, NULL, 'published',
    NEW.changed_by_user_id, NEW.reason, NEW.changed_at
  );

  INSERT INTO question_revision_events (
    id, certification_id, question_revision_id, sequence_number,
    event_type, actor_user_id, operation_id, reason, occurred_at
  )
  SELECT lower(hex(randomblob(16))), NEW.certification_id, NEW.question_revision_id,
         COALESCE(MAX(sequence_number), 0) + 1, 'published', NEW.changed_by_user_id,
         NEW.changed_operation_id || ':published', NEW.reason, NEW.changed_at
  FROM question_revision_events
  WHERE question_revision_id = NEW.question_revision_id;
END;

CREATE TRIGGER exam_version_questions_record_update
AFTER UPDATE ON exam_version_questions
BEGIN
  INSERT INTO content_publication_events (
    operation_id, certification_id, exam_version_id, question_id,
    question_revision_id, previous_revision_id, action, actor_user_id,
    reason, occurred_at
  )
  VALUES (
    NEW.changed_operation_id, NEW.certification_id, NEW.exam_version_id,
    NEW.question_id, NEW.question_revision_id,
    CASE WHEN NEW.publication_state = 'retired' THEN OLD.question_revision_id
         ELSE OLD.question_revision_id END,
    CASE WHEN NEW.publication_state = 'retired' THEN 'retired' ELSE 'published' END,
    NEW.changed_by_user_id, NEW.reason, NEW.changed_at
  );

  INSERT INTO question_revision_events (
    id, certification_id, question_revision_id, sequence_number,
    event_type, actor_user_id, operation_id, reason, occurred_at
  )
  SELECT lower(hex(randomblob(16))), OLD.certification_id, OLD.question_revision_id,
         (SELECT COALESCE(MAX(sequence_number), 0) + 1 FROM question_revision_events
          WHERE question_revision_id = OLD.question_revision_id),
         'superseded', NEW.changed_by_user_id,
         NEW.changed_operation_id || ':superseded', NEW.reason, NEW.changed_at
  WHERE OLD.publication_state = 'published'
    AND NEW.publication_state = 'published'
    AND OLD.question_revision_id <> NEW.question_revision_id;

  INSERT INTO question_revision_events (
    id, certification_id, question_revision_id, sequence_number,
    event_type, actor_user_id, operation_id, reason, occurred_at
  )
  SELECT lower(hex(randomblob(16))), NEW.certification_id, NEW.question_revision_id,
         (SELECT COALESCE(MAX(sequence_number), 0) + 1 FROM question_revision_events
          WHERE question_revision_id = NEW.question_revision_id),
         'published', NEW.changed_by_user_id,
         NEW.changed_operation_id || ':published', NEW.reason, NEW.changed_at
  WHERE NEW.publication_state = 'published'
    AND OLD.question_revision_id <> NEW.question_revision_id;

  INSERT INTO question_revision_events (
    id, certification_id, question_revision_id, sequence_number,
    event_type, actor_user_id, operation_id, reason, occurred_at
  )
  SELECT lower(hex(randomblob(16))), NEW.certification_id, NEW.question_revision_id,
         (SELECT COALESCE(MAX(sequence_number), 0) + 1 FROM question_revision_events
          WHERE question_revision_id = NEW.question_revision_id),
         'retired', NEW.changed_by_user_id,
         NEW.changed_operation_id || ':retired', NEW.reason, NEW.changed_at
  WHERE NEW.publication_state = 'retired'
    AND OLD.publication_state = 'published';
END;

CREATE TRIGGER exam_version_questions_no_delete
BEFORE DELETE ON exam_version_questions
BEGIN
  SELECT RAISE(ABORT, 'publication history must be retired, not deleted');
END;

CREATE TRIGGER content_publication_events_audit_insert
AFTER INSERT ON content_publication_events
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, action, subject_type, subject_id,
    certification_id, reason, occurred_at
  )
  VALUES (
    NEW.operation_id, NEW.actor_user_id,
    'content_' || NEW.action, 'question_revision',
    NEW.question_revision_id, NEW.certification_id, NEW.reason, NEW.occurred_at
  );
END;

CREATE TRIGGER content_publication_events_immutable_update
BEFORE UPDATE ON content_publication_events
BEGIN
  SELECT RAISE(ABORT, 'publication history is append-only');
END;

CREATE TRIGGER content_publication_events_immutable_delete
BEFORE DELETE ON content_publication_events
BEGIN
  SELECT RAISE(ABORT, 'publication history is append-only');
END;

CREATE TRIGGER question_derivations_audit_insert
AFTER INSERT ON question_derivations
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, action, subject_type, subject_id,
    certification_id, reason, occurred_at
  )
  VALUES (
    NEW.operation_id, NEW.actor_user_id, 'question_copied',
    'question', NEW.destination_question_id,
    NEW.destination_certification_id, NEW.reason, NEW.created_at
  );
END;

CREATE TRIGGER question_derivations_immutable_update
BEFORE UPDATE ON question_derivations
BEGIN
  SELECT RAISE(ABORT, 'question derivation provenance is immutable');
END;

CREATE TRIGGER question_derivations_immutable_delete
BEFORE DELETE ON question_derivations
BEGIN
  SELECT RAISE(ABORT, 'question derivation provenance is immutable');
END;

CREATE TRIGGER exam_versions_audit_insert
AFTER INSERT ON exam_versions
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, action, subject_type, subject_id,
    certification_id, reason, occurred_at
  )
  VALUES (
    NEW.created_operation_id, NEW.created_by_user_id, 'exam_version_created',
    'exam_version', NEW.id, NEW.certification_id,
    NEW.creation_reason, NEW.created_at
  );
END;

CREATE TRIGGER domains_audit_insert
AFTER INSERT ON domains
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, action, subject_type, subject_id,
    certification_id, reason, occurred_at
  )
  VALUES (
    NEW.created_operation_id, NEW.created_by_user_id, 'domain_created',
    'domain', NEW.id, NEW.certification_id,
    NEW.creation_reason, NEW.created_at
  );
END;

CREATE TRIGGER topics_audit_insert
AFTER INSERT ON topics
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, action, subject_type, subject_id,
    certification_id, reason, occurred_at
  )
  VALUES (
    NEW.created_operation_id, NEW.created_by_user_id, 'topic_created',
    'topic', NEW.id, NEW.certification_id,
    NEW.creation_reason, NEW.created_at
  );
END;

CREATE TRIGGER questions_audit_insert
AFTER INSERT ON questions
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, action, subject_type, subject_id,
    certification_id, reason, occurred_at
  )
  VALUES (
    NEW.created_operation_id, NEW.created_by_user_id, 'question_created',
    'question', NEW.id, NEW.certification_id,
    NEW.creation_reason, NEW.created_at
  );
END;

CREATE VIEW published_question_revisions AS
SELECT pointer.certification_id, pointer.exam_version_id, pointer.question_id,
       pointer.question_revision_id, pointer.lock_version
FROM exam_version_questions AS pointer
WHERE pointer.publication_state = 'published';
