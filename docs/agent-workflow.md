# Two-agent workflow

CertPath is built by two agents with a hard boundary between deciding and doing,
and one human who approves.

| Role | Agent | May | May not |
|---|---|---|---|
| Solution architect | [`arc`](../.github/agents/arc.agent.md) | read, search, research, design, review, file issues | edit code, run shell commands, merge, deploy |
| Senior developer | [`dev`](../.github/agents/dev.agent.md) | read, edit, run tests and builds, open and update draft PRs | change product rules, change architecture, merge, deploy |
| Owner | you | approve designs, approve merges, approve provisioning and deployment | — |

## The pipeline

```
Requirements → ARC design → DEV implementation → Testing → ARC review → Owner approval
```

| Stage | Owner | Input | Output | Gate |
|---|---|---|---|---|
| 1. Requirements | owner | a goal in chat | a scoped issue or milestone slice | the owner has said what "done" means |
| 2. Design | ARC | the issue, the code, the ADRs | design under `docs/` or a PR review comment | owner approves the design |
| 3. Implementation | DEV | an approved design | branch + draft PR | design is written, not remembered |
| 4. Testing | DEV | the design's test plan | `npm run verify` output, fresh-D1 migration check, CI run | evidence, not claims |
| 5. Review | ARC | the PR diff + DEV's evidence | blocking / gap / nit findings + verdict | verdict is explicit |
| 6. Approval | owner | everything above | merge, or changes required | only the owner merges |

Stages do not skip. A DEV change without a design is a design review waiting to
happen, and an ARC verdict without evidence is an opinion.

## Handoff contract

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

## Rules that keep the boundary real

- **Single writer.** Only DEV edits the repository. ARC has no edit tools, so a
  design that needs a change must be expressed precisely enough to implement.
- **Evidence over assertion.** "Tests pass" is not evidence. The command and its
  result are.
- **No silent product decisions.** Anything not covered by
  `docs/product-design.md`, `docs/delivery-plan.md` or an ADR goes to the owner.
  A decision that is made gets recorded — ADR for durable rules,
  `docs/open-decisions.md` for the register.
- **Findings become work.** Blocking items are fixed before merge; gaps and nits
  become issues in the milestone, not folklore.
- **$0 and unattended by default.** No deployment, no provisioning, no outbound
  email, no paid integration. ARC escalates; DEV never starts one.

## Using the agents in VS Code

Both agents live in `.github/agents/` and are picked from the agent/model
selector in chat (Agent picker → `arc` or `dev`). They are BYOK DeepSeek models
in this setup:

| Agent | `model:` in frontmatter | Use |
|---|---|---|
| `arc` | `deepseek/deepseek-v4-pro` | design and review: the reasoning-heavy half |
| `dev` | `deepseek/deepseek-v4-pro` | implementation; switch to `deepseek/deepseek-v4-flash` for mechanical edits and doc fixes |

If the model id does not match what your picker shows, change the `model:` line
to the name in the picker; agent discovery and behaviour do not depend on it.
The tool lists are the real boundary: `arc` has no `edit` and no `execute`.

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
it finds something CI cannot see.
