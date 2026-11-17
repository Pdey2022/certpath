-- 0021: pilot funnel events - a typed, consent-aware event log with no personal
-- data and no free text.
--
-- Every column is an enum, an integer, or a token that cannot hold an `@`, a
-- space or punctuation, so "no email, no free text" is a storage property rather
-- than a code-review habit. There is no JSON column and no free-text column: a
-- property bag would be the one surface the CHECKs cannot see into.
--
-- `(source, event_id)` is the dedupe key. Browser ids are client-generated
-- UUIDs, so a resubmit collapses; server ids are deterministic from the domain
-- fact (`checkout:<id>`, `settlement:<providerEventId>`, `grant:<operationId>`),
-- so a replayed provider webhook collapses at storage even if the calling code
-- forgets to check.
--
-- Consent is a signed cookie verified by the Worker, never a body claim: a row
-- with `consent = 'granted'` must carry the `anonymous_session_id` the cookie was
-- signed over, and a browser row must be consented at all. Server rows are
-- `not-required`: the owner's ruling on consent for order-linked server events is
-- open, and this schema keeps that value available without building any identity
-- linkage.
--
-- **No delete guard and no delete path, deliberately.** Retention for this table
-- is an owner decision (12 months for both sources, 17 November 2026) but the
-- enforcement of that floor - clock semantics, D1 skew, withdrawal - is its own
-- review. 0021 ships no `DELETE` trigger and no module issues
-- `DELETE FROM pilot_events`; the guard lands with the enforcement.
--
-- Rules: docs/pilot-hardening.md, docs/analytics-events.md,
-- docs/open-decisions.md.

CREATE TABLE pilot_event_names (
  name TEXT PRIMARY KEY NOT NULL
    CHECK (length(name) BETWEEN 1 AND 64 AND name NOT GLOB '*[^a-z_]*'
           AND name GLOB '[a-z]*'),
  introduced_in TEXT NOT NULL CHECK (introduced_in = '0021')
);

INSERT INTO pilot_event_names (name, introduced_in) VALUES
  ('exam_viewed','0021'), ('sample_started','0021'), ('sample_completed','0021'),
  ('signup_completed','0021'), ('checkout_started','0021'),
  ('purchase_confirmed','0021'), ('practice_completed','0021'),
  ('mock_completed','0021'), ('pro_activated','0021'),
  ('pro_simulation_completed','0021'), ('access_renewed','0021');

CREATE TABLE pilot_events (
  source        TEXT NOT NULL CHECK (source IN ('browser','server')),
  event_id      TEXT NOT NULL CHECK (length(event_id) BETWEEN 8 AND 128
                                     AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
  -- The vocabulary is a table, not a CHECK list: a new event is an INSERT in a
  -- later migration and cannot be invented by a caller.
  event_name    TEXT NOT NULL REFERENCES pilot_event_names(name) ON DELETE RESTRICT,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  occurred_at   INTEGER NOT NULL CHECK (occurred_at > 0),
  -- Five minutes of future skew at most, and a day of past drift. The windows
  -- the funnel measures on use `received_at` (our clock), never this value.
  received_at   INTEGER NOT NULL CHECK (received_at >= occurred_at - 86400000
                                        AND occurred_at <= received_at + 300000),
  consent       TEXT NOT NULL CHECK (consent IN ('granted','not-required')),
  anonymous_session_id TEXT
    CHECK (anonymous_session_id IS NULL OR (length(anonymous_session_id) BETWEEN 16 AND 64
           AND anonymous_session_id NOT GLOB '*[^A-Za-z0-9_-]*')),
  exam_id       TEXT CHECK (exam_id IS NULL OR (length(exam_id) BETWEEN 1 AND 64
                        AND exam_id NOT GLOB '*[^A-Za-z0-9._:-]*')),
  exam_version  INTEGER CHECK (exam_version IS NULL OR exam_version > 0),
  sample_id     TEXT CHECK (sample_id IS NULL OR (length(sample_id) BETWEEN 1 AND 128
                        AND sample_id NOT GLOB '*[^A-Za-z0-9._:-]*')),
  order_id      TEXT CHECK (order_id IS NULL OR (length(order_id) BETWEEN 1 AND 128
                        AND order_id NOT GLOB '*[^A-Za-z0-9._:-]*')),
  product_id    TEXT CHECK (product_id IS NULL OR (length(product_id) BETWEEN 1 AND 64
                        AND product_id NOT GLOB '*[^A-Za-z0-9._:-]*')),
  provider_event_id TEXT CHECK (provider_event_id IS NULL
                        OR (length(provider_event_id) BETWEEN 1 AND 128
                            AND provider_event_id NOT GLOB '*[^A-Za-z0-9._:-]*')),
  currency      TEXT CHECK (currency IS NULL OR length(currency) = 3),
  amount_minor  INTEGER CHECK (amount_minor IS NULL OR amount_minor > 0),
  result_band   TEXT CHECK (result_band IS NULL OR result_band IN ('below','near','above')),
  question_count_band TEXT CHECK (question_count_band IS NULL
                        OR question_count_band IN ('1-10','11-25','26-50','51+')),
  PRIMARY KEY (source, event_id),
  -- A consented event names the session it was consented for; a server fact has
  -- no session at all (no identity linkage is built here).
  CHECK (consent <> 'granted' OR anonymous_session_id IS NOT NULL),
  CHECK (source = 'browser' OR anonymous_session_id IS NULL),
  -- Money is either absent or complete; a half-written amount is not a band.
  CHECK ((currency IS NULL) = (amount_minor IS NULL))
);

CREATE INDEX pilot_events_name_received_idx
  ON pilot_events(event_name, received_at, product_id);

CREATE INDEX pilot_events_session_received_idx
  ON pilot_events(anonymous_session_id, received_at)
  WHERE anonymous_session_id IS NOT NULL;

-- The per-event field matrix, as a trigger because SQLite forbids a subquery in
-- a CHECK. Every name admits exactly the fields `docs/analytics-events.md` lists
-- for it and no others: a purchase without an amount, or a result band on an
-- `exam_viewed`, aborts instead of being stored as noise.
CREATE TRIGGER pilot_events_validate_insert
BEFORE INSERT ON pilot_events
WHEN NOT (
  (NEW.event_name = 'exam_viewed'
    AND NEW.exam_id IS NOT NULL
    AND NEW.sample_id IS NULL AND NEW.order_id IS NULL AND NEW.product_id IS NULL
    AND NEW.provider_event_id IS NULL AND NEW.currency IS NULL
    AND NEW.amount_minor IS NULL AND NEW.result_band IS NULL
    AND NEW.question_count_band IS NULL)
  OR (NEW.event_name IN ('sample_started','sample_completed')
    AND NEW.exam_id IS NOT NULL AND NEW.sample_id IS NOT NULL
    AND NEW.exam_version IS NULL AND NEW.order_id IS NULL
    AND NEW.product_id IS NULL AND NEW.provider_event_id IS NULL
    AND NEW.currency IS NULL AND NEW.amount_minor IS NULL
    AND NEW.question_count_band IS NULL
    AND (NEW.event_name = 'sample_completed' OR NEW.result_band IS NULL))
  OR (NEW.event_name = 'checkout_started'
    AND NEW.order_id IS NOT NULL AND NEW.product_id IS NOT NULL
    AND NEW.currency IS NOT NULL AND NEW.amount_minor IS NOT NULL
    AND NEW.exam_id IS NULL AND NEW.exam_version IS NULL
    AND NEW.sample_id IS NULL AND NEW.provider_event_id IS NULL
    AND NEW.result_band IS NULL AND NEW.question_count_band IS NULL)
  OR (NEW.event_name = 'purchase_confirmed'
    AND NEW.order_id IS NOT NULL AND NEW.product_id IS NOT NULL
    AND NEW.currency IS NOT NULL AND NEW.amount_minor IS NOT NULL
    AND NEW.provider_event_id IS NOT NULL
    AND NEW.exam_id IS NULL AND NEW.exam_version IS NULL
    AND NEW.sample_id IS NULL AND NEW.result_band IS NULL
    AND NEW.question_count_band IS NULL)
  OR (NEW.event_name = 'pro_activated'
    AND NEW.exam_id IS NOT NULL AND NEW.product_id IS NOT NULL
    AND NEW.order_id IS NOT NULL
    AND NEW.exam_version IS NULL AND NEW.sample_id IS NULL
    AND NEW.provider_event_id IS NULL AND NEW.currency IS NULL
    AND NEW.amount_minor IS NULL AND NEW.result_band IS NULL
    AND NEW.question_count_band IS NULL)
  OR (NEW.event_name IN ('practice_completed','mock_completed','pro_simulation_completed')
    AND NEW.exam_id IS NOT NULL AND NEW.question_count_band IS NOT NULL
    AND NEW.exam_version IS NULL AND NEW.sample_id IS NULL
    AND NEW.order_id IS NULL AND NEW.product_id IS NULL
    AND NEW.provider_event_id IS NULL AND NEW.currency IS NULL
    AND NEW.amount_minor IS NULL AND NEW.result_band IS NULL)
  OR (NEW.event_name IN ('signup_completed','access_renewed')
    AND NEW.exam_id IS NULL AND NEW.exam_version IS NULL
    AND NEW.sample_id IS NULL AND NEW.order_id IS NULL
    AND NEW.product_id IS NULL AND NEW.provider_event_id IS NULL
    AND NEW.currency IS NULL AND NEW.amount_minor IS NULL
    AND NEW.result_band IS NULL AND NEW.question_count_band IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'pilot event fields do not match its name');
END;

-- Money and access are server facts. A browser cannot claim one even if a route
-- is bypassed, so a forged purchase_confirmed cannot inflate conversion.
CREATE TRIGGER pilot_events_browser_cannot_claim_server_event
BEFORE INSERT ON pilot_events
WHEN NEW.source = 'browser'
  AND NEW.event_name NOT IN ('exam_viewed','sample_started','sample_completed')
BEGIN
  SELECT RAISE(ABORT, 'a browser event cannot claim a server fact');
END;

-- Append-only content.
CREATE TRIGGER pilot_events_no_update
BEFORE UPDATE ON pilot_events
BEGIN
  SELECT RAISE(ABORT, 'pilot events are append-only');
END;

-- `pilot_events_no_update` does not stop `INSERT OR REPLACE`: SQLite resolves the
-- primary-key conflict by deleting the pre-existing row, which fires no delete
-- trigger unless recursive triggers are enabled (0016's hole).
--
-- The guard compares **content**, not the key alone, and that is load-bearing.
-- A BEFORE INSERT trigger runs before conflict resolution, so a key-only
-- `EXISTS` guard aborts the `ON CONFLICT(source, event_id) DO NOTHING` that the
-- recorder relies on for a resubmitted id: every duplicate would raise instead of
-- being a no-op (proved by `pilot-event-guards.test.ts`). Comparing every column
-- lets an identical resubmit resolve as `DO NOTHING` - storing nothing and
-- changing nothing - while any attempt to rewrite a retained row's content
-- through `INSERT OR REPLACE` aborts. A same-content replace is a no-op rewrite:
-- SQLite does not expose the statement's conflict clause to a trigger, so it
-- cannot be told apart, and it cannot change what is stored.
CREATE TRIGGER pilot_events_no_replace
BEFORE INSERT ON pilot_events
WHEN EXISTS (
  SELECT 1 FROM pilot_events AS existing
  WHERE existing.source = NEW.source
    AND existing.event_id = NEW.event_id
    AND (existing.event_name IS NOT NEW.event_name
      OR existing.schema_version IS NOT NEW.schema_version
      OR existing.occurred_at IS NOT NEW.occurred_at
      OR existing.received_at IS NOT NEW.received_at
      OR existing.consent IS NOT NEW.consent
      OR existing.anonymous_session_id IS NOT NEW.anonymous_session_id
      OR existing.exam_id IS NOT NEW.exam_id
      OR existing.exam_version IS NOT NEW.exam_version
      OR existing.sample_id IS NOT NEW.sample_id
      OR existing.order_id IS NOT NEW.order_id
      OR existing.product_id IS NOT NEW.product_id
      OR existing.provider_event_id IS NOT NEW.provider_event_id
      OR existing.currency IS NOT NEW.currency
      OR existing.amount_minor IS NOT NEW.amount_minor
      OR existing.result_band IS NOT NEW.result_band
      OR existing.question_count_band IS NOT NEW.question_count_band)
)
BEGIN
  SELECT RAISE(ABORT, 'pilot events are append-only');
END;

-- The vocabulary is append-only too: a new event is an INSERT in a later
-- migration, never a rebuild of the list under rows that reference it.
CREATE TRIGGER pilot_event_names_no_update
BEFORE UPDATE ON pilot_event_names
BEGIN
  SELECT RAISE(ABORT, 'the pilot event vocabulary is append-only');
END;

CREATE TRIGGER pilot_event_names_no_delete
BEFORE DELETE ON pilot_event_names
BEGIN
  SELECT RAISE(ABORT, 'the pilot event vocabulary is append-only');
END;
