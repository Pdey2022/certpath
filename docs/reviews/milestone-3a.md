# Milestone 3A review handoff

## Status and scope

Implements untimed, server-saved learner practice using published
single-choice content. Learners can start an attempt, submit answers, resume
acknowledged progress, review completed results, and exit only after all work
is acknowledged. The synthetic `/app` and `/app/practice` prototype remains
separate from `/app/practice/live`.

No provider sign-in, live session issuance, access-grant management, payments,
timed mocks, adaptive exams, production provisioning, or deployment was added.
Test fixtures create synthetic users, sessions, grants, taxonomy and question
content only inside the isolated test harness.

## Architecture and product decisions

- The learner identity is resolved only from the opaque application-session
  cookie. The Worker hashes its raw value and validates the active session in
  D1; request data cannot supply identity, role, access or time authority.
- Each attempt requires a current, time-bounded Standard grant for the exact
  certification on every create, list, resume, read and answer operation.
  The runtime API does not issue or modify grants.
- Attempt creation snapshots exact sealed published revisions, question and
  option order, filters and position. Snapshots remain unchanged if source
  content is later republished or retired.
- Correct option keys and explanations stay server-side until the learner
  submits that question. The server validates and scores the answer, advances
  position and updates the expected version in one atomic operation. Completed
  attempts are locked.
- Start and answer request IDs provide retry deduplication; expected attempt
  versions reject stale writes. `Saved` is shown only after a server response.
  Failed submissions retain their pending answer in the open screen and offer
  a retry using the same operation. Save & exit is disabled while there is an
  unsubmitted choice or unresolved save.
- D1 attempt initialization uses a bounded batch and a finalization trigger
  that requires the expected complete snapshot count and rechecks session,
  user and grant state. A zero-row or failed snapshot insert cannot finalize a
  partial attempt; the batch rolls back rather than treating an incomplete
  attempt as success.
- Access-expiry behavior remains unresolved by the product owner. This slice
  takes the conservative temporary approach: expiry blocks further attempt
  reads and writes, while retained snapshots are not deleted. The owner must
  decide whether active attempts continue, receive a grace period, or stop at
  expiry, and whether completed explanations remain available.
- The route's server-rendered output is a neutral shell. The authenticated
  browser walkthrough used an isolated local Worker/D1 database, synthetic
  sessions and content, and a separate Edge profile for the second session.
  No provider sign-in or session-issuance endpoint was added.

## Files changed

- API and security: `apps/api/src/index.ts`,
  `apps/api/src/protected-content.ts`,
  `apps/api/src/learner-practice.ts`,
  `apps/api/src/security/http-session.ts`,
  `apps/api/src/security/practice.ts`.
- Worker/D1 tests and isolated factories:
  `apps/api/test/factories.ts`,
  `apps/api/test/learner-practice.test.ts`,
  `apps/api/test/schema.test.ts`.
- Database and shared contracts: `db/migrations/0005_learner_practice.sql`,
  `packages/contracts/src/index.ts`,
  `packages/contracts/src/practice.ts`.
- Web experience and route:
  `apps/web/app/app.css`,
  `apps/web/app/routes.ts`,
  `apps/web/app/components/learner-practice.tsx`,
  `apps/web/app/components/learner-practice.test.tsx`,
  `apps/web/app/lib/learner-practice-api.ts`,
  `apps/web/app/routes/learner-practice.tsx`,
  `apps/web/package.json`.
- Contracts and developer guidance: `README.md`, `docs/build-plan.md`,
  `docs/save-resume.md`, `docs/learner-practice-api.md`.

No dependency was added for this milestone.

## Verification

| Check | Result |
|---|---|
| `npm run verify` | Passed on Windows: workspace type checks, tests, and production builds. API tests: 64 passed across 9 files; web tests: 42 passed. |
| Worker/D1 practice integration | Passed with the actual Hono/Worker boundary and isolated D1: authorization and scope denial, exact revision snapshots, hidden answers, start/answer/resume, idempotent retries, stale writes, expiry/revocation, atomicity, and concurrent save/resume cases. |
| Learner UI tests | Passed: neutral initial shell, access/session errors, server-acknowledged save state, failed-save recovery with the same request, result review and locked completion, Save & exit, and navigation/reload warnings while work is pending. |
| Authenticated Worker/D1 browser walkthrough | Passed using two isolated synthetic active sessions for the same learner. In the first browser, started a two-question attempt, submitted option A on question 1, and used Save & exit. In a separate Edge profile, resumed the same attempt. The API summary and detail both reported the same attempt, version 2, position 1, and one saved answer (option A); the UI restored question 2 of 2. |
| Authenticated responsive browser check | Passed on the resumed attempt at mobile 390×844 and desktop 1280×900. The question and controls were present at both sizes; measured document width did not exceed the viewport. |
| `git diff --check` | Passed after handoff authoring; staged diff will be checked again before commit. |
| Ubuntu GitHub Actions | Passed for source correction SHA `63724f9d1343ccee74661e2087df591f48008797` in [run 43050428898](https://github.com/Pdey2022/certpath/actions/runs/43050428898). Any subsequent handoff-only commit is separately verified; its exact SHA and run are reported with the PR. |

No credentials, personal data or real question banks were added.

## Limitations and unresolved decisions

- Provider-backed authentication, session issuance and grant issuance are not
  implemented; live sessions cannot be obtained through an application
  endpoint.
- Active-attempt and completed-result behavior after grant expiry needs product
  approval as described above.
- Browser verification uses only local Worker configuration and synthetic
  fixtures. Production identity-provider sign-in and live session issuance
  remain out of scope.
- Only untimed single-choice practice is implemented. Timed exams, adaptive
  selection, notes, bookmarks, learner reports, grant-management UI and
  production provisioning remain out of scope.

## Architect inspection and run steps

1. Review the [build plan](../build-plan.md), [save/resume contract](../save-resume.md)
   and [learner practice API contract](../learner-practice-api.md).
2. Inspect snapshot schema and integrity rules in
   `db/migrations/0005_learner_practice.sql`, authorization and attempt logic in
   `apps/api/src/security/practice.ts`, and HTTP enforcement in
   `apps/api/src/learner-practice.ts`.
3. Inspect the distinct protected route at
   `apps/web/app/routes/learner-practice.tsx` and UI state handling in
   `apps/web/app/components/learner-practice.tsx`. `/app/practice` remains a
   synthetic browser-storage prototype.
4. Run `npm ci`, then `npm run verify`. Worker/D1 tests seed synthetic
   identities, sessions, grants and content in isolated fixtures; no session
   or grant issuance endpoint is exposed.
5. No merge, deployment or next milestone is part of this review.
