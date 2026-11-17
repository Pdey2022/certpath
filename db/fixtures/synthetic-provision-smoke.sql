-- Phase 5C provisioning smoke fixture.
--
-- Synthetic only: every value below is a fixture constant. There is no personal
-- data, no credential, no learner and no exam content in this file. It exists so
-- an operator can prove that a freshly provisioned, freshly migrated database
-- accepts a write before anything real is put in it.
--
-- This is a fixture, not a migration. It is never applied by
-- `wrangler d1 migrations apply`, never applied by CI and never part of
-- `npm run verify`. Only an owner-approved 5C provisioning run applies it, by
-- hand, to the isolated staging database.
--
-- Two deliberate consequences, both required by the schema:
--
--   1. The `exam_versions` and `domains` inserts fire `exam_versions_audit_insert`
--      and `domains_audit_insert` (0003), and the `exam_versions` insert also
--      fires `exam_versions_create_timed_mock_profile` (0006). The three
--      `audit_events` rows and the default `timed_mock_profiles` row are part of
--      the intended result, which is exactly why this fixture is a useful
--      rehearsal subject: it proves the trigger chain runs on the provisioned
--      database.
--
--   2. `certifications`, `exam_versions` and `domains` are immutable roots and
--      `audit_events` is append-only, so this database can never be emptied:
--      DELETE is refused by `certifications_no_delete`, `exam_versions_immutable_delete`,
--      `domains_immutable_delete` and `audit_events_no_delete`, and a partial
--      cleanup would leave a schema that no longer matches its audit trail.
--      Drop the database; never try to empty it.

INSERT INTO users (id, status, created_at, updated_at)
VALUES ('fixture-smoke-user', 'active', 1763424000000, 1763424000000);

INSERT INTO certifications (
  id, slug, display_name, created_by_user_id, created_operation_id, created_at
)
VALUES (
  'fixture-smoke-certification',
  'fixture-smoke-certification',
  'Synthetic Smoke Certification',
  'fixture-smoke-user',
  'fixture-smoke-op-certification',
  1763424000000
);

INSERT INTO exam_versions (
  id, certification_id, version_key, title, syllabus_reference,
  effective_from, effective_until, created_by_user_id, created_operation_id,
  creation_reason, created_at
)
VALUES (
  'fixture-smoke-exam-version',
  'fixture-smoke-certification',
  'fixture-smoke-v1',
  'Synthetic Smoke Exam Version',
  'Synthetic fixture; no syllabus is represented.',
  NULL,
  NULL,
  'fixture-smoke-user',
  'fixture-smoke-op-exam-version',
  'Provisioning smoke fixture',
  1763424000000
);

INSERT INTO domains (
  id, certification_id, exam_version_id, domain_key, title, meaning,
  display_order, created_by_user_id, created_operation_id, creation_reason,
  created_at
)
VALUES (
  'fixture-smoke-domain',
  'fixture-smoke-certification',
  'fixture-smoke-exam-version',
  'fixture-smoke-domain-1',
  'Synthetic Smoke Domain',
  'Synthetic fixture domain; no exam content.',
  0,
  'fixture-smoke-user',
  'fixture-smoke-op-domain',
  'Provisioning smoke fixture',
  1763424000000
);
