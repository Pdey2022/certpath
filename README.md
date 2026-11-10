# CertPath foundation

This repository contains the CertPath Milestone 1 interactive prototype. The
public site is server-rendered with React Router on Cloudflare Workers. A Hono
API is mounted at the same-origin `/api` path in that Worker; D1 is bound
locally for future server-side data access. Learner and admin experiences use
synthetic demo data only. There is no authentication, payment processing,
production persistence, or production authorization.

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
requiring browser JavaScript. The learner and admin routes are non-indexable
interactive previews, not authenticated accounts or authorized staff views.
Practice progress is saved only in the current browser and is labelled as
demo-only; it is not sent to the server or synchronized between devices.

## Verification

```powershell
npm run verify
```

This runs workspace type checks, tests, and a production build. To inspect the
running HTML and API manually, start `npm run dev` and request `/`, `/exams`,
`/robots.txt`, `/sitemap.xml`, `/app`, `/admin`, and `/api/health`. Private
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
