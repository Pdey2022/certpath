# Save and resume contract

This is the product contract. Milestone 3A implements untimed practice and
Milestone 3B implements fixed-format Standard timed mocks. Adaptive Pro exam
behavior remains future scope.

- Autosave must persist the active practice session, position, question order,
  accepted answers, submitted/revealed state and filters.
- A completed attempt is locked and cannot be resumed as editable.
- Show `Saving`, `Saved` with acknowledgement time, and `Unable to save—retry`.
  Never show `Saved` before server acknowledgement.
- `Save & exit` waits for acknowledgement or offers retry/stay. A page-unload
  request alone is insufficient.
- Keep bounded pending state during temporary disconnection, retry safely, and
  make unsynced work visible. Durable offline storage is excluded.
- Deduplicate requests and version session updates; reject stale writes without
  silently replacing newer progress. Restored filters cannot change an active
  question set.
- Recover from expired authentication without bypassing access checks. Persist
  notes, bookmarks and history across devices.
- Mock/Pro timers are authoritative on the server; leaving does not imply a
  pause. Resume restores acknowledged answers and remaining time.

For untimed practice, creating an attempt stores the filters, selected question
revisions, question order and option order in D1. A submitted answer and the
position advance are one atomic write guarded by the expected attempt version.
An idempotency key makes a retry of the same submission safe. Correctness and
explanations are returned only after that question's answer is acknowledged.
Save & exit is disabled while a selected answer is unsubmitted; it does not
pretend that an in-memory selection was saved. No pending answer is written to
browser storage.

For Standard timed mocks, each exam version has a server-owned versioned
profile. The approved profile is 15 minutes and 10 published questions.
Creation snapshots exact published revisions and option order, then starts a
non-pausable deadline from the server clock. Answer and navigation writes use
request IDs and an expected attempt version; the deadline is checked on every
write. Active responses never reveal answer keys or explanations. Submission
or the next authorized read after expiry finalizes exactly once from
acknowledged answers and locks the result. Resume restores those answers and
the server deadline. See the [timed-mock API contract](timed-mock-api.md).

Milestone 3A requires an active time-bounded exam grant on every attempt read or
write. If the grant expires during an active attempt, the current implementation
blocks further reads and writes while retaining the snapshot. Whether an active
attempt should continue or receive a grace period is an unresolved product
decision, not a release policy.

Milestone 3B retains that access behavior for timed mocks: an expired Standard
grant blocks attempt access even after the mock deadline. A later authorized
read finalizes an expired mock from acknowledged answers. The product owner
still needs to decide whether an active attempt may continue, receives a grace
interval, or stops at grant expiry, and how completed explanations remain
available.
