# Milestone 1 review handoff

Status: ready for architect review. Scope is limited to the local interactive
prototype. No production service, payment, authentication, deployment, or later
milestone was started.

## Implemented

- Responsive learner home, exam workspaces, exam-specific Standard and Pro
  access examples, practice hub, mock and Pro preparation previews, progress,
  account/access, and device-management previews.
- CISSP and CISM examples demonstrate independent Standard and Pro dates.
  Pro is presented as a three-calendar-month add-on with same-exam Standard
  coverage required. Eligible, insufficient-coverage, active, and expired
  states use synthetic dates; no prices or purchase flow are present.
- Three original illustrative questions, labelled as sample content, with
  answer selection/submission, explanations, bookmarks, results, and resume.
  Saving, Saved, failure/retry, and Save & exit are demonstrated through a
  replaceable adapter. Failed saves retain the changed session state, offer
  retry and stay actions, warn before internal or browser navigation, and
  explain the consequence before an explicit leave-without-saving action. The
  local adapter stores only the demo practice session in this browser and
  explicitly disclaims server acknowledgement and sync.
- Submitting the last question retains its explanation and offers an explicit
  View results action. Results provide read-only review of every answered
  sample question.
- Development-only save-failure simulation and role preview controls are
  guarded by `import.meta.env.DEV`. A labelled `/app/prototype/reset` route
  contains the development-only reset action, which clears only the practice
  demo key from this browser.
- Static mock and Pro instruction/preparation previews; no production timer,
  adaptive engine, or readiness prediction.
- First-seen and repeated-question sample performance are separate. Synthetic
  domain progress, loading/empty/error/expired examples, and access/device
  management previews are labelled as demonstrations.
- Global Admin and assigned-certification Manager presentation previews,
  including content/module management, question editing and validation,
  import preview, revision history, and role-specific navigation. The role
  selector is a demo display control, not authentication or authorization.
  The Manager permission-denied recovery link preserves `?demoRole=manager`;
  other Manager navigation links retain the preview selection.
- Public `/exams` contains synthetic catalogue entries only. Private routes
  remain noindex and `private, no-store`; public React Router/Cloudflare SSR,
  the approved framework, and disabled local indexing are unchanged.

## Architecture decisions

- Retained React Router framework mode with Cloudflare Worker SSR, the
  same-origin Hono API, and local D1 binding from Milestone 0. No runtime or
  deployment dependencies were added.
- Kept synthetic state in typed local fixtures and a replaceable practice-state
  adapter rather than adding production persistence. The browser adapter uses
  one versioned localStorage key and communicates that it is browser-only.
- Kept exam and role previews in the existing learner/admin routes rather than
  introducing a new permission or billing model. These controls demonstrate
  views only and cannot authorize access or mutate production records.
- Used fixed synthetic dates and a UTC calendar-month helper to demonstrate
  three-month Pro eligibility, including month-end clamping. This is not a
  server clock or entitlement implementation.
- Extracted practice screen transitions and presentation into a small flow
  model so the final-explanation, explicit-results, read-only review, and
  stay-after-failed-save outcomes have focused regression tests. Added
  `@testing-library/react` and `happy-dom` as dev-only dependencies to exercise
  the actual React component interactions in the existing Node test workflow;
  neither is shipped to the app runtime.

## Files changed

- `README.md`
- `apps/web/app/app.css`
- `apps/web/app/routes/admin.tsx`
- `apps/web/app/routes/exams.tsx`
- `apps/web/app/routes/learner.tsx`
- `apps/web/app/components/practice-demo.tsx`
- `apps/web/app/components/practice-demo.test.tsx`
- `apps/web/app/lib/practice-flow.ts`
- `apps/web/app/lib/practice-flow.test.ts`
- `apps/web/app/lib/prototype-data.ts`
- `apps/web/app/lib/prototype-data.test.ts`
- `apps/web/package.json`
- `package-lock.json`
- `docs/reviews/milestone-1.md`
- Screenshots:
  - [Learner — desktop](./assets/milestone-1-learner-desktop.png)
  - [Learner — mobile](./assets/milestone-1-learner-mobile.png)
  - [Admin — desktop](./assets/milestone-1-admin-desktop.png)
  - [Admin — mobile](./assets/milestone-1-admin-mobile.png)

## Verification

Environment: Windows, Node.js 24.18.0, npm 11.16.0.

| Command/check | Actual result |
|---|---|
| `npm ci --include=optional --no-audit --no-fund` | Passed on Windows from the updated lockfile; installed 147 packages. Local npm policy warned that install scripts for `workerd` and `esbuild` were not approved. |
| `npm run verify` | Passed on Windows: all workspace type checks, 1 API test, 13 web tests (including three React component-interaction tests), and client/Cloudflare Worker SSR production builds. |
| `git diff --check` | Passed with no whitespace errors. |
| Browser layout checks on `/app` and `/admin` at 320, 390, 768, 1024, and 1440 CSS px | No horizontal document overflow at any tested width. |
| Browser text resize to 200% at 320 CSS px on `/app` and `/admin` | Initial check found overflow in narrow learner content. After adjusting text wrapping and clipping contained horizontal overflow, both routes reported document width 320px for a 320px viewport. |
| Keyboard focus check | First Tab reaches “Skip to workspace”; its visible outline is solid and 2.86px wide. |
| Failed-save recovery in browser and component test | Verified: simulated/browser-storage save failure leaves the selected answer in the active session, “Stay in practice” retains the route and answer, internal navigation opens a consequence warning, retry saves the answer to this browser, and Save & exit navigates after a successful retry. Explicit “Leave without saving” displayed the discard warning and navigated while leaving browser storage unchanged. A component-interaction regression test covers failure, stay, navigation block, retry, and exit. |
| Final explanation/results in browser and component test | Verified all three sample questions: final submission kept its explanation visible and exposed “View results”; results listed all answered questions; selecting a review opened the saved answer/explanation with the answer fieldset disabled and no submit action; Back to results returned to the summary. A component-interaction regression test covers explicit results and read-only review. |
| Prototype controls and Manager preview in browser and component tests | Verified reset on `/app/prototype/reset` clears the demo session; development-only save simulation is visible in the local dev build. Manager permission denial links to `/admin/questions?demoRole=manager`; following it retains the Manager heading and query. Existing Manager navigation links retain the role query. A focused component-interaction test covers the recovery link and subsequent Manager navigation. |
| Production-bundle control check | Passed after `npm run build`: client JavaScript contains none of “Simulate next save failure”, “Preview role selector”, or “Reset demo practice data”. |
| Learner/admin practice and role previews | Previously checked in-browser: practice selection, submission, explanations, bookmarks, save status, refresh restoration; Manager navigation scope and presentation-only denial; editor validation and import preview. |
| SSR and private-route checks | Previously checked against the local Worker: public `/` and `/exams` return rendered page content; `/app/*` and `/admin/*` return HTTP 200 with `X-Robots-Tag: noindex, nofollow` and `Cache-Control: private, no-store`. |
| Screenshot files | Four checked-in screenshots; learner/admin desktop are 1440×1000 and learner/admin mobile are 390×844. |
| Ubuntu GitHub Actions | Passed on correction commit `a4f73911e51c6e7b9a504a740e50d2a3f62ae022` with clean `npm ci --include=optional` and `npm run verify` in [workflow run 42854019552](https://github.com/Pdey2022/certpath/actions/runs/42854019552). The push did not produce a pull-request check context, so the existing CI workflow was manually dispatched against the feature branch; no workflow checks were skipped or changed. |

The behavior checks above are prototype-level browser checks, not production
security or persistence tests. Browser persistence is isolated to
`certpath-demo-practice-v1`; refresh restores only that supported practice
demo state. Reset removes only that key via the development-only prototype
reset route. The reset action is not available in production builds.

## Known limitations and unresolved decisions

- No authentication, production permissions, real database mutations,
  customer/staff records, production persistence, payment processing, analytics
  transmission, or deployment is implemented.
- localStorage can be unavailable or cleared and is device/browser-local. It
  does not provide server acknowledgement, cross-device continuity, conflict
  handling, or secure storage.
- Sample questions and statistics are original illustrative synthetic data;
  they are not an official exam bank, readiness estimate, or validated result.
- Mock/Pro timing and preparation are static previews. There is no production
  timer, adaptive selection, readiness prediction, or exam engine.
- Demo dates, access states, role selection, admin changes, and import/revision
  previews are not live entitlements, authorization, or durable content edits.
- Manager query parameters preserve presentation state only; they do not
  authorize a Manager or enforce certification assignments.
- Browser confirmation for closing or leaving the page depends on the browser's
  native before-unload prompt. Client-side route navigation has an explicit
  in-app warning and a clearly labelled leave-without-saving action.

## Architect inspection and run steps

1. Check out `feat/milestone-1-prototype` and review this document, the four
   screenshots, the implementation files above, and the unchanged architecture
   and product contracts.
2. From the repository root, run `npm ci --include=optional`,
   `npm run db:migrate:local`, and `npm run dev`. Open the URL Wrangler prints
   (normally `http://localhost:5173`).
3. Inspect `/`, `/exams`, `/app`, `/app/exams/cissp`,
    `/app/exams/cism`, `/app/practice/session`, `/app/progress`,
    `/app/account`, `/app/prototype/reset`, and `/admin`. The learner/admin
    routes are previews; do not enter real data.
4. On the practice session, select and submit each sample answer. Confirm the
    final explanation remains visible, choose View results, then use each
    read-only review action. Test the development-only failed-save control,
    Stay in practice, warning on internal navigation, retry, and Save & exit.
    Visit `/app/prototype/reset` to clear only the browser demo session.
5. In Admin, switch the explicitly labelled preview role, inspect the module
   and question editor, validation, import, and revision history. These are
   display-only demo interactions, not permission enforcement or persisted
   mutations.
6. Run `npm run verify`. Review the latest draft PR's Ubuntu Actions result
   before approval. Do not merge or deploy this branch as part of Milestone 1
   review.
