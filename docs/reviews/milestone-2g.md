# Milestone 2G review handoff

## Status and scope

Connects exact-revision submission, review, publication/replacement and
retirement to the protected staff question editor. The existing synthetic
admin preview remains separate. This slice does not add provider-backed
sign-in, session issuance, import/export UI, learner features or deployment.

## Architecture and security decisions

- Added one bounded read:
  `GET /api/admin/content/certifications/:certificationId/exam-versions/:examVersionId/questions/:questionId/publication`.
  It returns the current publication state, revision and pointer version (or
  `null`), and its D1 query enforces current session, MFA, staff role and
  certification assignment while selecting the exact question and exam
  version. The UI uses this server pointer version for optimistic writes.
- Reused the existing submit, review, publish and retire services, shared
  request schemas, same-origin API client and session-bound CSRF protection.
  Review and publication remain separate audited actions; reviewer and
  publisher identities are independently recorded. The proposed launch policy
  does not impose a second-person requirement.
- Actions are derived from the exact selected revision and publication state.
  Publishing a replacement and retiring a publication require explicit
  confirmation. Retirement explains that future selection stops while
  revision and publication history remain intact.
- A conflict preserves question fields and review notes. The UI refreshes the
  affected revision or pointer and requires a deliberate retry; it never
  retries a stale transition automatically. Request identity checks prevent
  late responses from changing another selected question.
- After successful publication, replacement or retirement, the editor reuses
  the guarded workflow refresh to reload the exact selected revision, bounded
  revision history, publication pointer and the affected question summary.
  The summary uses an optional exact `questionId` filter on the existing
  bounded, scope-guarded question list rather than an unbounded search. The
  response is applied only if the question, revision, scope and request
  identity still match; refreshes do not replace form fields or review notes.
- If the mutation succeeds but any part of that refresh fails, the UI states
  that the change was saved and offers a separate “Refresh saved workflow
  state” action. Workflow mutations stay disabled until recovery succeeds, so
  this action cannot accidentally resubmit the successful mutation.
- No dependencies or provider configuration were added. The existing neutral
  server-rendered shell, private/no-store responses and non-indexing controls
  remain in place.

## Files changed

- `apps/api/src/protected-content.ts`
- `apps/api/src/security/content-queries.ts`
- `apps/api/test/protected-content.test.ts`
- `apps/web/app/app.css`
- `apps/web/app/lib/admin-question-editor-api.ts`
- `apps/web/app/routes/admin-question-editor.tsx`
- `apps/web/app/routes/admin-question-editor.test.tsx`
- `packages/contracts/src/protected-content.ts`
- `docs/build-plan.md`
- `docs/protected-content-api.md`
- `docs/reviews/milestone-2g.md`

## Verification

| Check | Result |
|---|---|
| `npm run verify` | Passed: typechecks; API health test; 56 API tests across 8 files; 26 web tests; client and SSR production builds. |
| Worker/D1 review-publication regression | Passed within the API suite: assigned Manager rejection/correction, exact-revision approval, publication/replacement/retirement and assertions that D1 reports the exact revision as `published`, the replaced revision as `superseded`, and the retired revision as `retired`; also covers the exact question-summary filter, stale pointer conflict, history preservation, exact status read and unassigned Manager denial. |
| Editor workflow and race tests | Passed within the web suite: after publish/replacement/retirement, exact revision, revision history, pointer and affected question summary reflect the D1 event states. A successful retirement followed by a failed refresh preserves unsaved fields and review notes, offers refresh-only recovery, and does not resubmit. A late publication refresh is discarded after selection changes. |
| Authenticated browser layout | Passed using an assigned synthetic Manager session and synthetic content in an isolated local Worker/D1 fixture. At 1280×900, review notes and enabled approval/rejection actions were visible. At 390×844, the published revision and retirement action were visible, with no horizontal overflow. Retirement confirmation appeared and was canceled; no browser action changed fixture content. |
| Ubuntu GitHub Actions | The original Milestone 2G implementation passed on `d6a8790a90f2a2dfd92965a29ea54ea867dcf3b4`: [CI run](https://github.com/Pdey2022/certpath/actions/runs/43024110701). The refresh correction passed on `8daa962b337fc13e0f0d980ebe4e31427d6173e0`: [CI run](https://github.com/Pdey2022/certpath/actions/runs/43026573376). The handoff-only final commit is being checked separately. |

The browser check used an explicitly configured local MFA policy and a
temporary localhost certificate. Both the certificate trust entry and
isolated D1 fixture were removed after verification. No test session token,
secret or fixture content is committed.

## Limitations

- Provider-backed sign-in, session issuance, recovery and production MFA/CSRF
  configuration remain separate work. The editor does not issue or switch
  roles or sessions.
- Import/export screens, taxonomy authoring, cross-certification copy,
  learner persistence, payments, adaptive practice and deployment remain out
  of scope.
- Staff may review and publish their own revisions under the existing
  proposed launch policy; no mandatory second reviewer was added.

## Architect inspection and run steps

1. Review the endpoint table and security requirements in
   [protected-content-api.md](../protected-content-api.md), and the completed
   slice in [build-plan.md](../build-plan.md).
2. Inspect the guarded publication query and Worker route in
   `apps/api/src/security/content-queries.ts` and
   `apps/api/src/protected-content.ts`.
3. Inspect the editor workflow and conflict handling in
   `apps/web/app/routes/admin-question-editor.tsx`; run the Worker/D1 and
   interaction regressions with `npm run verify`.
4. Open `/admin/question-editor` with an independently provisioned authorized
   staff session to inspect the protected flow. The `/admin` synthetic
   preview's role selector does not grant access.
5. No deployment or production session setup is part of this review.
