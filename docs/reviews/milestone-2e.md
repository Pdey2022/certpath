# Milestone 2E review handoff

## Status and scope

Implemented a protected same-origin Hono HTTP boundary for the existing
content, editorial, import and export services. It adds no provider integration,
login, application-session issuance, role-management, bootstrap operation,
admin UI wiring, learner routes, payment, deployment or production
provisioning. The existing browser admin remains explicitly synthetic.

## Security and architecture decisions

- Identity comes only from the `certpath_session` cookie: a canonical unpadded
  base64url 32-byte opaque token. The Worker decodes and hashes its bytes with
  SHA-256, then calls existing primary-consistent active-session validation.
  Request/query data cannot supply a digest, identity, role, assignment, MFA
  assertion or time.
- Server time supplies session checks and operation metadata. Explicit
  `PUBLIC_SITE_ORIGIN`, `STAFF_MFA_MAX_AGE_MS`,
  `STAFF_MFA_ALLOWED_METHODS`, and `CSRF_HMAC_SECRET` are required. No local
  or production MFA defaults or secret values are configured; incomplete or
  invalid configuration returns a sanitized 503.
- Staff scope and MFA are checked before body processing, with authorization
  repeated by the existing content services and guarded D1 mutations. Exact
  version/domain/question/revision paths are checked before reading the
  associated request body or content. Cross-certification copy and collection
  routes are intentionally absent.
- Cookie-authenticated mutations require the exact configured `Origin`, the
  request URL origin to match it, and an HMAC-SHA-256 CSRF token bound to the
  session digest and origin. `GET /csrf` provides a same-origin-only,
  session-bound token for a future UI; no permissive CORS is enabled.
- JSON request bodies use streaming route-specific limits: 24 KiB for
  non-question mutations and 256 KiB for question creation/correction, derived
  from maximum schema field lengths, six-byte-per-code-unit JSON escaping,
  UTF-8 expansion and explicit overhead. CSV retains the existing 256 KiB
  import limit. Declared `Content-Length` is only an early check; the stream
  byte count is authoritative. UTF-8 decoding is fatal. Shared strict Zod
  schemas reject unexpected fields.
- Expected duplicate version/domain/topic/question keys are handled with
  targeted SQLite `ON CONFLICT(key-columns) DO NOTHING` clauses in the
  guarded inserts. Zero returned rows become a sanitized 409; unrelated
  uniqueness/check/FK failures and trigger/infrastructure errors still reach
  the generic sanitized 503 handler. This is safe under concurrent requests
  and does not rely on preflight reads or broad error-message matching.
- All content responses, including CSV and errors, are private/no-store and
  noindex. Errors are mapped to stable status/code shapes. Unexpected D1 and
  runtime failures return a generic 503, and logs contain only a request ID.
- Future session issuance must set the opaque cookie as
  `Secure; HttpOnly; SameSite=Lax; Path=/api`, with explicit expiry and no
  `Domain`. This contract is documented only; no route issues or sets it.
- No dependency was added. Existing shared Zod schemas support strict transport
  contracts; Worker/D1 integration tests use the repository's existing
  Cloudflare Vitest plugin.

## Endpoint contract

The complete versioned input/output, auth, CSRF, size and error contract is in
[protected-content-api.md](../protected-content-api.md). Routes cover:

- Exam-version, domain and topic creation.
- Question draft creation and same-certification corrected revisions.
- Exact certification/version/question/revision reads.
- Review submission and approval/rejection.
- Publish, supersede through the existing publication service, and retirement.
- Import preview, idempotent confirmation, and scoped paginated published CSV
  export.

There are no cross-certification copy, general collection/search, login,
session issuance, role-change, bootstrap, test-session or learner endpoints.

## Files changed

- `apps/api/src/index.ts`
- `apps/api/src/protected-content.ts`
- `apps/api/src/security/content.ts`
- `apps/api/test/factories.ts`
- `apps/api/test/protected-content.test.ts`
- `docs/build-plan.md`
- `docs/protected-content-api.md`
- `docs/reviews/milestone-2e.md`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/protected-content.ts`

## Verification

Windows verification command and outcome:

| Command | Result |
|---|---|
| `Set-Location apps\api; npx vitest run --config vitest.config.ts test/protected-content.test.ts` | Passed: 12 protected HTTP integration tests on isolated Worker/D1, including duplicate-key and maximum-content regressions. |
| `npm run verify` | Passed on Windows: workspace TypeScript checks; API health test; 54 API Worker/D1 tests across 8 files; 13 web tests including public SEO/prototype tests; client and Cloudflare Worker SSR production builds. |
| Ubuntu GitHub Actions | Passed for correction commit `4bf61ad3d53b8c5b61d6e7f15368ac960b6f8190`: [CI run 43012257643](https://github.com/Pdey2022/certpath/actions/runs/43012257643). |

The HTTP integration tests cover missing/malformed/expired/revoked/disabled
sessions, forged client authority, missing/invalid/stale/unsupported MFA,
assigned/unassigned Manager access, role/session/assignment rechecks, CSRF and
Origin failures, content types, actual chunked body limits, scoped resource
IDs, draft/review/publish/correction/retirement and stale conflicts,
sequential/concurrent duplicate key conflicts, maximum-length eight-option
multibyte/escaped question bodies, route-specific chunked body limits,
idempotent/expired imports, scoped exports, private response headers,
sanitized D1 failures, and unchanged health behavior. Test session creation
uses the isolated test-only factories; session revocation and assignment
revocation exercise existing security services. The final PR head and its CI
result are reported separately if this handoff itself changes after the
correction commit.

## Configuration and limitations

- The checked-in Wrangler config deliberately does not define the new MFA or
  CSRF values. Protected routes therefore fail closed until an operator
  supplies approved environment-specific configuration. Do not copy test
  values into deployment secrets.
- MFA freshness and allowed factors remain pending owner/architect policy.
  Provider selection, provider-backed session issuance, account recovery and
  revocation remain deferred under proposed ADR 0002.
- The signed CSRF token endpoint is an application boundary for a future UI;
  no UI is connected to it. The prototype continues to use synthetic state and
  cannot authenticate or authorize.
- No rate-limiting, deployment, production cookie issuance or provider
  compatibility proof was added.
- The user-visible public HTML/SEO stack is unchanged; API health and existing
  SEO tests remain in the verification suite.

## Architect inspection and run steps

1. Review the endpoint table and configuration contract in
   [protected-content-api.md](../protected-content-api.md).
2. Inspect routing/auth/body/error handling in
   `apps/api/src/protected-content.ts`; verify `apps/api/src/index.ts` mounts
   it only under `/api/admin/content`.
3. Compare service calls with the D1 invariants in
   `apps/api/src/security/content.ts` and
   `apps/api/src/security/question-imports.ts`.
4. Inspect shared strict transport schemas in
   `packages/contracts/src/protected-content.ts` and real Worker/D1 tests in
   `apps/api/test/protected-content.test.ts`.
5. From the repository root, run `npm ci --include=optional` and
   `npm run verify`. Tests use the isolated local Worker/D1 runtime and
   synthetic records only.
6. Confirm the final Ubuntu CI run is green on the exact PR head before
   approval. Do not merge, deploy or connect the prototype UI as part of this
   slice.
