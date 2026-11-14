# Tester-only production admin panel

**Status:** Implemented for local review in a draft pull request. No worker was
deployed, no production database was touched, and no production account exists.
**Scope:** The real admin pages and APIs behind one tester gate and real staff
sign-in, with a provisioning script for two individual Global Admins and one
exam-scoped Manager.
**Unchanged:** Public site and demo (both $0), learner sign-in, Google OAuth
(paused), email delivery (off), staff MFA (parked, see below).

## Goal

Make the existing protected admin panel reachable only by approved testers,
authenticated as individual staff accounts, while keeping every existing
authorization rule in place server-side.

## Access path

| Layer | Rule |
|---|---|
| Tester gate | `ADMIN_TESTER_IPS` allowlist on every `/admin`, `/admin/*`, `/api/admin`, `/api/admin/*` request. Empty allowlist closes the surface with `503`. A client IP outside the list gets `403` before any handler runs. |
| Page gate | After the allowlist, `/admin/*` pages require a live application session for an account with an active staff role; otherwise `307` to `/admin/sign-in`. |
| Staff sign-in | `POST /api/admin/auth/sign-in` with a staff email and password: exact origin, rate limits, scrypt verification, session cookie, audit event. |
| Authorization | Unchanged `authorizeStaffSession` / `authorizeCertification`: active session, active staff role, MFA policy, and (for Managers) an active certification assignment. |
| Local-only tester mode | `ADMIN_TESTER_LOCAL=true` additionally allows loopback requests without a platform client IP and permits an `http://localhost` origin. Both remain impossible in a deployed configuration. |

The gate is evaluated in `apps/web/workers/app.ts` before the API or the router
handler, and again inside the staff-auth router. `apps/api/src/security/admin-gate.ts`
holds the single implementation.

## Staff sign-in

- Credentials live in `staff_password_credentials` (one row per staff account,
  unique normalised email, scrypt hash only). A credential is only accepted for
  an account that currently holds an active staff role.
- The hash is produced offline by the provisioning script. The Worker never
  creates hashes on a request path.
- Rate limits: 10 attempts per IP and 5 per address per 15 minutes, counted
  before the password check.
- Success writes the session and the `staff_signed_in` audit event in one D1
  batch. Failures return one generic `invalid_credentials`, and an unknown
  address still performs a dummy hash so timing does not reveal account
  existence.
- Sessions are the existing opaque cookie (`certpath_session` on `http`,
  `__Host-certpath_session` on `https`), HttpOnly, SameSite=Lax, eight hours.

## Tester assurance (parked staff MFA)

Both staff roles must satisfy an MFA policy; `getMfaFailure` fails closed when no
policy exists. Real MFA factors are parked, so this slice adds one explicitly
labelled method, `tester-gate`:

- Sign-in stamps `mfa_method = 'tester-gate'` and `mfa_verified_at = now`.
- The protected API only accepts that method when `STAFF_MFA_ALLOWED_METHODS`
  lists `tester-gate` **and** `ADMIN_TESTER_ASSURANCE=true` **and** the tester
  allowlist is non-empty. Otherwise `readStaffSecurityConfiguration` returns
  nothing and every admin API answers `503`.
- Sign-in itself refuses to mint a session when the assurance is not enabled, so
  a production configuration without the flag cannot produce a usable staff
  session at all.
- Every such session is auditable by method, and the assurance expires with
  `STAFF_MFA_MAX_AGE_MS`.

This is a deliberate, reviewable deviation from “both staff roles require MFA”.
It must be replaced by an approved factor before any non-tester use, and the
flag must never be enabled outside the tester deployment.

## Provisioning

`apps/api/scripts/provision-staff-accounts.ts` (run with `tsx`):

```
npx tsx apps/api/scripts/provision-staff-accounts.ts \
  --admins "owner@example.test,deputy@example.test" \
  --manager editor@example.test \
  --certification-slug synthetic-pilot
```

- Creates exactly three accounts: two individual Global Admins and one Manager,
  the synthetic certification, one exam version, and the Manager's assignment to
  that certification only.
- Passwords are typed privately at a hidden terminal prompt (repeat-to-confirm),
  or supplied as three lines on stdin for automation. They are never accepted as
  arguments, never echoed, never logged, and never written anywhere except as a
  scrypt hash in D1.
- Validation: at least 16 characters, at least three character classes, no
  account name inside the password, and three different passwords.
- Refuses to run when any address or the certification slug already exists.
- **Local database only.** `--remote` is rejected; remote provisioning is a
  separate, owner-approved step after review.
- Output lists only emails, user ids, and the certification/version ids. The
  operator is told to store the passwords immediately because they cannot be
  recovered.

## Verification performed

```
npm run verify                                 passed (typecheck, api 153 + 31, web 102, build)
apps/api: npx vitest run staff-admin-access     11 passed
apps/api: npx vitest run admin-gate              5 passed
apps/web: tsx --test staff-sign-in.test.tsx      3 passed
npm run db:migrate:local                        0012 applied
npx tsx apps/api/scripts/provision-staff-accounts.ts --password-stdin
                                               3 accounts + synthetic exam created
```

Local Worker run (`npm run dev` with the tester bindings):

| Check | Result |
|---|---|
| `GET /admin/question-editor` without a session | `307` to `/admin/sign-in` |
| `GET /admin/sign-in` | `200`, noindex, staff form in server HTML |
| `POST /api/admin/auth/preflight` | `{"signInEnabled":true,"testerAssuranceEnabled":true}` |
| Preflight from a non-allowlisted IP | `403` |
| `/api/admin/content/certifications` without a session | `401` |
| Global Admin sign-in | session + audit, `/session` shows both provisioned certifications |
| Manager sign-in | `/session` and `/certifications` show only the assigned exam |
| Manager on the unassigned exam | `404` on direct exam-version and domain requests |
| Global Admin on the assigned exam | `200` list, `201` domain creation with CSRF |
| `/api/admin/staff`, `/api/admin/payments` | `404` |
| `/`, `/exams`, `/api/health` | `200`, unchanged |

The API test suite additionally covers: closed gate, foreign IP before any D1
write, sign-in without assurance, wrong password, wrong origin, unknown account,
non-staff account, rate limiting, tester assurance recorded on the session,
both Global Admins creating and reading the same exam content, Manager scoping
on lists and direct IDs, absent staff/billing routes, missing session, and a
stale assurance (`403`).

## Workers Free capacity check

Measured values already recorded in this repository:

| Item | Value | Budget | Verdict |
|---|---|---|---|
| scrypt hash creation (`N=32768, r=8, p=1`) | 263,522 µs CPU | 10,000 µs | 26× over — **off the request path**; provisioning runs in Node |
| scrypt verification (same profile) | 19–20 ms CPU | 10,000 µs | over budget — **does not fit Workers Free** |
| Gate + session + role/assignment checks | D1 I/O bound | — | fits; no extra CPU-heavy work |
| New Workers | 0 (existing Worker) | 100 scripts | fits |
| New D1 databases | 0 (existing database) | 10 databases | fits |
| Email, KV, R2, Queues, paid features | none | — | fits, stays $0 |

**Conclusion:** the tester gate, page redirect, and admin APIs fit Workers Free,
but staff password verification does not fit the 10 ms CPU budget at the current
scrypt profile. Deployment therefore requires one of: the existing SigV4 Lambda
verifier path already built for the staging learner (not $0), an approved paid
plan, or an approved KDF change. The `createStaffAuthApi(now, verifyPassword)`
factory takes the verifier as an argument precisely so that decision does not
require rewiring the route. The measurement that would confirm this on the full
HTTPS request path is specified in the [staff sign-in CPU
runbook](admin-staff-signin-cpu-runbook.md); it is a plan only and has not been
executed. Its first step, the Workers Traces probe that must pass before any
password is submitted, is prepared for review in the [Workers Traces
probe](admin-staff-signin-trace-probe.md).

## Rollback steps

1. **Close the panel (seconds).** Blank `ADMIN_TESTER_IPS` and redeploy. Every
   admin page and admin API returns `503`; the public site and demo are
   unaffected.
2. **Revoke staff sessions.** One statement per account or one set-based update:
   `UPDATE app_sessions SET revoked_at = <now>, revocation_operation_id =
   'rollback:<nonce>', revoked_by_user_id = user_id WHERE revoked_at IS NULL AND
   user_id IN (SELECT user_id FROM staff_roles WHERE active = 1)`.
3. **Disable sign-in.** `DELETE FROM staff_password_credentials` (or delete only
   the tester rows) so no password can mint a session.
4. **Retire the roles.** Deactivate `staff_roles` and
   `manager_certification_assignments`; in normal operation use the audited
   mutation service rather than direct SQL.
5. **Revert the Worker.** Redeploy the previous version if a code regression is
   suspected; `audit_events` is append-only, so rollback never rewrites history.
6. **Confirm.** `/admin*` answers `503` (gate closed) and `/api/admin/*` answers
   `503`; an old staff cookie answers `401`; `/`, `/exams`, `/api/health` still
   answer `200`.

## Review questions

1. Approve or reject the `tester-gate` assurance for tester-only use, and name
   the replacement factor and its target milestone.
2. Choose the staff password verification host (Lambda verifier vs paid plan vs
   approved KDF) so sign-in can run inside the CPU budget.
3. Confirm the tester allowlist contents and who may change them.
4. Decide whether the panel keeps the trust boundary of the existing Worker and
   database (chosen here) or moves to an isolated tester Worker later.
