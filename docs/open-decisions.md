# Open decisions

These are not defaults. Do not implement or communicate them as settled product
rules. Resolved items are listed with the record that closed them; the rest still
need an owner or architect decision.

## Resolved (14 November 2026)

| Decision | Outcome | Record |
|---|---|---|
| Price ladder | $59 / $89 / $129 (3 / 6 / 12 months), USD | [ADR 0003](decisions/0003-pricing-pro-and-refunds.md) |
| Pro price and rules | $49 flat, 3 calendar months, CAT exams only, requires Standard coverage of a full Pro term (90 days kept as a display-only constant) | ADR 0003, amended 2026-11-16 |
| Refunds | 7 days, no questions, one per account per exam | ADR 0003 |
| Free sample | Guest sample: 10 questions + a mini mock, no account | ADR 0003 |
| Recurring vs fixed term | Fixed-term one-off; no recurring at launch | ADR 0003 |
| Pro repurchase | Sold again once the stored Pro window has ended, while Standard still covers a full Pro term | ADR 0003, amended 2026-11-16 |
| Post-expiry readability | 15-day read-only grace, then locked | [ADR 0005](decisions/0005-readiness-and-access-lifecycle.md) |
| Readiness definition | v1 formula, bands 50/75, 14-day decay | ADR 0005 |
| Learner dashboard behaviour | Readiness + next action; no streaks or goals | ADR 0005 |
| Staff capability boundary | Money/entitlements/staff/security = Global Admin only | [ADR 0004](decisions/0004-staff-capabilities-and-learner-data.md) |
| Learner data access | Managers platform-wide, masked, audited reveal; 12-month audit retention | ADR 0004 |
| Content supply | In-house authored, ~600 per exam, English, text only | [ADR 0006](decisions/0006-content-and-operations-posture.md) |
| Analytics | Cloudflare Web Analytics plus own consent-aware D1 events | ADR 0006 |
| Staging | Previews share production D1 today; isolated D1 required | ADR 0006 |
| Price points validated? | **No** - provisional until a fake-door test | ADR 0003 |

## Resolved (16 November 2026, PR B3)

| Decision | Outcome | Record |
|---|---|---|
| A refund that would leave future-but-not-present Standard coverage | **Refused** `409 refund_requires_support`; nothing moves and support resolves it. Every Standard purchase appends to the latest end, so a gap cannot be bought back and granting the refund would lock a paying learner out. | Owner decision, `docs/commerce-refunds.md` §15.1 |
| A provider decline and the one-per-exam cap | The partial unique index excludes `failed`, so a decline that moved no money does not consume the learner's one self-serve refund. A settled refund can never be bypassed. | Owner decision, `0020_refunds.sql` |
| A definitive provider decline | Answers `409 refund_rejected`, not `503 provider_unavailable`: it is a decision, not an outage, and retrying cannot change it. | Owner decision, `docs/commerce-refunds.md` §15.3 |
| Money arriving after a `checkout.failed` | `failed → paid` and `failed → needs_support` are legal. A late `checkout.completed` either grants (grant, receipt, one `paid_at`) or parks in `needs_support`; it never vanishes into an event row no checkout-level queue shows. The five settlement predicates widened with the edge. | `0020_refunds.sql`, `docs/commerce.md` §Failure paths |

## Resolved (17 November 2026)

| Decision | Outcome | Record |
|---|---|---|
| Export retention | Keep the last 3 dumps per target; delete a dump 14 days after the migration it precedes is confirmed; never commit a dump, never upload one | Owner decision, [`docs/data-export-and-restore.md`](data-export-and-restore.md) §Retention |

## Resolved (17 November 2026, Phase 5B)

| Decision | Outcome | Record |
|---|---|---|
| `pilot_events` retention | **12 months, for both `source = 'browser'` and `source = 'server'`.** This is the period only: 0021 ships no delete path and no delete-floor trigger. Enforcing the floor (clock semantics, D1 skew, withdrawal) is its own review, and it is a **precondition for enabling `PILOT_EVENTS_ENABLED`** — see [`docs/pilot-hardening.md`](pilot-hardening.md) §Retention precondition. **Superseded 18 November 2026: the floor landed in `0022`; see the row below.** | Owner decision, 17 November 2026; `db/migrations/0021_pilot_events.sql`, `db/migrations/0022_pilot_events_retention.sql` |
| Consent surface | **Explicit opt-in, no banner, 180-day cookie, issued in 5D.** Decided for 5D, not an ADR requirement; it must not stay ambiguous. 5B ships the verifier only (`apps/api/src/analytics/pilot-events.ts`): no banner, no copy, no issuing route, so a real origin has no `pilot_consent` cookie and `POST /api/events` records nothing. | Owner decision, 17 November 2026; [`docs/pilot-hardening.md`](pilot-hardening.md) §What 5B ships |

## Resolved (17 November 2026, Phase 5C)

| Decision | Outcome | Record |
|---|---|---|
| Consent for server-originated funnel events (`checkout_started`, `purchase_confirmed`, `pro_activated`) | **Not required.** An order-linked server row describes the account's own purchase, not a browsing session: it carries no session id, no identity linkage and `consent = 'not-required'`, and no consent reference is added. `PILOT_SERVER_EVENTS_ENABLED` is therefore **unblocked**, but it stays `"false"` pending an enablement decision. **Amended 18 November 2026:** the 12-month retention floor (#110) now exists — it landed in `0022` and was applied to staging on 18 November 2026. | Owner decision, 17 November 2026; amended 18 November 2026; `db/migrations/0021_pilot_events.sql`, `db/migrations/0022_pilot_events_retention.sql` |
| 5C provisioning scope | **One database only: `certpath-learner-staging`. No learner, no pilot database, no Worker, no secret.** The original slice seeded one invited learner and exported the pilot database; the learner contradicts [`docs/delivery-plan.md`](delivery-plan.md) §Operating constraints ("no real learner data until MFA replaces the tester-gate assurance", 5F), so the learner and the pilot database stay out. The account/plan posture is answered by the same decision: Free plan, $0 stop rule, 7-day Time Travel window. | Owner decision, 17 November 2026; [`docs/pilot-provisioning.md`](pilot-provisioning.md) |

## Resolved (18 November 2026, `pilot_events` retention, #110)

| Decision | Outcome | Record |
|---|---|---|
| Enforcing the twelve-month `pilot_events` retention | **Landed in `0022`.** `pilot_events_no_delete` refuses any delete of a row inside the window using D1's own clock, `pilot_events_received_at_idx` serves the prune's access path, and `cleanupExpiredPilotEvents` removes at most 250 expired rows per run from the Worker's `scheduled` handler. The job runs only when `PILOT_EVENTS_RETENTION_ENABLED` is exactly `"true"`; it is `"false"`. The trigger, not the job, is the guarantee. `0022` takes the number 5F had reserved; 5F moves to `0023`. | Owner decision, 18 November 2026; `db/migrations/0022_pilot_events_retention.sql`, [`docs/pilot-events-retention.md`](pilot-events-retention.md) |
| Consent withdrawal and stored history | **Withdrawal stops future events only.** Events already stored keep their full twelve-month retention: there is no erasure path, no exception to the floor, and no `withdrawal_operation_id` column. A withdrawal is a consent decision with no retention consequence. `docs/analytics-events.md`'s withdrawal sentence now says exactly this. | Owner decision, 18 November 2026 |

## Resolved (18 November 2026, Phase 5F — staff second factor)

| Decision | Outcome | Record |
|---|---|---|
| Lockout policy (design's owner decision 3) | **No account lock. Rate limits only.** No lock or lockout column, no "unlock" route and no counter that can deny a correct code for ever. `staff_mfa_verify` (10/ip, 5/email per 15 min), `staff_mfa_enrol` (10/ip, 3/email per hour) and `staff_recovery_redeem` (10/ip, 3/email per hour) are the whole control; a Global-Admin reset is the recovery path, not an unlock. | Owner decision, 18 November 2026; [`docs/5f-staff-second-factor.md`](5f-staff-second-factor.md) |
| `STAFF_MFA_MAX_AGE_MS` (design's owner decision 4) | **8 hours** — one verification per staff session, matching the session lifetime. | Owner decision, 18 November 2026 |
| `ADMIN_TESTER_IPS` (design's owner decision 2) | **Kept as defence in depth.** The IP allowlist still gates every `/admin` and `/api/admin` path and is *not* an assurance. `stagingTesterGate` and learner traffic are untouched. | Owner decision, 18 November 2026 |
| Retention of MFA audit rows (design's owner decision 1) | **The existing flat twelve-month floor.** `staff_mfa_*` rows inherit `audit_events` retention; no second regime, no new prune and no retention trigger in `0023`. | Owner decision, 18 November 2026 |
| Re-opening the `tester-gate` assurance | **Refused as a "restore the weaker assurance" change.** It needs an owner-approved migration that drops `app_sessions_no_tester_gate_insert`/`_update`. | ARC, [`docs/5f-staff-second-factor.md`](5f-staff-second-factor.md) §Rollback or disable path |

## Owner decisions still open

### Raised by the PROF design (ADR 0008, 21 November 2026)

| Decision | Why it is open | Options | Decider |
|---|---|---|---|
| **F1 — CISM reviewer-of-record posture.** The CISSP self-review exception "does not extend to any future bank", and CISM items are AI-assisted drafts entered under the owner's account, so the owner's review would be self-review. ADR 0008 records the posture as unsettled and PROF is advisory only. | ADR 0006 requires author ≠ reviewer; the database does not enforce it; PROF cannot satisfy it (no `users` row, and an automated check is not a second pair of eyes). | (a) extend the documented exception to CISM with the same wording and state what "AI-assisted draft" means for the record; (b) name a second human reviewer for CISM; (c) defer the CISM import. | Owner |
| **F3 — difficulty targets.** No agreed difficulty distribution exists in any source-of-truth document; `docs/cissp-bank-import.md` records "all-medium, uncalibrated" as a limitation. | The tool will not invent a product rule. `tools/question-check/profiles/cism-2026.json` carries `difficultyTargets: null` and the check warns (`DIFFICULTY_TARGET_UNSET`) without ever erroring. | (a) publish a target distribution and set `difficultyTargets`; (b) accept "uncalibrated" and keep measuring only. | Owner |
| **F4 — 3 versus 4 repeat-free mocks.** At 600 items and the exact blueprint weights (18/20/33/29) the bank supports **3** repeat-free full mocks; the programme domain binds. | Filling programme to 200 (a 602-item bank) reaches 4, but moves the share from 33.0% to 33.2% and invites per-batch drift. `coverage.repeatFreeMocks` is reported, not enforced. | (a) accept 3 at the exact weights (recommended); (b) state a 602-item bank with programme at 200. | Owner |
| **Whether a topic assignment is mandatory on every item.** The validator requires `topic_id`, requires it to exist in the taxonomy, and requires it to belong to the domain; `TOPIC_UNASSIGNED` warns when a `catchAllTopicKeys` topic holds more than 25% of the run. That is provisional tool behaviour, not an approved product rule. | No approved rule says every item must carry a specific topic, as opposed to an explicit catch-all. | (a) require a specific topic on every item; (b) allow a named catch-all subject to the 25% warning. | Owner |

- Launch market's tax, consumer, refund and invoicing obligations (currency is USD).
- Domain and canonical production origin (brand decided: CertPath, 18 November 2026).
- Exam launch order beyond CISSP (CISM is prepared but not scheduled).
- Transactional email provider (Cloudflare Email Workers covers inbound only).
- Device and session policy (Milestone 5) - required before paid launch.
- Resolution policy for money parked in `needs_support`: refund it, grant it, or
  leave it for manual handling. Settlement records the money and the parked
  checkout; it implements no policy, and `docs/commerce.md` §Failure paths names
  this as the owner's.
- Which clock starts the refund window for money parked in `needs_support` — the
  charge instant or the `paid_at` we recorded when we learned of it; `0019`
  records only the latter.

  B3 deliberately does not refund parked money: `POST …/refund` answers
  `409 refund_not_allowed` for a `needs_support` checkout, while the checkout read
  still reports a `refundWindowEndsAt` for it. That gap closes when the two
  decisions above are settled, not before.

- An unresolved refund (`commerce_refunds.status = 'requested'`) holds the
  one-per-exam slot until an operator resolves it. There is no route and no job
  for that in B3; the row is the work queue, and the alternative — treating an
  unanswered refund as a free retry — risks paying a learner back twice.
  `requested → failed` is **not** a universal resolution: it may be written only
  when the provider did not pay. It asserts "no money moved" and it frees the
  one-per-exam cap, so where the provider *did* confirm and our settle refused
  (a purchase landed during the provider call, or 0014 aborted every retry) the
  row must stay `requested` — `failed` there would both misstate the ledger and
  permit a second refund of the same checkout. Support resolves that shape
  against the provider's own record. `docs/commerce.md` §Failure paths states
  both shapes.
- Monitoring, alerting and on-call expectations for the pilot.

## Architect decisions still open

- Production Worker routing and migration rollout procedure. The export,
  rehearsed-restore and fresh-chain tooling exists and is documented in
  [`docs/data-export-and-restore.md`](data-export-and-restore.md); scheduling a
  dump and enforcing its retention are still open.
- Real MFA method to replace the tester-gate assurance before real learner data.
  **Resolved 18 November 2026**: in-Worker TOTP, owner-approved with the 5F design;
  see [`docs/5f-staff-second-factor.md`](5f-staff-second-factor.md). The staging
  deploy and both Worker settings are done ([pilot-provisioning](pilot-provisioning.md)
  §State); what remains is the production deploy, the two production Worker
  settings and one enrolment per remaining staff account, not a decision.
- Production secret rotation without invalidating sessions. `key_version` on
  `staff_totp_credentials` exists for it, and MFA-step re-wrapping is still open.
- Whether the production admin panel runs on the same Worker as learner traffic.
- CAT item-calibration approach and exposure control (Phase 6 sizing).

Milestone 0 decisions are recorded in `docs/decisions/`. Sequencing, dependencies
and exit criteria for the remaining phases are in
[`docs/delivery-plan.md`](delivery-plan.md).
