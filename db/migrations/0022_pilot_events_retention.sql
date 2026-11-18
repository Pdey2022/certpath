-- 0022: the twelve-month retention floor for `pilot_events`.
--
-- The owner decided on 17 November 2026 that `pilot_events` is retained for 12
-- months for both sources, and resolved the remaining question on 18 November
-- 2026: consent withdrawal stops future events only, so stored history keeps its
-- full window and there is no erasure path. 0021 shipped the period without an
-- enforcement mechanism, deliberately; this migration lands the mechanism.
--
-- This number was free because 5F (assurance/MFA) moves from `0022` to `0023`:
-- `d1_migrations` records files in apply order, `db:chain` asserts that order
-- equals filename order, and a retention floor that exists before its review
-- cannot be appended behind a later slice.
--
-- Rules: docs/pilot-events-retention.md, docs/analytics-events.md,
-- docs/open-decisions.md.

-- The prune's access path across every row, regardless of event name, session or
-- product: `pilot_events_name_received_idx` cannot serve a window that is not
-- filtered by `event_name`.
CREATE INDEX pilot_events_received_at_idx ON pilot_events(received_at);

-- The floor. A row is deletable once D1's own clock says it is older than 365
-- days, and nothing younger can be deleted from any code path - the scheduled
-- prune, an operator's `d1 execute`, or a future module that got it wrong.
--
-- The comparison has up to one second of slack on purpose: `strftime('%s','now')`
-- truncates to whole seconds, so it can report a clock up to 999 ms behind
-- `Date.now()`. The slack only ever makes the window slightly *longer*, which is
-- the safe direction for a retention floor. Do not "fix" it to millisecond
-- precision - the floor must not depend on the caller's clock.
CREATE TRIGGER pilot_events_no_delete
BEFORE DELETE ON pilot_events
WHEN OLD.received_at >= (CAST(strftime('%s','now') AS INTEGER) * 1000 - 31536000000)
BEGIN
  SELECT RAISE(ABORT, 'pilot events are retained for 12 months');
END;

-- **No second `REPLACE` guard, deliberately.** 0021's `pilot_events_no_replace`
-- compares content, not the key alone: an `INSERT OR REPLACE` that would change
-- `received_at` - or any other column - aborts before conflict resolution, so no
-- one can refresh a row's clock to move it out of the prune's reach, and a
-- REPLACE that keeps every value identical stores the same row and therefore
-- cannot extend the window either.
--
-- A key-only `EXISTS` guard in front of INSERT would be worse than redundant: a
-- BEFORE INSERT trigger cannot see the statement's conflict clause, so it would
-- abort the `ON CONFLICT (source, event_id) DO NOTHING` dedupe that the recorder
-- relies on for a resubmitted id. The floor therefore needs only the delete
-- trigger above.
