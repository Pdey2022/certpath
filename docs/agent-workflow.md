# Agent workflow: ARC, DEV and PROF

CertPath is built by three agents with a hard boundary between deciding, doing
and checking, and one human who approves.

| Role | Agent | May | May not |
|---|---|---|---|
| Solution architect | [`arc`](../.github/agents/arc.agent.md) | read, search, research, design, review, file issues | edit code, run shell commands, merge, deploy |
| Senior developer | [`dev`](../.github/agents/dev.agent.md) | read, edit, run tests and builds, open and update draft PRs | change product rules, change architecture, merge, deploy |
| Content reviewer | [`prof`](../.github/agents/prof.agent.md) | read item batches outside the repository, run the committed validator, apply the content rubric, report findings | edit anything, rewrite item text, reach the network, approve content, import, merge, deploy |
| Owner | you | approve designs, approve merges, approve provisioning and deployment, approve content, signalled import | — |

**PROF is an automated content pre-check. It is not a reviewer of record, it does not satisfy the "author ≠ reviewer" requirement in ADR 0006, and its verdict is not an approval of content, of an import, of a merge, of a deployment or of a provisioning step. Only the owner signs off content.**

## The pipeline

There are two lanes, and they meet only at the owner.

```
Code lane:     Requirements → ARC design → DEV implementation → Testing → ARC review → Owner approval
Content lane:  Draft (outside repo) → PROF check → PROF rubric review → Owner SME review → Owner-signalled import → publish
```

| Stage | Owner | Input | Output | Gate |
|---|---|---|---|---|
| C1 Draft | author (owner / AI-assisted) | blueprint + taxonomy | 41-column CSV batches outside the repo | taxonomy frozen first |
| C2 Mechanical check | tool (run by PROF) | batches, profile, taxonomy | `question-check-report.json` + exit code | exit 0, `verdict` ∈ {pass, pass_with_findings} |
| C3 Rubric review | PROF | report + the items | `prof-findings.json` + `prof-review.md` | every warning acknowledged |
| C4 Combined verdict | PROF + tool | report + findings | `question-review-verdict.json` | `pass` / `pass_with_findings` |
| C5 SME review | owner | the batches + the verdict | owner's own decision | **the reviewer of record** |
| C6 Import | owner/operator | approved batches | rows via the existing driver | separate slice |

The code lane keeps its stages unchanged:

| Stage | Owner | Input | Output | Gate |
|---|---|---|---|---|
| 1. Requirements | owner | a goal in chat | a scoped issue or milestone slice | the owner has said what "done" means |
| 2. Design | ARC | the issue, the code, the ADRs | design under `docs/` or a PR review comment | owner approves the design |
| 3. Implementation | DEV | an approved design | branch + draft PR | design is written, not remembered |
| 4. Testing | DEV | the design's test plan | `npm run verify` output, fresh-D1 migration check, CI run | evidence, not claims |
| 5. Review | ARC | the PR diff + DEV's evidence | blocking / gap / nit findings + verdict | verdict is explicit |
| 6. Approval | owner | everything above | merge, or changes required | only the owner merges |

Stages do not skip. A DEV change without a design is a design review waiting to
happen, an ARC verdict without evidence is an opinion, and a batch without a
combined verdict is a draft nobody checked.

## Handoff contracts

**ARC → DEV.** The design must contain scope, decision, data changes, interface,
security, failure modes, acceptance criteria and test plan — enough that DEV
never has to guess a product rule. If a design omits one, DEV asks before
writing code.

**DEV → ARC.** A draft PR using `.github/PULL_REQUEST_TEMPLATE.md`, plus:

- `npm run verify` — the command and its actual result, with counts;
- the migration chain applied to a fresh local D1, in order;
- the CI run URL and conclusion for the PR head;
- the judgement calls DEV had to make, named rather than buried;
- every place the design did not survive contact with the code.

**ARC → owner.** A verdict — approve, approve with follow-ups filed, or changes
required — and, when relevant, the product decision that needs the owner rather
than the architect (pricing, roles, retention, what a learner sees, any spend).

**ARC/DEV → PROF.** The batches, the committed profile and taxonomy, and the
command line the operator used to run the validator. PROF receives no credential
and no session: if a content check needs one, it has become an import and must
stop. Anything PROF needs that is a code, contract or profile change is escalated
to ARC, never patched into the tool.

**PROF → owner.** The batches, the tool report, `prof-findings.json` and the
combined `question-review-verdict.json`, all outside the repository. Every
warning in the report carries an acknowledgement: `not-a-defect`, `accepted` or
`defect`, with a reason. A `fail` verdict goes back to the author instead, and
nothing is put in front of the owner as ready to read.

**PROF → ARC.** Escalations only: a check that needs to exist, a threshold that
looks wrong, a taxonomy whose prose is blank, an item that reads like an
instruction, and any case where the only way to pass a batch would be to weaken
a rule. PROF never comments on a code pull request and never reviews
`tools/question-check/` source; that is ARC's review of DEV's implementation.

## Rules that keep the boundary real

- **Single writer.** Only DEV edits the repository. ARC has no edit tools, and
  PROF has none either, so a change either one needs must be expressed precisely
  enough to implement.
- **Only DEV edits the repository. Only the owner approves: a merge, a deployment, a provisioning step, an import into any database, and the content itself.** ARC approves designs. PROF pre-checks content on the owner's behalf and its verdict is advisory. None of the three agents approves any of those five things.
- **Only the owner approves content.** An automated consistency check is not a
  second opinion. A PROF verdict authorises exactly one thing: offering the batch
  to the owner for review.
- **Evidence over assertion.** "Tests pass" is not evidence. The command and its
  result are. For content that means the validator's command line, exit code and
  per-file digests — a pasted report can be stale and cannot be checked.
- **No silent product decisions.** Anything not covered by
  `docs/product-design.md`, `docs/delivery-plan.md` or an ADR goes to the owner.
  A decision that is made gets recorded — ADR for durable rules,
  `docs/open-decisions.md` for the register.
- **Findings become work.** Blocking items are fixed before merge; gaps and nits
  become issues in the milestone, not folklore.
- **$0 and unattended by default.** No deployment, no provisioning, no outbound
  email, no paid integration. ARC escalates; DEV never starts one.

## Using the agents in VS Code

All three agents live in `.github/agents/` and are picked from the agent/model
selector in chat (Agent picker → `arc`, `dev` or `prof`). They are BYOK DeepSeek
models in this setup:

| Agent | `model:` in frontmatter | Use |
|---|---|---|
| `arc` | `deepseek/deepseek-v4-pro` | design and review: the reasoning-heavy half |
| `dev` | `deepseek/deepseek-v4-pro` | implementation; switch to `deepseek/deepseek-v4-flash` for mechanical edits and doc fixes |
| `prof` | `deepseek/deepseek-v4-pro` | rubric judgement, which is the same reasoning-heavy work as review |

If the model id does not match what your picker shows, change the `model:` line
to the name in the picker; agent discovery and behaviour do not depend on it.
The tool lists are the real boundary: `arc` has no `edit` and no `execute`;
`prof` has `execute` (it must run the validator itself) but no `edit` and no
`web`.

## A worked example

Phase 2 ran this way by hand, and is the pattern to repeat:

1. The owner asked for readiness and a dashboard.
2. Design: `docs/readiness.md` — formula v1, snapshot table, interface, failure
   modes, acceptance criteria.
3. Implementation: one PR for the engine and audit trail, a second for the
   contract and UI. Two PRs because they have different review risks, not
   because the milestone was too big.
4. Evidence: `npm run verify` counts, fresh-D1 migration output, and the two
   tests that fail when the migration is reverted.
5. Review: the architect found a real defect — an audit trigger that wrote both
   an actor and a service reference, so no audited grant could be written.
6. The owner merged after the fix and green CI.

The defect is the point: the review stage is worth its round trip precisely when
it finds something CI cannot see. The content lane exists for the same reason —
the validator finds what a single reading misses, and the owner's read finds what
the validator cannot.
