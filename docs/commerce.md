# Commerce

What exists today, and what does not. This file describes only shipped
behaviour; the checkout, webhook, refund and receipt work is listed at the end
as explicitly absent, so nothing here can be read as a promise that a route
exists.

Rules: [ADR 0003](decisions/0003-pricing-pro-and-refunds.md) (pricing, Pro,
refunds), [ADR 0004](decisions/0004-staff-capabilities-and-learner-data.md)
(capabilities and audit) and [ADR 0006](decisions/0006-content-and-operations-posture.md)
(no third-party data, no paid plans).

## What ships now

| Piece | Where |
|---|---|
| Calendar-month term arithmetic | `apps/api/src/calendar.ts` |
| Price list, terms and purchase rules | `apps/api/src/pricing.ts` |
| Pro enablement storage, read and write | `db/migrations/0017_pro_enablement.sql`, `apps/api/src/security/pro-enablement.ts` |
| Two Global Admin routes | `apps/api/src/admin-commerce.ts` |
| Payment provider port and fake adapter | `apps/api/src/commerce/provider.ts`, `apps/api/src/commerce/providers/fake.ts` |
| Dashboard Pro prompt | `apps/api/src/security/learner-dashboard.ts` |

No learner-facing route, no checkout and no money movement exists in this phase.

## Terms are calendar months

A term is `{ unit: "calendar_months", months }` or `{ unit: "days", days }`.
Calendar months are computed in UTC from an anchor instant, clamped to the last
valid day, with the time of day preserved to the millisecond; windows stay
half-open (`starts_at <= t < expires_at`). A grant's `expires_at` is never
produced by adding a day count.

| SKU | Term |
|---|---|
| `standard-3m` | 3 calendar months |
| `standard-6m` | 6 calendar months |
| `standard-12m` | 12 calendar months |
| `pro-3m` | 3 calendar months |
| `bundle-standard-3m-pro` | 3 calendar months (Standard leg; the Pro leg is always 3 months) |
| `standard-topup-3m` | 3 calendar months |
| `standard-extension-30d` | 30 days |

Calendar addition does not compose, and it is not order-preserving across a day
clamp: 30 January 18:00 and 31 January 00:00 both clamp into 30 April, so the
later instant yields the earlier expiry. Anything that compares two
calendar-added instants has to be written so it does not rely on that ordering.

## The Pro gate is the storage predicate

Pro is purchasable iff a non-revoked Standard grant for the same account and
exam satisfies `starts_at <= now < expires_at` **and**
`expires_at >= addTerm(now, proTerm)` — exactly
`learner_access_grants_pro_requires_standard` (0013). Equality is allowed, so a
Standard term of exactly three months covers a Pro term bought at its start.

`canPurchasePro()` returns one of:

| Reason | Meaning |
|---|---|
| `pro-not-offered` | the exam is not enabled for Pro |
| `standard-too-short` | Standard coverage ends before the end of a full Pro term; the bundle or a top-up is the path |
| `pro-window-active` | a non-revoked Pro grant ends after `now` |

The repurchase check reads the **stored** Pro expiry. It never re-derives an
expiry from a start instant.

`proDisplayMinStandardDays = 90` is a display-only constant, currently
unreferenced. It gates nothing.

## Pro enablement

`certification_pro_enablement` is an append-only log beside the immutable
`certifications` row: current state is the row with the greatest
`(effective_at, id)` per certification, `enabled = 0` is a real state, and both
`UPDATE` and `DELETE` abort. An `AFTER INSERT` trigger writes exactly one
`audit_events` row per act, with the action name carrying the boolean
(`certification_pro_enabled` / `certification_pro_disabled`), the actor, the
reason and the operation id. No value is written into `details_json`.

`readProEnablement(database, certificationIds)` returns current state for many
certifications in **one** query (`ROW_NUMBER() OVER (PARTITION BY …)`), which is
what keeps the learner dashboard free of an N+1 read.

### Routes

Both are Global Admin only; both live under `/api/admin`, so the admin tester
gate applies before any handler runs.

| Method + path | Capability | Success |
|---|---|---|
| `GET /api/admin/commerce/certifications/:id/pro-enablement` | `commerce.read` | `200 { certificationId, enabled, effectiveAt, history[] }` |
| `POST /api/admin/commerce/certifications/:id/pro-enablement` | `access.grant` | `200 { certificationId, enabled, effectiveAt, operationId }` |

`effectiveAt` is `null` iff no act has ever been recorded; `enabled: false` with
`effectiveAt: null` therefore means 'never decided', not 'withdrawn'.

`POST` body: `{ "enabled": boolean, "reason": string }` (reason 1–200
characters), with `Origin` and `X-CSRF-Token` required. The server mints
`operationId = "api:pro-enablement:" + <uuid>`.

Status codes: `400 validation_error | invalid_origin | invalid_csrf`;
`401 unauthenticated`; `403 insufficient_role` (a Manager, on both routes);
`404 certification_not_found`; `409 conflict` when the requested state already
holds or when two acts land in the same millisecond
(`UNIQUE (certification_id, effective_at)`); `503 service_unavailable` when the
staff security configuration is missing.

Responses are `private, no-store`, `X-Robots-Tag: noindex, nofollow` and carry
`X-Request-Id`.

## The payment provider port

`PaymentProvider` has three methods — `createCheckout`, `verifyEvent`,
`refund` — plus `name` and `live`. `verifyEvent(rawBody, headers, now)` is the
only place a signature is checked, so a real adapter can replace the fake's HMAC
scheme without the route, the dedupe or the effect batch changing, and it must
never throw on a hostile body or a missing header. `createCheckout` takes our
checkout id as its idempotency key.

`resolvePaymentProvider(bindings, now)` returns the fake adapter **only** when
`PAYMENT_PROVIDER === "fake"` and `COMMERCE_WEBHOOK_SECRET` is at least 32 bytes;
every other value, including a typo or a short secret, returns `null`. There is
no fallback path: an unconfigured provider means "commerce is off".

The fake adapter (`PAYMENT_PROVIDER=fake`) is `live: false`, takes no card data,
and signs events as `X-CertPath-Signature: t=<seconds>,v1=<hex HMAC-SHA256(secret, "t.body")>`
with a 300-second replay window and a constant-time comparison. Its sessions are
keyed on our checkout id, so a retried `createCheckout` returns the same
session.

**The port is not wired into any route yet.** No commerce binding is required to
compile or deploy this phase, and no webhook exists to receive an event.

## The bundle stacks on live coverage

`bundle-standard-3m-pro` writes two windows from one anchor, and
`apps/api/src/pricing.ts` (`bundleWindows`) is the only place that arithmetic may
live:

- Standard `[now, max(addTerm(coverageEnd, 3 months), addTerm(now, 3 months)))`
- Pro `[now, addTerm(now, 3 months))`

`coverageEnd` is the end of live Standard coverage, or `null`-as-`now` when there
is none. The Standard leg **stacks**: a learner with 11 months gets 14, one with
2 gets 5, one with none gets 3. That is `docs/product-design.md`: "Early Standard
extension begins at the end of continuous current coverage".

The `max` exists because **calendar arithmetic is not order-preserving** (see
"Terms are calendar months" above). With `coverageEnd = 2026-01-31T00:00Z` and
`now = 2026-01-30T18:00Z`, `addTerm(coverageEnd, 3 months)` is 30 Apr 00:00 while
`addTerm(now, 3 months)` is 30 Apr 18:00: the later instant yields the earlier
expiry, so the uncapped leg can end before the Pro leg and 0013 would abort the
bundle. The `max` is not defensive tidying; removing it reintroduces that abort.

A **cap** on this leg was decided on 2026-11-16 and withdrawn by the owner the
same day, after seeing that a mid-term buyer would pay for the bundle and receive
no extra Standard.

### AC-5 — the bundle covers itself under one clock

One batch writes Standard
`[now, max(addTerm(coverageEnd, term), addTerm(now, term)))` and Pro
`[now, addTerm(now, term))`, both carrying the identical `now`; 0013 accepts by
construction because `S.starts_at = P.starts_at` and
`S.expires_at = max(...) >= addTerm(now, term) = P.expires_at`, which holds
**without** any ordering property of month arithmetic. Observable: both rows'
`starts_at` are byte-identical; `S.expires_at >= P.expires_at` holds in the
inversion case above; a learner with 11 months of coverage gets a Standard row
ending **at least** 3 calendar months past their previous coverage end. "At
least" is the whole guarantee: when the `max` picks `addTerm(now, term)` the row
ends later than `addTerm(coverageEnd, term)`, so no exact figure is stated and
none may be asserted.

Not yet observable: both legs sharing one `operation_id`. `learner_access_grants`
`operation_id` is `UNIQUE` and `audit_events.operation_id` is the primary key, so
the two grant rows cannot share one id. Decided on 2026-11-16; not implemented,
and not implemented elsewhere either: the legs will carry
`"<checkoutId>:standard"` and `"<checkoutId>:pro"`. Two conditions carry that
decision. The suffix is derived from the checkout id alone, so a replay
re-inserts the same two ids and fails closed at `UNIQUE` instead of granting
twice - a random suffix would let a replay double-grant. And it is length-safe:
`checkoutId` is validated at <= 128 and the `operationId` contracts cap at 128,
so `":standard"` would make 137 - checkout ids are minted at <= 118 characters,
or the suffixes shorten to `:s` / `:p`. PR B implements it.

## Owner decisions carried forward

Decided by the owner on 2026-11-16; not implemented, and not implemented
elsewhere either:

- One self-serve refund **ever** per `(account, exam)`.
- A refund of a Standard purchase that would orphan a separately-bought Pro
  refunds **both** checkouts in one refund record, Pro revoked before Standard.

## Arrives in the next commerce change (not present today)

Nothing below exists. No table, route, binding or job for it has shipped.

- Tables: `commerce_checkouts`, `commerce_checkout_lines`,
  `commerce_provider_events`, `commerce_receipts`, `commerce_refunds`,
  `commerce_refund_lines`.
- The `learner_access_grants_one_pro_window` trigger.
- Every `/api/commerce/*` route: offers, checkouts, checkout read, refund,
  receipts, the webhook, and the local-only `dev/fake-pay` seam.
- `expireStaleCheckouts` for the Worker's `scheduled` handler.
- `COMMERCE_ENABLED` and `PAYMENT_PROVIDER` bindings, and the
  `COMMERCE_WEBHOOK_SECRET` secret.

Still out of scope even then: any real payment provider (a change to PCI scope
and cost), tax, invoicing, delivery of receipts by email, coupons, proration and
recurring billing.
