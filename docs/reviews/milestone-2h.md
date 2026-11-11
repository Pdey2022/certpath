# Milestone 2H review handoff

## Status and scope

Connects the existing protected question-bank CSV preview, draft-only
confirmation, and published-content export services to the real protected
staff workspace. The synthetic `/admin` prototype remains separate. No
provider-backed sign-in, session issuance, learner features, public content
routes, deployment, or new API endpoints were added.

## Architecture and security decisions

- Added the import/export panel to `/admin/question-editor`, which is already
  separated from the synthetic admin preview and rendered only after the
  protected workspace resolves its staff session and authorized certification
  list. Certification and exam version come from the existing authorized
  selectors. The panel remains mounted across scope changes so an unresolved
  confirmation cannot be discarded by selecting another exam version.
- Reused the existing bounded CSV preview, confirmation, export, domain/topic
  reads, same-origin API client, CSRF endpoint, session cookie, MFA policy and
  certification authorization. No new dependency was needed.
- The template uses the exact v1 ordered header, CSV quoting, all eight option
  groups and empty trailing option cells. A downloaded synthetic example uses
  the selected exam version and the first available domain/topic. If taxonomy
  is absent, the download contains the exact header only. The sample key and
  content are explicitly marked synthetic and must be replaced.
- The browser enforces the existing 256 KiB file cap before upload; the Worker
  still enforces the authoritative streaming cap and the 10-row contract.
  Preview responses show parsed/valid/invalid counts, row/column error
  guidance, and expiry. Invalid header errors now count all parsed rows as
  invalid, and unknown header values are not reflected in the API response.
- Extended the existing invalid-preview error shape with safe summary counts
  so the UI can report counts for invalid files without reparsing CSV or
  duplicating the server validation rules. Error responses include only safe
  issue codes and paths, never CSV rows or question content.
- Confirmation sends only the server-issued preview ID. While it is in flight
  or its outcome is unknown, the panel retains the original preview ID,
  certification/exam IDs and labels, expiry and filename independently from
  the current file/preview state. File replacement and new previews are
  disabled; changing scope clears only that scope's transient file, preview
  and export cursor. A lost or unavailable response offers retry against the
  original certification and preview ID; server idempotency returns the
  established outcome. Expired/conflicting previews are cleared and require a
  fresh preview. Confirmation results explicitly describe sealed drafts and
  do not imply publication.
- Export requests one existing cursor page at a time (up to 100 published
  questions), downloads each page with certification, exam version and page in
  the filename, and disables further downloads when no cursor remains. CSV
  text is held only transiently for download; it is not logged or written to
  browser storage. The UI labels output as a spreadsheet-safe report that is
  not directly re-importable.
- Kept private/no-store and noindex behavior on the protected API; public SEO
  and the synthetic prototype were not changed. The import/export contract
  and API contract now describe the protected staff UI and validation summary.

## Files changed

- `apps/api/src/protected-content.ts`
- `apps/api/src/security/question-imports.ts`
- `apps/api/test/protected-content.test.ts`
- `apps/web/app/app.css`
- `apps/web/app/components/protected-csv-tools.tsx`
- `apps/web/app/components/protected-csv-tools.test.tsx`
- `apps/web/app/lib/admin-question-editor-api.ts`
- `apps/web/app/routes/admin-question-editor.tsx`
- `apps/web/package.json`
- `docs/build-plan.md`
- `docs/protected-content-api.md`
- `docs/question-bank-import-export.md`
- `docs/reviews/milestone-2h.md`
- `packages/contracts/src/protected-content.ts`

## Verification

| Check | Result |
|---|---|
| `npm run verify` | Passed on Windows: all workspace typechecks; API health test; 56 API tests across 8 files; 36 web tests; production client and Worker/SSR builds. |
| Protected Worker/D1 regression | Passed within the API suite using isolated synthetic sessions and content. Covers import preview/confirmation idempotency, expiry, authorization/scope denial, export pagination, safe invalid-preview counts, and that unknown CSV header text and question bodies are not reflected. |
| Import/export UI regressions | Passed: invalid-row counts and guidance, file-change clearing, delayed confirmation with a committed batch and lost response, blocked file replacement/new preview, exam-scope switching, same-ID/original-scope recovery with one batch, expiry recovery, permission denial messaging, stale response after exam change, two-page cursor download, exact v1 template with current taxonomy, and pre-upload oversized-file rejection. |
| Authenticated browser workflow | Passed in headless Chrome 156 against an isolated HTTPS local Worker and D1 fixture. A synthetic Global Admin session created the exam taxonomy and a published synthetic question through protected APIs. In the actual workspace, the v1 CSV preview validated one row, confirmation created one sealed draft, and published page 1 downloaded. No test-session endpoint or provider-backed login was added. |
| Responsive authenticated browser inspection | Passed with the authenticated workspace at desktop 1280×900 and mobile 390×844. Desktop showed the import/export controls in a two-column grid (document width 1265 CSS px including the scrollbar, with no horizontal overflow); mobile showed a single-column grid at 390 CSS px with no horizontal overflow. Both views retained the selected scope and confirmed draft result. The isolated D1 fixture, temporary session, HTTPS certificate and browser profile were removed after inspection. |
| `git diff --check` | Passed. |
| Ubuntu GitHub Actions | Passed for the initial implementation `2ff31f8067f94514069f0c88bd8f750e86423d90` ([run](https://github.com/Pdey2022/certpath/actions/runs/43030529753)), the pre-correction handoff `ebe85a9a67a41806718ac103f178099f77bd13b0` ([run](https://github.com/Pdey2022/certpath/actions/runs/43030790305)), and recovery correction `9d4e4db421d76cae0f843c84f7b9f60dbf4c52ed` ([run](https://github.com/Pdey2022/certpath/actions/runs/43034559364)), all on PR #10. The final handoff-recording commit is checked separately. |

No secrets, real question banks, personal data or test-session tokens were
added.

## Limitations

- Provider-backed sign-in and live session issuance remain unimplemented.
  The authenticated browser verification used only a temporary synthetic
  session, explicit local MFA/CSRF configuration and isolated local D1 state;
  it does not demonstrate provider-backed authentication or production policy.
- The template can include a synthetic data row only when the selected version
  has an available domain and topic; otherwise it safely provides the exact
  header and explains the taxonomy prerequisite.
- The UI does not add taxonomy authoring, import correction/overwrite,
  publication controls, learner data, production configuration or deployment.
- The export is intentionally a bounded spreadsheet-safe report, not a
  directly re-importable question-bank file.

## Architect inspection and run steps

1. Review the [build plan](../build-plan.md), [question-bank import/export
   contract](../question-bank-import-export.md), and [protected content API
   contract](../protected-content-api.md).
2. Inspect the panel and its transient-state handling in
   `apps/web/app/components/protected-csv-tools.tsx`, its API client methods in
   `apps/web/app/lib/admin-question-editor-api.ts`, and its insertion in the
   protected workspace route.
3. Run `npm ci`, then `npm run verify`. The Worker/D1 tests use isolated
   synthetic staff sessions; the UI component tests use synthetic protected
   API responses and do not create or issue sessions.
4. To inspect the live staff screen, configure the local Worker security
   settings and use an independently provisioned authorized staff session.
   The route must show a neutral shell when session/security checks fail; the
   `/admin` prototype role selector does not grant access.
5. No deployment, merge or next milestone is part of this review.
