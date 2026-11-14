# Private pilot: one invited Google learner (Workers Free)

**Status:** Prepared for review. **Nothing is provisioned or deployed.**
The public site (`https://certpath-site.certpath.workers.dev`) and the demo
(`https://certpath-ui-preview.certpath.workers.dev`) stay live at $0.

## What this pilot is

A separate Worker, `certpath-pilot`, running the real CertPath application with
its own isolated D1 database and one invited learner:

- Sign-in is **Google OpenID Connect only**, reusing the invite-only flow merged
  in PR #34 (authorization code, PKCE, state, nonce, browser-bound single-use
  transaction, server-side ID token validation, issuer + subject linking).
- Email, password sign-in, the Cognito sandbox, admin, and the Lambda verifier
  are **disabled**: those routes return `404` and no AWS binding exists.
- The tester gate runs before any other work, and the public pages stay
  non-indexable (`INDEXING_ENABLED=false`).

| Item | Value |
|---|---|
| Worker | `certpath-pilot` |
| Live URL (proposed) | `https://certpath-pilot.certpath.workers.dev` |
| **Google OAuth callback URL** | `https://certpath-pilot.certpath.workers.dev/api/auth/google/callback` |
| D1 database | `certpath-pilot` (isolated; not shared with the demo or sandbox) |
| Config | `apps/web/wrangler.pilot.jsonc` |
| Entry | `apps/web/workers/pilot.ts` |

## Prerequisites checked before provisioning (read-only)

Read on 14 November 2026 for account `ef67137c...420f3`:

| Check | Result |
|---|---|
| Identity | `wrangler whoami` - OAuth token, account `Certpath` |
| Worker scripts | 3 (`certpath-site`, `certpath-staff-mfa-sandbox`, `certpath-ui-preview`) of the Free 100-script allowance |
| D1 databases | 1 (`certpath-staff-mfa-sandbox`) of the Free 10-database allowance; 9 free slots |
| Plan via API | `GET /accounts/{id}/subscriptions` returned **403** for this token scope; confirm Workers Free in the dashboard before provisioning |
| Request/quota analytics | GraphQL `workersInvocationsAdaptive` rejected for this token; confirm daily request and D1 usage in the dashboard |

The read-only list calls used `GET /accounts/{account_id}/workers/scripts` and
`GET /accounts/{account_id}/d1/database`; no write call was made.

## Setup steps (only after review)

1. **Create the database and record its id.**
   `npx wrangler d1 create certpath-pilot`
   Put the returned `database_id` into `wrangler.pilot.jsonc`.
2. **Apply migrations.**
   `npx wrangler d1 migrations apply certpath-pilot --remote -c apps/web/wrangler.pilot.jsonc`
3. **Seed the invited learner and one exam grant.** Pick fresh UUIDs:
   `npx tsx apps/api/scripts/seed-pilot-learner.ts --user-id <u> --certification-id <c> --exam-version-id <v> --grant-id <g> --remote`
   The script creates an active user, one certification, one exam version, and
   one Standard grant (default 7 days). It is idempotent and creates **no**
   identity.
4. **Create the Google OAuth client.** In the Google Cloud console create a
   project, configure the OAuth consent screen (External, Testing), add the
   invited Google account as a test user, and create a **Web application**
   client whose *Authorized redirect URI* is exactly
   `https://certpath-pilot.certpath.workers.dev/api/auth/google/callback`.
5. **Set Worker configuration and secrets.**
   ```powershell
   npx wrangler secret put STAGING_TESTER_IPS -c apps/web/wrangler.pilot.jsonc
   npx wrangler secret put STAGING_AUTH_RATE_LIMIT_HMAC_SECRET -c apps/web/wrangler.pilot.jsonc
   npx wrangler secret put GOOGLE_OIDC_CLIENT_SECRET -c apps/web/wrangler.pilot.jsonc
   npx wrangler secret put GOOGLE_OIDC_TRANSACTION_KEY -c apps/web/wrangler.pilot.jsonc
   ```
   `STAGING_TESTER_IPS` is the tester's egress IP list, `*_SECRET` and
   `GOOGLE_OIDC_TRANSACTION_KEY` are at least 32 bytes of random data. Never
   commit any of them. Do **not** set `AWS_*`, `LAMBDA_FUNCTION_URL`,
   `LOCAL_*`, or `STAGING_LEARNER_AUTH_ENABLED`.
6. **Deploy with the client id.**
   `npm run build:pilot` then
   `npx wrangler deploy -c apps/web/build/server/wrangler.json --var GOOGLE_OIDC_CLIENT_ID:<client-id>.apps.googleusercontent.com`
   (`npm run deploy:pilot` deploys without the var; use it only if the id is
   already in the config.)
7. **Link the invited Google identity** to the seeded learner:
   `npx tsx apps/api/scripts/link-google-learner.ts --user-id <u> --subject <google-sub> --remote`
   The subject is the Google account's `sub` claim, not its email. The statement
   refuses unknown, disabled, already-linked learners and duplicate subjects.
8. **Confirm the gate before telling anyone the URL exists:** an unsigned request
   from an IP outside `STAGING_TESTER_IPS` returns `403`.

## Verification checklist

Record every result with a timestamp. Synthetic data only.

| # | Check | How | Pass |
|---|---|---|---|
| 1 | Tester gate | Request `/` from an unlisted IP | 403, no D1 write |
| 2 | Sign-in reaches the dashboard | Open `/sign-in`, choose **Continue with Google**, approve with the invited account | Lands on `/app/home`, one authorized exam, Secure `__Host-certpath_session` cookie |
| 3 | Uninvited account is refused | Repeat with a Google account that has no linked subject | `/sign-in?error=not_invited`, no session, no new `auth_identities` row |
| 4 | Worker CPU | `wrangler tail --format json`, send the sign-in and dashboard requests one at a time, wait for each `cpuTime` event | Record max CPU, count above 5 ms, count at/above 10 ms; **hold for review above 5 ms**, **stop at 10 ms or a 1102 error** |
| 5 | Cross-device resume | Sign in on device A, start a practice attempt and wait for the save; sign in on device B | Dashboard shows the same current question and progress |
| 6 | Saved mock result | Complete the timed mock on one device, then reopen the result from the dashboard on the other | Same score and explanations; result survives refresh |
| 7 | Session end | Sign out | Cookie cleared, D1 `app_sessions.revoked_at` set, dashboard returns 401 |

Content precondition for checks 5 and 6: the pilot database has no questions
until approved synthetic content is imported through the admin path (admin routes
are closed in this Worker, so the import runs against the database directly or
from a reviewed seeding run). Until then, record checks 5 and 6 as **blocked by
content review** rather than passed.

## Rollback

Run in order; each step is safe to repeat.

1. **Close access first.** Delete the tester allowlist so every request fails
   closed: `npx wrangler secret delete STAGING_TESTER_IPS -c apps/web/wrangler.pilot.jsonc`.
   Confirm `/` and `/api/health` return 403.
2. **Revoke the Google client.** Delete the OAuth client in the Google console so
   no new authorization codes can be issued.
3. **Remove the Worker.** `npx wrangler delete --name certpath-pilot`, then
   confirm the workers.dev URL returns 404.
4. **Delete the secrets** (`wrangler secret list` must be empty before deletion,
   or they disappear with the Worker).
5. **Delete the database.** `npx wrangler d1 delete certpath-pilot -y`, then
   confirm it is absent from `npx wrangler d1 list`.
6. **Record evidence:** Worker 404, database absent, secrets gone, Google client
   deleted, and no remaining `certpath-pilot` resource in the dashboard.

## Cost

Workers Free and D1 Free only: no paid plan, no AWS resources, no email, and
`wrangler tail` is free. The pilot adds one script (4 of 100) and one database
(2 of 10). Any Cloudflare charge or plan change is a stop condition.

## Local verification of this preparation

| Command | Result |
|---|---|
| `npm run build:pilot` | passed, `Verified pilot entry: workers/pilot.ts` |
| `npm run dry-run:pilot` | passed, 1,695 KiB upload, bindings `DB`, `PUBLIC_SITE_ORIGIN`, `GOOGLE_OIDC_REDIRECT_URI` only |
| `npx vitest run --config vitest.config.ts test/pilot-seed.test.ts` (in `apps/api`) | 4 passed: creates user/exam/grant, is idempotent, creates no identity, rejects unsafe input |
| `npx tsx --test app/lib/worker-routes.test.ts app/components/learner-sign-in-pilot.test.tsx` (in `apps/web`) | 6 passed: excluded-path matching and the pilot sign-in page |
| `npm run verify` | see the pull request for the recorded result |
