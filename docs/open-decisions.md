# Open decisions

These are not defaults. Do not implement or communicate them as settled product
rules.

## Owner decisions before production

- Launch market, business country, currency, tax, consumer and refund policies.
- Final brand, domain, and canonical production origin.
- Exam launch order and reviewed/licensed content sources.
- Prices, fixed-term versus recurring renewal, Pro repurchase, and the price and
  handling of a Standard extension for Pro.
- Customer-facing timezone and calendar-month expiry display policy.
- Whether completed results and explanations remain readable after Standard
  expiry; how expiry affects an active attempt; initial device policy.
- Authentication, email, monitoring, and analytics providers; privacy,
  attribution, consent, and retention policies.

## Architect decisions before later implementation

- Production Worker routing, D1 backup/restore and migration rollout.
- Server-side identity, permission checks, session revocation and MFA design.
- Canonical host and redirect policy for production and staging.
- Provider compatibility, data residency and operational limits for the
  selected launch market.

Milestone 0 decisions are recorded in `docs/decisions/`. These unresolved items
do not block a local foundation and must not be silently decided here.
