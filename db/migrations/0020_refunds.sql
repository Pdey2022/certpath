-- 0020: refunds - the refund record, its lines, the one-per-exam cap, and the
-- three status edges that make money arriving after a failure real.
--
-- What this migration adds:
--
--   1. `commerce_refunds` and `commerce_refund_lines` - the decision record and
--      the checkouts it covers. A refund is written *before* the provider is
--      called (`requested`), settled only when the provider confirms, and every
--      line records the deadline it was let in under.
--   2. `commerce_refunds_one_per_exam` - one self-serve refund ever per
--      (account, exam), partial on `requested_by_user_id = user_id`. That
--      predicate is exactly "a learner refunding their own entitlement": a
--      future staff-initiated refund writes a different requester and is exempt
--      without an index rewrite, and no dead `channel` enum is needed.
--      `status <> 'failed'` is deliberate: a provider decline that moved no money
--      must not consume the learner's one self-serve refund.
--   3. `commerce_receipts_refund_references_settled_refund` - #79. 0019 created
--      `commerce_receipts.refund_id` with no foreign key because
--      `commerce_refunds` did not exist. SQLite cannot add a constraint, so the
--      rule is a trigger, and it is **stronger** than the foreign key it stands
--      in for: it requires the refund to be settled, to belong to the same
--      learner/exam/currency, and its line amount to equal the receipt's total.
--   4. `commerce_checkouts_status_transition` **replaced**, not supplemented, so
--      that `paid -> refunded`, `failed -> paid` and `failed -> needs_support`
--      are legal. 0019's edges are restated verbatim, and `expired ->
--      needs_support` in particular: re-narrowing it turns a parked late payment
--      back into a permanent 5xx with the learner's money already taken. #78
--      added that edge for exactly that reason; the test re-asserts it.
--   5. `commerce_checkouts_refunded_requires_settled_refund` - a separately named
--      rule (not a second copy of the edge list): a checkout may only become
--      `refunded` while a settled refund names it.
--   6. `commerce_checkouts_refunded_requires_paid_checkout` - the second, equally
--      separate rule about the same status: only a checkout that was once paid may
--      be refunded. Without it a writer that forces the transition can mark a
--      `pending` or `needs_support` row `refunded`, which is money we do not have
--      or cannot give back.
--
-- Why `failed -> paid` and `failed -> needs_support` exist: a `checkout.completed`
-- can arrive after a `checkout.failed`. Before this change the transition was
-- refused, the settlement batch wrote nothing, and the money was visible only as
-- a `commerce_provider_events` row that no checkout-level queue shows. Money that
-- arrives late must either grant or park; it must never vanish. The migration
-- alone does not achieve that - `apps/api/src/commerce/webhooks.ts` widens the
-- five `status IN ('pending','expired')` predicates in the same PR, because an
-- edge no statement uses is decoration.
--
-- What this migration deliberately does NOT add:
--
--   - No trigger on `learner_access_grants`. 0014's
--     `learner_access_grants_revoke_keeps_pro_covered` is the storage guard for
--     the Pro-before-Standard revocation order, and the refund's concurrency
--     guard is a compare-and-swap in the settle statement. A third definition of
--     coverage at the grant layer would be a second copy of a rule `pricing.ts`
--     already owns.
--   - No refund of a `needs_support` checkout and no resolution policy for parked
--     money: both are open owner decisions (#83).
--   - No staff refund route and no new capability. The schema leaves room
--     (`requested_by_user_id`); the route is Phase 5.
--
-- Rules: docs/decisions/0003-pricing-pro-and-refunds.md, docs/commerce.md,
-- docs/commerce-refunds.md.

-- ---------------------------------------------------------------------------
-- 1. Refunds - the decision record
-- ---------------------------------------------------------------------------
--
-- A refund is two transactions with a provider call between them. This table is
-- the first one: it says what we decided and for how much, before any money
-- moves. The provider's confirmation (`status = 'settled'`, `provider_refund_id`)
-- is the only mutable part, and only from `requested`.
CREATE TABLE commerce_refunds (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  certification_id TEXT NOT NULL REFERENCES certifications(id) ON DELETE RESTRICT,
  -- Who asked. Equal to `user_id` for every self-serve refund, which is the
  -- predicate of the one-per-exam index below; a future staff refund writes the
  -- staff member's id here and is exempt without an index rewrite.
  requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('requested', 'settled', 'failed')),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  -- The sum of the lines. Asserted at settle time, not trusted.
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  -- Learner-supplied free text. Capped at the contract's limit, and it must never
  -- reach `audit_events`: 0013's revoke trigger hardcodes its reason, so the text
  -- is stored once on the learner's own row and nowhere else.
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  -- "refund:<id>". Opaque, unique, and never derived from the provider.
  operation_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
  provider_refund_id TEXT UNIQUE,
  requested_at INTEGER NOT NULL,
  settled_at INTEGER,
  -- A settled refund is one the provider confirmed; a requested one is a decision
  -- we are still collecting on; a failed one is a definitive "no money moved" and
  -- is the only terminal state that may be retried.
  CHECK (status <> 'settled'
         OR (settled_at IS NOT NULL AND provider_refund_id IS NOT NULL)),
  CHECK (status <> 'requested'
         OR (settled_at IS NULL AND provider_refund_id IS NULL)),
  CHECK (status <> 'failed'
         OR (settled_at IS NULL AND provider_refund_id IS NULL)),
  CHECK (settled_at IS NULL OR settled_at >= requested_at)
);

CREATE INDEX commerce_refunds_user_idx
  ON commerce_refunds(user_id, requested_at DESC, id DESC);

-- Owner decision: one self-serve refund ever per (account, exam).
--
-- `status <> 'failed'` is the one refinement of the literal rule (owner decision,
-- 2026-11-16): a provider decline that moved no money does not consume the
-- learner's refund. A *settled* row can never be bypassed - two settled rows for
-- one (account, exam) both sit in this index, so the second insert aborts - and
-- `commerce_refund_lines_not_already_settled` below stops the same checkout being
-- paid back twice even when this index does not apply (a future staff refund).
CREATE UNIQUE INDEX commerce_refunds_one_per_exam
  ON commerce_refunds(user_id, certification_id)
  WHERE requested_by_user_id = user_id AND status <> 'failed';

-- ---------------------------------------------------------------------------
-- 2. Refund lines - the checkouts a refund covers
-- ---------------------------------------------------------------------------
--
-- The refund unit is the entitlement, which can be two checkouts: revoking the
-- Standard grant that is a Pro grant's only cover aborts at 0014, so the
-- dependent Pro checkout is refunded in the same record rather than refused.
-- `position BETWEEN 0 AND 3` is slack on purpose - the planner caps the set at
-- two, and a CHECK that aborted a legitimate refund would be worse than a loose
-- bound.
CREATE TABLE commerce_refund_lines (
  refund_id TEXT NOT NULL REFERENCES commerce_refunds(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 3),
  checkout_id TEXT NOT NULL REFERENCES commerce_checkouts(id) ON DELETE RESTRICT,
  -- A refund is always the full price of the checkout (ADR 0003: no partial
  -- periods, no line-level refunds). The trigger below makes that an invariant
  -- rather than a comment.
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  -- The deadline this line was let in under: `paid_at + refundWindowMs`, copied
  -- from `pricing.ts` by the writer. Stored rather than recomputed so the
  -- "inside the window" rule needs no second copy of the seven-day constant in
  -- SQL - the defect class this repo keeps paying for. The *value* is JS-owned
  -- and asserted by a test; the *ordering* is storage-owned.
  window_ends_at INTEGER NOT NULL,
  PRIMARY KEY (refund_id, position),
  UNIQUE (refund_id, checkout_id)
);

CREATE INDEX commerce_refund_lines_checkout_idx
  ON commerce_refund_lines(checkout_id);

-- A line may only name a checkout that is paid, belongs to this refund's learner,
-- exam and currency, is being refunded in full, and was decided inside its own
-- window.
CREATE TRIGGER commerce_refund_lines_validate_insert
BEFORE INSERT ON commerce_refund_lines
WHEN NOT EXISTS (
  SELECT 1
  FROM commerce_refunds AS refund
  JOIN commerce_checkouts AS checkout ON checkout.id = NEW.checkout_id
  WHERE refund.id = NEW.refund_id
    AND checkout.status = 'paid'
    AND checkout.user_id = refund.user_id
    AND checkout.certification_id = refund.certification_id
    AND checkout.currency = refund.currency
    AND checkout.total_minor = NEW.amount_minor
    AND refund.requested_at < NEW.window_ends_at
)
BEGIN
  SELECT RAISE(
    ABORT,
    'a refund line requires a paid checkout of this refund and an open window'
  );
END;

-- The guard that survives the staff route being added: a checkout can never be
-- paid back twice, even though the one-per-exam index does not apply to a staff
-- refund.
CREATE TRIGGER commerce_refund_lines_not_already_settled
BEFORE INSERT ON commerce_refund_lines
WHEN EXISTS (
  SELECT 1
  FROM commerce_refund_lines AS line
  JOIN commerce_refunds AS refund ON refund.id = line.refund_id
  WHERE line.checkout_id = NEW.checkout_id
    AND refund.status = 'settled'
)
BEGIN
  SELECT RAISE(ABORT, 'this checkout has already been refunded');
END;

CREATE TRIGGER commerce_refund_lines_no_update
BEFORE UPDATE ON commerce_refund_lines
BEGIN
  SELECT RAISE(ABORT, 'refund lines cannot change once recorded');
END;

CREATE TRIGGER commerce_refund_lines_no_delete
BEFORE DELETE ON commerce_refund_lines
BEGIN
  SELECT RAISE(ABORT, 'refund lines cannot be deleted');
END;

-- Only the provider's answer may be written, and only over a `requested` row.
-- `settled` and `failed` are terminal: a timeout can never be "re-decided" into
-- `failed` after the money moved, and a decline can never become `settled`
-- without a new refund row.
CREATE TRIGGER commerce_refunds_immutable_update
BEFORE UPDATE ON commerce_refunds
WHEN NEW.id IS NOT OLD.id
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.certification_id IS NOT OLD.certification_id
  OR NEW.requested_by_user_id IS NOT OLD.requested_by_user_id
  OR NEW.currency IS NOT OLD.currency
  OR NEW.amount_minor IS NOT OLD.amount_minor
  OR NEW.reason IS NOT OLD.reason
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.provider IS NOT OLD.provider
  OR NEW.requested_at IS NOT OLD.requested_at
  OR (
    OLD.status <> 'requested'
    AND (
      NEW.settled_at IS NOT OLD.settled_at
      OR NEW.provider_refund_id IS NOT OLD.provider_refund_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'refunds are immutable except the provider answer');
END;

CREATE TRIGGER commerce_refunds_status_transition
BEFORE UPDATE OF status ON commerce_refunds
WHEN NEW.status <> OLD.status
  AND NOT (OLD.status = 'requested' AND NEW.status IN ('settled', 'failed'))
BEGIN
  SELECT RAISE(ABORT, 'illegal refund status transition');
END;

CREATE TRIGGER commerce_refunds_no_delete
BEFORE DELETE ON commerce_refunds
BEGIN
  SELECT RAISE(ABORT, 'refunds cannot be deleted');
END;

-- ---------------------------------------------------------------------------
-- 3. #79 - a refund receipt references a settled refund for that checkout
-- ---------------------------------------------------------------------------
--
-- 0019 created `commerce_receipts.refund_id` with no foreign key because
-- `commerce_refunds` did not exist yet. The alternatives were a 12-step table
-- rebuild (which would silently drop `commerce_receipts_no_update` and
-- `commerce_receipts_no_delete`) or this trigger. The trigger is smaller, keeps
-- both append-only rules, and is strictly stronger than the foreign key: a key
-- could not say "settled", could not tie learner/exam/currency, and could not
-- tie the receipt's total to the refund line for that checkout.
CREATE TRIGGER commerce_receipts_refund_references_settled_refund
BEFORE INSERT ON commerce_receipts
WHEN NEW.kind = 'refund'
BEGIN
  SELECT RAISE(ABORT, 'a refund receipt requires a settled refund for this checkout')
  WHERE NOT EXISTS (
    SELECT 1
    FROM commerce_refunds AS refund
    JOIN commerce_refund_lines AS line ON line.refund_id = refund.id
    WHERE refund.id = NEW.refund_id
      AND refund.status = 'settled'
      AND refund.user_id = NEW.user_id
      AND refund.certification_id = NEW.certification_id
      AND refund.currency = NEW.currency
      AND line.checkout_id = NEW.checkout_id
      AND line.amount_minor = NEW.total_minor
  );
END;

-- ---------------------------------------------------------------------------
-- 4. The replaced checkout transition -- every legal edge
-- ---------------------------------------------------------------------------
--
-- 0019's trigger is **replaced**, not supplemented: two BEFORE UPDATE triggers on
-- one table would be two places to read, and the second could be dropped without
-- anyone noticing the first still fired. 0018 and 0019's comments both say two
-- triggers on this table are the anti-pattern; the refund witness below is a
-- *different rule* (not another edge list) and is named for what it enforces, so
-- it is a second trigger on purpose.
--
-- Edges 0019 restated verbatim, none dropped:
--   pending -> paid | failed | expired | needs_support
--   expired -> paid | needs_support        (late payment; #78's park)
--   paid    -> needs_support
-- New in 0020:
--   paid    -> refunded                    (guarded by the witness below)
--   failed  -> paid                        (money arriving after a failure grants)
--   failed  -> needs_support               (money arriving that cannot be applied parks)
--
-- `refunded -> *`, `needs_support -> *` and `failed -> expired` stay illegal:
-- terminal states stay terminal, and an expiry job may not rewrite history.
DROP TRIGGER commerce_checkouts_status_transition;

CREATE TRIGGER commerce_checkouts_status_transition
BEFORE UPDATE OF status ON commerce_checkouts
WHEN NOT (
  OLD.status = NEW.status
  OR (OLD.status = 'pending'
      AND NEW.status IN ('paid', 'failed', 'expired', 'needs_support'))
  OR (OLD.status = 'expired' AND NEW.status IN ('paid', 'needs_support'))
  OR (OLD.status = 'failed' AND NEW.status IN ('paid', 'needs_support'))
  OR (OLD.status = 'paid' AND NEW.status IN ('refunded', 'needs_support'))
)
BEGIN
  SELECT RAISE(ABORT, 'illegal checkout status transition');
END;

-- A checkout may only become `refunded` while a settled refund names it. This is
-- the witness rule, not an edge rule: it is what makes "refunded with money still
-- with us" and "refunded with access still live" unrepresentable from any code
-- path, including one written next year.
CREATE TRIGGER commerce_checkouts_refunded_requires_settled_refund
BEFORE UPDATE OF status ON commerce_checkouts
WHEN NEW.status = 'refunded'
BEGIN
  SELECT RAISE(ABORT, 'a refunded checkout requires a settled refund')
  WHERE NOT EXISTS (
    SELECT 1
    FROM commerce_refund_lines AS line
    JOIN commerce_refunds AS refund ON refund.id = line.refund_id
    WHERE line.checkout_id = NEW.id
      AND refund.status = 'settled'
  );
END;

-- A refunded checkout was paid, once. This is the **third** distinct rule about
-- `refunded`, and the second witness: the trigger above asks "is there a settled
-- refund naming this row?", this one asks "could money ever have moved on this
-- row?". Neither implies the other - a forced `refunded` on a `pending` row has no
-- settled refund *and* no payment, and a `needs_support` row is money we hold that
-- no policy lets us give back yet (#83).
--
-- Created last on purpose. Of the BEFORE UPDATE triggers on this table SQLite
-- fires the newest first, and this is the rule that should answer a writer that
-- forces the transition; `commerce_checkouts_refunded_requires_settled_refund`
-- still answers every `paid` row that has no settled refund, so nothing it used
-- to catch is now missed. The settle batch itself never reaches this trigger:
-- its checkout statement filters `status = 'paid'`, so a row it cannot move is
-- caught by the checkout-transition count `applyRefundSettlement` returns, not
-- here. This trigger exists for the writer that forgets that filter.
CREATE TRIGGER commerce_checkouts_refunded_requires_paid_checkout
BEFORE UPDATE OF status ON commerce_checkouts
WHEN NEW.status = 'refunded' AND OLD.status NOT IN ('paid', 'refunded')
BEGIN
  SELECT RAISE(ABORT, 'only a paid checkout can be refunded');
END;
