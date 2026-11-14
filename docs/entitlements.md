# Entitlements

How the platform decides what a learner may do, and when. Storage is
`learner_access_grants`; evaluation is `apps/api/src/entitlements.ts`; prices and
purchase rules are `apps/api/src/pricing.ts`.

Rules: [ADR 0003](decisions/0003-pricing-pro-and-refunds.md) (pricing, Pro,
refunds) and [ADR 0005](decisions/0005-readiness-and-access-lifecycle.md)
(readiness, access lifecycle).

## Grants

One row per purchased or granted window:

| Column | Meaning |
|---|---|
| `feature` | `standard` or `pro` |
| `starts_at` / `expires_at` | the window, half-open: `starts_at <= t < expires_at` |
| `revoked_at`, `revocation_operation_id`, `revoked_by_user_id` | refund or admin revocation; all three set together or none |
| `sku`, `source` | provenance (`purchase`, `grant`, `extension`, `bundle`, `migration`) |
| `operation_id`, `created_by_user_id` | audit identity; inserts with an operation are audited automatically |

Grants are never deleted and never edited in place: revoke, then grant again.
Both are enforced by triggers, not by convention.

## States

Evaluated per feature, at an instant:

| State | Meaning |
|---|---|
| `active` | a non-revoked grant covers the instant |
| `grace` | a grant expired less than **15 days** ago |
| `expired` | neither |

Grace is read-only on purpose. Capabilities:

| Capability | Active | Grace | Expired |
|---|---|---|---|
| `practice`, `mock` | yes | no | no |
| `adaptive-mock` (Pro) | yes, needs both features active | no | no |
| `results`, `explanations` | yes | yes | no |

`graceDaysRemaining()` drives the dashboard countdown and renewal prompt.

## Storage guarantees

- A `pro` grant is rejected unless a non-revoked `standard` grant for the same
  learner and certification covers its whole window. Pro can never outlive
  Standard, even if application code is wrong.
- A grant is immutable after insert. Any `UPDATE` that touches a column other
  than the revocation trio, or that touches an already-revoked row, is rejected
  — refunds and corrections are a revocation plus a new grant, never an edit.
  This is what stops a window being shortened out from under a Pro grant.
- Revoking a `standard` grant is rejected when it would leave a live `pro`
  grant with no covering `standard` grant. Revoke the Pro grant first.
- Grants cannot be deleted.
- Grants carrying an `operation_id` write an `access_granted` audit event; a
  revocation writes `access_revoked`. The event names the staff member who acted
  as `actor_user_id`, and falls back to the `access-grant` service ref only when
  the grant has no named actor. `audit_events` allows one or the other, never
  both. Legacy rows without provenance are left alone.

## Prices and purchase rules

The price list is server-side and expressed in minor units so money never
touches a float: `standard-3m` 5900, `standard-6m` 8900, `standard-12m` 12900,
`pro-3m` 4900, `bundle-standard-3m-pro` 9900, `standard-topup-3m` 3900,
`standard-extension-30d` 2500 (USD).

`canPurchasePro()` answers one question: may this learner buy Pro right now?

| Condition | Result |
|---|---|
| the exam is not Pro-capable | `pro-not-offered` |
| fewer than 90 days of Standard remain | `standard-too-short` (offer the bundle or a top-up) |
| a Pro window started within the last 90 days | `pro-window-active` |
| otherwise | allowed |

The price list is **provisional** until a fake-door test measures conversion. The
rules around it are not provisional, and no route may hard-code a price.

## Not in this phase

Checkout, payment provider, receipts and refund execution arrive in Phase 4
([issue #47](https://github.com/Pdey2022/certpath/issues/47)). This phase only
defines the model those features write into.
