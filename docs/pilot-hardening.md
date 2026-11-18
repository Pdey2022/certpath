# Pilot hardening: Phase 5 slices

Phase 5 (#48) turns the tester-only build into something that can hold one real
learner's data without losing it. It is deliberately split into six slices so
each one can be reviewed, approved and rolled back on its own. This file records
the slices, their order, their migration reservations and the decisions each one
needs.

Status: **5A, 5B and 5C are merged, and the 5C run completed on 17 November
2026.** That run created `certpath-learner-staging` (17 November 2026 at
22:25:00Z, region `WEUR`) and migrated it through `0021_pilot_events.sql` (21
applied migrations), recorded its id in #134, and exported and rehearsed twice to
exit 0. **No Worker is deployed, and no secret, route or
deployment exists**: `learner-auth-staging` answers `code: 10007` (not found),
checked 18 November 2026. `0022_pilot_events_retention.sql` was applied to that
database on 18 November 2026, under owner approval, so it now holds **22 applied
migrations**, last `0022_pilot_events_retention.sql`, and the retention floor is
enforced there as well (see §Retention precondition); both funnel flags and
`PILOT_EVENTS_RETENTION_ENABLED` are `"false"`. #141 decides the staging Worker is
the events target, **in code only**; see §Events target below.

## Slices

| Slice | Scope | Depends on | Migration | Approval |
|---|---|---|---|---|
| **5A Data-safety tooling** | D1 isolation gate, export + manifest, rehearsed restore, fresh-chain check, `verify` wiring, export runbook | - | none (`db/migrations/checksums.txt` is not a migration) | **Approved 17 Nov 2026** |
| **5B Pilot funnel events** | `pilot_events` (consent-aware, no personal data), the events that the fake door needs | 5A (export/restore tooling), 5C (a database to write to) | **0021** | **Design approved 17 Nov 2026**; the consent-issuing surface is 5D and `PILOT_SERVER_EVENTS_ENABLED` is unblocked but not enabled |
| **5C Provisioning** | One isolated staging D1 (`certpath-learner-staging`): preflight, create, apply the chain, record the id, export #1, rehearse, apply the synthetic smoke fixture, export #2, rehearse #2. **No learner, no pilot database, no Worker, no secret.** | 5A, owner approval | uses the existing chain | **Run completed 17 Nov 2026**: database created (22:25:00Z, `WEUR`) and migrated (21 migrations), id recorded in #134, both exports rehearsed to exit 0; [runbook](pilot-provisioning.md) |
| **5D Fake door** | Price validation without taking payment | 5B (funnel), 5E (hostname) | none | Owner approval: product and pricing rule |
| **5E Hostname decision** | Canonical pilot hostname and routing | 5C | none | **Owner approval required**: brand, domain, canonical origin |
| **5F MFA before real learners** | Replace the `tester-gate` assurance with a real second factor | 5C, ADR 0004 | **0023** | ARC design + owner approval: access policy |

Order: **5A -> 5C -> 5B**, with 5E parallel to 5B and 5D after both. 5F gates the
first real learner, not the first database.

## Migration reservations

- `0021` is reserved for 5B (`pilot_events`).
- `0022` is taken by the `pilot_events` retention floor (#110), which landed
  ahead of 5F; see [`docs/pilot-events-retention.md`](pilot-events-retention.md).
- `0023` is reserved for 5F (assurance/MFA).
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
months, for both `source = 'browser'` and `source = 'server'`**. 0021 shipped the
period without the enforcement, deliberately.

**The enforcement has landed (#110, `0022`).** `0022_pilot_events_retention.sql`
adds the `received_at` index and `pilot_events_no_delete`, a floor that compares
`received_at` with D1's own clock; `apps/api/src/analytics/pilot-events-retention.ts`
adds a bounded, idempotent prune that the Worker's `scheduled` handler runs only
when `PILOT_EVENTS_RETENTION_ENABLED` is exactly `"true"` — and it is `"false"`
here. The withdrawal question that held the review open is resolved: withdrawal
stops future events and stored history keeps the full window, so there is no
erasure path and no exception to the floor (owner, 18 November 2026). Design,
failure modes and rollback: [`docs/pilot-events-retention.md`](pilot-events-retention.md).

**The floor is installed in the staging database too.** `0022` was applied
remotely to `certpath-learner-staging` on 18 November 2026, under owner approval:
that database now holds **22 applied migrations**, last
`0022_pilot_events_retention.sql`, and the run verified
`pilot_events_no_delete` (trigger) and `pilot_events_received_at_idx` (index) in
`sqlite_master`. Evidence and the stop rule:
[`docs/pilot-provisioning.md`](pilot-provisioning.md) §Pre-enablement step.

The floor is no longer the blocker for the events flags; the remaining
precondition is the owner's enablement decision. Both
`PILOT_EVENTS_ENABLED` and `PILOT_SERVER_EVENTS_ENABLED` stay `"false"` until
then, and the scheduled prune stays off until the owner turns it on: with it off
the table accumulates rows and nothing is removed automatically, though every
in-window delete is still refused by storage. The prune is now also declared for
the staging Worker, which is the events target — code only, not deployed
(§Events target below).

### Events target (#141): staging, in code only

Closed by owner decision on 18 November 2026. The Worker that will record and
prune pilot events is the **staging** Worker, `learner-auth-staging`, configured
by `apps/web/wrangler.staging.jsonc`:

- the config declares the same `*/5 * * * *` cron as `wrangler.jsonc`, and the
  three events flags, all `"false"` — `PILOT_EVENTS_ENABLED`,
  `PILOT_SERVER_EVENTS_ENABLED`, `PILOT_EVENTS_RETENTION_ENABLED`;
- `apps/web/workers/staging-app.ts` has a `scheduled` handler that calls
  `schedulePilotEventRetention` in
  `apps/web/workers/pilot-events-retention-schedule.ts`. With every flag
  `"false"` the cron fires and does nothing: the gate returns before
  `ctx.waitUntil`, so no statement is prepared and no row is read;
- the handler does not reuse `app.ts`'s handler, which would also run
  question-import cleanup, audit retention and commerce expiry against the
  staging database;
- nothing is deployed, no flag is turned on, no secret is set, and no route,
  capability or migration is added. `apps/web/wrangler.jsonc` is unchanged and
  still binds the all-zero `certpath-local` placeholder.

**What remains before events can be recorded and pruned:** applying `0022` is
done (the staging database holds 22 applied migrations, last
`0022_pilot_events_retention.sql`, 18 November 2026 —
[`docs/pilot-provisioning.md`](pilot-provisioning.md) §Pre-enablement step). What
remains:

1. deploy the staging Worker (an owner-approved deployment; the cron ships with
   the deployment and stays a no-op until step 3);
2. measure the cron's CPU cost for a 250-row prune against Free's 10 ms limit
   (#147) — the prune has never run on a deployed Worker, so the batch's cost
   against the cap is unproven;
3. turn `PILOT_EVENTS_RETENTION_ENABLED` on (owner decision) — not before;
4. only then consider `PILOT_EVENTS_ENABLED` / `PILOT_SERVER_EVENTS_ENABLED`: the
   coupling test refuses an events flag that is `"true"` while retention is not,
   because that would promise a twelve-month period nothing delivers.

Until step 1, the staging `scheduled` handler is exercised only by
`apps/api/test/pilot-events-retention.test.ts`, which drives it against the real
`0022` schema in the local runtime. No deployed Worker has run it, so the
schedule is verified by the committed configuration and that test, not by an
invocation.

## What 5C ships

| Piece | Where |
|---|---|
| Read-only account/database preflight | `apps/web/scripts/d1-account-preflight.mjs`, `npm run db:preflight` |
| Preflight assertions + unit tests | `apps/web/scripts/lib/d1-targets.mjs`, `d1-targets.test.mjs` |
| Generated-preview-config guard (build and deploy, no `d1_databases`) | `apps/web/scripts/preview-command.mjs` |
| Synthetic smoke fixture (applied in CI only to a throwaway local D1; never by migrations) | `db/fixtures/synthetic-provision-smoke.sql` |
| Provisioning design and runbook | [`docs/pilot-provisioning.md`](pilot-provisioning.md) |

5C itself created nothing: it added the assertions that had to pass before a
resource was created, and the runbook for the run that created it. The one
resource that run created is the staging database; the pilot database, the
learner and the Worker deployment stayed out.

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
- Enabling the retention prune and the events flags (owner). The enforcement
  itself landed in `0022` (#110); what is left is the decision to turn
  `PILOT_EVENTS_RETENTION_ENABLED`, `PILOT_EVENTS_ENABLED` and
  `PILOT_SERVER_EVENTS_ENABLED` on — and, before any of that, deploying the
  staging Worker that now owns them (#141).

## Not in 5A

No migration, table, binding, route, Worker var, deployment workflow or runtime
dependency. No Cloudflare resource is created, read or written. No dump is
scheduled. No pre-existing migration is modified. Phase 4 residue (staff refunds,
refund UI, the `needs_support` money policy, receipts cursor) stays out.

## Not in 5C

No migration or `db/migrations/` change, no checksum change, no dependency, no
secret, no deploy workflow change, no Worker binding, var or code path, and no
Cloudflare resource. When the slice landed, every `database_id` was the all-zero
placeholder; the approved run on 17 November 2026 has since recorded the staging
id (#134), so only `local` and `pilot` remain placeholders.
