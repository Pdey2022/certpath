# Learner authentication staging readiness

**Status:** Local preparation only; staging is not ready to enable.
**Base:** `c8d87bde2f94aa828d52ad6980eca3c8257cff1e` (`origin/main`)
**Checked:** 13 November 2026

No cloud resources were created or changed, no email was sent, and no account
was upgraded. PR #15 and the staff MFA/Cognito sandboxes remain untouched.

## Readiness summary

Two unresolved gates prevent a staging test:

1. The current learner-auth implementation is intentionally restricted to
   loopback origins. Its local-only configuration also enables the synthetic
   in-memory inbox. It cannot safely be enabled on a staging Worker by setting
   the existing `LOCAL_*` flags. A separate staging gate and real email
   adapter require architect review.
2. The current scrypt measurements indicate a likely Workers Free CPU-limit
   mismatch and a potential per-isolate memory risk under concurrent
   sign-ins. No hashing parameters were changed. Get deployed Worker CPU and
   memory evidence before deciding whether the profile or hosting plan is
   acceptable.

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

## Email delivery recommendation: Amazon SES

Recommend evaluating **Amazon SES** as an outbound delivery transport only.
CertPath would continue to own password hashes, verification/reset policy,
application sessions, identities, roles, and exam grants. SES would not become
an authentication or authorization provider.

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

## Future isolated staging runbook

This is a checklist for a later, approved staging slice; none of these steps
were performed here.

### Preconditions and isolation

1. Obtain owner/architect approval for the deployed scrypt CPU/memory results,
   the email cost gate, staging origin, test address, and staging-only enable
   controls.
2. Verify current AWS plan/credits and SES account state in the selected
   region. Confirm the sender identity and the one controlled recipient are
   verified in that region, and that the expected sends remain within the
   approved $0 out-of-pocket cap.
3. Use a separate staging Worker and D1 database. Do not reuse the staff
   Cognito sandbox, learner Cognito sandbox, production resources, or local
   D1. Keep test data synthetic apart from the one real inbox address needed
   for delivery.
4. Add and validate a backend allowlist for exactly one test learner and a
   tester-network restriction before enabling sign-in. Do not rely on a
   client-side-only restriction.
5. The current local-only code refuses non-loopback origins. Build and review
   a distinct staging configuration and production-mail adapter before this
   test. Keep `LOCAL_LEARNER_AUTH_ENABLED` and
   `LOCAL_TEST_MAIL_ENABLED` disabled; do not bypass the loopback guard.
   Ensure the synthetic inbox UI/API is unavailable in staging and verify the
   API does not expose verification or reset links.
6. Keep sign-in disabled while validating the staging origin, network
   restriction, one-address allowlist, SES sender/recipient identities,
   secret bindings, and logging redaction. Enable the test only after these
   checks pass.

### One-learner test

1. Register the single allowlisted learner by email only. Confirm that no
   session or exam grant exists before mailbox verification.
2. Deliver a verification message through SES to the verified, owner-controlled
   test inbox. Complete verification and choose the password on the
   verification page. Confirm the token is single-use, only a salted hash is
   stored, and the learner receives no staff role.
3. Sign in and confirm `/app/home` shows no exam access before a grant exists.
   Use an explicitly reviewed, staging-only and audited operation to grant
   `Standard` access to exactly one exam. Confirm that exam is visible and a
   second exam remains inaccessible.
4. Request password reset, complete it from the test inbox, and confirm the
   reset revokes the existing CertPath D1 session. Sign in with the new
   password and verify the one-exam boundary again.
5. Sign out through the CSRF-protected session endpoint. Confirm the D1
   session is revoked and the old session cannot access `/app/home`.
6. Confirm application logs contain no passwords, raw verification/reset
   links, cookies, or raw session tokens. Record SES delivery/usage and
   account billing evidence separately.

Public registration must remain closed except for the exact allowlisted test
address. No public or learner session may assign a staff role. Any staff/admin
route continues to require the existing Global Admin or exam-scoped Manager
authorization and fresh, signed authenticator-app MFA evidence. Since the
staff MFA sandbox remains parked, do not use an admin UI or add a staging
admin bypass; use only the separately approved, audited staging grant setup.

### Teardown

1. Disable staging learner sign-in and remove the test-network and learner
   allowlists.
2. Revoke active CertPath sessions and remove the synthetic learner,
   password credential, verification/reset tokens, audit fixtures, and
   one-exam grant from staging D1.
3. Remove staging-only Worker secrets and the email adapter configuration.
   Revoke any staging-only SES credentials. Remove only SES identities and DNS
   records created specifically for this test; preserve shared identities.
4. Delete the isolated staging Worker and D1 database when no longer needed.
   Review account usage/billing for delayed SES charges against the approved
   cap.

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
