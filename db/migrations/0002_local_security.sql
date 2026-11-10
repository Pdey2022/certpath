CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE auth_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (issuer, subject)
);

CREATE INDEX auth_identities_user_id_idx ON auth_identities(user_id);

CREATE TABLE app_sessions (
  token_digest TEXT PRIMARY KEY NOT NULL
    CHECK (length(token_digest) = 64 AND token_digest NOT GLOB '*[^0-9a-f]*'),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  revoked_at INTEGER,
  revocation_operation_id TEXT UNIQUE,
  revoked_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  mfa_method TEXT CHECK (mfa_method IS NULL OR length(mfa_method) BETWEEN 1 AND 32),
  mfa_verified_at INTEGER,
  CHECK ((mfa_method IS NULL) = (mfa_verified_at IS NULL)),
  CHECK (
    (revoked_at IS NULL AND revocation_operation_id IS NULL AND revoked_by_user_id IS NULL)
    OR
    (revoked_at IS NOT NULL AND revocation_operation_id IS NOT NULL AND revoked_by_user_id IS NOT NULL)
  )
);

CREATE INDEX app_sessions_user_expiry_idx ON app_sessions(user_id, expires_at);

CREATE TABLE audit_events (
  operation_id TEXT PRIMARY KEY NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  actor_ref TEXT,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  certification_id TEXT,
  reason TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  CHECK (
    (actor_user_id IS NOT NULL AND actor_ref IS NULL)
    OR
    (actor_user_id IS NULL AND actor_ref IS NOT NULL AND length(actor_ref) BETWEEN 1 AND 128)
  ),
  FOREIGN KEY (certification_id) REFERENCES certifications(id) ON DELETE RESTRICT
);

CREATE INDEX audit_events_subject_idx ON audit_events(subject_type, subject_id, occurred_at);

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TABLE certifications (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_operation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TRIGGER certifications_no_update
BEFORE UPDATE ON certifications
BEGIN
  SELECT RAISE(ABORT, 'certification roots are immutable');
END;

CREATE TRIGGER certifications_no_delete
BEFORE DELETE ON certifications
BEGIN
  SELECT RAISE(ABORT, 'certification roots are immutable');
END;

CREATE TABLE staff_roles (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('global_admin', 'manager')),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  changed_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  changed_by_ref TEXT,
  operation_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  CHECK (
    (changed_by_user_id IS NOT NULL AND changed_by_ref IS NULL)
    OR
    (changed_by_user_id IS NULL AND changed_by_ref IS NOT NULL AND length(changed_by_ref) BETWEEN 1 AND 128)
  )
);

CREATE INDEX staff_roles_role_active_idx ON staff_roles(role, active, user_id);

CREATE TABLE manager_certification_assignments (
  manager_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  certification_id TEXT NOT NULL REFERENCES certifications(id) ON DELETE RESTRICT,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  changed_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  PRIMARY KEY (manager_user_id, certification_id)
);

CREATE INDEX manager_assignments_cert_active_idx
  ON manager_certification_assignments(certification_id, active, manager_user_id);

CREATE TABLE initial_admin_provisioning (
  bootstrap_key TEXT PRIMARY KEY NOT NULL
    CHECK (bootstrap_key = 'initial-global-admin'),
  consumed_at INTEGER,
  operation_id TEXT UNIQUE,
  user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  operator_ref TEXT,
  CHECK (
    (consumed_at IS NULL AND operation_id IS NULL AND user_id IS NULL AND operator_ref IS NULL)
    OR
    (consumed_at IS NOT NULL AND operation_id IS NOT NULL AND user_id IS NOT NULL AND operator_ref IS NOT NULL)
  )
);

INSERT INTO initial_admin_provisioning (bootstrap_key)
VALUES ('initial-global-admin');

CREATE TRIGGER initial_admin_provisioning_no_delete
BEFORE DELETE ON initial_admin_provisioning
BEGIN
  SELECT RAISE(ABORT, 'initial provisioning state is permanent');
END;

CREATE TRIGGER initial_admin_provisioning_consume_once
BEFORE UPDATE ON initial_admin_provisioning
WHEN OLD.consumed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'initial provisioning is already consumed');
END;

CREATE TRIGGER initial_admin_provisioning_consume_from_bootstrap_role
AFTER INSERT ON staff_roles
WHEN NEW.role = 'global_admin'
  AND NEW.active = 1
  AND NEW.changed_by_user_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM initial_admin_provisioning
    WHERE bootstrap_key = 'initial-global-admin'
      AND consumed_at IS NULL
  )
BEGIN
  UPDATE initial_admin_provisioning
  SET consumed_at = NEW.changed_at,
      operation_id = NEW.operation_id,
      user_id = NEW.user_id,
      operator_ref = NEW.changed_by_ref
  WHERE bootstrap_key = 'initial-global-admin'
    AND consumed_at IS NULL;
END;

CREATE TRIGGER staff_roles_audit_insert
AFTER INSERT ON staff_roles
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, actor_ref, action, subject_type,
    subject_id, reason, occurred_at
  )
  VALUES (
    NEW.operation_id, NEW.changed_by_user_id, NEW.changed_by_ref,
    'staff_role_assigned', 'staff_role', NEW.user_id,
    NEW.reason, NEW.changed_at
  );
END;

CREATE TRIGGER staff_roles_audit_update
AFTER UPDATE OF role, active ON staff_roles
WHEN OLD.role IS NOT NEW.role OR OLD.active IS NOT NEW.active
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, actor_ref, action, subject_type,
    subject_id, reason, occurred_at
  )
  VALUES (
    NEW.operation_id, NEW.changed_by_user_id, NEW.changed_by_ref,
    CASE WHEN NEW.active = 1 THEN 'staff_role_assigned' ELSE 'staff_role_revoked' END,
    'staff_role', NEW.user_id, NEW.reason, NEW.changed_at
  );
END;

CREATE TRIGGER staff_roles_no_delete
BEFORE DELETE ON staff_roles
BEGIN
  SELECT RAISE(ABORT, 'staff roles must be revoked, not deleted');
END;

CREATE TRIGGER manager_assignments_audit_insert
AFTER INSERT ON manager_certification_assignments
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, action, subject_type, subject_id,
    certification_id, reason, occurred_at
  )
  VALUES (
    NEW.operation_id, NEW.changed_by_user_id, 'manager_assignment_granted',
    'manager_assignment', NEW.manager_user_id, NEW.certification_id,
    NEW.reason, NEW.changed_at
  );
END;

CREATE TRIGGER manager_assignments_audit_update
AFTER UPDATE OF active ON manager_certification_assignments
WHEN OLD.active IS NOT NEW.active
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, action, subject_type, subject_id,
    certification_id, reason, occurred_at
  )
  VALUES (
    NEW.operation_id, NEW.changed_by_user_id,
    CASE WHEN NEW.active = 1 THEN 'manager_assignment_granted' ELSE 'manager_assignment_revoked' END,
    'manager_assignment', NEW.manager_user_id, NEW.certification_id,
    NEW.reason, NEW.changed_at
  );
END;

CREATE TRIGGER manager_assignments_no_delete
BEFORE DELETE ON manager_certification_assignments
BEGIN
  SELECT RAISE(ABORT, 'manager assignments must be revoked, not deleted');
END;

CREATE TRIGGER certifications_audit_insert
AFTER INSERT ON certifications
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, action, subject_type, subject_id,
    reason, occurred_at
  )
  VALUES (
    NEW.created_operation_id, NEW.created_by_user_id,
    'certification_created', 'certification', NEW.id,
    'Certification root created', NEW.created_at
  );
END;

CREATE TRIGGER app_sessions_audit_revoke
AFTER UPDATE OF revoked_at ON app_sessions
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  INSERT INTO audit_events (
    operation_id, actor_user_id, action, subject_type, subject_id,
    reason, occurred_at
  )
  VALUES (
    NEW.revocation_operation_id, NEW.revoked_by_user_id,
    'application_session_revoked', 'application_session',
    NEW.user_id, 'Application session revoked', NEW.revoked_at
  );
END;
