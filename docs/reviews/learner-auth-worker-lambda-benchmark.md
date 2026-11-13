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

## Worker CPU telemetry (proved before the rerun)

Source: `wrangler tail --format json` on the deployed Worker. Each invocation
event carries `cpuTime` and `wallTime` in whole milliseconds, tied to the
request by URL path. This works on Workers Free with no paid feature. The first
attempt could not use it only because the parser expected one JSON object per
line while tail prints pretty-printed JSON; the parser now reads concatenated
objects and prints only path, outcome, status, `cpuTime` and `wallTime`.

Zero-Lambda proof requests against the deployed Worker (no Lambda configured or
called):

| Request | Status | CPU | Wall |
|---|---|---|---|
| `GET /` (readiness) | 200 | 0 ms | 0 ms |
| `POST /signing-probe` (tester-gated; signs ten requests locally with fake credentials, no network call) | 200 | 4–5 ms (three runs) | 4–5 ms |

The probe shows the metric is visible, responds to real CPU use, and that ten
SigV4 signings alone cost about half the budget. Resolution is 1 ms, so a value
of 0 means under 1 ms. Wall-clock latency and local timings were not used as
CPU evidence. Workers Free allows **10 ms CPU per HTTP request**
(100,000 requests/day, 50 subrequests/request) per Cloudflare's published
limits.

## Preflight (before provisioning)

| Check | Result |
|---|---|
| AWS plan | `FREE` / `ACTIVE`; $120.00 credits remaining (rechecked immediately before the run) |
| Free Tier usage API (Lambda/CloudWatch/data transfer) | Returned no rows in the earlier run; treated as **unknown** |
| Lambda concurrency, `eu-north-1` | 10 total, 10 unreserved (need 4) |
| Existing benchmark resources | None (functions, roles, log groups) |
| Cloudflare Workers Free | One temporary Worker deployed with no payment or upgrade prompt; the dashboard plan page was not readable from this session, so the plan is inferred from the successful deploy and the enforced 10 ms limit |
| Permissions | The configured AWS profile created and deleted the temporary resources; no policy was widened |
| Cleanup manifest and recovery command | Validated before provisioning: the manifest was written, then `cleanup.ts` was run against it with nothing deployed and had to exit 0 with `complete: true` (retried up to 3 times for transient AWS CLI SSL errors; the run that hit one was retried successfully) |

Maximum expected usage (bounded by the 10-call cap):

- **Lambda:** 10 invocations, 1769 MB, 3 s timeout, so at most 53 GB-seconds;
  about 0.3 s each is expected. Far below the 400,000 GB-s monthly allowance and
  also covered by credits.
- **Logging:** one-day retention log group, about 10 REPORT lines plus start/end
  lines (well under 50 KB).
- **Data transfer:** under 10 KB of request and response bodies in total.
- **Telemetry:** `wrangler tail` is free; no Logpush or paid analytics used.
- **Workers Free:** under 20 requests against 100,000/day.

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
| Zero-Lambda `/signing-probe` before the batch (deployed) | HTTP 200, CPU 2 ms |
| Signed batch | 10 Lambda calls, HTTP 200 each, max 4 in flight, no retries |
| Lambda hash verified locally | Passed |
| Locally created hash verified by Lambda | Passed |
| Wrong password rejected by Lambda | Passed |

### Worker CPU versus the Free limit

| Metric | Result |
|---|---|
| **Worker CPU, whole `/run` request (tail `cpuTime`)** | **9 ms** |
| Verified Workers Free limit | 10 ms per HTTP request |
| Headroom | **1 ms (10%)**, within the 1 ms resolution of the metric |
| Worker wall time for the request | 2,766 ms (includes waiting on Lambda; not CPU) |

The request completed with outcome `ok`, so it stayed under the limit.

### Latency and resources (separate from Worker CPU)

| Metric | Result |
|---|---|
| Worker-to-Lambda round trip per call | 230–739 ms (3 cold-start calls 443–739 ms; warm 230–452 ms) |
| Whole Worker request, end to end from the tester | 2,923 ms for the ten-call batch |
| Lambda handler elapsed time | 181.7–300.2 ms |
| Lambda platform duration (REPORT) | 183.4–306.5 ms; billed 184–420 ms each, 2,653 ms total (about 4.7 GB-s) |
| Lambda init (3 cold starts) | 113.4–139.3 ms |
| Lambda peak memory | **156 MB** (REPORT) of 1,769 MB |

### What one batch can and cannot establish

It shows that, on this one run, ten signings, ten subrequests and JSON handling
fit in the 10 ms Free budget, and that the Lambda scrypt profile is hash
compatible both ways with wrong-password rejection. It cannot show the CPU
distribution: this is a single sample at 1 ms resolution, and the probe showed
signing alone costs 4–5 ms with run-to-run variation. With 1 ms of headroom, a
slower isolate, a cold Worker start or a larger payload could push the same code
over the limit (error 1102). One batch is therefore **not** enough to commit to
this design on Workers Free. A learner sign-in would also need one signed call,
not ten, so it would use far less CPU than this batch; that is an inference, not
a measurement.

**Recommendation:** the result supports continuing to evaluate Workers Free for
a single-call sign-in path, not for the ten-call shape. Before relying on it,
measure repeated single-call requests (and consider caching the imported signing
key), still within the $0 cap. Do not treat 9 ms as comfortable.

## Findings during the runs

1. The first attempt failed before any Lambda call: `fetch(..., { redirect:
   "error" })` is not supported in Workers. The caller now uses
   `redirect: "manual"` and treats any non-2xx response, including a redirect,
   as a failure. Local Node tests did not catch this runtime difference.
2. In the first attempts the cleanup manifest's random suffix was shorter than
   the cleanup script's validation, so the script refused to run; the AWS
   resources were deleted manually and verified absent. The driver now uses a
   valid suffix and runs the cleanup script against the manifest before
   provisioning, which is the check that now gates every run.
3. Cloudflare reported the Worker for a short time after deletion; the run now
   polls until the URL returns 404 and `secret list` reports "not found".
4. The CPU-measurement gap in the earlier run was a tail parsing bug, not a
   missing Free-plan feature.

## Cleanup and billing

Removed and verified in the final run: the Worker (workers.dev URL returns 404)
and its secrets (`secret list`: not found), the Function URL, the function, the
execution role and policy, the temporary invoker role and policy, and the log
group (zero matching resources remain; the AWS cleanup script exited 0). STS
credentials expired within 900 s. The `/signing-probe` route is tester-gated,
makes no network call and uses fake credentials.

| | Before | After |
|---|---|---|
| Plan | FREE / ACTIVE | FREE / ACTIVE |
| Credits remaining | $120.00 | $120.00 (billing data not yet updated) |
| Billed Lambda duration | — | 2,653 ms ≈ 4.7 GB-s |

AWS billing and Free Tier usage can lag by hours. Recheck Billing and Cost
Explorer later and treat the figures above as **pending**. No payment or
upgrade was requested by AWS or Cloudflare.