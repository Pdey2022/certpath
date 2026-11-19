# CISSP bank import: the import driver

Status: Phase 3 design, submitted for owner approval. This slice adds one
build-time tool (`tools/cissp-import-driver/`) and this document. It adds **no**
migration, schema change, HTTP route, Worker code, contract schema, seed or
deployment, and it writes to **no** deployed database. Every run described here
targets a loopback origin. Running the driver against any non-local database is
a separate owner approval and is not part of this slice.

It extends `docs/cissp-bank-import.md` (Phase 2, owner-approved): that document
produces 463 rows in 47 batches outside the repository; this one gets those rows
into the platform through the existing protected import API.

## What this slice delivers

A single TypeScript entry point, invoked with `tsx`, that takes the converter's
output directory, the approved taxonomy, and an owner-supplied prose file, and
performs five stages against the protected staff API:

| Stage | Name | Effect |
|---|---|---|
| 0 | validate | Reads every input and every CSV row. No network. Exits non-zero on any defect. |
| 1 | taxonomy | Creates (or adopts, by natural key) the certification, exam version, 8 domains and 36 topics. |
| 2 | transform | Rewrites `exam_version_id`, `domain_id`, `topic_id` with server ids and re-chunks into upload units. Writes only outside the repository. |
| 3 | upload | For each unit: preview → confirm. Draft rows only. |
| 4 | publish | For each question: submit → review (approved) → publish, in smallest-domain-first order. |
| 5 | verify | Reads back the published set through the export route and asserts the count. |

Each stage refuses to start unless the previous one is `complete` in the
checkpoint. Every stage is resumable.

## Scope

**In scope:** the driver, its unit tests, its wiring into `npm test` /
`npm run typecheck`, and a local proof against the synthetic exam.

**Explicitly not in this slice**, and refused rather than absorbed:

- No migration, no table, no column, no trigger, no index. The driver is a
  client of existing storage guarantees, not an author of new ones.
- No new HTTP route and no change to `packages/contracts/src/protected-content.ts`.
  If a future need appears (for example a bulk status read), it lands in the
  contracts package and gets its own review; the driver must not grow a private
  contract.
- No change to the 10-row / 256 KiB import contract, the preview TTL, the
  self-review exception, the readiness formula, difficulty, or anything
  learner-facing.
- No authoring of taxonomy prose. The 46 prose strings are owner-supplied; ARC
  and DEV supply none of them.
- No fix to the `author != reviewer` guarantee (see *Honest limitations*), and
  no amendment to `docs/delivery-plan.md` in this slice.
- No run against staging or production, no deployment, no provisioning, no
  secret creation.
- No repair path for an immutable resource. If a taxonomy value is wrong, the
  answer is a new exam version, not an update.

## Decision

The driver is a **build-time Node/TypeScript client of the existing protected
staff API**, living in `tools/cissp-import-driver/`, run explicitly by the
operator with `tsx`, holding one staff session in memory for the length of a
stage. It never touches D1 directly, never re-implements a validator, and never
creates a privileged path: it creates taxonomy in natural-key order, rewrites
the converter's three id columns with the ids the server minted, pushes each
unit through preview → confirm immediately, and then walks every confirmed
revision through submit → review → publish one question at a time, checkpointing
intent before each call and outcome after it so an interrupted run resumes
without a duplicate and without a silent hole.

## Why a build-time tool and not a Worker route

A Worker route that performs bulk import would have to either (a) call the
existing routes over HTTP from inside the Worker, paying two invocations per
row and needing a second session, or (b) reimplement the preview/confirm
services behind a new privileged endpoint — a new authorization surface, a new
request schema, and a header size limit that a 463-row payload exceeds. It would
also add a capability nobody asked for to the admin surface, which is the one
surface this project keeps deliberately small. The driver is a one-operator,
one-shot, auditable job; a shell-invoked tool is the smallest thing that does it
and leaves the production attack surface unchanged.

The driver is TypeScript on Node ≥22 run with `tsx` (already a root dev
dependency), uses the platform `fetch`, and reuses `csv-parse` 7.0.3 — the same
pinned parser the server validates with — for the rewrite, so CSV quoting parity
is not a guess. Tests use `node:test` via `tsx --test`, matching
`tools/cissp-convert/cli.test.ts`.

## Stage 0 — validate, before any network call

The driver validates every input first, so a broken file costs zero requests:

- **Prose file** — schema, exact key set, every value non-blank and in range,
  `taxonomySha256` matching the taxonomy file it will be used with (see
  *The prose file*).
- **Taxonomy** — `certpath-cissp-taxonomy-v1`, 8 domains, 36 topics, ids
  unique, topic ids namespaced with their domain.
- **Converter output** — `manifest.json` format version; every file listed in
  it is present; each file's SHA-256 matches its manifest entry; the sum of
  `rows` equals parsed rows.
- **Every CSV row** — exact 41-column header, byte-equal to the driver's own
  copy of `QUESTION_IMPORT_TEMPLATE_COLUMNS` (parity asserted by a test against
  `apps/api/src/security/question-imports.ts`); `format_version` is
  `certpath-question-v1`; `question_key` matches `^cissp-[1-9][0-9]*$` and is
  unique across **all** batches; `difficulty` in `{easy,medium,hard}`; exactly
  four non-empty option groups and options 5–8 empty; exactly one
  `option_N_correct` is `true`; stem/option/explanation/source/licence lengths
  inside the documented caps; `exam_version_id`, `domain_id`, `topic_id`
  non-empty and present in the taxonomy.
- **Cross-checks** — rows per taxonomy topic versus
  `taxonomy-report.json`'s `writtenQuestions`; a mismatch is fatal
  (`TAXONOMY_REPORT_MISMATCH`).

Stage 0 writes nothing and calls nothing. `--dry-run` stops here and prints the
counts, which is the command the owner uses to review the inputs.

## Stage 1 — taxonomy, idempotent by natural key

Order: certification → exam version → 8 domains (taxonomy array order) →
36 topics (per-domain order). Natural keys, all server-enforced unique:

| Resource | Natural key | Unique constraint | Recovery read |
|---|---|---|---|
| certification | `slug` (and `id`) | `certifications.slug` unique, `id` PK | `GET /certifications` |
| exam version | `(certification, version_key)` | `UNIQUE (certification_id, version_key)` | `GET .../exam-versions` |
| domain | `(exam_version, domain_key)` | `UNIQUE (exam_version_id, domain_key)` | `GET .../domains` |
| topic | `(domain, topic_key)` | `UNIQUE (domain_id, topic_key)` | `GET .../topics` |

`domain_key` is the taxonomy domain id (`cissp-d1`); `topic_key` is the
taxonomy topic id (`cissp-d1-risk-management`). Using the ids rather than
inventing slugs means the CSV's taxonomy values join directly to server rows by
key, and the approved `slug` (`general`) is preserved only where the taxonomy
writer chose it. Titles come from `taxonomy.json`; meanings come from the owner's
prose file; `order` is the taxonomy index. Nothing is defaulted.

**Create or adopt.** For each resource: read the parent's collection; if a row
with the natural key exists, adopt its id and record `adopted: true`; if not,
POST once. A `409` is treated as "someone created it between my read and my
write" — one recovery read, adopt, continue. A `409` with no matching natural
key is fatal (`KEY_COLLISION`), because it means an id or operation collision
the driver does not understand.

**Immutability discipline.** Exam versions, domains and topics cannot be
updated (`exam_versions_no_update`, `domains_no_update`, `topics_no_update`
raise `ABORT`). So on adoption of a domain or topic the driver compares the
stored `title`, `order` — and, for topics, the parent domain — against the
taxonomy and stops with `TAXONOMY_PROSE_MISMATCH` on any difference, because a
key that exists with different prose means the CSV would attach questions to a
taxonomy that is not the approved one, permanently. The certification root and
exam version are **not** prose-compared on adoption: they are identities the
operator names, they may have been created by the provisioning script or an
earlier approved run, and the driver can neither read a certification's
`displayName` back from the list route in a way that proves anything nor ever
change it. The driver prints and checkpoints the adopted title so the operator
sees what it joined. That residual risk is stated in *Honest limitations*.

Creating a certification root is a Global-Admin, platform-wide act (ADR 0004).
The driver reads the actor's role from `GET /api/admin/auth/session` first and
refuses with `CERTIFICATION_CREATE_FORBIDDEN` rather than discovering it as a
403 halfway through.

## Stage 2 — transform, outside the repository

Inputs: the converter's `batch-NNN.csv` files (read-only), the checkpoint's
taxonomy id map, `--batch-size` (default 5, allowed 1–10).

The driver parses each file with `csv-parse`, concatenates the rows **in
converter order** (`batch-001` … `batch-047`, rows in file order), replaces
exactly three cells per row — index 2 `exam_version_id`, index 3 `domain_id`,
index 4 `topic_id` — with the server ids from the checkpoint, re-serialises every
cell with the same quoting rule the converter uses, and re-chunks into
`upload-NNN.csv` of at most `--batch-size` rows.

Every byte outside those three cells must survive. That is an acceptance test,
not an aspiration: a fixture containing embedded commas, doubled quotes, CRLF
inside a cell, and a value ending in a quote is round-tripped and compared cell
by cell.

The converter's own `--exam-version-id` value is a **label, not the server id**.
Phase 2 wrote `cissp-exam-v1`; the server mints a UUID. The driver therefore
overwrites that cell too, and records the converter's declared value in the
checkpoint so the two can never be confused in an audit.

Outputs, all in the state directory (outside the repository, and the driver
refuses a path that resolves inside it):

- `upload-NNN.csv`
- `upload-manifest.json` — `certpath-cissp-upload-manifest-v1`: batch size,
  unit count, per unit `{file, rows, firstKey, lastKey, sha256}`, and the
  sha256 of the converter manifest it was derived from.

The converter's output directory is never written to.

## Stage 3 — upload

Per unit, in order, with no other work in between:

1. Checkpoint `unit.state = "previewing"`, persist, then
   `POST /api/admin/content/certifications/:cid/exam-versions/:vid/import-previews`
   with `Content-Type: text/csv; charset=utf-8`, the exact `Origin`, and
   `X-CSRF-Token`.
2. A `201` records `importId`, `expiresAt`, and the returned `summary`. The
   driver asserts `summary.validRows === rows` and `invalidRows === 0`; anything
   else stops the run and prints the row/column issue list (codes only).
3. Checkpoint `unit.state = "previewed"` with `importId`, then
   `POST /api/admin/content/certifications/:cid/import-previews/:importId/confirm`
   with `{}`. The body is empty by contract; the driver never sends rows.
4. On `200`, store `questionIds`, `revisionIds`, `questionKeys` positionally
   (the server returns them in `row_number` order) and mark the unit `confirmed`.
5. Immediately before confirm, the driver refuses to proceed if
   `Date.now() > expiresAt - 60_000` and re-previews instead. In practice the
   gap is under a second; the margin exists so clock skew can never turn a
   healthy preview into an expired one.

No unit is ever "skipped". A failure stops the run.

## Stage 4 — review and publish

The self-review pilot exception is owner-approved in
`docs/cissp-bank-import.md`. Under it, the owner authors and the owner reviews.

For each question, in **smallest-domain-first** order (computed from the
transformed rows, not hardcoded), the driver performs one chain:
`submit` → `review{decision:"approved", notes}` → `publish{revisionId,
expectedPointerVersion: null}`. Each transition is checkpointed as
`in-flight` before the call and as its new state after it.

The review note is a fixed string, identical for every question:

```
Owner self-review under the pilot exception in docs/cissp-bank-import.md:
owner-authored source, converted by tools/cissp-convert and imported verbatim
through the protected import API. Recorded by driver run <runId>, unit <n>.
```

It is factual about the mechanism and points at the record; it does not claim
an item-by-item read that did not happen. The exact wording is an audit
statement and therefore needs the owner's explicit approval before stage 4 runs
against real content (see the reply's escalation).

**Ordering.** Domain order is ascending by the number of rows actually in that
domain, ties broken by taxonomy domain id, then `question_key` numeric order
inside a domain. For the current 463 rows the derived order is approximately
D7 (20), D3 (25), D6 (32), D5 (35), D8 (42), D2 (54), D4 (65), D1 (211). The
point is not that work is saved — every completed question is checkpointed — but
that the entire four-step chain, including the publish pointer and the export
read, is proven on a small domain before 443 more questions depend on it.

**Partial failure.** If a submit/review/publish call fails part way:

- `409` — re-read the revision (`workflowState`) and the publication pointer,
  decide again from the observed state, and act once more. A second `409` stops
  the run with `WORKFLOW_CONFLICT` rather than looping.
- `5xx` / timeout / abort — re-read state, then act if the transition did not
  land. One such recovery per question, then stop the run.
- `401`/`403` — the session or its assurance is gone. Stop immediately; do not
  re-authenticate inside a loop (see *Security*).
- Any observation of a publication whose `revisionId` is not ours — stop with
  `PUBLICATION_CONFLICT`. The driver never replaces a live publication.

## Stage 5 — verify

`GET /api/admin/content/certifications/:cid/exam-versions/:vid/export?limit=100`,
following `X-Export-Next-Cursor` until absent, counting data rows (excluding the
header). The run succeeds only when the count equals the number of questions the
driver confirmed **and** every key in the checkpoint appears exactly once. The
export is read-only and is never written to the repository.

## Data changes

**None.** No migration number, no table, no column, no constraint, no trigger,
no index, no seed.

The driver is written against invariants that already exist at the storage
layer, and the failure mode if the driver's code is wrong is deliberately
expensive in one direction and impossible in the other:

| Invariant | Enforced by | If the driver is wrong |
|---|---|---|
| Certification roots never change | `certifications_no_update`, `certifications_no_delete` | A wrong `displayName` or slug is permanent. Hence: owner-supplied, validated, and created only with an explicit flag. |
| Exam version, domain, topic identity and prose never change | `exam_versions_no_update`, `domains_no_update`, `topics_no_update` | A wrong title or meaning is permanent; a topology error costs a new exam version. Hence: no defaults, and adoption compares prose for domains/topics. |
| Taxonomy keys unique per parent | `UNIQUE (exam_version_id, domain_key)`, `UNIQUE (domain_id, topic_key)` | A duplicate create is a zero-row guarded insert → `conflict`, never a second row. |
| Import creates only sealed drafts | `prepareImportedQuestionDraft`, seal triggers, `question_revision_seal_complete` | Nothing can be published by the import path; `publishQuestionRevision` requires the last event to be `approved`. |
| One question identity per key per certification | `UNIQUE (certification_id, question_key)`, `ON CONFLICT DO NOTHING` | A replayed confirm cannot duplicate; a re-import of the same key is rejected at preview with `existing_question_key`. |
| Workflow transitions are ordered | `question_revision_workflow` trigger, `only a sealed submitted revision can be reviewed`, `only the exact approved revision can be published` | Out-of-order calls return `conflict`; they cannot corrupt state. |
| Reviews and events are append-only | `content_reviews_*append-only*`, `question_revision_events` append-only triggers | A wrong approval cannot be edited away; it must be superseded by a new revision. |

## Interface

### CLI

```powershell
tsx tools/cissp-import-driver/cli.ts `
  --origin http://localhost:5173 `
  --batches "$env:TEMP\cissp-import" `
  --taxonomy tools/cissp-convert/taxonomy.json `
  --prose "$env:TEMP\cissp-prose.json" `
  --state "$env:TEMP\cissp-run" `
  --email owner@example.test `
  --stage taxonomy|transform|upload|publish|verify|all `
  [--certification-slug cissp] [--version-key cissp-exam-v1] `
  [--create-certification] `
  [--batch-size 5] [--unit-limit N] `
  [--dry-run] [--allow-remote --remote-confirm <exact origin>]
```

- `--state` must resolve outside the repository and be either absent or hold a
  checkpoint whose target and input digests match this invocation.
- `--origin` must be loopback (`localhost`, `127.0.0.1`, `[::1]`). A non-loopback
  origin requires **both** `--allow-remote` and `--remote-confirm <origin>`
  equal to `--origin`; that combination is refused unless the owner approval
  issue id is also supplied via `--approval <issue>`.
- `--password` is rejected outright (`PASSWORD_ON_ARGV`). The password and the
  TOTP code are read from the terminal with echo off. Neither is accepted from
  an environment variable, because environment blocks are inherited by child
  processes and often captured.
- `--unit-limit` exists for the local proof; it refuses to skip units, only to
  stop after N.

### The prose file

JSON, one file, outside the repository, `certpath-cissp-taxonomy-prose-v1`. It
carries **exactly 46 owner-supplied strings**: the exam-version title and
syllabus reference, and 44 meanings. Titles for the 8 domains and 36 topics come
from the already-approved `tools/cissp-convert/taxonomy.json` — they are not
re-typed, so they cannot drift. Identity values are separate and also required.

```json
{
  "formatVersion": "certpath-cissp-taxonomy-prose-v1",
  "taxonomySha256": "<sha256 of tools/cissp-convert/taxonomy.json>",
  "certification": { "id": "cissp", "slug": "cissp", "displayName": "…" },
  "examVersion": {
    "versionKey": "cissp-exam-v1",
    "title": "…",
    "syllabusReference": "…"
  },
  "domains": { "cissp-d1": { "meaning": "…" }, "…": { "meaning": "…" } },
  "topics":  { "cissp-d1-risk-management": { "meaning": "…" }, "…": {} }
}
```

Validation, all before any request:

- exact top-level and nested key sets (unknown key → `PROSE_UNKNOWN_KEY`);
- `taxonomySha256` equals the digest of the taxonomy file actually passed;
- `certification.id` `^[a-zA-Z0-9:_-]{1,128}$`; `slug`
  `^[a-z0-9]+(?:-[a-z0-9]+)*$`; `displayName` non-blank ≤160;
- `versionKey` `^[a-zA-Z0-9][a-zA-Z0-9._:-]*$` ≤80; `title` ≤160;
  `syllabusReference` ≤500;
- exactly the 8 domain ids and exactly the 36 topic ids from the taxonomy, no
  extras, no duplicates, every topic under its own domain;
- every meaning, after trimming, 1–2000 characters, no C0 control characters
  other than `\n`;
- any missing, extra, blank or over-cap value is fatal with a named code and
  **zero** HTTP requests made.

The driver never generates, defaults or fills a meaning. A `general` topic gets
an owner-written meaning like any other; "General" is not treated as permission
to skip prose.

### The checkpoint

One JSON file, `checkpoint.json` in `--state`, replaced atomically (`.tmp` +
rename) so a crash leaves either the previous or the next version. It records,
and only records:

```json
{
  "formatVersion": "certpath-cissp-import-checkpoint-v1",
  "runId": "…", "createdAt": 0, "updatedAt": 0,
  "target": { "origin": "…", "actorUserId": "…",
              "certificationId": "…", "certificationSlug": "…",
              "examVersionKey": "…", "examVersionId": "…" },
  "inputs": { "taxonomySha256": "…", "proseSha256": "…",
              "converterManifestSha256": "…", "uploadManifestSha256": "…",
              "batchSize": 5, "converterDeclaredExamVersionId": "cissp-exam-v1" },
  "stages": { "taxonomy": "pending|in-progress|complete", "transform": "…",
              "upload": "…", "publish": "…", "verify": "…" },
  "taxonomy": {
    "certification": { "id": "…", "created": false },
    "examVersion":   { "id": "…", "created": false },
    "domains": [ { "key": "cissp-d1", "serverId": "…", "order": 0 } ],
    "topics":  [ { "key": "cissp-d1-risk-management", "serverId": "…",
                   "domainKey": "cissp-d1", "order": 0 } ]
  },
  "units": [ { "unit": 1, "file": "upload-001.csv", "sha256": "…", "rows": 5,
               "state": "pending|previewed|confirmed",
               "importId": null, "expiresAt": null } ],
  "questions": [ { "key": "cissp-1", "unit": 1,
                   "domainKey": "cissp-d1", "topicKey": "cissp-d1-risk-management",
                   "questionId": null, "revisionId": null,
                   "state": "pending|draft|submitted|approved|published",
                   "pointerVersion": null } ],
  "counters": { "requests": 0, "http5xx": 0, "conflicts": 0, "recoveries": 0 },
  "lastError": null
}
```

It never contains: a cookie, a CSRF token, a password, a TOTP code or seed, a
recovery code, a stem, an option, an explanation, an answer key, or question
text. `lastError` holds a code, an HTTP status and the server's `requestId`
only.

### API calls

All under `/api/admin`, session cookie only, `Origin` on every mutation,
`X-CSRF-Token` on every mutation. `null` means exactly what the contract says.

| Call | Body the driver sends | Success | Fields read |
|---|---|---|---|
| `GET /auth/session` | — | 200 | `userId`, `role`, `certifications[]` |
| `GET /csrf` | — | 200 | `csrfToken` |
| `GET /content/certifications?limit=50` | — | 200 | `items[].{id,slug,displayName}`, `nextCursor` (paginate until `null`) |
| `POST /content/certifications` | `{id,slug,displayName}` | 201 `{id}` | `id`; 409 → recovery read |
| `GET /content/certifications/:cid/exam-versions?limit=50` | — | 200 | `items[].{id,versionKey,title}`, `nextCursor` |
| `POST …/exam-versions` | `{versionKey,title,syllabusReference}` (`effectiveFrom`/`effectiveUntil` omitted, i.e. `NULL`) | 201 `{id}` | `id`; 409 → recovery |
| `GET …/domains?limit=50` | — | 200 | `items[].{id,domainKey,title,order}` |
| `POST …/domains` | `{domainKey,title,meaning,order}` | 201 `{id}` | `id`; 409 → recovery + prose compare |
| `GET …/domains/:did/topics?limit=50` | — | 200 | `items[].{id,topicKey,title,order}` |
| `POST …/domains/:did/topics` | `{topicKey,title,meaning,order}` | 201 `{id}` | `id`; 409 → recovery + prose compare |
| `POST …/import-previews` | `text/csv` body ≤256 KiB | 201 `{importId,formatVersion,expiresAt,summary{parsedRows,validRows,invalidRows}}` | all; `400` carries `error.issues[].{path,code}` and `error.summary` |
| `POST /content/certifications/:cid/import-previews/:importId/confirm` | `{}` | 200 `{importId,questionIds[],revisionIds[],questionKeys[]}` | arrays, positional |
| `GET …/questions?domainId&topicId&search&limit=50` | — | 200 | `items[].{id,questionKey,currentRevisionId,revisionNumber,lockVersion,workflowState}`; driver reads **only** these five fields and never prints `stem` |
| `GET …/questions/:qid/revisions/:rid` | — | 200 | `workflowState` only |
| `POST …/revisions/:rid/submit` | `{}` | 200 `{revisionId}` | — |
| `POST …/revisions/:rid/review` | `{decision:"approved",notes}` | 201 `{reviewId}` | — |
| `GET …/questions/:qid/publication` | — | 200 | `publication` — `null` when never published, else `{revisionId,state,pointerVersion,changedAt}` |
| `POST …/questions/:qid/publish` | `{revisionId,expectedPointerVersion:null}` | 200 `{pointerVersion}` | — |
| `GET …/export?limit=100[&cursor=…]` | — | 200 `text/csv` | `X-Export-Next-Cursor` (absent on the last page) |

No request carries a client-supplied actor, operation id or timestamp. There is
no contract change in this slice; if one is ever needed it goes to
`packages/contracts/src/protected-content.ts` first.

## Security

**Who may call.** The certification root requires Global Admin; everything else
requires Global Admin or an assigned Manager, plus staff MFA assurance. The
driver does not add a role, a bypass or a second actor. It refuses to run if the
signed-in account's role cannot perform the stage.

**Where authorization happens.** Entirely in the Worker and in the guarded D1
writes, exactly as for a browser. The driver's checks are conveniences that fail
early with a clear code; they are not the guarantee. The driver holds no
capability the browser lacks.

**The D1/Worker boundary.** The driver is an HTTP client. It does not import
`apps/api`, does not open a database handle, does not call `wrangler d1
execute`, and does not use a service binding. Its only write path is the
documented routes.

**Session handling.** One sign-in, one TOTP verification, one CSRF token, held
in memory for the process lifetime. The cookie value is never written to disk,
printed, or included in an error message; the driver redacts `Cookie`,
`X-CSRF-Token`, `Set-Cookie` and the response body of any auth call from its
log. The 8-hour assurance window (`STAFF_MFA_MAX_AGE_MS=28800000` locally) is
far longer than a 12–25 minute run, so a single sign-in covers a run.

**No auth retry loop.** Sign-in is limited to 5 attempts per 15 minutes per
account and TOTP verification to 5 per 15 minutes per account. A driver that
retried auth would lock the owner out of their own admin panel. Therefore: at
most **one** re-authentication attempt per process, performed interactively; if
the session or its assurance is gone, the run **stops**, prints the reason, and
the operator resumes with a fresh command. A `429` anywhere stops the run
immediately with `RATE_LIMITED`; 5xx is never masked by a retry storm.

**Actor stability.** A confirm is bound to the preview's `actor_user_id`. The
checkpoint records `target.actorUserId`; if a later stage authenticates as a
different user, the driver stops with `ACTOR_CHANGED` rather than producing
previews that can never be confirmed.

**What is logged.** Stage, unit number, question key, HTTP status, server
`requestId`, and error codes. **Never**: credentials, cookie or CSRF values,
question text, options, explanations, provenance prose, or a full response body.

## Idempotency and resume

`question_key` (`cissp-<id>`) is the only stable handle across a preview, a
confirm, a lost response and a fresh process. It is the join key between the
CSV row, the server's `UNIQUE (certification_id, question_key)`, and the
reconciliation read.

**The rule.** The checkpoint records the *intent* before a call and the
*outcome* after it. A crash therefore leaves at most one unit in `previewed` or
one question in a transitional state — never a silent gap.

**Ambiguous confirm.** A confirm "may or may not have committed" on timeout,
abort, or `5xx`. Resolution never guesses; it reads.

1. Re-read the preview's questions by key: for each key, one
   `GET …/questions?domainId=<row domain>&topicId=<row topic>&search=<key>` and
   an **exact** `questionKey` match in the returned items (the route's `search`
   is `LIKE`, so `cissp-12` also matches `cissp-120`; the driver filters).
2. Decide:

| Observed | Action |
|---|---|
| all N keys present, `revisionNumber = 1` | adopted: record `questionId`/`currentRevisionId`, unit `confirmed` |
| some keys present | **stop** with `PARTIAL_IMPORT` (should be impossible: confirm is one D1 batch) |
| none present, preview not expired | retry the same `importId` once (confirm is idempotent by id) |
| none present, preview expired | re-preview the same bytes (new `importId`), then confirm |
| `401`/`403`/`429` | stop; no retry |

3. A retry of an **already committed** confirm returns `200` with the
   established ids from `question_import_results` — that is the normal, benign
   path, and it is why the confirm body is only an id.
4. The same protocol covers a submit/review/publish whose response was lost:
   re-read `workflowState` and the publication pointer, then either act or
   record the observed state.

**Decay.** A preview lives 10 minutes; its payload rows are cleared on
confirmation and on expiry, and its content is gone after that. The driver
therefore never holds a preview across stages: preview and confirm are adjacent
calls in the same unit.

**Replay.** Re-running stage 3 after a complete run finds every key present at
preview time and stops with `EXISTING_KEYS` rather than silently doing nothing;
the operator is told the stage is already done by the checkpoint, and a fresh
checkpoint is refused unless the operator explicitly starts a new run against a
new exam version.

**Resume.** Stage 1 re-runs as pure reads plus skips. Stage 2 is a file
transform and is recomputed idempotently from the converter output. Stage 3
resumes at the first unit not `confirmed`. Stage 4 resumes at the first question
not `published`, re-reading that question's state once before acting.

## The Workers Free budget and the stage-3 batch size

The published Free limits are 50 D1 queries per Worker invocation and 10 ms CPU
per request. One correction to the framing this design inherited: a
`db.batch()` call **counts as one query** against the 50-query limit, not one
per statement (D1 limits page, checked 2026-11-18). So a 10-row confirm is ~10
queries, not 53, and the opportunistic cleanup adds 2 queries regardless of
backlog. What the 10-row cap actually approaches is not the query cap but the
**unmeasured** CPU budget, which this repository has never established (see
`docs/delivery-plan.md`: "Worker CPU still unmeasured").

Counted per invocation against the current code:

| Endpoint | Rows | D1 queries | Statements in the batch |
|---|---:|---:|---:|
| `import-previews` | 5 | 21 | 7 |
| `import-previews` | 10 | 31 | 12 |
| `confirm` | 5 | 10 | 28 |
| `confirm` | 10 | 10 | 53 |
| `submit` | 1 | 9 | 1 |
| `review` | 1 | 9 | 1 |
| `publish` | 1 | 9 | 1 |

The preview's cost is dominated by two per-row existence checks (taxonomy pair,
then `question_key`), and the confirm's by 40 trigger-assisted statements plus
JSON parsing and sealing of 10 revisions. Neither breaches 50; both scale with
the row count per request.

**Decision: stage-3 batch size is 5.** The 10-row cap is the contract's ceiling
and stays untouched — the driver simply asks for less per request than the
contract allows. Reasons, in order of weight:

1. **Per-request cost is the limit that binds.** The Free plan's per-request CPU
   is the only budget this project has never measured, and the confirm endpoint
   is the heaviest write in the system. Five rows halves the peak per-request
   work (28 batch statements instead of 53, half the parsing and sealing) at the
   cost of 93 units instead of 47. On a limit expressed per request, halving the
   request is the mitigation.
2. **Independent, verifiable units.** 93 units of 5 give 93 checkpoint
   boundaries and a natural canary: the first unit proves the whole path before
   458 questions depend on it.
3. **Cheap ambiguity.** A lost confirm response costs 5 reconciliation lookups
   instead of 10.
4. **Negligible overhead.** 186 upload requests instead of 94, against a 100,000
   request/day allowance (0.19% of a day's budget).

`--batch-size` stays configurable in 1–10. Raising the default to 10 for a real
run requires the local proof's measured per-request durations at 5 and 10 in the
PR, and an owner decision — not an ARCH guess. A batch size above 10 is refused,
because that would exceed the import contract rather than work within it.

**Detecting a 5xx or an over-quota response.** The Worker answers a runtime
failure with `503 {"error":{"code":"service_unavailable","requestId":"…"}}`
(the protected router's `onError`), and it does not, and must not, distinguish
"over quota" from "D1 failed". The driver therefore:

- never treats any non-2xx as success, and never advances the unit's state;
- records the status, `code` and `requestId` so the operator can find the
  invocation, and increments `counters.http5xx`;
- reconciles by key **before** any retry, so a row is never lost and never
  duplicated;
- retries a given operation at most once, and stops the whole run after two
  consecutive failures (`CONSECUTIVE_FAILURES`) rather than grinding through 93
  units against a broken dependency;
- stops immediately on `413`, `429`, `401`, `403`, `404`, `400`.

No row is ever dropped silently: a unit's rows are either all confirmed
(atomically, by the existing batch) or the run stops and the checkpoint says
exactly where.

## Review and publish under the self-review exception

The owner authored the source and is the only reviewer; that exception is
documented in `docs/cissp-bank-import.md`. The driver mechanises it, and the
mechanisation is honest about itself:

- every review row is written by the owner's own authenticated account, through
  the same route a human reviewer uses, with a note that names the exception and
  the driver run;
- the driver only ever approves. It never rejects: a question that cannot pass
  the workflow triggers stops the run, because a bulk `rejected` decision would
  be a silent content drop disguised as editorial judgement;
- reviewer and publisher identities are recorded separately by the schema, as
  they already are for browser-driven work;
- no question is published without a stored `approved` review, because
  `publishQuestionRevision` and the `only the exact approved revision can be
  published` trigger both require it.

## What the driver must never do

1. Never touch D1 directly — no `wrangler d1`, no SQL, no service binding, no
   export/import of the database file.
2. Never put a secret in git, a log, a manifest or the checkpoint: no password,
   TOTP seed or code, recovery code, session cookie or CSRF token.
3. Never bypass the import validators — no bulk question creation by looping
   `POST …/questions`, no client-side "validation" trusted instead of the
   server's, no 11-row upload to "save a round trip".
4. Never invent taxonomy prose, titles, meanings, order values or ids; never
   default a missing meaning.
5. Never write to a non-loopback origin without the two explicit flags plus a
   recorded owner approval — and never as part of this slice.
6. Never update, repair or delete an immutable resource; never retire a
   question.
7. Never replace an existing publication, and never publish a revision that is
   not ours.
8. Never retry `401`, `403` or `429`, and never loop on sign-in.
9. Never continue past a failed unit or question, and never mark a failed call
   as done.
10. Never write inside the repository, and never read learner data or the
    learner routes.

## Honest limitations

- **This is a pipeline, not an editorial review.** The driver writes 463
  `approved` records. Those records attest that the owner approved the bank for
  the pilot under a documented exception; they do not attest an item-by-item
  read. Anything that consumes `content_reviews` as evidence of careful reading
  would be over-reading it.
- **ADR 0006 and `docs/delivery-plan.md` overstate a guarantee.** ADR 0006 states
  "Author != reviewer is enforced in the database, not only the UI", and
  `docs/delivery-plan.md` repeats it. There is no such constraint in
  `0003_versioned_content.sql` or any later migration: `content_reviews` records
  a `reviewer_user_id` but nothing compares it with `question_revisions.
  authored_by_user_id`. The database does not stop an author from approving
  their own revision. This slice records the gap and does **not** close it — a
  migration with a trigger is its own review, and the pilot exception is the
  owner's decision in the meantime.
- **Adopted roots are not prose-checked.** If a certification or exam version
  with the target key already exists with a different title, the driver joins it
  and says so; it cannot change it and does not refuse. Domains and topics
  *are* prose-checked, which is where the CSV actually attaches content.
- **No rollback.** Published questions can be retired, not deleted; taxonomy
  cannot be edited. A wrong run against a real database is repaired by a new
  exam version, not by an undo.
- **Nothing here proves Free-plan CPU.** Every measurement in this slice is a
  loopback measurement. The per-request CPU question stays open until a
  deployment, which is out of scope.
- **Staging cannot run this today**: `0023` is not applied and its staff
  configuration is absent, so `/admin` answers 503 there.
- **Resume across a long gap needs the operator.** Assurance expires after 8
  hours and the driver will not re-authenticate itself more than once.
- **The 21 rejected items stay out, and 171 questions carry no subtopic.** Both
  are phase-2 facts, unchanged here; they are not "fixed" by importing faster.
- **The certification `displayName` is a public product string** the driver
  writes once and can never change. Naming and any affiliation claim are an
  owner/legal decision, not an architect's.

## Acceptance criteria

1. `npm run verify` passes, including the driver's type check and unit tests,
   with the command and its counts reported.
2. A CSV fixture with embedded commas, doubled quotes, CRLF and a
   quote-terminated cell round-trips through stage 2 with every byte outside
   columns 3–5 identical, and columns 3–5 replaced by the supplied ids.
3. A second `--stage taxonomy` run creates nothing, reports 0 creates and 46
   adoptions, and makes no POST request.
4. Against the local synthetic exam (`synthetic-pilot`, version `v1`), a run of
   `--unit-limit 2` confirms 10 questions, publishes 10, and `--stage verify`
   reads back exactly 10 published rows with no `X-Export-Next-Cursor` on the
   last page.
5. Killing the driver between preview and confirm, then re-running, produces
   exactly 10 questions — no duplicates, no missing keys — and the checkpoint
   shows one reconciliation.
6. No file written by the driver (checkpoint, manifest, log) contains any of the
   sentinel secrets the test injects.
7. The driver makes zero HTTP requests when any prose value is missing or blank.
8. The driver refuses a non-loopback origin without both remote flags.
9. A confirm `500` followed by a reconciliation that finds some-but-not-all keys
   stops the run with `PARTIAL_IMPORT`; it never records the unit as confirmed.
10. Domain publish order is computed and equals smallest-first for the supplied
    data; an existing publication for a different revision stops the run.
11. `git status` after a full local run shows only the intended source and docs
    changes: no generated file, no CSV, no checkpoint, no secret.

## Test plan

**Unit tests, no network** (`tools/cissp-import-driver/*.test.ts`, run by
`tsx --test`):

- Contract parity: driver column list equals
  `QUESTION_IMPORT_TEMPLATE_COLUMNS` imported from
  `apps/api/src/security/question-imports.ts`; `MAX_ROWS` 10; `MAX_BYTES`
  256 KiB; TTL 600 000 ms.
- Transform: 47→93 units at size 5 (last unit 3 rows); order preserved; byte
  preservation fixture; refusal cases — missing column, reordered header, two
  correct answers, zero correct answers, five options, unknown taxonomy id,
  duplicate key across files, 11 rows in one input file, BOM, non-UTF-8.
- Re-chunking bounds: 1 and 10 accepted, 0 and 11 rejected, 10 reproduces the
  converter's 47.
- Prose validation: missing file, blank meaning, 35/37 topics, unknown topic,
  2001-character meaning, taxonomy digest mismatch, unknown key, invalid
  certification id.
- URL and body construction as pure functions: exact path per id; exact JSON
  field set (deep equal, no extras); CSV request headers.
- Checkpoint state machine: legal and illegal transitions; refusing to skip a
  stage; refusing a checkpoint whose origin, target or input digests differ;
  atomic replace leaves the previous file when serialisation throws.
- Ambiguous-confirm decision table: `200`; `409` + all keys; `409` + none +
  unexpired; `409` + none + expired → re-preview; `500` + all keys; `500` +
  none + unexpired → one retry then stop; partial keys → `PARTIAL_IMPORT`;
  `401`/`429` → stop, no retry.
- Publish decision table: `draft`/`submitted`/`approved` × publication
  `null`/ours/other-revision.
- Secret hygiene: sentinel cookie, password and TOTP values; assert absence from
  every written artefact; assert `--password` is rejected.
- Origin policy: loopback accepted; remote rejected without both flags; mismatch
  rejected.
- Ordering: smallest-domain-first, deterministic tie-break.
- No-request guarantee: prose failure with a stub server that asserts zero hits.

**Local proof, operator-run, not part of `verify`** (needs a dev server and a
TOTP code):

1. Fresh local D1 and the existing synthetic provisioning
   (`synthetic-pilot`, `v1`).
2. `--dry-run` with the real taxonomy, prose and converter output: prints 463
   rows, 93 units at size 5, 8/36 taxonomy.
3. `--stage taxonomy`: adopts the root and version (proving recovery), creates 8
   domains and 36 topics. Re-run: 0 creates.
4. `--stage transform`.
5. `--stage upload --unit-limit 2`; interrupt once between preview and confirm;
   resume.
6. `--stage publish` for those 10; `--stage verify`.

**Evidence this slice reports:** the exact command and result for
`npm run verify` (test counts included); the driver's unit-test count; the local
proof transcript with unit ids, confirm counts, published count and the export
row count; the checkpoint's `counters` and `lastError`; per-request latency for
preview and confirm at batch size 5 (and a one-off at 10 for comparison); and
the CI run URL and conclusion for the PR head. Claims without those are not
evidence.

## Worked call-count estimate

For a full 463-row run at batch size 5, from an empty certification:

| Stage | Requests | Notes |
|---|---:|---|
| 0 | 0 | pure validation |
| 1 | 57 | 4 reads + 4 creates + 8 domain POSTs + 8 topic-collection reads + 36 topic POSTs + 1 |
| 2 | 0 | file transform |
| 3 | 186 | 93 units × (preview + confirm) |
| 4 | 1 389 | 463 × (submit + review + publish) |
| 5 | 5 | 463 published rows at 100 per export page |
| **Total** | **≈1 637** | |

- 0.19% of the Free plan's 100 000 requests/day; peak per-invocation D1 queries
  is 21 (preview at 5 rows).
- Wall clock: at a 250 ms median round trip that is ~7 minutes; at 1 s, ~27
  minutes. The 8-hour assurance window covers either; the 10-minute preview TTL
  never binds because preview and confirm are adjacent.
- A re-run after a complete import is 19 requests (adoption reads only) plus
  whatever stage 5 needs.
- Resume after any failure replays at most one unit (2 requests) plus one
  question's chain (3 requests) plus one reconciliation read per affected key.
