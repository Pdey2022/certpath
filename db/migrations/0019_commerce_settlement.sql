-- 0019: settlement - receipts, the one-Pro-window guard, and three storage rules
-- that settlement depends on.
--
-- What this migration adds:
--
--   1. `commerce_receipts` - the stored purchase record. Only `kind='purchase'`
--      is ever written in this change: the `'refund'` value stays in the CHECK
--      so 0020 can write it without a rebuild, but no refund table, no refund
--      line table and no `paid -> refunded` edge exist yet. A refund receipt
--      without a refund record would be exactly the state the design forbids,
--      so the enum value is kept and not used.
--   2. `learner_access_grants_one_pro_window` - one live Pro window per
--      (account, exam). Overlap-based rather than "live now": a trigger cannot
--      read a clock, so the predicate is the same one 0013 uses for coverage -
--      two half-open windows overlap when each starts before the other ends.
--   3. `commerce_checkouts_immutable` replaced (not a second trigger) so that
--      `paid_at` and `provider_session_id` become write-once. `paid_at` anchors
--      the seven-day refund window a later change computes, and a session id
--      that could be rebound would let a provider event be pointed at a
--      different checkout.
--   4. `commerce_checkouts_one_open_per_fingerprint` - one pending checkout per
--      (learner, certification, SKU). `request_fingerprint` is
--      `sha256(certificationId + "\n" + sku)`, so the index is keyed on exactly
--      that triple. Two browser tabs with two client keys can no longer open two
--      provider sessions for the same product, which with settlement live would
--      mean two charges and two grants. The expiry job frees the slot by moving
--      the row to `expired`, which is not `pending`.
--   5. `commerce_checkouts_status_transition` replaced (not a second trigger) so
--      that `expired -> needs_support` is a legal edge. Settlement parks money it
--      cannot apply in `needs_support`, and a row our own expiry already closed is
--      one of the shapes it can meet: a late payment whose amount does not match,
--      or one whose Pro insert aborts at the trigger below. Without the edge the
--      park itself aborted, the event row was never written with the transition,
--      and the provider retried a real charge forever.
--
-- What this migration deliberately does NOT add: `commerce_refunds`,
-- `commerce_refund_lines`, the `paid -> refunded` status edge,
-- `commerce_checkouts_refunded_requires_settled_refund` and any refund receipt.
-- Those are the next change; nothing here may be read as a promise that they
-- exist.
--
-- Rules: docs/decisions/0003-pricing-pro-and-refunds.md and docs/commerce.md.

-- ---------------------------------------------------------------------------
-- 1. Receipts
-- ---------------------------------------------------------------------------
--
-- A receipt is a witness of a settlement, not a message: it is stored and never
-- sent (`delivery` has one legal value), it carries no tax statement, and it
-- carries no card data because no column exists for any. `lines_json` and
-- `grants_json` are JSON because they are snapshots of what was bought and what
-- was granted - the amounts and windows the checkout recorded, not the current
-- price list.
CREATE TABLE commerce_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  -- Derived inside the insert from the id and `issued_at`: 'CP' + the issue date
  -- + the first twelve hex characters of the id. Never a counter, so two
  -- settlements cannot produce the same number by both reading a sequence.
  receipt_number TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('purchase', 'refund')),
  checkout_id TEXT NOT NULL REFERENCES commerce_checkouts(id) ON DELETE RESTRICT,
  -- No foreign key: `commerce_refunds` does not exist in this change. NULL for
  -- every purchase receipt, and the CHECK below ties it to `kind`, so a refund
  -- receipt cannot exist before the table it must reference does.
  refund_id TEXT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  certification_id TEXT NOT NULL REFERENCES certifications(id) ON DELETE RESTRICT,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  total_minor INTEGER NOT NULL CHECK (total_minor > 0),
  lines_json TEXT NOT NULL CHECK (json_valid(lines_json)),
  grants_json TEXT NOT NULL CHECK (json_valid(grants_json)),
  provider TEXT NOT NULL,
  -- An opaque provider reference. Never a card reference.
  provider_ref TEXT,
  delivery TEXT NOT NULL CHECK (delivery = 'stored'),
  refund_window_ends_at INTEGER,
  issued_at INTEGER NOT NULL,
  -- One purchase receipt and one refund receipt per checkout: this is the
  -- receipt insert's idempotency witness, alongside the caller's NOT EXISTS.
  UNIQUE (checkout_id, kind),
  CHECK ((kind = 'refund') = (refund_id IS NOT NULL)),
  CHECK ((kind = 'purchase') = (refund_window_ends_at IS NOT NULL))
);

CREATE INDEX commerce_receipts_user_idx
  ON commerce_receipts(user_id, issued_at DESC, id DESC);

CREATE TRIGGER commerce_receipts_no_update
BEFORE UPDATE ON commerce_receipts
BEGIN
  SELECT RAISE(ABORT, 'receipts are append-only');
END;

CREATE TRIGGER commerce_receipts_no_delete
BEFORE DELETE ON commerce_receipts
BEGIN
  SELECT RAISE(ABORT, 'receipts cannot be deleted');
END;

-- ---------------------------------------------------------------------------
-- 2. One Pro window per (account, exam)
-- ---------------------------------------------------------------------------
--
-- ADR 0003 rule 3: Pro is sold again only when the previous Pro window has
-- ended. Enforced here rather than only in `canPurchasePro`, because a purchase
-- rule that the storage does not share is two definitions of one guarantee.
--
-- Overlap, not "live now": a trigger cannot read a clock, so the predicate is
-- the same instant comparison 0013 uses for coverage. Two half-open windows
-- `[a, b)` and `[c, d)` overlap iff `a < d AND c < b`; that is the predicate
-- below with `NEW` as one side. A revoked window is not a window: after a refund
-- the learner may buy Pro again.
--
-- This strengthens 0013/0014 and relaxes nothing: `pro_requires_standard` still
-- requires a covering Standard grant, `immutable_update` still forbids editing a
-- window, and `immutable_delete` still forbids removal.
CREATE TRIGGER learner_access_grants_one_pro_window
BEFORE INSERT ON learner_access_grants
WHEN NEW.feature = 'pro'
BEGIN
  SELECT RAISE(ABORT, 'a pro window already overlaps for this certification')
  WHERE EXISTS (
    SELECT 1
    FROM learner_access_grants AS pro
    WHERE pro.user_id = NEW.user_id
      AND pro.certification_id = NEW.certification_id
      AND pro.feature = 'pro'
      AND pro.revoked_at IS NULL
      AND pro.starts_at < NEW.expires_at
      AND pro.expires_at > NEW.starts_at
  );
END;

-- ---------------------------------------------------------------------------
-- 3. `paid_at` and `provider_session_id` are write-once
-- ---------------------------------------------------------------------------
--
-- 0018's trigger is **replaced**, not supplemented: two BEFORE UPDATE triggers
-- on one table would be two places to read, and the second could be dropped
-- without anyone noticing the first still fired.
--
-- The two new clauses are one-way only - they refuse a change once a value
-- exists, never the first write. Settlement writes `paid_at` exactly once
-- (NULL -> the instant we learned the money moved) and checkout creation binds
-- the provider session exactly once (NULL -> the session), so both directions
-- the code needs are still open, and the directions it must never take are
-- closed.
DROP TRIGGER commerce_checkouts_immutable;

CREATE TRIGGER commerce_checkouts_immutable
BEFORE UPDATE ON commerce_checkouts
WHEN NEW.user_id IS NOT OLD.user_id
  OR NEW.certification_id IS NOT OLD.certification_id
  OR NEW.sku IS NOT OLD.sku
  OR NEW.client_checkout_key IS NOT OLD.client_checkout_key
  OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NEW.currency IS NOT OLD.currency
  OR NEW.total_minor IS NOT OLD.total_minor
  OR NEW.provider IS NOT OLD.provider
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR (OLD.paid_at IS NOT NULL AND NEW.paid_at IS NOT OLD.paid_at)
  OR (
    OLD.provider_session_id IS NOT NULL
    AND NEW.provider_session_id IS NOT OLD.provider_session_id
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'checkouts are immutable except status and provider binding'
  );
END;

-- ---------------------------------------------------------------------------
-- 4. One open checkout per (learner, certification, SKU)
-- ---------------------------------------------------------------------------
--
-- `request_fingerprint` is the storage-side name for the triple, so the index
-- needs no join and no expression. Only `pending` rows compete: a paid, failed,
-- expired or refunded checkout is history and must not block a new purchase.
--
-- The expiry job is the pressure valve: `expireStaleCheckouts` moves a lapsed
-- row to `expired`, which frees the slot, so a learner whose session timed out
-- is never locked out of buying the same product again.
CREATE UNIQUE INDEX commerce_checkouts_one_open_per_fingerprint
  ON commerce_checkouts(user_id, request_fingerprint)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- 5. `expired -> needs_support` is a legal edge
-- ---------------------------------------------------------------------------
--
-- 0018's trigger is **replaced**, not supplemented, for the same reason as the
-- immutability trigger above: two BEFORE UPDATE triggers on one table are two
-- places to read.
--
-- The edge this adds is the one settlement needs to answer a provider at all. A
-- `checkout.completed` can arrive after our own expiry closed the row, and the
-- amount can disagree with the snapshot, or the Pro leg can abort here (0019's
-- one-Pro-window trigger) because the learner already holds an overlapping Pro
-- window. Both are "money moved, nothing can be granted", which is exactly what
-- `needs_support` exists for; while the edge was missing, `markNeedsSupport`
-- aborted its own batch, the event row it writes in the same transaction rolled
-- back with it, and the delivery became a 5xx the provider retries forever -
-- with the learner's money already taken.
--
-- `expired -> paid` stays: a late payment that *does* apply settles normally.
-- `paid -> refunded` is still absent; a refunded checkout needs the refund record
-- that 0020 adds.
DROP TRIGGER commerce_checkouts_status_transition;

CREATE TRIGGER commerce_checkouts_status_transition
BEFORE UPDATE OF status ON commerce_checkouts
WHEN NOT (
  OLD.status = NEW.status
  OR (OLD.status = 'pending'
      AND NEW.status IN ('paid', 'failed', 'expired', 'needs_support'))
  OR (OLD.status = 'expired' AND NEW.status IN ('paid', 'needs_support'))
  OR (OLD.status = 'paid' AND NEW.status = 'needs_support')
)
BEGIN
  SELECT RAISE(ABORT, 'illegal checkout status transition');
END;
