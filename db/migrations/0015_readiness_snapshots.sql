-- 0015: timestamped readiness snapshots.
--
-- Readiness is a customer-facing promise, so every value a learner is shown has
-- to be reproducible from stored attempts and explainable after the fact. Each
-- snapshot records the formula version, the band and score, and the basis it was
-- derived from.
--
-- Append only: a snapshot is evidence, never a mutable cache.
--
-- Rules: docs/decisions/0005-readiness-and-access-lifecycle.md.

CREATE TABLE readiness_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  certification_id TEXT NOT NULL,
  exam_version_id TEXT NOT NULL,
  formula_version TEXT NOT NULL CHECK (length(trim(formula_version)) BETWEEN 1 AND 40),
  band TEXT NOT NULL CHECK (band IN ('low', 'medium', 'ready')),
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  is_ready INTEGER NOT NULL CHECK (is_ready IN (0, 1)),
  mocks_count INTEGER NOT NULL CHECK (mocks_count BETWEEN 0 AND 3),
  questions_count INTEGER NOT NULL CHECK (questions_count >= 0),
  basis_json TEXT NOT NULL CHECK (json_valid(basis_json)),
  next_action_json TEXT CHECK (
    next_action_json IS NULL OR json_valid(next_action_json)
  ),
  -- The completed mock that triggered this snapshot, when there was one. Unique
  -- so re-observing the same attempt cannot write a second snapshot.
  source_attempt_id TEXT UNIQUE REFERENCES timed_mock_attempts(id) ON DELETE RESTRICT,
  computed_at INTEGER NOT NULL,
  FOREIGN KEY (certification_id, exam_version_id)
    REFERENCES exam_versions(certification_id, id) ON DELETE RESTRICT
);

CREATE INDEX readiness_snapshots_latest_idx
  ON readiness_snapshots(
    user_id, certification_id, exam_version_id, computed_at DESC, id DESC
  );

CREATE TRIGGER readiness_snapshots_append_only_update
BEFORE UPDATE ON readiness_snapshots
BEGIN
  SELECT RAISE(ABORT, 'readiness snapshots are append-only');
END;

CREATE TRIGGER readiness_snapshots_append_only_delete
BEFORE DELETE ON readiness_snapshots
BEGIN
  SELECT RAISE(ABORT, 'readiness snapshots are append-only');
END;
