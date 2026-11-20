# The import driver's presence rule

Status: implemented in `tools/cissp-import-driver/presence.ts`.
This is the design that `docs/cissp-import-driver.md` §Idempotency and resume
refers to. It is recorded here because a design that lives only in a review
thread does not exist.

## The defect it replaces

The driver decides whether a question already exists on the server. It used to
ask `GET …/questions?…&search=<key>&limit=50` once per key and exact-match
`questionKey` on the first page. On a live staging run that read reported
**3 of 5 rows missing when all 5 existed**, so the driver re-sent creates, earned
`409`s, and stopped.

The route's SQL is
`(question_key LIKE '%key%' OR revision.stem LIKE '%key%') ORDER BY question.id
LIMIT ?`. Probing `cissp-12` also matches `cissp-120`, `cissp-112` and any stem
that quotes the key; the driver read only the first page of 50 and never
followed `cursor`. An exact row can sit past the first page, and the answer
"absent" was never sound.

It was not repaired by adding a cursor to the probe. The question the probe asks
— *what does a ranked, substring-filtered, page-windowed result return first?* —
is the wrong question, and paginating it would still cost up to five full walks
per unit and keep correctness hostage to `LIKE` escaping and stem content.

## The rule

**Presence is a checkpoint-local fact wherever the checkpoint can answer it. The
server is consulted only for rows it cannot, and then only through an exhaustive
listing compared by exact key.**

### 1. The checkpoint answers first, with no request

A `questions[]` record whose `questionId` **and** `revisionId` are both non-null
is proof the row exists:

- both ids are written only from a server answer to a preview or a confirm;
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

A record with exactly one of the two ids set is a corrupted checkpoint — no
writer produces it. The run stops with `CHECKPOINT_INVALID` rather than falling
back to the server, because a hand-edited id would otherwise let the driver
adopt a question it never created.

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

A question counts as present only when the key matches **exactly** and its
current revision is **revision 1** — the revision an import of these bytes
creates. A key at a later revision is present but not adoptable: the driver
cannot prove it holds the content its review note claims, so the run stops with
`PRESENCE_UNKNOWN`.

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
| `401`/`403`/`429` mid-walk | `SESSION_LOST` / `RATE_LIMITED`, propagated |
| `5xx` or a malformed body mid-walk | `PROTOCOL_ERROR`, propagated |
| some keys established present, at least one established absent | `PARTIAL_IMPORT` |
| half-set checkpoint record, wrong unit, missing taxonomy id | `CHECKPOINT_INVALID` |

`PARTIAL_IMPORT` and `PRESENCE_UNKNOWN` are different claims and are never
interchanged. `PARTIAL_IMPORT` asserts a fact; `PRESENCE_UNKNOWN` says the read
could not conclude, and nothing is acted on.

`noteStop` already writes the code to `checkpoint.lastError`, so the stop is
visible on disk with no extra plumbing.

## The two call sites

**Ambiguous confirm.** `decideConfirm` does not change: the fix is behind the
observation. `resolveUnitPresence` returns a richer `UnitPresence` and `run.ts`
maps it down to `ConfirmObservation`, so `decide.ts` stays the pure decision
table the acceptance test pins. Only the keys the preview covered decide this
case.

**Preview refused with `existing_question_key`.** When *every* issue is
`existing_question_key`, the server already holds the unit's rows, so the driver
resolves the unit by presence and records it instead of stopping. When the walk
finds fewer keys than the refusal asserted, two server answers disagree and the
run stops with `PRESENCE_UNKNOWN` — that is the live incident, converted from a
silent false "missing" into an honest stop. When it finds some but not all, at
least as many as the refusal asserted, the server really does hold part of the
unit: `PARTIAL_IMPORT`, because the preview is all-or-nothing and nobody can
proceed from half a unit.

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

## Tests that hold this in place

- `presence.test.ts`: checkpoint-local hit with no read; `state`/`inFlight` do
  not gate; half-set record refused; wrong unit refused; mixed local/server in
  row order; substring decoys never adopted; missing `nextCursor`; page bound;
  later revision; refusal count greater than the read; corroborated partial; two
  topics cost one traversal each.
- `run.test.ts`: the live incident as a unit whose rows are all in the checkpoint
  (`GET …/questions` count must be 0); adoption through three pages of a crowded
  topic; a refusal the listing cannot corroborate; `PARTIAL_IMPORT` for a
  genuinely partial unit; a mid-walk `500`; the page bound; and a global pin that
  no question read ever carries `search`.
- `fixtures.ts` `pageOf` plus its fidelity test: 120 questions at `limit: 50` is
  50 + 50 + 20 with a null cursor only on the last page. The old fake ignored
  `limit`, returned every match and hardcoded `nextCursor: null`, which is why
  the defect's tests passed while the defect was live.

## Not in scope

No migration, no route, no query parameter, no response field, no contract
change. The driver reads existing routes with existing parameters, and the
protection remains where it was: the Worker authorises every request, the driver
gains no capability, and it still speaks only HTTP.
