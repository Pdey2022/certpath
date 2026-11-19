# Deployments

How CertPath reaches Cloudflare Workers, what a merge to `main` does, and how
to undo it. The pipeline is `.github/workflows/ci.yml` (continuous) and
`.github/workflows/deploy-production.yml` (manual).

The **first automatic deploy happens when the owner merges this change to
`main`**: both publish jobs are guarded by `github.event_name == 'push' &&
github.ref == 'refs/heads/main'`, so a pull request, a manual `CI` dispatch and
this branch publish nothing.

## Two tiers

| Tier | Worker | Trigger | Path |
|---|---|---|---|
| Public site | `certpath-site` | push to `main`, after `verify` | `npm run build:site` -> stamp -> `npm run deploy:site` |
| Staging app | `learner-auth-staging` | push to `main`, after `verify` and the migration gate | `npm run build:staging` -> stamp -> `npm run deploy:staging -- --expect-account ...` |
| Production | `certpath-site` or `certpath-pilot` | `workflow_dispatch` only, protected `production` environment | `deploy-production.yml`, after its own `verify` job |

- Pull requests, `workflow_dispatch` of `CI`, and any other ref deploy nothing:
  both jobs carry an explicit `if:` guard rather than relying on a default.
- Each target has its own `concurrency` group (`publish-certpath-site`,
  `publish-learner-auth-staging`, `deploy-production-<target>`), so two merges
  queue instead of deploying at once, and an in-flight deploy is never
  cancelled by a later one.
- The staging publish is a separate job from the site publish, so a skipped or
  failed staging deploy does not stop the site.
- The root scripts are themselves `npm run --workspace` hops, and npm swallows
  an option passed through two hops. The workflow therefore names the workspace
  once — `npm run deploy:staging --workspace @certpath/web -- --expect-account
  <id>` — which is the same command as `npm run deploy:staging --
  --expect-account <id>` run from `apps/web`.

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

## Required GitHub settings

The owner creates these once, in **Settings -> Secrets and variables -> Actions**:

| Secret | Value | Used for |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | an API token for the Certpath account with **Workers Scripts:Edit** and **D1:Edit** (D1:Read for the migration gate and exports) | every deploy, the gate, `wrangler deployments status` |
| `CLOUDFLARE_ACCOUNT_ID` | `ef67137c4d1556f7f51f1cb3f1f420f3` (the Certpath account) | pinning Wrangler to that account |

If either secret is absent, or the account id is not the Certpath account, every
publish job stops before building with an `::error::` annotation naming the
missing or wrong value and linking here. The account id is not itself a secret —
it is pinned in the workflows — but the token is, and it is never written to a
file, passed as an argument, printed in a log or committed. The gate and the
deploy scripts redact it from anything Wrangler prints.

Production also needs an **environment** named `production`
(**Settings -> Environments**) with required reviewers (and, if desired, a
deployment-branch rule limiting it to `main`). Without it, the production
workflow deploys without an approval step. It cannot be reached by a push: its
only trigger is `workflow_dispatch`, and it additionally requires the `confirm`
input to equal the target's Worker name (`certpath-site` or `certpath-pilot`).

## The deployed commit

Every publish adds a Worker var, `DEPLOYED_COMMIT`, holding the 7-character
commit (`${GITHUB_SHA::7}`), by rewriting the generated
`apps/web/build/server/wrangler.json` after the build and before the deploy
(`apps/web/scripts/stamp-deployed-commit.mjs`). The value is not committed in
`wrangler.*.jsonc`, because a committed value would describe one commit forever,
and it is **not** exposed on `/api/health`: the public API surface is unchanged,
and `apps/api/src/index.test.ts` still asserts that health returns exactly
`{"status":"ok"}`.

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
publish jobs only run on a push to `main`. The first live proof is the first
merge.
