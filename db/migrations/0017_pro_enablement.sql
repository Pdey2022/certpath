-- 0017: Pro enablement as a per-certification Global Admin commercial act.
--
-- `certifications` is immutable and aborts every UPDATE, so the commercial
-- question "is Pro sold on this exam?" lives in its own append-only log beside
-- it: current state is the row with the greatest (effective_at, id) per
-- certification, and `enabled = 0` is a real state because Pro can be withdrawn.
--
-- Audit is written by trigger, not by the route, so an act cannot be recorded
-- without its audit row. The boolean lives in the action name; `details_json`
-- stays absent, per the house rule that it carries field names and never values.
--
-- Nothing else changes: no table is rebuilt, no existing trigger is relaxed, and
-- `learner_access_grants` is untouched.
--
-- Rules: docs/decisions/0003-pricing-pro-and-refunds.md and
-- docs/decisions/0004-staff-capabilities-and-learner-data.md.

CREATE TABLE certification_pro_enablement (
  id TEXT PRIMARY KEY NOT NULL,
  certification_id TEXT NOT NULL REFERENCES certifications(id) ON DELETE RESTRICT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  effective_at INTEGER NOT NULL,
  changed_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  UNIQUE (certification_id, effective_at)     -- one act per millisecond per exam
);

CREATE INDEX certification_pro_enablement_current_idx
  ON certification_pro_enablement(certification_id, effective_at DESC, id DESC);

-- Append-only: a commercial act is a fact, never an edit.
CREATE TRIGGER certification_pro_enablement_no_update
BEFORE UPDATE ON certification_pro_enablement
BEGIN
  SELECT RAISE(
    ABORT,
    'pro enablement is append-only; record a new act instead of editing one'
  );
END;

CREATE TRIGGER certification_pro_enablement_no_delete
BEFORE DELETE ON certification_pro_enablement
BEGIN
  SELECT RAISE(ABORT, 'pro enablement records cannot be deleted');
END;

CREATE TRIGGER certification_pro_enablement_audit_insert
AFTER INSERT ON certification_pro_enablement
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, actor_ref, action, subject_type, subject_id,
    certification_id, reason, occurred_at
  ) VALUES (
    NEW.operation_id, NEW.changed_by_user_id, NULL,
    CASE WHEN NEW.enabled = 1
         THEN 'certification_pro_enabled' ELSE 'certification_pro_disabled' END,
    'certification', NEW.certification_id, NEW.certification_id,
    NEW.reason, NEW.effective_at
  );
END;
