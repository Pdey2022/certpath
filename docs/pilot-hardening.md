# Pilot hardening: Phase 5 slices

Phase 5 (#48) turns the tester-only build into something that can hold one real
learner's data without losing it. It is deliberately split into six slices so
each one can be reviewed, approved and rolled back on its own. This file records
the slices, their order, their migration reservations and the decisions each one
needs.

Status: **5A approved by the owner and in review; 5B (pilot funnel events) is
implemented on a draft PR with its design approved by the owner on 17 November
2026; 5C is narrowed to one staging database with no learner, design approved by
the owner on 17 November 2026 to implement, and not approved to run.** Nothing in
Phase 5 has been deployed or provisioned, and both funnel flags are `"false"`.

## Slices

| Slice | Scope | Depends on | Migration | Approval |
|---|---|---|---|---|
| **5A Data-safety tooling** | D1 isolation gate, export + manifest, rehearsed restore, fresh-chain check, `verify` wiring, export runbook | - | none (`db/migrations/checksums.txt` is not a migration) | **Approved 17 Nov 2026** |
| **5B Pilot funnel events** | `pilot_events` (consent-aware, no personal data), the events that the fake door needs | 5A (export/restore tooling), 5C (a database to write to) | **0021** | **Design approved 17 Nov 2026**; the consent-issuing surface is 5D and `PILOT_SERVER_EVENTS_ENABLED` is unblocked but not enabled |
| **5C Provisioning** | One isolated staging D1 (`certpath-learner-staging`): preflight, create, apply the chain, record the id, export #1, rehearse, apply the synthetic smoke fixture, export #2, rehearse #2. **No learner, no pilot database, no Worker, no secret.** | 5A, owner approval | uses the existing chain | **Design approved 17 Nov 2026 to implement, NOT approved to run**; [runbook](pilot-provisioning.md) |
| **5D Fake door** | Price validation without taking payment | 5B (funnel), 5E (hostname) | none | Owner approval: product and pricing rule |
| **5E Hostname decision** | Canonical pilot hostname and routing | 5C | none | **Owner approval required**: brand, domain, canonical origin |
| **5F MFA before real learners** | Replace the `tester-gate` assurance with a real second factor | 5C, ADR 0004 | **0022** | ARC design + owner approval: access policy |

Order: **5A -> 5C -> 5B**, with 5E parallel to 5B and 5D after both. 5F gates the
first real learner, not the first database.

## Migration reservations

- `0021` is reserved for 5B (`pilot_events`).
- `0022` is reserved for 5F (assurance/MFA).
- 5A adds no migration. The only file it adds under `db/migrations/` is
  `checksums.txt`; no existing migration is edited.

A slice may only take the next unused number when it lands. If another slice
lands first, renumber before writing the file and add its checksum line.

## What 5A ships

| Piece | Where |
|---|---|
| Isolation gate | `apps/web/scripts/check-d1-isolation.mjs` |
| Export + manifest | `apps/web/scripts/d1-export.mjs` |
| Rehearsed restore | `apps/web/scripts/d1-restore-rehearse.mjs` |
| Fresh-chain check | `apps/web/scripts/d1-chain-check.mjs` |
| Pure rules + unit tests | `apps/web/scripts/lib/d1-targets.mjs` |
| Checksums | `db/migrations/checksums.txt` |
| Runbook | `docs/data-export-and-restore.md` |

`npm run verify` now runs the isolation gate first and the chain check before the
build, so a broken chain fails verification instead of reporting a green summary.

## What 5B ships

| Piece | Where |
|---|---|
| `pilot_events` + `pilot_event_names`, guards, indexes | `db/migrations/0021_pilot_events.sql` |
| Checksum line for 0021 | `db/migrations/checksums.txt` |
| Wire contract (request, acceptance, error codes) | `packages/contracts/src/analytics.ts` |
| Recorder, consent verifier, `POST /api/events` | `apps/api/src/analytics/pilot-events.ts` |
| Funnel measurement query | `apps/api/src/analytics/funnel.ts` |
| Server writes beside checkout and settlement | `apps/api/src/commerce/checkouts.ts`, `apps/api/src/commerce/webhooks.ts` |
| Flags, both `"false"` | `apps/web/wrangler.jsonc` |

Two flags, because either half must be switchable alone:
`PILOT_EVENTS_ENABLED` (the browser endpoint) and `PILOT_SERVER_EVENTS_ENABLED`
(the three server writes). Both are exact-string gates, like `COMMERCE_ENABLED`.

5B ships the consent **verifier only**. There is no consent banner, no copy and no
issuing route: the owner approved explicit opt-in with a 180-day cookie issued in
5D. On a real origin no `pilot_consent` cookie exists, so the endpoint writes
nothing even with the flag on — inertness by construction, not only by flag.

Conversion is computed from `commerce_checkouts`, never from events, so a lost
event cannot move the reported rate; the event-side counts sit beside it and
`eventGap` makes the loss visible. `createCheckout` and `settleCompletedEvent`
answer identically whether the recorder is off or fails.

### Retention precondition

The owner decided on 17 November 2026 that `pilot_events` is retained for **12
months, for both `source = 'browser'` and `source = 'server'`**. That is the
period, not the enforcement: 0021 ships **no delete path and no delete-floor
trigger**, and nothing in the codebase deletes from `pilot_events`.

**Enforcing the 12-month floor is a precondition for enabling
`PILOT_EVENTS_ENABLED` — it is not part of 5B.** The enforcement lands in its own
review (clock semantics, D1 clock skew, and what withdrawal does to stored
history) and needs its own migration: issue #110. Enabling the flag before that
enforcement exists would create a table with a stated retention period and no
mechanism that delivers it.

The same floor is a precondition for enabling `PILOT_SERVER_EVENTS_ENABLED`: the
consent question for server rows is resolved (owner, 17 November 2026 — not
required), but the flag stays `"false"` until the retention floor exists.

## What 5C ships

| Piece | Where |
|---|---|
| Read-only account/database preflight | `apps/web/scripts/d1-account-preflight.mjs`, `npm run db:preflight` |
| Preflight assertions + unit tests | `apps/web/scripts/lib/d1-targets.mjs`, `d1-targets.test.mjs` |
| Generated-preview-config guard (build and deploy, no `d1_databases`) | `apps/web/scripts/preview-command.mjs` |
| Synthetic smoke fixture (never applied by migrations or CI) | `db/fixtures/synthetic-provision-smoke.sql` |
| Provisioning design and runbook | [`docs/pilot-provisioning.md`](pilot-provisioning.md) |

5C creates nothing in this PR. It adds the assertions that must pass before a
resource is created, and the runbook for the run that creates it. The one
resource that run will ever create is the staging database; the pilot database,
the learner and the Worker deployment all stay out.

## Resolved decisions

| Decision | Outcome | Date |
|---|---|---|
| Export retention | Keep the last 3 dumps; delete 14 days after the migration is confirmed; never commit or upload a dump | Owner decision, 17 November 2026 |
| Server-originated event consent | **Not required.** Checkout/settlement server rows are written with `consent = 'not-required'`, carry no session id and need no consent reference; `PILOT_SERVER_EVENTS_ENABLED` is unblocked but stays `"false"` until the retention floor (#110) and an enablement decision | Owner decision, 17 November 2026 |
| 5C scope | **One staging database, no learner.** `certpath-learner-staging` is the only resource 5C will ever create; the pilot database and the invited learner are withdrawn because no real learner data exists until MFA replaces the tester-gate assurance ([`docs/delivery-plan.md`](delivery-plan.md) §Operating constraints) | Owner decision, 17 November 2026 |

## Open decisions that still block Phase 5

- 5D: the price point to validate and what "demand" means (owner).
- 5E: canonical hostname and whether the pilot keeps a `workers.dev` origin
  (owner).
- 5F: the MFA method that replaces `tester-gate` (ARC, then owner).
- Scheduling and enforcement of the retention rule (#110): 5A states the rule and
  ships the tooling; automation is not in scope.

## Not in 5A

No migration, table, binding, route, Worker var, deployment workflow or runtime
dependency. No Cloudflare resource is created, read or written. No dump is
scheduled. No pre-existing migration is modified. Phase 4 residue (staff refunds,
refund UI, the `needs_support` money policy, receipts cursor) stays out.

## Not in 5C

No migration or `db/migrations/` change, no checksum change, no dependency, no
secret, no deploy workflow change, no Worker binding, var or code path, and no
Cloudflare resource. The `database_id` values stay the all-zero placeholder until
the owner-approved run records one.
