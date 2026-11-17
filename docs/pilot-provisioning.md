# Pilot provisioning (Phase 5C)

Status: **design approved to implement (owner, 17 November 2026); NOT approved to
run.** Nothing in this document has been executed. No Cloudflare resource exists,
no Worker is deployed, no secret is set, and every `database_id` in the
repository is still the all-zero placeholder.

This is the runbook for the one provisioning run the owner will approve later. It
is written now, with the tooling and the guards, so that the run is a sequence of
checked steps rather than an improvisation. Implementing 5C changes no
Cloudflare state; only an owner-approved execution of this document does.

## What 5C is, narrowed

5C creates **one resource**: the D1 database `certpath-learner-staging` in the
account that owns the staging Worker (`learner-auth-staging`).

It does **not** create:

- the pilot database (`certpath-pilot`) — that waits for the first real learner,
  which waits for 5F to replace the `tester-gate` assurance;
- a learner, an invited learner, a credential or a sign-in link — no real learner
  data exists until MFA replaces the tester-gate assurance
  ([`docs/delivery-plan.md`](delivery-plan.md) §Operating constraints);
- a Worker deployment, a route, a secret or a var change. The staging Worker's
  vars and the `PILOT_*` / `COMMERCE_ENABLED` flags are untouched.

The original slice plan also seeded one invited learner and exported the pilot
database "before its first migration". Both were withdrawn by the owner on
17 November 2026: the learner contradicts the operating constraint above, and a
pre-migration export of a virgin database is empty by definition (see
[`docs/data-export-and-restore.md`](data-export-and-restore.md) §The first
export).

## The order

Do not reorder these steps. Each one is a prerequisite for the next, and the
guards are placed so a skipped step fails rather than passes.

| # | Step | Guard or proof |
|---|---|---|
| 1 | Preflight: account matches, database absent | `npm run db:preflight -- --expect-account <id> --database certpath-learner-staging --expect-absent` |
| 2 | Create the database | `wrangler d1 create certpath-learner-staging` prints the uuid |
| 3 | Record the uuid **locally**, apply the chain | `d1_migrations` must equal `db/migrations/*.sql` |
| 4 | Repo PR with the uuid, merged and pulled | the isolation gate and the export run against the committed config |
| 5 | Preflight again: database present | `--expect-present` |
| 6 | Export #1 (first non-empty baseline) | `db:export --target staging` writes dump + manifest |
| 7 | Rehearse #1 | `db:rehearse` restores it into a scratch local database |
| 8 | Apply the smoke fixture | `db/fixtures/synthetic-provision-smoke.sql` |
| 9 | Export #2 | the first data-bearing dump |
| 10 | Rehearse #2 | the first rehearsal that has seen a real row |

### 1. Preflight

From the repository root:

```powershell
npm run db:preflight -- --expect-account <account-id> --database certpath-learner-staging --expect-absent
```

The expected account id is passed **only** as `--expect-account`; it is never
read from the environment or from a config. On success the output is exactly
three lines and nothing else:

```
account: <account name> (<account-id>)
database certpath-learner-staging: absent
preflight ok
```

The command is read-only. It runs `wrangler whoami --json` and
`wrangler d1 list --json`, asserts the account and the database, and prints
neither the raw payload nor a token.

| Exit | Code | Meaning |
|---|---|---|
| 0 | — | both assertions true |
| 1 | `account_env_mismatch` | `CLOUDFLARE_ACCOUNT_ID` is set and disagrees with `--expect-account` |
| 1 | `account_mismatch` | the expected id is not among the accounts this credential can see |
| 1 | `database_already_exists` | `--expect-absent` was asserted and the database exists |
| 1 | `database_missing` | `--expect-present` was asserted and the database is gone |
| 1 | `preflight_unparsed` | Wrangler's answer could not be read, so no assertion ran |
| 2 | usage | a missing or conflicting option |
| 4 | `remote_auth_failed` | Wrangler was not authenticated |

`preflight_unparsed` on an authentication failure you expected to be
`remote_auth_failed` is reported honestly: the script reuses the shared
`isAuthFailure` wording check, and a credential problem phrased differently is
still a refusal, never a pass.

#### Account-ID remediation

Wrangler resolves the account from the config, then `CLOUDFLARE_ACCOUNT_ID`, then
its stored selection. An id left in the shell therefore wins over the account the
operator selected interactively, and every later write lands in the wrong
account. When the preflight reports `account_env_mismatch`:

1. `Remove-Item Env:\CLOUDFLARE_ACCOUNT_ID` (or set it to the expected id);
2. re-run `wrangler whoami` and confirm the account name;
3. re-run the preflight.

Do not "fix" it by changing `--expect-account` to whatever the environment
variable says.

### 2. Create

```powershell
Set-Location apps\web
npx wrangler d1 create certpath-learner-staging
Set-Location ..\..
```

`wrangler d1 create` prints the new uuid and a config snippet. Copy **only** the
`database_id` value. Nothing else in the config changes: the binding stays `DB`,
the `database_name` stays `certpath-learner-staging`, and the migration directory
stays `../../db/migrations`.

If the command reports that the database already exists, stop. That is the
`--expect-absent` assertion having been wrong, and nothing else in this runbook is
safe to continue with.

### 3. Record the uuid locally and apply the chain

The migration step reads the config, and Wrangler needs a real id there, so the
uuid is written into `apps/web/wrangler.staging.jsonc` **locally** first. That
edit is not the repo PR: it is an uncommitted change that exists only so step 3
can run.

```powershell
Set-Location apps\web
npx wrangler d1 migrations apply certpath-learner-staging --remote -c wrangler.staging.jsonc
Set-Location ..\..
```

Expect every file in `db/migrations/` to be listed as applied, in order, and no
more. Record the count.

### 4. Repo PR with the uuid

The only repository change is the `database_id` value in
`apps/web/wrangler.staging.jsonc`. That PR must record, in its body: the migration
count applied, and the preflight output lines. It must not contain a dump, a
manifest or a row value.

The PR must pass `npm run verify`; the isolation gate then proves the new id
appears in exactly one config.

### 5. Preflight again

```powershell
npm run db:preflight -- --expect-account <account-id> --database certpath-learner-staging --expect-present
```

Expected:

```
account: <account name> (<account-id>)
database certpath-learner-staging: present (<uuid>)
preflight ok
```

### 6–7. Export #1 and rehearsal #1

```powershell
npm run db:export -- --target staging --out D:\certpath-exports
npm run db:rehearse -- --file D:\certpath-exports\certpath-learner-staging-<UTC>.sql
```

Export #1 is the **first non-empty baseline**: the schema and the
`d1_migrations` ledger are already in it, and no application row is. There is no
pre-migration export because a virgin database exports to nothing and `db:export`
exits `1 empty_export` rather than publish a dump that proves nothing.

Rehearsal #1 must report `integrity_check ok`, an empty foreign-key check and
counts equal to the manifest.

Before accepting the manifest, diff its `migrations[]` against the files by hand:

```powershell
Get-Content D:\certpath-exports\certpath-learner-staging-<UTC>.sql.manifest.json |
  Select-String -Pattern '"\.sql"'
Get-ChildItem db\migrations\*.sql | Select-Object -ExpandProperty Name
```

The rehearsal does not compare the manifest's migration list with the repository
(issue #103), so this manual diff is the only provenance check in 5C.

### 8. Apply the smoke fixture

```powershell
Set-Location apps\web
npx wrangler d1 execute certpath-learner-staging --remote -c wrangler.staging.jsonc `
  --file ..\..\db\fixtures\synthetic-provision-smoke.sql
Set-Location ..\..
```

The fixture is synthetic: one `users` row, one `certifications` root, one
`exam_versions` row and one `domains` row, with fixed fixture constants and no
personal data or exam content. It is deliberately not a migration and CI never
applies it.

It writes more than four rows: the `exam_versions` and `domains` inserts fire
`exam_versions_audit_insert`, `domains_audit_insert` and
`exam_versions_create_timed_mock_profile`. Three `audit_events` rows and the
default `timed_mock_profiles` row are part of the expected result.

If the database now refuses a DELETE, that is the schema working: certification
roots are immutable and audit is append-only. **Drop the database, never empty
it.**

### 9–10. Export #2 and rehearsal #2

```powershell
npm run db:export -- --target staging --out D:\certpath-exports
npm run db:rehearse -- --file D:\certpath-exports\certpath-learner-staging-<UTC>.sql
```

Rehearsal #2 is the first rehearsal with a data-bearing dump in it: four
application rows, three audit rows and one timed-mock profile, plus the ledger.

#### Trigger replay and dump ordering are the unknown, and they are a stop condition

`wrangler d1 export` writes `CREATE TABLE` statements and `INSERT` statements in
schema order. Two things can go wrong when that dump is replayed, and neither has
been observed against a remote D1:

1. **Ordering.** `audit_events` is created before `certifications` in
   `0002_local_security.sql`, and its rows carry a `certification_id` foreign
   key. A dump that contains audit rows therefore inserts into `audit_events`
   before the `certifications` table exists. `PRAGMA defer_foreign_keys=TRUE` at
   the top of the dump does not help: the parent table has to exist for the
   deferred check to be set up at all. This is reproducible locally today — a
   dump of a local database carrying this fixture fails the rehearsal with
   `no such table: main.certifications` (`dump_load_failed`).
2. **Trigger replay.** Restoring the fixture's `certifications`, `exam_versions`
   and `domains` rows re-fires `certifications_audit_insert`,
   `exam_versions_audit_insert`, `domains_audit_insert` and
   `exam_versions_create_timed_mock_profile`, which would insert the audit rows a
   second time under the same `operation_id`; `audit_events_no_replace` aborts on
   a repeated key. This sits behind problem 1 and has not been reached.

**If rehearsal #2 fails, stop.** Do not edit the dump, do not drop the trigger, do
not re-key the audit rows, do not load with foreign keys disabled, and do not
declare the export "restorable with a caveat". Record the exact error, keep both
dumps and both manifests, and escalate: the next move (accepted limitation, a
documented restore order, or a change to the export strategy) is an architecture
decision, not an operator workaround. The first finding above means the expected
outcome of step 10 on the current tooling is a stop, not a green rehearsal.

## Time Travel

D1 Time Travel keeps **7 days** of history on the Free plan; the 30-day window is
a paid-plan feature. Under the $0 stop rule below, 7 days is the whole recovery
window: a bad write found on day 8 cannot be rolled back, only restored from a
dump.

No Time Travel restore has been rehearsed, and this runbook does not include one.
A Time Travel restore is a remote write and needs its own approval.

## The $0 stop rule

This slice must cost nothing. It stays on the Free plan: no Workers Paid
upgrade, no payment method, no Time Travel extension, no D1 storage/read/write
overage.

Any of the following is a **stop condition**, not an invitation to upgrade:

- a command says a feature requires a paid plan;
- a quota message appears (D1 rows read/written, storage, export size);
- the dashboard shows a charge or a pending charge;
- anything asks for billing details.

Record the message, stop, and escalate to the owner. A $0 run that stops is a
result; a $12 run that continues is a decision nobody made.

## Teardown

The staging database is disposable until the first real learner exists, and it
can never be emptied, only dropped:

```powershell
Set-Location apps\web
npx wrangler d1 delete certpath-learner-staging
Set-Location ..\..
```

Export first if the state is worth keeping, and keep dump + manifest together
([`docs/data-export-and-restore.md`](data-export-and-restore.md) §Retention).

A deleted database's id is dead, so the teardown PR must either record the new id
(after a recreate) or revert `apps/web/wrangler.staging.jsonc` to the
placeholder. Which one applies is the owner's call at teardown time; do not merge
a teardown that leaves the config pointing at an id that no longer exists.

After teardown, `db:export --target staging` exits `3 d1_not_provisioned` again —
that is the correct state for a repository that has no staging database.

## What this proves, and what it does not

Proven by a completed run:

- the chain applies to a remote D1 through Wrangler, in order, and the ledger
  matches `db/migrations/*.sql`;
- the account and database assertions run against the real API and fail closed;
- export #1 is a real, non-empty dump of a migrated database, with a manifest
  whose hash and counts match it;
- rehearsal #1 restores that dump into a scratch database with matching counts;
- the provisioned database accepts a synthetic write and its triggers fire;
- export #2 contains rows, and rehearsal #2 has been attempted against a
  data-bearing dump.

Not proven, and not claimed:

- **no remote restore** — no dump has been restored into a remote D1, only into a
  local scratch database;
- **no data-bearing restore** — the 5A round trip is proven with zero rows, and a
  dump carrying the smoke fixture fails the local rehearsal on dump ordering (see
  the stop condition above), so no dump with audit rows has ever loaded;
- **no concurrency** — no writer was active during an export, so nothing is known
  about a dump taken while rows are being written;
- **no Time Travel restore** — the 7-day window is stated, not exercised;
- **no dump provenance check** (issue #103) — the rehearsal proves the dump
  matches its manifest, not that the manifest belongs to this schema; the
  operator diffs `migrations[]` by hand in step 6;
- **no learner, no sign-in, no Worker, no real data** — 5C creates a database and
  nothing else.
