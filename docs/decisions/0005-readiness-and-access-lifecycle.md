# ADR 0005: Readiness signal and access lifecycle

- Status: Accepted, with owner approval on 2026-11-14.
- Scope: Learner-facing readiness, the dashboard's next action, and what happens
  when a membership expires.

## Context

Pro is a confidence-stage purchase: a learner buys it when they believe they are
close to sitting the real exam. Without a defensible readiness signal, the Pro
prompt is a marketing guess, and an explicit readiness percentage becomes an
unsupported promise. Separately, `docs/open-decisions.md` left post-expiry
readability undecided, which blocks both the entitlement model and the dashboard.

## Decision

### Readiness v1 (versioned formula, server-computed)

A certification is **ready** when either:

- at least 2 of the last 3 timed mocks score **>= 70% overall** and **>= 55% in
  every domain**, or
- question coverage is **>= 75%** and the latest mock is **>= 65%**.

Readiness is computed from attempts and blueprint weights, never from practice
clicks alone, and is stored as a timestamped snapshot so it is auditable and
comparable over time. The formula is versioned (`readiness v1`) so a change is
explainable rather than mysterious.

**Bands shown to learners:** Low `< 50`, Medium `50-74`, Ready `75+`. Every
display carries its basis ("3 mocks, 412 questions, blueprint-weighted").

**Decay:** a readiness snapshot older than **14 idle days** no longer counts as
current for promotion or display; it is recomputed on the next attempt.

### Next action

The dashboard proposes one action: the **weakest domain by accuracy, weighted by
the exam blueprint**, with recency as the tiebreak. No streaks, no daily goals -
the product stays a quiet professional tool.

### Access lifecycle

Three states per membership:

| State | Access |
|---|---|
| Active | everything the membership includes |
| **Grace** (15 days after expiry) | read results and explanations for answered questions; no new attempts, no new practice |
| Expired | locked; history retained, not shown |

The dashboard shows the remaining grace days with a renewal action. Grace is a
read state, not an entitlement: it never permits new questions or mocks.

## Alternatives considered

- _Coverage-only readiness_: easy to raise by clicking through easy questions, so
  it rewards gaming rather than exam readiness.
- _Mocks-only readiness_: ignores a learner who has answered the whole bank but
  sat one bad mock.
- _No decay_: readiness bought in month 1 would still say "ready" in month 9.
- _Percentage without bands_: invites false precision at +/-15 points of noise.
- _Lock everything at expiry_: loses the renewal conversation at exactly the
  moment the learner is closest to value.
- _Grace with new attempts_: extends the product for free and breaks the
  entitlement boundary.

## Consequences

- Readiness needs attempt, domain, and blueprint data that Milestone 3 already
  records; no new tracking surface is required.
- The Pro prompt is `readiness = ready AND proEnabled AND standard remaining >=
  90 days` - one query, one place.
- The readiness percentage is a customer-facing promise, so its basis line, its
  version, and its decay are part of the API contract, not presentation.
- Grace days must be part of `canAccess()`; a route that ignores the state is a
  bug, testable by asserting no new attempt can start during grace.
