# CertPath foundation

This repository contains the CertPath prototype and the first protected
untimed learner-practice slice. The public site is server-rendered with React
Router on Cloudflare Workers. A Hono API is mounted at the same-origin `/api`
path in that Worker; D1 holds server-side attempt snapshots and answers.
Provider-backed sign-in, live session issuance, access-grant issuance,
payments, and production provisioning are not implemented.

## Requirements

- Node.js 22.22 or newer
- npm 10 or newer

## Local development

From the repository root:

```powershell
npm ci
npm run db:migrate:local
npm run dev
```

The local Worker is available at the URL printed by Wrangler (normally
`http://localhost:5173`). Public routes return HTML from the Worker without
requiring browser JavaScript. The `/app` workspace and `/app/practice` remain
synthetic, browser-only previews and do not authorize any action.
`/app/practice/live` is a separate protected route; it requires an opaque
application-session cookie and a current D1 Standard grant. This repository
does not provide an endpoint to issue sessions or grants. API/D1 tests use
isolated synthetic fixtures only. Protected practice content is never written
to browser storage.

## Verification

```powershell
npm run verify
```

This runs workspace type checks, tests, and a production build. To inspect the
running HTML and API manually, start `npm run dev` and request `/`, `/exams`,
`/robots.txt`, `/sitemap.xml`, `/app`, `/app/practice/live`, `/admin`, and
`/api/health`. Private
previews carry `noindex` and `private, no-store`; local robots configuration
disallows crawling. See [Milestone 1 review](docs/reviews/milestone-1.md) for
prototype limitations, screenshots, verification, and inspection steps.

## Architecture and product contracts

- [Product design](docs/product-design.md) and [build plan](docs/build-plan.md)
  are the product baseline.
- [Architecture decisions](docs/decisions/) record framework and Worker
  boundaries; [open decisions](docs/open-decisions.md) records items that need
  an owner or architect before production.
- [SEO](docs/seo.md), [analytics events](docs/analytics-events.md),
  [permissions](docs/permissions.md), and
  [save/resume](docs/save-resume.md) document contracts without implementing
  later milestone features.

Local development uses Wrangler's local D1 emulator. Do not put credentials,
customer data, or paid question banks in this repository. There is no deploy
command in the workspace scripts.
