# Pilot event retention

Twelve months for `pilot_events`, enforced in storage and delivered by a
scheduled prune. This is issue #110: the enforcement that
[`docs/pilot-hardening.md`](pilot-hardening.md) §Retention precondition names as a
precondition for enabling `PILOT_EVENTS_ENABLED`.

Status: **owner approved the design on 18 November 2026, with one addition —
consent withdrawal stops future events only.** Implemented in `0022`; no flag is
enabled, nothing is deployed.

## Scope

| In scope | Out of scope |
|---|---|
| The twelve-month floor on `pilot_events` (`0022`) | Any other table's retention (`audit_events` keeps 0016's floor) |
| The index the prune's access path needs (`pilot_events_received_at_idx`) | A schedule for database dumps |
| A bounded, idempotent prune in `apps/api/src/analytics/pilot-events-retention.ts` | A route, a staff capability, or an operator UI for deletion |
| The `PILOT_EVENTS_RETENTION_ENABLED` flag, wired into the Worker's `scheduled` handler | Erasure on consent withdrawal |
| Tests that fail if the floor, the prune's guards or the flag coupling regress | Any change to an existing migration |

## Decision

| Question | Answer | Record |
|---|---|---|
| How long is an event kept? | 365 days from `received_at`, both sources, one class, no legal hold | Owner, 17 November 2026 |
| Does consent withdrawal delete stored history? | **No.** Withdrawal stops future events; already-stored rows keep their full twelve-month window. There is no erasure path, no exception to the floor, and no `withdrawal_operation_id` column | Owner, 18 November 2026 |
| Who decides whether the prune runs? | The owner, through `PILOT_EVENTS_RETENTION_ENABLED` (exact string `"true"`) | This design |

Withdrawal is therefore a *consent* decision with no retention consequence: the
row a withdrawn learner produced is treated exactly like any other row of the same
age. `docs/analytics-events.md` says so, and that sentence is the contract.

## The floor

`db/migrations/0022_pilot_events_retention.sql`:

```sql
CREATE INDEX pilot_events_received_at_idx ON pilot_events(received_at);

CREATE TRIGGER pilot_events_no_delete
BEFORE DELETE ON pilot_events
WHEN OLD.received_at >= (CAST(strftime('%s','now') AS INTEGER) * 1000 - 31536000000)
BEGIN
  SELECT RAISE(ABORT, 'pilot events are retained for 12 months');
END;
```

It copies 0016's audit floor because that floor already answered the same three
questions, and answering them differently for a second table would be a bug
waiting to be explained:

- **The clock is D1's, not the caller's.** `strftime('%s','now')` runs inside the
  database, so a Worker whose clock is wrong, a stale retry, and a hand-written
  `wrangler d1 execute` all get the same answer. A caller-supplied timestamp can
  only ever *narrow* the candidate set.
- **One second of slack, on purpose.** `strftime('%s','now')` truncates to whole
  seconds, so it can report a clock up to 999 ms behind `Date.now()`. The slack
  only makes the window slightly longer, which is the safe direction for a floor.
  It must not be "fixed" to millisecond precision.
- **`received_at`, not `occurred_at`.** `occurred_at` is the client's claim (bounded
  by 0021's skew CHECK); `received_at` is our clock, and it is the clock the
  funnel windows on too. A retention window on a client-claimed value would be
  adjustable by the client.

### Why there is no second `REPLACE` guard

0016 added an explicit `BEFORE INSERT` guard beside the audit floor. `0022` does
not, and the difference is deliberate:

- 0021's `pilot_events_no_replace` already compares **content**, not the key:
  any `INSERT OR REPLACE` that would change `received_at` — or any other column —
  aborts before conflict resolution. The window cannot be refreshed.
- A REPLACE that keeps every value identical stores the same row, so it cannot
  extend the window either.
- A key-only `EXISTS` guard would be worse than redundant. A `BEFORE INSERT`
  trigger cannot see the statement's conflict clause, so it would abort the
  `ON CONFLICT (source, event_id) DO NOTHING` dedupe that the recorder relies on
  for a resubmitted id. `pilot-event-guards.test.ts` proves that dedupe works.

The claim is tested, not asserted: `pilot-events-retention.test.ts` shows an
identical `INSERT OR REPLACE` leaves `received_at` unchanged and a REPLACE that
moves it aborts.

## The prune

`apps/api/src/analytics/pilot-events-retention.ts` mirrors
`apps/api/src/security/audit-retention.ts` in shape: a window constant, a batch
constant, a result union (`{ ok: true, value: { deleted } } | { ok: false, reason:
"invalid-input" }`) and a function that does one bounded `DELETE`.

```sql
DELETE FROM pilot_events
WHERE rowid IN (
  SELECT rowid FROM pilot_events
  WHERE received_at < ?
    AND received_at < (CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 31536000000)
  ORDER BY received_at, source, event_id
  LIMIT ?
)
```

Three properties are load-bearing:

- **`rowid`, never `event_id`.** `event_id` is unique only per `source`
  (0021's primary key is `(source, event_id)`), so an `event_id IN (...)` list
  would delete a row in the other source that this run never selected.
- **The D1-clock predicate is repeated in the statement.** The passed `now` only
  narrows the candidate set; the floor is still decided in the database. Without
  the repeated predicate, a caller clock two years ahead would select young rows
  and the trigger would abort the whole batch — a denial of the prune, not an
  over-delete, but still wrong. With it, a wrong clock deletes nothing.
- **`ORDER BY received_at, source, event_id`** is a total order (the primary key
  makes `(source, event_id)` unique), so a backlog drains deterministically
  across runs and the batch is reproducible.

Invalid input (`NaN`, a non-integer, `now < 1`, `limit < 1`, `limit > 250`)
returns `invalid-input` before any statement is prepared.

### Cost

The Worker's cron is every five minutes: 288 runs a day.

| Batch | Worst-case deletes/day | D1 Free daily writes | Verdict |
|---|---|---|---|
| 250 (chosen) | 288 × 250 = 72,000 | 100,000 | Fits, with 28,000/day of headroom for the rest of the Worker |
| 500 | 288 × 500 = 144,000 | 100,000 | Breaches the limit |

The prune is idempotent, so a backlog bigger than one batch drains over the
following runs; it does not need a bigger batch to be correct. The test file
asserts `288 × pilotEventRetentionMaxBatch === 72_000`, so changing the constant
forces the arithmetic to be revisited.

## The flag

`PILOT_EVENTS_RETENTION_ENABLED` is a `wrangler.jsonc` var, `"false"` here, read
by the exact-string gate `pilotEventsRetentionEnabled(bindings)` — `"TRUE"`,
`" true"`, `"1"` and `"yes"` are all off.

With the flag off the `scheduled` handler prepares no statement and reads no row:
the check is before the `ctx.waitUntil`, not inside it. With it on, the prune runs
in its own `ctx.waitUntil`, so a failure in it cannot stop the question-import
cleanup, audit retention or commerce expiry beside it.

The flag is not what enforces the period. The trigger is. The flag only decides
whether the scheduled job bothers to look for expired rows; a database whose flag
was never turned on still refuses every in-window delete.

Nothing about the prune is logged except a failure's `reason` (for example
`invalid-input`). No event id, no session id, no row value, no count appears in a
log line: the row is deliberately unidentifiable and a log line must not undo that.

## Failure modes

| Shape | What happens | Consequence |
|---|---|---|
| Flag off (today) | No statement is prepared, no row read | The period is not delivered automatically; the floor still refuses any in-window delete |
| Worker clock wrong | `now` only narrows the candidate set; the D1 predicate decides | Under-delete at worst; never an over-delete |
| D1 clock ahead of ours | Window is up to 999 ms longer | A row lives marginally longer; safe direction |
| Prune fails (D1 error, bad input) | `scheduled` throws the failure `reason`; the rest of the cron continues | Rows stay longer than twelve months until the next successful run; no data is lost |
| Backlog larger than 250 | One batch per run | Drains at 250 rows per five minutes; the table grows no faster than the recorder writes |
| Someone issues a manual `DELETE` | The trigger aborts with `pilot events are retained for 12 months` | In-window rows are undeletable from every path |
| Someone tries to refresh `received_at` with `INSERT OR REPLACE` | 0021's content-comparing guard aborts | A row cannot be moved out of the prune's reach |
| Storage trigger missing (bad migration) | `pilot-event-guards.test.ts` and `pilot-events-retention.test.ts` fail by name | The floor cannot regress silently |

## Acceptance criteria

1. `0022` applies to a fresh local D1 after `0021` and a second apply is a no-op;
   `checksums.txt` has one appended line and no existing migration changed.
2. `DELETE FROM pilot_events` on a row inside the window aborts; on a row older
   than the window it succeeds.
3. `cleanupExpiredPilotEvents` deletes only out-of-window rows, reports the count,
   is idempotent, respects the batch bound, deletes by `rowid`, and refuses
   invalid input without touching a row.
4. A caller clock two years ahead cannot delete a young row.
5. `PILOT_EVENTS_RETENTION_ENABLED` accepts only `"true"`; with it off the
   `scheduled` handler starts no prune.
6. `wrangler.jsonc` declares the flag as `"false"` and no events flag is on while
   the retention flag is not.
7. Only `analytics/pilot-events-retention.ts` may contain `DELETE FROM
   pilot_events`.
8. Documentation states the period, the enforcement and the withdrawal rule
   consistently.

## Test plan

| Test | Where | What it would catch |
|---|---|---|
| Deletes only old rows, reports the count | `pilot-events-retention.test.ts` | A wrong window boundary or a silent no-op prune |
| Idempotent on a second run | same | A prune that double-counts or re-deletes |
| Bounded batch | same | A missing `LIMIT`, or a batch constant ignored by the statement |
| Direct delete inside the window aborts | same | A missing or mis-scoped delete trigger |
| Caller clock two years ahead deletes nothing | same | Trusting the passed `now` |
| Old row pruned, young row in the same fixture survives | same | A window evaluated per statement instead of per row |
| Same `event_id` in the other source survives | same | `event_id IN (...)` instead of `rowid IN (...)` |
| Invalid callers delete nothing | same | Input validation that runs after the statement |
| Identical `INSERT OR REPLACE` keeps `received_at`; a moved one aborts | same | The no-second-guard argument being false |
| Exact-string flag gate | same | A flag that accepts `"TRUE"` or a missing binding |
| `wrangler.jsonc` coupling | same | An events flag turned on while retention is off |
| Trigger inventory and old-vs-young delete | `pilot-event-guards.test.ts` | A dropped or renamed floor trigger |
| One-module delete allowlist | `src/index.test.ts` | A second module gaining a `DELETE` |
| Funnel gap from a missing write | `funnel.test.ts` | A test that depends on deleting a retained row |

## Rollback

Revert the commit. The migration is append-only, so `0022` stays applied on any
database it reached: the index and the delete trigger remain. That is safe to
leave in place — a floor that keeps rows for twelve months is the decided
behaviour whether or not the prune runs — and there is nothing to un-apply. If the
prune itself must stop, set `PILOT_EVENTS_RETENTION_ENABLED` to `"false"`; that
needs no deploy of code, only a var change by the owner.

There is no down migration. Nothing in `0022` removes data, so leaving it applied
cannot lose a row.

## Limits

- **The period is delivered only while the flag is on.** Today it is off: no
  scheduled prune runs, so rows accumulate and the floor has nothing to remove.
  The floor still refuses every in-window delete. Turning the flag on is an owner
  decision, like every other pilot barrier.
- **No dump can recover what the prune removed.** A dump taken after the prune
  never contained those rows; that is the policy working, not a restore gap. See
  [`docs/data-export-and-restore.md`](data-export-and-restore.md) §Limitations.
- **Deletion is by `received_at`, not by event time.** A row written late with an
  old `occurred_at` is kept for twelve months from storage; the window is on our
  clock.
- **No metrics.** The prune logs only a failure reason, so "how many rows did it
  remove" is answerable from the data, not from logs. That is the same trade the
  rest of the pilot makes: no personal data in logs.
- **No operator path to delete anything.** A support request to remove a learner's
  events cannot be satisfied, by design; the owner decision above says withdrawal
  stops future events only.
