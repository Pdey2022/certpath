# Readiness

How the platform decides whether a learner is ready to sit the real exam, and
what it tells them. Evaluation is `apps/api/src/readiness.ts`; storage is
`readiness_snapshots`; the loader is
`apps/api/src/security/readiness-snapshots.ts`.

Rules: [ADR 0005](decisions/0005-readiness-and-access-lifecycle.md).

## Two numbers, two jobs

| Value | Question it answers | Used for |
|---|---|---|
| `isReady` | has this learner met the promotion rule? | the Pro prompt, promotion |
| `score` + `band` | what form are they in right now? | the dashboard display |

They are deliberately separate, and the difference is a real product case: a
learner can be in form (`band: ready`, score 75+) from one strong mock while
still failing the two-of-three rule, so the Pro prompt stays closed. Every
display carries its basis ("2 mocks, 20 questions, blueprint-weighted") so the
learner can see why.

## The promotion rule (`isReady`)

Ready when **either** path passes:

- **recent mocks** — at least 2 of the last 3 timed mocks score >= 70% overall
  and >= 55% in every domain present in that mock; or
- **coverage** — at least 75% of the published questions have been answered and
  the latest mock scores >= 65%.

Unanswered items inside a mock count as wrong; the clock does not forgive them.

## The display score

Blueprint-weighted accuracy pooled across the last 3 completed mocks:

1. For each domain, pool correct and total across those mocks.
2. Weight each domain by its share of the exam version's published questions.
3. `score` is the weighted average, rounded to a whole percent.

Domains with no attempts are excluded from the score and the weights are
renormalised. With no published blueprint at all, the score falls back to raw
pooled accuracy. Practice never contributes to the score - practice-only
activity cannot inflate readiness, and a test asserts it.

Bands: `low` below 50, `medium` 50-74, `ready` 75 and above.

## Next action

One suggestion, not a plan: the weakest domain by accuracy, weighted by the
blueprint, with recency as the tiebreak. A domain with no attempts counts as
accuracy 0, so a learner who has only touched one domain is pointed at another
rather than deeper into the one they already know. No streaks, no daily goals.

## Decay

A snapshot older than **14 idle days** is no longer current: it is not promoted
on and not shown as the current band. Snapshots are recomputed when a mock
completes, never on read, so a stale snapshot stays stale until the learner sits
another mock. `isReadinessCurrent()` is the single check.

## Storage

`readiness_snapshots` is append-only (triggers reject update and delete) and
records the formula version, band, score, basis, next action and the mock that
triggered it. `source_attempt_id` is unique, so re-observing the same completed
mock cannot append a second row — a test drives the real submit and re-read path
to prove it.

Nothing is backfilled: snapshots start existing when this migration ships.

## On the dashboard

`/api/dashboard` returns, per exam:

- `access` — `state` (`active` / `grace` / `expired`), `endsAt`, `graceEndsAt`
  and `graceDaysRemaining`, resolved by `apps/api/src/entitlements.ts`.
- `readiness` — `band`, `score`, `isReady`, `isCurrent`, `computedAt`, `basis`,
  `nextAction` and `proPrompt`, or `null` before the first completed mock.

The read path is read-only: it never computes or stores readiness. A stale
snapshot is shown as stale ("sit another timed mock") rather than refreshed, and
`band` is labelled as form ("Early days", "Building up", "In form") while
readiness is stated separately, so a learner never reads "Ready" from the band
alone.

Grace behaves as ADR 0005 describes: the exam stays on the dashboard with a
countdown and a renewal prompt, and its attempt history is withheld. An expired
membership drops off the dashboard entirely.

`proPrompt` is `isCurrent && isReady && proOffered(exam) && >= 90 days Standard
remaining`. `proOffered()` returns `false` for every exam until the CAT engine
gives an exam an adaptive capability in Phase 6 and checkout exists in Phase 4,
so nothing is advertised early.
