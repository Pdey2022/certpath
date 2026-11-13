# CertPath UI preview (synthetic demo)

A separate Cloudflare Worker, `certpath-ui-preview`, serves the existing React
Router pages with synthetic data only. It is not the production Worker
(`certpath-foundation`), which is unchanged.

Live URL: https://certpath-ui-preview.certpath.workers.dev

## What the preview excludes

No D1 binding, Lambda, live authentication, cron/scheduled handler, email,
payments, or secrets. `/api/*` returns `404 {"error":{"code":"preview_only"}}`
from the Worker without running any API code. Observability is off.

## How it is built

- `apps/web/wrangler.preview.jsonc`: Worker name, `INDEXING_ENABLED=false`, no
  bindings.
- `apps/web/workers/preview.ts`: entry with no API, D1, or scheduled handler;
  adds `X-Robots-Tag: noindex, nofollow, noarchive` to every response.
- `npm run build:preview -w @certpath/web` and
  `npm run deploy:preview -w @certpath/web` set `VITE_CERTPATH_UI_PREVIEW=true`
  and use the preview config. A normal `npm run build` is unchanged.
- In preview mode only: the public nav links to the demo screens, the home page
  has a walkthrough list, the sign-in availability check is skipped, and the
  admin role selector is shown (it is development-only otherwise).

## Indexing

Pages emit `noindex,nofollow` meta, every response carries `X-Robots-Tag`, and
`robots.txt` is `Disallow: /`. `robots.txt` is not access control; the preview
is public to anyone with the URL and holds only synthetic content.

## Role switching isolation

Global Admin and exam-scoped Manager are shown by a client-side `?demoRole=`
query parameter on the synthetic `/admin/*` pages. It grants nothing: there is
no authentication, no API, and no data. The protected `/admin/question-editor`
route is not linked and its API does not exist in this Worker.

## Clickable screens

| Area | Routes |
| --- | --- |
| Landing and catalogue | `/`, `/exams` |
| Learner (synthetic) | `/app`, `/app/exams/cissp`, `/app/exams/cissp/practice`, `/app/practice`, `/app/exams/cissp/mock`, `/app/exams/cissp/mock/active`, `/app/exams/cism/mock/active`, `/app/exams/cissp/pro/preview`, `/app/exams/cissp/pro/preview/session`, `/app/exams/cism/pro/preview`, `/app/exams/cism/pro/preview/session`, `/app/progress`, `/app/account` |
| Global Admin | `/admin` and its sections |
| Manager (CISSP) | `/admin?demoRole=manager` and its sections |

Illustrative only: every learner and admin screen. Practice answers and the
timed mocks use separate browser-storage keys for CISSP and CISM (each mock is
a 3-question, 3-minute synthetic attempt with a wall-clock countdown, auto-submit
on expiry, a results screen, and same-browser resume; they are not official exams
or server-enforced timers, and clearing site data discards them). The learner
dashboard shows separate CISSP and CISM mock links that resume, show results, or
start each exam according to its browser-saved attempt. It also shows separate
CISSP and CISM Pro mock links that resume an in-progress attempt, show a
completed result, or start the matching exam according to its browser-saved
attempt. The CertPath demo Pro
mock adapts among the same three synthetic questions: correct answers target
Intermediate difficulty and incorrect answers target Foundational when available.
Answers lock on submission; the final score and explanations are saved separately
for CISSP and CISM in browser storage. This small heuristic is not a validated
adaptive exam or official result. Access, customers, payments, and audit data
remain fixed fixtures. The Progress page reads the shared browser-saved
practice session and exam-specific timed and Pro mock attempts. Because
practice has no exam label, it is shown separately rather than attributed to
CISSP or CISM. The
live-API pages (`/app/home`, `/app/practice/live`,
`/app/mock/live`, `/sign-in`, and related) are not linked and do not work here.

## Workers Free check (before deploy)

- A PUT with `limits.cpu_ms` was rejected with error 100328, confirming the
  Free plan.
- 127 Worker requests in the previous 24 hours against 100,000/day.
- 1 existing Worker; preview adds a second (limit 100).
- Upload 1254 KiB, 253 KiB gzip, under the 3 MB Free limit; startup 3 ms.
- No paid features, D1, or AWS resources are used; cost is $0.

## Smoke test

Playwright against the live URL at 390x844 and 1280x800 across 16 routes: all
returned 200, rendered the expected `h1`, had no horizontal overflow, console
errors, or failed requests. The admin role selector switched Global Admin and
Manager with no `/api` request. `/api/*` returned 404 and `/robots.txt`
returned `Disallow: /`.

## Remove

`wrangler delete --name certpath-ui-preview` with
`CLOUDFLARE_ACCOUNT_ID` set to the Certpath account.
