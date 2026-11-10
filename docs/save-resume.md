# Save and resume contract

This is a product contract, not a Milestone 0 implementation.

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

Milestone 0 has no learner persistence, authentication, session, or timer
implementation.
