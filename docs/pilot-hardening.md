# Pilot hardening: Phase 5 slices

Phase 5 (#48) turns the tester-only build into something that can hold one real
learner's data without losing it. It is deliberately split into six slices so
each one can be reviewed, approved and rolled back on its own. This file records
the slices, their order, their migration reservations and the decisions each one
needs.

Status: **5A approved by the owner and in review.** Nothing in Phase 5 has been
deployed or provisioned.

## Slices

| Slice | Scope | Depends on | Migration | Approval |
|---|---|---|---|---|
| **5A Data-safety tooling** | D1 isolation gate, export + manifest, rehearsed restore, fresh-chain check, `verify` wiring, export runbook | - | none (`db/migrations/checksums.txt` is not a migration) | **Approved 17 Nov 2026** |
| **5B Pilot funnel events** | `pilot_events` (consent-aware, no personal data), the events that the fake door needs | 5A (so a pre-migration export exists), 5C (a database to write to) | **0021** | ARC design + owner approval of *what* is recorded |
| **5C Provisioning** | Dedicated staging D1, then the pilot D1: create, record ids, apply the chain, export before the first migration, rehearse it, seed one invited learner | 5A, owner approval | uses the existing chain | **Owner approval required**: creates Cloudflare resources |
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

## Resolved decisions

| Decision | Outcome | Date |
|---|---|---|
| Export retention | Keep the last 3 dumps; delete 14 days after the migration is confirmed; never commit or upload a dump | Owner decision, 17 November 2026 |

## Open decisions that still block Phase 5

- 5B: exactly which funnel events are recorded and under what consent wording
  (ARC, then owner).
- 5C: account/plan posture for the isolated staging database (owner).
- 5D: the price point to validate and what "demand" means (owner).
- 5E: canonical hostname and whether the pilot keeps a `workers.dev` origin
  (owner).
- 5F: the MFA method that replaces `tester-gate` (ARC, then owner).
- Scheduling and enforcement of the retention rule: 5A states the rule and ships
  the tooling; automation is not in scope.

## Not in 5A

No migration, table, binding, route, Worker var, deployment workflow or runtime
dependency. No Cloudflare resource is created, read or written. No dump is
scheduled. No pre-existing migration is modified. Phase 4 residue (staff refunds,
refund UI, the `needs_support` money policy, receipts cursor) stays out.
