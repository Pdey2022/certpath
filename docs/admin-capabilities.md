# Admin capabilities and learner support (Phase 3, issue #46)

Status: implemented behind the tester gate. No learner-support UI ships in this
phase; the server rules are the whole change.
Rules: [ADR 0004](decisions/0004-staff-capabilities-and-learner-data.md).

## ⚠️ Deactivation is terminal

A deactivated learner **cannot be reactivated**. `users_no_reactivation` is a
storage trigger and aborts any `disabled → active` update, whatever code path
attempts it. There is deliberately **no `learner.reactivate` capability**.

**Undoing a mistaken or malicious deactivation requires an owner-approved
migration that drops that trigger.** It is a visible, deliberate act, not a
capability and not a support action. Do not describe deactivation as reversible.

A compromised Manager session can therefore disable learner accounts
platform-wide. The exposure is denial of service, not data, and every
deactivation is audited with an actor, a reason and an operation id.

## 1. Scope

Delivered here:

- One closed capability table and one server-side decision function,
  `canCapability(actor, capability, resource)`, with content-scope resolution
  including the *proposed* certification when content moves.
- Manager: content in assigned certifications; learner support platform-wide.
- One learner read model that masks contact details, plus one audited reveal.
- Audit for every learner record view, every reveal and every support mutation.
- Twelve-month audit retention with a scheduled cleanup that cannot delete
  anything younger.

Not in this phase (refused, not absorbed): any admin learner UI; payments,
prices, discounts, coupons, refunds, credits, checkout; access grants,
extensions, Pro enablement (learner support may **read** membership state, never
write it); staff and role management; security, secrets, integrations, audit
export (`audit.read` exists in the matrix and has no route); reactivation; hard
delete; bulk learner export; transactional email; real MFA; deployment or
provisioning; per-actor rate limiting on reveal/lookup (follow-up issue).

## 2. Capability table

`apps/api/src/security/capabilities.ts` holds a
`Record<StaffCapability, CapabilityRule>`; a new capability without a rule is a
type error and an unknown string is denied at runtime.

| Capability | Resource kind | Global Admin | Manager |
|---|---|---|---|
| `content.read` | certification | all | assigned |
| `content.manage` | certification | all | assigned |
| `learner.lookup` | platform | yes | yes |
| `learner.read` | learner | yes | yes |
| `learner.reveal` | learner | yes | yes |
| `learner.deactivate` | learner | yes | yes |
| `learner.contact.correct` | learner | yes | yes |
| `learner.support.email` | learner | yes | yes |
| `learner.support.history` | learner | yes | yes |
| `commerce.read` | platform | yes | **no** |
| `access.grant` | platform | yes | **no** |
| `staff.manage` | platform | yes | **no** |
| `security.manage` | platform | yes | **no** |
| `audit.read` | platform | yes | **no** |

The decision function is named `canCapability`, **not** `can`:
`apps/api/src/entitlements.ts` already exports `can(access, capability)` for
learners, and a second `can` with a different signature in every module that
needs both is a readability trap.

Failures: `not-staff`, `insufficient-role`, `unknown-capability`,
`resource-kind-mismatch`, `certification-not-found`, `certification-unassigned`,
`learner-not-found`. A learner resource that belongs to an account holding an
active staff role answers `learner-not-found`, which is indistinguishable from a
missing account.

## 3. Three layers, all server-side

1. **Tester gate** (`apps/web/workers/app.ts` → `adminTesterGate`). Every
   `/api/admin/...` path is inside `isAdminSurfacePath`, so an empty
   `ADMIN_TESTER_IPS` answers 503 before any handler and an unlisted
   `cf-connecting-ip` answers 403 before any read or write. The gate is not an
   authorization boundary and is not treated as one.
2. **`requireCapability(...)`** (`security/staff-request.ts`): live session →
   `authorizeStaffSession` (active role + MFA freshness and method) →
   `canCapability(...)`. Every route uses it.
3. **Statement guards.** Every write carries `learnerGuard(tokenDigest,
   learnerUserId, now, policy)` inside its own `WHERE`: live session, unexpired,
   staff role active, account active, MFA method in the allowed set and inside the
   maximum age, and the subject holding no active staff role. Content keeps the
   equivalent `certificationGuard(...)`.

## 4. Interface

All paths are same-origin under `/api/admin`, `private, no-store`,
`X-Robots-Tag: noindex, nofollow`, `X-Request-Id`. Errors use the repository
envelope `{ "error": { "code": string, "requestId": string } }`. Every `POST`
requires `Origin` equal to `PUBLIC_SITE_ORIGIN` and an `X-CSRF-Token` from
`GET /api/admin/csrf`.

Lookups are `POST` on purpose: an address must never appear in a URL, where it
would reach edge request logs, `Referer` headers and browser history.

| Endpoint | Capability |
|---|---|
| `GET /api/admin/csrf` | none (live session plus an active staff role) |
| `GET /api/admin/capabilities` | none (reports the caller's own role) |
| `POST /api/admin/learners/lookup` | `learner.lookup` |
| `GET /api/admin/learners/:learnerId` | `learner.read` |
| `POST /api/admin/learners/:learnerId/contact-reveal` | `learner.reveal` |
| `POST /api/admin/learners/:learnerId/deactivate` | `learner.deactivate` |
| `POST /api/admin/learners/:learnerId/contact` | `learner.contact.correct` |
| `POST /api/admin/learners/:learnerId/password-reset` | `learner.support.email` |
| `POST /api/admin/learners/:learnerId/resend-verification` | `learner.support.email` |
| `GET /api/admin/learners/:learnerId/support-history` | `learner.support.history` |

`GET /api/admin/capabilities` reports `{ role, capabilities }`; the server never
accepts a capability from a client. A live session with no `staff_roles` row is
401; a row whose role was withdrawn (`active = 0`) is 404. `/api/admin/csrf`
mints a token only for an account holding an active staff role.

### 4.1 Masked learner record

`userId`, `accountStatus` (`active | deactivated`), `maskedContact`,
`contactKind` (`password-credential | sign-in-invite | null`), `emailVerified`
(null for invite-based accounts and for accounts with no credential),
`memberships` (one entry per `(certificationId, feature)`, state from
`evaluateFeature`, at most 20, newest `endsAt` first), `membershipsTruncated`,
`attemptCounts` (all rows, in progress or completed), `lastActivityAt`,
`createdAt`.

`maskEmail` is shape-preserving and never carries a full label:
`alice@example.test` → `a***@e***.test`.

### 4.2 Refusals

| Case | Answer |
|---|---|
| No live session | 401 `unauthenticated` |
| Live session, no staff role | 401 `unauthenticated` |
| Staff role withdrawn | 404 `not_found` (capabilities only) |
| MFA missing, stale or unsupported | 403 `forbidden` |
| Capability denied | 403 `forbidden` |
| Subject missing **or holding an active staff role** | 404 `not_found` |
| Reveal with no contact on file | 409 `contact_not_available` (no audit row) |
| Deactivation of a disabled account | 409 `already_deactivated` (no audit row) |
| Contact correction to the current address | 409 `contact_unchanged` (no audit row) |
| Contact correction for an invite-only account | 409 `contact_not_correctable` |
| Contact address held by another learner | 409 `contact_taken` (nothing written) |
| Password reset / resend verification | 409 `email_unavailable` |
| Resend verification for a verified account | 409 `already_verified` |
| Invalid staff security configuration | 503 `service_unavailable` |

A staff subject is a 404 on **every** learner endpoint, for both roles, and
writes nothing: resetting a staff member's password is "who can act on the
platform" and therefore a Global Admin path, not learner support.

## 5. Masked by default, revealed once

There is exactly one unmasked read in the codebase:
`revealLearnerContact()` in `apps/api/src/security/learner-access.ts`. The reveal
is a `batch([audit insert, select email])` where both statements carry the same
contact predicate and the same statement guard, so a reveal either writes one
audit row and returns the address, or writes nothing at all.

### Audited events

| Action | When | `details_json` | `reason` |
|---|---|---|---|
| `learner_record_viewed` | one per successful lookup hit or record read | `NULL` | server constant |
| `learner_contact_revealed` | one per successful reveal | `{"fields":["email"]}` | server constant |
| `learner_contact_corrected` | one per applied correction | `{"fields":["email"]}` | staff-supplied, validated |
| `learner_deactivated` | one per applied deactivation | `NULL` | staff-supplied, validated |
| `learner_support_history_viewed` | one per history read | `NULL` | server constant |

**Owner decision: a reveal records field names only.** The address and the
search term are never written to the audit table, a log line, an error message
or a response outside the reveal itself. `details_json` holds `{"fields":["email"]}`
and nothing else. A malformed value is rejected by the
`audit_events_details_valid_insert` trigger.

Denied and no-op requests write nothing. Mutations use a guarded `UPDATE`, a
witness column (`users.deactivation_operation_id`,
`learner_password_credentials.contact_operation_id`) and a *conditional* audit
insert in the same batch, so a denied or no-op mutation provably writes no audit
row and a mutation cannot succeed without one. Over-auditing is possible and
preferred; under-auditing is impossible for the write paths.

Reasons are trimmed to 1–200 characters and rejected if they contain `@`, so a
support note cannot become a second, unretained copy of an address.

Support-history actors are shown by role only (`global_admin`, `manager`,
`learner`, `system`) — never a user id, never contact data. Reading the history
is itself audited and appears on the next read; that is deliberate.

## 6. Data changes — `db/migrations/0016_admin_capabilities.sql`

One migration, no table rebuilds, no data copy, every added column nullable.

1. `audit_events.details_json` plus `audit_events_details_valid_insert` and
   `audit_events_occurred_at_idx`. `audit_events_no_update` is untouched: the
   table stays append-only except for retention.
2. Retention: `audit_events_no_delete` is replaced by a trigger that aborts any
   delete of a row whose `occurred_at` is inside the window, measured against
   **D1's own clock**, not the caller's.
3. `users.deactivation_operation_id`, `users_deactivation_requires_operation`
   (no unaudited disable) and `users_no_reactivation` (terminal state).
4. `learner_password_credentials.contact_operation_id`.
5. Four contact-identity triggers closing the cross-table hole described next.

## 7. One address, one learner

Contact identity was only unique *within* each table: an address could exist in
`learner_password_credentials` for one account and in
`learner_email_sign_in_invites` for another. Four triggers close that:

- `learner_password_credentials_contact_identity_insert` / `_update`
- `learner_email_sign_in_invites_contact_identity_insert` / `_update`

The comparison is **`user_id`**, so the *same* learner may hold the same address
in both tables; only a different `user_id` aborts with
`a contact address may identify only one learner`. Revoked invites still reserve
their address — there is no `revoked_at` filter, which is what keeps re-provisioning
idempotent (`ON CONFLICT … DO UPDATE SET revoked_at = NULL` still works).

Consequences:

- The learner lookup deduplicates **by `user_id`**, because a same-user address
  can match two rows.
- `POST /learners/:id/contact` pre-checks the collision with a `UNION` over both
  tables (`WHERE user_id <> :learnerId`) and answers one `409 contact_taken` for
  every case — credential holder, invite holder, active or disabled holder,
  revoked invite — with a byte-identical body apart from the per-request
  `requestId` envelope field. Splitting it per table or per state would disclose
  which sign-in path the other account uses. A `DB.batch` rejection whose message
  is `a contact address may identify only one learner` maps to the same 409; any
  other D1 error stays 503 and never surfaces as a 500. Nothing is written on a
  409.
- Registration consults the invite table as well as the credential table, and a
  residual trigger abort answers with the same `202` accepted body, so an
  already-provisioned address is indistinguishable from a fresh one. Before this,
  registering an invited address created a second account for one address.

## 8. Audit retention — twelve months, flat

`cleanupExpiredAuditEvents(database, now, limit = 500)` deletes at most `limit`
rows whose `occurred_at` is older than 365 days, ordered oldest first. It is
idempotent, re-entrant and bounded. It runs in its own `ctx.waitUntil` beside the
question-import cleanup and only when `AUDIT_RETENTION_ENABLED === "true"`
(default `"false"` in `wrangler.jsonc`).

**Owner decision: retention is a flat twelve months with no legal hold.** Every
audit row is deleted at the window, including reveal rows and deactivation rows.
There is no separate class, no hold mechanism and no per-learner exception. If a
launch market later requires longer retention for deactivation evidence, or a
legal hold that suspends deletion, that is a new decision and a new migration.

Storage enforces the floor: a `DELETE` of any row younger than the window aborts
with `audit events are retained for 12 months`, whoever issues it. A caller clock
two years ahead still cannot over-delete. Under-deletion is possible with a stale
clock and is cheap to detect — the index makes "how many rows are older than the
window" one query. Over-deletion is not possible.

## 9. Email stays off

`password-reset` and `resend-verification` answer `409 email_unavailable`: no
transport exists, and minting a reset token that cannot be delivered would leave
a live credential with no legitimate reader. No token row, no audit row, no
address logged. The handler sits behind `supportEmailConfigured(env)`, which
returns false for every binding this phase can set, so the routes cannot be
switched on by configuration drift alone. `resend-verification` answers
`409 already_verified` for a verified account before it reaches that refusal.

## 10. Failure modes

- **Fail-closed configuration.** An invalid `PUBLIC_SITE_ORIGIN`, CSRF secret or
  MFA policy returns 503 with no read, no write and no audit row. An empty
  `ADMIN_TESTER_IPS` returns 503 before routing.
- **Atomic audit.** D1 `batch()` is one transaction: if the audit insert or the
  read fails, the whole batch rolls back and the route answers with an error
  status and an empty body.
- **Idempotency.** Reveal, view and history are intentionally non-idempotent —
  a second look is a second act. Deactivation and contact correction are
  idempotent in effect: a replay returns 409 and writes nothing. Operation ids are
  per request, so no `audit_events` primary-key collision is possible.
- **Concurrency.** Two deactivations race on `status = 'active'`; SQLite
  serialises, the loser changes 0 rows and answers 409. Two corrections serialise;
  the identity triggers reject a duplicate address and roll the batch back. A
  concurrent assignment revocation is caught by the statement guard.
- **Revocation and deactivation take effect on the next request.** Every session
  read joins `users.status = 'active'` and every guard re-reads `staff_roles`.
  Live session rows stay in place with their history; they simply stop
  authenticating.

## 11. Never logged

No log line, error message, audit field or response outside a reveal ever carries
a learner address, normalised address, invite address, token or token digest, a
password hash, a full request or response body, a lookup address, or SQL that
carries them. The new modules emit no per-request logging at all.

## 12. Security dependency: MFA before real learners

Platform-wide learner access is acceptable on the labelled `tester-gate`
assurance only while the IP allowlist is non-empty, because real MFA is parked.
**This surface may not be used for real learner data until an approved MFA factor
replaces `tester-gate` (Phase 5 gate).** `staff-configuration.ts` already refuses
`tester-gate` without both the allowlist and the owner flag.

## 13. Rollback

`AUDIT_RETENTION_ENABLED` unset ⇒ the cleanup deletes nothing. Unmounting the
learner-support router (`application.route("/admin", adminLearnersApi)` in
`apps/api/src/index.ts`) removes every new endpoint behind the existing tester
gate; no migration is needed to roll back a route. Reversing a *deactivation*
needs the owner-approved migration described at the top of this document.

## 14. Follow-up issues

1. Admin learner-support UI under `/admin/learners` — UI only, no new server rules.
2. Per-actor rate limiting for lookup and reveal, plus an alert when one actor's
   reveal count in a day crosses a threshold.
3. MFA replacement for `tester-gate` as a hard gate before real learner data.
4. HTTP-level Manager denial tests for commerce, access grants, prices and staff —
   those routes arrive in Phase 4. The guarantee is held here at the capability
   layer (matrix denial, `requireCapability`, the `/capabilities` report and the
   forbidden-route test).
