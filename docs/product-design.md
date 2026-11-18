# Exam preparation platform — design specification v0.2

Status: confirmed requirements with proposals explicitly labelled, 10 November 2026. Brand: CertPath (owner decision, 18 November 2026, PR #161); domain and canonical production origin undecided.

## 1. Product contract

Mobile-first consumer certification preparation. One account can own several independent exam memberships. Standard includes that exam's published questions, answers, explanations, practice, normal mock exams, and progress. Standard durations: 3, 6, or 12 calendar months. Pro adds adaptive preparation and reports for exactly 3 calendar months; it requires Standard for the same exam throughout its validity. No all-exam subscription.

Pro should be purchasable when approaching the real exam. Proposed baseline: starts immediately after confirmed payment, with an explicit date range shown before checkout. Deferred activation requires a separate product decision and is excluded initially. If Standard cannot cover Pro, offer a clearly priced extension; never silently shorten Pro. How to price an exact extension remains open. Until configured, block that purchase with an explanatory renewal path.

Pro expiry leaves Standard intact. Standard expiry preserves the account and study history, but blocks new protected content and new attempts. Proposed policy: completed results remain readable, including explanations for questions already answered; confirm before launch. A new exam version does not overwrite historical attempts.

Recurring renewal versus fixed-term passes remains open. Build the first purchase flow as fixed-term access unless explicitly changed; do not silently enable recurring billing. No final prices or currency are set.

## 2. Visual and interaction direction

Quiet, professional learning environment. Light neutral surfaces, dark navy text, teal primary actions, amber notices, red errors. Accessible contrast takes priority over the palette. Dark mode follows after the primary experience is validated. Use a system font stack, readable 16px body text, generous line height, and answer choices that expand naturally. Avoid decorative illustrations on study screens.

Mobile-first at 360px, then verify 320px to large desktop. Aim for 44px touch controls, visible keyboard focus, screen-reader labels, reduced motion, and WCAG 2.2 AA. Do not use colour alone for correctness. Allow browser zoom and text resizing. Avoid hover-only controls. All forms have field-level errors and an error summary where useful.

Desktop learner navigation: sidebar. Mobile: Home, My Exams, Practice, Progress, Account bottom navigation. Admin uses a separate responsive workspace; complex imports and bulk editing are optimised for desktop, with usable mobile review.

Every page defines loading, empty, error, offline, expired-access, and permission-denied states where relevant. Every important action has pending, success, and failure feedback. Dates show an explicit timezone when ambiguity matters. Do not display fictitious progress or revenue.

### Responsive browser contract

One web app supports mobile, tablet and desktop. Desktop uses a sidebar and complementary dashboard columns; questions retain a comfortable reading width. Breakpoints follow content fit rather than device detection. Verify Chrome, Edge, Firefox and Safari, including Android Chrome and iOS Safari; record supported versions at release. Include 320px, 390px, 768px, 1024px and 1440px viewports plus zoom/text resizing. Do not assume a smaller desktop browser behaves like a phone. Complex admin editing remains usable at narrow widths.

The interactive demo is a visual/navigation reference using synthetic data and the approved brand CertPath. It is not implemented authentication, payments, secure saving, or adaptive testing. PWA installation is optional; offline exam taking is not initial scope.

## 3. Learner screen map

Public: landing page; exam catalogue; exam detail; Standard/Pro comparison; help; sign in/register; email verification; recovery; policies.

Authenticated: onboarding; home; my exams; exam workspace; practice setup; practice session; explanation/review; mock setup; exam instructions; active exam; results; attempt history; bookmarks/mistakes; progress; access and purchases; checkout; payment pending/result; account; devices; notification preferences; support.

### Home

Top: greeting, selected certification, optional target exam date. Primary card: Continue study or Start a short practice. Secondary: recommended next task with a reason. Exam cards: certification, Standard expiry, Pro state, latest activity. Reminders: only relevant access or study notices. Cross-sell belongs below current learning tasks.

Example mobile layout:

    CertPath                          Account
    Your next step
    CISSP · Target exam: 18 June
    Continue your practice
    7 of 15 questions · Saved 2 min ago
    [ Continue ]
    Recommended: revise Domain 3
    Based on 12 first-attempt answers
    Your exams
    CISSP  Standard until 20 June
           Pro until 18 June
    [ Open exam ] [ Manage access ]
    Home | My Exams | Practice | Progress | Account

### Exam workspace

Header: exam and syllabus version, target date, access status. Sections: Overview, Practise, Mock exams, Pro, History. On narrow screens use a labelled section selector rather than overflowing tabs. Overview contains domain coverage and recommendations, not a wall of statistics.

### Practice

Setup: domain/topic, question count, unanswered/incorrect/bookmarked pool, optional difficulty. Show available matching count before starting. One question per view; clear selection and submission. Explain correctness after submission; include reasons for distractors and references. Bookmark, note, and report-question actions remain secondary. Show save status. Resume after interruption.

### Save and resume — confirmed requirement

Automatically save study progress and provide Save & exit. Restore the same practice session, position, question order, accepted answers, submitted/revealed state and selected filters. Persist notes, bookmarks and history across devices. Changing devices requires transfer of the active study lease. A completed attempt is locked, never resumed as editable.

Display Saving, Saved (with time), and Unable to save—retry. Show Saved only after server acknowledgement. Save & exit waits for acknowledgement or explicitly offers retry/staying on the page. A page-unload request alone is insufficient. Keep bounded pending state during temporary disconnection, retry safely, and make unsynced work visible. Durable offline storage needs a separate privacy/security design and is excluded initially.

Use deduplicated requests and versioned session updates to reject stale writes. Restoring filters cannot change an in-progress question set. Recover from expired authentication without bypassing access checks. Never overwrite newer device progress silently.

Mock and Pro attempts autosave but leaving does not necessarily pause timing. Show Leave exam and its consequences. Non-pausable timers continue on the server while disconnected or away. Resume restores acknowledged answers and authoritative remaining time. Allowed pauses are recorded server-side. Timed-out attempts follow the profile completion policy. Access expiry during an attempt remains a policy decision required before release.

### Mock exam

Before start: duration, question count, navigation rules, pause policy, connection requirements, access implications. In session: progress, timer, question, answer choices, permitted navigation. Hide unrelated navigation. Flag/review only when the configured exam profile permits it. Submission confirmation includes unanswered count. Server enforces timing and locks accepted answers according to profile.

### Pro

States: no Standard; eligible to buy; insufficient Standard coverage; active; expired; temporarily unavailable because question pool is inadequate. Explain each state and provide one clear next action. Active Pro shows Start simulation, attempt history, domain feedback, and a recommended revision task. Insufficient data produces an explicit message, not a readiness percentage.

### Results and progress

Results: score where appropriate, completion summary, domain breakdown, reviewed answers, recommended next step. Separate first-seen performance from repeats. Readiness is an estimate and is not an official pass prediction. Preserve attempt snapshots. Progress has an exam selector, date range, coverage, first-attempt accuracy, mock trends, and data sufficiency indicators. Avoid misleading aggregation across certifications.

### Access and account

One card per exam with independent Standard and Pro dates, purchase history, add-Pro/extend actions. Explore exams is separate. Show full price, currency, coverage, activation and expiry dates before payment. Account includes sign-in methods, device/session management, preferences, support, data export and deletion request.

## 4. Admin workspace

Navigation: Overview; Certifications; Question bank; Reviews; Exam profiles; Pro settings; Products & prices; Customers; Payments; Support; Reports; Staff & audit; Settings.

Exactly two staff roles: Global Admin and Manager. Global Admin controls all certifications, staff assignments, pricing, customer access, payments/refunds, security, integrations, settings and audit reports. Manager adds and maintains modules, domains, topics, questions, explanations and mock/adaptive profiles within explicitly assigned certifications; may amend, review, publish and retire that content and inspect its quality reports. Managers cannot manage prices, payments, access grants, staff, security or secrets, or browse unrestricted customer data.

Global Admin assigns Managers one or more certifications. Managers may create modules/versions inside assigned certifications; Global Admin creates new certification roots and assignments. Assignment changes take effect on subsequent requests and are audited. Enforce scope on the backend for every list, detail, mutation, nested resource, import and export. Check both current and proposed certification on reassignments. Deny by default. Both staff roles require MFA.

Workflow states are not additional roles. Record reviewer and publisher separately. Proposed launch policy allows an assigned Manager to publish their own reviewed revision with an audit trail; optional second-person approval must enforce a different approver if enabled. Managers see minimal learner context when investigating content reports. No unrestricted impersonation or unlogged overrides.

Question editor: stable ID, certification/version, domain/topic/objective, stem, options, correct answer, explanation per option, references, difficulty, tags, source/licence provenance, status and revision history. Import uses upload, validation, preview, confirmation, outcome report. Reject malformed rows; identify duplicates; do not publish on import by default.

Editorial workflow: draft → in review → approved → published → retired. Corrections create revisions. Audit who approved and published. Reports link to the exact revision. Do not delete a referenced revision.

Exam profiles configure question count, duration, topic weights, navigation, review and pause rules. Adaptive profiles additionally configure difficulty selection, minimum/maximum questions, exposure and repeat controls, and supported stopping policy. Validate settings against available approved content. Preview and test before activation; new attempts use a versioned profile.

Pricing: per-exam Standard durations and Pro price; effective dates; publication status; provider price references. New prices do not rewrite completed purchases. Discounts, refunds, access grants and extensions record an actor and reason. Never provide an unlogged 'mark paid' shortcut.

Security settings include device and active-session limits, verification policies, revocation and reviewed alerts. Warn about the impact of policy changes. Provider secrets are configured through deployment secret management, never returned to the browser.

## 5. Learning quality and adaptive scope

Use a shared assessment engine with versioned certification profiles. Start with single-choice questions while allowing typed future item formats. Each exam syllabus is versioned with effective dates. New certifications are added as data plus supported profile settings, without bespoke screen copies.

Initial Pro uses an explicitly labelled heuristic adaptive simulation: reviewed difficulty bands, performance-based selection, domain balancing, repeat/exposure control, and a declared stopping policy. Do not claim psychometric equivalence to official CAT. Reserve a calibrated ability-estimation implementation for a validated later stage with expert review and sufficient data. No unsupported confidence-based early stopping.

Maintain practice and mock pools, with sufficient unpublished-to-user questions for meaningful first-seen assessments. If pool constraints cannot be satisfied, prevent starting rather than silently weakening the profile. Define content readiness per certification before enabling sales.

## 6. Architecture proposal

One repository, one modular application. Frontend: React + TypeScript with a Cloudflare-compatible SSR/prerender strategy selected in an architecture decision before scaffolding public routes. Authenticated routes may use client rendering. Backend: TypeScript Cloudflare Worker with Hono as the proposed API layer, subject to frontend-runtime compatibility. Database: D1 with SQL migrations and a small typed access layer. Deploy static frontend assets and API under one origin. Proposed workspace: apps/web, apps/api, packages/contracts, db/migrations, docs. Avoid microservices and generic plugin execution in v1.

Use an established managed authentication service with email registration and Google sign-in. Provider selection is pending business country, cost, data needs, and Worker compatibility. Auth adapter isolates provider identifiers from internal user IDs. Document safe account-linking and recovery flows; never merge accounts solely because an unverified email matches.

Stripe is the proposed first payment provider, PayPal a later adapter. Provider country eligibility and currency remain unresolved. Internal entitlements drive access, not browser claims or payment return URLs. Transactional email and monitoring providers remain selectable. No provider integration is complete until configured and tested.

Cloudflare R2 is optional for later media/import objects; do not introduce storage products without a need. Use database indexes, bounded queries, pagination and measured request frequency. Load-test the actual authentication and adaptive paths against free-tier constraints. Budget a paid-plan transition; free-tier hosting is a launch target, not an availability guarantee.

## 7. Core records and invariants

users; auth_identities; staff_roles (global_admin or manager); manager_certification_assignments; certifications; exam_versions; domains; topics; questions; question_revisions; answer_options; content_reviews; exam_profiles/profile_versions; products/prices; orders/order_items; payment_events; entitlement_grants; study_sessions; attempts; attempt_items; answer_events; bookmarks; notes; devices; sessions; active_study_leases; question_reports; audit_events.

Entitlement grant: user, certification, feature (standard/pro), starts_at, ends_at, source order/admin grant, status. Multiple grants can form continuous coverage. For every Pro interval, Standard coverage for that certification must cover its entirety. Cancelling or refunding dependent Standard invokes an explicit dependent-Pro policy; never leave silently inconsistent grants.

Store timestamps in UTC; document calendar arithmetic and display rules. Proposed expiry arithmetic: add calendar months from activation in UTC, clamp to the last valid day, end timestamp exclusive. Confirm the customer-facing timezone policy before implementation. Early Standard extension begins at the end of continuous current coverage, otherwise at activation. Do not infer 3 months as 90 days.

Attempt snapshots include question revisions, option order, exam/profile version and adaptive algorithm version. Store authoritative answer and timing state on the server. Aggregate progress is derived from preserved attempts, with repeat status and sample counts.

## 8. API and security boundaries

API domains: /me; /catalog; /entitlements; /checkout; /payment-events; /practice; /attempts; /progress; /devices; /admin. Shared schemas validate inputs and outputs. Every protected handler checks identity, permission/ownership and applicable entitlement. Return consistent errors without leaking another user's records.

Proposed defaults: two registered browsers/devices, one active study lease per account. Device identity is approximate; a cleared browser is a new registration. A transactional claim/transfer operation prevents simultaneous lease acquisition. Do not write a heartbeat every second. Use a bounded lease renewal interval and recover after browser crashes. Normal account browsing does not seize the study lease. Tabs coordinate the same session. Network loss does not automatically evict a legitimate learner.

Use secure HttpOnly cookies, server-side revocation, CSRF protection for cookie-authenticated mutations, origin checks, rate limits and output escaping. Never store bearer credentials in localStorage. Request fresh verification for sensitive account and staff actions. Keep answers out of unsupervised frontend bundles and question payloads until permitted. Treat content imports as untrusted input.

Payments: authenticate provider notifications; durably store provider event IDs with uniqueness; handle duplicates and out-of-order state; atomically record order effects and access grants where possible; retry recoverable failures; reconcile against provider state. Record refunds and access changes as history, not destructive overwrites.

Avoid strict IP locks. Provide remote sign-out, device replacement/recovery, abuse review, and privacy-conscious retention. No mechanism guarantees elimination of voluntary credential sharing.

## 9. Integration and operations contracts

Authentication: verification, Google, recovery, linking, session revocation. Payments: checkout, confirmation, refund, failure, reconciliation. Email: account messages, purchase/access notifications, reminders; marketing preference separate. Monitoring: request failures, answer-save failures, payment backlog, entitlement inconsistencies, usage limits; scrub tokens, secrets, and unnecessary personal data.

Separate development/staging/production data and secrets. GitHub Actions runs type checks, build, meaningful unit/integration tests; deployment uses narrowly scoped credentials. Protect main and avoid automatic production deployment until the release workflow is agreed. Create backups and test a restore. Define support response routes and an incident procedure before launch. Maintain dependency updates and a migration/rollback plan; destructive database changes need staged rollout.

Product metrics: onboarding completion, first practice completion, active learners by exam, return rate, mock completion, Standard-to-Pro conversion, renewal, payment failure and reported-question rate. Collect only necessary analytics. Privacy/retention and tax/consumer policy review depend on launch market; do not assume a jurisdiction from the developer's location.

## 10. Decisions needed before production

Launch exam and reviewed content source; business country/currency; brand/domain; pricing; fixed-term versus auto-renewal; Standard extension pricing for Pro; Pro repurchase policy; expiry during active exams; historical explanation access; auth/email/monitoring providers; privacy/retention and refund policies; initial device policy approval. These do not block a clearly labelled local prototype.

## 11. SEO and tracking — mandatory foundation

Public exam, pricing, sample-question and editorial pages must return meaningful server-rendered or pre-rendered HTML. Select a Cloudflare-compatible rendering solution before scaffolding, retaining React/TypeScript. Authenticated learning pages may use client rendering. Do not rely on an empty browser-rendered shell for acquisition pages.

SEO contract: useful original public content; stable readable URLs; unique titles/descriptions; canonical tags; internal links and breadcrumbs; accurate status codes and redirects; XML sitemap; robots configuration; social previews; appropriate structured data matching visible content. Publish only explicitly approved public sample questions; never expose paid banks to crawlers. Define exam-version archive/canonical rules. No ranking or rich-result guarantee.

Private learner pages, admin, checkout and staging are excluded from sitemaps and receive noindex directives. Enforce authentication separately; robots.txt does not secure data. Restrict staging access. Test public HTML with JavaScript disabled, mobile usability, metadata, redirects and crawlability. Establish performance budgets and monitor real-user loading, responsiveness and layout stability. Connect Search Console for indexing/crawl and search-performance monitoring.

Define a versioned analytics event dictionary before implementation: exam_viewed, sample_started/completed, signup_completed, checkout_started, purchase_confirmed, practice_completed, mock_completed, pro_activated, pro_simulation_completed and access_renewed. Specify triggers, safe properties, schema version and deduplication keys. Confirm purchases and access events from verified server processing. Do not send email, credentials, question/answer content or unnecessary personal data to analytics providers.

Measure acquisition source, per-exam conversion, Standard-to-Pro conversion, engagement, renewal and revenue/refunds. Document attribution model, campaign retention and reporting timezone; sanitise campaign parameters. Finance reports reconcile to order/provider records rather than browser events. Exclude demo, staff and test traffic. Analytics failures must not interrupt learning or checkout.

Implement market-appropriate consent for optional tracking, withdrawal and retention. Link anonymous and account activity only where permitted and disclosed. No invasive fingerprinting. Advertising pixels require an explicit marketing decision. Analytics providers remain open and replaceable through an adapter.

Operational traceability includes correlation IDs, redacted structured logs, payment/access processing history, notification failures, and audited admin changes. Restrict access and define retention. Add docs/analytics-events.md and docs/seo.md to the repository. SEO rendering and event contracts belong in Milestone 0; validate public journeys and real integrations before release.

## 12. Release acceptance scenarios

Purchase CISSP Standard without obtaining CISM access. Purchase Pro only when same-exam Standard fully covers its three months. Duplicate payment events never grant duplicate time. Failed or pending payment never grants paid access. Pro expiry preserves remaining Standard. Concurrent login/lease claims cannot yield two active study leases. Refresh and temporary disconnect preserve acknowledged answers. Late answers follow server timing rules. Question corrections do not rewrite results. Manager cannot grant access, refund, or access an unassigned certification, including through direct requests, nested resources, imports and exports. Screen-reader/keyboard and small-screen learning flows work. Restore a backup in a non-production environment. No paid feature relies solely on a hidden frontend button.

## 13. Enhancement priorities — proposals, not automatic scope

Launch foundation: trustworthy explanations including distractor reasoning; reliable save/resume; accessible responsive learning; honest first-seen progress; question reporting and Manager review; independent per-exam access management; SEO and measurement foundations.

Candidate next phase: personalised study plans using exam date and available time; a mistake notebook; spaced repetition within Standard; optional confidence tagging; configurable reminders and weekly summaries; a structured Pro baseline/revision/fresh-simulation/checklist journey. Agree each feature before implementation and version its event and data contracts. Explain recommendations and allow learner control.

Later candidates: grounded AI assistance, localisation and offline practice. Community forums, leaderboards and open-ended AI tutoring are deferred. Do not claim these proposals are committed launch features.
