# Learner authentication staging readiness

**Status:** Local preparation only; staging is not ready to enable.
**Base:** `c8d87bde2f94aa828d52ad6980eca3c8257cff1e` (`origin/main`)
**Checked:** 13 November 2026

No cloud resources were created or changed, no email was sent, and no account
was upgraded. PR #15 and the staff MFA/Cognito sandboxes remain untouched.

> **Update, 18 November 2026.** The staging Worker still does not exist
> (`code: 10007`), so nothing in this review is deployed. Two statements above
> have since gone stale: the `database_id` in `apps/web/wrangler.staging.jsonc`
> is the real `certpath-learner-staging` id recorded in #134, not a placeholder;
> and that config now declares a `*/5 * * * *` cron plus the three pilot event
> flags, all `"false"` (#141). The cron exists so the staging Worker can prune
> pilot events once it is deployed — with every flag `"false"` its `scheduled`
> handler prepares no statement and reads no row — so the "keep cron jobs off"
> precondition below is about an enablement run, not about the committed config.

## Readiness summary

The HTTPS sign-in path is implemented for local review only. No Cloudflare or
AWS resources were created or changed, no email was sent, and no credentials
were provisioned.

The existing local learner-auth path remains loopback-only and retains its
local test inbox. Staging uses a separate router and Worker entry; it does not
enable `LOCAL_*`, registration, recovery, email, scheduled work, or the
synthetic inbox. The staging Worker is gated by a tester IP allowlist before
dispatching any request. Sign-in requires the exact staging HTTPS origin and a
pre-auth CSRF cookie/token pair. It uses a Secure `__Host-` session cookie,
existing D1 learner/exam authorization and rate limits, and one SigV4-signed
verification request to a fixed `eu-north-1` Lambda Function URL per eligible
attempt. The signer requires a temporary session token; staging configuration
and credentials are not included in the repository.

The staging Wrangler configuration intentionally contains a placeholder D1
identifier and no secrets, tester allowlist, Lambda URL, or credentials. Do not
deploy it. Local regression tests use the Cloudflare Vitest D1 fixture and a
stubbed verifier; a separate test captures a locally signed request using
synthetic credentials.

Build the local-review bundle from the repository root with:

```powershell
npm run build:staging
```

This selects `apps/web/wrangler.staging.jsonc`, writes the Worker bundle under
`apps/web/build/server`, and verifies both the generated Wrangler config and
source map identify `workers/staging-app.ts`. It only builds; it does not
provision or deploy resources. The local-only HTTPS integration harness may
use a self-bound verifier stub and an isolated D1 persistence directory; those
test bindings are not part of the staging Wrangler config.

The harness needs the complete staging binding set: `STAGING_LOCAL_TEST=true`,
an HTTPS loopback `PUBLIC_SITE_ORIGIN`, `STAGING_TESTER_IPS`,
`STAGING_LOCAL_TEST_PASSWORD`, the `STAGING_LAMBDA_TEST_STUB` service binding,
synthetic temporary AWS credentials with `AWS_REGION=eu-north-1`, and a
shape-valid `LAMBDA_FUNCTION_URL` such as
`https://staging-local-stub.lambda-url.eu-north-1.on.aws`. The stub intercepts
the signed request, so that host is never contacted. Missing any one of them
makes the Worker fail closed before CSRF: `GET /api/auth/staging/preflight`
still answers `200` but reports `signInEnabled: false`, while
`GET /api/auth/staging/csrf` answers `503`. An empty `LAMBDA_FUNCTION_URL`
produces exactly that pair, so treat it as an incomplete local binding set
rather than a browser, cookie, or origin fault.

Deployed validation remains blocked. The unchanged scrypt profile has prior
19–20 ms Worker CPU observations against the Workers Free 10 ms per-request
limit. No hashing parameters were changed. Obtain reviewed, deployed CPU and
memory evidence before considering any pilot; do not upgrade an account or
exceed the $0 out-of-pocket cap.

## Local Worker scrypt measurements

The existing profile is `@noble/hashes` scrypt with `N=32768`, `r=8`, `p=1`,
16-byte random salt, 32-byte output, `asyncTick=10`, and `maxmem=64 MiB`.

The measurements below came from
`apps/api/benchmark/local-auth-runtime-benchmark.test.ts` in the Cloudflare
Vitest plugin's local Workerd runtime, using local D1 and synthetic
`@example.test` accounts. It used `performance.now()` and reports wall-clock
time, not Workers CPU time. Each value is one observed run on the Windows
development machine, not a percentile or a capacity guarantee. All sign-in
responses were HTTP 200. The benchmark sends no email.

Re-run it from the repository root with:

```powershell
npm run benchmark:local-auth --workspace=@certpath/api
```

The separate benchmark configuration keeps its variable-duration workload out
of the regular `npm run verify` suite.

| Local operation | Concurrency | Batch wall time |
|---|---:|---:|
| Password hash creation | 1 | 1,785 ms |
| Sign-in requests | 1 | 1,847 ms |
| Sign-in requests | 2 | 3,782 ms |
| Sign-in requests | 4 | 7,741 ms |

This local harness does not expose Cloudflare's per-request CPU accounting or
per-isolate high-water memory. `maxmem=64 MiB` is a per-derivation ceiling, not
a measured resident footprint. The standard scrypt `128 * N * r` working-set
estimate is about 32 MiB per derivation; four concurrent derivations could
therefore approach 128 MiB of scrypt workspace alone, before the Worker heap,
D1/runtime state, and other request allocations.

Cloudflare's current limits page lists Workers Free at **10 ms CPU per HTTP
request** and **128 MB memory per isolate**. The memory limit is shared by
concurrent requests in that isolate. The 1.6-second local wall time is not a
direct comparison to the 10 ms CPU budget, because wall time includes
scheduling and asynchronous yields. Nevertheless, scrypt is CPU-intensive and
the gap is large enough to flag a likely Free CPU-limit mismatch for review.
The approximately linear increase in local batch wall time at concurrency 2
and 4 also warrants a deployed concurrency test. Local success does not prove
deployed memory safety.

**Do not change the scrypt parameters in this slice.** Before staging, capture
Workers invocation CPU time and memory outcomes on the actual deployed
configuration, including concurrent sign-ins. If Free's 10 ms cap is
exceeded, stop and obtain architect/owner approval for an alternative
implementation or hosting decision; do not silently weaken the password
hashing profile or upgrade an account.

## Prior email research (not in scope)

The staging-only implementation uses a pre-provisioned synthetic learner and
does not send email or expose registration, verification, or password-recovery
routes. The following earlier SES research is retained for context only; it is
not authorization to provision SES or send messages.

Official SES documentation reviewed on 13 November 2026 says:

- The SES Essentials pricing page lists **$0.16 per 1,000 outbound emails**.
  At one recipient per email, one verification message plus one reset message
  is approximately **$0.00032** in outbound-email charges, before any
  separately billable services or add-ons. Eligible AWS Free Tier credits can
  apply, but pricing documentation does not confirm this account's eligibility
  or current balance.
- New SES accounts are in a regional sandbox. The sandbox can send only to
  verified recipient addresses/domains or the mailbox simulator, with a limit
  of **200 messages per 24 hours** and **1 message per second**. A single
  controlled test mailbox can fit those limits if it is verified in the same
  region. Production-access approval is not needed for that verified
  recipient; moving out of the sandbox would require a separate request.
- A sender must use a verified SES identity. A domain identity requires DNS
  control and DKIM-based verification. Identities are regional, so verification
  in one AWS region does not establish verification in another.
- SES sending quotas are regional and count recipients, not just API calls.

This session could not verify the AWS Free plan/credit balance, SES sandbox
status, regional quotas, or an existing verified sender identity: the AWS CLI
is unavailable in the workspace and opening the SES console page failed. Thus
**the email option is not confirmed within the $0 out-of-pocket cap**. Do not
provision SES, add DNS records, send email, request production access, or
upgrade an account until the owner confirms the account-specific billing and
identity state. The Worker-to-SES authentication mechanism and least-privilege
permissions also need review; no long-lived credential approach is approved
here.

## Future isolated staging CPU validation

This is a checklist for a later, separately approved validation; none of these
steps were performed here.

### Preconditions and isolation

1. Before provisioning, verify current Cloudflare Workers Free capacity and
   AWS Free plan/eligible credits, regional capacity, invocation permissions,
   and expected usage. Proceed only if the bounded work remains within the $0
   out-of-pocket cap without payment or upgrade.
2. Obtain owner/architect review of the unchanged scrypt profile and prior
   19–20 ms CPU observations. Use a separate staging Worker and D1 database;
   never reuse production, local D1, or either Cognito sandbox.
3. Keep the staging Worker disabled until the exact origin,
   `STAGING_TESTER_IPS`, one pre-provisioned `@example.test` learner, isolated
   D1, and fixed `eu-north-1` `AWS_IAM` Function URL are verified. Store only
   short-lived, invoke-only AWS credentials as Worker secrets. Keep all
   `LOCAL_*` flags, email, cron jobs, registration, recovery, payments, and
   production integrations off.
4. Verify unauthorized requests are rejected before D1 or Lambda work, and
   unsigned Function URL requests are rejected. Confirm the function
   permission is scoped only to invoking that test function through its URL.
5. After review, run 50 sequential sign-in attempts across the configured
   rate-limit windows, with idle gaps and rate limits enabled. Report attempts
   reaching Lambda separately from early rejections. Do not retry Lambda
   requests. Capture full Worker CPU including middleware and D1, plus
   end-to-end latency; report maximum CPU and counts above 5 ms and at or above
   10 ms. Hold for review above 5 ms and stop at 10 ms or on any CPU-limit
   error. Never report wall time as Worker CPU.
6. Confirm successful sign-in/dashboard access, wrong-password rejection,
   single-exam server-side authorization, and logout revocation. Keep
   passwords, hashes, credentials, cookies, signed headers, and request bodies
   out of logs and evidence. Record unavailable metrics as unmeasured.

### Teardown

1. Disable staging sign-in and remove the tester allowlist.
2. Revoke sessions and remove the synthetic learner, password credential,
   audit fixtures, and one-exam grant from staging D1.
3. Remove staging Worker secrets and revoke the short-lived AWS credentials
   and function-URL permission created for the run.
4. Delete only the isolated staging Worker and D1 resources created for the
   run. Confirm cleanup and review pre/post usage, credits, and any pending
   billing.

## Local HTTPS harness results

The built staging bundle (`npm run build:staging`) was served locally over
HTTPS with isolated D1, one synthetic `@example.test` learner, one authorized
exam, and the self-bound verifier stub. Synthetic credentials, the fixture
password, and signed headers are not reproduced here.

- Unlisted tester IP — `403` before D1 or verifier work.
- Foreign `Origin` on CSRF — `503`; foreign `Origin` on sign-in — `403
  invalid_origin`; `/api/auth/local/*` — `404`.
- Real sign-in form — `GET /api/auth/staging/csrf` `200`, then
  `POST /api/auth/staging/sign-in` `200`, then `/app/home` and
  `GET /api/practice/dashboard` `200` with one authorized exam.
- Session cookie — `__Host-certpath_session` with `Path=/`, `Max-Age=28800`,
  `HttpOnly`, `Secure`, `SameSite=Lax`; not readable from `document.cookie`,
  and re-sent automatically after a full reload.
- Logout — `/api/auth/session/csrf` `200`, `/api/auth/session/logout` `204`,
  then `GET /api/practice/dashboard` `401`; isolated D1 showed two sessions
  created and both revoked with none active.
- Verifier stub calls — one per eligible sign-in and none from the rejected
  requests.

This proves the local path only. Deployed Worker CPU and memory remain
unmeasured and block a staging pilot.

## Local validation

- `npm run benchmark:local-auth --workspace=@certpath/api` — passed; one
  benchmark test, with four concurrent sign-ins returning HTTP 200.
- `npm run verify` — passed (typecheck, 92 API tests across 12 files, 64 web
  tests, and workspace builds).
- The staff-authorization test now has an explicit 20-second timeout because
  its scrypt-backed flow exceeded Vitest's 5-second default on this Windows
  development machine; its assertions still run and pass.

## Official sources

- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) — Free CPU and per-isolate memory limits (page last updated 29 October 2026).
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) — Free and paid usage model (page last updated 2 October 2026).
- [Amazon SES pricing](https://aws.amazon.com/ses/pricing/) — Current plans, outbound-email pricing, and Free Tier credit notes.
- [Creating and verifying SES identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html) — Sender identities, DNS/DKIM, and region-specific verification.
- [Requesting SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) — Sandbox recipient restrictions and quotas.
- [Managing SES sending quotas](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html) — Regional, recipient-based quota behavior.
