# Save and resume contract

This is the product contract. Milestone 3A implements the untimed practice subset described below; timed mock/Pro behavior remains future scope.

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

Milestone 3A requires an active time-bounded exam grant on every attempt read or
write. If the grant expires during an active attempt, the current implementation
blocks further reads and writes while retaining the snapshot. Whether an active
attempt should continue or receive a grace period is an unresolved product
decision, not a release policy.
