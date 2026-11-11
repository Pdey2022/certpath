# Learner practice API contract

Milestone 3A exposes only the protected untimed practice boundary under
`/api/practice`. Every response, including errors, is `private, no-store` and
`noindex, nofollow`. API clients use the same-origin `certpath_session` opaque
cookie; the Worker hashes it and resolves an active user/session from D1. No
user ID, role, access claim, session digest, MFA claim, or timestamp supplied by
the browser is authority.

The runtime requires an exact HTTPS `PUBLIC_SITE_ORIGIN` and a configured
`CSRF_HMAC_SECRET` of at least 32 bytes. Mutations require the matching Origin
and an HMAC token from `GET /csrf`, bound to the session digest and origin.
Missing or invalid configuration fails closed. Session issuance is not part of
this slice; a future issuer must set the cookie `Secure`, `HttpOnly`, and
`SameSite=Lax` (or stricter), with a narrow path and expiry matching the server
session.

## Routes

| Method and path | Purpose |
|---|---|
| `GET /api/practice/csrf` | Return the session-bound CSRF token. |
| `GET /api/practice/scopes` | List only currently granted certifications and exam versions with published questions, including bounded domain choices. |
| `GET /api/practice/attempts?certificationId=…&examVersionId=…` | List at most 20 of the learner's attempts in the authorized scope. |
| `POST /api/practice/attempts` | Create or idempotently recover an attempt. |
| `GET /api/practice/attempts/:attemptId` | Resume an owned attempt and return its bounded snapshot. |
| `POST /api/practice/attempts/:attemptId/answers` | Submit one answer with an expected version and idempotency key. |

Attempt creation accepts only:

```json
{
  "certificationId": "…",
  "examVersionId": "…",
  "questionCount": 10,
  "domainId": "…",
  "difficulty": "medium",
  "requestId": "uuid"
}
```

`domainId` and `difficulty` are optional. `questionCount` is 1–20. The stored
filters and immutable item snapshots are fixed for the attempt. A retry with
the same request ID and identical scope/filters returns the existing attempt;
reusing the ID for different input conflicts.

An answer accepts only:

```json
{
  "expectedVersion": 1,
  "requestId": "uuid",
  "selectedOptionKey": "A"
}
```

Each accepted answer increments the attempt version and advances the current
position atomically. Duplicate submissions with the same request ID, version,
and option have one effect. A stale version, mismatched retry, answer to a
completed attempt, or answer for a non-current question returns `409`.

Before submission, an item contains its stem and ordered option keys/text only.
It omits correct keys, correctness, and all explanations. After submission of
that item, the response may contain the selected key, correct key, correctness,
and explanations for that item. Scoring and completion state are calculated by
the Worker/D1 boundary. Completed attempts are immutable and remain available
only while the access policy permits the read.

## Bounds and persistence

JSON request bodies have an 8 KiB streaming byte limit; `Content-Length` is an
early rejection only, never the sole size check. Schemas reject unknown fields.
Scope lists are capped at 200 exam scopes and 200 domains per scope; attempt
lists are capped at 20; an attempt holds at most 20 questions with 2–8 options
each.

Creation uses one D1 batch containing one attempt insert, at most 20 snapshot
inserts, and one finalization statement (22 statements maximum). Each snapshot
is a single D1 row and one bound JSON value; the row's content is bounded by the
existing question field/option limits and remains well below D1's 2,000,000-byte
row limit. The largest statement binds 17 values, below D1's 100-parameter
per-statement ceiling; all 22 statements together use at most 358 bindings,
below the approximately 5,000 bindings per Worker script limit. D1 batch rollback plus a finalization trigger that
requires every expected row prevents zero-row inserts from leaving an active
partial attempt. Answer submission is one conditional insert; a D1 trigger
advances the version, position, score and completion state in the same atomic
statement.

The 20-question and field limits are intentionally conservative. Current
Cloudflare D1 limits are documented at
[D1 platform limits](https://developers.cloudflare.com/d1/platform/limits/).

## Access expiry decision

The implementation requires an active Standard grant for create, list, resume,
and answer requests. If a grant expires during an attempt, reads and writes are
denied while the original snapshot remains stored. This is a temporary
fail-closed behavior, not an approved customer-facing policy. Product approval
is still required on whether active attempts may continue, receive a bounded
grace period, or stop at expiry, and on historical explanation availability.
No grant-issuance or grant-management API is included.

## Errors

Errors use a sanitized `{ "error": { "code": "…", "requestId": "…" } }` body.
The boundary uses `401` for missing/invalid sessions, `403 access_required` for
missing/expired grants, `404` for another user's or unavailable attempts, `409`
for stale/idempotency conflicts or insufficient question pools, `413` for the
streaming body limit, and `503` for unavailable configuration or unexpected
database/runtime failures. Raw SQL errors and question content are not returned
or logged.
