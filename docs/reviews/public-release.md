# Public site release (Workers Free)

**Status:** Prepared for review; **not deployed**. The existing demo stays live at
`https://certpath-ui-preview.certpath.workers.dev` on the Workers Free plan.

## Scope

A separate Worker, `certpath-site`, serves only the public pages:

- `/` - landing page explaining exam-specific preparation for CISSP and CISM.
- `/exams` - CISSP and CISM catalogue, with Standard and Pro access explained.
- `/robots.txt` and `/sitemap.xml` - indexing for the two public pages only.

Sign-in, registration, email verification, password recovery, checkout, admin,
the learner workspace, and every `/api/*` route are **not** part of this release.
The Worker returns `404` with `X-Robots-Tag: noindex` for `/api`, `/app`,
`/admin`, `/sign-in`, `/verify-email`, `/recover-password`, `/reset-password`, and
`/local-inbox`, before React Router runs.

## Proposed live URL

`https://certpath-site.certpath.workers.dev`

`PUBLIC_SITE_ORIGIN` and both canonical URLs use that origin, and the sitemap
lists only `/` and `/exams`.

## Build and deployment commands

```powershell
npm run build:site     # builds with VITE_CERTPATH_PUBLIC_RELEASE=true and asserts the entry
npm run deploy:site    # wrangler deploy -c apps/web/build/server/wrangler.json
```

`build:site` fails if the generated config does not select `wrangler.site.jsonc`,
if the Worker name is not `certpath-site`, or if the bundle does not contain
`workers/public-site.ts`. Deployment is a single Worker upload on Workers Free,
so there is no metered cost; `observability` is disabled and no D1 binding,
secret, or cron trigger exists.

## Content changes

- Prototype wording is gone from the landing page and catalogue: no "interactive
  prototype", "synthetic catalogue", "working label", or "foundation page".
- Standard and Pro are explained from the product rules: one certification at a
  time, Standard fixed terms of 3, 6, or 12 calendar months, and Pro as optional
  adaptive preparation for exactly three months that requires Standard for the
  same exam.
- **Try the demo** links to the live preview from the header, the home page, and
  the catalogue.
- An availability note says practice content is not published yet and that
  purchasing and accounts open later, plus an independence notice about the
  CISSP and CISM trademarks.

## Local verification (built release Worker, `wrangler dev`, port 8795)

| Check | Result |
|---|---|
| `GET /` | 200, title `CertPath CISSP and CISM exam preparation`, description names Standard and Pro, canonical `https://certpath-site.certpath.workers.dev/`, `robots: index,follow` |
| `GET /exams` | 200, title `CISSP and CISM catalogue CertPath`, CISSP and CISM cards plus Standard and Pro sections |
| Phone 390x844 | Single-column cards, no horizontal overflow, header nav `Exams` and `Try the demo` |
| Desktop 1440x900 | Two-column cards, no horizontal overflow, same nav |
| In-app navigation | `Exams` reaches `/exams`, brand reaches `/`, titles update per page |
| `/robots.txt` | `Allow: /`, `Disallow: /app`, `Disallow: /admin`, sitemap link |
| `/sitemap.xml` | Exactly `/` and `/exams` on the proposed origin |
| `/sign-in`, `/verify-email`, `/recover-password`, `/reset-password`, `/local-inbox` | 404 |
| `/app`, `/app/practice/live`, `/admin/question-editor` | 404 |
| `/api/health`, `/api/auth/google/start` | 404 |
| Browser console | No errors (the release skips the learner preflight request) |

## Limitations

- Indexing is enabled for the released pages, but no domain, analytics, or
  consent handling exists yet; the release stays on the `workers.dev` hostname.
- Prices, currency, purchasing, accounts, and question content are not present,
  so the site describes the product without offering a purchase.
- The demo Worker is unchanged and remains the only live deployment.
