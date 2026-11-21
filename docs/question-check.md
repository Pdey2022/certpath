# question-check: the deterministic content validator

`tools/question-check/` is the committed validator behind PROF. It reads
41-column item batches that live **outside** the repository, judges everything a
program can judge, and writes a report that also lives outside it. It has no
network, no credential and no database: it is a pure function over bytes.

A report is not an approval. Only the owner signs off content
(`docs/question-review-rubric.md`, ADR 0008).

## Identity

| Field | Value |
|---|---|
| Location | `tools/question-check/`, CLI at `tools/question-check/cli.ts` |
| Invocation | `tsx tools/question-check/cli.ts <verb> …`, or `npm run question:check -- <verb> …` |
| Runtime | Node ≥ 22.22 (as pinned in `package.json`), TypeScript run with `tsx` |
| CSV parser | `csv-parse@7.0.3`, already installed, with the server preview's options |
| Dependencies added | none |
| Report format | `certpath-question-check-report-v1` |
| Findings format | `certpath-prof-findings-v1` |
| Verdict format | `certpath-question-review-verdict-v1` |

`npm run verify` does **not** run `question:check`. Content is not a property of
the code, the bank is deliberately outside the repository, and a red pipeline
caused by uncommitted content is the fastest route to someone committing the
bank to make CI green.

## CLI

```
tsx tools/question-check/cli.ts check
  --batches <dir>            # directory of *.csv, outside the repo
  --profile <file>           # committed profile, e.g. tools/question-check/profiles/cism-2026.json
  --taxonomy <file>          # committed taxonomy, e.g. tools/question-check/taxonomy/cism-2026.json
  [--imported-keys <file>]   # newline-delimited keys already in the platform; outside the repo
  --out <dir>                # outside the repo; absent or empty; .partial + rename
  [--mode partial|complete]  # default partial
  [--format json|markdown|both]  # default both
  [--redact]                 # markdown carries no excerpts (always on for markdown)
  [--force]                  # overwrite an existing report; blanks the previous file first
  [--strict-warnings]        # warnings make the exit code 1
  [--suppress <code> --reason <text> --approved-by owner]  # repeatable; errors cannot be suppressed
```

```
tsx tools/question-check/cli.ts combine --report <file> --findings <file> --out <dir>
tsx tools/question-check/cli.ts taxonomy --taxonomy <file> --profile <file> [--out <dir>]
tsx tools/question-check/cli.ts --help
```

`taxonomy` validates the taxonomy **alone**, before any batch exists. It is the
gate that requires topic prose; `check` needs only identity (ids, keys, order),
because a growing batch can be checked before the prose is written.

## Exit codes

| Exit | Report `verdict` | Meaning |
|---:|---|---|
| 0 | `pass` | 0 errors, 0 warnings |
| 0 | `pass_with_findings` | 0 errors, ≥1 warning; exit 1 instead when `--strict-warnings` |
| 1 | `fail` | ≥1 error, or (with `--strict-warnings`) ≥1 warning |
| 2 | refused | refused to run: bad arguments, unreadable input, path inside the repository, attempted suppression of an error, unacknowledged warning at `combine`, stale report, PROF trying to override an error. **Nothing was judged.** |
| 3 | incomplete | the tool failed mid-run (I/O error after validation began). The report is not a verdict. |

Exit 2 and 3 never produce a `pass`.

## Report schema

```json
{
  "formatVersion": "certpath-question-check-report-v1",
  "advisoryOnly": true,
  "approvalGranted": null,
  "mode": "partial",
  "inputs": {
    "profile":  { "path": "…", "sha256": "…" },
    "taxonomy": { "path": "…", "sha256": "…" },
    "batches": [
      { "file": "batch-004.csv", "sha256": "…", "rows": 10, "included": true, "excludedReason": null }
    ],
    "importedKeys": { "path": "imported-keys.txt", "sha256": "…", "count": 0 }
  },
  "totals": { "batches": 10, "filesExcluded": 0, "rows": 100, "itemsWithErrors": 0, "itemsWithWarnings": 37 },
  "byDomain": [
    { "domainId": "cism-d1", "count": 40, "targetShare": 0.18, "observedShare": 0.4, "delta": 0.22, "slack": 0.05, "verdict": "error" }
  ],
  "byDifficulty": [ { "difficulty": "medium", "count": 100, "share": 1, "target": null } ],
  "byTopic": [ { "domainId": "cism-d1", "topicId": "cism-d1-t1", "count": 25, "shareOfDomain": 0.625 } ],
  "answerPosition": { "positions": { "1": 100, "2": 0, "3": 0, "4": 0 }, "maxShare": 1, "verdict": "error" },
  "coverage": { "mockDraw": { "cism-d1": 27, "cism-d2": 30, "cism-d3": 50, "cism-d4": 43 }, "repeatFreeMocks": 3, "bindingDomain": "cism-d3" },
  "findings": [
    { "code": "DOMAIN_WEIGHT_DEVIATION", "severity": "error", "owner": "tool",
      "scope": { "file": null, "row": null, "questionKey": null, "domainId": "cism-d1" },
      "message": "domain cism-d1 holds 0.4 of rows against a target share of 0.18",
      "evidence": { "count": 40, "delta": 0.22, "rows": 100, "slack": 0.05 } }
  ],
  "suppressions": [ { "code": "STEM_NEAR_DUPLICATE", "questionKey": "cism-0042", "reason": "…", "approvedBy": "owner" } ],
  "verdict": "fail"
}
```

Rules that make the report usable as evidence:

- **No timestamp, no absolute path, deterministic ordering.** Findings are sorted
  by `file`, `row`, `code`, `questionKey`, `message`; maps are sorted by key;
  shares are rounded to six decimals. Two runs over the same bytes produce
  byte-identical JSON.
- `file` is the basename inside `--batches`. An input outside the repository is
  recorded by basename only; a committed schema file is recorded
  repository-relative. No report contains an absolute path.
- `evidence` is a structured object: numeric counts, at most one `excerpt` of
  ≤ 160 characters, plus key values where the finding is about a key. Markdown
  output never carries an excerpt, and `--redact` removes them from JSON.
- `questionKey` is `null` for bank-level findings; `row` is `null` for run-level
  and file-level findings; `approvalGranted` is always `null` — there is no code
  path that sets it.

## Check catalogue — errors

A batch with any error cannot be passed by PROF. No flag turns an error into a
warning.

| Code | Check | Notes |
|---|---|---|
| `CSV_BOM` / `CSV_NOT_UTF8` / `CSV_UNPARSEABLE` | UTF-8 without BOM; parses | file-level, excludes the file |
| `HEADER_MISMATCH` | header is exactly the 41 ordered columns | `contract.test.ts` asserts parity with the server |
| `ROW_CELL_COUNT` | every row has exactly 41 cells | file-level, excludes the file |
| `BATCH_ROW_LIMIT` | ≤ 10 rows per file | the preview cap; the file is still judged |
| `BATCH_BYTES` | ≤ 256 KiB per file | file-level, excludes the file |
| `FORMAT_VERSION` | `certpath-question-v1` | |
| `FIELD_REQUIRED` | format, key, exam version, domain, topic, stem, difficulty, source, licence, option key/text/explanation | |
| `FIELD_CAP` | stem 5–4000; option text 1–1000; explanation 1–3000; source 1–1000; licence 1–200; question key 1–120; option key 1–32 | |
| `QUESTION_KEY_INVALID` | matches the **profile's** pattern (CISM: `^cism-[1-9][0-9]*$`) | profile data, not a constant |
| `DUPLICATE_QUESTION_KEY` | unique within a file and across the run | the first occurrence is named in evidence |
| `KEY_ALREADY_IMPORTED` | not in `--imported-keys` | |
| `OPTION_COUNT` | exactly `profile.optionCount` (4) populated slots | |
| `OPTION_SLOT_GAP` | slots contiguous from 1; trailing slots empty | |
| `OPTION_KEY_DUPLICATE` | unique within an item | |
| `CORRECT_FLAG_NOT_BOOLEAN` | literal `true` / `false` | |
| `CORRECT_OPTION_COUNT` | exactly one `true` | the "two correct options" case |
| `EXPLANATION_MISSING` | every populated option has one | |
| `EXPLANATION_COPY` | the correct explanation is not byte-identical to a distractor's | |
| `DIFFICULTY_INVALID` | `easy` \| `medium` \| `hard` | |
| `EXAM_VERSION_MISMATCH` | equals `profile.examVersionId` | |
| `UNKNOWN_DOMAIN_KEY` / `UNKNOWN_TOPIC_KEY` | present in the taxonomy | the offending value is in `evidence.value` |
| `DOMAIN_TOPIC_MISMATCH` | the topic belongs to the domain | |
| `STEM_DUPLICATE` | after NFKC, casefold, punctuation strip and whitespace collapse | both keys named |
| `ANSWER_POSITION_MONOTONE` | a file of ≥ 4 rows where **every** correct answer is at one position | file-level |
| `ANSWER_POSITION_BIASED` | run ≥ 40 rows and one position ≥ 40% of correct answers | |
| `DOMAIN_WEIGHT_DEVIATION` | complete mode only; see tolerance below | |
| `DOMAIN_MISSING` | a weighted domain has zero rows | error in both modes |

## Check catalogue — warnings

Each warning must be **acknowledged** in `prof-findings.json` with a judgement
(`not-a-defect` / `accepted` / `defect`) and a reason. An unacknowledged warning
makes `combine` fail closed.

| Code | Measurement |
|---|---|
| `DOMAIN_WEIGHT_DEVIATION` | in `partial` mode, the complete-mode error becomes this warning |
| `DOMAIN_UNDER_TARGET` / `DOMAIN_OVER_TARGET` | per-domain direction, in `partial` mode |
| `BANK_VOLUME_SHORTFALL` | rows < `profile.targetRows` |
| `ANSWER_POSITION_SKEW` | run ≥ 40 rows, max share in [32%, 40%) |
| `DIFFICULTY_TARGET_UNSET` | `profile.difficultyTargets` is `null` — the target does not exist yet |
| `DIFFICULTY_CONCENTRATION` | one difficulty ≥ 80% of the run |
| `DIFFICULTY_DEVIATION` | only when `difficultyTargets` is set; same slack rule as domains |
| `TOPIC_CONCENTRATION` | one topic > 35% of its domain, domain has ≥ 3 topics |
| `TOPIC_UNASSIGNED` | a `catchAllTopicKeys` topic holds > 25% of the run |
| `STEM_NEAR_DUPLICATE` | 5-gram token-shingle Jaccard ≥ 0.80; reports score and counterpart key |
| `STEM_LENGTH_OUTLIER` / `OPTION_LENGTH_OUTLIER` | modified z-score > 3.5 across the run (MAD = 0 means no outliers) |
| `CORRECT_OPTION_LONGEST_PATTERN` | the correct option is strictly longest in ≥ 50% of a run of ≥ 10 items |
| `EXPLANATION_THIN` | a distractor explanation shorter than 40 characters |
| `EXPLANATION_LETTER_REFERENCE` | an explanation names an option letter (`\b[Oo]ption[s]?\s+[A-H]\b`, `\b(?:[Aa]nswer|[Cc]hoice)s?\s+[A-H]\b`, or `[A-H][.)]\s`); the keyword matches in any case, the letter only in upper case |
| `STEM_NUMBER_INCONSISTENT` | a stem beginning "what is" / "calculate" / "compute" whose one explicit operation does not produce the keyed number |

These are warnings because each is a *distribution over items*, and a legitimate
bank can be skewed at small n. The tool can prove the shape but not the intent.
`STEM_DUPLICATE` is the exception: two identical stems are never intentional.

`DOMAIN_UNDER_TARGET` / `DOMAIN_OVER_TARGET` are emitted in `partial` mode only.
In complete mode the deviation is an error and its message already names the
direction; emitting both would double the acknowledgements a reviewer owes for
one defect.

## Tolerance maths

`slack = max(profile.maxDomainShareDeviation, profile.maxDomainDeviationSlackItems / rows)`
— defaults `0.05` and `3`. Fewer rows means a wider band: three items cannot be
a 5% share.

- `complete`: `|observed − target| > slack` → error `DOMAIN_WEIGHT_DEVIATION`.
- `partial`: the same predicate → warning.
- `DOMAIN_MISSING`: any weighted domain with zero rows → error in both modes.

Against 100 items split 40/20/20/20 with the CISM weights (18/20/33/29),
slack = max(0.05, 0.03) = 0.05:

| Domain | Observed | Target | Δ | Result (complete / partial) |
|---|---:|---:|---:|---|
| Governance | 0.40 | 0.18 | +0.22 | error / warning |
| Risk | 0.20 | 0.20 | 0.00 | pass |
| Programme | 0.20 | 0.33 | −0.13 | error / warning |
| Incident | 0.20 | 0.29 | −0.09 | error / warning |

Why `partial` exists: during authoring a growing bank is legitimately out of
balance. `partial` keeps the signal visible without declaring the work
defective. Only a `complete`-mode `pass` may be quoted as a gate, and the
report's `mode` field makes it impossible to quote the wrong one by accident.

## Coverage maths

The per-mock draw is `examQuestionCount × weightShare`, then Hamilton
largest-remainder to integers summing to `examQuestionCount`, ties broken by
profile order. For CISM (150 questions, 18/20/33/29) that is 27 / 30 / 50 / 43
(49.5 and 43.5 round by largest remainder; the 0.5 tie goes to profile order).

`repeatFreeMocks = min over domains floor(bankRows_d / draw_d)`, and
`bindingDomain` is the domain that achieves the minimum.

Against the profile's 108 / 120 / 198 / 174 target rows: `floor` gives 4, 4, 3, 4
— **the programme domain binds, so the answer is 3 repeat-free mocks, not 4.**
`coverage.repeatFreeMocks` is reported, never enforced: inflating programme to
200 to reach 4 would change 33.0% to 33.2% and open the door to filling the
smallest domain rather than the weakest one. If the owner wants 4, the honest
version is a stated 602-item bank in the profile
(`docs/open-decisions.md`, F4).

## Path policy

| Path | Where it may resolve |
|---|---|
| `--batches` | outside the repository |
| `--imported-keys` | outside the repository |
| `--out` | outside the repository |
| `--report`, `--findings` (combine) | outside the repository |
| `--profile`, `--taxonomy` | anywhere — these are committed schema files with no item text |

A path that resolves inside the repository is refused before anything is read or
written: `INPUT_INSIDE_REPOSITORY` for inputs, `OUT_INSIDE_REPOSITORY` for
`--out`. The walk canonicalises through the nearest existing parent, as the CISSP
converter does, so `..` and symlinks do not smuggle a path inside.

`--out` must be absent or empty. `--force` blanks the previous report (and any
`.partial` files) **before** the new one is written, so a crash cannot leave an
old `pass` where a new run was expected.

`.gitignore` ignores `docs/CISSP*/` and `docs/CISM*/`: a CSV of question content
inside the checkout is the leak those rules exist to prevent, and the validator
must not make it convenient.

## Suppressions

`--suppress <code> --reason <text> --approved-by owner`, repeatable.

- Recorded, never silent: every suppressed finding appears in `suppressions[]`
  with its reason and `approvedBy`. A suppression that matched nothing is
  recorded with `questionKey: null`, so an ineffective suppression is visible.
- `--suppress` on an error is refused (`CANNOT_SUPPRESS_ERROR`), whether the code
  is always an error (`CORRECT_OPTION_COUNT`) or became one in this run
  (`DOMAIN_WEIGHT_DEVIATION` in complete mode).
- A suppression without a reason is refused (`SUPPRESSION_UNJUSTIFIED`).
- `--approved-by` must be the literal `owner`.

## `combine` — the one quotable verdict

Inputs: the tool report plus PROF's findings. Four rules, each fail-closed:

1. The findings' `batchDigests` (and `reportSha256`, when present) must match the
   report → else `STALE_REPORT` (exit 2). This is the replay guard: a verdict
   cannot outlive the bytes it describes.
2. Every report `warning` must appear in `acknowledgedWarnings`, matched on code
   and `scopeKey` → else the verdict is `fail` with `WARNING_UNACKNOWLEDGED`
   (exit 1).
3. A report containing an `error` cannot be passed by any PROF verdict → else
   `CANNOT_OVERRIDE_ERROR` (exit 2).
4. Otherwise the verdict is the worse of PROF's verdict and the report's:
   any `blocking` finding → `fail`; only `major` / `minor` →
   `pass_with_findings`; none → `pass`.

`combine` writes `question-review-verdict.json`, which is the file the owner is
shown. It still says `advisoryOnly: true` and `approvalGranted: null`.

## Rollback or disable path

Nothing depends on the validator, because nothing has to be undone: it sits in
front of the owner's reading, not in front of a write.

1. **Stop running it.** Imports, merges and deployments are unaffected; the
   owner's review is the reviewer of record either way.
2. **Delete `.github/agents/prof.agent.md`.** One PR, no dependency. The
   validator stays — it is useful without the agent, and its tests keep it
   honest.
3. **Revert the docs to two agents.** One PR; ADR 0008 is then superseded by a
   new ADR, never edited.
4. **Downgrade the validator's role.** `partial` mode already exists for
   authoring; the only difference is that `DOMAIN_WEIGHT_DEVIATION` stops being
   an error. If the owner has made `complete` an operational gate, turning it
   off is an owner decision recorded in `docs/open-decisions.md`, so the
   withdrawn guarantee is visible rather than absent.
5. **Fix a wrong check** by changing the tool in a reviewed PR.

What must never be the disable path: dropping `--strict-warnings` to get green,
lowering a threshold until a batch passes, adding an `--ignore-code` for an
error, or deleting a test. Each is weakening a guarantee to make a check pass,
which is a finding against the person who did it, not a fix.
