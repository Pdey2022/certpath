# ADR 0007: Public repository and licence posture

- Status: Accepted, with owner approval on 2026-11-20.
- Scope: The repository's visibility, the licence it carries, and the
  protections that had to be in place before anything was published.

## Context

Branch protection and repository rulesets — the features that make a required
`verify` check and a blocked force push real rather than conventions — are not
available on GitHub's free plan for private repositories.
They are available on the paid plan (Pro, roughly $4 per month at the published
price) and on public repositories.

The product has no revenue yet and the operating constraint is $0 during the
tester phase (ADR 0006). The owner weighed $4 per month against publishing the
source. The source carries no customer data, no licensed bank and no credential:
it is the product's own code and documentation, and the owner judged that the
transparency is worth the exposure.

Publishing is not reversible in practice. A public repository can be viewed and
forked by any GitHub user under GitHub's Terms of Service, and a commit stays
retrievable by its SHA after the branch that pointed at it is deleted. The
decision therefore had to be taken with the content already clean, not with a
plan to clean it later.

## Decision

- The repository is **public**, and it is **not open source**: all rights are
  reserved by **DeyLabs (deylabs.co.uk)**, 2026. The licence is `LICENSE` at the
  repository root.
- The licence grants nothing beyond what GitHub's Terms of Service give a viewer
  of a public repository — the ability to view it and to **fork** it through
  GitHub — and says so, so that "no right is granted" is not read as forbidding
  what GitHub permits.
- The competing-product sentence is a **condition of use**, not a reserved
  copyright right: ideas and methods are not copyrightable, and the notice does
  not claim otherwise.
- Content **imported from a third party** that carries its own
  `license_reference` is governed by **that** reference, not by `LICENSE`. The
  importer records a `license_reference` per question, so a future licensed bank
  keeps its own licence and is not silently claimed by this file. The owner's own
  bank carries `All rights reserved (owner-authored)` and is covered by
  `LICENSE` like everything else here; the carve-out is for imported banks only.
- The trademark disclaimer and the as-is paragraph stay.

### Done before publishing

- **History audited for credentials.** The objects in the published history were
  searched for tokens, keys, passwords, `.dev.vars` content and account ids. What
  was found were deliberate fakes: test fixtures and stub secrets that are not
  credentials anywhere, plus the public Cloudflare account id that the workflows
  already pin. Nothing secret had to be rewritten or rotated.
- **Agent checkpoints are a standing check, not a one-off cleanup.** 139 local
  `refs/agents/*` refs were deleted and pruned on 2026-11-20. They were never on
  `origin` — `git push --all` publishes `refs/heads/*` only — but they existed in
  the working clone and were one `git push --mirror` away from being published.
  `git fetch origin <sha>` for the pruned commits failed, so they are **not
  retrievable from GitHub by SHA now**; a SHA is served only while a ref reaches
  it, so that shows they are gone, not that they were never there — the claim
  rests on the refs having been local-only.
  The harness recreates checkpoint refs every session, so the clone is not
  permanently clean: at the time of writing 7 such refs exist (6 under
  `refs/agents/` plus `refs/stash`). Before any publish,
  `git for-each-ref refs/agents refs/stash` must print nothing. What makes the
  current state safe is that the study file is **not reachable from any ref right
  now** — `git rev-list --objects --all` returns no match — not the earlier
  deletion.
- **Ignore rules checked for renames.** A study folder had been renamed once, and
  `git log --all -- <path>` alone would miss it under the old name. The
  `.gitignore` pattern covers the folder rather than one path, and the two
  complementary history checks in `docs/deployments.md` cover both questions:
  `git rev-list --objects --all` lists every reachable object with the single
  path it is first reached under, and `git log --all --full-history --
  '*CISSP*'` matches the glob against each commit's tree. Neither follows a
  rename by itself.

### Protections now in place

- **`main` is protected**: the `verify` check is required in strict mode, and
  force pushes and branch deletions are blocked.
- **Secret scanning and push protection** are enabled on the repository
  (Settings → Code security, verified 2026-11-20). Push protection is not
  absolute: it covers only the secret patterns GitHub recognises, and a writer
  can bypass a block with a recorded reason. It is a backstop that catches the
  common accident, not a guarantee, and it does not replace the audit above or
  the push rule below.
- **One push rule**, in [`docs/deployments.md`](../deployments.md)
  § *Pushing refs*: a named branch only; never `--all`, `--mirror`, `--tags` or
  `--follow-tags`; check which refs and commits a push would send (`--dry-run`
  plus `git log origin/<branch>..<branch>`), that `refs/agents` and `refs/stash`
  are empty, and the object reachability first.

## Alternatives considered

- _Pay for Pro and stay private_ (~$4 per month): protects the source, but adds
  a recurring cost before revenue and still leaves the protections to be
  configured. The owner chose the public repository.
- _Public and open source_: not considered acceptable. The question bank, the
  price ladder and the operating documentation are commercial assets; a
  permissive licence would give them away.
- _A source-available licence with a non-compete clause_: closer to the intent,
  but the decision the owner actually made is narrower — fork and view only —
  and a bespoke licence invites arguments this project cannot afford to have.
- _Publish only a subset of the history_: a shallow or filtered repository would
  not carry the CI, the migrations or the docs that make the public view useful.

## Consequences

- **Forks are permitted and persist.** GitHub's Terms of Service allow any
  GitHub user to fork a public repository, and a fork taken today keeps its
  content after this repository changes or goes private. The licence cannot
  revoke that, and does not pretend to.
- **Publication is irreversible in practice.** A pushed commit remains
  retrievable by SHA, and commercial information in the repository is disclosed
  permanently. That includes documentation the owner accepted publishing: the
  price ladder (ADR 0003), the risk register and delivery plan
  (`docs/delivery-plan.md`), and the content gaps recorded in
  `docs/pilot-hardening.md`.
- **The bank's composition is published.**
  `tools/cissp-convert/taxonomy.json` carries the blueprint the import driver
  uses, including per-domain and per-topic `expectedQuestions`: **484** in total,
  **211** in Domain 1, and **171** mapped to the per-domain `general` topics.
  Anyone reading the repository can see how the bank is built and where it is
  thin (the gaps themselves are recorded in `docs/pilot-hardening.md`). The owner
  accepted this: the numbers describe the exam's structure and the bank's shape,
  not its questions.
- **`main` cannot be rewritten.** A leaked object cannot be removed by force
  pushing a cleaned history; it would still be addressable by SHA, and forks
  would still hold it. Rotation, not history editing, is the response to a
  leaked credential.
- **The protections are repository settings, not code.** They are recorded here
  and in `docs/deployments.md` so that a future owner knows what to re-create,
  but nothing in CI fails when they are switched off.

## Residual risk

- **Author != reviewer is still not enforced.** ADR 0006 requires it and records
  that the schema does not; publishing the repository does not change that. The
  pilot's self-review exception remains a documented concession.
- **Taxonomy provenance is unverified.** The terms under which
  `tools/cissp-convert/taxonomy.json` may be redistributed have not been
  established. The owner chose to keep the file; if the terms turn out to forbid
  redistribution, removing it later will not remove it from forks or from the
  published history, and the answer is a fresh licence check plus a new exam
  version, not a history rewrite.
