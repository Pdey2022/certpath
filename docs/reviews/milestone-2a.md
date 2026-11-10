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
  current official documentation, checked 10 November 2026. Listed which
  provider capabilities are documented and which Cloudflare/runtime, data
  residency, plan, and operational conclusions remain assumptions or require
  confirmation.
- Recommended Auth0 as a **candidate**, not a selection. The owner and
  architect must approve the provider, market, region/residency, cost envelope,
  and staff MFA/session policy before implementation or paid setup.
- Specified default-deny Global Admin/Manager permissions, certification
  assignment checks, safe first-Global-Admin bootstrap, staff MFA enforcement,
  account linking, opaque D1 sessions, a revision-oriented D1 content model,
  import/review/publication integrity, prototype isolation, implementation
  slices, and behavioral acceptance tests.

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

- Auth0 is the preferred proof-of-concept candidate; Cognito remains the
  alternative. No provider is selected.
- Use provider OAuth/OIDC only to establish identity; maintain a stable
  application user ID and opaque, server-revocable D1 session.
- Use explicit, recent proof of both identities for linking. Never merge by
  email alone.
- Require verified provider MFA for every staff request; record MFA assurance
  in server-owned session state. The freshness window and step-up policy remain
  to be approved.
- Provision the first Global Admin through an audited, one-time operator
  procedure, never public registration or a permanent bootstrap endpoint.
- Use immutable question revisions and answer-option rows with a separate
  current-publication pointer and append-only workflow/publication/audit
  history.
- Have Managers create/publish content only within assigned certifications;
  both sides of a content move must be assigned. Keep the existing proposal
  that one Manager may publish their own reviewed revision unless a separate
  second-person policy is approved.

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
| Official provider/platform documentation review | Completed on 10 November 2026. Direct links and capability caveats are in the proposal. Prices are a point-in-time comparison, not a quote. |
| `npm run verify` | Passed on Windows: workspace type checks, 1 API test, 13 web tests, and client/Cloudflare Worker SSR production builds. No dependencies were installed or changed. |
| `git diff --check` | Passed after staging the two documentation files; no whitespace errors. |
| Browser, provider, MFA, session and D1 behavior tests | Not applicable to this planning-only branch; no implementation or provider configuration was performed. |

## Pending owner/architect input

1. Select the managed provider and approve whether a small Worker compatibility
   proof-of-concept is the next step.
2. Confirm business country/launch market, data residency and retention
   obligations, acceptable provider region, and whether external Google
   identity data is acceptable.
3. Approve an MFA-capable plan and monthly cost envelope based on expected MAUs;
   decide whether MFA is required for learners too or only for staff sessions.
4. Approve the staff authentication/MFA experience, accepted factors/recovery,
   reauthentication freshness window, and which actions require step-up.
5. Approve session lifetime, remote sign-out behavior, support recovery, and
   provider/application logout behavior.
6. Approve the first-Global-Admin operator identity, change approval, scoped
   credential, audit evidence and bootstrap-disable procedure.
7. Confirm whether content approval requires a distinct reviewer/publisher.
   Current product proposals allow an assigned Manager to publish their own
   reviewed revision; a two-person rule is not silently imposed here.
8. Resolve product decisions that affect later attempt/schema behavior,
   especially historical explanation access after Standard expiry and access
   expiry during active attempts, before their implementation gates.

## Known limitations

- Auth0 tenant data residency details and Cognito's complete cross-service
  processing/location commitments have not been contractually verified.
- Neither provider has been tested from the actual Worker runtime. Generic
  OAuth/OIDC support plus Worker Fetch/Web Crypto is compatibility rationale,
  not a guarantee that a vendor SDK or MFA-claim mapping works.
- Provider pricing, free-tier rules, and plan features can change and require
  reconfirmation before procurement. Email/SMS, support, region, tax and
  ancillary-service charges may be additional.
- The proposed schema has not been validated against D1/SQLite migration
  constraints or performance. Migration review and concurrency tests belong
  to implementation.
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
