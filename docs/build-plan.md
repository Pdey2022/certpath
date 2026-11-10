# GitHub and Copilot build plan v0.2

Read product-design.md as the product baseline. Proposed decisions remain proposals until accepted. Each milestone has its own branch and pull request. Do not implement the entire application in a single agent prompt.

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

Select auth provider; configure email/Google flows, secure sessions and staff MFA. Add user and certification/content schema, Global Admin/Manager roles, certification assignments, ownership/permission checks, question revision workflow, bulk-import preview, and audit records. Use development identities, never fake production roles.

Acceptance: cross-user and unauthorised admin requests fail; unsafe account linking fails; published revisions remain immutable; import validation prevents accidental publication. Manager cannot access unassigned certifications through direct IDs, list queries, reassignment, imports or exports; cannot change finance/access/security/staff settings. Assignment revocation is effective on subsequent requests. Both staff roles require MFA. Content and role changes are audited.

## Milestone 3 — Standard learning engine

Persist practice, attempts, answers, notes, bookmarks and reports. Add autosave and explicit Save & exit with server acknowledgements, revision conflicts, deduplicated retries, saved question position/order/filter state, and interrupted-session recovery. Implement versioned fixed mock profiles, authoritative timers, safe answer retries, refresh recovery, results and honest progress metrics. Add manual development-only grants behind an explicit environment guard, then remove their necessity for production.

Acceptance: acknowledged answers survive interruption; duplicate answer requests have one effect; server timing applies; content updates preserve attempt snapshots; correct keys are not disclosed prematurely. Save & exit cannot report success on failed persistence; stale writes cannot overwrite later progress; final attempts stay locked. Leaving non-pausable exams does not stop their timer. Reauthentication recovery and access expiry follow explicit policies.

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
