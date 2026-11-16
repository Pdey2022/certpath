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

## Owner decisions still open

- Launch market's tax, consumer, refund and invoicing obligations (currency is USD).
- Final brand, domain, and canonical production origin.
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

- Production Worker routing, D1 backup automation and migration rollout procedure.
- Real MFA method to replace the tester-gate assurance before real learner data.
- Production secret rotation without invalidating sessions.
- Whether the production admin panel runs on the same Worker as learner traffic.
- CAT item-calibration approach and exposure control (Phase 6 sizing).

Milestone 0 decisions are recorded in `docs/decisions/`. Sequencing, dependencies
and exit criteria for the remaining phases are in
[`docs/delivery-plan.md`](delivery-plan.md).
