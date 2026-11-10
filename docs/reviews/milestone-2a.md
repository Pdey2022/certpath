# Milestone 2A review handoff

Status: **proposed design for architect/owner review**. This branch contains
documentation only. It does not configure an identity service, add database
migrations, implement authentication/authorization, or start Milestone 2B.

## Summary

- Read `AGENTS.md`, product design, build plan, permissions, the accepted
  Cloudflare/React Router architecture decision, open decisions, save/resume,
  SEO and Milestone 0 review handoff.
- Confirmed `main` and `origin/main` matched at
  `3d2b12a61b9228f7cd2e07b6297e243fb1b75dea` before branching.
- Created `feat/milestone-2a-security-design`.
- Compared Auth0 Customer Identity (B2C) and Amazon Cognito User Pools using
  current official documentation, checked 10 November 2026. Added Firebase
  Authentication with Identity Platform as a lower-cost candidate. The
  comparison distinguishes its free MAU allowance from the Identity Platform
  upgrade required for production TOTP MFA, and does not rely on temporary
  trial credits.
- Auth0 remains a **candidate recommendation**, not a selection. The owner and
  architect must approve a provider, market, region/residency, full cost
  envelope, event coverage, and staff MFA/session policy before implementation
  or paid setup. No provider account was created.
- Specified default-deny Global Admin/Manager permissions, certification
  assignment checks, a uniquely keyed one-time initial-Global-Admin bootstrap
  with separate later appointments and last-admin protection, staff MFA
  enforcement, safe account linking, opaque D1 sessions, D1 primary-consistent
  security reads and conditional atomic-batch write patterns, immediate
  application-controlled session revocation, provider-event/status
  revalidation alternatives with pending per-population stale-assurance
  limits, immutable cross-certification content provenance, prototype
  isolation, implementation slices, and behavioral acceptance tests.

## Decision status

### Accepted baseline (unchanged)

- Cloudflare Workers + React Router SSR, same-origin Hono API, and D1 remain
  the approved architecture in
  [ADR 0001](../decisions/0001-cloudflare-react-router.md).
- Exactly two staff roles remain: Global Admin and certification-scoped
  Manager. Both require MFA. Manager scope must be enforced server-side for
  reads, writes, nested IDs, imports, exports and reassignment.
- Public registration does not grant staff access; deny by default.
- Product rules for Standard/Pro coverage, exam-version history, attempts and
  prototype labelling are preserved.

### Proposed, pending architect/owner approval

- Auth0 is the current proof-of-concept recommendation; Cognito and Firebase
  Authentication with Identity Platform remain alternatives. No provider is
  selected.
- Use provider OAuth/OIDC only to establish identity; maintain a stable
  application user ID and opaque, server-revocable D1 session.
- Use explicit, recent proof of both identities for linking. Never merge by
  email alone.
- Require verified provider MFA for every staff request; record MFA assurance
  in server-owned session state. The freshness window and step-up policy remain
  to be approved.
- Provision the first Global Admin through an audited operator procedure that
  consumes one uniquely keyed bootstrap record exactly once. Permit later
  Global Admin appointments through a separate authorized, MFA-protected,
  audited procedure; prevent removal/demotion of the last active Global Admin
  without a separately approved recovery procedure.
- Use immutable question revisions and answer-option rows with a separate
  current-publication pointer and append-only workflow/publication/audit
  history.
- Do not move stable question identities across certifications. Cross-scope
  reuse creates a new question identity with provenance and checks both
  source/destination authorization; published revisions retain fixed
  domain/topic identities and meanings.
- Have Managers create/publish content only within assigned certifications;
  a Manager must be assigned to both scopes for a cross-certification copy.
  Keep the existing proposal that one Manager may publish their own reviewed
  revision unless a separate second-person policy is approved.
- Route session, role, assignment and ownership reads to D1 primary using
  `withSession("first-primary")`; use conditional writes and D1 `batch()` for
  atomic database operations, not assumed interactive transactions.
- Revoke D1 sessions immediately for application-controlled revocations and
  check current session, role and assignment state from D1 primary on every
  protected request. Compare authenticated/replayable lifecycle events with
  bounded provider-status revalidation. External-provider latency is a
  pending measurable policy, not a universal 60-second requirement. Invalid
  events are rejected and investigated without automatically denying
  unrelated users. Approve separate finite staff/learner stale-assurance
  windows and outage behavior before implementation; D1 outages fail closed.
- Create identity/session schema before the routes/code that consume it. Keep
  provider compatibility proof, local schema/permissions work, and production
  first-admin execution separate.
- Keep learner attempt/bookmark/note ownership and attempt-snapshot integrity
  tests deferred to Milestone 3, when those records and routes exist.

## Files changed

- [0002-identity-and-content-architecture.md](../decisions/0002-identity-and-content-architecture.md)
  - Proposed provider evaluation, identity/session boundary, permissions,
    D1 content schema, revision/import integrity, prototype boundary, staged
    work plan, test matrix and official-source links.
- [milestone-2a.md](milestone-2a.md)
  - This planning handoff, decision status and verification record.

No source code, package manifest/lockfile, environment configuration, secret,
database migration or production data was changed.

## Verification

| Command/check | Result |
|---|---|
| `git fetch origin`; compare `git rev-parse main` and `git rev-parse origin/main` | Passed before branch creation; both were `3d2b12a61b9228f7cd2e07b6297e243fb1b75dea`. |
| Official provider/platform and Cloudflare D1 documentation review | Completed on 10 November 2026. Direct links and capability caveats are in the proposal. Prices are a point-in-time comparison, not a quote. D1 `first-primary`, `batch()` transaction/rollback behavior, and replica-consistency limits were checked against Cloudflare documentation. |
| `npm run verify` | Passed on Windows: workspace type checks, 1 API test, 13 web tests, and client/Cloudflare Worker SSR production builds. No dependencies were installed or changed. |
| `git diff --check` | Passed for the current documentation changes before commit; no whitespace errors. |
| Earlier GitHub Actions run [42857695850](https://github.com/Pdey2022/certpath/actions/runs/42857695850) | Passed on commit `7110b33549c3af786a5817d74f99ca5836bdb21`; it did **not** verify the later `3ef0f017492fd855889859cbbab52fe1b553d7be` commit or the corrections in this handoff. |
| Earlier GitHub Actions run [42858109307](https://github.com/Pdey2022/certpath/actions/runs/42858109307) | Passed on commit `3ef0f017492fd855889859cbbab52fe1b553d7be`; it does **not** verify the corrections in this handoff. CI for the corrected head must be reported only with the exact tested commit SHA and run URL. |
| Browser, provider, MFA, session and D1 behavior tests | Not applicable to this planning-only branch; no implementation or provider configuration was performed. |

## Pending owner/architect input

1. Select a provider candidate (Auth0, Cognito or Firebase Authentication with
    Identity Platform) and approve an isolated Worker compatibility proof.
2. Confirm business country/launch market, data residency and retention
   obligations, acceptable provider region, and whether external Google
   identity data is acceptable.
3. Confirm expected MAUs and approve a production-capable MFA plan and total
    cost envelope; Firebase Spark without Identity Platform TOTP is not
    sufficient for staff. Decide whether learners also require MFA.
4. Compare verified lifecycle-event delivery/replay with bounded provider-
    status revalidation for password resets, suspensions and compromise.
    Approve measurable latency and outage policies, including separate finite
    maximum stale-assurance windows for staff and learners.
5. Approve the staff authentication/MFA experience, accepted factors/recovery,
    reauthentication freshness window, and which actions require step-up.
6. Approve session lifetime, remote sign-out behavior, support recovery, and
    provider/application logout behavior.
7. Approve the first-Global-Admin operator identity, change approval, scoped
    credential, audit evidence and bootstrap-disable procedure. Actual
    production bootstrap remains a separate, explicitly approved operation.
8. Confirm whether content approval requires a distinct reviewer/publisher.
   Current product proposals allow an assigned Manager to publish their own
   reviewed revision; a two-person rule is not silently imposed here.
9. Resolve product decisions that affect later attempt/schema behavior,
   especially historical explanation access after Standard expiry and access
   expiry during active attempts, before their implementation gates.

## Known limitations

- Auth0 tenant, Cognito cross-service, and Firebase Identity Platform
  data-residency/processing commitments have not been contractually verified.
- No provider has been tested from the actual Worker runtime. OAuth/OIDC,
  Worker Fetch/Web Crypto and Firebase token-verification documentation are
  compatibility rationale, not a guarantee that vendor SDKs or MFA assurance
  claims work.
- Provider pricing, free-tier rules and plan features can change. Firebase's
  50,000 tier-1 MAU free allowance is not a time-limited trial, but production
  TOTP MFA requires upgrading to Identity Platform; temporary Google Cloud
  trial credits are excluded. Email/SMS, support, region, tax and ancillary
  service charges may be additional.
- Provider documentation reviewed here does not establish complete lifecycle
  event delivery/replay or bounded provider-status availability for every
  candidate. Coverage, measured latency, and separate staff/learner maximum
  stale-assurance windows remain approval and proof gates. Invalid events are
  rejected and investigated without automatically denying unrelated users;
  D1 outages still fail closed immediately.
- The proposed schema has not been validated against D1/SQLite migration
  constraints or performance. Cloudflare documents `withSession("first-primary")`
  and atomic sequential `batch()` rollback behavior; exact conditional-write,
  result-count and trigger patterns still require local and remote
  non-production tests.
- No production authentication, staff permission enforcement, database
  persistence, paid provider account, deployment, or real content exists as a
  result of this work.

## Architect inspection

1. Review the proposed status and all unresolved items in
   [0002-identity-and-content-architecture.md](../decisions/0002-identity-and-content-architecture.md).
2. Compare its role definitions to [permissions.md](../permissions.md), product
   invariants to [product-design.md](../product-design.md), and architecture
   boundary to [ADR 0001](../decisions/0001-cloudflare-react-router.md).
3. Check each provider capability against the official source links and decide
   whether the recommendation or assumptions need revision.
4. Approve, amend, or reject the provider and security decisions before
   authorizing the next implementation milestone.
5. Do not configure a provider or deploy from this planning-only branch.
