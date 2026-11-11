# Standard timed-mock API contract

The timed-mock routes extend the protected learner API at `/api/practice`.
They are for CertPath practice, not an official certification exam. Requests
use the existing opaque `certpath_session` cookie; the Worker hashes it and
checks the current session, user and exact-certification Standard grant in D1.
The client supplies no identity, grant, role, clock, duration, question count,
deadline, score, or answer-key authority.

All responses, including errors, are `private, no-store` and carry
`X-Robots-Tag: noindex, nofollow`. Unsafe requests require the existing
session-bound `X-CSRF-Token` and the exact configured `Origin`. JSON requests
use strict shared schemas. The API does not expose a session-issuance or
test-session endpoint.

## Profile and question selection

Each exam version has a server-owned, versioned profile. The approved profile
is 900 seconds, 10 questions, and reviewable navigation. The database bounds
duration to 60–14,400 seconds and question count to 1–20; runtime checks those
bounds before creating an attempt. A start request cannot override profile
settings. If there are fewer currently published questions than the profile
requires, start returns `409 insufficient_questions` and creates no attempt.

At creation, the server chooses published sealed revisions and snapshots their
exact content, question order, option order, correct key, and explanations.
Republishing or retiring source content does not change an existing snapshot.
The deadline is `startedAt + durationSeconds * 1000` using server time.

## Routes

| Method and path | Purpose |
|---|---|
| `GET /api/practice/scopes` | Lists currently authorized certification/exam scopes and each available mock profile. |
| `GET /api/practice/mocks?certificationId=…&examVersionId=…` | Lists at most 20 owned attempts in the exact authorized scope. An authorized list read checks/finalizes expired attempts. |
| `POST /api/practice/mocks` | Starts a profile-defined mock. Body: `{ "certificationId": "…", "examVersionId": "…", "requestId": "UUID" }`. Same-user retries with the same request ID return the established attempt. |
| `GET /api/practice/mocks/:attemptId` | Resumes an owned attempt or reads its finalized result. The request checks session and active Standard access before returning data. An expired in-progress attempt is finalized from acknowledged answers. |
| `POST /api/practice/mocks/:attemptId/answers` | Saves/changes an answer. Body: `{ "expectedVersion": 1, "requestId": "UUID", "position": 0, "selectedOptionKey": "A" }`. |
| `POST /api/practice/mocks/:attemptId/position` | Saves reviewable navigation. Body: `{ "expectedVersion": 1, "requestId": "UUID", "position": 0 }`. |
| `POST /api/practice/mocks/:attemptId/submit` | Finalizes the mock. Body: `{ "expectedVersion": 1, "requestId": "UUID" }`. |

Answer and position commands are deduplicated by attempt/request ID and guarded
by the expected attempt version. Replaying a matching command returns the
current persisted snapshot; reusing an ID for a different command conflicts.
Stale versions return `409 conflict`. Answer writes at or after the deadline
return `409 deadline_reached`. A later authorized read performs automatic
timeout finalization. Simultaneous or repeated submissions return the one
persisted finalized result.

The submit action locks the attempt and scores only acknowledged answers.
Unanswered questions count as incorrect. Active responses include selected
answers but omit correct keys and explanations. Only finalized result
responses include correctness and explanations.

## Access expiry and error behavior

The existing Standard-grant policy is unchanged: active access is required on
every attempt list, resume, answer, navigation, submit, and result request. If
access expires, those requests are denied even if the timer is also expired;
the timer is finalized when access is restored and an authorized request
checks it. The product owner has not chosen a grace or continuation policy.

Errors use the shared protected-API envelope and request ID. Notable statuses:

- `401 unauthenticated`: missing, malformed, expired or revoked session.
- `403 access_required`: no current Standard grant for the requested
  certification.
- `404 not_found`: attempt does not belong to the authenticated user.
- `400 validation_error` / `415 unsupported_media_type`: invalid strict body
  or content type.
- `409 conflict`: stale version, locked attempt, or mismatched replay.
- `409 deadline_reached`: the answer-write deadline has elapsed.
- `409 insufficient_questions`: the profile cannot be filled from currently
  published questions.
- `409 mock_not_configured`: authorized exam version has no active profile.
- `503 service_unavailable`: sanitized unexpected database/runtime failure.

## Inspection

Shared request and response schemas are in
`packages/contracts/src/practice.ts`; the HTTP boundary is
`apps/api/src/learner-practice.ts`; D1 persistence and authorization are in
`apps/api/src/security/timed-mocks.ts`; profile, snapshot and integrity
constraints are in `db/migrations/0006_timed_mocks.sql`.
