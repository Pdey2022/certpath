# Data export and restore

Operator runbook for the Phase 5A data-safety tooling: the D1 isolation gate,
pre-migration exports with a sidecar manifest, a rehearsed restore, and the
fresh-chain check. Everything here runs locally. Nothing in this slice deploys
anything, creates a database, schedules a dump or calls Cloudflare except the
export of a *remote* target, which refuses to start until that target has a real
`database_id`.

## What exists

| Command | Script | Network |
|---|---|---|
| `npm run check:isolation` | `apps/web/scripts/check-d1-isolation.mjs` | none |
| `npm run db:chain` | `apps/web/scripts/d1-chain-check.mjs` | none |
| `npm run db:export -- --target <target>` | `apps/web/scripts/d1-export.mjs` | none for `local`, Cloudflare for `staging`/`pilot` |
| `npm run db:rehearse -- --file <dump>` | `apps/web/scripts/d1-restore-rehearse.mjs` | none |

npm needs `--` before script arguments, so the commands above are the exact
Windows PowerShell spellings.

## Targets

| Target | Wrangler config | Mode | Default dump name |
|---|---|---|---|
| `local` | `apps/web/wrangler.jsonc` | `--local` (wrangler-dev state) | `certpath-local-<UTC>.sql` |
| `staging` | `apps/web/wrangler.staging.jsonc` | `--remote` | `certpath-learner-staging-<UTC>.sql` |
| `pilot` | `apps/web/wrangler.pilot.jsonc` | `--remote` | `certpath-pilot-<UTC>.sql` |

`<UTC>` is `YYYYMMDDTHHMMSSZ`. `--wrangler-config <path>` overrides the config,
which is how the round-trip test points the export at a scratch database the
chain check just migrated.

`local` is the only target that may carry the placeholder `database_id`; it is
wrangler-dev state, not a provisioned database.

## Where dumps go

`--out <dir>` wins. Otherwise `$CERTPATH_D1_EXPORT_DIR`. Otherwise
`~/.certpath/exports`. Dumps are **outside the repository by default**, and
`exports/` is git-ignored as defence in depth. Never commit a dump and never
upload one to a third party.

## The export

```powershell
npm run db:export -- --target pilot --out D:\certpath-exports
```

The script:

1. resolves the target's `database_id` first and exits `3` before any network
   call when a remote target still has the placeholder id;
2. writes `<db>-<UTC>.sql.partial`;
3. verifies the dump is not empty;
4. records the manifest, then renames the partial file into place.

A published dump therefore cannot exist without its manifest.

### Exit codes

| Code | Meaning | State left behind |
|---|---|---|
| 0 | exported and verified | one `.sql` and one `.sql.manifest.json` |
| 1 | verification failed (e.g. `empty_export`, `migrations_query_failed`) | nothing: the `.partial` is deleted |
| 2 | usage error or unknown target | nothing |
| 3 | `d1_not_provisioned` (remote target still on the placeholder id) | nothing |
| 4 | `remote_auth_failed` | nothing: the `.partial` is deleted |

The script never prints row values, an email address, dump contents, or the
values of `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`.

### Manifest fields

`<dump>.sql.manifest.json` carries exactly these fields, none nullable:

| Field | Value |
|---|---|
| `schemaVersion` | `1` |
| `target` | `local`, `staging` or `pilot` |
| `binding` | the D1 binding name, normally `DB` |
| `databaseName` | `database_name` from the config |
| `databaseIdClass` | `"placeholder"` or `"real"` |
| `wranglerConfig` | the config path used (repo-relative when inside the repo) |
| `capturedAt` | ISO8601 UTC |
| `gitCommit` | 40-character hex commit that produced the dump |
| `wranglerVersion` | Wrangler that produced the dump |
| `file` | dump file name |
| `byteLength` | dump size in bytes |
| `sha256` | 64 lowercase hex characters |
| `tables` | `[{ name, inserts }]` ordered by name, covering every table in the dump |
| `migrations` | `d1_migrations` names in id order |

`inserts` counts `INSERT INTO "<name>"` occurrences in the dump text. Wrangler's
`d1 export` emits one `INSERT` per row, so this equals the restored row count for
every table.

## Rehearsed restore

```powershell
npm run db:rehearse -- --file D:\certpath-exports\certpath-pilot-20261117T101500Z.sql
```

The sidecar `<dump>.sql.manifest.json` is required. `--persist-to` is refused on
purpose; the rehearsal always loads into a fresh temporary database that is
deleted afterwards, so it can never read or write a real one.

Steps the script performs, in order:

1. the manifest must exist, be well formed, and describe every field above;
2. the dump's byte length and sha256 must equal the manifest;
3. the dump is loaded into the temporary database with
   `wrangler d1 execute --local --file`;
4. `PRAGMA integrity_check` must return `ok`;
5. `PRAGMA foreign_key_check` must be empty;
6. the table set and per-table row counts must equal `tables[]`;
7. `d1_migrations` must equal `migrations[]`.

Any mismatch exits `1` with a per-table diff line, for example:

```
  accounts: manifest 1, restored 2 (+1)
  users: manifest 3, restored 2 (-1)
```

Nothing is auto-repaired. A failing rehearsal is a stop condition: do not restore
that dump anywhere, capture a fresh export, and escalate.

## Fresh-chain check

```powershell
npm run db:chain
```

Applies `0001_foundation.sql` … the newest migration, in filename order, to an
empty database, asserts `d1_migrations` equals `db/migrations/*.sql` exactly,
asserts a second apply is a no-op, and verifies every file against
`db/migrations/checksums.txt`.

`checksums.txt` is append-only: one `<sha256>  <basename>` line per migration, in
filename order. The hash is computed over the file with CRLF/CR normalised to LF,
so a Windows checkout (`core.autocrlf=true`) and a Linux CI checkout agree; any
other byte change still fails. A changed byte in an already-landed migration
fails with `migration_checksum_changed` naming the file. Migrations are
append-only; add the next number instead of editing one.

`--work-dir <empty dir>` keeps the scratch database (the round-trip test uses it);
without it the scratch directory is removed.

## Isolation gate

```powershell
npm run check:isolation
```

Reads the four configs and fails when:

| Code | Rule |
|---|---|
| `preview_binds_d1` | `wrangler.preview.jsonc` declares any `d1_databases` entry (the preview Worker is D1-free) |
| `duplicate_database_name` | two remote configs name the same `database_name` (the local config is exempt) |
| `duplicate_database_id` | two configs carry the same non-placeholder `database_id` |
| `config_missing` / `config_parse_failed` | a config cannot be read, so the gate cannot verify it |

## Retention

Approved by the owner on 17 November 2026:

- **keep the last 3 dumps** per target; delete older ones;
- **delete a dump 14 days after the migration it precedes is confirmed**;
- **never commit a dump; never upload a dump.**

The manifest goes with its dump: both or neither.

## What CI does and does not prove

CI has zero rows. `npm run verify` runs `db:chain`, and the round-trip test
chains, exports `local` and rehearses that dump, so CI proves the *shape* of the
round trip: schema, manifest, hashing, load, integrity and counts. It cannot
prove a data-bearing restore.

The first data-bearing rehearsal belongs to slice 5C (provisioning): export the
isolated staging database before its first migration, rehearse it, and record the
result. Until then, no rehearsal has seen a real row.

## Limitations

- No scheduling, no automatic retention enforcement, no remote restore. The
  rehearsal is local-only; restoring a remote D1 is a separate, owner-approved
  step.
- `db:export --target staging` and `--target pilot` cannot run until 5C records
  a real `database_id`; they exit `3` before touching the network.
- `PRAGMA integrity_check` is refused by D1's local emulation (`SQLITE_AUTH`), so
  the rehearsal runs the integrity and foreign-key checks against the restored
  SQLite file with Node's built-in `node:sqlite`. The load itself still goes
  through `wrangler d1 execute`, so the operator path is exercised.
