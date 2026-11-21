# ADR 0008: PROF, the question-content review agent

- Status: Accepted for an advisory role, with owner approval on 2026-11-21. The
  CISM reviewer-of-record posture is **unresolved** — see Consequences (F1).
- Scope: A third workflow agent for question content, the committed validator it
  runs, and the boundary between an automated pre-check and a review.

## Context

ADR 0006 requires author ≠ reviewer and records that the database does not
enforce it: `content_reviews.reviewer_user_id` is never compared with the
revision's author. Its only exception is named — the CISSP pilot runs under a
documented self-review exception, and that exception "does not extend to any
future bank".

CISM is a future bank. Its items are AI-assisted drafts entered under the owner's
account, so the owner is the author and the owner's review would be self-review —
outside the documented exception. Two things follow that this ADR has to live
with:

- an automated check is not a second pair of eyes: it is neither human nor a
  `users` row, so it cannot be the reviewer ADR 0006 means;
- a batch can still be wrong in ways no program can see: two defensible options,
  a distractor nobody would pick, an item that tests a different topic, a
  BEST/FIRST question with no discriminator, an explanation that contradicts the
  key.

The existing pipeline also has a gap on the other side. A 600-item bank can pass
every storage invariant and still be a broken product: `CORRECT` is not a CHECK,
and nothing in D1 knows whether the run is blueprint-weighted. The wrong
taxonomy value is permanent (`domains_no_update`, `topics_no_update`,
`exam_versions_no_update`, `certifications_no_update`), and published content is
not rolled back (`exam_version_questions`).

## Decision

- Add a third agent, **PROF**, whose only authority is advisory. It sits between
  drafting and the owner's SME review. Its verdict authorises exactly one thing:
  offering the batch to the owner as ready to read.
- Back the mechanical half with one committed, offline, deterministic validator
  at `tools/question-check/`. It owns contract conformance, exactly-one-correct,
  key uniqueness, taxonomy membership, blueprint shares, answer-position
  distribution, duplicates and outliers. PROF owns only the judgements code
  cannot make, against `docs/question-review-rubric.md`.
- The verdict vocabulary is `pass` / `pass_with_findings` / `fail` — never
  `approved` / `rejected`, which are the `content_reviews.decision` values, so an
  agent verdict can never be mistaken for a row in the review table. PROF
  severities are `blocking` / `major` / `minor`, distinct from the tool's
  `error` / `warning`.
- The tool's verdict is exclusive where it errors: `combine` refuses any PROF
  verdict that would pass a report containing an error
  (`CANNOT_OVERRIDE_ERROR`). Every tool warning must be acknowledged with a
  judgement and a reason before a verdict exists (`WARNING_UNACKNOWLEDGED`).
- **PROF has no `edit` tool.** The bank is outside version control, so an AI edit
  leaves no diff: nobody can see which words changed, the author cannot review
  it, and the owner's sign-off would attest to text nobody saw being written.
  PROF may say what is wrong with a sentence; it may not write the sentence.
- **PROF has no `web` tool**, and the validator's module graph has no `fetch`.
  Item text must never leave the operator's machine: sending a draft stem to a
  search engine is exfiltration of possibly confidential or third-party-derived
  material, and search results are not evidence that an item is not a
  reconstruction of a live exam.
- PROF has `execute` because its findings must be grounded in the current bytes.
  A pasted report can be stale and cannot be checked. The report therefore
  carries per-file SHA-256 digests and no timestamp, so a reader can re-run and
  compare.
- No migration, no table, no route, no Worker code, no contract change, no new
  dependency. PROF adds no storage invariant.

## Alternatives considered

- _Let PROF fix what it finds._ Faster for typos, and it makes the AI both
  drafter and fixer with no human in between — in the one place this workflow is
  already weak (F1). Rejected.
- _Drop `execute` and have PROF judge a transcript the operator ran._ Gives a
  hard tool-list guarantee instead of grounded findings, and every finding then
  rests on a report nobody verified. Rejected; the operator's own checkout is the
  control.
- _Make the content check a stage in `npm run verify`._ Puts a content gate in
  CI, where uncommitted content is by design absent, and makes a red pipeline the
  fastest route to committing the bank to make CI green. Rejected.
- _Enforce a difficulty distribution._ No target exists in any source-of-truth
  document, so the profile carries `difficultyTargets: null` and the tool warns
  (`DIFFICULTY_TARGET_UNSET`) instead of inventing one.
- _Inflate the programme domain to reach 4 repeat-free mocks._ Changes 33.0% to
  33.2% and invites "just a few more here" until the blueprint stops describing
  the exam. Rejected: the exact weights are the product's claim, and 3
  repeat-free mocks is reported, not enforced.

## Consequences

- The content lane gains three artefacts — `question-check-report.json`,
  `prof-findings.json`, `question-review-verdict.json` — all outside the
  repository, none of them a `content_reviews` row. None is an approval.
- A wrong taxonomy value is still permanent, so the `taxonomy` verb must pass
  before the first batch is authored and again before the first import. That is
  why the validator checks the taxonomy alone, not only the rows.
- The tool's report is deterministic by construction: no timestamp, no absolute
  path, sorted findings and rounded shares. Two runs over the same bytes are
  byte-identical, so a re-run either matches or the input changed.
- **F1 — the CISM reviewer-of-record posture is unresolved.** This ADR does not
  claim CISM is covered by the CISSP self-review exception, and PROF does not
  satisfy author ≠ reviewer for any bank. The owner must still choose: extend the
  documented exception to CISM with the same wording, name a second human
  reviewer for CISM, or defer the CISM import. Until then PROF is advisory and
  nothing more. The decision is recorded in `docs/open-decisions.md`.
- **F5 — this ADR says nothing about importability.** The CISSP converter and
  driver are CISSP-specific (`certpath-cissp-taxonomy-v1`, the `cissp-` key
  pattern, a 484-item id range), so a green content check is not a path to rows.
  CISM import support is a separate slice.
- The validator is useful without the agent. Deleting `prof.agent.md` is one PR
  with no dependency, and the tests keep the tool honest.
