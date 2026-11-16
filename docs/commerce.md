# Commerce

What exists today, and what does not. This file describes only shipped
behaviour; refunds are described below because they now exist, and anything not
described here is absent, so nothing here can be read as a promise that a route
exists.

Rules: [ADR 0003](decisions/0003-pricing-pro-and-refunds.md) (pricing, Pro,
refunds), [ADR 0004](decisions/0004-staff-capabilities-and-learner-data.md)
(capabilities and audit) and [ADR 0006](decisions/0006-content-and-operations-posture.md)
(no third-party data, no paid plans).

The refund design is recorded in full in
[`docs/commerce-refunds.md`](commerce-refunds.md).

## What ships now

| Piece | Where |
|---|---|
| Calendar-month term arithmetic | `apps/api/src/calendar.ts` |
| Price list, terms and purchase rules | `apps/api/src/pricing.ts` |
| Pro enablement storage, read and write | `db/migrations/0017_pro_enablement.sql`, `apps/api/src/security/pro-enablement.ts` |
| Two Global Admin routes | `apps/api/src/admin-commerce.ts` |
| Payment provider port and fake adapter | `apps/api/src/commerce/provider.ts`, `apps/api/src/commerce/providers/fake.ts` |
| Checkout schema: checkouts, price-snapshot lines, provider events | `db/migrations/0018_commerce_checkouts.sql` |
| Offers projection and checkout creation | `apps/api/src/commerce/checkouts.ts` |
| Learner commerce routes | `apps/api/src/commerce/http.ts` |
| Checkout expiry for the `scheduled` handler | `apps/api/src/commerce/expire.ts` |
| Settlement, receipts and the one-Pro-window guard | `db/migrations/0019_commerce_settlement.sql` |
| Verify → dedupe → effect batch | `apps/api/src/commerce/webhooks.ts` |
| The webhook route and the local dev seam | `apps/api/src/commerce/http.ts` |
| Refunds: records, lines and the one-per-exam cap | `db/migrations/0020_refunds.sql` |
| Refund protocol: decision, provider call, revocation | `apps/api/src/commerce/refunds.ts` |
| Receipts read | `apps/api/src/commerce/receipts.ts` |
| Commerce contracts | `packages/contracts/src/commerce.ts` |
| Dashboard Pro prompt | `apps/api/src/security/learner-dashboard.ts` |

A learner can be quoted a price, create a checkout a provider hosts, have that
checkout settled into a stored receipt and a grant by an authenticated provider
event, and refund the purchase inside seven days — which revokes the grants and
stores a refund receipt. **Nothing else can grant access**: `learner_access_grants`
is written only by the settlement batch (and by staff access grants and migration
fixtures), always with a deterministic `operation_id`, and it is removed only by a
revocation, which a self-serve refund can only perform against the grants its own
checkouts wrote.

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

## The Pro gate takes grants, not a window

Pro is purchasable iff **one** non-revoked Standard grant for the same account
and exam satisfies `starts_at <= now < expires_at` **and**
`expires_at >= addTerm(now, proTerm)` — exactly
`learner_access_grants_pro_requires_standard` (0013). Equality is allowed, so a
Standard term of exactly three months covers a Pro term bought at its start.

`standardCoversProWindow(grants, now)` and `canPurchasePro({ grants, … })` take
the grant rows rather than a pre-computed `{startsAt, endsAt}` pair; the one
`grants` parameter carries **both** features, because the Standard side and the
Pro side of the gate are computed from the same list. A pair can be synthesised
from two different grants and is not a witness of anything: `g1 = [now − 90d,
now + 10d)` plus `g2 = [now + 1d, proEnd + 30d)` yields a start from `g1` and an
end from `g2`, neither of which covers the Pro window, so 0013 would refuse the
insert after money was taken. Handing the gate the rows makes "the gate allowed
it" and "0013 accepts it" the same statement.

`canPurchasePro()` returns one of:

| Reason | Meaning |
|---|---|
| `pro-not-offered` | the exam is not enabled for Pro |
| `standard-too-short` | no single Standard grant spans `now` to `addTerm(now, proTerm)`; the bundle or a top-up is the path |
| `pro-window-active` | a non-revoked Pro grant **overlaps** the window a purchase made now would write |

The repurchase check reads the **stored** Pro window and applies the same
overlap predicate 0019 enforces: two half-open windows `[a, b)` and `[c, d)`
overlap iff `a < d AND c < b`, so a Pro grant with
`starts_at < addTerm(now, proTerm)` and `expires_at > now` refuses the purchase.
It is **not** a "live now" test: a Pro grant that starts tomorrow still overlaps,
and refusing it at the gate is what stops the trigger aborting a purchase the
learner already paid for. `proWindowActive(grants, now)` is that predicate, and
`canPurchasePro` computes both sides of the gate from the same grant list. It
never re-derives an expiry from a start instant.

`standardCoverageEndMs(grants, now)` is the one definition of "how much coverage
does this account have": `null` with no non-revoked Standard grant, otherwise the
latest expiry across them floored at `now`. It counts a grant that has not
started yet, because coverage is contiguous by construction (a top-up appends to
the end of the current window). It is used for `standardRemainingDays` and for
the top-up rule; it is **not** the purchase gate.

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
session. Its three URLs — `/commerce/fake-pay` for the redirect,
`/commerce/checkout/complete` and `/commerce/checkout/cancelled` for
`successUrl` / `cancelUrl` — are placeholders: no route serves any of them until
the Phase 5 UI lands.

`createCheckout` and `resolvePaymentProvider` are wired into checkout creation,
`verifyEvent` is wired into the webhook route, and `refund` is wired into the
refund route. `provider.refund` is called with **our** refund id as its
idempotency key, outside any transaction, between the two refund batches.

## The commerce gate

Every `/api/commerce/*` route is behind three conditions, checked before a
session is read:

1. `COMMERCE_ENABLED` is the exact string `"true"`;
2. `PUBLIC_SITE_ORIGIN` and `CSRF_HMAC_SECRET` are usable (as for every learner
   route);
3. a payment provider resolves.

Any of the three missing answers `503 commerce_disabled` (`service_unavailable`
when only the site configuration is missing) and writes nothing.
`COMMERCE_ENABLED` and `PAYMENT_PROVIDER` are declared **off** in
`apps/web/wrangler.jsonc` (`"false"` / `"none"`), and `COMMERCE_WEBHOOK_SECRET`
is set only with `wrangler secret put` by the owner. `apps/web/.dev.vars.example`
carries placeholders only; `.dev.vars` stays gitignored.

`/api/commerce/*` is outside `isAdminSurfacePath`, so the admin IP allowlist does
not apply; the gate above is the compensating control. Workers previews share the
production D1 (ADR 0006), so a preview with `COMMERCE_ENABLED=true` and the
production secret could process real events: that is a Phase 5 blocker (isolated
staging D1). Until then the rule is that the fake provider is enabled only in
local development, never on a preview or the deployed Worker.

## Checkouts — `0018_commerce_checkouts.sql`

Three tables, no rebuild of anything, and `learner_access_grants` untouched.

### `commerce_checkouts`

One row is a request to buy: `id`, `user_id`, `certification_id`, `sku`,
`client_checkout_key`, `request_fingerprint`, `currency`, `total_minor`,
`status`, `provider`, `provider_session_id`, `provider_redirect_url`,
`created_at`, `updated_at`, `expires_at`, `paid_at`.

`sku` is the price-list key that was bought. It is stored rather than inferred
from the lines because the bundle's `standard-3m` + `pro-3m` line pair describes
the same two features as a Pro purchase made on top of existing Standard
coverage; only the row says which one settlement is looking at, and the two need
different writes.

- `status` is one of `pending | paid | failed | expired | needs_support | refunded`.
- `UNIQUE (user_id, client_checkout_key)` is the idempotency witness;
  `provider_session_id` is `UNIQUE`.
- `updated_at >= created_at` and `expires_at > created_at`.
- A CHECK ties status to money: `paid`, `refunded` and `needs_support` require a
  `paid_at`; `pending`, `failed` and `expired` require `paid_at IS NULL`.
- Indexes: `(user_id, created_at DESC, id DESC)` and a partial
  `(status, expires_at) WHERE status = 'pending'` for the expiry job.

Storage guards, each a trigger rather than a convention:

| Trigger | Refuses |
|---|---|
| `commerce_checkouts_immutable` | any change to `user_id`, `certification_id`, `sku`, `client_checkout_key`, `request_fingerprint`, `currency`, `total_minor`, `provider`, `created_at`, `expires_at`, and (from 0019) any change to `paid_at` or `provider_session_id` **once they are set** |
| `commerce_checkouts_status_transition` (replaced in 0019 and again in 0020) | any edge outside `pending → {paid, failed, expired, needs_support}`, `expired → {paid, needs_support}`, `failed → {paid, needs_support}`, `paid → {refunded, needs_support}` (no-op same-status writes are allowed) |
| `commerce_checkouts_refunded_requires_settled_refund` (0020) | a `refunded` transition with no settled refund naming the checkout |
| `commerce_checkouts_refunded_requires_paid_checkout` (0020) | a forced `refunded` on a row that was never `paid` — `pending` or `needs_support` |
| `commerce_checkouts_no_delete` | every delete |
| `commerce_checkouts_one_open_per_fingerprint` (0019, an index) | a second `pending` row for one `(user_id, request_fingerprint)` |

`expired → paid` is deliberate: money taken after our own deadline is money
taken, so a late `checkout.completed` still applies. `expired → needs_support` is
the same rule's other half and is added by `0019`: a late payment that cannot be
applied — an amount that disagrees with the snapshot, or a Pro leg that aborts at
the one-Pro-window trigger — has to be *recorded* as `needs_support`, because that
record is the work queue for money the learner actually paid. While the edge was
missing, `markNeedsSupport` aborted its own batch and the delivery became a `503`
with the learner's money already taken; what the provider saw next depended on
the shape. A Pro leg that aborted rolled the settlement batch back, so no event
row existed and every retry repeated the `503`. An amount mismatch applied
nothing but had already committed the event row as `ignored-inconsistent`, so the
next delivery answered `200 {duplicate: true}` and left the row `expired` with
`paid_at` NULL and the money visible only in `commerce_provider_events` —
recorded, unqueued, and still invisible to anything that reads checkouts. A row
our own expiry closed is never left `expired` once money has moved: the CHECK
forbids `paid_at` on `expired`, so leaving it there would make the payment
invisible.

`paid → refunded` arrived in `0020`, guarded by
`commerce_checkouts_refunded_requires_settled_refund`: a checkout may only become
`refunded` while a settled refund names it, and by
`commerce_checkouts_refunded_requires_paid_checkout`: only a row that was `paid` may
become `refunded` at all. The edge list is **replaced**, not
supplemented — `0020` drops and recreates the trigger, restating every edge
`0018` and `0019` added, and
`test/commerce-checkout.test.ts` ("allows only the documented status edges") plus
`test/commerce-refund-guards.test.ts` (case 11) re-assert `expired → needs_support`
so a future replacement cannot silently re-narrow it.

`paid_at` and `provider_session_id` are write-once as of 0019: the first write is
allowed (`NULL` → the instant money moved, `NULL` → the provider session), and any
second value aborts. `paid_at` anchors the seven-day refund window a later change
computes, and a session id that could be rebound would point a provider event at a
different checkout.

### One open checkout per (learner, certification, SKU)

`commerce_checkouts_one_open_per_fingerprint` is a **partial unique index** on
`(user_id, request_fingerprint) WHERE status = 'pending'`. `request_fingerprint`
is `sha256(certificationId + "\n" + sku)`, so one learner holds at most one
*pending* checkout per product.

A second tab with its own `clientCheckoutKey` is answered
`409 checkout_already_open` with
`{ "error": { "code": "checkout_already_open", "requestId": "…", "checkoutId": "…" } }`
— the existing id travels so the tab can be handed the live provider session
through `GET /api/commerce/checkouts/:checkoutId` rather than opening a second
one. Two open sessions for one product would mean two possible charges and, once
settled, two grants under two operation ids.

`expireStaleCheckouts` is the pressure valve: an expired row is not `pending`, so
it frees the slot and a learner whose session lapsed can buy the same product
again. The same is true of any settled row — a `paid` checkout never blocks a
new purchase. A different SKU (or a different exam) is a different fingerprint
and is unaffected.

### `commerce_checkout_lines` — the price snapshot

`checkout_id`, `position` (0–3), `sku`, `label`, `amount_minor`,
`grants_feature`, `grants_unit`, `grants_months`, `grants_days`, `price_source`.

The line is a snapshot: `amount_minor` and the grant term are copied from
`apps/api/src/pricing.ts` when the checkout is created and never re-read from it,
so a later price-list edit cannot change what a paid checkout granted. The term
is stored as **one unit plus one quantity** (`calendar_months` + `months`, or
`days` + `days`), with a CHECK that refuses both or neither: `0017` replaced day
counts with a term, and a bare number would let the next reader guess the unit.

`price_source` records how the amount was obtained: `price-list` for a real price
entry, `bundle-residual` for the bundle's derived Pro leg.

| Trigger | Refuses |
|---|---|
| `commerce_checkout_lines_within_total` | an insert whose running sum would exceed `total_minor` |
| `commerce_checkout_lines_no_update` | every update |
| `commerce_checkout_lines_no_delete` | every delete |

The failure direction is deliberate: an over-charge is impossible, and a
shortfall would be visible as a receipt whose lines sum below its total. The
checkout and its lines are written in **one** batch, so a checkout without a
price snapshot cannot be observed.

### `commerce_provider_events`

The provider-attempt ledger: `provider_event_id` (PK), `provider`, `kind`
(`checkout.completed | checkout.failed`), `checkout_id`, `amount_minor`,
`currency`, `occurred_at`, `received_at`, `outcome`
(`applied | ignored-unknown-checkout | ignored-inconsistent`). Append-only (no
update, no delete), no retention job: it is not an audit row and it carries no
personal data beyond opaque ids. `0019` creates it and settlement writes it — one
row per delivered provider event, written **last** in the effect batch, with the
outcome the batch actually produced.

It is also the reconciliation record, and one property follows from that: it
stores `amount_minor` **per event**, and a redelivered event keeps its original
row (`ON CONFLICT … DO NOTHING`), but a checkout settled by a later event id has
more than one row naming it. Reconciliation must therefore join
`commerce_receipts` — one purchase receipt per checkout, plus one refund receipt
per refunded checkout (`UNIQUE (checkout_id, kind)` allows exactly those two) —
or count `DISTINCT checkout_id`, and **must never sum
`commerce_provider_events.amount_minor`**:
a replay asserting `outcome = 'applied'` would be counted twice. "At most one
`applied` event per checkout" is enforced by the batch (each effect statement
requires the event id to be unseen and the receipt insert is one per checkout),
not by a unique index; a constraint for it belongs in a follow-up, not in a
reconciliation query that trusts it.

## Checkout creation

`POST /api/commerce/checkouts` with
`{ certificationId, sku, clientCheckoutKey }`.

1. **Idempotency first.** `client_checkout_key` is unique per learner. A key that
   already exists with the same `request_fingerprint`
   (`sha256(certificationId + "\n" + sku)`) is a replay: `200` with the stored
   checkout and one row. The same key with a different fingerprint is
   `409 idempotency_conflict`. Idempotency is decided *before* the purchase rule,
   so a replay is a replay even if the rule that allowed the original would now
   refuse it; nothing is created either way.
2. **The rule.** The SKU is evaluated with the same function the offers endpoint
   uses, so the offer a learner sees and the decision the write path makes cannot
   disagree. A refusal is `409 purchase_not_allowed` with
   `{ code, reason, requiresBundle }`; `requiresBundle` is `true` for
   `standard_too_short` only, so the bundle is surfaced rather than hidden. It is
   `false` for `pro_window_active` and for `pro_not_offered`, because
   `bundleDecision` refuses the bundle for exactly those two reasons — a pointer
   at a refusal is not a way through.
3. **One batch.** The checkout row (`INSERT … ON CONFLICT (user_id,
   client_checkout_key) DO NOTHING RETURNING id`) and its lines are written
   together. The witness that our row landed is the returned id, never
   `meta.changes` — an audit trigger inflates `changes`. Line inserts are
   predicated on *our* row id existing, so the loser of a concurrent double-click
   writes nothing.
4. **The provider.** Only after the row is committed: `createCheckout` is called
   with our checkout id as its idempotency key and the **stored** line amounts. A
   throw leaves the row `pending` with `provider_session_id IS NULL` and answers
   `503 provider_unavailable`; the retry with the same client key calls the
   provider again with the same key. The session is bound with `UPDATE … WHERE
   provider_session_id IS NULL RETURNING id`, so a concurrent retry cannot create
   a second session.

Line construction, from `priceList` only:

| SKU | Lines |
|---|---|
| `standard-3m`, `standard-6m`, `standard-12m`, `standard-topup-3m`, `standard-extension-30d` | one line, that SKU's price and term |
| `pro-3m` | one line, `pro-3m`'s price and `proTerm` |
| `bundle-standard-3m-pro` | Standard at `standard-3m`'s price, then Pro at the **residual** `bundle − standard-3m`, marked `bundle-residual` |

`total_minor` is the sum of the lines, so it is derived rather than typed. The
request never carries an amount, and a response amount that disagreed with the
stored snapshot would fail the contract parse before it left the Worker.

The response is
`{ checkoutId, sku, status, currency, totalMinor, lines[], redirectUrl,
expiresAt, paidAt, refundWindowEndsAt }`, where `sku` is the purchased SKU and
each line is
`{ sku, label, amountMinor, feature, term, priceSource }` and `term` is the
`TermSpec` the line grants — never a day count standing in for a month. `paidAt`
is `null` until a settlement records that money moved, so it is set on `paid`
and also on `needs_support` where money moved and nothing could be granted;
`refundWindowEndsAt` is `null` until the checkout is paid, then holds
`paidAt + 7 days` (`refundWindowMs` in `pricing.ts`, the same value the purchase
receipt records), and is `null` again once the checkout is `refunded` — the window
has been used and there is nothing left to act on. A client must branch on
**`status`, never on `paidAt`**: a parked `needs_support` has a `paidAt` and still
grants nothing. The same fields are returned by
`GET /api/commerce/checkouts/:checkoutId`, so a paid checkout and its receipt
report one refund window rather than two.

One known inconsistency is recorded rather than silenced: a `needs_support`
checkout reports a `refundWindowEndsAt` that **no route honours**, because
self-serve refunds cover `paid` checkouts only and the resolution policy for
parked money is an open owner decision (issue #83). A client must branch on
`status`; the field is a fact about `paidAt`, not a promise about a route.

Status codes: `201` created, `200` replay, `400 validation_error | unknown_sku |
invalid_origin | invalid_csrf`, `401 unauthenticated`,
`404 certification_not_found`, `409 purchase_not_allowed | idempotency_conflict |
checkout_already_open`,
`413 payload_too_large`, `415 unsupported_media_type`,
`503 commerce_disabled | provider_unavailable`. An unknown SKU is `unknown_sku`
rather than `validation_error` because the request accepts a string and checks it
against the price list; every other malformed body is `validation_error`.
`checkout_already_open` carries the existing `checkoutId` — see "One open
checkout per (learner, certification, SKU)".

## The offers projection

`GET /api/commerce/offers?certificationId=` returns every SKU, in price-list
order, priced from `priceList`:

```json
{ "certificationId": "…", "currency": "USD", "standardRemainingDays": 41,
  "proOffered": true,
  "offers": [
    { "sku": "pro-3m", "label": "Pro, 3 months", "amountMinor": 4900,
      "purchasable": false, "reason": "standard_too_short" }
  ] }
```

`reason` is `null` exactly when `purchasable` is `true`; the contract enforces
that both ways. `standardRemainingDays` is `0` — never `null` — when there is no
coverage. `amountMinor` always comes from `priceList`; the endpoint and the
checkout response are the only ways a client learns a price.

| SKU | Purchasable when | Otherwise |
|---|---|---|
| `standard-3m`, `standard-6m`, `standard-12m` | always | — |
| `pro-3m` | `canPurchasePro` allows | `pro_not_offered`, `standard_too_short`, `pro_window_active` |
| `bundle-standard-3m-pro` | Pro is sold on the exam and no Pro window is live | `pro_not_offered`, `pro_window_active` |
| `standard-topup-3m` | Pro is sold, a Standard grant is live, and coverage is under a full Pro term | `topup_not_applicable` |
| `standard-extension-30d` | a Standard grant is live | `extension_not_applicable` |

The bundle is never refused `standard_too_short`: it brings its own Standard leg,
so that refusal is the reason it exists.

## Checkout read and expiry

`GET /api/commerce/checkouts/:checkoutId` returns the owner's checkout and `404
checkout_not_found` for anyone else's, indistinguishable from a nonexistent id —
the owner is in the `WHERE`, not in an `if` above it. `redirectUrl` is the stored
provider URL while the checkout is pending (or before its own expiry), and `null`
once it can no longer be used — which includes a `refunded` checkout: there is
nothing left to pay, and no session to send the learner back to. The same read
returns `refundWindowEndsAt` while a window exists and `null` once the checkout is
`refunded`, because the window has been used and `paid_at` is preserved by 0018's
money/status CHECK.

`expireStaleCheckouts(database, now)` marks pending checkouts whose `expires_at`
has passed as `expired` and returns how many (`RETURNING id`, never
`meta.changes`). It is idempotent and safe to skip. The Worker's `scheduled`
handler runs it in its own `ctx.waitUntil`, beside the question-import cleanup and
the audit retention job, so one failure cannot stop another — and only when
`COMMERCE_ENABLED` is `"true"`.

A checkout's provider session lives for 30 minutes (`checkoutSessionTtlMs`); a
checkout is a redirect handoff, not a reservation, and a lapsed one is replaced by
a new checkout with a new `client_checkout_key`.

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

Both legs cannot share one `operation_id`: `learner_access_grants.operation_id` is
`UNIQUE` and `audit_events.operation_id` is the primary key. As implemented the
legs carry `"<checkoutId>:standard"` and `"<checkoutId>:pro"`, derived from the
stored `commerce_checkouts.id` and never from a random or provider-supplied value,
so a replay re-inserts the same two ids and fails closed at `UNIQUE` instead of
granting twice. The checkout ids are minted at **≤ 118 characters**
(`chk_` + UUID is 40) so `":standard"` stays inside the 128-character cap on an
operation id, and a test asserts the bound.

## The webhook — `POST /api/commerce/webhooks/:provider`

The only unauthenticated write surface in the application. Raw body, header
`X-CertPath-Signature: t=<sec>,v1=<hex>`, **no session, no CSRF token, no IP
allowlist** (providers come from anywhere) and no learner-supplied header is
read. The router is a separate Hono app mounted at `/api/commerce/webhooks`
ahead of the learner router, so "no session" is structural: the learner
middleware cannot grow a branch that decides it.

| Answer | When |
|---|---|
| `200 { received: true, duplicate: false }` | applied, or recorded as `ignored-unknown-checkout` / `ignored-inconsistent` |
| `200 { received: true, duplicate: true }` | the event id was already recorded; nothing was written |
| `401 invalid_signature` | a missing header, a wrong secret, a tampered body, or a timestamp outside the 300-second window |
| `400 malformed_event` | a valid signature over a body that is not an event, **or** raw bytes that are not valid UTF-8 (the decoder runs on unauthenticated input before any signature is checked, so it answers instead of throwing) |
| `404 unknown_provider` | the path segment is not `provider.name` |
| `413 payload_too_large` | the raw body exceeds 16 KiB; refused before the signature is read |
| `503 commerce_disabled` | `COMMERCE_ENABLED` is not `"true"` or no provider resolves |
| `503 provider_unavailable` | an unexpected storage error. The effect batch is one transaction, so nothing was written; the provider is asked to retry rather than handed a 5xx it cannot act on. Nothing about the body, the signature or the event is logged |

`stale` is answered `401` rather than `400`: the signature was valid and outside
the replay window, and inviting a retry of the same body would only repeat it.

The checkout an event is about is resolved on `provider_session_id` — the session
**we** bound at checkout creation, `UNIQUE` and write-once — never on the
provider's echo of our id. The echo is provider-supplied input and the fake
adapter accepts up to 128 characters of it.

### The dev seam

`POST /api/commerce/dev/fake-pay` exists only when `PAYMENT_PROVIDER=fake` **and**
`LOCAL_COMMERCE_DEV_TOOLS` is the exact string `"true"`; every other combination
answers `404`, exactly as an unwritten route would. It takes a learner session
and a CSRF token because it is a learner route, and it grants nothing by itself:
it reads the stored checkout, signs a `checkout.completed` body and dispatches it
through `handleProviderWebhook` — the same function the webhook route calls. One
write path, no second door. The event id it mints is
`fake_completed:<checkoutId>`, so pressing the button twice is a duplicate rather
than a second settlement.

`LOCAL_COMMERCE_DEV_TOOLS` is absent from `wrangler.jsonc`, which means off; it
is set to `true` in a local `.dev.vars` only.

## Settlement — `0019_commerce_settlement.sql`

One `database.batch()` is one transaction, and a failing statement rolls the whole
batch back. The statements are written so that every witness reads a write the
same transaction made:

1. **Standard grant**, if the SKU grants Standard — guarded by a
   **compare-and-swap** on the coverage end read for this settlement.
2. **Pro grant**, if the SKU grants Pro — after the Standard row, because 0013
   requires the covering Standard row to exist.
3. **The checkout transition** to `paid` with `paid_at`, predicated on the grants
   above having landed. A paid checkout with no entitlement is therefore
   unrepresentable, and a lost compare-and-swap leaves the row *pending*.
4. **The purchase receipt**, predicated on the paid checkout.
5. **The provider event row last**, with its `outcome` computed from what this
   transaction wrote.

Why the event row is last. `commerce_provider_events.outcome` is append-only and
`NOT NULL`, so the value must be decided once and be true. Written first it would
name an outcome before the effects ran, and a lost compare-and-swap would leave a
row claiming `applied` with no grant behind it. Written last, the outcome is a
function of the state the transaction produced. The property the "first" ordering
was there to buy — *a duplicate can never fail the batch and pin the provider in a
retry loop* — is kept by `ON CONFLICT (provider_event_id) DO NOTHING`, and is
strengthened: every effect statement also requires the event id to be unseen, so a
duplicate delivery provably writes nothing at all.

**Design amendment (2026-11-16), approved by ARC.** §6.2 of the approved commerce
design specifies the **event-first** ordering: write the provider event row, then
the effects. That ordering is **superseded** by the event-last ordering above, for
the reason the design itself names against it — the event row's outcome is
`NOT NULL` and append-only, so an event-first batch would let a lost
compare-and-swap write `applied` and commit no grant at all: a **false witness**,
which is exactly what the ledger exists to prevent. Event-last with a `NOT NULL`
outcome plus a per-statement "event unseen" guard (`NOT EXISTS … provider_event_id
= ?`) on every effect keeps the duplicate-delivery property §6.2 was buying and
adds the one it was missing. The design's §6.2 has been read this way since; no
implementation may "restore" event-first on the strength of the older text.

### The compare-and-swap

Calendar months cannot be done in SQL: `date('2024-01-31','+1 month')` overflows
to `2024-03-02` instead of clamping to `2024-02-29`, so the arithmetic lives in
`apps/api/src/calendar.ts` and settlement computes the windows in JavaScript from
the **stored price snapshot**. The concurrency property that living in the
statement would have bought is kept by a compare-and-swap instead:

```sql
INSERT INTO learner_access_grants (...) SELECT ...
WHERE (SELECT COALESCE(MAX(expires_at), ?casFallback)
       FROM learner_access_grants
       WHERE user_id = ... AND certification_id = ... AND feature = 'standard'
         AND revoked_at IS NULL) = ?casToken
RETURNING id
```

`casToken` is the exact `MAX(expires_at)` the plan was computed from (or
`casFallback` when there is none), read in this settlement. Zero returned rows
means another settlement appended first, so this attempt wrote **nothing** — no
grant, no transition, no receipt, no event row — and it is retried with a fresh
read, up to three attempts. Only when every attempt loses is the checkout parked
in `needs_support`.

### Operation ids

`"<checkoutId>:standard"` and `"<checkoutId>:pro"`, derived from the **stored**
`commerce_checkouts.id` and nothing else. Never from a provider-supplied or
provider-echoed `checkoutId`, which the fake accepts up to 128 characters, and
never a random suffix: a replay re-inserts the same two ids and fails closed at
`UNIQUE (operation_id)` instead of granting twice. `0018` mints checkout ids at
≤ 118 characters (`chk_` + a UUID is 40) so `":standard"` stays inside the
128-character cap on an operation id.

### Row witnesses

`meta.changes` is never used as a witness. `learner_access_grants` carries an
`AFTER INSERT` audit trigger (0013), so one audited grant insert reports **two**
changes; every statement here returns `RETURNING id` and the returned rows are
counted. A test asserts both numbers to keep that reason on the record.

### What a settlement writes

| SKU | Grants |
|---|---|
| `standard-3m`, `standard-6m`, `standard-12m`, `standard-topup-3m`, `standard-extension-30d` | one Standard `[coverageEnd, coverageEnd + term)`, `source='purchase'` |
| `pro-3m` | one Pro `[now, now + proTerm)`, `source='purchase'` |
| `bundle-standard-3m-pro` | Standard `[now, max(addTerm(coverageEnd, term), addTerm(now, term)))` and Pro `[now, addTerm(now, term))`, both `source='bundle'`, both sharing one `now` |

`coverageEnd` is the end of non-revoked Standard coverage, floored at `now`. The
bundle is the one SKU whose Standard leg starts at `now` rather than at
`coverageEnd`, because 0013 requires a *single* row covering the Pro window. Both
legs share the settlement's one `now`, byte for byte; a test asserts it.

The purchase receipt records the account id, the certification, the currency, the
total, the line items with their snapshotted amounts, the granted windows, the
provider name and opaque reference, the refund window end (`paid_at + 7 days`) and
`issued_at`. It contains no card data, no email address, no IP address, no learner
name and no tax field — no column or field for any of them exists.

### `learner_access_grants_one_pro_window`

One non-revoked Pro window per `(account, exam)`, refused by a `BEFORE INSERT`
trigger whose predicate is the overlap of two half-open windows
(`pro.starts_at < NEW.expires_at AND pro.expires_at > NEW.starts_at`). A trigger
cannot read a clock and a partial unique index cannot either, so overlap — not
"live now" — is the expressible rule, and it is the same predicate
`canPurchasePro` uses. A revoked window is not a window: after a refund the
learner may buy Pro again. This strengthens 0013/0014 and relaxes nothing.

## Failure paths

| Situation | What happens |
|---|---|
| Unknown checkout (an authentic event for a session we do not know) | event row `ignored-unknown-checkout` with `checkout_id = NULL`, plus an audit row (`actor_ref = 'commerce-webhook'`, action `commerce_event_unknown_checkout`, subject = event id), answered `200`. Retrying cannot fix it and a retry storm has a cost. |
| Paid but not applicable (amount or currency mismatch, or every compare-and-swap attempt lost) | nothing granted, no receipt, event row `ignored-inconsistent`, checkout `needs_support` with `paid_at`, answered `200`. The learner is not granted something they did not buy and is not silently refunded; the resolution policy is the owner's, and the two rows are the work queue. Works on a `pending` row and on a row our own expiry already closed (`expired → needs_support`), which is the shape a late mismatch actually arrives in — and the event row commits with the park, so a redelivery is a duplicate rather than a fresh 5xx. |
| A second overlapping Pro window (a bundle and a Pro add-on paid at the same moment) | the Pro insert aborts at 0019, the whole batch rolls back, and the checkout lands in `needs_support` with the event recorded `ignored-inconsistent`. One Pro grant exists, bought by the checkout that arrived first. The same holds when the second checkout had already expired: `expired → needs_support` is legal, so the park is recorded instead of 5xx-ing. |
| Late payment on a row our own expiry closed | settles normally: `expired → paid` is a legal edge because money is money. |
| A provider event for a `failed` checkout | `failed → paid` and `failed → needs_support` are legal from 0020, so a late completion grants or parks instead of vanishing. Money arriving after a failure is either applied (grant, receipt, `200 {duplicate: false}`) or parked in `needs_support` with `paid_at`. The five `status IN ('pending','expired')` predicates in `webhooks.ts` widened with the edge; an edge no statement uses would be decoration. |
| A refund the provider declines | refund row `failed`, nothing revoked, nothing settled, no receipt, checkout still `paid`; answered `409 refund_rejected`. The one-per-exam cap is **not** consumed — the partial index excludes `failed` — so a retry is a new refund row. |
| A refund the provider has not answered | refund row `requested`, nothing revoked, access stays live; answered `202 refund_pending` with the same `refundId`. A retry re-calls the provider with the same idempotency key. "Maybe moved" is not "did not move", and losing access without getting money back is the worse error. |
| A refund that would orphan a separately-bought Pro | both checkouts are refunded in one refund record, Pro revoked before Standard. A **staff-granted** Pro, a dependent checkout outside its own window, or a refund that would leave future-but-not-present Standard coverage is refused `409 refund_requires_support` and nothing moves. |
| A refund stuck in `requested` | the row holds the one-per-exam slot until an operator resolves it. **Two shapes, and only one of them may be written `failed`.** (a) The provider never confirmed — a timeout, no answer — so no money moved: `requested → failed` is correct and frees the slot, and the cap is not consumed. (b) The provider **did** confirm and our settle refused — a purchase landed during the provider call, or 0014 aborted every retry (`docs/commerce-refunds.md` §4.3). Money has moved, so `failed` would assert the opposite; it would also drop the row out of `commerce_refunds_one_per_exam` and out of the `anotherRefundForExam` check, freeing the cap while the checkout is still `paid` with its window open, which lets the same checkout be paid back a **second** time. Shape (b) therefore stays `requested`, holding the slot, and is resolved by support against the provider's own record. |
| Provider outage during checkout creation | the `pending` row stays with no session, `503 provider_unavailable`, and the retry with the same client key calls the provider again with the same idempotency key. |
| Database error during settlement | the batch is one transaction, so nothing was written; `handleProviderWebhook` catches the unexpected error and answers `503 provider_unavailable`, and the provider retries the same event. Nothing about the body, the signature or the event id is logged. |

## Refunds — `0020_refunds.sql`

Two tables, eight rules of their own, one replacement and two new triggers on
`commerce_checkouts`. Full design: [`docs/commerce-refunds.md`](commerce-refunds.md).

### `commerce_refunds` and `commerce_refund_lines`

A refund row is the **decision**: learner, exam, requester, currency, amount, the
learner's free-text reason (1–200, stored once and never copied into
`audit_events`), `operation_id` (`refund:<id>`), and a status of `requested |
settled | failed`. Only `status`, `settled_at` and `provider_refund_id` may ever
change, and only from `requested`; `commerce_refunds_status_transition` allows
`requested → {settled, failed}` and nothing else.

A refund line names one checkout at its full price, plus `window_ends_at` — the
deadline the decision was taken under, copied from `pricing.ts` so storage
enforces the *ordering* (`requested_at < window_ends_at`) without holding a second
copy of the seven-day constant.

| Rule | Where | Refuses |
|---|---|---|
| one self-serve refund ever per (account, exam) | `commerce_refunds_one_per_exam`, a partial unique index on `(user_id, certification_id) WHERE requested_by_user_id = user_id AND status <> 'failed'` | a second learner refund for one exam. A staff requester is exempt by construction, and a `failed` row (a decline that moved no money) does not consume the cap. |
| a line names a payable checkout | `commerce_refund_lines_validate_insert` | a line for a checkout that is not `paid`, belongs to another learner/exam/currency, is not refunded in full, or was decided after its window |
| no second payout | `commerce_refund_lines_not_already_settled` | a line for a checkout that already appears in a settled refund — the guard that survives a future staff route, which the one-per-exam index does not cover |
| append-only | `commerce_refund_lines_no_update/_no_delete`, `commerce_refunds_no_delete` | every edit and delete of a money record |
| a refunded checkout has a witness | `commerce_checkouts_refunded_requires_settled_refund` | `paid → refunded` with no settled refund naming that checkout |
| a refunded checkout was paid | `commerce_checkouts_refunded_requires_paid_checkout` | `refunded` from any status other than `paid` (or a same-status no-op) — a `pending` or `needs_support` row whose money we do not hold, or may not return yet (#83) |
| a refund settles only over paid checkouts | `commerce_refunds_settle_requires_paid_checkouts` | `requested → settled` while any checkout a line covers is not `paid` — the shape where the batch's own `WHERE status = 'paid'` would match nothing, commit the settle and leave the checkout parked |

### The refund protocol, in one paragraph

Batch 1 records the decision (refund + one line per checkout) and is the first
write; the provider is called outside any transaction with **our** refund id as
the idempotency key; batch 2 revokes **Pro before Standard** (0014 aborts the
other order), settles the refund under a compare-and-swap that counts the
revocations it just wrote, moves each checkout to `refunded`, and writes one
refund receipt per checkout. Every witness is a statement in the same
transaction, so a lost compare-and-swap fails the whole batch instead of
committing a refunded checkout with live access — and every witness is *counted*
against the plan. The count is a tripwire, not a rollback: the batch has already
committed when it is compared, so it can only refuse a `200`. The storage rule for
the shape it cannot fix is `commerce_refunds_settle_requires_paid_checkouts`: a
refund may not settle while any checkout a line covers is not `paid`, which is
exactly the row the checkout statement's `status = 'paid'` filter would skip. If a
purchase settles while the provider call is in flight, the batch cannot add it (the
lines are immutable and the provider has the amount) and the coverage-gap guard
refuses at settle time: the answer is `503 provider_unavailable` with the refund
left `requested`, every grant intact, the checkout still `paid` and access live.
Money returned with access retained, and an operator resolves the ledger — nothing
is silently expanded and nothing is silently revoked. A refund **revokes** rather than
expires, so `evaluateAccess` filters the grant out and the learner is locked with
no grace — ADR 0005's grace is defined for expiry of a grant that still exists.

A refunded purchase does not block a new one: the one-open-checkout index only
covers `pending`, and `proWindowActive` ignores revoked grants. The control on
buy→refund loops is the one-per-exam cap, not a purchase ban.

### Routes

- `POST /api/commerce/checkouts/:checkoutId/refund` — body `{ reason }`. `200`
  settled (and on replay), `202 refund_pending`, `400 refund_window_closed`,
  `404 checkout_not_found`, `409 refund_already_used | refund_requires_support |
  refund_not_allowed | refund_rejected`, `503 provider_unavailable`.
- `GET /api/commerce/receipts?certificationId=` — the caller's receipts for one
  exam, `issued_at DESC`, `limit` 1–50 (default 50, no cursor).
- `GET /api/commerce/receipts/:receiptId` — one receipt, owner-scoped in the
  `WHERE`.

Every response is `private, no-store`, `X-Robots-Tag: noindex, nofollow` and
carries `X-Request-Id`; the `POST` also requires `Origin` and `X-CSRF-Token`. An
undiagnosed failure on any commerce route answers `500 internal_error` in the same
envelope with the same correlation id and private headers, and logs
`{requestId, route, name, message}` — never the body and never the learner's
`reason`.

### #79 — the receipt's `refund_id`

`0019` created `commerce_receipts.refund_id` without a foreign key because
`commerce_refunds` did not exist. `0020` enforces it with a trigger,
`commerce_receipts_refund_references_settled_refund`, rather than a 12-step table
rebuild — the rebuild would have to drop and recreate both append-only triggers,
and the foreign key could not express what the rule actually needs: that the
refund is **settled**, that learner, exam and currency agree, and that the
receipt's total equals the refund line for that checkout. The trigger is stronger
than the key it stands in for.

### Still absent, and where it belongs

- Refunds of a `needs_support` checkout, and the resolution policy for parked
  money: an open owner decision (issue #83). B3 deliberately implements no
  parked-refund path, and a `needs_support` checkout reports a refund window no
  route honours.
- Staff-initiated refunds, goodwill credits, partial or line-level refunds,
  refunds outside seven days: Phase 5 admin commerce. No capability, no route.
- Any real payment provider, tax, invoicing, delivery of receipts by email,
  coupons, proration and recurring billing: unchanged, and still out of scope.

## No price constant outside the price list

Acceptance criterion 18: no price or currency constant exists outside
`apps/api/src/pricing.ts`. The evidence is a grep over the shipped source:

```
grep -rnE "\b(5900|8900|12900|4900|9900|3900|2500|5_900|8_900|12_900|4_900|9_900|3_900|2_500)\b" apps/api/src apps/web/app
apps/api/src/pricing.ts:65:    amountMinor: 5_900,
apps/api/src/pricing.ts:72:    amountMinor: 8_900,
apps/api/src/pricing.ts:79:    amountMinor: 12_900,
apps/api/src/pricing.ts:86:    amountMinor: 4_900,
apps/api/src/pricing.ts:93:    amountMinor: 9_900,
apps/api/src/pricing.ts:100:    amountMinor: 3_900,
apps/api/src/pricing.ts:109:    amountMinor: 2_500,
```

The offers and checkout responses carry `priceList[sku].amountMinor`, and the
bundle's Pro line is a subtraction of two entries, never a third constant.
