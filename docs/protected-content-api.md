# Protected content API contract v1

Status: Milestone 2E server contract. These routes expose the existing
server-only content/import/export services; they do not implement provider
login, application-session issuance, or admin UI integration. The synthetic
prototype remains separate.

## Trust and request rules

- The only identity input is the `certpath_session` cookie. It contains an
  opaque 32-byte random token encoded as unpadded base64url. The Worker hashes
  the decoded token with SHA-256 and validates the digest, account, expiry and
  revocation in D1 primary. A provider JWT, token digest, user ID, role, MFA
  claim, assignment, timestamp, query parameter or prototype state is never
  authority.
- Requests use the Worker clock. Required server configuration is
  `PUBLIC_SITE_ORIGIN`, `STAFF_MFA_MAX_AGE_MS`,
  `STAFF_MFA_ALLOWED_METHODS`, and `CSRF_HMAC_SECRET`. Missing, malformed or
  weak configuration denies protected operations. There are deliberately no
  MFA production defaults or local credential values in Wrangler config.
- Staff routes check the active Global Admin role or current Manager
  certification assignment, MFA assurance and exact nested resource scope.
  The existing services recheck authorization in their reads and guarded
  writes. An unassigned/missing certification or nested resource is reported
  as not found to avoid confirming another scope.
- Each request body is read as a byte stream with an enforced byte cap; the
  `Content-Length` header is only an early rejection hint. JSON endpoints
  accept `application/json` with optional UTF-8 charset; imports accept
  `text/csv` with optional UTF-8 charset. Invalid UTF-8, unsupported media
  types, malformed JSON, unknown fields and cross-resource IDs are rejected.
- Every protected response, including errors and CSV, is
  `Cache-Control: private, no-store, max-age=0` and
  `X-Robots-Tag: noindex, nofollow`. Errors have the shape
  `{"error":{"code":"...","requestId":"..."}}`; they never contain SQL,
  exception messages, cookies, tokens, stems, explanations or answer keys.
- Mutations require an exact `Origin` match to `PUBLIC_SITE_ORIGIN` and a
  request URL origin equal to `PUBLIC_SITE_ORIGIN`, plus a session-bound
  `X-CSRF-Token`. The signed session-bound token is an HMAC-SHA-256 of
  the session digest, configured origin and version, signed by the
  `CSRF_HMAC_SECRET`; compare signatures without early-exit string checks.
  `GET /csrf` returns the token only to the authenticated same-origin browser
  and is not CORS-enabled. A future UI obtains it with same-origin `fetch`,
  keeps it in memory, and sends it in the header for each mutation. No
  arbitrary origins, return URLs or permissive CORS are supported.
- Future session issuance, after separate provider approval, must set the
  random opaque value only in a `Secure; HttpOnly; SameSite=Lax; Path=/api`
  cookie, with an explicit expiry/Max-Age and no `Domain`; production must use
  HTTPS. This slice does not issue or set that cookie.

## Routes

All routes below are under `/api/admin/content`. `:certificationId`,
`:examVersionId`, `:domainId`, `:topicId`, `:questionId`, `:revisionId` and
`:importId` are path identifiers. Path IDs, not body/query alternatives,
define scope.

| Method and path | Request | Success |
|---|---|---|
| `GET /csrf` | Authenticated session cookie; no body | `200 {"csrfToken":"v1.<signature>"}` |
| `POST /certifications/:certificationId/exam-versions` | Strict JSON: `versionKey`, `title`, `syllabusReference`, optional nullable integer `effectiveFrom`, `effectiveUntil`. Server generates ID, operation ID and time. | `201 {"id":"..."}` |
| `POST /certifications/:certificationId/exam-versions/:examVersionId/domains` | Strict JSON: `domainKey`, `title`, `meaning`, non-negative integer `order`. | `201 {"id":"..."}` |
| `POST /certifications/:certificationId/exam-versions/:examVersionId/domains/:domainId/topics` | Strict JSON: `topicKey`, `title`, `meaning`, non-negative integer `order`. | `201 {"id":"..."}` |
| `POST /certifications/:certificationId/exam-versions/:examVersionId/questions` | Strict JSON: `questionKey`, `domainId`, `topicId`, `content` (stem, difficulty, source/licence references, and ordered options with key/text/correct/explanation). | `201 {"questionId":"...","revisionId":"...","revisionNumber":1}` |
| `POST /certifications/:certificationId/exam-versions/:examVersionId/questions/:questionId/revisions` | Strict JSON: `domainId`, `topicId`, positive `expectedLockVersion`, and full `content`. | `201 {"revisionId":"...","revisionNumber":2}` |
| `GET /certifications/:certificationId/exam-versions/:examVersionId/questions/:questionId/revisions/:revisionId` | No body. Revision must match all path scopes. | `200` with exact revision, workflow state and options (including answer correctness, for staff only). |
| `POST /certifications/:certificationId/exam-versions/:examVersionId/questions/:questionId/revisions/:revisionId/submit` | Strict JSON `{}`. | `200 {"revisionId":"..."}` |
| `POST /certifications/:certificationId/exam-versions/:examVersionId/questions/:questionId/revisions/:revisionId/review` | Strict JSON: `decision` (`approved` or `rejected`), `notes`. | `201 {"reviewId":"..."}` |
| `POST /certifications/:certificationId/exam-versions/:examVersionId/questions/:questionId/publish` | Strict JSON: `revisionId`, `expectedPointerVersion` (positive integer or null for first publication). Revision must match certification, version and question. | `200 {"pointerVersion":1}` |
| `POST /certifications/:certificationId/exam-versions/:examVersionId/questions/:questionId/retire` | Strict JSON: positive `expectedPointerVersion`. | `200 {"pointerVersion":2}` |
| `POST /certifications/:certificationId/exam-versions/:examVersionId/import-previews` | `text/csv`, at most 256 KiB; same authorized scope/version as path. | `201` with the existing import preview result and row-specific validation summary. No questions/publications are created. |
| `POST /certifications/:certificationId/import-previews/:importId/confirm` | Strict JSON `{}`; the path certification must match the preview, which is bound to the same actor and certification. | `200` with the established idempotent confirmed draft IDs. |
| `GET /certifications/:certificationId/exam-versions/:examVersionId/export?cursor=...&limit=1..100` | No body; strict query allowlist. | `200 text/csv` with the export CSV and `X-Export-Next-Cursor` when another page exists. |

General collection/search endpoints, cross-certification copy, lifecycle
management, login/logout, role changes, bootstrap, test-session creation and
all learner routes are out of scope. Operation IDs and timestamps are
generated server-side. No route accepts client-supplied actor or audit
identity.

## Error codes and status

| Status | Error code | Meaning |
|---|---|---|
| 400 | `validation_error` | Invalid schema, path/query value, media type, encoding, CSRF token or origin; malformed/oversized request uses `payload_too_large` where applicable. |
| 401 | `unauthenticated` | Missing, malformed, expired, revoked or disabled-account session. |
| 403 | `forbidden` | Authenticated non-staff or staff MFA assurance is missing, unsupported or stale. |
| 404 | `not_found` | Resource is absent or not visible in the authorized certification scope. |
| 409 | `conflict` | Stale lock/pointer, duplicate exam-version/domain/topic/question key, invalid workflow transition, expired preview or import replay conflict. Expected key collisions use targeted SQLite conflict clauses in the same guarded insert; they are not classified by parsing arbitrary database errors. Existing confirmed imports return their prior successful outcome. |
| 503 | `service_unavailable` | Required security configuration is absent/invalid or D1/runtime processing failed. The response is sanitized. |

Validation responses may include stable field-level schema issue paths and
codes, but never rejected content values. Import validation may use the
existing row/column/code list; it does not echo source text.

## Configuration and limits

`STAFF_MFA_MAX_AGE_MS` must be a positive safe integer. `STAFF_MFA_ALLOWED_METHODS`
must be a non-empty comma-separated subset of `totp`, `webauthn`, and `sms`.
These values must come from deployment configuration approved separately;
this feature does not select a production freshness policy. `CSRF_HMAC_SECRET`
must be a deployment secret with at least 32 bytes of entropy. Never place
secret values in the repository or return them. `PUBLIC_SITE_ORIGIN` must be
one exact HTTPS origin (scheme, hostname and optional port only), not a path,
wildcard or comma-separated list.

JSON limits are route-specific and enforced while streaming, before JSON parsing:

- Exam-version, domain, topic, review, publication, retirement, and other
  non-question JSON mutations: 24 KiB. The largest of these schemas is a
  3,000-code-unit review note; worst-case JSON escaping uses at most six bytes
  per code unit (18,000 bytes), leaving room for the rest of the request and
  JSON structure.
- Question draft creation and correction: 256 KiB. The schema allows at most
  37,576 UTF-16 code units across question key, stem, source/licence
  references, and eight options' keys, text and explanations. Escaping every
  code unit as a six-byte JSON escape is at most 225,456 bytes. The two
  maximum-length body IDs add at most 1,536 bytes; JSON property/array syntax
  and numeric metadata remain below 1 KiB, leaving over 34 KiB of overhead.
  UTF-8 multibyte characters are no larger than this escaped bound.
- CSV import: 256 KiB, as defined by the existing import contract.

Chunked and content-length-free requests use the same streaming caps. Declared
`Content-Length` is an early-rejection hint only; the stream byte count remains
authoritative. Oversized bodies return 413 before parsing and cannot create
content or audit records. Query strings are bounded and strictly parsed.

## Boundaries

The existing internal content, review, publication, import and export services
remain authoritative for D1 guards and invariants. The HTTP layer adds
identity resolution, request constraints, transport validation, CSRF and
error/header policy only. The admin UI continues to use synthetic prototype
state and must not call these endpoints in this slice.
