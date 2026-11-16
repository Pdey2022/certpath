# ADR 0003: Pricing, Pro, refunds and samples

- Status: Accepted as the launch proposal, with owner approval on 2026-11-14.
  Amended 2026-11-16 (see "Amendment" at the end) to replace the flat 90-day Pro
  gate with the coverage predicate, and to fix terms as calendar months.
- Scope: Commercial rules only. No payment provider, checkout, tax or currency
  implementation is decided here.
- Supersedes: nothing. Extends the product contract in `docs/product-design.md`.

## Context

Standard grants one exam's published questions, explanations, practice, normal
mocks and progress for 3, 6 or 12 months. Pro adds adaptive (CAT-faithful)
preparation for exactly 3 months and requires Standard for the same exam
throughout. Prices, currency, refund policy and sample policy were unresolved in
`docs/open-decisions.md`, which blocked Milestone 4 (commerce and entitlement).

The buyer already pays $575-$749 for the real exam. A retake costs the same
again, which is the largest number in the decision and the natural anchor.

## Decision

Currency is **USD with one global price list** per exam. Fixed-term, one-off
purchases only; no recurring billing at launch.

| SKU | Price | Rule |
|---|---|---|
| Standard 3 months | $59 | hero SKU, advertised price |
| Standard 6 months | $89 | same exam, extends the window |
| Standard 12 months | $129 | same exam, longest window |
| Pro 3 months | $49 | CAT-capable exams only, requires Standard |
| Standard-3 + Pro bundle | $99 | presented as two line items, one checkout |
| Standard top-up (3 months) | $39 | only to make Pro fit inside Standard |
| Standard extension (30 days) | $25 | edge case; never shortens Pro |

Pro rules:

1. Pro is **per exam**, valid for exactly **3 calendar months** measured in UTC
   from the purchase instant and clamped to the last valid day, and requires
   Standard coverage that reaches a full Pro term: a non-revoked Standard grant
   for the same `(account, exam)` with `starts_at <= now < expires_at` **and**
   `expires_at >= addTerm(now, proTerm)`. Equality is allowed. This is the same
   predicate as `learner_access_grants_pro_requires_standard` (0013), so a
   purchase the gate accepts cannot be refused at insert. 90 days survives only
   as display copy (`proDisplayMinStandardDays`), never as a gate.
2. Pro is offered only on certifications whose real exam is adaptive. CISSP is
   the only such exam at launch; enablement is a **Global Admin** commercial
   decision, recorded per certification in `certification_pro_enablement`.
3. Pro is sold again only when the previous Pro window has ended: the stored Pro
   grant's `expires_at <= now` **and** rule 1's coverage predicate holds. The
   stored expiry is read, never re-derived — calendar addition does not compose
   (`31 Jan + 1 month + 1 month` is 28 March, `31 Jan + 2 months` is 31 March),
   so `start + term` is not a stable way to find the end of a window.
4. Pro is never shortened. When Standard cannot cover it, the only path is the
   bundle or a Standard top-up first.
5. Pro is always visible and purchasable; a **readiness signal** (ADR 0005) only
   changes when it is *recommended*.

Refunds: **7 calendar days from purchase, no questions, one per account per
exam**. Not consumption-based, so no attempt counts are inspected. Access ends
when the refund is processed.

Free sample: a **guest sample of 10 questions plus one mini mock**, no account
required, no saved progress. It exists to make the quality visible, not to be a
trial.

## Alternatives considered

- _$79 / $109 / $149_: better margin, but lands above the $99 impulse line that
  competing question banks occupy.
- _Pro at $59_: cleaner margin, but at $59 Standard-3 it would price Pro at 100%
  of the entire learning product.
- _Recurring subscription_: rejected for launch; adds billing failure, dunning and
  cancellation paths before retention is proven.
- _Consumption-based refunds_: rejected; turns support into an arbitration over
  attempt counts.
- _Pro for every exam_: rejected; a linear exam makes the CAT promise false.

## Consequences

- Pro at $49 is **83% of a 3-month Standard**, so the $99 bundle ("+$40 for Pro")
  must be the lead offer. If standalone Pro conversion is weak, adjust the Pro
  price, never the Standard price.
- The coverage rule forces a top-up SKU. Refusing standalone Pro when Standard
  cannot cover a full Pro term is a pricing rule enforced server-side, not a UI
  choice; the "≈90 days" figure a learner sees is display copy for that rule.
- Chaining Pro ($49 per 3 months) costs more than Standard-12 ($129), so it needs
  no anti-abuse control.
- **Price points are provisional** until a fake-door test measures click-through
  at $59 / $79 / $99 for Standard-3 with Pro at $49. That test requires the
  consent-aware event path, since Cloudflare Web Analytics records no custom
  events (ADR 0006).
- Tax, invoicing, and consumer-law obligations per market remain open and must be
  settled before real money is taken.

## Amendment — 16 November 2026 (owner approved)

Rule 1, rule 3 and the "90-day rule" consequence above are rewritten at the
owner's direction. The flat 90-day gate was wrong in both directions:

- **Too strict** at a 3-month term: Standard bought 1 February 2026 ends
  1 May 2026, which is 89 days, so a learner standing inside a full, untouched
  3-month term was refused Pro. `docs/product-design.md` forbids inferring
  3 months as 90 days.
- **Too permissive**, which is worse: with 91 days of Standard left, the gate
  allowed a Pro window that ran one day past Standard, and the insert aborted at
  `learner_access_grants_pro_requires_standard` (0013) — money taken, no Pro row.

A gate whose predicate differs from the storage predicate is one guarantee split
across two definitions. The gate **is** 0013's predicate now: Standard coverage
reaching `addTerm(now, proTerm)`. `standard-too-short` keeps its identifier and
its "offer the bundle or a top-up" instruction; it now means "your Standard does
not cover a full Pro term".

Two related decisions taken at the same time:

1. **Terms are calendar months**, not day counts: 3, 6 and 12 months in UTC,
   clamped to the last valid day, half-open windows. The single exception is
   `standard-extension-30d`, because this ADR names the SKU "30 days".
2. **The bundle's Standard leg is capped**: a bundle writes Standard
   `[now, max(coverageEnd, addTerm(now, 3 months)))` and Pro
   `[now, addTerm(now, 3 months))`. A mid-term buyer therefore gets exactly three
   extra months of Standard, not the remainder of the old term plus three. The
   capped form satisfies 0013 trivially (`S.expires_at = max(coverageEnd,
   f(now)) >= f(now) = P.expires_at`) and does not depend on calendar arithmetic
   being order-preserving.

Carried forward, not decided here: one self-serve refund ever per
`(account, exam)`, and a refund of a Standard purchase that would orphan a
separately-bought Pro refunds both checkouts in one refund record.
