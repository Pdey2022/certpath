# Delivery plan: from prototype to pilot

This plan sequences the work that remains after Milestone 3. It does not replace
`docs/build-plan.md` (which defines the milestones) or `docs/product-design.md`
(which defines the product). It records **order, dependencies, exit criteria and
issue tracking** so a phase cannot quietly start before its prerequisites exist.

Each phase ships as one or more draft pull requests against `main`, with a
decision record where a product rule is involved.

## Current position (14 November 2026)

| Area | State |
|---|---|
| Milestones 0-3C | Complete: foundation, prototype, local security, versioned content, admin editor/review/imports, learner practice, timed mocks, dashboard |
| Admin tester gate and staff sign-in | Built and merged; tester-only, MFA parked, assurance labelled `tester-gate` |
| Staff provisioning | Local and UUID-pinned remote mode merged; never run against a real database |
| Evidence | Isolated workflow passed (sign-in, edit, reload); Worker CPU still **unmeasured** (Observability returns 403) |
| Decisions | ADR 0003-0006 accepted; `docs/permissions.md` and `docs/open-decisions.md` updated |

## Phases

| Phase | Issue | Scope | Depends on |
|---|---|---|---|
| **0. Decision records** | this PR | ADRs 0003-0006, permissions rewrite, open-decisions reconciliation, this plan | - |
| **1. Entitlement and price model** | #44 | Price list (server-side), access grants, `canAccess` with active/grace/expired, Pro 90-day rules, entitlement = Global Admin only | Phase 0 |
| **2. Readiness and dashboard v1** | #45 | Readiness v1 snapshots, bands, decay, next action, Pro prompt | Phase 1 |
| **3. Admin capability model** | #46 | Capability table, learner support with masked data and audited reveal, audit retention | Phase 1 |
| **4. Commerce** | #47 | `PaymentProvider` port with a fake, checkout, webhooks, refunds and access revocation | Phases 1, 3 |
| **5. Pilot hardening** | #48 | Isolated staging D1, pre-migration exports, funnel events, hostname decision, MFA before real learners | Phases 3, 4 |
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

Author != reviewer is enforced in the database; the content policy (original
work, no live-exam reconstruction) is a prerequisite for the first author.

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
  until MFA replaces the tester-gate assurance.
- **Public site and demo stay live and unchanged** by admin or commerce work.

## Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Content authored later than code | Pilot slips with a working app and an empty bank | Content starts in parallel; ~600/exam scoped, not "unlimited" |
| Readiness percentage seen as a guarantee | Trust damage, refunds | Bands, basis line, versioned formula, 14-day decay |
| Platform-wide learner access with MFA parked | PII exposure | Tester allowlist only; MFA is a Phase 5 gate |
| Previews share the production D1 | Accidental writes during review | Isolated staging D1 (Phase 5) |
| Pricing never validated | Wrong price baked into checkout | Fake-door test before Phase 4 commitments |
| Worker CPU still unmeasured | Unknown headroom for CAT work | Obtain Observability access before Phase 6 sizing |

## After the pilot

Pro/CAT (Phase 6), device and session controls (Milestone 5), then recurring
billing only if retention data justifies it. None of those are prerequisites for
a first paid Standard learner.
