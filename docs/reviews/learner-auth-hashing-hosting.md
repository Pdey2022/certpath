# Learner password-hashing hosting review

**Status:** Documentation-only evaluation; no hosting option selected for
production and no cloud changes made.
**Branch:** `docs/learner-auth-hashing-hosting`
**Base:** `64daaf7d2fdd709a43d5527a1bc306fa51cf92d1` (`origin/main`)
**Sources checked:** 13 November 2026

## Summary

The existing profile is `@noble/hashes` scrypt with `N=32768`, `r=8`,
`p=1`, a 16-byte random salt, a 32-byte derived key, and the current PHC-style
stored format. Keep those values unchanged. The deployed Workers Free proof
reported 263,522 microseconds of CPU for one hash against the 10 ms per-request
limit; the call completed, but that is not evidence that repeated use fits
Free. Its observed 35.25 MiB peak was aggregated over the hash and readiness
requests, not a per-hash or concurrent memory guarantee.

**No option is currently approved for processing real learner passwords
within a guaranteed $0 cap.** The Workers Free measurement exceeded its CPU
budget. Workers Paid has a $5/month minimum. AWS Lambda has a large published
monthly free allowance, but the account's current Free Plan is for evaluation
and AWS advises that Free Plan accounts should not process sensitive data. We
therefore require a Paid Plan before handling real learner passwords. Although
Lambda's monthly free allowance may keep a small workload's service usage at
$0, any usage beyond the account-wide allowance is billed and AWS provides no
hard account spend cap. Account usage, eligibility and limits have not been
rechecked, so a $0 real pilot is not yet a credible guarantee.

**Recommended next candidate for a synthetic-only benchmark: AWS Lambda Event
Function with an `AWS_IAM`-protected Function URL, called only by the Cloudflare
Worker.** The published 1 million requests and 400,000 GB-seconds per month
make it the most plausible place to measure the unchanged profile without a
fixed compute fee. This is not a production recommendation, does not authorize
provisioning, and must not be used for real credentials under the current Free
Plan. A future real-password pilot needs a separate Paid Plan and cost-gate
approval. If that path is not accepted or cannot be bounded below unused
allowances, neither candidate meets the cap.

PR #15 remains draft. Staff MFA is parked. This review does not change
identity ownership, enable authentication, provision resources, deploy code,
send email, or modify either sandbox.

## Existing constraints and measured baseline

- React Router SSR, Hono, D1, account ownership, opaque sessions, and
  authorization remain on Cloudflare. The hash service is stateless and gets
  no D1, session, role, or exam-grant access.
- The identity decision keeps CertPath-owned learner authentication under
  test and requires verified email before activating a password. Existing
  identities are not linked by email match. Public registration never grants
  a staff role. Both staff roles still require separate, server-verified MFA.
- The Cloudflare proof measured 263,522 microseconds CPU, 332,507
  microseconds wall time, and 36,965,472 bytes peak memory for its metrics
  group. No verification or concurrent hash was attempted after the first
  hash exceeded the Free CPU budget.
- The format and parameters above are not candidates for tuning in this
  review. The eventual proof must cross-verify hashes between the Worker and
  the candidate runtime.

## Candidates

| | AWS Lambda Event Function + Function URL | Cloudflare Workers Paid |
|---|---|---|
| Fit for measured hash | No 10 ms invocation CPU cap; configurable memory from 128 MB to 10,240 MB. At 1,769 MB Lambda documents approximately one vCPU. A 3-second timeout is a proposed pilot guard, not measured performance. | The measured 263.5 ms is below the 30-second default Paid CPU limit. Paid allows up to 5 minutes per request. |
| Memory and concurrency | Each simultaneous Event Function request uses a separate execution environment. Default account concurrency is 1,000 per region, but new accounts can have reduced concurrency and memory quotas. Reserved concurrency can bound this function and cause throttling when full. | 128 MB per isolate. One isolate can handle multiple concurrent requests; concurrent scrypt memory usage was not tested. The observed 35.25 MiB aggregate must not be extrapolated linearly. |
| Ongoing free usage | Published monthly Lambda allowance: 1 million requests and 400,000 GB-seconds. This is separate from promotional credits. Aggregate use across the account/region and the account's Free Plan eligibility must be verified. | Workers Free has 100,000 requests/day but only 10 ms CPU per HTTP request. Paid includes 10 million requests/month and 30 million CPU-ms/month, but requires a $5/month account minimum. |
| Charges after free use | On a Paid Plan, excess requests and duration are charged at the current region/architecture rates. A Free Plan account instead expires; after expiration there is no access unless upgraded. | Free over-limit CPU invocations are terminated when the limit is consistently exceeded; Paid usage above the included request/CPU allotment is billed. |
| Network | Function URLs are HTTPS endpoints on the public Internet, not PrivateLink. AWS documents 100 GB/month of internet data out free, aggregated across AWS services/regions; excess egress follows standard rates. | No additional egress or bandwidth charge on Workers Paid. Worker subrequests are not separately billed. |
| Fixed cost / billing prerequisite | No Function URL or API Gateway deployment is part of this review. A continuing AWS account requires a Paid Plan after the Free Plan period; overage can then be billed. | $5/month minimum is unavoidable even when hash traffic is below included usage. |

### AWS request path and boundary

The browser continues to submit its password to the same-origin Cloudflare
Worker over HTTPS. The Worker then makes one signed HTTPS request to a
dedicated Lambda Function URL:

- Hash creation (email-verification completion or reset): Worker sends the
  password only after it confirms the one-time verification/reset token is
  valid and unexpired; Lambda returns only the PHC-style hash. The Worker
  conditionally consumes the token and activates the hash in one D1 batch. A
  failed Lambda call must not consume the token or change the password.
- Sign-in: Worker sends the submitted password and stored PHC value; Lambda
  returns only a boolean. The Worker creates an opaque D1 session only after
  successful verification and its normal account checks.
- Reset: D1 session revocation and password-hash update remain one Worker/D1
  operation after the new hash is returned. Lambda never sees an account ID,
  email, session, staff role, or exam grant unless strictly needed for
  correlation; the proposed protocol needs none of them.

Use Function URL `AWS_IAM`, not `NONE`, with SigV4 on every call. Grant a
dedicated caller only `lambda:InvokeFunctionUrl` and the required
`lambda:InvokeFunction` permission for that function URL. Keep the signing
credential in a Cloudflare Worker secret, never in browser code or a URL, and
rotate it. The Lambda URL is still reachable from the public Internet; IAM
authentication, not obscurity or CORS, is its access control.

Passwords cross the Worker-to-AWS boundary as plaintext over TLS, and Lambda
must hold them in memory to hash/verify. The PHC value also crosses for
verification. Do not log request/response bodies, passwords, PHC values,
tokens, cookies, or raw AWS authorization headers. Disable body capture and
tracing for this endpoint; emit only sanitized timings, status and resource
metrics. Lambda must have no D1 or application-session permission.

Use request-size bounds, per-IP and per-identity abuse limits at the Worker,
and an atomic monthly hash-call budget there. Do not automatically retry
hashing calls: a retry consumes another invocation and adds latency. On
timeout, throttling, signature failure, or Lambda outage, fail closed: do not
issue a session or change a password. Leave existing D1 sessions governed by
the current Worker/D1 rules. There is no fallback to over-budget hashing on
Workers Free.

The Function URL avoids adding API Gateway or an Application Load Balancer.
Lambda usage still has request and duration charges after its allowance; the
small request/response bodies should make egress negligible for this pilot,
but the account's shared 100 GB data-transfer allowance must be checked.
CloudWatch log ingestion and any extra monitoring can have separate charges;
keep logs payload-free and verify their account-level allowance before any
live proof.

### Cloudflare Workers Paid path

This keeps the simplest trust boundary: the Worker itself creates and verifies
the existing hash, and no password leaves Cloudflare. The observed hash should
fit Paid's 30-second default CPU limit. The current published account minimum
is nevertheless $5/month, so it fails the $0 cap before usage is considered.
Paid includes 10 million requests and 30 million CPU-ms monthly, then bills
request and CPU overages. At the observed CPU rate, 610 hash operations would
use about 160,749 CPU-ms, well under the included CPU amount, but that does
not remove the $5 charge. Memory remains 128 MB per isolate; concurrency
memory and performance still need proof.

## Small-pilot usage estimate

Planning scenario (not a traffic forecast): 100 learners, five sign-in
attempts per learner per month, 100 completed email-verification/password
setups, and 10 password resets. Each event makes one Lambda call, for **610
invocations/month**. Sign-in attempts include incorrect passwords; unverified
registrations do not hash a password until the learner completes verification.

For a rough compute envelope only, use the Workers proof's 332.5 ms wall time
as a placeholder for Lambda duration, and configure 1,769 MB (1.728 GiB):

- `610 × 0.333 s × 1.728 GB ≈ 351 GB-seconds/month`
- 610 requests is 0.061% of Lambda's published 1 million monthly requests.
- 351 GB-seconds is 0.088% of the published 400,000 GB-second allowance.
- At an illustrative 1 KiB response per call, AWS egress is about 0.6 MB/month,
  far below the published 100 GB aggregate monthly free data-transfer-out
  allowance.

These are not Lambda measurements. Cold-start duration, actual CPU time, and
memory consumption can differ materially; the benchmark below must replace
these estimates. A proposed Worker-side ceiling of 10,000 calls per month,
combined with 1,769 MB memory and a 3-second Lambda timeout, gives a
conservative duration envelope of about 51,827 GB-seconds/month (13% of
400,000) and at most 10,000 requests. This ceiling is only safe if the
account's other Lambda use leaves that allowance available. An AWS billing
alarm is useful but is not a hard spend cap.

## Account-specific gates and limitations

Earlier user-provided CLI output reported an AWS **FREE / ACTIVE** account,
$100 in remaining credits with an expiry of 11 May 2027, and zero Lambda
functions in `eu-north-1`. This is a prior snapshot, not revalidated for this
review. The credits are temporary; the AWS Free Tier page describes a separate
monthly Lambda allowance. Do not count credits as an ongoing free allowance.

Before any benchmark or deployment, the owner must verify:

1. The current Free Plan status, remaining credits, expiry, and whether the
   desired Lambda Event Function and Function URL are allowed in the selected
   region. AWS states Function URLs are not available in every region.
2. The actual Lambda concurrency and memory quotas for the account and region.
   AWS says new accounts can have reduced quotas; the generic 1,000-concurrent
   default is not an account-specific guarantee.
3. Lambda request and GB-second usage across the account, all regions, and
   any consolidated billing. Verify remaining free usage, not just the
   function list in `eu-north-1`.
4. Remaining 100 GB data-transfer-out allowance and any CloudWatch/logging
   usage. The free data-transfer allowance is shared across services/regions.
5. That no paid-only service is activated and no plan upgrade is required for
   a synthetic-only benchmark. A Free Plan account expires six months after
   opening or when credits are exhausted, whichever comes first. AWS says it
   loses access at expiry; conversion to Paid is required to continue. AWS's
   Free Plan terms say accounts are for evaluation and should not be used to
   process sensitive data. A Paid Plan is therefore required before any
   real learner password crosses into AWS; Paid Plan usage beyond free
   allowances can incur charges.

If any prerequisite is unavailable, stop before a benchmark. If a
synthetic-only benchmark passes, that still does not authorize real
credentials; the owner must separately accept a Paid Plan and the remaining
overage risk. Otherwise the only Cloudflare-hosted alternative in this
comparison costs at least $5/month.

## Smallest follow-up benchmark and acceptance criteria

This is a future, separately approved test plan. It does not authorize
provisioning or deployment.

1. **Preflight the cost gate.** Confirm the account-specific facts above,
   available recurring Lambda allowance, region support, and an approved
   maximum monthly call budget. Use no temporary credits to claim an ongoing
   $0 result.
2. **Isolate the hasher.** Use a Lambda Event Function with a Function URL
   using `AWS_IAM`, no API Gateway, VPC, D1, email, application sign-in, or
   Cognito access. Start at 1,769 MB and a 3-second timeout; set low
   reserved concurrency (up to four only if the actual quota permits). Route
   all calls through the Cloudflare Worker.
3. **Use synthetic data and the exact implementation.** Bundle the same
   `@noble/hashes` implementation and unchanged scrypt parameters. Generate
   synthetic passwords, salts and identity labels inside the harness. Never
   log input values. Confirm the returned hash uses the existing PHC-style
   format, 16-byte salt and 32-byte derived key.
4. **Prove interoperability and measure.** First run one hash and one verify
   sequentially. Cross-check a Lambda-created hash with the Worker verifier
   and a Worker-created hash with Lambda verification. Then run ten hash/verify
   pairs sequentially, followed by ten request waves at concurrency two and
   ten at concurrency four if the single-request checks pass. Include both
   hash creation and verification in each level. Record cold and warm runs
   separately.
5. **Record metrics without secrets.** Measure hash/verify CPU with Node
   `process.cpuUsage()`, per-operation wall time with a monotonic timer,
   Lambda billed duration and CloudWatch `Max Memory Used`, process peak RSS
   if available, Worker-to-Lambda round-trip latency, HTTP outcomes,
   throttling, timeouts, and any memory/resource errors. Do not enable body
   logging. Record any metric the platform does not expose as unavailable.
6. **Pass only if** every cross-runtime verification and wrong-password
   negative check is correct; each invocation finishes within the configured
   three-second timeout; no throttling, memory errors, or CPU/resource errors
   occur through concurrency four; and observed usage fits the approved
   monthly budget without consuming temporary credits. Report p50/p95/max
   latency and memory rather than treating this test as a production SLO.
   If any check fails or the free allowance is not verified, stop; do not
   switch to weaker hashing or silently fall back.

## Official sources

All sources were checked on 13 November 2026. Published allowances and prices
are not a quote and do not establish this account's eligibility or remaining
quota.

### AWS

- [Lambda pricing](https://aws.amazon.com/lambda/pricing/) — Event Function
  request/duration pricing, 1 million requests and 400,000 GB-seconds monthly
  free usage, memory range, and aggregate duration pricing.
- [Lambda memory configuration](https://docs.aws.amazon.com/lambda/latest/dg/configuration-memory.html)
  — 128 MB to 10,240 MB and CPU allocation proportional to memory; 1,769 MB
  is approximately one vCPU.
- [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
  — default and new-account quota caveats, concurrency, memory, timeout and
  scaling limits.
- [Lambda concurrency](https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html)
  and [scaling behavior](https://docs.aws.amazon.com/lambda/latest/dg/scaling-behavior.html)
  — per-invocation execution environments, regional concurrency, scaling and
  throttling.
- [Function URL configuration](https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html)
  — HTTPS endpoint, regional availability and public-Internet-only access.
- [Function URL access control](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html)
  and [invocation](https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html)
  — `AWS_IAM`, required permissions, and SigV4 signing.
- [AWS Free Tier](https://aws.amazon.com/free/) and [Free Tier terms](https://aws.amazon.com/free/terms/)
  — temporary Free Plan and credit period, expiry, upgrade requirement, and
  restriction against processing sensitive data on Free Plan accounts.
- [AWS data transfer pricing](https://aws.amazon.com/ec2/pricing/on-demand/#Data_Transfer)
  — 100 GB/month internet data out free across AWS services and regions,
  followed by applicable transfer rates.

### Cloudflare

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
  — Free and Paid request/CPU allowances, overage rates, $5 Paid minimum, and
  no extra egress/throughput charge on Paid.
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
  — Free/Paid CPU limits, per-isolate memory, concurrent-request behavior,
  and errors after resource limits are exceeded.
