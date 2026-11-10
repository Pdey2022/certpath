# ADR 0001: Cloudflare React Router rendering

- Status: Accepted for Milestone 0, with owner approval on 2026-11-10.
- Scope: Local repository foundation only; no production deployment decision.

## Context

Public acquisition pages must return meaningful HTML, titles, descriptions and
canonical metadata without JavaScript. The app must retain React/TypeScript and
run in Cloudflare's Worker environment. Private learner and admin pages may use
client-side interaction but must be non-indexable and eventually enforce
authorization on the server.

## Decision

Use React Router framework mode with server-side rendering on Cloudflare
Workers. Use the Cloudflare Vite plugin and Wrangler for local Worker-runtime
development. Public landing and catalogue routes are server-rendered; the
learner and admin route shells remain simple non-functional placeholders.

Mount the Hono API in the same Worker at `/api/*`; dispatch those requests to
Hono before passing other requests to React Router. This keeps one origin and
one explicit routing boundary without a second Worker, service binding, or
duplicated API/business logic. Bind local D1 through Wrangler and keep its
migrations in `db/migrations`. No database access is exposed to browser code.

Local indexing is disabled. Public routes emit canonical links based on the
request origin until the owner selects a production domain. Private routes
always emit `noindex,nofollow`. Enabling production indexing requires explicit
configuration and a reviewed host/redirect policy.

## Alternatives considered

- Astro SSR with React islands is Cloudflare-compatible, but adds a second
  frontend framework alongside the React application.
- A separate API Worker would require additional local/deployment routing and
  service-binding configuration for this foundation.

## Consequences

- One framework handles public SSR and the private React shell.
- Public HTML can be inspected with JavaScript disabled.
- Local development uses Cloudflare's Worker runtime and D1 emulator.
- This ADR does not settle brand/domain, authentication, payment, or production
  hosting configuration.

## Compatibility evidence

Cloudflare's React Router Worker guide, updated 2026-11-05, documents the
`create-cloudflare` React Router starter, SSR enabled by default, the Cloudflare
Vite plugin, and local Worker-runtime development:
<https://developers.cloudflare.com/workers/framework-guides/web-apps/react-router/>

The scaffolded dependencies and lockfile are verified by the local typecheck
and build in `docs/reviews/milestone-0.md`.
