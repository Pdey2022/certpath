# Milestone 3C review handoff

## Scope delivered

Added the protected `/app/home` learner dashboard. It groups summaries by
certification and exam version for which the current learner has active
Standard access. In-progress practice and timed mocks appear before recent
completed attempts. Each card links to the existing protected route with that
attempt's exact ID. A timed-out mock remains resumable until the existing
authorized mock read finalizes it.

The dashboard API returns acknowledged answer counts, position, score when
completed, and timed-mock deadline/reason. It does not return question text,
options, explanations, or answer keys. Query results are bounded to 20
in-progress and 20 completed attempts per type and at most 200 authorized
certification/version groups. The API response and dashboard route are
private/no-store and non-indexable.

## Architecture and access decisions

- Reused the opaque session cookie, server-side session validation, and exact
  certification Standard-grant checks. Both the authorized-scope lookup and
  attempt-summary reads check the current session, active user, and unexpired,
  unrevoked grant in D1 using server time.
- Kept attempt ownership, grant enforcement, and timeout finalization in the
  existing protected attempt endpoints. Dashboard links are navigation only;
  they do not confer access.
- The SQL selects no more than 20 records per state before combining the
  bounded result sets. Groups with no attempt history are retained while the
  learner has active access to that certification/version.
- Preserved the current conservative access behavior: an expired or revoked
  Standard grant removes that group and blocks direct attempt/result reads.
  An expired mock timer remains distinct; the existing authorized mock read
  finalizes the mock from acknowledged answers.
- No dependencies were added. Provider-backed sign-in, session issuance,
  grant-management screens, billing, adaptive exams, and deployment remain
  out of scope.

## Files changed

- `packages/contracts/src/practice.ts` — strict dashboard summary and response
  schemas.
- `apps/api/src/security/learner-dashboard.ts` — current-session/grant checks,
  bounded summary queries, grouping, and safe summary projection.
- `apps/api/src/learner-practice.ts` — protected `GET /api/practice/dashboard`.
- `apps/api/test/learner-practice.test.ts` — Worker/D1 authorization,
  privacy, acknowledgement counts, timed-out mock finalization, and expiry
  coverage.
- `apps/web/app/lib/learner-practice-api.ts` — validated dashboard API client.
- `apps/web/app/components/learner-dashboard.tsx` and
  `apps/web/app/components/learner-dashboard.test.tsx` — dashboard states,
  progress cards, exact attempt links, and UI regressions.
- `apps/web/app/routes/learner-dashboard.tsx` and
  `apps/web/app/routes.ts` — protected `/app/home` route.
- `apps/web/app/components/learner-practice.tsx` and
  `apps/web/app/components/learner-timed-mock.tsx` — load the selected
  `attemptId` from a dashboard link.
- `apps/web/app/routes/learner-practice.tsx` and
  `apps/web/app/routes/learner-timed-mock.tsx` — navigation to the dashboard.
- `apps/web/app/app.css` and `apps/web/package.json` — responsive dashboard
  styles and registered component test.
- `docs/build-plan.md` — Milestone 3C behavior, limits, and access semantics.

## Verification results

- `npm run verify` — passed on Windows: workspace type checks passed; API
  health plus 69 Worker/D1 tests passed across 9 test files; 50 web tests
  passed; client and server production builds completed.
- `npm test --workspace @certpath/api` — passed (69 tests across 9 files, plus
  the API health test).
- `npm exec --workspace @certpath/web -- tsx --test
  app/components/learner-dashboard.test.tsx` — passed (2 tests).
- `git diff --check` — passed before final verification.
- Worker/D1 tests confirm that summaries use acknowledged answer counts, omit
  question and answer content, isolate other users and certifications, exclude
  expired access, and move a timed-out mock into completed history after the
  existing protected read returns its persisted result.
- Browser responsive inspection rendered synthetic dashboard summaries at
  360 CSS px and 1425 CSS px; both had no horizontal overflow. It showed the
  acknowledged-progress count and exact timed-mock result URL. The browser
  used intercepted synthetic API data, not an authenticated Worker session.

## Known limitations and unresolved decisions

- A full authenticated browser walkthrough against local Worker/D1 could not
  be performed. Production session issuance is intentionally absent, and the
  local Worker fails closed without an exact HTTPS `PUBLIC_SITE_ORIGIN` and
  configured CSRF secret. The protected Worker/D1 boundary is covered by the
  isolated synthetic-session tests; browser viewport inspection used
  synthetic API responses. Do not treat this as provider-backed sign-in or a
  live session.
- History is deliberately bounded, not an archive: each attempt type returns
  at most 20 in-progress and 20 completed summaries across the learner's
  authorized exams. No pagination or older-history browsing is included.
- Expired Standard access continues to hide summaries and block attempt and
  result reads until access is restored. The product owner must still decide
  whether completed results or in-progress attempts should be accessible
  after grant expiry.

## Architect inspection and run steps

1. Run `npm ci`, then `npm run db:migrate:local`.
2. Run `npm run verify`.
3. Start `npm run dev` and inspect `/app/home`. The dashboard API requires an
   active application-session cookie, an active Standard grant for the exact
   certification, and local protected-API configuration. This milestone does
   not add an endpoint to issue sessions or grants.
4. Review the API query and route in
   `apps/api/src/security/learner-dashboard.ts` and
   `apps/api/src/learner-practice.ts`, the shared response schema in
   `packages/contracts/src/practice.ts`, and the Worker/D1 cases in
   `apps/api/test/learner-practice.test.ts`.
5. Inspect exact resume/result loading in
   `apps/web/app/components/learner-practice.tsx` and
   `apps/web/app/components/learner-timed-mock.tsx`; the server remains
   authoritative for ownership, active access, and timeout finalization.
