# Tester-only production admin rollout

**Status:** Plan only, prepared for review. No account was provisioned, no Worker
was deployed, no password was created, and no production admin panel exists.
**Scope:** the tester-only staff admin surface on Workers Free, with two individual
Global Admin accounts and one Manager scoped to a single synthetic exam.
**Keep-out list:** the public site (`certpath-site`) and the demo
(`certpath-ui-preview`) stay live at $0 and are not redeployed; email stays off;
Google OAuth stays paused; staff MFA stays parked.

## Evidence this plan rests on

| Record | Result |
|---|---|
| Password-free readiness probe | HTTP 200, both readiness flags true ([probe](admin-staff-signin-trace-probe.md)) |
| **Isolated staff workflow** | **Passed.** One synthetic Global Admin signed in over HTTPS with unchanged scrypt (HTTP 200 plus a session), created a synthetic question, saved an edit as revision 2, and retrieved the edited text on reload; a separate revision-detail read returned the same edit; D1 held two revisions |
| **Worker CPU** | **Unmeasured.** Workers Observability returns HTTP 403 to the current credential, so no `cloudflare.cpu_time_ms` value was ever verified. No CPU-limit error occurred in either run |
| Temporary resources from those runs | Deleted and confirmed gone through Cloudflare inventory |

The workflow proves the admin sign-in and content path work. It does **not** prove
a CPU number, a production account model, or the Manager denial boundary on
production data — those are what this rollout adds.

## Targets

| Target | Value |
|---|---|
| Account | `Certpath`, account id `ef67137c4d1556f7f51f1cb3f1f420f3` |
| Admin Worker | `certpath-foundation` - the name in the committed [`apps/web/wrangler.jsonc`](../../apps/web/wrangler.jsonc) |
| Admin D1 | **`certpath-admin`** - a dedicated tester database, not the committed `certpath-local` binding. Its `database_id` stays the recorded placeholder `<certpath-admin UUID>` until the approved provisioning step records the real UUID |
| Planned hostname | `certpath-foundation.<workers.dev subdomain>.workers.dev` (currently `certpath`) |
| Public site and demo | `certpath-site`, `certpath-ui-preview` - **not targets** |

Read-only inventory on 14 November 2026: Workers are `certpath-site`,
`certpath-staff-mfa-sandbox`, and `certpath-ui-preview`; the only D1 database is
`certpath-staff-mfa-sandbox`. **Neither `certpath-foundation` nor `certpath-admin`
exists yet.** The committed [`apps/web/wrangler.jsonc`](../../apps/web/wrangler.jsonc)
still binds `DB` to `certpath-local`; the approved rollout repoints that binding to
`certpath-admin` and its recorded UUID at deploy time. Creating both resources is an
approval item, not an assumption in this document.

Record **before** creating anything, so a partial rollout can still be reverted and
every later command can be pinned:

| Record | Value |
|---|---|
| Account | `Certpath` / `ef67137c4d1556f7f51f1cb3f1f420f3` |
| Worker name | `certpath-foundation` |
| Planned hostname | `https://certpath-foundation.<subdomain>.workers.dev` |
| D1 name | `certpath-admin` |
| **D1 UUID** | `<certpath-admin UUID>` - placeholder until the create step returns it |
| Operator egress IPs | the addresses that will appear as `cf-connecting-ip` |

Record **after**: Worker version id and deployment id, the real `certpath-admin`
UUID, the three tester `user_id` values, and the timestamp of the first sign-in.

### Provisioning preconditions the command must enforce

The provisioning command must abort **before the first write** unless both checks
pass:

```powershell
$env:CLOUDFLARE_ACCOUNT_ID='ef67137c4d1556f7f51f1cb3f1f420f3'
npx wrangler whoami                          # must print: Certpath | ef67137c4d1556f7f51f1cb3f1f420f3
npx wrangler d1 info certpath-admin --json   # .result.uuid must equal the recorded <certpath-admin UUID>
```

A wrong account, a differently named database, or any other UUID is a hard stop -
writing staff credentials into the wrong database is unrecoverable. The same two
values are pinned on every later `wrangler d1 execute` call for this rollout.

## Tester gate

The gate covers `/admin`, `/admin/*`, `/api/admin`, and `/api/admin/*`, and runs
before any handler.

| Variable | Value | Effect |
|---|---|---|
| `ADMIN_TESTER_IPS` | comma-separated operator egress IPs | empty ⇒ **every** admin page and API returns `503`; an unlisted caller gets `403` |
| `ADMIN_TESTER_ASSURANCE` | `"true"` | required for the tester assurance method to be accepted |
| `ADMIN_TESTER_LOCAL` | **unset** | leave unset outside local development |

Pages and APIs also send `X-Robots-Tag: noindex, nofollow` and
`Cache-Control: no-store`. The gate is a tester convenience, **not** an
authorization boundary: every admin API still requires a staff session, and the
content API enforces exam scoping server-side.

## Temporary staff assurance policy - flagged for approval

While staff MFA is parked, sign-in accepts the `tester-gate` assurance method. This
is a deliberate, temporary widening and needs explicit owner approval:

- `STAFF_MFA_ALLOWED_METHODS=tester-gate` together with `ADMIN_TESTER_ASSURANCE=true`
  and a non-empty `ADMIN_TESTER_IPS` is the only combination the configuration
  parser accepts for this method; anything else makes the whole admin surface
  return `503`.
- `STAFF_MFA_MAX_AGE_MS=900000` (15 minutes) bounds how long the assurance is
  treated as fresh; staff sessions themselves last 8 hours.
- `PUBLIC_SITE_ORIGIN` must be the exact `https` origin of the Worker
  (`https://certpath-foundation.<subdomain>.workers.dev`), with no path, query, or
  trailing content.
- `CSRF_HMAC_SECRET` must be at least 32 bytes, and `STAFF_RATE_LIMIT_HMAC_SECRET`
  must be present for rate limiting. Both are fresh random values stored as Worker
  secrets, never in the repository, a shell history, a log, or this PR.

**Approval flag:** turning on `tester-gate` is a standing exception to "MFA
required for staff". Approving this rollout approves that exception for the tester
period only. Removing it means switching to a real MFA method, deleting the
`tester-gate` allowance, and redeploying.

## Accounts

| Account | Role | Scope |
|---|---|---|
| Global Admin 1 | `global_admin` | all certifications |
| Global Admin 2 | `global_admin` | all certifications |
| Manager 1 | `manager` | **one** synthetic certification only, via `manager_certification_assignments` |

Two individual accounts exist so no single mailbox is the only way in. The Manager
exists to prove exam scoping on real infrastructure. **Exactly these three accounts
are provisioned** - no shared mailbox, no `admin@`-style alias, no extra tester, and
no fourth account for convenience. Their three `user_id` values become the scope for
every rollback statement.

Passwords: **fresh, unique per account, entered privately during the approved
provisioning step** - hidden prompt or stdin, never a command-line argument, never
captured in a transcript, never written to a file. The provisioning script enforces
16-1024 characters, at least three of lower case/upper case/digits/symbols, no
containment of the email local part, and no reuse across the three accounts.

**Provisioning path.** `npm run staff:provision`
(`apps/api/scripts/provision-staff-accounts.ts`) supports an explicit remote mode:
`--remote --expect-database-id <recorded certpath-admin UUID>`. It resolves
`certpath-admin` by name **once**, checks `wrangler whoami --json` for the Certpath
account and `wrangler d1 info certpath-admin --json` for the exact UUID, then writes
that UUID into a run-only Wrangler config and performs **every** later read and write
through that binding - so a database swapped behind the name after the check
receives nothing. It aborts with zero writes on a wrong account, a wrong database
name, a wrong UUID, a missing UUID, or an existing tester account or synthetic
certification. Local mode stays the default. Running it against the production
database is still an owner-approved step, and the remote path has so far been
exercised only by tests that mock the Cloudflare CLI against an isolated D1 - never
against the real database.

The script seeds exactly one synthetic certification and exam version
(`--certification-slug`, `--certification-name`, `--exam-version-key`) and assigns
the Manager to it, so the Manager's entire scope is synthetic data.

## Read-only Workers Free capacity checks

Run before any provisioning. Every command below is a read.

| Check | Command | Blocking condition |
|---|---|---|
| Account pin | `wrangler whoami` | not `Certpath` / `ef67137c4d1556f7f51f1cb3f1f420f3` |
| Plan is Workers Free | signed-in dashboard plan and subscription view | plan cannot be confirmed in the dashboard, or any paid subscription shows |
| Worker capacity | `GET /accounts/{account_id}/workers/scripts` or dashboard script list | no free script slot |
| D1 capacity | `GET /accounts/{account_id}/d1/database` or dashboard D1 list | no free database slot |
| Request quota | GraphQL `workersInvocationsAdaptive`, previous 24 h | less headroom than the rollout plus check requests need |
| D1 quota | GraphQL `d1AnalyticsAdaptiveGroups`, previous 24 h | less headroom than the rollout's writes need |
| Name collisions | same two inventories, filtered for the target names | a `certpath-foundation` or `certpath-admin` already exists that this plan did not account for |
| Telemetry | Workers Observability reachable for the account | traces cannot be read - CPU will stay unmeasured and must be reported as such |

Measured on 14 November 2026: 3 Workers, 1 D1, 125 Worker requests in the day, 8,654
D1 rows read and 1,742 written. All well inside Free limits.

**Credential caveats found during the runs:** the current OAuth session answers
`403` for `subscriptions`, `billing`, Workers Observability, and the KV namespace
probe, and `wrangler delete` therefore exits non-zero *after* deleting a Worker.
The dashboard plan check is mandatory; inventory, not a delete exit code, is what
confirms a resource is gone.

## Post-deploy checklist

Short by design - one pass, no probes.

1. **Global Admin 1 signs in** at `/admin/sign-in` over HTTPS: `200`, session
   cookie set, redirect to `/admin/question-editor`.
2. **Global Admin 1 edits a synthetic question** and reloads: the edited text comes
   back and the revision number increased.
3. **Global Admin 2 signs in** and can open the same synthetic exam.
4. **Manager signs in**: can read and edit the assigned synthetic exam.
5. **Manager denials**, each expected `404`:
   `GET /api/admin/content/certifications/<other-cert>/exam-versions` for a
   certification the Manager is not assigned, `GET /api/admin/staff`, and
   `GET /api/admin/payments`.
6. **Record** the request count and any `1102` / `exceededCpu`. Worker CPU remains
   unmeasured until Observability access exists; report it as unmeasured, never as
   a passing number.
7. If sign-in fails, a Worker limit is hit, or a denial returns something other than
   `404`, stop and roll back rather than retrying.

## Rollback

Order matters: close the gate first so nothing new can be authorized, then unwind
the three recorded tester identities. Every statement below is scoped to the three
recorded `user_id` values - `<ga1-id>`, `<ga2-id>`, `<manager-id>` - never to "all
staff", never by email pattern, never by role membership.

1. **Close the tester gate first (seconds).** Blank `ADMIN_TESTER_IPS` and redeploy
   the admin Worker. Every admin page and admin API returns `503` from that moment;
   the public site and demo are untouched. Do this before anything else - the steps
   below assume no new request can authenticate.
2. **Revoke tester sessions with a unique operation ID per session.**

   ```sql
   UPDATE app_sessions
      SET revoked_at = <now>,
          revocation_operation_id = 'rollback:session:' || token_digest,
          revoked_by_user_id = user_id
    WHERE revoked_at IS NULL
      AND user_id IN ('<ga1-id>', '<ga2-id>', '<manager-id>');
   ```

   The suffix is `token_digest`, unique per session, because
   `app_sessions.revocation_operation_id` is `UNIQUE` **and** the
   `app_sessions_audit_revoke` trigger writes that same value into
   `audit_events.operation_id`, which is unique as well. A single shared nonce for
   all sessions fails with `UNIQUE constraint failed` and revokes nothing.
   `WHERE revoked_at IS NULL` leaves already-revoked sessions and their history
   untouched.
3. **Disable sign-in for those three accounts.**

   ```sql
   DELETE FROM staff_password_credentials
    WHERE user_id IN ('<ga1-id>', '<ga2-id>', '<manager-id>');
   ```

   The scoped `WHERE` is what keeps unrelated staff credentials alive.
4. **Retire the roles.**

   ```sql
   UPDATE staff_roles
      SET active = 0,
          changed_by_user_id = NULL,
          changed_by_ref = 'rollback',
          operation_id = 'rollback:role:' || user_id,
          reason = 'Tester rollout rollback',
          changed_at = <now>
    WHERE user_id IN ('<ga1-id>', '<ga2-id>', '<manager-id>')
      AND active = 1;
   ```

5. **Retire the Manager's assignment.**

   ```sql
   UPDATE manager_certification_assignments
      SET active = 0,
          changed_by_user_id = '<ga1-id>',
          operation_id = 'rollback:assignment:' || manager_user_id,
          reason = 'Tester rollout rollback',
          changed_at = <now>
    WHERE manager_user_id = '<manager-id>'
      AND certification_id = '<synthetic certification id>'
      AND active = 1;
   ```

   `changed_by_user_id` is `NOT NULL` on this table (unlike `staff_roles`), so it
   must name an existing user; the rehearsal used the first Global Admin's ID. The
   table's audit trigger records `manager_assignment_revoked`.
6. **Remove the temporary policy.** Delete `tester-gate` from
   `STAFF_MFA_ALLOWED_METHODS`, set `ADMIN_TESTER_ASSURANCE` to `false`, and
   redeploy so the admin surface fails closed on configuration as well as on the
   allowlist.
7. **Rotate secrets.** Replace `CSRF_HMAC_SECRET` and
   `STAFF_RATE_LIMIT_HMAC_SECRET` if either may have been exposed.
8. **Verify, scoped.**

   ```sql
   SELECT
     (SELECT COUNT(*) FROM app_sessions
       WHERE revoked_at IS NULL
         AND user_id IN ('<ga1-id>', '<ga2-id>', '<manager-id>')) AS tester_active_sessions,
     (SELECT COUNT(*) FROM app_sessions
       WHERE revoked_at IS NULL
         AND user_id NOT IN ('<ga1-id>', '<ga2-id>', '<manager-id>')) AS unrelated_active_sessions,
     (SELECT COUNT(*) FROM staff_password_credentials
       WHERE user_id IN ('<ga1-id>', '<ga2-id>', '<manager-id>')) AS tester_credentials,
     (SELECT COUNT(*) FROM staff_roles
       WHERE active = 1
         AND user_id IN ('<ga1-id>', '<ga2-id>', '<manager-id>')) AS tester_active_roles,
     (SELECT COUNT(*) FROM manager_certification_assignments
       WHERE active = 1
         AND manager_user_id = '<manager-id>') AS tester_active_assignments;
   ```

   The four tester columns must read `0`; `unrelated_active_sessions` must equal the
   reading taken before rollback. Also confirm admin paths return `503`,
   `certpath-site` and `certpath-ui-preview` return `200`, and inventory matches the
   recorded targets.

### Rollback rehearsal (local D1, no cloud resources)

On 14 November 2026 the statements above were run against an isolated local D1
database (`--local --persist-to <temp dir>`, migrations `0001`-`0012`). The scenario
had five users - the three testers plus one unrelated staff account with its own
credential, role, assignment, and sessions, and one learner - and ten sessions: six
tester sessions (two each, all active), three unrelated active sessions, and one
tester session already revoked.

| Observation | Result |
|---|---|
| Single shared operation ID for all tester sessions | **Failed**: `UNIQUE constraint failed: app_sessions.revocation_operation_id`, zero rows changed |
| Per-session operation IDs | 6 tester sessions revoked, **6 distinct** `revocation_operation_id` values |
| Tester active sessions after rollback | **0** |
| Unrelated active sessions after rollback | **3** - preserved |
| Already-revoked tester session | operation ID unchanged (`pre-existing-revocation`) |
| Credentials left | **1** - the unrelated staff account |
| Active roles / assignments | **1 / 1** - the unrelated account's |
| User rows | **5** - nothing deleted |
| Audit | 1 `manager_assignment_revoked` event written by the assignment trigger |

Re-run it with any local tooling: apply the migrations to an isolated local
database, insert the roles/credentials/sessions above, run steps 2-5, and compare the
same counts. No Cloudflare resource is involved.

## Approvals needed before execution

- [ ] Target Worker and D1: create `certpath-foundation` + the dedicated
      `certpath-admin` database and record its UUID
- [ ] Operator egress IPs for `ADMIN_TESTER_IPS`
- [ ] The temporary `tester-gate` assurance policy while MFA is parked
- [ ] The two Global Admin addresses and the one Manager address (individuals, not
      shared mailboxes)
- [ ] The remote provisioning path for production D1
- [ ] Workers Free capacity readings re-confirmed in the dashboard at execution time

## Invariants

No product rule changes: exactly two staff roles, exam-scoped Managers, server-side
authorization, and no personal data or real paid question content. No credentials in
the repository. Provisioning and deployment each require explicit approval, and
until then this document is the only deliverable.
