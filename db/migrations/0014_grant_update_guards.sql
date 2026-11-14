-- 0014: guard learner_access_grants against edits that break its invariants.
--
-- ADR 0003: a grant is never edited in place - revoke it, then grant again.
-- 0013 only enforced that when a row is inserted, so an UPDATE could still
-- shorten a window, un-revoke a refunded grant, or revoke the Standard grant
-- that was the sole cover for an active Pro grant, leaving Pro outliving
-- Standard. These triggers close those paths.
--
-- Rules: docs/decisions/0003-pricing-pro-and-refunds.md.

CREATE TRIGGER learner_access_grants_immutable_update
BEFORE UPDATE ON learner_access_grants
WHEN NEW.id <> OLD.id
  OR NEW.user_id <> OLD.user_id
  OR NEW.certification_id <> OLD.certification_id
  OR NEW.feature <> OLD.feature
  OR NEW.starts_at <> OLD.starts_at
  OR NEW.expires_at <> OLD.expires_at
  OR NEW.created_at <> OLD.created_at
  OR NEW.sku IS NOT OLD.sku
  OR NEW.source IS NOT OLD.source
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.created_by_user_id IS NOT OLD.created_by_user_id
  -- A revocation is final: an already revoked grant cannot change again.
  OR OLD.revoked_at IS NOT NULL
BEGIN
  SELECT RAISE(
    ABORT,
    'access grants are immutable; revoke the grant and issue a new one'
  );
END;

CREATE TRIGGER learner_access_grants_revoke_keeps_pro_covered
BEFORE UPDATE OF revoked_at ON learner_access_grants
WHEN OLD.revoked_at IS NULL
  AND NEW.revoked_at IS NOT NULL
  AND OLD.feature = 'standard'
BEGIN
  -- Fail closed: revoking a Standard grant may not leave any live Pro grant
  -- without another Standard grant covering its whole window. Revoke the Pro
  -- grant first when that is the intent.
  SELECT RAISE(
    ABORT,
    'revoking this standard grant would leave a pro grant uncovered'
  )
  WHERE EXISTS (
    SELECT 1
    FROM learner_access_grants AS pro
    WHERE pro.user_id = OLD.user_id
      AND pro.certification_id = OLD.certification_id
      AND pro.feature = 'pro'
      AND pro.revoked_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM learner_access_grants AS cover
        WHERE cover.user_id = pro.user_id
          AND cover.certification_id = pro.certification_id
          AND cover.feature = 'standard'
          AND cover.id <> OLD.id
          AND cover.revoked_at IS NULL
          AND cover.starts_at <= pro.starts_at
          AND cover.expires_at >= pro.expires_at
      )
  );
END;

CREATE TRIGGER learner_access_grants_immutable_delete
BEFORE DELETE ON learner_access_grants
BEGIN
  SELECT RAISE(ABORT, 'access grants cannot be deleted; revoke instead');
END;
