# 5F — Staff second factor: design record

**Status: approved.** This is ARC's design record for Phase 5, slice 5F, as
approved by the owner on **18 November 2026**. Everything below the horizontal
rule is ARC's design, reproduced **verbatim**. It is the contract for this slice:
where the code stands in the way of a rule written below, the rule wins or the
change stops for review, and it is not re-designed in implementation.

## Owner decisions taken after the design was written

These four decisions were taken by the owner *after* the design text was written,
and they settle the "Owner decisions required" list at the end of the record.
They are the only change to the approved scope; the design text is otherwise
unedited, so its open-questions section is superseded by this table.

| # | Decision | Effect on the design |
|---|---|---|
| 1 | **No account lock. Rate limits only.** | The design's lockout question (owner decision 3) is answered *no*: no lock or lockout column, no unlock route, no counter that denies a correct code forever. The existing `consumeLocalRateLimit` windows are the only control. |
| 2 | **`STAFF_MFA_MAX_AGE_MS` = 8 hours** — one verification per session. | Owner decision 4 is answered: 8 h, equal to the staff session lifetime. |
| 3 | **Keep `ADMIN_TESTER_IPS`** as defence in depth. | The admin IP gate stays and is not retired. `stagingTesterGate` and learner traffic are untouched. |
| 4 | **MFA audit rows inherit the existing 12-month retention.** | Owner decision 1 is answered: no second retention regime, no new prune, no `0023` trigger on `audit_events`. |

Two further post-design clarifications, applied as written in the design:

- Transactional email stays off and Google OAuth stays paused. `STAFF_MFA_SEAL_KEY`
  is a deploy-time secret: the 503-when-missing path is implemented and the secret
  is **not** set by this slice.
- The "Exam Prep" → CertPath brand change is a separate change (#161) and does not
  appear here.

---

# 5F — Replace the `tester-gate` assurance with a real second factor

**Design record:** `docs/5f-staff-second-factor.md` (new, beside `docs/pilot-hardening.md`). Phase 5 (#48), slice 5F, migration **`0023`**. Read at `main` @ `9fb12d2`.

## Verified facts (not assumed)

- `staging-gate.ts#stagingTesterGate`: empty `STAGING_TESTER_IPS` → **503**; absent/mismatched `cf-connecting-ip` → **403**. It runs on **every** request of the staging Worker (`apps/web/workers/staging-app.ts:1`) and again inside the API when `STAGING_LEARNER_AUTH_ENABLED === "true"` (`apps/api/src/index.ts:107`). It is *not* the admin gate.
- `admin-gate.ts#adminTesterGate`: same shape with `ADMIN_TESTER_IPS` over `/admin`, `/api/admin` (`isAdminSurfacePath`), called from `workers/app.ts:47` and again in `staff-auth.ts:147`.
- `staff-configuration.ts`: `tester-gate` is accepted only if `ADMIN_TESTER_ASSURANCE === "true"` **and** `ADMIN_TESTER_IPS` is non-empty; otherwise the whole config is `null` → 503. `staff-auth.ts#readConfiguration` additionally refuses to mint a session unless that assurance is enabled (`503 staff_mfa_unavailable`) — so **today the only usable staff session carries `mfa_method='tester-gate'`**.
- `mfa.ts#getMfaFailure` → `missing | unsupported | stale`; `repository.ts#authorizeStaffSession` maps them to `mfa-*` (403); `capabilities.ts` statement guards re-read `mfa_method IN (...) AND mfa_verified_at BETWEEN ? AND ?` inside each write.
- `0002_local_security.sql`: `app_sessions.mfa_method TEXT CHECK(length 1..32)`, `mfa_verified_at`, `CHECK((mfa_method IS NULL) = (mfa_verified_at IS NULL))`. `0012` rebuilds `local_auth_rate_limit_windows` with a closed `scope` CHECK list.
- Learner paths (`local-learner-auth.ts:352`, `learner-google-oidc.ts:566`, `email-sign-in-links.ts:104`) insert `mfa_method = NULL` and never call `authorizeStaffSession`. Staff is `/admin/*` only.
- `0022` header and `pilot-hardening.md` both record `0023` as this slice. `docs/admin-capabilities.md` §12, `docs/permissions.md` §MFA dependency, `docs/delivery-plan.md` §Operating constraints and `product-design.md` line 97 ("Both staff roles require MFA") are the governing text.

## Scope

**In:** TOTP enrolment and verification for the two staff roles; the assurance label that replaces `tester-gate`; one-time recovery codes; Global-Admin reset; migration `0023`; contracts; tests; docs (`admin-capabilities.md` §12, `permissions.md`, `pilot-hardening.md` 5F row, `open-decisions.md`).
**Explicitly not in:** any change to the public site or demo, the "Exam Prep" → CertPath label work, learner sign-in, email, Google OAuth, staff MFA-for-learners, a staff-management UI, deployment, secret setting, or any new Cloudflare resource.

## Decision

The factor is **in-Worker TOTP (RFC 6238)** and the assurance label is **`totp`**, which already exists in `mfa.ts`, `staff-configuration.ts` and the free-text `app_sessions.mfa_method` column — so the label change is *data and configuration*, not new plumbing: `authorizeStaffSession`, the route guards and every statement guard already refuse anything not in `STAFF_MFA_ALLOWED_METHODS`. The one structural change is that **password sign-in stops minting assurance**: `POST /admin/auth/sign-in` inserts `mfa_method = NULL, mfa_verified_at = NULL` (already legal under the 0002 CHECK), which yields `mfa-assurance-missing` on every existing route, and `POST /admin/auth/mfa/verify` upgrades *that same session row* to `('totp', now)`. That removes the deadlock a config-only flip would create (you cannot enrol without a session, and you cannot get an assured session without enrolling), and it means `tester-gate` can be killed at the storage layer on day one without locking anyone out. `tester-gate` is deleted from both `supportedMfaMethods` lists, so a configuration naming it fails closed to `null` → 503, and a trigger refuses the label at the table. The **`adminTesterGate` IP allowlist stays as defence in depth** (it costs nothing, it is already fail-closed on empty, and it protects the enrolment surface from a stranger on the internet); whether to retire it is the owner's call. The **staging Worker's blanket `stagingTesterGate` cannot stay** on learner traffic — a real learner is not on the allowlist — which is an access-policy decision, not mine (see Owner decisions).

## Data changes — migration `0023_staff_second_factor.sql`

New tables (all timestamps INTEGER ms, all `REFERENCES users(id) ON DELETE RESTRICT`):

1. `staff_totp_credentials` — `credential_id TEXT PRIMARY KEY`, `user_id`, `secret_ciphertext TEXT` (base64 AES-256-GCM), `secret_iv TEXT` (base64, 12 bytes), `key_version INTEGER NOT NULL DEFAULT 1 CHECK(key_version > 0)`, `digits INTEGER NOT NULL CHECK(digits = 6)`, `period_seconds INTEGER NOT NULL CHECK(period_seconds = 30)`, `algorithm TEXT NOT NULL CHECK(algorithm = 'SHA1')`, `last_used_step INTEGER NOT NULL CHECK(last_used_step >= 0)`, `created_at`, `confirmed_at INTEGER`, `created_operation_id TEXT NOT NULL UNIQUE`, `revoked_at INTEGER`, `revoked_operation_id TEXT UNIQUE`, `CHECK((confirmed_at IS NULL) OR (confirmed_at >= created_at))`, `CHECK((revoked_at IS NULL) = (revoked_operation_id IS NULL))`. Partial unique index `staff_totp_credentials_active_idx ON (user_id) WHERE revoked_at IS NULL` — one live secret per person, history preserved.
2. `staff_recovery_codes` — `code_digest TEXT PRIMARY KEY CHECK(length=64 AND NOT GLOB '*[^0-9a-f]*')`, `user_id`, `set_operation_id TEXT NOT NULL`, `created_at`, `revoked_at`, `used_at`, `used_operation_id TEXT UNIQUE`, `CHECK((used_at IS NULL) = (used_operation_id IS NULL))`.
3. `staff_mfa_enrolment_tickets` — `ticket_digest TEXT PRIMARY KEY` (same digest CHECK), `user_id`, `created_by_user_id`, `created_by_ref`, `created_at`, `expires_at`, `consumed_at`, `consumed_operation_id TEXT UNIQUE`, `revoked_at`, `CHECK(expires_at > created_at)`, `CHECK(expires_at - created_at <= 86400000)`, the 0002-style all-or-nothing pairs, and `CHECK((created_by_user_id IS NOT NULL AND created_by_ref IS NULL) OR (created_by_user_id IS NULL AND created_by_ref IS NOT NULL AND length(created_by_ref) BETWEEN 1 AND 128))`.

Triggers — the invariants live here, not in TypeScript:

- `app_sessions_no_tester_gate_insert` / `_update`: `BEFORE INSERT` and `BEFORE UPDATE OF mfa_method ON app_sessions WHEN NEW.mfa_method = 'tester-gate'` → `RAISE(ABORT, 'the tester-gate assurance is retired')`. Nothing — not a route, not `d1 execute` — can mint the label again.
- `staff_totp_credentials_no_delete`; `..._secret_immutable` (`BEFORE UPDATE OF secret_ciphertext, secret_iv, key_version` → abort: replacement is a new row); `..._step_monotonic` (`BEFORE UPDATE OF last_used_step WHEN NEW.last_used_step <= OLD.last_used_step` → abort); `..._no_unrevoke` (`WHEN OLD.revoked_at IS NOT NULL` → abort on `revoked_at` change).
- `staff_recovery_codes_no_delete`; `..._no_reuse` (`BEFORE UPDATE OF used_at WHEN OLD.used_at IS NOT NULL` → abort); `..._max_ten_active` (`BEFORE INSERT WHEN (SELECT COUNT(*) FROM staff_recovery_codes WHERE user_id = NEW.user_id AND revoked_at IS NULL AND used_at IS NULL) >= 10` → abort).
- `staff_mfa_enrolment_tickets_no_delete`; `..._consume_once` (`WHEN OLD.consumed_at IS NOT NULL` → abort), mirroring `initial_admin_provisioning_consume_once`.
- Audit triggers in the 0002 `staff_roles_audit_*` style, so no code path can act without a row: `staff_totp_credentials` insert → `staff_mfa_enrolled`; `staff_recovery_codes` insert of a set → `staff_recovery_codes_issued`; `used_at` set → `staff_recovery_code_used`; `revoked_at` set → `staff_mfa_reset`; ticket consumption → `staff_mfa_enrolment_authorised`. `subject_type = 'staff_mfa'`, `subject_id = user_id`, `operation_id` supplied per row.
- Rebuild `local_auth_rate_limit_windows` exactly as `0011`/`0012` did, preserving rows and adding scopes `staff_mfa_verify_ip`, `staff_mfa_verify_email`, `staff_mfa_enrol_ip`, `staff_mfa_enrol_email`, `staff_recovery_redeem_ip`, `staff_recovery_redeem_email`.

Existing sessions: **no mass revocation.** Sessions stamped `tester-gate` immediately fail `mfa-assurance-unsupported` (403) on every route and every statement guard, which is the §10 convention ("Live session rows stay in place with their history; they simply stop authenticating"). Nothing in the migration deletes or rewrites `app_sessions`.

Checklist: add the SHA-256 line to `db/migrations/checksums.txt`; `npm run db:chain` asserts order.

## Interface — `packages/contracts/src/staff-admin.ts`

Mounted under the existing `/admin/auth` router, so `adminTesterGate` in `staff-auth.ts` covers all of it — no new prefix, no new gate.

| Route | Request | Success | Failures |
|---|---|---|---|
| `GET /admin/auth/preflight` | — | `{signInEnabled: boolean, mfaMethods: ("totp")[], testerAssuranceEnabled: literal false}` | — |
| `POST /admin/auth/sign-in` | `{email, password}` | `{redirectTo: "/admin/mfa/verify"}` + cookie (`mfa_method` NULL) | 400 `invalid_origin`/`invalid_request`, 401 `invalid_credentials`, 429 `rate_limited`, 503 `service_unavailable` |
| `GET /api/admin/csrf` (existing) | — | `{csrfToken}` — minted on live session + active role only | 400 `invalid_origin`, 401 `unauthenticated` |
| `POST /admin/auth/mfa/enrol` | `{}` or `{ticket}` | `{secret, otpauthUri, keyVersion}` — **shown once** | 403 `forbidden`, 409 `mfa_already_enrolled`, 410 `ticket_expired`, 429 |
| `POST /admin/auth/mfa/enrol/confirm` | `{code}` | `{recoveryCodes: string[10]}` — shown once | 400 `invalid_code`, 409 `mfa_already_enrolled`, 429, 503 `service_unavailable` (no seal key) |
| `POST /admin/auth/mfa/verify` | `{code}` | `{redirectTo: "/admin/question-editor"}` | 400 `invalid_code`, 401 `unauthenticated`, 429, 503 |
| `POST /admin/auth/mfa/recovery` | `{recoveryCode}` | `{next: "enrol"}` | 400 `invalid_code`, 409 `recovery_code_used`, 429 |
| `POST /admin/auth/mfa/reset` | `{userId, reason}` | `{ticket, expiresAt}` — Global Admin only | 403 `forbidden`, 404 `not_found`, 409 `conflict`, 400 `invalid_csrf` |

All POSTs: `Origin` must equal `PUBLIC_SITE_ORIGIN` exactly (`validRequestOrigin(..., true)`), `Content-Type: application/json`, body ≤ 6 KiB, `X-CSRF-Token` compared with `constantTimeEqual`. `GET /api/admin/csrf` is deliberately reusable before assurance — its own comment states it is "minted for an account that currently holds an active staff role", which a password-only staff session is.

**Assurance flow:** nothing in `repository.ts` or `capabilities.ts` changes. `STAFF_MFA_ALLOWED_METHODS=totp` becomes the policy; `authorizeStaffSession` then refuses `NULL`, `tester-gate` and stale assurance, and the statement guards carry the same predicate into SQL. One deliberate addition: `readStaffPageSession` (`admin-access.ts`) must also require assurance and send the caller to `/admin/mfa/verify` instead of rendering the HTML shell, otherwise the editor page renders for a password-only session while every API under it 403s.

## Security

TOTP specifics: RFC 6238, **HMAC-SHA1, 6 digits, 30-second period** (T = floor(now/30000)), **±1 step skew** (T−1, T, T+1 — 90 s total), secret **160 bits** from `crypto.getRandomValues`, base32 (RFC 4648, unpadded) only in the `otpauth://` URI. WebCrypto: `crypto.subtle.importKey("raw", seed, {name:"HMAC", hash:"SHA-1"}, false, ["sign"])`, sign the 8-byte big-endian counter, dynamic-truncate, `mod 10^6`, zero-pad, `constantTimeEqual` against the submitted string. **The seed is stored encrypted**: AES-256-GCM under `STAFF_MFA_SEAL_KEY` (32-byte Worker secret, free), IV per row, `key_version` column for a future re-wrap. Plaintext is refused because 5A's `db/export` dumps are retained and any D1 reader would otherwise mint codes for ever; a Worker secret moves that from "can read the database" to "can deploy the Worker". Missing or short seal key → 503, never plaintext fallback, never a startup-time degradation.

Replay: success requires `step > last_used_step`, enforced inside `UPDATE … SET last_used_step = ? WHERE credential_id = ? AND revoked_at IS NULL AND last_used_step < ?` with `meta.changes === 1`; the `..._step_monotonic` trigger is the backstop. Rate limits: `staff_mfa_verify` 10/ip + 5/email per 15 min, `staff_mfa_enrol` 10/ip + 3/email per hour, `staff_recovery_redeem` 10/ip + 3/email per hour — the existing `consumeLocalRateLimit` machinery, HMAC'd bucket digests, nothing stored in clear.

Recovery: **10 one-time codes**, `XXXXX-XXXXX` (50 bits, Crockford-style alphabet without `0/O/1/I/L`), issued once at enrolment confirmation, stored only as SHA-256 digests, single use by conditional `UPDATE … WHERE used_at IS NULL` + trigger, regenerated only by a fresh-assurance session or a reset (the previous set is revoked, never deleted). Redeeming a code **mints no assurance**: it revokes the current credential and returns `{next:"enrol"}`, so the next step is enrolling a new authenticator and verifying it. A paper code that grants factor replacement is the intended purpose; a paper code that grants admin access would be a weaker second factor than the TOTP it replaces. **Lost both:** a Global Admin resets (fresh TOTP assurance + CSRF + same origin, `security.manage`, cannot reset themselves), which revokes the target's credentials, codes and live sessions and returns a printed enrolment ticket; audit row `staff_mfa_reset`. If every Global Admin is locked out, the operator-run `staff:provision` script against a pinned database is the only path, and it is an owner-approved act.

Enrolment without email: the provisioning script (`apps/api/src/staff-provisioning.ts`) mints one 256-bit `staff_mfa_enrolment_tickets` digest per account and prints the ticket next to the password. A Manager signs in, uses the ticket once, enrols, verifies. **A password alone can never create a factor**, so a stolen password cannot beat the Manager to enrolment — only the printed ticket can. A Global Admin never sees a Manager's secret (rejected: administrator-side enrolment makes every Manager impersonable).

Logging: codes, seeds, `otpauthUri`, tickets, recovery codes and their digests never appear in a response outside the single one-time display, in a log line, an audit field or an error. `reason` strings on audit rows are free text and must not quote a code.

## Failure modes

| Case | Behaviour |
|---|---|
| Wrong code | 400 `invalid_code`, rate-limit bucket incremented, no assurance, no state change |
| Reused code (same step) | `last_used_step` guard changes 0 rows → 400 `invalid_code`; trigger aborts any attempt to lower it |
| Reused recovery code | 409 `recovery_code_used`, no assurance, no enrolment |
| Clock skew ≤ 30 s | Accepted (T−1/T/T+1); beyond that the code fails and the operator fixes the device, not the server |
| Lost secret (no codes) | Global-Admin reset → new ticket; access is unavailable until then, never bypassed |
| D1 unavailable | 503 before any state change; no assurance is inferred from a failed read |
| Session minted under the old label | `mfa-assurance-unsupported` (403) on every route and inside every statement guard; row kept for history |
| Attacker with the staff password only | Reaches `mfa/enrol`/`mfa/verify` only; cannot enrol (ticket required), cannot enrol over an existing credential, cannot pass the guards; sign-in is rate-limited |
| Seal key missing/short | 503 `service_unavailable` on MFA routes; admin surface closed, not downgraded |

## Acceptance criteria

1. Sign-in returns a cookie whose session row has `mfa_method IS NULL`, and every `/api/admin/*` route answers 403 `mfa-assurance-missing` for it.
2. A valid TOTP code upgrades that same session to `('totp', now)` and the next admin call succeeds.
3. Any insert with `mfa_method = 'tester-gate'` aborts, and `STAFF_MFA_ALLOWED_METHODS=tester-gate` yields 503 with no D1 read.
4. A second submission of the same code fails.
5. A code from T−2 or T+2 fails; T−1 and T+1 succeed.
6. Ten recovery codes are displayed exactly once and never again.
7. Reset revokes the target's credential, codes and sessions and audits it.
8. Learner sign-in (`/auth/local`, `/auth/google`, email link) is unchanged.

## Test plan — each fails if its guard is removed

`apps/api/test/staff-mfa.test.ts`: `sign-in mints no assurance`, `verify upgrades the session in place`, `verify rejects a replayed step` (delete the `last_used_step < ?` predicate → test must go red), `verify accepts t-1 and rejects t-2`, `verify refuses a revoked credential`, `enrolment requires a ticket`, `enrolment cannot overwrite a confirmed credential without a ticket`, `confirm returns ten codes once`, `recovery code is single-use`, `recovery mints no assurance`, `reset by a Global Admin revokes everything`, `a Manager cannot reset`.
`apps/api/test/staff-admin-access.test.ts` (amend): `tester-gate config is refused with 503`, `preflight reports testerAssuranceEnabled false`, **`tester gate cannot be reached once TOTP is enabled`** — sign in, complete TOTP, clear `ADMIN_TESTER_IPS`, and every admin route must still answer 503 from the gate; separately, insert `mfa_method='tester-gate'` via raw SQL and prove the trigger aborts.
`apps/api/test/staff-mfa-migration.test.ts`: apply `0023` over a `0022` database holding a `tester-gate` session; assert the row survives, `authorizeStaffSession` returns `mfa-assurance-unsupported`, and the trigger blocks a new one.
`apps/web/app/components/staff-mfa.test.tsx`: enrolment and verify forms, no code in a DOM error.
CPU: TOTP verify adds one HMAC and one D1 round trip; the 10 ms Free budget is *already* unproven for staff sign-in (`docs/reviews/admin-tester-access.md` §Cost), so DEV must attach a measured `wrangler` CPU figure for `verify` to the PR — I will not approve the CPU claim without it.

## Rollback or disable path

Migrations are apply-only; rollback is a *disable*, exactly as `admin-capabilities.md` §13 does it. Unset `STAFF_MFA_SEAL_KEY` or drop `totp` from `STAFF_MFA_ALLOWED_METHODS` → 503/403 with no data change (fail closed, `$0`, no deploy of new code needed only if the binding change is applied). Unmount `/admin/auth/mfa/*` to close enrolment. **Re-opening `tester-gate` requires an owner-approved migration that drops the `app_sessions_no_tester_gate_*` triggers**; I will refuse that as a "restore the weaker assurance" change unless the owner asks explicitly. The MFA tables and existing sessions are inert when the surface is disabled.

## Out of scope / flagged as not covered by a product rule

Proposed **ADR 0007 — Staff second factor, recovery and reset** covering: recovery-code count and format, reset authority, and the residual risk that a stolen ticket plus password can claim a first enrolment. `product-design.md` says only "both staff roles require MFA"; nothing in `product-design.md`, `build-plan.md`, `delivery-plan.md` or ADRs 0001–0006 covers recovery, lockout or MFA audit retention, so I am not deciding them (below).

## Owner decisions required

1. **Retention of MFA audit rows.** They inherit the flat 12-month floor and the `audit_events` prune, so a reset record disappears after a year. Extending it needs a rule and a migration.
2. **IP allowlist.** I recommend keeping `ADMIN_TESTER_IPS` as defence in depth. Separately: `stagingTesterGate` currently gates *every* staging request (`staging-app.ts:1`, `index.ts:107`), so a real learner cannot reach the app — retiring it for learner traffic is an access-policy change only you can authorise.
3. **Lockout policy.** Whether N failed verifications lock the account, for how long, who unlocks it, and whether the Global-Admin reset is the unlock. Also whether reset requires a second Global Admin to be present.
4. **`STAFF_MFA_MAX_AGE_MS`.** Recommend 8 h (= session lifetime, one verification per session) rather than a short re-prompt window.
5. **`STAFF_MFA_SEAL_KEY` and `STAFF_MFA_ALLOWED_METHODS=totp`** must be set as Worker secrets/vars — a deployment action, yours.

**Ships unattended at $0:** `0023`, the code, contracts, tests and docs, verified locally with `npm run verify`. **Needs you:** everything in the list above, plus any deploy, secret, or Cloudflare change. Email stays off, Google OAuth stays paused, staff MFA stays parked until this lands, and the "Exam Prep" → **CertPath** rename stays out of this slice.
