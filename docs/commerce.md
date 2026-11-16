# Commerce

What exists today, and what does not. This file describes only shipped
behaviour; settlement, the webhook, refunds and receipts are listed at the end as
explicitly absent, so nothing here can be read as a promise that a route exists.

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
| Checkout schema: checkouts, price-snapshot lines, provider events | `db/migrations/0018_commerce_checkouts.sql` |
| Offers projection and checkout creation | `apps/api/src/commerce/checkouts.ts` |
| Learner commerce routes | `apps/api/src/commerce/http.ts` |
| Checkout expiry for the `scheduled` handler | `apps/api/src/commerce/expire.ts` |
| Commerce contracts | `packages/contracts/src/commerce.ts` |
| Dashboard Pro prompt | `apps/api/src/security/learner-dashboard.ts` |

A learner can be quoted a price and can create a checkout that a provider hosts.
**No access is granted by anything in this phase**: `learner_access_grants` is not
written by any commerce code path, and no provider event is accepted, because no
webhook route exists until the next change.

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

`standardCoversProWindow(grants, now)` and
`canPurchasePro({ standardGrants, … })` take the grant rows rather than a
pre-computed `{startsAt, endsAt}` pair. A pair can be synthesised from two
different grants and is not a witness of anything: `g1 = [now − 90d, now + 10d)`
plus `g2 = [now + 1d, proEnd + 30d)` yields a start from `g1` and an end from
`g2`, neither of which covers the Pro window, so 0013 would refuse the insert
after money was taken. Handing the gate the rows makes "the gate allowed it" and
"0013 accepts it" the same statement.

`canPurchasePro()` returns one of:

| Reason | Meaning |
|---|---|
| `pro-not-offered` | the exam is not enabled for Pro |
| `standard-too-short` | no single Standard grant spans `now` to `addTerm(now, proTerm)`; the bundle or a top-up is the path |
| `pro-window-active` | a non-revoked Pro grant ends after `now` |

The repurchase check reads the **stored** Pro expiry. It never re-derives an
expiry from a start instant.

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
session.

`createCheckout` and `resolvePaymentProvider` are wired into checkout creation.
`verifyEvent` and `refund` are **not** wired into any route: there is no webhook
and no refund until the next change.

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

One row is a request to buy: `id`, `user_id`, `certification_id`,
`client_checkout_key`, `request_fingerprint`, `currency`, `total_minor`,
`status`, `provider`, `provider_session_id`, `provider_redirect_url`,
`created_at`, `updated_at`, `expires_at`, `paid_at`.

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
| `commerce_checkouts_immutable` | any change to `user_id`, `certification_id`, `client_checkout_key`, `request_fingerprint`, `currency`, `total_minor`, `provider`, `created_at`, `expires_at` |
| `commerce_checkouts_status_transition` | any edge outside `pending → {paid, failed, expired, needs_support}`, `expired → paid`, `paid → needs_support` (no-op same-status writes are allowed) |
| `commerce_checkouts_no_delete` | every delete |

`expired → paid` is deliberate: money taken after our own deadline is money
taken, so a late `checkout.completed` still applies. `paid → refunded` is **not**
permitted yet — the `refunded` value is in the enum because the column must
accept it, but its witness (`commerce_refunds`, in `0019`) does not exist, and a
refunded checkout with no refund record is exactly the state the design forbids.
`0019` replaces this trigger with that edge and its witness.

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
personal data beyond opaque ids. **Nothing writes to it in this phase**; `0019`
does.

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
   `standard_too_short`, so the bundle is surfaced rather than hidden.
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
`{ checkoutId, status, currency, totalMinor, lines[], redirectUrl, expiresAt,
paidAt, refundWindowEndsAt }`, where each line is
`{ sku, label, amountMinor, feature, term, priceSource }` and `term` is the
`TermSpec` the line grants — never a day count standing in for a month. `paidAt`
and `refundWindowEndsAt` are `null` because nothing in this phase can pay a
checkout.

Status codes: `201` created, `200` replay, `400 validation_error | unknown_sku |
invalid_origin | invalid_csrf`, `401 unauthenticated`,
`404 certification_not_found`, `409 purchase_not_allowed | idempotency_conflict`,
`413 payload_too_large`, `415 unsupported_media_type`,
`503 commerce_disabled | provider_unavailable`. An unknown SKU is `unknown_sku`
rather than `validation_error` because the request accepts a string and checks it
against the price list; every other malformed body is `validation_error`.

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
once it can no longer be used.

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

Not yet observable: both legs sharing one `operation_id`. `learner_access_grants`
`operation_id` is `UNIQUE` and `audit_events.operation_id` is the primary key, so
the two grant rows cannot share one id. Decided on 2026-11-16: the legs carry
`"<checkoutId>:standard"` and `"<checkoutId>:pro"`, derived from the stored
`commerce_checkouts.id` and never a random or provider-supplied value, so a
replay re-inserts the same two ids and fails closed at `UNIQUE` instead of
granting twice. This phase mints the checkout ids at **≤ 118 characters**
(`chk_` + UUID is 40) so `":standard"` stays inside the 128-character cap on an
operation id, and a test asserts the bound. `0019` writes the grants.

## Nothing is written to `learner_access_grants`

No commerce code path inserts, updates or revokes a grant, and `0018` adds no
trigger to that table. The only way an entitlement exists is still a row in
`learner_access_grants` carrying a deterministic `operation_id`; when `0019`
settles a checkout it will read the price snapshot these lines record, not the
price list.

## Owner decisions carried forward

Decided by the owner on 2026-11-16; not implemented, and not implemented
elsewhere either:

- One self-serve refund **ever** per `(account, exam)`.
- A refund of a Standard purchase that would orphan a separately-bought Pro
  refunds **both** checkouts in one refund record, Pro revoked before Standard.

## Arrives in the next commerce change (not present today)

Nothing below exists. No table, route, binding or job for it has shipped.

- Settlement of a checkout into grants, and the
  `learner_access_grants_one_pro_window` trigger.
- The one authenticated webhook route (`POST /api/commerce/webhooks/:provider`)
  and the local-only `dev/fake-pay` seam. `commerce_provider_events` and
  `verifyEvent` exist; no route calls them.
- Tables: `commerce_receipts`, `commerce_refunds`, `commerce_refund_lines`.
- The `paid → refunded` status edge and
  `commerce_checkouts_refunded_requires_settled_refund`.
- `POST /api/commerce/checkouts/:checkoutId/refund` and the receipt reads.

Still out of scope even then: any real payment provider (a change to PCI scope
and cost), tax, invoicing, delivery of receipts by email, coupons, proration and
recurring billing.

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
