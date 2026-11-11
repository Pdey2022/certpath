# Milestone 2F review handoff

## Status and scope

Adds a separate protected staff question editor at `/admin/question-editor`.
The existing `/admin/*` experience remains a labelled synthetic preview; its
query-string role selector, fixtures and browser state are not used by the
real editor. The editor begins with a neutral shell and loads authorized data
after hydration through same-origin `/api/admin/content` requests.

This slice includes scoped read APIs, draft creation, exact revision loading
and immutable corrections. It does not add provider-backed login or session
issuance, review/publication controls, import/export UI, learner routes,
deployment, or real question content.

## Architecture and security decisions

- The editor has no server loader that fetches protected content. Its initial
  server HTML is a role-neutral shell; browser requests include the existing
  same-origin session cookie and are validated by the Worker on every request.
  Missing/expired sessions, insufficient staff/MFA, unavailable security
  configuration and missing assignments have distinct user-facing messages.
- Added only the reads required by the editor: authorized certification list,
  scoped exam versions/domains/topics, taxonomy-scoped question search and
  bounded question revision history. Pages are capped at 50 (25 by default).
  Every content-list query uses a primary D1 scope predicate covering active
  session, active user, current role, MFA freshness/method and current Manager
  assignment. The editor cannot supply a role, identity, assignment, clock or
  token digest.
- Certification enumeration is similarly filtered in the same SQL query:
  Global Admin sees all roots; Manager sees only currently assigned roots.
  Other taxonomy/question reads recheck certification authorization and also
  include the same guard in their D1 selection. The existing exact-revision
  and mutation services remain authoritative.
- Search is restricted to the selected certification/version/domain/topic,
  escaped for SQL `LIKE`, and bounded to 100 input characters. Stem previews
  are limited to 200 characters. No unscoped collection endpoint was added.
- Mutations validate with the shared strict schemas and fetch the session-
  bound CSRF token from `/csrf`; the browser sends it with same-origin
  credentials. The API performs current session/MFA/scope checks and creates
  a sealed revision. The editor never writes browser-supplied authority.
- A stale correction leaves the form values intact. The UI offers an explicit
  latest-revision load and displays its stem; only after the user chooses
  “Use latest revision as base and keep my edits” does it update the expected
  lock version. Validation and network errors likewise do not clear fields.
- The exact synthetic admin preview stays unchanged and remains separately
  labelled. Test identities, sessions and synthetic content exist only in the
  isolated Worker/D1 test harness. No provider, production session, secret,
  or question-bank fixture was added.
- Protected route HTML sets private/no-store and noindex headers and metadata;
  list and detail API responses inherit the protected API's private/no-store
  and noindex headers.

## Files changed

- `apps/api/src/protected-content.ts`
- `apps/api/src/security/content-queries.ts`
- `apps/api/src/security/repository.ts`
- `apps/api/test/protected-content.test.ts`
- `apps/web/app/routes.ts`
- `apps/web/app/routes/admin-question-editor.tsx`
- `apps/web/app/routes/admin-question-editor.test.tsx`
- `apps/web/app/lib/admin-question-editor-api.ts`
- `apps/web/app/app.css`
- `apps/web/package.json`
- `packages/contracts/src/protected-content.ts`
- `docs/build-plan.md`
- `docs/protected-content-api.md`
- `docs/reviews/milestone-2f.md`

## Verification

| Command | Result |
|---|---|
| `Set-Location apps\api; npx vitest run --config vitest.config.ts test/protected-content.test.ts` | Passed: 13 protected HTTP tests, including the Worker/D1 editor workflow, assignment isolation, paging, session expiry, stale edit and CSRF rejection. |
| `Set-Location apps\web; npx tsx --test app/routes/admin-question-editor.test.tsx` | Passed: 2 component tests for the neutral/missing-session shell and stale-edit retention/retry. |
| `npm run verify` | Passed: API health test; 55 API tests across 8 files; 15 web tests; typechecks; client and SSR builds. |
| Browser responsive check | Passed on the rendered neutral editor shell at 390x844 and 1440x900; document width matched viewport at both sizes (no horizontal overflow). |
| Ubuntu GitHub Actions | Pending on the final PR head. |

The Worker/D1 integration test uses isolated test factories to establish an
assigned Manager session, creates taxonomy and a question through HTTP,
selects scoped list and exact-revision reads, corrects the question, confirms
the prior revision content is unchanged, and verifies an unassigned Manager
cannot discover or edit the certification's question. It also checks
pagination, expired-session rejection, stale-write conflict, CSRF rejection
and private response headers.

## Limitations

- There is no provider-backed sign-in, session issuance or recovery. A visitor
  without an independently provisioned valid session sees the missing-session
  message; this editor does not provide a test-session or role-switch route.
- Production MFA freshness/method values and CSRF secret remain explicitly
  configured as required by the API contract. Missing security configuration
  fails closed.
- The editor handles question drafts and corrections only. Review, publication,
  taxonomy creation, import/export, cross-certification copy and other admin
  workflows remain out of scope.
- The current question list is paginated, with key/stem search inside the
  selected topic. It does not provide an unscoped bank search.

## Architect inspection and run steps

1. Review the scoped read and response contract in
   [protected-content-api.md](../protected-content-api.md), especially its
   list routes and page limits.
2. Inspect the D1 query guards in
   `apps/api/src/security/content-queries.ts` and the read/mutation routes in
   `apps/api/src/protected-content.ts`.
3. Inspect the separate route at
   `apps/web/app/routes/admin-question-editor.tsx` and confirm its first
   render contains only the neutral shell. Compare it with the unchanged
   synthetic `/admin/*` page.
4. Run `npm ci --include=optional` and `npm run verify` from the repository
   root. The Worker/D1 integration tests use synthetic sessions and isolated
   local D1 state.
5. To inspect the editor shell locally, run `npm run dev --workspace
   @certpath/web`; opening `/admin/question-editor` without a valid session
   should show a clear unauthenticated or fail-closed configuration message.
   The test-only identity/session factories must not be used by runtime code.
6. Confirm Ubuntu CI is green on the exact final PR head before approval.
   Do not merge, deploy, connect provider sign-in or begin another milestone
   as part of this review.
