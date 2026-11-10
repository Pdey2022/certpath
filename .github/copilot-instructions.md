# Copilot instructions

- Follow `docs/product-design.md` and `docs/build-plan.md`; do not invent
  product rules or implement work from a later milestone.
- Preserve React/TypeScript, Cloudflare Workers, same-origin `/api`, and D1
  migrations. Keep secrets and database access server-side.
- Public pages must render useful HTML and metadata without JavaScript. Learner
  and admin routes remain non-indexable and are not authorization boundaries.
- Preserve Global Admin and exam-scoped Manager as the only staff roles.
- Do not add real question banks, personal data, credentials, billing, or
  production integrations.
- Run `npm run verify` and report actual results.
