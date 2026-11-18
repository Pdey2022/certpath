# Pilot provisioning (Phase 5C)

Status: **the 5C run completed on 17 November 2026, under owner approval given
that day; further provisioning is NOT approved to run.** The run produced one
Cloudflare resource: the D1 database `certpath-learner-staging`, created on
17 November 2026 at 22:25:00Z in region `WEUR` and migrated through
`0021_pilot_events.sql` (21 applied migrations at the end of that run:
`SELECT COUNT(*), MAX(name) FROM d1_migrations` answered `21` and
`0021_pilot_events.sql`), with its id recorded in #134. Export #1 (first
non-empty baseline) and rehearsal #1 exited 0 — `replay: schema 101, data 35,
triggers 141`; export #2 (data-bearing, after the smoke fixture) and rehearsal #2
exited 0 — `replay: schema 101, data 43, triggers 141`, with the `audit_events`
count equal to the manifest.

No Worker is deployed (`learner-auth-staging` answers `code: 10007`, checked
18 November 2026), no secret is set and no route exists. Apart from the recorded
staging id, every `database_id` in the committed Wrangler configs is still the
all-zero placeholder; test fixtures carry their own literal ids.
The database now has **22 applied migrations**, last
`0022_pilot_events_retention.sql`: the retention floor landed after the 5C run
and was applied remotely on 18 November 2026, under owner approval, so the
twelve-month floor is enforced there as well — §Pre-enablement step below records
that run and its evidence.

**Not approved to run:** deploying the staging Worker or setting its secrets.
Each is a separate owner decision. (Applying `0022` remotely was such a decision;
the owner gave it and it ran on 18 November 2026 — §Pre-enablement step.)
The deployment now has a guarded command — `npm run deploy:staging`, guard and
rollback described in §Deploying the staging Worker. Having the command is not an
approval to run it, and it has never been run.

This document is both the record of that run and the from-scratch path for a
future rebuild. Each step is a checked step rather than an improvisation; only an
owner-approved execution changes Cloudflare state.

## What 5C is, narrowed

5C creates **one resource**: the D1 database `certpath-learner-staging` in the
account where the staging Worker (`learner-auth-staging`) will be deployed. That
Worker does not exist yet: it answered `code: 10007` (not found) on 18 November
2026, after the database id was recorded (#134). Its
`apps/web/wrangler.staging.jsonc` gained a `*/5 * * * *` cron and the three
pilot event flags, all `"false"`, in #141 — code only, not deployed.

It does **not** create:

- the pilot database (`certpath-pilot`) — that waits for the first real learner,
  which waits for 5F to replace the `tester-gate` assurance;
- a learner, an invited learner, a credential or a sign-in link — no real learner
  data exists until MFA replaces the tester-gate assurance
  ([`docs/delivery-plan.md`](delivery-plan.md) §Operating constraints);
- a Worker deployment, a route, a secret or a var change. 5C itself changes no
  var: the three `PILOT_*` flags in `apps/web/wrangler.staging.jsonc`
  (`PILOT_EVENTS_ENABLED`, `PILOT_SERVER_EVENTS_ENABLED`,
  `PILOT_EVENTS_RETENTION_ENABLED`) were declared beforehand, all `"false"`, in
  #141. No flag is enabled, and none is touched by this run.

The original slice plan also seeded one invited learner and exported the pilot
database "before its first migration". Both were withdrawn by the owner on
17 November 2026: the learner contradicts the operating constraint above, and a
pre-migration export of a virgin database is empty by definition (see
[`docs/data-export-and-restore.md`](data-export-and-restore.md) §The first
export).

## The order

Do not reorder these steps. Each one is a prerequisite for the next, and the
guards are placed so a skipped step fails rather than passes. The 5C run followed
this order on 17 November 2026 and the database it created is still the only
Cloudflare resource; the table records what the run produced. Every step ran:
they are kept as the record and as the from-scratch path, and none of their
remote writes should be re-run without a new approval.

| # | Step | State |
|---|---|---|
| 1 | Preflight: account matches, database **absent** (`--expect-absent`) | done 17 November 2026 — exited 0 with `database certpath-learner-staging: absent`, before the create |
| 2 | Create the database | done 17 November 2026 at 22:25:00Z — created in region `WEUR`; the uuid was recorded in #134 |
| 3 | Record the uuid **locally**, apply the chain | done 17 November 2026 — 21 applied migrations, last `0021_pilot_events.sql` (22 today, §Pre-enablement step) |
| 4 | Repo PR with the uuid, merged and pulled | done — #134 |
| 5 | Preflight again: database present | done |
| 6 | Export #1 (first non-empty baseline) | done, exit 0 |
| 7 | Rehearse #1 | done, exit 0 — `replay: schema 101, data 35, triggers 141` |
| 8 | Apply the smoke fixture | done — rehearsal #2 carried its data rows |
| 9 | Export #2 (first data-bearing dump) | done, exit 0 |
| 10 | Rehearse #2 | done, exit 0 — `replay: schema 101, data 43, triggers 141`, `audit_events` count equal to the manifest |

`0022` is deliberately not in this order: it landed after the run and was applied
to the same database separately on 18 November 2026 — §Pre-enablement step.

A **repeat** run does not start at step 1: `--expect-absent` now fails closed as
`database_already_exists` against the database step 2 created, so it starts at
step 3, the migrate step, and uses step 5's `--expect-present` to check the
account and the database as they are. Step 1 keeps the assertion that ran,
because that assertion is what made the create safe.

### 1. Preflight

This is the assertion the 5C run made before it created anything. From the
repository root:

```powershell
npm run db:preflight -- --expect-account <account-id> --database certpath-learner-staging --expect-absent
```

On success the output is exactly three lines and nothing else:

```
account: <account name> (<account-id>)
database certpath-learner-staging: absent
preflight ok
```

The run exited 0 with that output on 17 November 2026, before the create.

**A repeat run against the database that now exists** fails closed here as
`database_already_exists` — the guard doing its job. It starts at step 3, the
migrate step, as the note under the order says.

The expected account id is passed **only** as `--expect-account`; it is never
read from the environment or from a config. The command is read-only. It runs
`wrangler whoami --json` and `wrangler d1 list --json`, asserts the account and the
database, and prints neither the raw payload nor a token.

Both reads are **pinned** to `--expect-account`: the child environment carries
that id as `CLOUDFLARE_ACCOUNT_ID`, so neither call can fall back to a stored
selection of some other account. The database that is asserted absent is
therefore the database in the asserted account — the same account `d1 create`
will write to — rather than in whichever account this shell happened to select.

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

**Done 17 November 2026 at 22:25:00Z: created in region `WEUR`.**

```powershell
Set-Location apps\web
npx wrangler d1 create certpath-learner-staging
Set-Location ..\..
```

`wrangler d1 create` prints the new uuid and a config snippet. Copy **only** the
`database_id` value. Nothing else in the config changes: the binding stays `DB`,
the `database_name` stays `certpath-learner-staging`, and the migration directory
stays `../../db/migrations`.

Never run this against a database that exists. If the command reports that the
database already exists, stop: the step 1 assertion was bypassed or skipped, and
nothing after this step is safe to continue with.

### 3. Record the uuid locally and apply the chain

**Done 17 November 2026: 21 migrations applied, last `0021_pilot_events.sql`.**
The migration step reads the config, and Wrangler needs a real id there, so the
uuid is written into `apps/web/wrangler.staging.jsonc` **locally** first. That
edit is not the repo PR: it is an uncommitted change that exists only so this step
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
personal data or exam content. It is not a migration, and nothing automated
applies it to a remote database; CI applies it only to a throwaway local D1 (see
the fixture header).

It writes more than four rows: three inserts fire an audit trigger —
`certifications_audit_insert` (0002) for the certification root,
`exam_versions_audit_insert` and `domains_audit_insert` (0003) — and the
`exam_versions` insert also fires `exam_versions_create_timed_mock_profile`
(0006). Three `audit_events` rows and the default `timed_mock_profiles` row are
part of the expected result.

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

#### Replaying a data-bearing dump

`wrangler d1 export` writes `CREATE TABLE` and `INSERT` statements in schema
order, which makes a single ordered replay wrong twice over:

1. **Ordering.** `audit_events` is created before `certifications` in
   `0002_local_security.sql`, and its rows carry a `certification_id` foreign
   key, so a dump with audit rows inserts into `audit_events` before
   `certifications` exists and the load fails with
   `no such table: main.certifications`. `PRAGMA defer_foreign_keys=TRUE` at the
   top of the dump does not help: the parent table has to exist for the deferred
   check to be set up at all.
2. **Trigger replay.** Restoring the fixture's `certifications`, `exam_versions`
   and `domains` rows re-fires `certifications_audit_insert`,
   `exam_versions_audit_insert`, `domains_audit_insert` and
   `exam_versions_create_timed_mock_profile`, inserting the audit rows a second
   time under the same `operation_id`; `audit_events_no_replace` aborts on a
   repeated key.

Both are handled by the rehearsal itself: it loads the verified dump in three
phases — schema, then data, then triggers
([`docs/data-export-and-restore.md`](data-export-and-restore.md) §The load is a
three-phase replay) — so no trigger exists while the rows load and every table
exists before the first row. Rehearsal #2 is expected to be green.

**This is pre-fix history, kept for the diagnosis.** Before the replay fix, a
single `--file` call failed on the ordering problem first (`no such table:
main.certifications`, reported as `dump_load_failed`), and the trigger re-fire was
never reached. The diagnosis must still be evidenced, not inferred: keep the first
~40 statements of an offending dump **outside the repository** — a dump is never
committed, never uploaded and never pasted into a PR — and read the statement
order directly. The 17 November 2026 observation did exactly that: in the first 40
statements of that dump, the three `INSERT INTO "audit_events"` statements sit
immediately before `CREATE TABLE certifications`.

**If rehearsal #2 fails, stop.** Do not edit the dump, do not drop the trigger, do
not re-key the audit rows, do not load with foreign keys disabled, and do not
declare the export "restorable with a caveat". Record the exact error, keep both
dumps and both manifests, and escalate: the next move (accepted limitation, a
documented restore order, or a change to the export strategy) is an architecture
decision, not an operator workaround.

## Pre-enablement step: apply `0022` to staging — **done 18 November 2026**

**Done, under owner approval given for this step, on 18 November 2026.** It was
not part of 5C and it was the one remote step outstanding after that run: the
database then stopped at `0021` (21 rows in `d1_migrations`). It now has **22
applied migrations**, last `0022_pilot_events_retention.sql`, so the staging
database enforces the twelve-month floor itself.

The preflight ran first and exited 0 with
`database certpath-learner-staging: present (<uuid>)`, so the write landed in the
asserted account and database. Evidence from the run:

- `npx wrangler d1 migrations apply certpath-learner-staging --remote -c
  apps/web/wrangler.staging.jsonc` (repository root) → exit 0,
  `0022_pilot_events_retention.sql │ ✅`, `Executed 3 commands in 1.55ms`;
- `SELECT COUNT(*) AS applied, MAX(name) AS last FROM d1_migrations` → `22` and
  `0022_pilot_events_retention.sql`;
- `SELECT type, name FROM sqlite_master WHERE name IN
  ('pilot_events_no_delete','pilot_events_received_at_idx')` → trigger
  `pilot_events_no_delete`, index `pilot_events_received_at_idx`.

`PILOT_EVENTS_RETENTION_ENABLED` still stays `"false"` on staging, because the
Worker that would run the prune is not deployed. Turning the flag on before the
floor existed would have run a prune against a table with no floor — the window
would be a promise the database cannot keep, which is the one thing
[`docs/pilot-events-retention.md`](pilot-events-retention.md) says is enforced in
storage rather than by the job. The order still holds; only its first half is
now satisfied.

The procedure below is kept as written: it is the correct step for a future
rebuild, or for any database that stops short of the last migration.

```powershell
Set-Location apps\web
npx wrangler d1 migrations apply certpath-learner-staging --remote -c wrangler.staging.jsonc
Set-Location ..\..
```

Then prove it, and keep the output with the step's record:

```powershell
Set-Location apps\web
npx wrangler d1 execute certpath-learner-staging --remote -c wrangler.staging.jsonc `
  --command "SELECT COUNT(*) AS applied, MAX(name) AS last FROM d1_migrations"
Set-Location ..\..
```

Expected after the step: `22` applied and `0022_pilot_events_retention.sql` as
the last name. Anything else is a stop, not a retry: `21` means the apply did not
reach the remote database, and any other last name means the ledger does not
match `db/migrations/*.sql`.

This is a remote write to the staging database, so it needs the owner's approval
like every other run step — that approval was given for the 18 November 2026 run,
and a repeat run would need a new one. It changes no repository file: no migration
is edited, no checksum line changes, and `apps/web/wrangler.staging.jsonc` stays
exactly as committed.

## Deploying the staging Worker: `deploy:staging` — the command exists, nothing ran

Until #149 there was no guarded way to ship this Worker. Only
`npm run build:staging` existed, and the raw form the other runbooks use —
`wrangler deploy -c build/server/wrangler.json` — ships whatever build wrote that
file. `build:site`, `build:pilot`, `build:staging` and `build:preview` all write
it, so a pilot build followed by a staging deploy would have shipped a D1-bound
`certpath-pilot` Worker to the staging host.

`npm run deploy:staging` is that command now. **It has never been run:** no
Worker is deployed (`learner-auth-staging` answers `code: 10007`, checked
18 November 2026), no secret is set and no route exists. What changed is that the
deployment has a name, a guard and a rollback.

### The command

```powershell
npm run build:staging     # writes build/server/wrangler.json and asserts the entry
Set-Location apps\web
npm run dry-run:staging -- --expect-account <account id>   # guards + local bundle; uploads nothing
npm run deploy:staging -- --expect-account <account id>    # the guards, then wrangler deploy -c build/server/wrangler.json
Set-Location ..\..
```

`--expect-account` is passed from `apps/web`, where the CLI runs: the root
`npm run deploy:staging` delegates to `@certpath/web` and a trailing
`-- --expect-account …` stops at the delegating `npm`, exactly as it does for
`--allow-pilot-flags` (below). From the root the equivalent is
`npm run deploy:staging --workspace @certpath/web -- --expect-account <account id>`.

`deploy:staging` and `dry-run:staging` read `build/server/wrangler.json` —
resolved from the working directory, exactly as `-c build/server/wrangler.json`
is — and refuse with exit 1 **before Wrangler is spawned** unless every rule
holds:

| Rule the generated config must satisfy | Refusal code |
|---|---|
| it selected `wrangler.staging.jsonc` | `staging_wrong_config` |
| the Worker name is `learner-auth-staging` | `staging_wrong_worker` |
| exactly one `d1_databases` entry, binding `DB`, named `certpath-learner-staging` | `staging_database_mismatch` |
| its `database_id` is present and is not the all-zero placeholder | `staging_database_placeholder` |
| `triggers.crons` is exactly `["*/5 * * * *"]` | `staging_schedule_mismatch` |
| `PILOT_EVENTS_ENABLED`, `PILOT_SERVER_EVENTS_ENABLED` and `PILOT_EVENTS_RETENTION_ENABLED` are each the string `"false"` | `staging_pilot_flag_enabled` |
| all three flags are present at all | `staging_pilot_flag_missing` |
| `build/server/wrangler.json` exists | `staging_config_missing` |
| it parses as a JSON object | `staging_config_unparsed` |

The **account** is asserted in the same breath, before any spawn.
`CLOUDFLARE_ACCOUNT_ID` is never accepted silently: Wrangler prefers it over its
stored selection, so an id left in the shell would deploy `learner-auth-staging`
into *that* account, bound to a `database_id` that does not exist there. If the
variable is set, `--expect-account <account id>` is required and must agree with
it; the child Wrangler process is then pinned to that id (`wranglerEnv`), which
removes both fallbacks. Missing or disagreeing is `account_env_mismatch`, exit 1,
before Wrangler runs:

| Rule the environment must satisfy | Refusal code |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` set and `--expect-account` absent | `account_env_mismatch` |
| `CLOUDFLARE_ACCOUNT_ID` set and different from `--expect-account` | `account_env_mismatch` |
| an argument other than `--expect-account` / `--allow-pilot-flags` | `unknown_argument` (exit 2) |

Exit 2 is a usage error (an unknown action or a missing option value). The guards
print what they verified, so the operator can see the target, the schedule, the
flag values and the account that was checked:

```
Verified staging deploy target: worker learner-auth-staging, database certpath-learner-staging (binding DB)
Verified cron schedule: */5 * * * *
Verified PILOT_EVENTS_ENABLED="false"
Verified PILOT_SERVER_EVENTS_ENABLED="false"
Verified PILOT_EVENTS_RETENTION_ENABLED="false"
```

`--allow-pilot-flags` is the only override, and it permits a flag that is not
`"false"` for a deliberate, owner-approved flag change, printing
`Pilot flag override: --allow-pilot-flags (the flags above are not asserted false)`.
Pass it where the CLI runs — from `apps/web`:

```powershell
Set-Location apps\web
npm run deploy:staging -- --allow-pilot-flags
Set-Location ..\..
```

`npm run deploy:staging -- --allow-pilot-flags` **from the repository root does
not reach the CLI**: the root script delegates to `@certpath/web`, so the flag
stops at the delegating `npm`. That combination is fail-closed — the guard still
refuses an enabled flag with `staging_pilot_flag_enabled` — but it is a refusal,
not an applied override. From the root the working form is
`npm run deploy:staging --workspace @certpath/web -- --allow-pilot-flags`.
It does not permit a flag to be absent: a build that dropped the vars is not the
artefact the guard checked. Every refusal and the accepted path are covered in
`apps/web/scripts/staging-command.test.mjs`; the refusals never spawn `deploy`.

### Preconditions

All seven must hold. Any one missing is a stop, not a retry.

1. **The account is asserted.** Run with `--expect-account <account id>` — the
   Certpath account the database was created in (#134) — and make sure a
   `CLOUDFLARE_ACCOUNT_ID` in the shell either agrees with it or is removed. The
   command refuses before spawning Wrangler otherwise (`account_env_mismatch`),
   and when nothing is asserted it prints
   `Account: not asserted (...)`, which is the line to notice before deploying
   into whatever Wrangler has stored.
2. **`npm run build:staging` exited 0** in this checkout after the last change.
   It asserts the bundle entry is `workers/staging-app.ts`.
3. **The staging database has 22 applied migrations**, last
   `0022_pilot_events_retention.sql` (§Pre-enablement step). The Worker carries a
   `*/5 * * * *` cron; shipping the prune before the floor exists would run a job
   against a table with no floor. Re-read the ledger:

   ```powershell
   Set-Location apps\web
   npx wrangler d1 execute certpath-learner-staging --remote -c wrangler.staging.jsonc `
     --command "SELECT COUNT(*) AS applied, MAX(name) AS last FROM d1_migrations"
   Set-Location ..\..
   ```

4. **`CSRF_HMAC_SECRET` is set** on the Worker, at least 32 random bytes. Without
   it `/api/auth/session/csrf` and `/api/auth/session/logout` answer `503`.
5. **`STAGING_TESTER_IPS` is set** to the tester's egress IP list. Until it is,
   every request answers `503`; with it, an address not on the list answers
   `403`. Both are hosted secrets, never files or arguments:

   ```powershell
   Set-Location apps\web
   npx wrangler secret put STAGING_TESTER_IPS -c wrangler.staging.jsonc
   npx wrangler secret put CSRF_HMAC_SECRET -c wrangler.staging.jsonc
   Set-Location ..\..
   ```

   `wrangler secret put` prompts for the value. **Neither secret is set today**,
   and setting either is its own owner decision, not part of `deploy:staging`.

6. **The three `PILOT_*` flags are `"false"`** in `apps/web/wrangler.staging.jsonc`,
   and so in the built copy. The guard asserts the built copy, which is what
   ships.
7. **`npm run dry-run:staging -- --expect-account <account id>` exited 0** (from
   `apps/web`) and printed the verified lines above, with the account line naming
   the id it pinned. It bundles locally and uploads nothing.

### Afterwards: what to check

The read after the deploy names the Worker through `wrangler.staging.jsonc`, not
through the built config. `build/server/wrangler.json` is a mutable artefact —
any later `build`, `build:pilot` or `build:site` overwrites it with another
target's Worker name — so `status`, `rollback` and `delete` must not be pointed
at it:

```powershell
npx wrangler deployments status -c apps/web/wrangler.staging.jsonc
```

Expected: exactly one deployment for `learner-auth-staging`, created by this run.
Record its version id with the run. If `deployments status` does not print the
triggers in your Wrangler version, the dashboard's Triggers tab is the authority:
`*/5 * * * *` and nothing else — that cron is half of what this deploy ships.

The three flags are not printed by `deployments status`; read them from the
artefact that was deployed, which the guard also asserts:

```powershell
Select-String -Path apps\web\build\server\wrangler.json `
  -Pattern 'PILOT_[A-Z_]+":"[a-z]+' -AllMatches |
  ForEach-Object { $_.Matches.Value }
```

Expected: all three `"false"`. A deploy that turns any of them on is a stop —
the retention flag needs the floor that §Pre-enablement step applied, and the
funnel flags need a consent path staging does not exercise yet.

The gate itself, from an address **not** in `STAGING_TESTER_IPS`:

```powershell
curl.exe -i https://learner-auth-staging.certpath.workers.dev/
```

Expected: `503` while `STAGING_TESTER_IPS` is unset, `403` once it holds a list
the caller is not on. A `200` means the tester gate is not enforcing — delete the
deployment (below) and escalate; do not add an address to make it pass.

### Rollback

A deploy is a remote write and needs the owner's approval like every other step.
The guard proves the target, not the authorisation to run the command.

```powershell
npx wrangler rollback -c apps/web/wrangler.staging.jsonc
```

`rollback` returns to the previous version and needs one to exist, so on a first
deploy there is nothing to roll back to; the rollback is then a delete:

```powershell
npx wrangler delete -c apps/web/wrangler.staging.jsonc
```

`delete` removes the Worker, its cron and its secrets. The **database is
untouched** — `certpath-learner-staging` and its 22 migrations stay, and dropping
it is the separate teardown decision below. After a delete, `learner-auth-staging`
answers `code: 10007` again and no remote staging write is outstanding.

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
- export #2 contains rows, and rehearsal #2 completed against a data-bearing
  dump (exit 0, `replay: schema 101, data 43, triggers 141`).

Not proven, and not claimed:

- **no remote restore** — no dump has been restored into a remote D1, only into a
  local scratch database;
- **no data-bearing restore into a remote database** — a dump carrying the smoke
  fixture rehearses locally through the three-phase replay, and CI runs that round
  trip, but no data-bearing dump has been loaded into a real D1;
- **no concurrency** — no writer was active during an export, so nothing is known
  about a dump taken while rows are being written;
- **no Time Travel restore** — the 7-day window is stated, not exercised;
- **no dump provenance check** (issue #103) — the rehearsal proves the dump
  matches its manifest, not that the manifest belongs to this schema; the
  operator diffs `migrations[]` by hand in step 6;
- **no learner, no sign-in, no Worker, no real data** — 5C creates a database and
  nothing else.
