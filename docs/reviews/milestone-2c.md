# Milestone 2C Review Handoff

## What was implemented

- Added versioned exam taxonomy and content tables to D1: exam versions, domains, topics, stable question identities, immutable question revisions and answer options, editorial workflow events, review decisions, publication pointers/history, and cross-certification copy provenance.
- Added server-only content functions for taxonomy/question creation, corrected revisions, review submission and decisions, publishing/retiring, protected reads, and cross-certification copying. No HTTP endpoints or admin UI integration were added.
- Reused the existing session, staff-role, certification-assignment, and injected MFA-policy checks. Current authorization is rechecked in guarded database writes; reads use D1 `first-primary`.
- Added synthetic Worker/D1 integration tests and retained test factories under the API test directory only.
- Updated the build plan with the 2C boundary and deferred work.

## Architecture decisions

- Exam-version, domain, and topic identities and meanings are immutable. Changes to syllabus or taxonomy create new identities; old references retain their historical meaning.
- A question keeps its certification ownership permanently. Same-certification corrections create a new immutable revision with an expected lock version. Reuse across certifications creates a new question and revision and records source certification, question, revision, actor, and reason.
- Composite foreign keys enforce certification, exam-version, domain, topic, question, and revision consistency. Restrictive deletion, immutable-row triggers, and append-only workflow/review/publication records preserve history.
- Single-choice content is supported in this slice. Stems, difficulty, source/license references, 2–8 ordered unique options, explanations, and exactly one correct answer are validated before writes and again at submission.
- Review and publication are separate workflow events. The database only permits publishing the exact approved revision. A Manager may review/publish their own revision under the existing proposed launch policy; no second-person rule was added.
- D1 conditional statements contain the current session, MFA, role, and assignment predicates. Question/revision/option creation and cross-certification provenance use D1 batches; option sets are inserted with one guarded statement. SQL errors and trigger/audit failures abort the batch. Zero-row guards are handled through dependent-row predicates, so a denied/stale parent produces no child, publication, or success-audit row; no post-batch check is treated as rollback.
- Publication uses an expected pointer version and guarded state transition. Triggers append publication history and audit events in the same statement. A concurrent or stale publisher gets a conflict and creates no success audit.

## Files changed

- `db/migrations/0003_versioned_content.sql`
- `apps/api/src/security/content.ts`
- `apps/api/src/security/database.ts`
- `apps/api/test/content-fixtures.ts`
- `apps/api/test/content.test.ts`
- `apps/api/test/schema.test.ts`
- `docs/build-plan.md`
- `docs/reviews/milestone-2c.md`

No dependency was added.

## Verification

All commands were run on Windows in the repository worktree:

- `npm run verify` — passed.
  - TypeScript checks passed for API, API test code, contracts, and web.
  - API tests: 6 Vitest files, 26 tests passed; the health test passed.
  - Web tests: 13 passed.
  - React Router production client and Worker builds completed successfully.
- `Set-Location apps\api; npx vitest run --config vitest.config.ts test/content.test.ts test/schema.test.ts` — passed, 2 files and 12 tests.
  - The Cloudflare Vitest plugin ran against its isolated Miniflare Worker/D1 runtime.
  - Test setup applied all migrations twice. Tests cover invalid taxonomy references, immutable revisions/options, stale and concurrent edits/publication, editorial transitions, retirement, access/MFA/session/assignment denial, copy provenance and both-scope authorization, and audit-failure atomicity.
- Ubuntu GitHub Actions verification is required on the exact pushed commit before review handoff is complete.

## Limitations and deferred work

- The content service is internal and has no HTTP routes or admin UI integration.
- There are no imports/exports, learner attempts/bookmarks, exam selection, attempt snapshots, production content, provider integration, or provider-event infrastructure.
- Single-choice questions only; question validation and editorial workflow are the scope of this slice.
- Provider choice, production MFA/session policy, and provider revocation remain pending approval. This code does not perform production authentication or provisioning.
- No production D1 database or deployment was accessed.

## Architect inspection and run steps

1. Review the migration and its guards/triggers in `db/migrations/0003_versioned_content.sql`.
2. Review authorization and conditional writes in `apps/api/src/security/content.ts`; confirm no route imports or exposes these functions.
3. Review the D1 scenarios in `apps/api/test/content.test.ts` and isolated fixture setup in `apps/api/test/content-fixtures.ts`.
4. From the repository root, run `npm ci --include=optional` and `npm run verify`.
5. To focus on content and migrations, run `Set-Location apps\api; npx vitest run --config vitest.config.ts test/content.test.ts test/schema.test.ts`.
6. Confirm the Ubuntu Actions run for the final pushed SHA is green before approving the pull request.
