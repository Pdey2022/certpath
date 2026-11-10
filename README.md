# CertPath foundation

This repository contains the Milestone 0 foundation for a mobile-first exam
preparation product. The public site is server-rendered with React Router on
Cloudflare Workers. A Hono API is mounted at the same-origin `/api` path in
that Worker; D1 is bound locally for future server-side data access. No
authentication, payments, learner records, question content, or production
permissions are implemented.

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
requiring browser JavaScript. The learner and admin routes are non-functional,
non-indexable shells; they do not represent authenticated or authorized users.

## Verification

```powershell
npm run verify
```

This runs workspace type checks, tests, and a production build. To inspect the
running HTML and API manually, start `npm run dev` and request `/`, `/exams`,
`/robots.txt`, `/sitemap.xml`, `/app`, `/admin`, and `/api/health`. Private
shells carry `noindex`; local robots configuration disallows crawling.

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
