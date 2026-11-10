# Identity and content architecture proposal

- Status: **Proposed; pending architect and owner approval**
- Scope: Milestone 2A planning only. No provider, account, paid service,
  authentication flow, schema, or production permission has been configured.
- Research checked: 10 November 2026. Provider prices and plan features must be
  reconfirmed before selection.

## Baseline constraints

The following are existing accepted product or architecture constraints, not
new decisions:

- Retain React Router SSR on Cloudflare Workers, same-origin Hono API routing,
  and D1. See [ADR 0001](0001-cloudflare-react-router.md).
- The only staff roles are **Global Admin** and **Manager**. Managers are
  assigned to certifications and may work only in those scopes.
- Both staff roles require MFA. Permission checks include list, detail, nested
  resource, mutation, import, export, and reassignment operations.
- Public registration never grants a staff role. Deny by default.
- Keep internal user IDs and authorization in the application, not in browser
  claims. Keep the synthetic Milestone 1 fixture data separate from protected
  production content.
- Preserve the product's per-exam Standard and Pro entitlements, question
  versioning, and attempt history; this proposal does not change those rules.

Provider selection, market, residency obligations, staff MFA freshness, and
first-admin operations remain pending. The recommendation below is not an
accepted provider decision.

## Managed provider comparison

Two candidates were reviewed against their current official documentation:
Auth0 Customer Identity (B2C) and Amazon Cognito User Pools. Both can act as a
managed OIDC/OAuth identity service. Feature statements below are provider
capabilities documented as of the research date; Worker-specific integration
details and operational assumptions are called out separately.

| Concern | Auth0 Customer Identity (B2C) | Amazon Cognito User Pools |
|---|---|---|
| Email registration and verification | Documented database connections, built-in verification links and verification OTP options. Verification can be required by the app's flow. | Documented local user-pool signup and account confirmation, with verification messages. |
| Recovery | Documented Universal Login/email password-reset flow for database users. Social users recover at their social provider. Resetting a password expires the Auth0 session. | Documented self-service password recovery by code sent to a verified recovery address/phone. MFA and recovery channel settings must be coordinated; a user's MFA destination cannot also receive the reset code. |
| Google sign-in | Documented Google social connection using OAuth 2.0. Requires Google OAuth credentials and Auth0 connection configuration. | Documented Google social IdP federation through the user pool's managed login. Requires Google app credentials and attribute/scope mapping. |
| Safe account linking | Documented linking of distinct identities. Auth0 warns that both accounts should authenticate before linking and every manual link should prompt for credentials. Feature availability varies by plan. | Documented `AdminLinkProviderForUser` operation links an external IdP identity to an existing pool user and requires IAM authorization. It is an administrative operation, not a safe automatic email-match rule. |
| Worker compatibility | OIDC/OAuth authorization-code flow and HTTPS endpoints are a protocol fit. Cloudflare documents Web Crypto and Fetch APIs. No Auth0 Worker-specific SDK compatibility was established in this review; avoid assuming a Node SDK runs unchanged. | User pools expose OAuth/OIDC endpoints and JWTs. Cloudflare documents the Web Crypto and Fetch APIs needed by a standards-based Worker client. No Cognito-specific Worker integration was established in this review. |
| Staff MFA | Auth0 documents required MFA policies and Universal Login post-login Actions that can select challenges from contextual information, including roles. Enforcing only application staff still requires a trusted, maintainable way to synchronize staff status to the provider flow. | Pool-level `required` MFA is documented for local users. Cognito explicitly says it does not add MFA to federated sign-ins; the external IdP owns that authentication. A Cognito-only guarantee for staff using Google therefore needs an isolated local staff flow or separately verified IdP step-up. |
| Server sessions, logout, revocation | Auth0 documents refresh-token revocation and its hosted login/logout model. Provider token revocation is not the application's authorization source in this proposal. | Cognito documents refresh-token revocation and global sign-out. It also documents that a revoked self-contained JWT can still pass a local signature/expiry-only check until it expires. |
| Published free tier / cost signal | The pricing page currently lists Free at $0 up to 25,000 MAUs. B2C Essentials starts at $35/month for the published 500-MAU starting tier and lists Pro MFA. The required MFA plan/cost must be confirmed for actual usage and region. | Essentials currently includes 10,000 free direct/social MAUs, then publishes $0.015 per MAU in its example. SMS and email verification/recovery are separately billed through SNS and SES. Plus pricing and legacy-tier eligibility differ. |
| Data location | This review did not verify the current tenant-region list or contractual residency/replication boundaries. Obtain written confirmation for the selected tenant and market. | User pools have regional service endpoints; select a supported AWS Region. This does not by itself prove every dependent service, support process, or external Google identity is confined to that region. Confirm the full data-flow and legal terms. |
| Portability | OIDC issuer/subject identities and a separate application user ID provide a portable boundary. Provider-managed passwords, MFA enrollment, linking, and tenant-specific configuration are not automatically portable. | Same standards-based boundary is possible. AWS-specific pool IDs, Admin APIs, IAM authorization, MFA settings, email/SMS configuration, and federated-link records add migration work. Passwords and MFA seeds are not assumed exportable. |

### Recommendation for review (not a decision)

**Prefer Auth0 as the first candidate for a post-approval proof of concept.**
The documented contextual MFA Actions and explicit account-linking cautions
fit the two staff roles and safe linking requirement better than Cognito's
pool-wide local-user MFA model and its explicit federated-user MFA limitation.
The trade-off is a likely paid B2C plan for the needed MFA feature, an
unverified exact data-residency commitment, and provider-specific Actions and
linking operations.

Amazon Cognito remains a credible alternative if the owner prioritizes AWS
regional control and lower published MAU pricing, and accepts proving a
separate staff MFA path, email/SMS operating costs, and AWS-specific operations.
No provider should be selected until the owner confirms the business market,
privacy/residency needs, traffic estimate, acceptable monthly cost, Google
consent responsibilities, and staff sign-in/MFA experience.

### Worker and session design common to either provider

This is a proposal, not implementation:

1. Use the Worker as the confidential web application in a same-origin OAuth
   authorization-code flow with `state`, `nonce`, PKCE, exact callback URI
   validation, and provider metadata/JWKS validation. The provider performs
   password registration, verification, Google federation, recovery and MFA.
2. Resolve a provider identity by the exact `(issuer, subject)` pair to a
   stable internal `users.id`. Do not key application ownership, staff roles,
   or entitlements by email, provider user ID alone, or client-supplied claims.
3. After successful verification and required MFA, mint a cryptographically
   random opaque application session. Set only its secret in a `Secure`,
   `HttpOnly`, `SameSite=Lax`, path-scoped cookie; store a one-way digest and
   session state in D1. Do not put bearer tokens in localStorage or use a
   provider JWT as the long-lived application session.
4. On every protected request, look up the non-expired, non-revoked D1 session
   and current internal user. Staff handlers also read the current role,
   current certification assignments, and server-recorded MFA assurance.
   Do not cache authorization/assignment decisions across requests. Provider
   token validation establishes identity; it does not establish a role,
   assignment, ownership, or entitlement.
5. Logout and remote sign-out revoke the D1 application session and clear the
   cookie. If provider refresh tokens are retained (not preferred), revoke
   them server-side too. Do not depend on provider logout or JWT expiry for
   application-session revocation.
6. Require CSRF protection and same-origin checks for cookie-authenticated
   mutations; rate-limit login, recovery, linking and staff-sensitive actions.
   Do not log passwords, tokens, recovery codes, question text or answer keys.

Cloudflare documents Web Crypto and Fetch runtime APIs, and both candidates
document OAuth/OIDC interfaces. That establishes a **protocol-level
compatibility rationale**, not proof that either provider's SDK, MFA claim
mapping, callback exchange or API client works in this Worker. Verify with a
small test harness after approval and before choosing an SDK or dependency.

### Account registration, recovery and linking

- Public email registration creates only a learner identity. Require verified
  email before treating it as a contact/recovery address or linking key. Google
  sign-in must validate the provider's verified-email assertion, but that
  assertion alone never merges accounts.
- Link a second identity only from an already authenticated internal account,
  after recent reauthentication of that account and a fresh OAuth transaction
  proving control of the second identity. Bind `state`/`nonce` to the current
  session, prevent replay, and reject identities already attached to another
  internal user. Require explicit user confirmation and audit the link/unlink.
- Same-email discovery may display a recovery/link suggestion, but must not
  auto-link. An inaccessible old account goes through verified recovery or
  support review, not email-only proof.
- Use the provider's verified email/password recovery for local credentials;
  Google credentials are recovered at Google. Invalidate application sessions
  after password reset, account compromise, role removal or explicit
  revocation.
- Keep the minimal provider key, issuer, subject, verified contact metadata and
  link timestamps in `auth_identities`; do not copy social tokens or passwords
  into D1.

### Staff MFA and first Global Admin

For any provider, create a staff application session only after a provider
authentication event that the selected adapter can verify as MFA-complete.
Persist the provider-authenticated MFA time/method in server-owned session
fields; never accept an MFA boolean, `demoRole`, query parameter, or role claim
from the browser as proof. Every staff request checks that the session is
active, has MFA assurance, and satisfies the approved freshness policy. The
exact reauthentication interval and step-up rules for sensitive actions need
architect/owner approval. If the provider cannot produce trustworthy MFA
assurance for a flow, deny staff access through that flow.

The first Global Admin must not be obtainable through public registration or
an ordinary UI. Proposed bootstrap: after a verified, MFA-enrolled identity
exists, an authorized operator runs a one-time, audited provisioning command
through a tightly scoped deployment/data-access credential and approved change
record. The command must transactionally require that no Global Admin exists,
resolve the exact `(issuer, subject)` to one internal user, insert exactly one
`global_admin` role and an audit event, and then disable/remove the bootstrap
capability. No shared bootstrap password, default account, or permanent
bootstrap endpoint. The exact operator approval and credential mechanism must
be reviewed before implementation.

Public registration never writes `staff_roles`. After bootstrap, only a
Global Admin can assign Managers or alter staff roles; each operation requires
MFA, reason, and audit event. Removing a role or assignment is effective on
the next protected request because every request re-reads current D1 scope.

## Server-enforced permission model

Represent only `global_admin` and `manager` in `staff_roles`. The database may
also have no staff-role row; that is an ordinary learner, not a third staff
role. No role is inferred from route, email domain, provider group, cookie
payload, hidden navigation, `demoRole`, or user metadata.

| Operation | Global Admin | Manager |
|---|---|---|
| Create certification roots and manage any exam version/content | All certifications | No certification roots; content/version work only under assigned certifications |
| Read/write modules, domains, topics, questions, explanations, mock/adaptive profiles | All certifications | Assigned certifications only |
| Review, approve/publish/retire content | All certifications | Assigned certifications only; record reviewer and publisher separately; do not require a second person unless separately approved |
| List/detail access to content | All certifications | Query must be scoped by current assignments, including list totals/search/counts; direct IDs and nested IDs must independently prove the same scope |
| Import/export | All certifications | Only assigned certifications; validate every row and requested output scope before reading/writing; never bulk-export other exams |
| Move content between certification scopes | Any; audit both sides | Only if both source and destination certifications are currently assigned; otherwise deny |
| Manage staff, assignments, security, integrations, secrets, settings | Yes | No |
| Prices, orders, payments/refunds, access grants, unrestricted customer data | Yes | No |
| Learner context for content reports | As product/admin policy permits | Only minimal context required for assigned-certification quality investigations |

Implementation boundary proposal:

- Put a shared server-side guard at every admin API entry point, but do not
  treat middleware alone as sufficient. Data queries and mutation predicates
  must include the current certification assignment and ownership constraints.
- For detail/update/delete operations, resolve the resource and verify its
  certification before returning fields or applying side effects. Return a
  consistent not-found/denied response that does not confirm unassigned
  records.
- For moves, check source and destination in the same transaction as the
  update; require scope on both sides. A Manager cannot move content out of an
  assignment they are losing or into an unassigned exam.
- For imports, authorize the requested certification before parsing or storing;
  validate every parsed certification/version/domain/topic reference on
  preview and again at confirmation. Confirmation creates drafts only.
- For exports, scope before selecting fields, aggregation, pagination or
  download generation. No unassigned rows may affect counts or side channels.
- Resolve actor/session, current staff role, assignment and MFA assurance on
  each request. Assignment removal and role removal take effect on subsequent
  requests; do not rely on stale provider tokens or cache.
- Record role, assignment, import/export, content workflow and publication
  changes in append-only audit events with actor, action, certification scope,
  request/correlation ID, timestamp and reason where applicable. Exclude
  credentials, secrets and unnecessary personal data.

## Proposed D1 content model

The names and constraints below are a design proposal only. No migration is
created in Milestone 2A. Use stable internal IDs, foreign keys, explicit
uniqueness constraints, bounded indexed queries, and `ON DELETE RESTRICT` for
history-bearing records. UTC timestamps are application/database instants;
exam-version effective-date presentation follows existing product decisions.

### Identity and assignment records

| Table | Key fields and relationships |
|---|---|
| `users` | Stable internal `id`; account state and timestamps. Do not use email as the primary or authorization key. |
| `auth_identities` | `id`, `user_id -> users`, provider key, exact issuer and subject, verified-email metadata, linked/created timestamps; unique `(issuer, subject)`. No passwords or provider bearer tokens. |
| `staff_roles` | `user_id -> users`, role constrained to exactly `global_admin` or `manager`, actor and timestamps. No row means non-staff. |
| `manager_certification_assignments` | Manager `user_id`, `certification_id`, assigning Global Admin, timestamps/revocation; unique active assignment per manager/certification. Changes are audited. |
| `app_sessions` | Digest of random opaque cookie secret, `user_id`, created/expiry/revocation timestamps, MFA time/method/assurance, authentication time and limited device/session metadata. Never store the raw cookie secret. |

### Versioned editorial records

| Table | Key fields and relationships |
|---|---|
| `certifications` | Stable certification root and unique stable key. Global Admin creates roots. |
| `exam_versions` | `certification_id -> certifications`, version key, syllabus/effective dates, lifecycle metadata; unique `(certification_id, version_key)`. Do not overwrite an older version to represent a new syllabus. |
| `domains` | `exam_version_id -> exam_versions`, stable per-version key, title/order. |
| `topics` | `domain_id -> domains`, stable per-domain key and title/order. |
| `questions` | Stable question identity and `certification_id`; unique stable question key within a certification; lifecycle metadata. Do not store mutable answer content here. |
| `question_revisions` | Immutable revision number, `question_id -> questions`, `exam_version_id`, topic/domain references, stem, item type, difficulty, source/licence provenance, author and creation time. Unique `(question_id, revision_number)`; validate that question, exam version, domain and topic all belong to the same certification/version. |
| `answer_options` | Immutable rows per `question_revision_id`, stable option key/order, option text, correctness flag and explanation. Validate at review/publication that a supported item has the required option count and exactly one correct option. Corrections create a new revision and new option rows. |
| `question_revision_events` | Append-only workflow transitions such as draft, in review, approved, published and retired; actor, time, reason, revision ID. Workflow states are not staff roles. |
| `content_reviews` | Append-only review decisions for an exact revision, reviewer, decision, notes and time. Record reviewer separately from publisher. The current product proposal permits an assigned Manager to publish their own reviewed revision; requiring an independent reviewer is a separate policy decision. |
| `exam_version_questions` | Current published revision pointer for a question in an exam version, with publication actor/time. Unique `(exam_version_id, question_id)`; pointer updates only through an authorized publish/retire transaction. |
| `content_publication_events` | Immutable publish, supersede, unpublish and retire events; exam version, exact revision, actor/time/reason and optional superseded event. Provides history while `exam_version_questions` supports bounded current-content queries. |
| `content_imports` | Import ID, actor, requested certification/version, digest, state, created/confirmed timestamps and outcome counts. Raw files should be bounded and transient; a durable object store is a separate approval. |
| `content_import_rows` | Import ID, row number, sanitized preview fields, validation errors and draft outcome IDs. Never publish as a side effect of upload or preview. |
| `audit_events` | Append-only actor/action, subject type/ID, certification scope, timestamp, request ID, reason and scrubbed metadata. Use for identity-role, assignment, import/export, workflow and publication changes. |

Existing later product records (including `attempts` and `attempt_items`) must
refer to the exact `question_revision_id` they presented. Add a restrictive
foreign key from each attempt item to its immutable revision; preserve option
order and the applicable exam/profile version in the attempt snapshot. A
correction changes the current publication pointer to a new reviewed revision;
it never edits or deletes a revision referenced by a published exam or
completed attempt. Retirement removes a revision from future selection without
destroying history or rewriting results. Whether explanations remain readable
after Standard expiry is still the separate open product decision.

### Integrity and concurrent editing

- Treat a revision and all its answer options/explanations as append-only after
  creation. Enforce this in the data-access layer and, where supported by the
  selected D1 migration design, with restrictive foreign keys/triggers that
  reject updates/deletes. No cascade may erase a published or attempt-referenced
  revision.
- Editing creates a new revision based on the displayed revision. Update the
  stable question's edit/version pointer with an expected `lock_version` (or
  expected current revision) predicate. If the predicate no longer matches,
  return a conflict and ask the editor to reload/rebase; never silently
  overwrite another editor's revision.
- Validate the whole proposed revision before entering review. Validate
  certification/version/topic consistency, answer option count, exactly one
  correct choice where applicable, required explanations, allowed difficulty,
  references/licence provenance, and status transition.
- Publish in one D1 transaction/batch: recheck actor role, current assignment,
  expected version, review state and references; append publication/audit
  events; update only the current publication pointer. If any check fails,
  publish nothing.
- Import preview is inert and reproducible from a file digest. Confirmation
  revalidates the preview, scope, duplicates and schema, then creates draft
  questions/revisions with audit history. It never directly publishes, silently
  reassigns, or bypasses review. Escape CSV formula cells in exported previews;
  treat all uploaded fields as untrusted.
- Use revision IDs, not copied mutable question content, for attempt integrity.
  Published revisions remain queryable for historical attempts even after
  supersession, retirement, or a later exam version.

## Application and prototype boundaries

- Keep the accepted Worker/Hono/D1 architecture. Public pages remain useful
  SSR HTML; private responses remain `noindex` and `private, no-store`.
- Replace prototype content behind real authenticated routes/API handlers, or
  isolate synthetic demonstration routes at build/runtime boundaries. Do not
  gradually treat demo fixtures as production records.
- `demoRole` and every other query parameter are presentation-only. Real
  guards ignore them and derive identity, role, assignment and MFA assurance
  only from server-verified session state and current D1 records.
- Synthetic sample questions, answer keys, fixtures and demo storage stay in
  prototype-only modules. The production content API reads protected D1
  revision records only after identity, certification assignment/entitlement,
  and attempt-state checks. Never import fixture answer keys into a protected
  content module or publish them as production content.
- UI navigation may hide unavailable actions for clarity, but every data
  request must independently authorize on the Worker. Neither `noindex`,
  route loaders alone, nor client-side role state is security enforcement.

## Remaining Milestone 2 work: reviewable sequence

These are proposed implementation slices after this design is reviewed. Each
slice should be a separate feature branch/PR or a clearly bounded PR section;
do not begin them in Milestone 2A.

1. **Approve identity provider and operational constraints.** Confirm market,
   tenant/pool region, residency terms, forecast MAUs and email/SMS costs,
   allowed factors, staff MFA experience, session duration/re-authentication
   policy, and account-link/recovery policy. Prove the provider's Worker
   callback/JWKS/MFA-assurance behavior without introducing production data.
2. **Identity/session foundation.** Add only the approved provider adapter,
   registration/email verification/Google/recovery/link flows, opaque
   HttpOnly D1 sessions, logout/revocation, CSRF protections, rate limits and
   identity-provider configuration. Do not add staff roles in public signup.
3. **Internal identity and secure bootstrap.** Add users, auth identities,
   app sessions, roles, assignments and audit migrations; implement the
   one-time first-Global-Admin procedure and then disable it. Review the
   bootstrap operation separately before production use.
4. **Authorization service and admin APIs.** Implement default-deny session,
   MFA, role, assignment and ownership checks on list/detail/mutation routes.
   Cover import/export and content reassignment before exposing any admin UI.
5. **Content schema and revisions.** Add certification/version/domain/topic,
   stable question, immutable revision/options, review/workflow and publication
   history tables. Add migration constraints and revision-aware data access.
6. **Admin content workflow.** Replace only the content-management prototype
   with guarded server-backed CRUD, review, publish, correction and retirement
   interactions. Preserve synthetic role controls only as isolated development
   previews, never as authorization.
7. **Import preview and audit.** Implement bounded parsing, scoped preview,
   validation, idempotent confirmation into drafts, explicit outcome report,
   exports and audit records. No import may publish directly.
8. **Security acceptance and handoff.** Run the tests below, negative direct-ID
   probes, data-leak checks and review of indexes/migrations. Update the
   architecture decision only after provider selection is approved.

## Required tests before Milestone 2 is complete

- **Ownership:** one learner cannot read or mutate another learner's session,
  attempt, answer, bookmark, note or access record by changing an ID; responses
  do not disclose the existence of another user's record.
- **Assigned-exam isolation:** Manager A can list/detail/mutate only assigned
  certification content. Test collection queries, counts, pagination, search,
  direct IDs, nested IDs, profile operations, import/export and both sides of
  reassignment. Removing the assignment blocks the next request. Global Admin
  has the approved cross-certification scope.
- **MFA:** each staff role is denied without server-verified MFA, with
  unsupported or missing assurance, or after the approved freshness window.
  Learner session state cannot satisfy staff MFA. Test step-up, recovery and
  role changes without using browser-supplied claims.
- **Account linking:** same verified or unverified email never auto-merges;
  both identities must be freshly proven by the same signed-in user; bad
  `state`/`nonce`, replay, canceled linking, existing cross-user subject, and
  provider errors do not link. Audit successful link/unlink and preserve the
  internal user ID.
- **Session revocation/logout:** logout and remote revocation invalidate the
  app session on the next request even if a provider JWT remains cryptographically
  valid. Expired, revoked, malformed and rotated cookies fail closed.
- **Registration/bootstrap:** anonymous/public registration cannot create
  `staff_roles`; concurrent or repeated bootstrap attempts cannot create a
  second Global Admin; wrong/unverified identity or missing MFA aborts without
  partial role/audit state.
- **Imports/exports:** malformed, duplicate, oversized and cross-certification
  rows fail safely; preview has no write/publication side effect; confirmation
  is idempotent, revalidates assignment and creates drafts only; exports and
  aggregate counts exclude unassigned data.
- **Revision integrity:** published revision/options cannot be updated/deleted;
  correction creates a new revision; invalid revision cannot publish; stale
  concurrent edit returns conflict; concurrent publish cannot replace a newer
  pointer silently; attempts remain bound to the exact old revision after
  correction/retirement.
- **Demo isolation:** `demoRole=manager` and other forged query values never
  affect server identity/authorization; prototype fixtures and their correct
  answers are absent from production protected-content responses.

## Official documentation reviewed

All sources below are provider/platform documentation, checked 10 November
2026. Pricing pages are snapshots, not quotes. Statements above are limited to
what these pages establish; unresolved compatibility and legal claims remain
explicitly pending.

### Auth0

- [Auth0 pricing](https://auth0.com/pricing) - B2C/free MAU limits and plan
  feature/pricing indications.
- [Enable MFA](https://auth0.com/docs/secure/multi-factor-authentication/enable-mfa)
  - factors and tenant MFA policies.
- [Customize MFA with Universal Login Actions](https://auth0.com/docs/secure/multi-factor-authentication/customize-mfa/customize-mfa-selection-universal-login)
  - contextual post-login challenges.
- [Verify emails](https://auth0.com/docs/manage-users/user-accounts/verify-emails)
  - email links and OTP verification.
- [Change users' passwords](https://auth0.com/docs/authenticate/database-connections/password-change)
  - email recovery flow and session expiry after password reset.
- [Add Google login](https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/google)
  - Google social connection.
- [User account linking](https://auth0.com/docs/manage-users/user-accounts/user-account-linking)
  - explicit linking behavior, safeguards and plan caveat.
- [Authorization Code Flow with PKCE](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow-with-pkce)
  - standards-based browser authorization flow.
- [Revoke refresh tokens](https://auth0.com/docs/secure/tokens/refresh-tokens/revoke-refresh-tokens)
  - provider token revocation behavior and limitations.

### Amazon Cognito

- [Amazon Cognito pricing](https://aws.amazon.com/cognito/pricing/)
  - current user-pool tiers, MAU prices and separately billed SNS/SES messages.
- [Adding MFA to a user pool](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa.html)
  - required MFA and the federated-user limitation.
- [Signing up and confirming user accounts](https://docs.aws.amazon.com/cognito/latest/developerguide/signing-up-users-in-your-app.html)
  - local signup and confirmation.
- [Passwords, account recovery, and password policies](https://docs.aws.amazon.com/cognito/latest/developerguide/managing-users-passwords.html)
  - verified-channel self-service recovery and MFA interaction.
- [User pool sign-in with third-party identity providers](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-identity-federation.html)
  - social, OIDC and SAML federation.
- [Configuring identity providers](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-identity-provider.html)
  - Google/social provider setup.
- [AdminLinkProviderForUser API](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminLinkProviderForUser.html)
  - trusted, IAM-authorized administrative identity linking.
- [Ending user sessions with token revocation](https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html)
  - revocation and local JWT-verification caveat.
- [Cognito endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/cognito.html)
  - regional User Pools endpoints.

### Cloudflare

- [Workers Web Crypto API](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
  - cryptographic APIs available in Workers.
- [Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
  - outbound HTTPS requests from Worker handlers.
