# CISSP bank import: converter and pilot decisions

Status: owner-approved plan for Phase 2 of the CISSP content work. This slice
builds the converter only. It performs **no** migration, import, deployment,
provisioning or database write.

The source file stays local. `docs/CISSP questoins/` is git-ignored, the
converter writes only outside the repository, and every generated CSV stays out
of git.

## What this slice delivers

`tools/cissp-convert/cli.ts` turns the owner's local study HTML into the
repository's v1 question-import CSV. It is a build-time tool, not a Worker
route. It reads the `allQuestions` JSON array from the HTML, validates every
item against the import contract, and writes:

- `batch-NNN.csv` — one header row plus at most ten question rows per file;
- `manifest.json` — counts and SHA-256 digests only;
- `taxonomy-report.json` — expected/observed counts per domain, topic and
  source label;
- `rejections.txt` — one line per omitted question: id, reason code, safe
  detail. No question text is written to it.

The tool contains no question text, options, answers or explanations. It holds
schema constants, the approved taxonomy mapping and limit checks. Tests use a
three-question synthetic fixture authored in the test file.

## Usage

```powershell
tsx tools/cissp-convert/cli.ts `
  --input "docs/CISSP questoins/cissp.html" `
  --taxonomy tools/cissp-convert/taxonomy.json `
  --out "$env:TEMP\cissp-import" `
  --exam-version-id "cissp-exam-v1" `
  --source-reference "Owner-authored CISSP study file (local, git-ignored)" `
  --license-reference "All rights reserved (owner-authored)"
```

`--out` is required and must resolve outside the repository and be empty. The
tool writes `.partial` files and renames them into place only after every row
validates; a failure removes the partial files and writes nothing else. There
is no default output directory and no default provenance.

`--source-reference` and `--license-reference` may be replaced by
`--provenance <json>` containing exactly those two fields. Supplying both forms,
one of the pair, or a missing/blank/over-cap value fails closed.

### Contract values

- `format_version` is `certpath-question-v1`.
- `question_key` is `cissp-<id>`.
- `difficulty` is `medium` for every row.
- `exam_version_id` is the operator-supplied exam-version id.
- `domain_id` and `topic_id` come from the taxonomy file.
- The header is exactly `QUESTION_IMPORT_TEMPLATE_COLUMNS` from
  `apps/api/src/security/question-imports.ts`. A test imports that constant and
  asserts byte equality with the converter's copy.
- Rows are capped at `QUESTION_IMPORT_MAX_ROWS` (10) per batch. A test asserts
  the two constants are equal and that no emitted batch exceeds the cap.

### Fail-closed codes

Fatal conditions exit non-zero with a named code on stderr and leave no output
files: unreadable input, missing/unclosed/unparseable `allQuestions`, duplicate
or out-of-range id (1–484), option count other than four, blank stem/option,
any value over its contract cap, unknown source label or domain prefix,
malformed taxonomy, missing provenance, an output path inside the repository or
a non-empty output directory, and a run in which no question survives.

Per-question omissions do not abort the run. They are written to
`rejections.txt` with one of:

- `CORRECT_ANSWER_MATCH_COUNT` — `correct_text` matches zero or several options
  after trimming and whitespace normalisation. The converter never guesses.
- `EXPLANATION_MISSING` — the correct option has no `ins_why`.
- `EXPLANATION_SPLIT_INCOMPLETE` — `ins_others` does not yield exactly one
  non-empty fragment for every non-correct option.

The correct option's explanation is always `ins_why`. Distractor explanations
come only from `ins_others`, split deterministically: a marker is the *next
expected* option letter in option order, followed by a full stop and whitespace.
A capital letter that is not the next expected marker is prose, so an
explanation ending “...for option B.” is not mistaken for a new section. If the
expected sequence does not complete, the question is rejected — `ins_why` is
never copied onto a distractor and a fragment is never duplicated.

## Canonical taxonomy

`tools/cissp-convert/taxonomy.json` is the owner-approved mapping: eight CISSP
domains and 36 topics. It carries every source label that maps into each topic,
so each merge is auditable (for example `Risk terminology` →
`cissp-d1-risk-management`, and `Audit Ethics`, `Change management`,
`Governance and Compliance`, `Governance and policy`, `Legal, regulatory and
investigations` → `cissp-d1-governance-and-compliance`).

The truncated source labels `Asset`, `Security`, `Identity`, `Software`,
`Communication` and `NAC` map to `general` inside their own domain. They are
never assigned an invented subtopic.

Topic ids are namespaced with their domain (`cissp-d2-general`), because
`topics.id` is a global primary key in D1. The approved per-domain slug
(`general`) is preserved as `slug`; the CSV carries the namespaced id.

Unknown labels are fatal. There is no fallback to `general`, no fuzzy match and
no case-insensitive match: a new spelling requires an explicit taxonomy change.

## Decisions taken for the pilot

- **Owner-authored, all rights reserved.** The import is labelled as
  owner-authored content under an all-rights-reserved licence reference. It is
  not a licensed bank.
- **Driver through the API.** The converter produces CSVs. The operator uploads
  each batch through the existing protected staff question-import preview and
  confirmation API. The converter never writes D1, never calls the API and does
  not bypass the import validators.
- **Self-review accepted for this pilot.** The owner authored the source and is
  the only reviewer. This is a documented pilot exception, not a change to the
  content-review records the schema already keeps.
- **All-medium, uncalibrated.** There is no empirical difficulty data, so every
  row is `medium`. Difficulty is not a quality signal yet.
- **Split-or-reject explanations.** No generated distractor explanation is
  invented. Questions whose source explanation cannot be split are omitted.
- **All 484 items are labelled practice.** Every parsed item is intended for
  labelled practice. The 463 that pass the contract are importable as draft
  rows; the remaining 21 are omitted for the reason above.
- **Readiness remains gated.** Importing content does not change the readiness
  formula, the pilot gate or any learner-facing guarantee.

## Honest limitations

- **171 questions are domain-only.** They map to `general` in their domain
  (D2, D3, D4, D5, D7, D8) and carry no useful subtopic. They are usable as
  practice but not as topic-level readiness signal.
- **Domain 1 dominates the bank.** 211 of 484 items (about 44%) are Domain 1,
  so practice volume is not blueprint-balanced.
- **Roughly 140 explanations are still pending editorial review** in the
  owner's inventory. The converter does not judge editorial quality; it only
  enforces the import contract. Separately, 21 items in the current file have no
  per-option `ins_others` markers and are rejected rather than guessed.
- **Third-party question wording remains in the source's own
  `verified_source`.** Several items record notes such as “still recommended to
  verify against the exact license” or third-party outline references. The
  import's `source_reference` is a fixed provenance string; it does not launder
  that underlying wording. Re-authoring or licensing review is required before
  any public claim of original content.
- **No calibration, no blueprint weighting.** Difficulty and distribution are
  unmodified source facts.
- **The HTML is not reproducible from the repository.** It is local, ignored
  and never committed. The manifest records the source digest and the batch
  digests so a later run can be compared, but the file itself must be supplied
  by the owner.

## Verification evidence for this slice

A real run against the owner's local file produced:

```text
parsed 484 question(s)
wrote 463 row(s) in 47 batch(es)
rejected 21 question(s)
  EXPLANATION_SPLIT_INCOMPLETE: 21
```

The taxonomy report observed all eight domains and 36 topics at their approved
counts (484 total, 171 `general`), and the generated CSV rows use the exact
41-column header, four options, options 5–8 empty, and exactly one `true`.

The tool's tests cover the synthetic three-question fixture byte-for-byte, the
header/format/row-cap parity with the real import constants, every rejection
code, the repo-write refusal, `.partial` cleanup after a write failure, and the
absence of question text from `manifest.json`, `taxonomy-report.json` and
`rejections.txt`.

No migration, import, deployment, provisioning or database write is part of
this slice.
