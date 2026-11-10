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
  replaceable adapter. The local adapter stores only the demo practice session
  in this browser and explicitly disclaims server acknowledgement and sync.
- A development-only demo panel exposes save-failure and reset controls.
  Reset clears only the demo practice key from browser storage.
- Static mock and Pro instruction/preparation previews; no production timer,
  adaptive engine, or readiness prediction.
- First-seen and repeated-question sample performance are separate. Synthetic
  domain progress, loading/empty/error/expired examples, and access/device
  management previews are labelled as demonstrations.
- Global Admin and assigned-certification Manager presentation previews,
  including content/module management, question editing and validation,
  import preview, revision history, and role-specific navigation. The role
  selector is a demo display control, not authentication or authorization.
- Public `/exams` contains synthetic catalogue entries only. Private routes
  remain noindex and `private, no-store`; public React Router/Cloudflare SSR,
  the approved framework, and disabled local indexing are unchanged.

## Architecture decisions

- Retained React Router framework mode with Cloudflare Worker SSR, the
  same-origin Hono API, and local D1 binding from Milestone 0. No dependencies
  or deployment components were added.
- Kept synthetic state in typed local fixtures and a replaceable practice-state
  adapter rather than adding production persistence. The browser adapter uses
  one versioned localStorage key and communicates that it is browser-only.
- Kept exam and role previews in the existing learner/admin routes rather than
  introducing a new permission or billing model. These controls demonstrate
  views only and cannot authorize access or mutate production records.
- Used fixed synthetic dates and a UTC calendar-month helper to demonstrate
  three-month Pro eligibility, including month-end clamping. This is not a
  server clock or entitlement implementation.

## Files changed

- `README.md`
- `apps/web/app/app.css`
- `apps/web/app/routes/admin.tsx`
- `apps/web/app/routes/exams.tsx`
- `apps/web/app/routes/learner.tsx`
- `apps/web/app/components/practice-demo.tsx`
- `apps/web/app/lib/prototype-data.ts`
- `apps/web/app/lib/prototype-data.test.ts`
- `apps/web/package.json`
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
| `npm run verify` | Passed after correcting a missing `Link` import found by the initial typecheck. Workspace type checks passed; 1 API test and 7 web tests passed; client and Cloudflare Worker SSR production builds passed. |
| `git diff --check` | Passed with no whitespace errors. |
| Browser layout checks on `/app` and `/admin` at 320, 390, 768, 1024, and 1440 CSS px | No horizontal document overflow at any tested width. |
| Browser text resize to 200% at 320 CSS px on `/app` and `/admin` | Initial check found overflow in narrow learner content. After adjusting text wrapping and clipping contained horizontal overflow, both routes reported document width 320px for a 320px viewport. |
| Keyboard focus check | First Tab reaches “Skip to workspace”; its visible outline is solid and 2.86px wide. |
| Learner/admin practice and role previews | Previously checked in-browser: practice selection, submission, explanations, bookmarks, save status, refresh restoration, failed save/retry, Save & exit; Manager navigation scope and presentation-only denial; editor validation and import preview. |
| SSR and private-route checks | Previously checked against the local Worker: public `/` and `/exams` return rendered page content; `/app/*` and `/admin/*` return HTTP 200 with `X-Robots-Tag: noindex, nofollow` and `Cache-Control: private, no-store`. |
| Screenshot files | Four checked-in screenshots; learner/admin desktop are 1440×1000 and learner/admin mobile are 390×844. |
| Ubuntu GitHub Actions | Passed: [CI run 42848425162](https://github.com/Pdey2022/certpath/actions/runs/42848425162) completed successfully on commit `a4ab9dda57488cf4521be06ddcd71ba6624e83af` using the existing Ubuntu workflow. |

The behavior checks above are prototype-level browser checks, not production
security or persistence tests. Browser persistence is isolated to
`certpath-demo-practice-v1`; refresh restores only that supported practice
demo state. Reset removes only that key.

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
The first draft PR revision passed both local Windows verification and the
  Ubuntu CI workflow. The documentation-only follow-up will trigger the same CI
  workflow; verify that rerun before architect approval.

## Architect inspection and run steps

1. Check out `feat/milestone-1-prototype` and review this document, the four
   screenshots, the implementation files above, and the unchanged architecture
   and product contracts.
2. From the repository root, run `npm ci --include=optional`,
   `npm run db:migrate:local`, and `npm run dev`. Open the URL Wrangler prints
   (normally `http://localhost:5173`).
3. Inspect `/`, `/exams`, `/app`, `/app/exams/cissp`,
   `/app/exams/cism`, `/app/practice/session`, `/app/progress`,
   `/app/account`, and `/admin`. The learner/admin routes are previews; do not
   enter real data.
4. On the practice session, select and submit an answer, bookmark it, use the
   development-only save-failure control and retry, refresh to inspect the
   browser-only restore, use Save & exit, and try Reset demo.
5. In Admin, switch the explicitly labelled preview role, inspect the module
   and question editor, validation, import, and revision history. These are
   display-only demo interactions, not permission enforcement or persisted
   mutations.
6. Run `npm run verify`. Review the latest draft PR's Ubuntu Actions result
   before approval. Do not merge or deploy this branch as part of Milestone 1
   review.
