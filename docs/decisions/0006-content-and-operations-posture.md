# ADR 0006: Content supply and operations posture

- Status: Accepted, with owner approval on 2026-11-14.
- Scope: How content is produced, stored and operated before and during the pilot.

## Context

The repository must never contain real paid question content, and no licensed
bank exists yet. Content is the critical path to a pilot: engineering is ahead of
it. Operational choices (email, analytics, backups, hosting, staging) also need
decisions that do not create cost or production risk while the product is still
tester-only.

## Decision

### Content

- Content is **authored in-house by domain experts**, not licensed and not mined
  from live exams. Target **~600 questions per exam**, blueprint-weighted across
  domains (roughly two full mocks' worth of depth).
- Items are **original work**. Reproducing or reconstructing live exam items is
  prohibited by the certification bodies' terms and is a legal risk, not a style
  preference. A short written content policy must exist before the first author
  starts.
- **Author != reviewer** is enforced in the database, not only the UI, because
  self-authored content without a second pair of eyes is where answer-key drift
  lives.
- English only at launch. The content model stays text-in/text-out with no locale
  baked into keys, so translation is later a data task, not a migration.
- **Text only**: no images or diagrams at launch, so no object storage is
  required.

### Operations

- **Email**: Cloudflare Email Workers handles *inbound* routing (for example
  support@). Its `send_email` binding only delivers to destinations verified in
  Email Routing, so it **cannot** send verification, magic links or renewal mail
  to arbitrary learners. Transactional sending therefore needs an external
  provider (Resend, SES) when email is switched on. Email stays off until then.
- **Analytics**: Cloudflare Web Analytics for traffic (free, cookieless) plus the
  repository's own consent-aware event endpoint in D1 for funnels. Web Analytics
  records no custom events, so pricing tests and Pro funnels must be measured
  through the event endpoint, never inferred from pageviews.
- **Backups**: an export is taken **before every migration**, even in the tester
  phase. Time Travel covers recent mistakes; a pre-migration export covers the
  deliberate one. Automated recurring backups become mandatory before real
  learner data exists.
- **Hosting**: `workers.dev` for the tester phase; the public hostname is decided
  with the brand. Changing origin later means re-issuing sessions and re-checking
  every exact-origin configuration, so it is planned work, not a DNS change.
- **Staging**: Workers version previews **share the production D1 binding**. A
  previewed admin build would read and write real data, so previews are either
  given their own isolated D1 in a separate configuration or are treated as
  code-review only and never exercised against data.

## Alternatives considered

- _Licensed bank_: faster to launch, but adds licensing, renewal and editorial
  control costs before any revenue exists.
- _Community-contributed items_: cheap volume, unbounded review load, and
  provenance problems.
- _MailChannels free tier_: withdrawn; not a stable foundation.
- _GA4_: free, but adds consent surface and vendor data flow for a product that
  needs a handful of funnel events.
- _No backups until real users_: true for data-loss exposure, false for migration
  risk, which is highest exactly during rapid schema change.

## Consequences

- ~1,200 authored and reviewed items across two exams is the longest lead time in
  the plan; it must start in parallel with Phase 1, not after it.
- The editorial pipeline (draft, review, publish, retire) already exists and is
  the mechanism for enforcing author != reviewer.
- Email-dependent features (magic links, verification, renewal reminders) remain
  fake-inbox only until a provider is chosen and email is enabled.
- Funnel instrumentation is a Phase 5 deliverable, before any pricing test runs.
