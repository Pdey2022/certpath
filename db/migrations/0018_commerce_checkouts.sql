-- 0018: the commerce checkout ledger - checkouts, price-snapshot lines, provider events.
--
-- A checkout is a request to buy, not a purchase. Nothing in this migration can
-- grant access: `learner_access_grants` is untouched, no grant trigger is added
-- or relaxed, and the only way an entitlement appears is still an insert into
-- 0013's table with a deterministic `operation_id` (written by 0019, never
-- here). Settlement, receipts, refunds and the webhook are the next migration.
--
-- The line row is a **price snapshot**: `amount_minor`, `grants_feature` and the
-- grant term are copied from `apps/api/src/pricing.ts` at checkout creation and
-- never re-read from it, so a later price-list edit cannot change what a paid
-- checkout granted (ADR 0003: new prices do not rewrite completed purchases).
-- `price_source` records *how* the amount was obtained, so the bundle's derived
-- Pro line is auditable as derived rather than as a second price constant.
--
-- The term is stored as a unit plus its quantity, never as a bare day count.
-- 0017 replaced day counts with `TermSpec`, and a bare number would let the
-- next reader guess the unit: `grants_unit = 'calendar_months'` with
-- `grants_months` is 89 days from 1 February, while `'days'` with `grants_days`
-- is exactly that many. A `term_json` blob would be the alternative; two typed
-- columns plus a CHECK keep the reconstruction total without asking SQLite to
-- parse JSON to answer "what did this line grant".
--
-- `commerce_checkouts_refunded_requires_settled_refund` is deliberately absent:
-- its witness table `commerce_refunds` arrives in 0019. The `refunded` value is
-- in the status enum because the column must accept it when that migration
-- lands, but the transition trigger below does not permit `paid -> refunded`
-- yet, because no row could justify it and a refund with no refund record is
-- exactly the state the design's own trigger forbids.
--
-- Rules: docs/decisions/0003-pricing-pro-and-refunds.md and docs/commerce.md.

CREATE TABLE commerce_checkouts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  certification_id TEXT NOT NULL REFERENCES certifications(id) ON DELETE RESTRICT,
  client_checkout_key TEXT NOT NULL
    CHECK (length(client_checkout_key) BETWEEN 8 AND 128),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  -- The value comes from `pricing.ts`; no route may supply a currency literal.
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  total_minor INTEGER NOT NULL CHECK (total_minor > 0),
  status TEXT NOT NULL CHECK (status IN
    ('pending', 'paid', 'failed', 'expired', 'needs_support', 'refunded')),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
  provider_session_id TEXT UNIQUE,
  provider_redirect_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  paid_at INTEGER,
  -- A learner's retry is the same checkout, not a second one.
  UNIQUE (user_id, client_checkout_key),
  -- Money and the status that claims it are written together or not at all.
  CHECK (
    (status IN ('paid', 'refunded', 'needs_support') AND paid_at IS NOT NULL)
    OR (status IN ('pending', 'failed', 'expired') AND paid_at IS NULL)
  )
);

CREATE INDEX commerce_checkouts_user_idx
  ON commerce_checkouts(user_id, created_at DESC, id DESC);

-- The expiry job's working set: only pending rows, and only by their deadline.
CREATE INDEX commerce_checkouts_pending_idx
  ON commerce_checkouts(status, expires_at) WHERE status = 'pending';

CREATE TABLE commerce_checkout_lines (
  checkout_id TEXT NOT NULL REFERENCES commerce_checkouts(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 3),
  sku TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 160),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  grants_feature TEXT NOT NULL CHECK (grants_feature IN ('standard', 'pro')),
  -- The grant term, as `TermSpec`: one unit, one quantity, never both.
  grants_unit TEXT NOT NULL
    CHECK (grants_unit IN ('calendar_months', 'days')),
  grants_months INTEGER CHECK (grants_months IS NULL OR grants_months > 0),
  grants_days INTEGER CHECK (grants_days IS NULL OR grants_days > 0),
  price_source TEXT NOT NULL CHECK (price_source IN ('price-list', 'bundle-residual')),
  PRIMARY KEY (checkout_id, position),
  CHECK (
    (grants_unit = 'calendar_months'
      AND grants_months IS NOT NULL
      AND grants_days IS NULL)
    OR
    (grants_unit = 'days'
      AND grants_days IS NOT NULL
      AND grants_months IS NULL)
  )
);

-- Except for status, the provider binding and the paid/updated timestamps, a
-- checkout is immutable. A retry that re-prices or re-scopes a checkout cannot
-- land on the existing row; it has to be a new `client_checkout_key`.
CREATE TRIGGER commerce_checkouts_immutable
BEFORE UPDATE ON commerce_checkouts
WHEN NEW.user_id IS NOT OLD.user_id
  OR NEW.certification_id IS NOT OLD.certification_id
  OR NEW.client_checkout_key IS NOT OLD.client_checkout_key
  OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NEW.currency IS NOT OLD.currency
  OR NEW.total_minor IS NOT OLD.total_minor
  OR NEW.provider IS NOT OLD.provider
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(
    ABORT,
    'checkouts are immutable except status and provider binding'
  );
END;

-- Allowed edges only. `expired -> paid` is deliberate: money taken after our own
-- expiry still grants access. `paid -> refunded` waits for 0019, because the
-- settled-refund witness does not exist yet.
CREATE TRIGGER commerce_checkouts_status_transition
BEFORE UPDATE OF status ON commerce_checkouts
WHEN NOT (
  OLD.status = NEW.status
  OR (OLD.status = 'pending'
      AND NEW.status IN ('paid', 'failed', 'expired', 'needs_support'))
  OR (OLD.status = 'expired' AND NEW.status = 'paid')
  OR (OLD.status = 'paid' AND NEW.status = 'needs_support')
)
BEGIN
  SELECT RAISE(ABORT, 'illegal checkout status transition');
END;

-- An over-charge is impossible; a shortfall is visible as a receipt whose lines
-- sum below its total. The failure direction is deliberate.
CREATE TRIGGER commerce_checkout_lines_within_total
BEFORE INSERT ON commerce_checkout_lines
WHEN (
  SELECT COALESCE(SUM(amount_minor), 0)
  FROM commerce_checkout_lines
  WHERE checkout_id = NEW.checkout_id
) + NEW.amount_minor > (
  SELECT total_minor FROM commerce_checkouts WHERE id = NEW.checkout_id
)
BEGIN
  SELECT RAISE(ABORT, 'checkout lines would exceed the checkout total');
END;

CREATE TRIGGER commerce_checkout_lines_no_update
BEFORE UPDATE ON commerce_checkout_lines
BEGIN
  SELECT RAISE(ABORT, 'checkout lines are a price snapshot and cannot change');
END;

CREATE TRIGGER commerce_checkout_lines_no_delete
BEFORE DELETE ON commerce_checkout_lines
BEGIN
  SELECT RAISE(ABORT, 'checkout lines cannot be deleted');
END;

CREATE TRIGGER commerce_checkouts_no_delete
BEFORE DELETE ON commerce_checkouts
BEGIN
  SELECT RAISE(ABORT, 'checkouts cannot be deleted');
END;

-- The provider-attempt ledger and the reconciliation record against provider
-- state. Append-only, no retention job: it is not an audit row and it carries no
-- personal data beyond opaque ids. 0019 writes to it; nothing writes to it here.
CREATE TABLE commerce_provider_events (
  provider_event_id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('checkout.completed', 'checkout.failed')),
  checkout_id TEXT REFERENCES commerce_checkouts(id) ON DELETE RESTRICT,
  amount_minor INTEGER,
  currency TEXT,
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN
    ('applied', 'ignored-unknown-checkout', 'ignored-inconsistent'))
);

CREATE TRIGGER commerce_provider_events_no_update
BEFORE UPDATE ON commerce_provider_events
BEGIN
  SELECT RAISE(ABORT, 'provider events are append-only');
END;

CREATE TRIGGER commerce_provider_events_no_delete
BEFORE DELETE ON commerce_provider_events
BEGIN
  SELECT RAISE(ABORT, 'provider events cannot be deleted');
END;
