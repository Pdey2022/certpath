# Deployments

How CertPath reaches Cloudflare Workers, what a merge to `main` does, and how
to undo it. The pipeline is `.github/workflows/ci.yml` (continuous) and
`.github/workflows/deploy-production.yml` (manual).

## The first live deploy (2026-11-20)

The first merge to `main` ran the pipeline: the public site published, and the
staging publish was deliberately gated. Run
[44780344874](https://github.com/Pdey2022/certpath/actions/runs/44780344874) on
commit `16247bf` ("CISSP import driver (Phase 3) and two-tier Cloudflare deploy
pipeline (#184)"):

| Job | Outcome |
|---|---|
| `verify` | success |
| `publish-site` | **success** — `DEPLOYED_COMMIT=16247bf` was stamped into the artefact and verified in the log |
| `publish-staging` | **success** — its deploy step was skipped by the schema gate, with a notice naming `0023_staff_second_factor.sql`; `learner-auth-staging` was not published |

Live checks against `certpath-site` after the deploy: `/` 200 with the full
server-rendered HTML, `/exams` 200, `/robots.txt` 200 (`Allow: /`,
`Disallow: /app`, `Disallow: /admin`), `/sitemap.xml` 200.

That robots reading was taken at `16247bf`, when the site config shipped with
`INDEXING_ENABLED: "true"`. The public site now deploys with indexing off
(`apps/web/wrangler.site.jsonc` sets `"false"`; see
[SEO](seo.md#indexing-is-off-on-the-public-site)), so the same live check after
the next merge to `main` must show `/robots.txt` as `User-agent: *` plus
`Disallow: /`, an empty `/sitemap.xml`, and `noindex,nofollow` on `/` and
`/exams`. A live `Allow: /` would mean the deployed config is not the one in
`main`.

Both publish jobs are guarded by `github.event_name == 'push' &&
github.ref == 'refs/heads/main'`, so a pull request or a manual `CI` dispatch
publishes nothing.

## Two tiers

| Tier | Worker | Trigger | Path |
|---|---|---|---|
| Public site | `certpath-site` | push to `main`, after `verify` | `npm run build:site` -> stamp -> `npm run deploy:site` |
| Staging app | `learner-auth-staging` | push to `main`, after `verify` and the migration gate | `npm run build:staging` -> stamp -> `npm run deploy:staging -- --expect-account ...` |
| Production | `certpath-site` or `certpath-pilot` | `workflow_dispatch` only, protected `production` environment | `deploy-production.yml`, after its own `verify` job; the `app` target runs the migration gate, then `npm run deploy:pilot -- --expect-account ...` |

- Pull requests, `workflow_dispatch` of `CI`, and any other ref deploy nothing:
  both jobs carry an explicit `if:` guard rather than relying on a default.
- Each Worker has one `concurrency` group, shared by both workflows:
  `deploy-certpath-site`, `deploy-learner-auth-staging`, `deploy-certpath-pilot`.
  Two merges queue instead of deploying at once, an in-flight deploy is never
  cancelled by a later one, and a manual site dispatch cannot race the merge
  that is publishing `certpath-site`.
- A *pending* run in a shared group is superseded by a newer one. An in-progress
  deploy is never cancelled, but a queued one can be: a production dispatch that
  is waiting behind a merge may never start, because the newer merge takes the
  slot. Re-dispatch and read the run outcome rather than assuming a queued
  dispatch will execute.
- The production deploy job runs only from `refs/heads/main`. A dispatch from
  another ref runs `verify` and then skips the deploy job — that is a guard, not
  a supported way to ship. Allowing a non-`main` production deploy is an open
  owner decision, not a default.
- The staging publish is a separate job from the site publish, so a skipped or
  failed staging deploy does not stop the site.
- The root scripts are themselves `npm run --workspace` hops, and npm swallows
  an option passed through two hops. The workflows therefore name the workspace
  once — `npm run deploy:staging --workspace @certpath/web -- --expect-account
  <id>` (and the same for `deploy:pilot`) — which is the same command as
  `npm run deploy:staging -- --expect-account <id>` run from `apps/web`.

### Account pinning

Both app deploys assert the account on the command line, with one shared rule
(`deployEnv` in `apps/web/scripts/lib/d1-targets.mjs`, used by
`staging-command.mjs` and `pilot-command.mjs`):

| Action | `--expect-account` | `CLOUDFLARE_ACCOUNT_ID` set but different |
|---|---|---|
| `deploy` (staging or pilot) | **required**; absent is exit 2 `account_not_asserted`, before Wrangler is spawned | refused, exit 1 `account_env_mismatch` |
| `dry-run` | optional; the run prints `Account: not asserted ...` when it is omitted | refused, exit 1 `account_env_mismatch` - a value nobody asserted must not decide where a read lands |
| `build` | not accepted at all | not read |

`--allow-pilot-flags` is a staging-only override; the pilot CLI refuses it as an
unknown argument, so a pilot deploy has no way to waive an assertion. The public
site's `deploy:site` has no script-level *account* assertion — its account comes
from `CLOUDFLARE_ACCOUNT_ID`, which the workflow asserts equals
`ef67137c4d1556f7f51f1cb3f1f420f3` before the step runs — but its artefact and
its `DEPLOYED_COMMIT` stamp are asserted by `assertSiteDeployConfig`.

The pilot **database** is not provisioned: `wrangler.pilot.jsonc` still carries
the all-zero `database_id`, so the production `app` dispatch fails loudly at the
migration gate (`database_not_provisioned`) before any build or deploy. The
account guard above is independent of that and does not weaken it.

## The migration gate

A deploy must never run ahead of its schema, and a deploy job must never apply a
migration. `apps/web/scripts/migration-gate.mjs` runs

```
wrangler d1 migrations list <database> --remote
```

before the staging and production **app** deploys, compares the pending names it
reports with `db/migrations/*.sql`, and then:

| Situation | Staging (`--mode skip`) | Production (`--mode abort`) |
|---|---|---|
| nothing pending | deploy | deploy |
| anything pending | **skip**, exit 3, `::notice::` + job summary naming each file | **abort**, exit 4, `::error::`, job red |
| pending name not in this commit | refuse, exit 1 | refuse, exit 1 |
| output unreadable / clean line beside a pending row | refuse, exit 1 | refuse, exit 1 |
| database id still the all-zero placeholder | refuse, exit 1 | refuse, exit 1 |
| `CLOUDFLARE_ACCOUNT_ID` disagrees with `--expect-account` | refuse, exit 1 | refuse, exit 1 |

Nothing in either workflow applies a migration; `wrangler d1 migrations apply`
exists only in local and provisioning tooling.

**Why staging skips rather than fails.** Staging D1 holds 22 applied migrations
(`0022` is the last) while `main` carries 23: `0023_staff_second_factor.sql` is
deliberately deferred by the owner, and the staging Worker does not exist yet.
Deploying staging code against that schema would be wrong, applying `0023` from
a pipeline would be worse, and a red build would read as breakage rather than a
decision. The skip is therefore deliberate and visible — a notice, a summary and
a log line naming the pending file — and it leaves the site publish unaffected.
Once `0023` is applied under owner approval, the same gate turns green and the
next merge publishes the staging Worker.

The public site carries no D1 binding, so there is no schema to gate; the
production workflow's gate step is scoped to the `app` target.

## GitHub settings (in place)

These are done, not outstanding. They were created and verified on 2026-11-20,
against the first live deploy.

| Secret (Settings -> Secrets and variables -> Actions) | Value | Used for |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | an API token for the Certpath account scoped to **Workers Scripts:Edit** and **D1:Read**; verified live by the first deploy | every deploy, the migration gate, `wrangler deployments status` |
| `CLOUDFLARE_ACCOUNT_ID` | `ef67137c4d1556f7f51f1cb3f1f420f3` (the Certpath account) | pinning Wrangler to that account |

If either secret is absent, or the account id is not the Certpath account, every
publish job stops before building with an `::error::` annotation naming the
missing or wrong value and linking here. The account id is not itself a secret —
it is pinned in the workflows — but the token is, and it is never written to a
file, passed as an argument, printed in a log or committed. The gate and the
deploy scripts redact it from anything Wrangler prints.

**The pipeline cannot write to D1.** No workflow runs `d1 migrations apply`, so
`D1:Read` is all the deploy token needs. Applying a migration by hand is a
separate, owner-only credential with **D1:Edit**; it is never stored in Actions
secrets, never used by a workflow, and never held by the deploy token.

The **`production` environment** exists (**Settings -> Environments**), with the
owner as its required reviewer. Without it, the production workflow would deploy
without an approval step. It cannot be reached by a push: its only trigger is
`workflow_dispatch`, and it additionally requires the `confirm` input to equal
the target's Worker name (`certpath-site` or `certpath-pilot`).

**`main` is protected.** Branch protection requires the `verify` check in strict
mode (a branch must be up to date before it merges), and force pushes and branch
deletions are blocked — **except for the repository administrator, who can still
bypass them** (`enforce_admins` is off, and no ruleset enforces against admins).
The protection binds everyone else. It was enabled shortly after publication and
before the first deploy. The protection exists because the branch protection and
ruleset features this repository needs are not available on the free private
plan; the repository is public instead of paying for Pro (ADR 0007).

## The deployed commit

Every publish adds a Worker var, `DEPLOYED_COMMIT`, holding the 7-character
commit (`${GITHUB_SHA::7}`), by rewriting the generated
`apps/web/build/server/wrangler.json` after the build and before the deploy
(`apps/web/scripts/stamp-deployed-commit.mjs`). The value is not committed in
`wrangler.*.jsonc`, because a committed value would describe one commit forever,
and it is **not** exposed on `/api/health`: the public API surface is unchanged,
and `apps/api/src/index.test.ts` still asserts that health returns exactly
`{"status":"ok"}`.

All three deploy CLIs assert the stamp before they deploy: an artefact whose
`DEPLOYED_COMMIT` is not commit-shaped is refused (`staging_deploy_stamp_missing`
/ `pilot_deploy_stamp_missing` / `site_deploy_stamp_missing`), so a skipped stamp
fails the job instead of shipping a Worker nobody can identify. Each CLI also
refuses an artefact that is not its own build (`assertStagingDeployConfig`,
`assertPilotDeployConfig`, `assertSiteDeployConfig`): every build target writes
`build/server/wrangler.json`, so without that check `npm run build:pilot &&
npm run deploy:site` would publish the `certpath-pilot` Worker under the public
origin, and `build:staging && deploy:pilot` would ship the staging Worker under
the pilot name. The site guard additionally asserts the *absence* of any
`d1_databases` binding, because the public site is D1-free.

Where to read it:

- the job summary of the publish job (`target`, `commit`);
- the deploy log, which prints `DEPLOYED_COMMIT` immediately before
  `wrangler deployments status`;
- the Worker itself, via `wrangler deployments status` / the dashboard version
  view — useful when checking whether staging has drifted behind `main`.

## Rollback

**Code rolls back; migrations do not.**

- Code: `wrangler rollback --name <worker>` (or find the deployment with
  `wrangler deployments list` and pass `--message`/`--version-id` as needed).
  That re-points the Worker at a previous version; because each version carries
  its own `DEPLOYED_COMMIT`, the var tells you which commit is live after the
  rollback. Roll back the site to a previous deployment in the same way.
- The production workflow is not a rollback tool: it deploys the current
  `main` HEAD (or the dispatched ref), so rolling back a bad commit means either
  `wrangler rollback` or a revert commit merged to `main`.
- D1 migrations are apply-only: there is no `down`, and `wrangler d1 export`
  is not a restore tool. Before applying a migration to a database that holds
  data, **export first**:

  ```powershell
  npm run db:export -- --target staging --out D:\certpath-exports
  npm run db:rehearse -- --file D:\certpath-exports\certpath-learner-staging-<UTC>.sql
  ```

  Keep the last 3 dumps, delete a dump 14 days after the migration it precedes
  is confirmed, and never commit or upload one. Restoring a remote D1 is a
  separate owner-approved step: see
  [data export and restore](data-export-and-restore.md) for the manifest, the
  rehearsal and its exit codes.
- A skipped staging deploy needs no rollback: nothing ran.

## What CI proves, and what it cannot

`npm run verify` remains the single gate; the publish jobs depend on it
(`needs: verify`) and do not repeat its steps. `actionlint` is not wired into CI;
the workflow files were linted by hand when they were written.

CI cannot prove a deploy: `npm run verify` runs no network command, and the
publish jobs only run on a push to `main`. The first live deploy is recorded at
the top of this document (run `44780344874`, commit `16247bf`).

## Pushing refs: never `--all`, `--mirror` or `--tags`

The repository is public (ADR 0007). Only refs that reach `origin` are published,
and **a pushed commit stays retrievable on GitHub by its SHA after the ref that
pointed at it is deleted**, and persists in any fork taken while it was there.
Deleting a branch is not a way to un-publish what was on it. Treat every push as
irreversible.

That is why these commands are prohibited rather than discouraged: each one
publishes refs nobody reviewed. The rule binds the person pushing — **no
server-side control rejects any of these pushes.** Branch protection covers
`main` only; nothing on the server refuses `git push origin refs/agents/…`, a
`refs/stash` push, a tag push or `--mirror`.

| Command | What it actually publishes | Why it is prohibited |
|---|---|---|
| `git push --all` | every `refs/heads/*` — **not** `refs/agents/*` or `refs/stash`, which are not heads | every *unpublished local branch* in the clone, not the one you meant. `git for-each-ref --format='%(refname)' refs/heads` lists them; the list changes, so read it rather than trusting a remembered one |
| `git push --mirror` | every ref — `refs/heads/*`, `refs/tags/*`, `refs/agents/*` and `refs/stash` — and it **deletes** origin refs that are absent locally | it publishes the agent checkpoints that `--all` leaves alone whenever they exist, and it destroys as well as publishes: a ref that exists on `origin` but not locally is removed |
| `git push origin --tags` | every tag | a tag keeps the commit it names reachable, including commits no branch points at any more |
| `git push --follow-tags` | annotated tags reachable from the pushed ref | the same exposure, limited to the tags you are carrying |

Push a named branch only:

```powershell
git push origin <branch-name>
```

### Before any push from a new working copy

```powershell
git push --dry-run origin <branch-name>              # which refs would be updated
git log --oneline origin/<branch-name>..<branch-name> # which commits those refs carry
git ls-remote origin                                 # what origin already holds
```

`--dry-run` previews **which refs would be updated** and uploads nothing. It does
not exercise server-side push protection or secret scanning — nothing reaches the
server for either to inspect — and it does not list the commits the ref carries,
so pair it with the `git log` line above. `ls-remote` shows what is already
published. None of the three replaces the reachability checks below.

### Agent checkpoint refs are recreated every session

139 `refs/agents/*` refs were deleted and pruned on 2026-11-20. That was not a
one-off cleanup: the agent harness recreates checkpoint refs every session, so at
the time of writing 7 such refs exist (6 under `refs/agents/` plus `refs/stash`).

Before any publish, the check is that the list is empty:

```powershell
git for-each-ref --format='%(refname)' refs/agents refs/stash   # must print nothing
```

What makes the current state safe is not the earlier deletion but the fact that
the study file is **not reachable from any ref right now**:
`git rev-list --objects --all` returns no match for it. The refs come back, so
the check has to be repeated, not remembered.

### Is a path reachable from any ref?

`git log --all -- <path>` matches that path in each commit, so a file that was
renamed is found only under its current name. That matters here: the `.gitignore`
pattern `docs/CISSP*/` covers a renamed study folder, so a check that sees only
the new path can pass while the object is still reachable under the old one.

```powershell
git rev-list --objects --all | Select-String -Pattern 'CISSP'
git log --all --full-history -- '*CISSP*'
```

The two commands answer different halves of the question, and neither follows a
rename on its own:

- `git rev-list --objects --all` lists every object reachable from any ref with
  the path it is reached under. Each object is named **once**, by the first path
  that reaches it, so a blob reachable under several names appears under one of
  them only.
- `git log --all --full-history -- '*CISSP*'` matches the glob against each
  commit's tree, so it finds a matching name in any commit, whatever the path is
  today, and keeps those commits in the history it prints.

An object listed by either is published the moment a ref that reaches it is
pushed.

A file excluded by `.gitignore` is not protected once it has been committed on
any ref: ignore rules govern new adds, not existing history. The only reliable
control is not to publish the ref.
