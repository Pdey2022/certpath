# Delivery plan: from prototype to pilot

This plan sequences the work that remains after Milestone 3. It does not replace
`docs/build-plan.md` (which defines the milestones) or `docs/product-design.md`
(which defines the product). It records **order, dependencies, exit criteria and
issue tracking** so a phase cannot quietly start before its prerequisites exist.

Each phase ships as one or more draft pull requests against `main`, with a
decision record where a product rule is involved.

## Current position (21 November 2026)

| Area | State |
|---|---|
| Milestones 0-3C | Complete: foundation, prototype, local security, versioned content, admin editor/review/imports, learner practice, timed mocks, dashboard |
| Staff sign-in and second factor | **5F merged (#164) and deployed to staging**: in-Worker TOTP, recovery codes and a Global-Admin reset replace the `tester-gate` assurance. The IP allowlist and the staging gate remain as defence in depth, not as assurance |
| Staff provisioning | Remote mode merged (#188), and the staging staff surface is configured — five hosted secret **names** only, recorded in [pilot-provisioning](pilot-provisioning.md) §State. The provisioned account and its enrolled factor are recorded in #190, not in a repository file |
| **Phase 4 Commerce** | **Complete and merged (#87)**: entitlements, checkout, settlement, refunds with access revocation — **against the fake provider**. `PAYMENT_PROVIDER` (`none`) and `COMMERCE_ENABLED` (`false`) are declared only in `apps/web/wrangler.jsonc`; every other Wrangler config omits both, which the exact-string gate reads as off. No real charge has ever been possible |
| **Phase 5 Pilot hardening** | **5A, 5B, 5C and 5F merged; 5D and 5E not started.** `learner-auth-staging` is deployed by the pipeline (latest `7aa7518`, 21 November 2026), the database holds **23 applied migrations** (last `0023_staff_second_factor.sql`), exports and rehearsed restores pass, and both funnel flags plus `PILOT_EVENTS_RETENTION_ENABLED` are `"false"`. 5D (fake door) and 5E (hostname) wait on owner decisions ([slice plan](pilot-hardening.md)) |
| Evidence | Worker CPU still **unmeasured**; the staging deploy, migration ledger and rehearsed restores are recorded in [pilot-provisioning](pilot-provisioning.md) §State. The isolated sign-in/edit/reload proof from the tester-gate era survives in [reviews/admin-production-rollout.md](reviews/admin-production-rollout.md) |
| Decisions | ADR 0003-0007 accepted; `docs/permissions.md`, `docs/open-decisions.md` and `docs/pilot-provisioning.md` are current |

## Phases

| Phase | Issue | Scope | Depends on |
|---|---|---|---|
| **0. Decision records** | this PR | ADRs 0003-0006, permissions rewrite, open-decisions reconciliation, this plan | - |
| **1. Entitlement and price model** | #44 | Price list (server-side), access grants, `canAccess` with active/grace/expired, Pro coverage rules, entitlement = Global Admin only | Phase 0 |
| **2. Readiness and dashboard v1** | #45 | Readiness v1 snapshots, bands, decay, next action, Pro prompt | Phase 1 |
| **3. Admin capability model** | #46 | Capability table, learner support with masked data and audited reveal, audit retention | Phase 1 |
| **4. Commerce** | #47 | `PaymentProvider` port with a fake, checkout, webhooks, refunds and access revocation | Phases 1, 3 |
| **5. Pilot hardening** | #48 | Isolated staging D1, rehearsed exports and restores, funnel events, hostname decision, MFA before real learners ([slices 5A-5F](pilot-hardening.md)) | Phases 3, 4 |
| **6. CAT/adaptive Pro** | #49 | Blueprint-weighted item selection, session model, Pro reports, CISSP only | Phases 2, 4 and a stocked bank |

Phases 1-3 are strictly sequential because they share the entitlement predicate.
Phase 4 can begin against a fake provider as soon as Phase 1 lands. Phase 6 is
**post-pilot** on purpose: launch sells Standard only, so the adaptive engine is
not on the critical path to revenue.

## Parallel track: content (starts now, not after Phase 1)

~600 authored and reviewed questions per exam, blueprint-weighted, text only,
English. This is the longest lead time in the plan (~1,200 items for two exams)
and the real launch blocker. It runs alongside Phases 1-4 and must not wait for
a milestone gate.

Author != reviewer is **not** enforced in the database. `content_reviews` stores
the reviewer separately from the publisher, and nothing in the schema or in
`recordQuestionReview` requires a reviewer to differ from the author of the
revision; an independent-review requirement is a separate policy decision with
its own migration. The content policy (original work, no live-exam
reconstruction) remains a prerequisite for the first author.

The CISSP pilot is a documented exception: the owner authors that bank and is
its only reviewer ([decisions](decisions/0006-content-and-operations-posture.md)).

## Definition of done (every phase)

1. `npm run verify` passes, with the tests named in the issue.
2. Behaviour is enforced server-side; the UI only reflects it.
3. A decision record exists for any product rule the phase introduces or changes.
4. The relevant doc is updated in the same PR (permissions, readiness, analytics).
5. Rollback or disable path stated: what turns the behaviour off without a revert.
6. No credential, learner PII, or licensed content enters the repository.

## Operating constraints

- **$0 during the tester phase.** Workers Free, no paid plan, no Logpush, no
  OpenTelemetry export, no object storage until a phase needs it.
- **Email stays off** until a transactional provider is chosen; Cloudflare Email
  Workers covers inbound only.
- **No production deployment** without owner approval, and no real learner data
  until the staff second factor is deployed to production and every staff account
  that will hold data is enrolled.
- **Public site and demo stay live and unchanged** by admin or commerce work.

## Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Content authored later than code | Pilot slips with a working app and an empty bank | Content starts in parallel; ~600/exam scoped, not "unlimited" |
| Readiness percentage seen as a guarantee | Trust damage, refunds | Bands, basis line, versioned formula, 14-day decay |
| Learner access wider than the staff surface allows | PII exposure | 5F's second factor is deployed; the tester allowlist and the staging gate still restrict who can reach the app |
| Previews share the production D1 | Accidental writes during review | Isolated staging D1 (Phase 5) |
| Pricing never validated | Wrong price baked into checkout | Fake-door test before Phase 4 commitments |
| Worker CPU still unmeasured | Unknown headroom for CAT work | Obtain Observability access before Phase 6 sizing |

## After the pilot

Pro/CAT (Phase 6), device and session controls (Milestone 5), then recurring
billing only if retention data justifies it. None of those are prerequisites for
a first paid Standard learner.
