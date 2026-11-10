# Milestone 2D review handoff

## Status and scope

Implemented the internal question-bank import preview, draft-only confirmation,
and scoped published-content export. The services are not exposed through HTTP
routes and are not connected to the prototype or an admin UI. No provider,
production identity, real question-bank data, learner persistence, payment,
deployment, or production provisioning was added.

## Decisions

- Added the pinned pure-JavaScript `csv-parse` 7.0.3 dependency. A standards
  parser is needed for quoted commas, escaped quotes, and embedded newlines;
  hand-splitting CSV would parse valid input incorrectly. It has no native
  binding requirement.
- Defined the ordered `certpath-question-v1` template for single-choice
  questions. Import accepts UTF-8 without a BOM and rejects malformed,
  unsupported, duplicate, unknown, missing, or out-of-order fields. It uses
  the manual content validator and validates all rows and taxonomy references.
- Limited uploads to 256 KiB, 10 rows, 96 KiB per CSV record, and the existing
  content-field bounds. Input is rejected, never truncated or silently skipped.
- A valid preview stores normalized validated rows, identifiers, actor/scope,
  format, expiry, and a digest bound to those values in D1. It stores no raw
  file. Invalid previews retain no validated question content. Preview rows
  expire after 10 minutes; expired payloads are cleared opportunistically and
  by a five-minute scheduled cleanup, at most 50 per invocation.
- Confirmation accepts only the preview ID and rechecks session, MFA, role,
  assignment, and taxonomy. One bounded D1 batch creates only new sealed draft
  revisions. Guarded writes, unique fixed IDs, foreign keys, and triggers make
  it all-or-nothing and idempotent; database failures abort the batch, while
  zero-row conditional writes are treated as conflicts rather than success.
  At the 10-row maximum, construction uses at most 53 statements and the
  largest option statement uses 47 bindings.
- Export is limited to 100 current published questions per page and an
  explicitly authorized certification/exam version. CSV fields are quoted,
  quotes doubled, and formula-leading cells neutralized with a leading
  apostrophe. This spreadsheet-safe output is intentionally not directly
  re-importable.
- Audit records contain actor, scope, operation, outcome, and safe counts or
  codes, never question bodies, explanations, raw CSV, or credentials.
- Kept cleanup in a small server-only module so the scheduled Worker path does
  not import the CSV parser. The cron is configuration only and has not been
  deployed.

## Files changed

- `apps/api/package.json`, `package-lock.json`
- `apps/api/src/security/content.ts`
- `apps/api/src/security/question-import-cleanup.ts`
- `apps/api/src/security/question-imports.ts`
- `apps/api/test/question-imports.test.ts`
- `apps/api/test/schema.test.ts`
- `apps/web/workers/app.ts`, `apps/web/wrangler.jsonc`
- `db/migrations/0004_question_imports.sql`
- `docs/build-plan.md`
- `docs/question-bank-import-export.md`
- `docs/reviews/milestone-2d.md`

## Verification

Executed on Windows after a clean dependency install:

| Command | Result |
|---|---|
| `npm ci --include=optional` | Passed; 175 packages installed, audit reported 0 vulnerabilities. npm emitted pending install-script approval warnings for `workerd` and `esbuild`; the verification below completed successfully. |
| `npm run verify` | Passed: API/contracts/web TypeScript checks; API health test; 42 API Worker/D1 tests across 7 files; 13 web tests; client and SSR production builds. |

The Worker/D1 tests use the isolated local runtime and synthetic records. They
cover quoted and multiline CSV, malformed and oversized input, schema and
content validation, authorization and revocation, expired/tampered previews,
idempotent and concurrent confirmation, conflict and rollback paths, sealed
draft outputs, cleanup, and scoped/paginated formula-safe exports.

Ubuntu CI has not yet been run on the committed head. The PR handoff must report
the exact pushed SHA and its passing Ubuntu Actions run; no result for another
commit is evidence for this head.

## Limitations and deferred work

- This is a service/schema slice only; there are no HTTP routes, upload UI, or
  admin UI integration.
- Imports are intentionally capped at 10 questions per all-or-nothing batch.
  Increasing that cap requires revalidating actual D1 and Worker limits.
- Exports are bounded to 100 rows per page and include only current published
  content; formula-neutralized output is a report, not a re-import artifact.
- Cleanup handles at most 50 expired previews per run. Monitor backlog before
  increasing import volume. The cron has not been deployed.
- Provider choice, provider lifecycle handling, production MFA/session timing,
  and production operations remain pending approval under ADR 0002.
- No learner attempts, bookmarks, payments, adaptive engine, production
  provisioning, or deployment behavior is included.

## Architect inspection and local run

1. Review the migration and its guards in
   `db/migrations/0004_question_imports.sql`.
2. Review parsing, preview/confirmation, and export in
   `apps/api/src/security/question-imports.ts`; review scheduled payload
   cleanup in `apps/api/src/security/question-import-cleanup.ts`.
3. Review D1 regression cases in `apps/api/test/question-imports.test.ts` and
   the full import/export contract in `docs/question-bank-import-export.md`.
4. From the repository root, run `npm ci --include=optional`, then
   `npm run verify`. The test harness uses its isolated local Worker/D1 state;
   no production database or destructive production command is involved.
