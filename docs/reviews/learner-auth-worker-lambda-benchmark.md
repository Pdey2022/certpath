# Worker-to-Lambda scrypt benchmark

**Status:** Completed once on 13 November 2026 within the $0 out-of-pocket cap.
All temporary Cloudflare and AWS resources were removed. This is a synthetic
benchmark only; it does not change production routes, learner sign-in, D1,
email, PR #15, or staff MFA.

## What was built

- `apps/api/benchmark/worker-lambda/worker.ts` — isolated Worker. It checks the
  tester IP before routing or parsing, then runs exactly ten signed calls to one
  fixed `AWS_IAM` Function URL: four sequential, a wave of two, and a wave of
  four. There are no retries, a 10-call cap, and a four-request in-flight
  ceiling. The URL must be HTTPS and match `*.lambda-url.eu-north-1.on.aws`; it
  is never taken from a request.
- `sigv4.ts` — SigV4 signer using only Web Crypto (no Node built-ins). A test
  compares its `Authorization` value with `@smithy/signature-v4`.
- `client.ts` — tester-side driver. It sends a locally generated hash, verifies
  the Lambda-generated hash locally, and prints only sanitized numbers.
- Reuses the PR #22 Lambda handler and the unchanged scrypt profile
  (`N=32768`, `r=8`, `p=1`). Inputs are fixed synthetic strings.
- `wrangler.worker-lambda.jsonc` — Worker `certpath-scrypt-lambda-proof`, no D1,
  email, or application bindings.

Local tests (`npm run verify`) cover signing parity, rejection before Lambda,
ten-call/four-in-flight bounds, fixed destination, no retry after a Lambda
error, and no credentials or synthetic password in responses.

## Preflight (before provisioning)

| Check | Result |
|---|---|
| AWS plan | `FREE` / `ACTIVE`, expires 2027-05-11; $120.00 credits remaining |
| Free Tier usage API (Lambda/CloudWatch/data transfer) | Returned no rows; treated as **unknown** |
| Lambda concurrency, `eu-north-1` | 10 total, 10 unreserved (need 4) |
| Existing benchmark resources | None (functions, roles, log groups) |
| Cloudflare Workers Free | Account was recorded as Free with room for one temporary Worker in the PR #20 evidence; the dashboard was not readable from this session. The deploy completed with no payment or upgrade prompt |
| Permissions | The configured AWS profile created and deleted the temporary resources; no policy was widened |

Maximum expected usage (bounded by the 10-call cap):

- **Lambda:** 10 invocations, 1769 MB, 3 s timeout, so at most 53 GB-seconds
  (10 × 3 s × 1.769 GB); about 0.3 s each is expected. This is far below the
  400,000 GB-s monthly free allowance and is also covered by credits.
- **Logging:** one-day retention log group, roughly 10 REPORT lines plus start/end
  lines (well under 50 KB).
- **Data transfer:** under 10 KB of request and response bodies in total.
- **Workers Free:** a handful of requests against 100,000/day.

## Run

Credentials were short-lived (900 s) STS credentials from a temporary role
allowing only `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` on the test
function with `lambda:FunctionUrlAuthType=AWS_IAM`, and were stored as temporary
Worker secrets. Secrets, signed headers, hashes, and synthetic passwords were
not logged or recorded here.

| Check | Result |
|---|---|
| Unsigned Function URL request | HTTP 403 |
| Unauthorized request to Worker (decoy tester IP) | HTTP 403; zero Lambda `REPORT` log lines afterwards |
| Signed batch | 10 Lambda calls, HTTP 200 each, max 4 in flight |
| Lambda hash verified locally | Passed |
| Locally created hash verified by Lambda | Passed |
| Wrong password rejected by Lambda | Passed |

### Latency and resources

| Metric | Result |
|---|---|
| Worker-to-Lambda round trip per call | 254–741 ms (cold-start calls 579–741 ms; warm 254–354 ms) |
| Whole Worker request, end to end from the tester | 3,178 ms for the ten-call batch |
| Lambda handler elapsed time | 183.6–305.5 ms (warm 183.6–214.0 ms) |
| Lambda platform duration (REPORT) | 185.3–320.2 ms; billed 186–432 ms |
| Lambda init (4 cold starts) | 111.6–139.0 ms |
| Lambda peak memory | **154 MB** of 1,769 MB |
| **Worker CPU time** | **Unmeasured.** `wrangler tail` captured no events and Workers analytics was not available to this session |

Worker CPU was not recorded, so this run does not show whether the Worker's
signing and fetch work fits the 10 ms Workers Free budget. Rerun only with an
approved way to read per-request CPU.

## Findings during the run

1. The first attempt failed before any Lambda call: `fetch(..., { redirect:
   "error" })` is not supported in Workers. The caller now uses
   `redirect: "manual"` and treats any non-2xx response, including a redirect,
   as a failure. Local Node tests did not catch this runtime difference.
2. In that attempt the cleanup manifest's random suffix was shorter than the
   cleanup script's validation, so the script refused to run; the three AWS
   resources were deleted manually and verified absent. No Lambda invocation
   occurred. The final run used a valid suffix and the cleanup script succeeded.
3. Cloudflare reported the Worker for a short time after deletion; it returned
   404 (`1042`) and `secret list` reported "not found" shortly afterwards.

## Cleanup and billing

Removed and verified: the Worker and its secrets, the Function URL, the
function, the execution role and policy, the temporary invoker role and policy,
and the log group (zero matching resources remain; the AWS cleanup script
reported `complete: true`). STS credentials expired within 900 s.

| | Before | After |
|---|---|---|
| Plan | FREE / ACTIVE | FREE / ACTIVE |
| Credits remaining | $120.00 | $120.00 (billing data not yet updated) |
| Billed Lambda duration | — | 2,847 ms ≈ 5.0 GB-s |

AWS billing and Free Tier usage can lag by hours; the usage API returned no
rows. Recheck Billing and Cost Explorer later and treat the figures above as
**pending**. No payment or upgrade was requested.
