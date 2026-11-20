# SEO foundation

## Public routes

- `/` and `/exams` are public, server-rendered React Router pages. They must
  return useful HTML even when JavaScript is disabled.
- Each public route defines a unique title, description, canonical URL, social
  preview metadata and WebPage structured data matching visible content.
  Canonical URLs use the request origin for local development; set
  `PUBLIC_SITE_ORIGIN` and enforce host redirects once the production domain is
  approved.
- `PUBLIC_SITE_ORIGIN` and `INDEXING_ENABLED` are Worker variables. Configure
  them in the appropriate Wrangler environment; `.env.example` documents names
  only and is not a source of Worker secrets or a production configuration.
- `/sitemap.xml` lists only public routes and only when `INDEXING_ENABLED` is
  explicitly `true`.
- `/robots.txt` disallows crawling in the local configuration. When indexing
  is explicitly enabled, it excludes `/app` and `/admin` and points to the
  sitemap.
- `/app/*` and `/admin/*` emit `noindex,nofollow` and are never included in the
  sitemap. Their placeholder responses use `private, no-store`. This is not
  authentication or authorization.
- Do not publish question samples until the content owner explicitly approves
  them. Paid question banks must never be exposed to crawlers or public bundles.

## Indexing is off on the public site

`apps/web/wrangler.site.jsonc` is the config `build:site` selects, so it is the
configuration the published Worker runs with. It sets
`INDEXING_ENABLED: "false"`, which is a full disable, not a partial one:

- every public page (`/`, `/exams`) emits `robots: noindex,nofollow`;
- `/robots.txt` is `User-agent: *` followed by `Disallow: /`;
- `/sitemap.xml` still answers `200` but lists no URLs, and `robots.txt` does
  not point at it.

Why: the marketing copy still says access is not published yet and purchasing
is not open (`apps/web/app/lib/site-content.ts`). Inviting crawlers to pages
that say the product cannot be bought advertises a storefront that does not
sell, and it publishes a canonical origin before a production domain is
approved. This is a temporary posture, not a product change: it is not a
decision that CertPath stays unindexable.

Turning indexing back on is a separate, owner-approved change: it must move
together with the copy that says the product is not published, the approved
public origin, and the Search Console setup in the release checks below. A
page that is `noindex` is still readable by anyone with the URL; indexing was
never a security or access control.

Only the public-site config carries this posture. `wrangler.jsonc` (local),
`wrangler.preview.jsonc`, `wrangler.staging.jsonc` and `wrangler.pilot.jsonc`
set `INDEXING_ENABLED: "false"` independently and are unaffected by this
config.

## Release checks

1. Request `/` and `/exams` with JavaScript disabled; inspect the response body
   for visible content, a unique title, description and canonical link.
2. Verify real status codes for public routes, missing pages and redirects.
3. Check `/robots.txt`, `/sitemap.xml`, `X-Robots-Tag` and page-level robots
   metadata with indexing enabled, disabled and in staging. While the site is
   deployed with indexing off, the live check is the disabled row: `/robots.txt`
   must say `Disallow: /`, `/sitemap.xml` must list no URLs, and `/` and `/exams`
   must carry `noindex,nofollow`.
4. Confirm authenticated learner/admin data is server-protected regardless of
   robots directives or hidden navigation.
5. Test viewport sizes, zoom, keyboard access, mobile performance and layout
   stability. Record supported browser versions before release.
6. Add approved social preview artwork and configure the canonical origin,
   redirects, Search Console and
   performance monitoring before production indexing.

There is no ranking or rich-result guarantee. Milestone 0 does not configure a
production domain, Search Console, staging access control, or analytics.
