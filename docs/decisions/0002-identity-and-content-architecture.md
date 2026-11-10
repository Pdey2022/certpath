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

Three candidates were reviewed against current official documentation:
Auth0 Customer Identity (B2C), Amazon Cognito User Pools, and Firebase
Authentication with Identity Platform. All can provide managed sign-in, but
their documented MFA and event/session capabilities differ. Pricing below is
a point-in-time comparison, not a quote. A free-tier limit is not assumed to
include a production MFA capability unless documented.

| Concern | Auth0 Customer Identity (B2C) | Amazon Cognito User Pools | Firebase Authentication / Identity Platform |
|---|---|---|---|
| Email registration and verification | Database connections with verification links and OTP options; verification can be required by the app flow. | Local signup and account confirmation with verification messages. | Email/password authentication and email verification are documented. |
| Recovery | Universal Login/email reset flow for database users; social users recover at their social provider. Password reset expires the Auth0 session. | Self-service recovery code to a verified address/phone. MFA and recovery destinations must be coordinated; the same channel cannot deliver both MFA and reset codes. | Password reset email is supported; Google users recover at Google. Firebase documents automatic revocation of Firebase refresh tokens after password reset, but this alone does not revoke CertPath D1 sessions. |
| Google sign-in | Google social connection through OAuth 2.0; requires Google OAuth credentials and Auth0 configuration. | Google social federation through managed login; requires Google credentials and attribute/scope mapping. | Google provider is supported through the Firebase web SDK or a manual Google OAuth flow. |
| Safe account linking | Explicit linking supported. Auth0 advises authenticating both accounts and prompting for credentials for every manual link; availability varies by plan. | `AdminLinkProviderForUser` links a trusted external identity to a pool user and requires IAM authorization; it is not an email-match rule. | SDK linking attaches a second credential after sign-in; credentials already linked elsewhere fail. The docs describe app-specific account merging separately. A documented SDK issue affects `linkWithCredentials` in some projects; compatibility and safe linking need a proof before use. |
| Worker compatibility | OAuth/OIDC authorization-code flow and HTTPS endpoints are protocol-compatible in principle; this review did not establish Auth0 SDK compatibility with Workers. | OAuth/OIDC endpoints and JWTs are protocol-compatible in principle; this review did not establish Cognito SDK compatibility with Workers. | Browser SDK can perform sign-in, but the Worker must verify tokens server-side. Web Crypto/fetch make standards-based JWT verification plausible; Firebase Admin SDK compatibility with Workers and TOTP assurance claim mapping were not established here. Do not put authorization in browser SDK state. |
| Staff MFA | Required MFA policy and Universal Login post-login Actions can choose contextual challenges. Pro MFA is listed on the B2C Essentials plan; verify availability and pricing for the selected tenant. | Required pool MFA is documented for local users. Cognito explicitly does not add MFA to federated sign-ins, so Google staff require an independently enforced and verified MFA step or a different staff flow. | TOTP MFA is documented only after upgrading to Firebase Authentication with Identity Platform. It is a production capability, not a temporary trial feature, but requires the Identity Platform billing/configuration tier. Worker-verifiable staff assurance still needs proof. Base Spark Firebase Auth without Identity Platform TOTP is not acceptable for staff MFA. |
| Server sessions, logout, revocation | Refresh-token revocation is documented. Application D1 session revocation remains CertPath's responsibility. | Refresh-token revocation/global sign-out are documented; a revoked self-contained JWT can still pass local signature/expiry-only verification. | ID tokens last about one hour; refresh tokens can be revoked, and password reset or disabled/deleted user revokes provider refresh tokens. Firebase says server verification must explicitly check revocation. None of these automatically revoke an independent D1 session. |
| Lifecycle-event delivery | Complete, replayable events for every password reset, account suspension and compromise change, with a bounded delivery time, were not established by the sources reviewed; verify provider log-stream coverage/retry/replay before selection. | Complete lifecycle event coverage, ordering/replay and bounded delivery for the required user changes were not established by the sources reviewed; verify an event source and recovery path before selection. | Complete lifecycle event coverage, ordering/replay and bounded delivery for the required user changes were not established by the sources reviewed; verify an event source and recovery path before selection. |
| Published free tier / cost signal | Free currently lists up to 25,000 MAUs. B2C Essentials starts at $35/month at the published 500-MAU starting tier and lists Pro MFA. Confirm actual required plan/limits before any selection. | Essentials currently lists 10,000 free direct/social MAUs, then $0.015/MAU in its example; SMS and email delivery are additional SNS/SES costs. Plus pricing and legacy eligibility differ. | Firebase pricing currently lists up to 50,000 tier-1 MAUs without charge. The TOTP feature requires Identity Platform; its pricing page currently includes a 50,000-MAU no-cost tier for tier-1 methods, then publishes per-MAU charges. SMS is separately priced. The no-cost allowance is a production price tier, not a time-limited trial; temporary Google Cloud credits are excluded from this comparison. |
| Data location | Exact tenant-region and contractual residency/replication commitments were not verified. Obtain written confirmation for market and tenant. | User Pools have regional endpoints. A region choice does not prove all support, dependent delivery services or Google processing stay in-region. | Identity Platform project location/residency and identity-data processing boundaries were not verified in this review. Confirm the selected project location, contract and Google processing terms. |
| Portability | OIDC `(issuer, subject)` plus internal IDs is portable; passwords, MFA enrollment, linking and tenant configuration are not automatically portable. | Same OIDC boundary is possible; pool IDs, IAM APIs, MFA, delivery and federated links add migration work. Passwords/MFA seeds are not assumed exportable. | Firebase UID can be mapped to an internal ID, but Firebase token claims, provider configuration, MFA enrollment and Google-specific APIs add migration work. Passwords/MFA seeds are not assumed exportable. |

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
Firebase Authentication with Identity Platform is an additional lower-cost
candidate for evaluation: the documented tier-1 MAU free allowance is larger,
and TOTP MFA is available in production after the Identity Platform upgrade.
However, its Worker server-side assurance path, reliable revocation event
coverage, provider linking behavior and residency commitments are not yet
proven. Its base Spark-only configuration without Identity Platform TOTP
cannot satisfy the staff-MFA requirement and is not an acceptable substitute.
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

Cloudflare documents Web Crypto and Fetch runtime APIs, and all three candidates
document OAuth/OIDC interfaces or token formats. That establishes a **protocol-level
compatibility rationale**, not proof that any provider's SDK, MFA claim
mapping, callback exchange or API client works in this Worker. Verify with a
small test harness after approval and before choosing an SDK or dependency.

### D1 security consistency and atomic writes

Cloudflare documents that D1 read replicas replicate asynchronously and may be
arbitrarily stale. The D1 Sessions API supports
`env.DB.withSession("first-primary")`, which begins on the primary; its
subsequent queries are sequentially consistent. Proposed security rule:

- Every protected request uses primary-routed D1 reads for app-session
  validity, user security state, current staff role, current Manager
  assignments, and content ownership. Do not use `first-unconstrained`, a
  replica-routed read, a user-supplied bookmark, a cache, or a stale UI claim
  for authorization.
- Keep authorization predicates inside the write SQL too; a primary read
  followed by a separate unconditional write is not an atomic authorization
  check. Bind all values and include expected version/state predicates.
- On D1 error or inability to establish the required consistency, protected
  routes fail closed. Do not fall back to a replica or provider claim.

D1 is auto-commit; this design does **not** assume an interactive transaction
held across Worker round trips or support for arbitrary transaction-control
SQL. Cloudflare documents `D1Database.batch()` as sequential, non-concurrent
SQL transaction execution: statements commit together, and a statement error
aborts/rolls back the sequence. Use prepared statements, schema constraints,
conditional DML and one `batch()` for related database-only work. The exact
`D1Result.meta.changes`/`RETURNING` behavior must be validated in local
emulator and remote non-production tests before relying on it.

Concrete conditional-write patterns:

- **First Global Admin:** enforce a unique partial index permitting only one
  `global_admin`. In one batch, insert the role using `INSERT ... SELECT ...
  WHERE NOT EXISTS (SELECT 1 FROM staff_roles WHERE role='global_admin')`,
  bound to the exact preverified internal user and one-time provisioning
  operation ID. Insert the consumed provisioning record and audit event only
  through statements guarded by that operation/role row. Check returned
  changes; any unexpected row count is a failed provisioning result. A unique
  constraint resolves concurrent bootstrap attempts; no read-then-insert
  decision is trusted by itself.
- **Assignment-sensitive mutation:** make the actual `UPDATE`/`INSERT` predicate
  require the target certification assignment (and source assignment for a
  move), actor/session state, and expected `lock_version`/revision. In the
  same batch, persist history/audit rows tied to a unique operation ID and
  condition them on the target row carrying that operation ID. Check each
  result; zero affected target rows means denied/conflict and no successful
  response. Where the database-only audit/history insertion cannot be
  conditioned safely in the same batch, use an SQLite trigger attached to the
  guarded row write or redesign as one statement; never emit success or
  unaudited mutation.
- **Publication:** a single batch rechecks publishable revision, review state,
  active role/assignment, version ownership and expected current pointer in
  the SQL predicates; inserts immutable publication/audit events; and
  compare-and-swaps `exam_version_questions` only when the old pointer/version
  matches. Use unique operation/event keys and foreign-key constraints.
  Unexpected zero changes or stale pointer is a conflict; SQL errors roll back
  the batch. Do not split publication into independent requests.
- **Concurrent editing:** create the next revision and advance the stable
  question's `lock_version` with a conditional update in one batch. Only one
  writer can match the expected version; a competing writer gets a conflict
  and must reload/rebase.

Cloudflare's documented batch atomicity applies to database statements in
that call, not external provider HTTP requests. Do not put a provider call and
D1 work inside a fictitious cross-system transaction. For identity lifecycle
operations, use an explicit pending/fail-closed state and an idempotent
reconciliation protocol described below.

### Provider changes and D1 session invalidation

Provider session expiry, refresh-token revocation and JWT expiry do not by
themselves revoke the independent CertPath D1 session. The required behavior
is:

1. **CertPath-initiated password reset, suspension or compromise response:**
   in a D1 batch, mark the internal account pending/blocked and revoke every
   active D1 session before asking the provider to reset/disable/revoke. Keep
   access blocked if the provider call times out or returns an ambiguous
   result. Retry the provider operation idempotently; restore access only
   after trusted reconciliation proves the operation was not applied and an
   authorized operator/user completes recovery. Password reset keeps the
   account otherwise active after verified completion; suspension/compromise
   remains blocked until an explicit audited reactivation.
2. **Provider-originated password reset/change, disable/suspension or
   compromise event:** require the selected provider to produce authenticated,
   replayable lifecycle events for these conditions. Verify the provider
   signature/issuer, event timestamp and audience; map the exact provider
   `(issuer, subject)` to the internal user; then use one D1 batch to insert an
   event-ledger row with unique `(provider_key, provider_event_id)`, update
   account security state as appropriate, revoke all D1 sessions, and append
   the audit event. Acknowledge the delivery only after the D1 commit.
   Duplicate event IDs are no-ops; transient D1 failures return a retryable
   non-success response and are alerted. Keep unprocessed events durable and
   replay/reconcile them before reopening access.
3. **Delivery target and outage mode:** target event-to-D1 revocation within
   60 seconds during healthy provider/event/D1 operation. Enforce this with a
   feed watermark/cursor and an independent freshness monitor, not an
   assumption that a webhook is instantaneous. If the event feed is behind,
   cannot prove cursor continuity, or D1 is unavailable, fail closed for
   protected authenticated routes; do not renew/create app sessions. Keep that
   gate closed after recovery until the provider event history has been
   reconciled through a known cursor and D1 has applied all revocations.
   Alert, retry with bounded exponential backoff, deduplicate by provider
   event ID, and expose an operator recovery procedure. No stale event may
   restore access. A provider without a documented and demonstrated durable
   event/replay or equivalent status-check mechanism does not meet this
   architecture requirement.

The 60-second target is an application SLO to validate, not a provider SLA.
The vendor docs reviewed so far establish password/session APIs for some
candidates, but do not establish complete event coverage, ordering, replay,
delivery retry guarantees, or a 60-second bound for all password resets,
suspensions and compromise signals. These are selection/proof-of-concept
gates. Until verified for a chosen provider, do not claim remote password
resets or out-of-band suspension invalidate D1 sessions within a bounded
period. Provider outage, missing event, invalid signature, unmapped identity,
or inconsistent D1 results must never silently leave staff or learner
sessions authorized.

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
| `domains` | `exam_version_id -> exam_versions`, stable per-version identity, key, title/order and documented meaning. Once referenced by a published revision, identity and meaning are immutable. |
| `topics` | `domain_id -> domains`, stable per-domain identity, key, title/order and documented meaning. Once referenced by a published revision, identity and meaning are immutable. |
| `questions` | Stable question identity and immutable `certification_id`; unique stable question key within a certification; lifecycle metadata. Do not store mutable answer content here. Never transfer an identity with historical revisions to another certification. |
| `question_revisions` | Immutable revision number, `question_id -> questions`, `exam_version_id`, fixed domain/topic identity references, stem, item type, difficulty, source/licence provenance, author and creation time. Unique `(question_id, revision_number)`; validate that question, exam version, domain and topic all belong to the same certification/version. A published revision continues to reference the same domain/topic identities and meanings for its full lifetime. |
| `question_derivations` | Optional provenance edge from a newly created question/revision to a source question/revision, reason, actor and timestamp. Used when copying content to a distinct certification; does not move or rewrite the source record. |
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

Certification ownership of a stable `questions` identity is immutable. If
content needs to appear under another certification, create a **new question
identity** and new revision(s), retain the source question and all its history,
and optionally record provenance in `question_derivations`. The actor must
currently be authorized in both source and destination certification scopes;
an export/import copy workflow must revalidate both scopes and licensing. A
published revision's `exam_version_id`, domain ID, topic ID, and the domain/topic
meanings those IDs denote are immutable. Reclassification or a meaningful
domain/topic change requires a new revision in a new valid target identity;
do not rename/repoint a published domain/topic in place to change the meaning
of historical content.

### Integrity and concurrent editing

- Treat a revision and all its answer options/explanations as append-only after
  creation. Enforce this in the data-access layer and, where supported by the
  selected D1 migration design, with restrictive foreign keys/triggers that
  reject updates/deletes. No cascade may erase a published or attempt-referenced
  revision.
- Treat the question's certification root and every published revision's exam,
  domain and topic identity/meaning as fixed. For cross-certification reuse,
  copy into a new question identity with provenance; require authorization for
  both source and destination and preserve all source history.
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

These are proposed implementation slices after design review. Keep the
provider compatibility proof, local schema/permissions work and any real
production bootstrap as separate, reviewable tasks. No item starts in Milestone
2A.

1. **Approve a provider candidate and operating constraints.** Confirm market,
   region/residency, MAU forecast, full email/SMS/MFA costs, allowed factors,
   staff MFA assurance, session/re-authentication policy, provider event
   coverage and account-link/recovery policy. No provider is selected by this
   proposal.
2. **Isolated provider compatibility proof.** Only after provider approval,
   test OAuth callback/state/nonce/PKCE, Worker token/JWKS validation, Google,
   email verification/recovery, production staff MFA assurance, lifecycle
   event delivery/replay and account linking in a non-production harness. Keep
   this separate from production accounts, D1 schema, business records and
   deployment. Do not proceed if the 60-second revocation target cannot be
   demonstrated or safely failed closed.
3. **Local identity/session schema first.** Add reviewed D1 migrations for
   internal users, auth identity keys, account security state, opaque app
   sessions, provider event ledger/feed watermark, and audit records. Add
   constraints and primary-read repositories. No route or permission code may
   depend on a schema that has not been migrated and tested locally.
4. **Local roles, assignments and permission service.** Add exactly the two
   staff roles and certification assignments; implement default-deny guards
   and assignment-scoped reads/writes against local test identities. Test
   primary consistency and D1 conditional batches before wiring a provider.
   Never treat demo fixtures/query parameters as identities.
5. **Local content/revision schema.** Add certification/version/domain/topic,
   stable questions, immutable revisions/options, review/publication history,
   imports and audit constraints. Test version/certification integrity,
   cross-scope copy provenance, atomic publication and concurrent edits.
6. **Provider-backed identity/session routes.** After the isolated proof and
   schema are approved, implement registration, verification, Google, recovery,
   explicit identity linking, opaque D1 session creation/logout, CSRF/rate
   limiting, and authenticated lifecycle-event intake/reconciliation. Add no
   public staff-role assignment.
7. **Admin content workflow and imports.** Replace only content-management
   preview paths with guarded server-backed CRUD, review, publish, correction,
   retirement, import preview, draft-only confirmation and scoped exports.
   Keep unrelated synthetic practice/question fixtures isolated.
8. **Production bootstrap as a separate gated operation.** Implement and test
   a one-shot provisioning tool in a non-production environment first. Do not
   execute it in production from this milestone/PR. Production execution needs
   a separate explicit approval, identified operator, verified MFA identity,
   narrowly scoped credential, change record, runbook, dry-run evidence and
   post-run audit verification.
9. **Security acceptance and handoff.** Run the applicable tests below, direct
   ID probes, data-leak checks and migration/index review. Keep ADR 0002
   proposed until the architect/owner accepts provider and design decisions.

## Required tests before Milestone 2 is complete

- **Identity/session ownership (Milestone 2 scope):** one internal user cannot
  read, revoke or mutate another user's account/session records by changing an
  ID; responses do not disclose the existence of another user's identity or
  session.
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
- **Provider lifecycle invalidation:** password reset, account disable/
  suspension and compromise events are authenticated, mapped to the correct
  internal user, idempotently applied, audited and retried. Healthy operation
  meets the 60-second target; event-feed staleness/provider outage/D1 outage
  closes protected routes until replay/reconciliation completes. Provider
  session expiry alone must not pass this test.
- **Registration/bootstrap:** anonymous/public registration cannot create
  `staff_roles`; concurrent or repeated bootstrap attempts cannot create a
  second Global Admin; wrong/unverified identity or missing MFA aborts without
  partial role/audit state.
- **Imports/exports:** malformed, duplicate, oversized and cross-certification
  rows fail safely; preview has no write/publication side effect; confirmation
  is idempotent, revalidates assignment and creates drafts only; exports and
  aggregate counts exclude unassigned data.
- **Revision integrity:** published revision/options and their domain/topic
  IDs and meanings cannot be updated/deleted/repointed; correction creates a
  new revision; invalid revision cannot publish; stale concurrent edit returns
  conflict; concurrent publish cannot replace a newer pointer silently;
  cross-certification copy creates a distinct identity and requires both
  scopes while preserving source history.
- **Deferred Milestone 3 ownership/history tests:** attempts, presented
  question snapshots, answers, bookmarks, notes, learner access records and
  attempt-to-revision retention are not Milestone 2 test requirements because
  those learner persistence APIs are not implemented here. Carry their
  cross-user ownership and immutable-attempt-snapshot tests forward to the
  milestone that implements those records and routes.
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

### Firebase Authentication with Identity Platform

- [Firebase pricing](https://firebase.google.com/pricing) - Spark/Blaze plan
  distinctions, current tier-1 MAU free allowance, and separately billed
  phone authentication.
- [Identity Platform pricing](https://cloud.google.com/identity-platform/pricing)
  - current MAU and SMS/MFA charges.
- [TOTP MFA](https://firebase.google.com/docs/auth/web/totp-mfa) - TOTP
  availability only after upgrading to Firebase Authentication with Identity
  Platform and the documented web enrollment/sign-in flow.
- [Google sign-in](https://firebase.google.com/docs/auth/web/google-signin)
  - Firebase web provider sign-in.
- [Account linking](https://firebase.google.com/docs/auth/web/account-linking)
  - provider linking flow, collision handling, and documented SDK issue.
- [Manage sessions](https://firebase.google.com/docs/auth/admin/manage-sessions)
  - refresh-token revocation and server-side revoked-ID-token checking.
- [Manage users](https://firebase.google.com/docs/auth/admin/manage-users)
  - server-side user lookup and account management capabilities.
- [Verify ID tokens](https://firebase.google.com/docs/auth/admin/verify-id-tokens)
  - server verification and the distinction between ordinary token validation
  and revocation checking.

### Cloudflare

- [Workers Web Crypto API](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
  - cryptographic APIs available in Workers.
- [Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
  - outbound HTTPS requests from Worker handlers.
- [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
  - prepared statements, `batch()` transaction/rollback behavior, and
  `withSession("first-primary")`.
- [D1 global read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
  - replica lag and session sequential-consistency guarantees.
