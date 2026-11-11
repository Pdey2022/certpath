# Milestone 3B review handoff

## Scope delivered

Implemented CertPath Standard timed mocks as a separate learner route at
`/app/mock/live`. The server owns a versioned, reviewable 15-minute/10-question
profile. Starting a mock snapshots ten currently published sealed revisions,
their content, correct keys, explanations, and order. The server sets and
enforces the deadline; the learner can save answers, navigate, save and exit,
resume, submit, and view a locked result. The UI labels this as CertPath
practice and not an official certification exam.

## Architecture decisions

- Reused the opaque session cookie, server-side session validation, and exact
  certification Standard-grant checks from learner practice. No identity,
  grant, timer, score, or answer-key authority is accepted from the client.
- Added a server-owned profile for each exam version, initially 900 seconds
  and 10 questions. The service validates profile bounds before starting.
- Kept timed-mock tables and integrity triggers in migration
  `0006_timed_mocks.sql`. D1 stores immutable question snapshots and
  append-only, versioned answer/navigation commands. The server scores from
  acknowledged answers, and active responses omit correct keys and
  explanations.
- A request ID and expected attempt version make answer and navigation retries
  safe and reject stale writes. Submission and timeout finalization persist one
  immutable result. An authorized read after expiry performs timeout
  finalization.
- Randomly selects the profile's question count first, then assigns contiguous
  attempt positions. A Worker/D1 regression test supplies more questions than
  the profile requires and verifies positions `0` through `9`.
- Kept the timed-mock screen separate from the synthetic demo and untimed
  practice. No production sign-in, session issuance, grant-management UI,
  payments, adaptive exams, or deployment was added. No runtime dependency was
  added; the web test command now includes the timed-mock component tests.

## Files changed

- Worker/API: `apps/api/src/learner-practice.ts`,
  `apps/api/src/security/practice.ts`, and new
  `apps/api/src/security/timed-mocks.ts`.
- Database and shared contracts: new `db/migrations/0006_timed_mocks.sql` and
  updates to `packages/contracts/src/practice.ts`.
- Web: new `apps/web/app/components/learner-timed-mock.tsx`,
  `apps/web/app/components/learner-timed-mock.test.tsx`, and
  `apps/web/app/routes/learner-timed-mock.tsx`; updates to
  `apps/web/app/lib/learner-practice-api.ts`,
  `apps/web/app/routes.ts`, `apps/web/app/routes/learner-practice.tsx`,
  `apps/web/app/app.css`, and `apps/web/package.json`.
- Contracts and handoff: new `docs/timed-mock-api.md`; updates to
  `docs/build-plan.md` and `docs/save-resume.md`; this review file.
- Worker/D1 coverage was added to `apps/api/test/learner-practice.test.ts`.

## Verification results

- `npm run verify` — passed on Windows. API TypeScript checks passed; 9 API
  test files passed (68 tests); the API health test passed; all 45 web tests
  passed; client and server production builds passed.
- `npm run test --workspace @certpath/api` — passed (9 test files, 68 tests,
  plus the API health test).
- `git diff --check` — passed.
- The Worker/D1 tests cover fixed profile enforcement, immutable snapshots,
  hidden active answer keys, cross-user and cross-exam denial, session and
  grant expiry, stale and duplicate writes, deadline-boundary rejection,
  submit/timeout finalization, and insufficient published-question counts.

## Authenticated browser walkthrough

Used local Worker/D1 state with synthetic published questions, two independently
seeded opaque sessions, and isolated local origins so each browser context had
its own session cookie. No test-session endpoint or repository credentials
were added.

1. Started a mock, selected an answer, opened the unsaved-work leave warning,
   chose to stay, and confirmed the selection remained.
2. Saved the answer, used **Save & exit** after acknowledgement, then resumed
   the same attempt from the second authenticated browser context. The saved
   answer and running server deadline were restored.
3. Checked the authenticated layout at mobile and desktop widths; the document
   did not exceed the viewport.
4. Advanced only the isolated local attempt to its deadline, restoring the
   temporary D1 integrity trigger afterward. Both sessions received the same
   server-finalized timeout result (0/10), including the result review, and the
   first session's result screen was opened and verified.

## Limitations and unresolved decisions

- Standard-grant expiry continues to block reads and writes for an attempt,
  including a completed result, until access is restored. The product owner
  must decide whether an active mock continues, receives a grace period, or
  stops at grant expiry, and how completed explanations remain available.
  Timer expiry remains a separate server-enforced event.
- Provider-backed sign-in and live session issuance are not implemented.
  Browser verification used isolated synthetic test sessions only.
- Local test profiles are initialized to the approved 15-minute/10-question
  practice format. Production profile administration and deployment are out
  of scope.

## Architect inspection and run steps

1. Run `npm ci`.
2. Apply the local schema with `npm run db:migrate:local`.
3. Run `npm run verify`.
4. Start the web app with `npm run dev` and inspect `/app/mock/live`. An
   authorized session and active Standard grant for the exact exam are required
   to use the protected screen; normal sign-in is not part of this milestone.
5. Inspect the API contract in `docs/timed-mock-api.md`, D1 integrity rules in
   `db/migrations/0006_timed_mocks.sql`, authorization and persistence in
   `apps/api/src/security/timed-mocks.ts`, and Worker/D1 regression cases in
   `apps/api/test/learner-practice.test.ts`.
