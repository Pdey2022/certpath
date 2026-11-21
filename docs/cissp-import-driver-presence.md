# The import driver's presence rule

Status: implemented in `tools/cissp-import-driver/presence.ts`.
This is the design that `docs/cissp-import-driver.md` §Idempotency and resume
refers to. It is recorded here because a design that lives only in a review
thread does not exist.

## The defect it replaces

The driver decides whether a question already exists on the server. It used to
ask `GET …/questions?…&search=<key>&limit=50` once per key and exact-match
`questionKey` on the first page. On a live staging run that read reported
**3 of 5 rows missing when all 5 existed**, so the driver treated keyed rows as
new, re-previewed the same bytes, earned a `409` on the confirm, and stopped.

The route's SQL is
`(question_key LIKE '%key%' OR revision.stem LIKE '%key%') ORDER BY question.id
LIMIT ?`. A probe for `cissp-12` also matches `cissp-120`; a probe for `cissp-1`
matches `cissp-112`, `cissp-120` and any stem that quotes `cissp-1`. The driver
read only the first page of 50 and never followed `cursor`. An exact row can sit
past the first page, and the answer "absent" was never sound.

It was not repaired by adding a cursor to the probe. The question the probe asks
— *what does a ranked, substring-filtered, page-windowed result return first?* —
is the wrong question, and paginating it would still cost up to five full walks
per unit and keep correctness hostage to `LIKE` escaping and stem content.

## The rule

**Presence is a checkpoint-local fact wherever the checkpoint can answer it. The
server is consulted only for rows it cannot, and then only through an exhaustive
listing compared by exact key.**

### 1. The checkpoint answers first, with no request

A `questions[]` record carrying both a `questionId` **and** a `revisionId` is
proof the row exists:

- both ids are written only from a server answer — a confirm's positional
  arrays, or the listing read in §2 — and there is no other writer;
- `questions_immutable_delete` (`0003_versioned_content.sql`) aborts every
  `DELETE FROM questions`, so a recorded id cannot disappear;
- `questions_immutable_update` forbids changing a question's id or key, so a
  recorded id cannot come to mean another question;
- `UNIQUE (certification_id, question_key)` means the key names at most one
  question.

Presence is monotone, so the local answer needs no request, no expiry and no
verification. `state` and `inFlight` must not gate it: `state` is workflow
progress and `inFlight` is an intent about a *revision* mutation; neither can
remove a row. Reading them would call a published question absent and re-read
rows the server already holds.

A record that does not carry both ids — one set and one unset, or neither — is a
corrupted checkpoint. No writer produces one, and one cannot be repaired
(`addQuestions` refuses a key that is already present with different ids), so
the run stops with `CHECKPOINT_INVALID` rather than falling back to the server:
a hand-edited or truncated id would otherwise let the driver adopt a question it
never created. `null`, `undefined` and `""` all count as absent, so a dropped
field cannot pass for a complete record.

Presence is *not* a revision-identity claim. A recorded `revisionId` may lag the
server if someone edited the question (this driver never does). The publish stage
is what re-reads `workflowState` and the publication pointer, and stops on
`PUBLICATION_CONFLICT`.

### 2. The server answers the rest, by walking one topic

For the rows the checkpoint cannot answer, the driver groups them by
`(domainId, topicId)` and walks each topic's listing once:

```
GET …/questions?domainId=<row domain>&topicId=<row topic>&limit=50[&cursor=…]
```

- `pageClause(cursor, "question.id")` is `AND question.id > ?` with
  `ORDER BY question.id`, so the walk is exhaustive and cursor-correct.
- No `search`. A substring match is never the row.
- `nextCursor` must be `string | null`. An absent cursor is `PROTOCOL_ERROR`,
  never "end of list" — which is why this does not reuse `paginate`, which
  treats a missing cursor as the end and has no bound.
- The walk is bounded at 40 pages per topic (≈2 000 questions). Hitting the
  bound stops the run with `PRESENCE_UNKNOWN`; it never concludes.
- Only `{id, questionKey, currentRevisionId, revisionNumber}` are read. The
  response also carries a 200-character `stem` preview: it is parsed and
  discarded, never stored, never logged, never in an error detail.

A question counts as **present** only when the key matches **exactly** and its
current revision is **revision 1**. A key at a later revision is present but not
adoptable — the driver cannot show it holds the content its review note claims —
so the run stops with `PRESENCE_UNKNOWN`.

Revision 1 is necessary and **not sufficient**. It says *an* import created the
first revision of that key; it does not say *these bytes* did, and
`UNIQUE (certification_id, question_key)` is scoped to the certification, so a
corrected source re-imported against the same keys meets rows that hold the
older content at revision 1. The discriminator is the checkpoint's own record
that it previewed these exact bytes: a non-null `importId` on the unit
(`reconcileUnits` clears it whenever a unit's bytes move). So adoption
**fails closed**:

- an id the checkpoint itself recorded is this run's own answer and is used;
- an id taken from the listing is used **only** when the unit's `importId` is
  non-null;
- otherwise the run stops with `EXISTING_KEYS` and names the unproven keys.

That decision lives in `openUnit` (`run.ts`), which owns the unit record; the
resolver only reports where each id came from.

Absence is therefore only ever concluded from an exhausted listing. And absence
never causes a create: the driver has no create path here, so "absent" leads at
most to retrying the same `importId` or re-previewing the same bytes, both of
which the server de-duplicates.

## Failure codes

| Situation | Code |
|---|---|
| the walk exceeds the page bound | `PRESENCE_UNKNOWN` |
| a key is present only at a later revision | `PRESENCE_UNKNOWN` |
| a preview refusal named more existing keys than the read proves | `PRESENCE_UNKNOWN` |
| a page's `nextCursor` is neither a string nor `null` | `PROTOCOL_ERROR` |
| `401`/`403`/`429` mid-walk | `SESSION_LOST` / `RATE_LIMITED`, propagated; not counted in `counters.http5xx` |
| `5xx` mid-walk | `PROTOCOL_ERROR`, propagated, and counted in `counters.http5xx` |
| a 2xx with an unusable body mid-walk | `PROTOCOL_ERROR`, propagated; not counted, because it carries no status |
| some keys established present, at least one established absent | `PARTIAL_IMPORT` |
| a refusal that mixes `existing_question_key` with another issue code | `EXISTING_KEYS` |
| every row established, but some id would come from the listing and this checkpoint never previewed these bytes | `EXISTING_KEYS`, naming the unproven keys |
| a checkpoint record without both ids, a record under another unit, a missing taxonomy id | `CHECKPOINT_INVALID` |
| the same key twice in one unit's rows | `DUPLICATE_QUESTION_KEY` |

`PARTIAL_IMPORT` and `PRESENCE_UNKNOWN` are different claims and are never
interchanged. `PARTIAL_IMPORT` asserts a fact — that is why it requires **both**
sets non-empty, some keys present and at least one established absent; a read
that finds nothing is `none`, not `some`. `PRESENCE_UNKNOWN` says the read could
not conclude, and nothing is acted on.

`noteStop` already writes the code to `checkpoint.lastError`, so the stop is
visible on disk with no extra plumbing.

**What the counters mean.** `counters.recoveries` counts recovery *paths* taken,
not adopted rows or requests: one per create-or-adopt recovery in
`createWithRecovery`; one per presence resolve that returned a result, whether
or not the caller then refused it (a resolve that throws does not count, and one
that answers entirely from the checkpoint does); and one per publish-stage
observation of a question whose mutation was in flight (`observeQuestion`).
Do not confuse it with the local `conflictRetries` in `convergeQuestion`
(`run.ts`, formerly `recoveries`, which is why it read like the counter): that
local bounds one question's reconcile-and-retry after a non-`ok` mutation
answer — a `409`, a `5xx`, a timeout — and the second such answer stops the run.
It is never persisted and is not `checkpoint.counters.recoveries`; only
`noteRecovery` moves that counter.
`counters.http5xx` counts a `5xx` seen on preview, confirm, submit, review or
publish, and a `5xx` that fails a presence walk — which is why the resolver's
caller records it before letting `PROTOCOL_ERROR` propagate. It does **not**
count a `5xx` on a stage-1 taxonomy *read*, on authentication, or on the stage-4
observation / stage-5 export reads. A stage-1 *create* that answers `5xx` is
counted **only when the recovery could not adopt the row**: `createWithRecovery`
calls `noteOutcome` after `adopt` returns `null`, so a `5xx` whose create
actually landed is adopted, adds a `counters.recoveries` entry and adds nothing
to `http5xx`. An operator who sees `http5xx` rise during stage 1 is therefore
looking at that create path; a `0` does not prove the create failed.

## The two call sites

**Ambiguous confirm.** `decideConfirm` does not change: the fix is behind the
observation. `resolveUnitPresence` returns a richer `UnitPresence` and `run.ts`
maps it down to `ConfirmObservation`, so `decide.ts` stays the pure decision
table the acceptance test pins. The read covers the whole unit; with the
subset-preview recovery gone there is no narrower set left to read.

**Preview refused with `existing_question_key`.** When *every* issue is
`existing_question_key`, the server already holds the unit's rows, so the driver
resolves the unit by presence. When the walk finds fewer keys than the refusal
asserted, two server answers disagree and the run stops with
`PRESENCE_UNKNOWN` — that is the live incident, converted from a silent false
"missing" into an honest stop. When it finds some but not all, at least as many
as the refusal asserted, the server really does hold part of the unit:
`PARTIAL_IMPORT`, because the preview is all-or-nothing and nobody can proceed
from half a unit. When it finds the whole unit, adoption is still fail-closed:
ids from the listing need this checkpoint's `importId`, otherwise `EXISTING_KEYS`.

Adoption takes the legal two-step transition `previewing → previewed →
confirmed` in memory with a **single** persist. `previewing → confirmed` was
deliberately not added to `UNIT_TRANSITIONS`: `previewed` is the state that
proves a preview attempt produced an `importId`, and widening the table would
let a future path confirm a unit whose preview never ran. The intermediate is
never written, because `previewed` with a null `importId` is a state the resume
loop does not handle.

Ids are mapped to rows **by key**, never by array position: the resolver
interleaves checkpoint and server results by row order, and positional coupling
would mis-attribute taxonomy keys silently.

Question adoption does not increment `RunReport.adoptions`. That counter belongs
to taxonomy adoption and is asserted by the stage-1 acceptance test; question
adoption is reported by the log line and `counters.recoveries`.

## Cost

Zero requests when the checkpoint holds every id — the normal case after a
stage-2 re-run reset the unit states but not the questions. Otherwise one request
per 50 questions of the affected topic, bounded at 40 pages per topic. A
reconcile never costs one request per key.

`maxPagesPerTopic` is a **test-only** seam on the resolver input, so a test can
prove the bound bites without a 2 000-row fixture. `run.ts` never sets it and
production always uses `DEFAULT_MAX_PAGES_PER_TOPIC` (40).

## Tests that hold this in place

- `presence.test.ts`: checkpoint-local hit with no read; `state`/`inFlight` do
  not gate; a record missing either id, a dropped id or an empty id refused; a
  record under another unit refused; a duplicate row key refused; mixed
  local/server returned in **row** order (with the local rows at positions 2 and
  4, so "order found" fails); substring decoys never adopted; missing
  `nextCursor`; page bound; later revision; refusal count greater than the read;
  corroborated partial; two topics cost one traversal each.
- `run.test.ts`: the live incident as a unit whose rows are all in the checkpoint
  (`GET …/questions` count must be 0); adoption through three pages of a crowded
  topic after a preview this checkpoint made; a fresh checkpoint refusing the
  same adoption with `EXISTING_KEYS`; a mixed local/server unit with no preview
  refusing only the server half; a mixed local/server unit adopting when this
  checkpoint previewed the bytes — the licensed half of the same gate; a refusal
  the listing cannot corroborate; `PARTIAL_IMPORT` for a genuinely partial unit;
  a mid-walk `500` counted; a `429` on a walk page that is `RATE_LIMITED` and
  leaves `counters.http5xx` at 0; a mid-walk `2xx` whose body is not JSON, which
  is `PROTOCOL_ERROR` with no status and is not counted; the page bound; the
  sentinel test, which also asserts that the upload manifest was written and that
  a sign-in and a session read really happened, so a
  stem/cookie/CSRF/password/TOTP sentinel is absent from the checkpoint, the
  manifest and the log; and a global pin that no question read ever carries
  `search` and that every one carries `domainId` and `topicId` — the claim is
  that the read is *scoped*, not that the id values are validated.
- `fixtures.ts` `pageOf` plus its fidelity test: 120 questions at `limit: 50` is
  50 + 50 + 20 with a null cursor only on the last page. The old fake ignored
  `limit`, returned every match and hardcoded `nextCursor: null`, which is why
  the defect's tests passed while the defect was live.

## Residual risk worth naming

`previewUnit` interpolates the server-supplied `issue.path` into its error
message, and `rejectedError` joins `path:code` pairs into `info`. That is safe
only because the Worker formats a path as `row.<n>.<column>`; a server that put
content in a path would have that content logged. The driver does not sanitise
it, and this note is the reason nobody should assume it does.

## Not in scope

No migration, no route, no query parameter, no response field, no contract
change. The driver reads existing routes with existing parameters, and the
protection remains where it was: the Worker authorises every request, the driver
gains no capability, and it still speaks only HTTP.
