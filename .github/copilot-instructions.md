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
- Work through the three-role process in `docs/agent-workflow.md`: ARC designs
  and reviews (`.github/agents/arc.agent.md`), DEV implements and tests
  (`.github/agents/dev.agent.md`), and PROF pre-checks question content outside
  the repository (`.github/agents/prof.agent.md`). Only DEV edits the repository.
  Only the owner approves a merge, a deployment, a provisioning step, an import
  into any database, and the content itself. A PROF verdict is never an approval
  of content, of an import, of a merge, of a deployment or of a provisioning
  step, and it never satisfies the "author ≠ reviewer" requirement in ADR 0006.

**PROF is an automated content pre-check. It is not a reviewer of record, it does not satisfy the "author ≠ reviewer" requirement in ADR 0006, and its verdict is not an approval of content, of an import, of a merge, of a deployment or of a provisioning step. Only the owner signs off content.**
