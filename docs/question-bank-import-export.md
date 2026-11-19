# Question-bank import/export contract v1

Status: internal Milestone 2D data contract, exposed to the protected staff
workspace in Milestone 2H. There is no public endpoint or real identity
provider.
Authorization uses the existing internal session/role/assignment services and
an explicitly supplied MFA policy.

## Import template

The exact, ordered header is:

```text
format_version,question_key,exam_version_id,domain_id,topic_id,stem,difficulty,source_reference,license_reference,option_1_key,option_1_text,option_1_correct,option_1_explanation,...,option_8_key,option_8_text,option_8_correct,option_8_explanation
```

The abbreviated `...` represents the same four columns for each option number
from 1 through 8. Every row uses format version `certpath-question-v1`.
Option groups are contiguous and ordered; absent trailing options have four
empty cells. Correctness is exactly `true` or `false`. Required values,
single-choice option count, unique option keys, one correct answer, text
lengths, difficulty, source and licence fields use the same validator as
manual draft creation.

Files must be UTF-8 without a BOM. CSV quoting follows the `csv-parse` parser,
including escaped quotes, quoted commas and embedded newlines. Header names
must be unique and exactly match the template and order. Unknown/missing
headers, extra or missing cells, malformed records, blank records, unsupported
encodings, duplicate question keys, unsupported item shapes and invalid
certification/version/domain/topic references reject the whole preview. Rows
are never silently skipped or truncated. The selected exam version must
belong to the explicitly authorized certification; each row must identify
that same version and an existing domain/topic pair in it.

Conservative limits:

| Limit | Value |
|---|---:|
| Uploaded bytes | 256 KiB |
| Question rows | 10 |
| Raw CSV record size | 96 KiB |
| Stem | 5-4,000 characters |
| Option count | 2-8 |
| Option key | 1-32 characters |
| Option text | 1-1,000 characters |
| Per-option explanation | 1-3,000 characters |
| Source reference | 1-1,000 characters |
| Licence reference | 1-200 characters |
| Stable question key | 1-120 ASCII key characters |
| Preview lifetime | 10 minutes |

These are caps, not truncation rules. Input that exceeds a cap is rejected.
The uploaded file itself is not retained. A successful preview stores only
the normalized validated rows, generated question/revision IDs, the requested
scope, actor, format, expiry and a SHA-256 digest of the canonical rows plus
those bindings. Confirmation accepts only the preview ID; it never accepts
browser-supplied rows or treats a file digest as authority.

## Preview and confirmation

The actor and certification are authorized before parsing. The preview
validates every row and returns a row/column/code error list and counts, but
creates no question, revision, option or publication. Invalid previews retain
no row content. Audit events record only actor, certification, operation,
outcome and safe counts/codes, never CSV bytes or question text.

Validated rows remain in D1 for at most 10 minutes before confirmation. An
internal cleanup operation marks expired previews, appends an audit event and
removes their validated payload rows; preview creation, confirmation and export
also remove expired payloads opportunistically. A Worker cron invokes cleanup
every five minutes and processes at most 50 expired previews per run;
additional backlog is handled by later invocations. Confirmed rows have their
content payload cleared while stable outcome IDs remain for idempotent retries.
There is no raw-file/object-storage staging. Monitor cleanup backlog before
increasing import throughput.

Confirmation rechecks the active session, staff role, MFA policy and
certification assignment, and its guarded D1 writes recheck them again. It
also rechecks the exact scope/taxonomy and conflicting stable question keys.
Each import creates new, sealed draft revisions only; it cannot publish,
overwrite or silently correct an existing question. A unique import ID, fixed
row/question/revision IDs, import-state predicates, foreign keys and database
triggers make retries return the established outcome and prevent a concurrent
confirmation from creating a second set.

The confirmation is one D1 batch. It constructs each question and complete
option set using the Milestone 2C seal mechanism, records immutable import
outcomes, and then transitions the import to confirmed. The final D1 trigger
requires every expected row to reference the exact sealed draft. A failed
statement or incomplete final state aborts the batch, including lock changes,
content audit events and import success audit. Zero-row guarded writes are
checked separately; a zero-row result is not treated as an SQL exception or
success. No post-commit check is relied on for rollback.

Cloudflare's D1 limits documentation (checked 10 November 2026) specifies 100
bound parameters per query, 100 KB SQL statements, 2 MB maximum row size and
50 queries per Worker invocation on the Free plan. The 10-row cap uses at most
53 statements in the confirmation batch (five per row plus three import state
and payload operations), and the largest option-construction statement uses
47 bound values. Each batch statement is individually below D1's parameter
and SQL-size limits. A 256 KiB upload cap also bounds canonical staged data
well below D1's 2 MB row limit. The current D1 documentation describes batch
execution and rollback, but does not specify a smaller maximum statement count
per batch; the implementation deliberately remains bounded.

## Export

Export requires a current Global Admin or assigned Manager, the explicit
certification and exam version, and staff MFA. Authorization and scope
predicates precede content selection. Each call returns at most 100 current
published questions and a stable question-ID cursor. Draft, review, retired,
learner, session and secret data are excluded. Export action, scope, actor,
operation ID, row count and whether another page exists are audited.

The output uses the same documented field/header shape and RFC-style CSV
quoting (all cells are quoted; quotes are doubled). Cells beginning with
formula-significant characters (`=`, `+`, `-`, `@`, tab, CR or LF), including
those after leading whitespace, receive a leading apostrophe before quoting.
This is a spreadsheet-safe report, not a byte-for-byte import artifact; it is
intentionally **not directly re-importable** because formula-neutralization
changes those cell values. There is no import correction/overwrite path.

## Runtime and future work

A certification root can now be created over the audited boundary:
`POST /api/admin/content/certifications` (`docs/protected-content-api.md`) is
Global Admin only, requires the exact `Origin` and a session-bound CSRF token,
writes one `certifications` row through `createCertificationRoot`, and answers
`409` instead of duplicating an existing id or slug. The row is audited by the
`certifications_audit_insert` trigger, and it is immutable afterwards
(`certifications_no_update`, `certifications_no_delete`), so a wrong root cannot
be amended - only a second, correctly named root can be created. With the root in
place, creating the `exam_versions`, `domains` and `topics` beneath it is the
next step of the content plan; those routes already exist under the authorized
certification scope. This slice creates no exam version, domain, topic,
question, seed or import row.

The CSV parser is the pinned `csv-parse` 7.0.3 pure-JavaScript synchronous
parser. It handles quoted commas, escaped quotes and embedded newlines without
hand-written delimiter splitting and is exercised in the actual local
Worker/D1 runtime and production build. D1 tests use synthetic records only.

No public content route, provider, real question bank, learner persistence,
payment, deployment or production provisioning is part of this slice. The
protected UI is an internal staff screen; the cleanup schedule is
code/configuration only and has not been deployed. The Worker enforces request
body limits before buffering, and protected responses remain
`noindex`/`private, no-store`. Monitor the periodic cleanup backlog and preserve
the existing public SEO and synthetic-prototype boundaries.

Cloudflare reference: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
