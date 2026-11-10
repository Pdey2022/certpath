# Milestone 0 review handoff

Status: ready for architect review. Scope is limited to the repository
foundation; no production deployment or later milestone has been started.

## Implemented

- Private-repository workspace foundation: npm workspaces, lockfile, root
  guidance, issue/PR templates, CI, and local setup/verification commands.
- React Router 8.5.1 server rendering on Cloudflare Workers. Public landing and
  catalogue pages return meaningful HTML with unique metadata, canonical URLs,
  social metadata and WebPage structured data.
- Hono 4.13.17 API mounted at same-origin `/api/*`; `/api/health` returns only
  `{"status":"ok"}` and is not cacheable.
- Local D1 binding and a version-controlled migration workflow. The initial
  migration is intentionally a no-op; product schema is deferred.
- Responsive learner and admin placeholder shells, with private noindex and
  `private, no-store` responses. They contain no user or staff fixture data and
  do not implement authentication or authorization.
- SEO and analytics contracts, the two-role permissions contract, save/resume
  semantics, architecture decision and open-decision register.
- Screenshots captured from the local Worker:
  - [Learner shell — mobile](./assets/learner-mobile.png)
  - [Learner shell — desktop](./assets/learner-desktop.png)
  - [Admin shell — mobile](./assets/admin-mobile.png)
  - [Admin shell — desktop](./assets/admin-desktop.png)

## Architecture decisions

- **React Router framework mode with SSR** was selected over Astro/React
  islands to keep one React/TypeScript application. Owner approval was received
  before scaffolding. Cloudflare’s Worker guide, updated 2026-11-05, documents
  React Router SSR, the Cloudflare Vite plugin and local Worker-runtime
  development. The scaffold resolved React Router 8.5.1, Cloudflare Vite plugin
  1.68.0, Wrangler 4.160.0, and Vite 8.3.7.
- **One Worker and one origin:** requests under `/api/` dispatch to Hono; all
  other requests dispatch to React Router. This avoids separate-worker routing
  and duplicated API logic.
- **D1 is local-only in this milestone.** The zero database ID is for Wrangler’s
  local emulator, not production. No product tables or credentials were added.
- **Indexing defaults off locally.** Public canonical links use the request
  origin until the production domain is approved. Production indexing and host
  redirects require explicit configuration.

## Files changed

- Root: `.env.example`, `.gitignore`, `AGENTS.md`, `README.md`, `package.json`,
  `package-lock.json`.
- GitHub: `.github/copilot-instructions.md`,
  `.github/PULL_REQUEST_TEMPLATE.md`,
  `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/workflows/ci.yml`.
- API: `apps/api/package.json`, `apps/api/tsconfig.json`,
  `apps/api/src/index.ts`, `apps/api/src/index.test.ts`.
- Web: `apps/web/package.json`, `apps/web/react-router.config.ts`,
  `apps/web/tsconfig.cloudflare.json`, `apps/web/vite.config.ts`,
  `apps/web/wrangler.jsonc`, `apps/web/workers/app.ts`,
  `apps/web/app/root.tsx`, `apps/web/app/app.css`, `apps/web/app/routes.ts`,
  `apps/web/app/routes/home.tsx`, `apps/web/app/routes/exams.tsx`,
  `apps/web/app/routes/learner.tsx`, `apps/web/app/routes/admin.tsx`,
  `apps/web/app/routes/robots.ts`, `apps/web/app/routes/sitemap.ts`,
  `apps/web/app/components/public-layout.tsx`,
  `apps/web/app/components/workspace-shell.tsx`,
  `apps/web/app/lib/cloudflare-context.ts`, `apps/web/app/lib/seo.ts`,
  `apps/web/app/lib/seo.test.ts`, and
  `apps/web/.vscode/settings.json`.
- Shared contracts: `packages/contracts/package.json`,
  `packages/contracts/tsconfig.json`, `packages/contracts/src/index.ts`.
- D1: `db/migrations/0001_foundation.sql`.
- Documentation: `docs/analytics-events.md`,
  `docs/decisions/0001-cloudflare-react-router.md`,
  `docs/open-decisions.md`, `docs/permissions.md`, `docs/save-resume.md`,
  `docs/seo.md`, this review, and its four screenshots under `assets/`.

## Verification

Environment: Node.js 24.18.0, npm 11.16.0, Windows.

| Command/check | Actual result |
|---|---|
| `npm ci --no-audit --no-fund` | Passed; installed 128 packages from the lockfile. npm warned that install scripts for `workerd` and `esbuild` were not approved by the local npm policy. |
| `npm run db:migrate:local` | Passed; `0001_foundation.sql` applied to the local D1 emulator (two SQL commands executed). |
| `npm run verify` | Passed after clean install: API, web and contracts type checks; 1 API test and 4 SEO tests; React Router client and Worker SSR production builds. |
| `npm ci --include=optional --no-audit --no-fund` (Windows, after lockfile fix) | Passed; installed 128 packages from the lockfile. npm emitted its existing local install-script approval warnings for `workerd` and `esbuild`. |
| `npm run verify` (Windows, after lockfile fix) | Passed: all type checks, 1 API test, 4 SEO tests, and client/Worker SSR production builds. |
| `npm ls @rolldown/binding-win32-x64-msvc lightningcss-win32-x64-msvc --all` (Windows) | Passed; both Windows x64 bindings are installed. Their Linux x64 glibc counterparts remain in the lockfile for Ubuntu and are excluded by npm’s platform filter on Windows. |
| [GitHub Actions run 42843892379](https://github.com/Pdey2022/certpath/actions/runs/42843892379) (Ubuntu, Node 24) | Passed; `npm ci --include=optional` and `npm run verify` both succeeded. |
| Local Worker HTTP checks | `/` and `/exams` returned HTTP 200 with visible headings, title, description, canonical and social metadata in the raw HTML response; WebPage JSON-LD parsed and matched the canonical URL. `/app` and `/admin` returned HTTP 200 with `noindex,nofollow` and `Cache-Control: private, no-store`. `/api/health` returned HTTP 200 and `{"status":"ok"}`. Local `/robots.txt` disallowed crawling and `/sitemap.xml` contained no URLs. |
| Browser responsive checks | Learner and admin shells tested at 320, 390, 768, 1024 and 1440 CSS pixels. No document overflow; mobile navigation controls were at least 48px high; desktop showed the sidebar and hid mobile navigation. Keyboard Tab reached the visible skip link with a focus outline. |

### Cross-platform optional dependency correction

The original lockfile recorded Windows x64 native bindings but not their
Linux x64 glibc counterparts for either Rolldown or Lightning CSS. On Ubuntu,
`npm ci` completed without them: React Router type generation first failed
with “Cannot find native binding”; after adding that binding, the production
build exposed the missing Lightning CSS native module. The lockfile now
records both Linux package versions, registry URLs, integrity values, and
platform constraints while retaining the Windows entries. CI continues to
use `npm ci` and now explicitly passes `--include=optional`; it does not skip
checks or alter the runner OS. A `workflow_dispatch` trigger is also
available to repeat the same Ubuntu verification directly against a branch
head.

The corrected clean install and full verification passed on Windows. The
final Ubuntu run passed after both Linux bindings were added; it completed
both `npm ci --include=optional` and `npm run verify` successfully.

No deploy command was run, no Cloudflare account was contacted, and no payment
or production integration was configured.

## Known limitations and unresolved decisions

- The learner/admin routes are explicitly non-functional placeholders. There is
  no authentication, authorization, entitlement check, study persistence,
  autosave, payment, adaptive exam or learner/admin data.
- The D1 migration proves the local migration flow only; it creates no product
  schema.
- No certification catalogue records, sample questions, paid question banks,
  social preview artwork, or final brand are included.
- Local indexing is disabled. A production domain, canonical origin, redirects,
  staging protection, Search Console and production indexing policy remain
  unset.
- Owner decisions still open include launch market/currency, prices and
  renewal, customer-facing timezone/calendar expiry display, content sources,
  auth/email/monitoring/analytics providers, privacy and retention, refund
  policy, active-attempt expiry, historical explanation access, Pro
  extension/repurchase rules and device policy. See
  [open decisions](../open-decisions.md).
- The npm install-script warning is environment-specific; clean install,
  production build and local Worker HTTP checks passed despite it.

## Architect inspection and run steps

1. Review the `feat/milestone-0-foundation` branch and this handoff, especially
   [ADR 0001](../decisions/0001-cloudflare-react-router.md),
   [SEO](../seo.md), [permissions](../permissions.md), and
   [save/resume](../save-resume.md).
2. With Node.js 22.22+ and npm 10+, run `npm ci`.
3. From the repository root, run `npm run db:migrate:local`, then `npm run dev`.
4. Inspect `/`, `/exams`, `/robots.txt`, `/sitemap.xml`, `/app`, `/admin`, and
   `/api/health` at the local URL Wrangler prints.
5. Run `npm run verify` to repeat types, tests and the production build.

Do not deploy this foundation. Production configuration and later milestone
work require architect review and the open owner decisions above.
