# Open decisions

These are not defaults. Do not implement or communicate them as settled product
rules. Resolved items are listed with the record that closed them; the rest still
need an owner or architect decision.

## Resolved (14 November 2026)

| Decision | Outcome | Record |
|---|---|---|
| Price ladder | $59 / $89 / $129 (3 / 6 / 12 months), USD | [ADR 0003](decisions/0003-pricing-pro-and-refunds.md) |
| Pro price and rules | $49 flat, 3 months, CAT exams only, requires 90 days Standard | ADR 0003 |
| Refunds | 7 days, no questions, one per account per exam | ADR 0003 |
| Free sample | Guest sample: 10 questions + a mini mock, no account | ADR 0003 |
| Recurring vs fixed term | Fixed-term one-off; no recurring at launch | ADR 0003 |
| Pro repurchase | One Pro per rolling 90 days while Standard is active | ADR 0003 |
| Post-expiry readability | 15-day read-only grace, then locked | [ADR 0005](decisions/0005-readiness-and-access-lifecycle.md) |
| Readiness definition | v1 formula, bands 50/75, 14-day decay | ADR 0005 |
| Learner dashboard behaviour | Readiness + next action; no streaks or goals | ADR 0005 |
| Staff capability boundary | Money/entitlements/staff/security = Global Admin only | [ADR 0004](decisions/0004-staff-capabilities-and-learner-data.md) |
| Learner data access | Managers platform-wide, masked, audited reveal; 12-month audit retention | ADR 0004 |
| Content supply | In-house authored, ~600 per exam, English, text only | [ADR 0006](decisions/0006-content-and-operations-posture.md) |
| Analytics | Cloudflare Web Analytics plus own consent-aware D1 events | ADR 0006 |
| Staging | Previews share production D1 today; isolated D1 required | ADR 0006 |
| Price points validated? | **No** - provisional until a fake-door test | ADR 0003 |

## Owner decisions still open

- Launch market's tax, consumer, refund and invoicing obligations (currency is USD).
- Final brand, domain, and canonical production origin.
- Exam launch order beyond CISSP (CISM is prepared but not scheduled).
- Transactional email provider (Cloudflare Email Workers covers inbound only).
- Device and session policy (Milestone 5) - required before paid launch.
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
