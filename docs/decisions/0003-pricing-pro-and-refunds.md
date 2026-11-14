# ADR 0003: Pricing, Pro, refunds and samples

- Status: Accepted as the launch proposal, with owner approval on 2026-11-14.
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

1. Pro is **per exam**, valid for **at most 3 months**, and requires Standard with
   **at least 90 days remaining** at purchase.
2. Pro is offered only on certifications whose real exam is adaptive. CISSP is
   the only such exam at launch; enablement is a **Global Admin** commercial
   decision, recorded per certification.
3. Pro is sold again only when the previous Pro window has ended:
   `lastProStart + 90 days <= now` **and** `standardRemaining >= 90 days`.
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
- The 90-day rule forces a top-up SKU. Hiding standalone Pro when Standard has
  under 90 days left is a pricing rule enforced server-side, not a UI choice.
- Chaining Pro ($49 per 3 months) costs more than Standard-12 ($129), so it needs
  no anti-abuse control.
- **Price points are provisional** until a fake-door test measures click-through
  at $59 / $79 / $99 for Standard-3 with Pro at $49. That test requires the
  consent-aware event path, since Cloudflare Web Analytics records no custom
  events (ADR 0006).
- Tax, invoicing, and consumer-law obligations per market remain open and must be
  settled before real money is taken.
