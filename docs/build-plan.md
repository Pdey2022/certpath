# GitHub and Copilot build plan v0.2

Read product-design.md as the product baseline. Proposed decisions remain proposals until accepted. Each milestone has its own branch and pull request. Do not implement the entire application in a single agent prompt.

Sequencing for everything after Milestone 3 - phase order, dependencies, exit criteria and GitHub issue tracking - lives in [delivery-plan.md](delivery-plan.md). Product rules settled since this plan was written are recorded in `docs/decisions/` and summarised in [open-decisions.md](open-decisions.md).

## Cross-cutting requirements

Read product-design.md v0.2 before every milestone. Include: SEO-ready public HTML; consent-aware acquisition/product tracking; reliable save/resume; mobile/tablet/desktop layouts; exactly two staff roles (Global Admin and exam-scoped Manager). Resolve the Cloudflare-compatible public SSR/prerender strategy before scaffolding; there is no Vite-only public shell assumption. The previous interactive demo is a synthetic design reference, not production code or a functional backend.

Use a private GitHub repository, feature branches, reviewable pull requests and protected main where supported. Keep product rules in the repository. Add docs/seo.md, docs/analytics-events.md, docs/permissions.md and docs/save-resume.md. Capture provider/framework decisions and verify current compatibility during implementation. Optional enhancements need explicit scope approval; do not bundle them into foundational work.

## Milestone 0 — repository foundation

Private GitHub repository. Maintain the existing docs/product-design.md and docs/build-plan.md; create docs/decisions/ for architecture decisions and docs/open-decisions.md. Add README, .gitignore, .env.example containing names only, root AGENTS.md and .github/copilot-instructions.md with consistent concise project rules. Add pull request and issue templates. Do not commit credentials, customer data or real paid question banks.

Scaffold the proposed TypeScript web/API workspace, a shared contract package, SQL migrations, local Worker/D1 development and a CI workflow. Make one documented command run local development and one run verification. Pin dependencies with a lockfile. Confirm selected package and runtime versions during setup rather than copying stale version numbers. No production deployment or payment setup in this milestone.

Acceptance: fresh checkout installs and runs; CI checks build and types; API health route returns a non-sensitive response; responsive learner/admin shells work at mobile, tablet and desktop widths; sample public HTML is meaningful without JavaScript; metadata, canonical and indexing checks exist; event schemas are documented without fake analytics; production secrets absent.

## Milestone 1 — local product prototype

Use explicitly labelled synthetic fixtures. Create design tokens, public catalogue, learner shell, home, exam workspace, practice/explanation/results, access management, and an admin question editor. Include Global Admin and assigned-exam Manager navigation previews, without treating fixture roles as authorisation. Demonstrate separate CISSP and CISM access plus Standard and Pro states. Implement loading, empty, error and expired states. Prototype controls may simulate behaviour only when visibly labelled; never claim payment or secure login works.

Acceptance: a complete mobile practice journey and admin editing preview; no horizontal overflow at 320px; keyboard focus and text resizing work. Show autosave, explicit Save & exit, save failure, resume and session conflict states. Mock exams include leave/timer consequences. Verify desktop layout as well as mobile; label simulated storage clearly.

## Milestone 2 — content and identity

Keep identity/provider compatibility, local security foundations, production identity routes, and content management as separate reviewable slices. No provider, production authentication, or production bootstrap operation is implied by local foundations.

### Milestone 2B — provider-independent local security foundations

Create D1 identity/session and audit migrations first, followed by server-only default-deny session, role, assignment, and mutation services. Use isolated synthetic identities and explicit test MFA policies in the actual local Worker/D1 runtime. Test primary-consistent reads, conditional writes, audit atomicity, one-time initial provisioning, later Global Admin appointments, and last-active-admin protection. Keep test factories out of runtime imports. Do not expose login, bootstrap, role-changing, or test-session HTTP endpoints. Do not add provider-specific event infrastructure, content revision/import tables, or production provisioning operations.

### Milestone 2C — versioned content and publication safeguards

Add D1 exam-version taxonomy, stable question identities, immutable single-choice revisions/options, editorial events/reviews, publication pointers/history, and cross-certification copy provenance. Keep domain/topic identities and meanings immutable; meaningful taxonomy changes create new identities. Corrections within a certification create a new revision of the same question. Cross-certification reuse creates a new question identity, checks authorization in both scopes, and preserves source provenance. Use conditional, audited D1 writes with current session/MFA/role/assignment predicates. Test on the isolated Worker/D1 runtime, including repeat migrations, invalid scope references, stale edits/publication pointers, concurrent publication, failure atomicity, access revocation, and historical integrity. Keep the services internal; do not connect the admin UI or add content HTTP endpoints.

### Milestone 2D — internal question-bank imports and exports

Add a versioned, strict CSV contract for single-choice questions. Parse UTF-8 CSV with a standards-compliant parser, enforce byte/record/row/field limits, and validate every row with the same question rules and certification/version/domain/topic checks used by manual authoring. Preview is inert with respect to content: it may retain only validated canonical rows in short-lived D1 staging, bound to the exact format, scope, actor and expiry. Confirmation rechecks current session/MFA/role/assignment and taxonomy, then atomically creates new sealed drafts only; it cannot overwrite an existing question or publish. Retried/concurrent confirmations have one durable outcome. Export is staff-only, scoped before selection, limited to current published revisions, paginated, and spreadsheet-formula-safe. Keep all import/export services internal with no endpoints or UI. Test actual Worker/D1 transaction, triggers, constraints, retries, revocation and cleanup. See the [question-bank import/export contract](question-bank-import-export.md).

### Milestone 2E — protected content HTTP boundary

Expose only the existing versioned-content, review/publication, import and scoped-export services through same-origin `/api/admin/content` routes. Resolve the actor solely from a hashed opaque application-session cookie; use server time, explicit MFA configuration, current D1 role/assignment checks, exact-origin validation and a session-bound CSRF token. Enforce streaming request limits and strict shared schemas, including path-to-resource consistency. Keep responses private/no-store and noindex, sanitize errors, and add actual Hono/Worker/D1 integration tests. Document the future cookie issuance contract without implementing a provider, login/session issuance, or admin UI. Keep the synthetic prototype isolated; no copy or collection/search routes in this slice. See the [protected content API contract](protected-content-api.md).

### Milestone 2F — protected admin question editor

Keep the `/admin/*` synthetic prototype and its presentation-only role selector explicitly isolated. Add a separate `/admin/question-editor` route that server-renders only a neutral shell, then uses the existing same-origin session cookie and protected content API from the browser. Add only scoped, bounded certification/version/domain/topic/question/revision reads; each read must enforce current staff session, MFA and certification assignment in primary D1 queries. Connect draft creation, exact revision reads and corrections using the existing request schemas and CSRF endpoint. A correction creates a new sealed revision. Preserve edited field values on validation/network failures and on 409; let staff inspect the latest revision and explicitly choose it as the retry base. Do not add review/publication, import/export UI, provider sign-in/session issuance or deployment. Test Worker/D1 behavior with isolated synthetic staff sessions, including assigned/unassigned Managers, expired sessions, stale writes and CSRF rejection. Test the editor interaction separately and inspect mobile/desktop layouts. See the [protected content API contract](protected-content-api.md).

### Milestone 2G — protected admin review and publication

Extend the protected question editor with exact-revision submission, review decisions and notes, publication/replacement, and retirement. Reuse the existing protected API services, shared request contracts, same-origin CSRF client, MFA and certification guards. Add only an exact-question/exam-version publication-status read when needed; it must return the current pointer state/version and be authorized in its primary D1 query. Derive controls from the selected exact revision and server pointer. Require explicit confirmation before replacing a live publication and before retirement. Retain form/review notes on conflicts, refresh the affected state, and require a deliberate new action. Keep review and publisher audit identities independent; the launch policy does not require a second person. Test actual Worker/D1 flows for assigned and unassigned Managers, rejection/correction, exact-revision approval, stale pointer conflicts, replacement, retirement/history and UI request races. Verify authenticated mobile and desktop controls. Do not add sign-in, import/export screens, learner features, providers or deployment.

### Milestone 2H — protected admin import and export screens

Connect the existing CSV preview, draft-only confirmation, and scoped published-content export services to the real protected staff workspace. Let staff choose an already-authorized certification and exam version, provide the exact v1 template with synthetic sample content, enforce the existing 10-row/256-KiB limits, and present preview row counts, actionable row/column errors, and expiry. Clear previews on file or scope changes and ignore stale responses. Confirmation sends only the preview ID and retries the same ID after an ambiguous response; it never creates or publishes content in the browser. Download published exports in 100-question cursor pages with spreadsheet-safe handling and a clear notice that reports are not directly re-importable. Reuse existing CSRF, session, MFA, permission, and private-response controls. Keep CSV contents in transient memory only; do not write browser storage or logs. Test the UI with synthetic data and retain actual Worker/D1 coverage for session authorization, preview, confirmation, export, expiry, retry/idempotency and scope denial. Check responsive authenticated controls. Do not add provider sign-in, deployment, learner features, or public content routes.

### Deferred Milestone 2 work

Provider selection and its compatibility proof remain pending approval; do not weaken either staff role's MFA requirement to meet a cost target. Provider-backed registration, Google sign-in/account linking, recovery, session issuance/revocation, and lifecycle-event handling require a separately approved provider and assurance/outage policies. Remaining admin workflows stay separate UI slices. Carry attempt, bookmark, notes, learner-record ownership, and attempt-to-revision snapshot tests into the milestone that implements learner persistence; they are not prerequisites for this content-only slice. Preserve the existing same-exam Pro prerequisite, public SEO, and prototype isolation.

Implementation status: an invite-only email sign-in link proof exists for
pre-provisioned learners. It is local-only, disabled by default, issues no
invitations of its own, sends no email, and changes no product rule; Google
OAuth setup is paused and no provider is selected. See the [email sign-in link
review](reviews/learner-email-sign-in-links.md).

Implementation status: the real admin panel now sits behind a fail-closed tester
allowlist and individual staff sign-in, with an offline provisioning script for
two Global Admins and one exam-scoped Manager. Staff MFA remains parked; a
labelled tester assurance substitutes for it and is accepted only while the
allowlist and an explicit owner flag are configured. Nothing is deployed and no
production account exists. Deployment is blocked on the Workers Free CPU
capacity finding and on review of the assurance. See the [tester access
review](reviews/admin-tester-access.md).

Acceptance for the remaining identity and admin workflows: cross-user and unauthorised admin requests fail; unsafe account linking fails; import validation prevents accidental publication. Manager cannot access unassigned certifications through direct IDs, list queries, reassignment, imports or exports; cannot change finance/access/security/staff settings. Assignment revocation is effective on subsequent requests. Both staff roles require MFA. Content and role changes are audited.

## Milestone 3 — Standard learning engine

Deliver learner persistence in separately reviewed slices. Milestones 3A and 3B implement untimed practice and fixed-format Standard timed mocks. Notes, bookmarks, reports, adaptive exams, grant-management workflows and production provisioning remain later work.

### Milestone 3A — untimed learner practice

Use the opaque application-session cookie and active, time-bounded Standard access grant for every practice read and write. Learners may select an authorized certification/version, domain, difficulty and 1–20 published questions. Persist the exact sealed revision, ordered question/option snapshots, filters, position, accepted answers and expected version. The Worker withholds correct-answer keys and explanations until that question is submitted, scores server-side, and locks completed attempts. Use a request ID for start/answer retries and a compare-and-set version for answers. Keep current progress server-side; never write protected questions, answers or credentials to browser storage. Save & exit is available only when there is no unsubmitted local selection; all submitted progress is already acknowledged by the server.

The access-grant table is read-only to runtime APIs in this slice. Isolated test factories seed synthetic learners, sessions and grants; provider-backed sign-in, grant issuance/management and payments are not implemented. Require active access to start, resume, read and answer an attempt. If access expires mid-attempt, deny further reads and writes while retaining the immutable snapshot. This is a conservative temporary gate, not an approved release policy: the owner must decide whether an active attempt may continue, receives a grace interval, or stops at expiry, and how completed explanations remain available.

Implementation status: the protected Worker/D1 API, immutable attempt snapshots,
answer submission and resume UI are implemented and covered by isolated
synthetic-session integration tests. The standalone `/app/practice/live` route
is separate from the browser-storage prototype. Responsive browser inspection
used synthetic protected-API responses; it did not imply provider-backed or
live session issuance. See the [Milestone 3A handoff](reviews/milestone-3a.md)
for actual verification and limitations.

### Milestone 3B — Standard timed mock exams

Add a fixed-format, versioned mock profile for each certification/exam version.
The approved local profile is 15 minutes and 10 published single-choice
questions with reviewable navigation. The server validates profile bounds,
selects and snapshots exact sealed revisions and option order at start, and
sets an immutable deadline from its clock. Client input cannot set duration,
question count, deadline, score, or answer-key data.

Use the existing opaque session cookie and exact-certification Standard grant
for every start, list, resume, answer, position, submit, and result read.
Answers and navigation commands require request IDs and expected attempt
versions. Active responses omit correct keys and explanations. The server
rejects answer writes at or after the deadline, finalizes from acknowledged
answers on submission or the next authorized read after expiry, and returns
the single persisted result on retries. A completed attempt is immutable.
Leaving or reauthenticating does not pause the deadline.

The current conservative Standard-expiry behavior remains: an expired grant
blocks attempt access even if the timer has expired. This is separate from mock
deadline handling and remains a product decision; see the [Milestone 3B
handoff](reviews/milestone-3b.md) and [timed-mock API contract](timed-mock-api.md).
Provider-backed sign-in, session issuance, grant-management screens,
adaptive Pro exams, payments and deployment remain out of scope.

### Milestone 3C — learner dashboard and progress history

Add a protected `/app/home` dashboard backed by a same-origin Worker endpoint.
Build its groups only from the learner's current active Standard grants and
active server-validated session. Return bounded summaries for the learner's
own untimed and timed attempts: up to 20 in-progress and 20 completed attempts
per attempt type, and at most 200 authorized certification/version groups.
Summaries may contain acknowledged answer counts, current position, recorded
score and mock deadline, but never question text, choices, explanations or
answer keys. Keep running mocks ahead of recent completed attempts and link
each card to the existing protected attempt/result route by its exact attempt
ID. The attempt endpoint remains authoritative for ownership, active exam
access and timeout finalization.

An expired or revoked Standard grant hides that exam's dashboard group and
continues to block direct attempt/result reads; restore access before the
learner can resume or review that exam. A timed-out mock remains resumable in
the summary until an authorized read finalizes it. Do not pause or change the
existing server deadline. Provider-backed sign-in, grant management, billing,
adaptive Pro exams and deployment are separate work.

Acceptance for the remaining learning-engine slices: acknowledged answers survive interruption; duplicate answer requests have one effect; server timing applies; content updates preserve attempt snapshots; correct keys are not disclosed prematurely. Save & exit cannot report success on failed persistence; stale writes cannot overwrite later progress; final attempts stay locked. Leaving non-pausable exams does not stop their timer. Reauthentication recovery and access expiry follow explicit policies.

## Milestone 4 — commerce and entitlement rules

Resolve country, currency, prices, renewal model and extension policy. Implement one payment provider in sandbox, per-exam grants, same-exam Pro dependency, calendar dates, replay-safe notifications and reconciliation. Add customer purchase history and audited staff operations.

Acceptance: test delayed/duplicate/out-of-order events, payment failure, refund, early extension, month-end purchase, and Pro prerequisite violations. Use a server clock abstraction in date tests. No real charge until an explicit release action.

## Milestone 5 — session sharing controls

Device registration, new-device verification, transactional active study lease, session transfer/revocation, recovery, and admin review. Validate Cloudflare concurrency behaviour rather than relying on browser state.

Acceptance: two concurrent clients cannot claim the same active study slot; tabs remain usable; interrupted devices recover; a legitimate phone/laptop switch restores saved progress and is understandable. Returning stale tabs cannot overwrite accepted answers. Verify race conditions with concurrent requests, lease expiry, crashes and revocation.

## Milestone 6 — Pro

Implement the approved heuristic adaptive profile with deterministic replay, domain constraints, exposure controls, sufficient-pool checks and transparent reports. Validate content and behaviour before accepting Pro purchases. Keep psychometric CAT and official pass prediction outside initial claims.

Acceptance: same inputs/seed/profile replay selection; pool shortage fails clearly; domain constraints hold; expired Pro blocks new simulations; reports show sample sufficiency. Review with a subject specialist before public launch.

## Milestone 7 — pilot and release

Accessibility and mobile/browser verification, security review, real-provider sandbox journeys, monitoring, usage/load assessment, backups/restoration, support/policy pages and a rollback exercise. Add staging and approved production deployment workflow. Pilot with reviewed content and a small user group before broader sales. Verify agreed browser/version matrix and representative viewport sizes, keyboard/screen-reader and zoom operation. Check public HTML without JavaScript, canonical/redirect/sitemap/noindex rules, performance budgets and Search Console setup. Verify consent changes, attribution and deduplicated purchase events; reconcile financial reports to provider records. Save/restore, Manager isolation and mobile-to-desktop continuation are release gates.

## First Copilot prompt

Read docs/product-design.md and docs/build-plan.md. Implement Milestone 0 only. First inspect the repository and existing instructions, report any conflicts, and list unresolved choices that affect this milestone. Use React/TypeScript and select a Cloudflare-compatible SSR/prerender strategy for public acquisition routes before scaffolding. Record the decision and verify compatibility; client-rendered private routes are acceptable. Use a TypeScript Cloudflare Worker API (Hono proposed), D1 migrations, and shared validation contracts. Keep the structure small. Verify current package compatibility and pin a lockfile. Create mobile/tablet/desktop learner and admin shells with placeholder pages, a meaningful pre-rendered/server-rendered public page, a non-sensitive API health endpoint, local setup documentation, SEO and event contracts, and CI for types/build and public metadata. Document exactly Global Admin and exam-scoped Manager permissions and autosave/Save & exit semantics; do not implement production permissions with fixture roles. Do not implement authentication, billing, adaptive exams or production deployment. Do not invent provider credentials or real question content. Run appropriate checks and report changed files, commands to run locally, verification results, and remaining limitations. Ask before changing product rules or adding major dependencies.

## Review handoff for every pull request

Provide the PR link, intended milestone, change summary, verification results, screenshots for changed learner/admin screens, and known limitations. Architect review should check product rules, security boundaries, accessibility, data migrations and unnecessary complexity. Update decision records when an accepted decision changes the baseline.

## Post-launch candidate backlog

Personalised study plans, mistake notebook, Standard spaced repetition, optional confidence tags, user-controlled reminders and richer Pro preparation journeys. Prioritise from pilot evidence and explicitly approve scope before writing implementation prompts. AI tutoring, localisation, offline practice, community and leaderboards remain later candidates.

## Required acceptance matrix

Per-exam Standard and Pro dependency; month-end/renewal dates; verified payments and notification replay; save acknowledgement and failed-save recovery; resumed practice and timed exams; stale/concurrent device writes; both staff roles and assigned-exam isolation; private content protection; public SEO/indexing; consent/analytics deduplication; supported browsers/accessibility; staging isolation and backup restoration. Tests target these behavioural risks rather than copying implementation details.
