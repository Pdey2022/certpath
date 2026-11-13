# Worker sign-in CPU benchmark (one signed Lambda verification per request)

**Status:** Completed once on 13 November 2026 within the $0 out-of-pocket cap.
All temporary Cloudflare and AWS resources were removed. This is a synthetic
benchmark only; it does not change production routes, learner sign-in, D1,
email, PR #15, or staff MFA.

## Question

Can a deployed Worker on Certpath's Cloudflare Workers Free plan run a learner
sign-in-shaped request (validation, one signed Lambda scrypt verification,
response handling) inside the published **10 ms CPU per HTTP request** limit?

## What was built

- `apps/api/benchmark/worker-lambda/signin-worker.ts`: isolated Worker
  `certpath-signin-cpu-proof`. `POST /sign-in` does the work below; `POST /probe`
  runs the same code but replaces the Lambda call with local signing using fake
  credentials and no network call.
- `signin-client.ts` and `signin-synthetic.ts`: tester-side driver and fixed
  synthetic accounts and passwords (not real secrets).
- `wrangler.signin-cpu.jsonc`: no D1, email, or application bindings.
- Reused unchanged from PR #22 and PR #23: the Lambda handler and scrypt profile
  (`N=32768`, `r=8`, `p=1`), the Web Crypto SigV4 caller (`sigv4.ts`), the
  fixed-URL `AWS_IAM` Function URL invoker, and the cleanup script.
- `signin-worker.test.ts`: tester gate before Lambda, one signed call per
  sign-in, invalid input and foreign origin rejected without a call, and the
  zero-Lambda probe.

### Worker-side work included

Tester-IP gate; same-origin check; content-type and 6 KB body limit as in the
app; the real `learnerSignInRequestSchema` (zod from `@certpath/contracts`);
email normalization; two HMAC-SHA-256 rate-limit bucket digests (IP and email);
account lookup from a Worker secret; SigV4 signing and the `fetch` subrequest;
response size cap and JSON parsing; a decision by the verified flag; and, on
success, a 32-byte random session token with its SHA-256 digest and a
`Set-Cookie` header. Unknown emails verify against a decoy hash so every
request makes exactly one Lambda call.

### App work omitted (so the result is a lower bound)

| Omitted | Effect on representativeness |
|---|---|
| D1 reads and writes (rate-limit window delete and insert, credential join query, session insert, audit event) | Adds real CPU and subrequest-like time; the largest gap |
| Hono routing, middleware and CSRF/session cookie checks | Small extra CPU |
| Account lookup is a parsed JSON secret, not a database row | Understates query and binding cost |
| Email verification, status and staff-role checks | Small extra CPU |
| The full application bundle (only this Worker's imports load) | Cold-start CPU likely understated |
| Response is a tiny JSON body, not a page | Negligible |

## Gates before provisioning

| Check | Result |
|---|---|
| Cloudflare Workers Free plan (direct) | The subscription and billing endpoints returned 403 to this OAuth token, so the plan was verified another way: the API **rejected** a Worker upload that set `limits.cpu_ms`, with error 100328 "CPU limits are not supported for the Free plan". The upload failed, so nothing was created. The account has one other Worker script of the Free plan's 100-script allowance |
| Workers Free capacity | The account GraphQL analytics showed 53 Worker requests in the previous 24 hours against 100,000 per day; this test needs about 20 |
| Published Free limits | 10 ms CPU per HTTP request, 100,000 requests/day, 50 subrequests per request (Cloudflare limits page); each sign-in uses one subrequest |
| AWS plan | `FREE` / `ACTIVE`, expires 2027-05-11; $120.00 credits |
| Free Tier usage API | Returned no rows; usage treated as unknown, so the ceiling below is checked against credits |
| Lambda capacity, `eu-north-1` | 10 concurrent executions, 10 unreserved; this test uses 1 at a time |
| Leftover resources | None before the run |
| Cleanup manifest and recovery command | Validated before provisioning: the manifest was written and `cleanup.ts` ran against it with nothing deployed and exited 0 with `complete: true` |

Maximum usage for the test:

- **Lambda:** at most 10 invocations, 1,769 MB, 3 s timeout: 53 GB-s ceiling
  (about 4 expected), against $120 credits and the 400,000 GB-s free allowance.
- **Logs:** one-day retention group, about 10 REPORT lines plus start/end lines,
  under 50 KB.
- **Transfer:** under 20 KB of request and response bodies.
- **Telemetry:** `wrangler tail` is free; no Logpush or paid analytics.
- **Workers Free:** about 20 requests (gate, probes, validation, ten sign-ins).

## Run

Short-lived (900 s) STS credentials from a role limited to
`lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` on the one function with
`lambda:FunctionUrlAuthType=AWS_IAM` were stored as temporary Worker secrets.
Secrets, signed headers, passwords and hashes are not recorded here.

| Check | Result |
|---|---|
| Unsigned Function URL request | HTTP 403 |
| Unauthorized Worker request (decoy tester IP) | HTTP 403; zero Lambda `REPORT` lines afterwards |
| Zero-Lambda `/probe` x3 | HTTP 200 each; tail reported `cpuTime` for each; zero Lambda `REPORT` lines afterwards |
| Invalid input under the tester gate | HTTP 400, no Lambda call |
| Ten sign-in requests | One at a time, one Lambda call each, no retries; every status matched expectation |

### Telemetry

`wrangler tail --format json` events give `cpuTime` and `wallTime` in whole
milliseconds (1 ms resolution; 0 means under 1 ms). Requests were tied to events
by an `x-bench-seq` request header read by the parser, which prints only path,
sequence, outcome, status and times.

Zero-Lambda probe (same code, no network call):

| Probe | CPU | Wall |
|---|---|---|
| 1 | 4 ms | 5 ms |
| 2 | **10 ms** | 11 ms |
| 3 | 1 ms | 1 ms |

The probe confirmed the metric is visible per request. Probe 2 reached the full
10 ms with no Lambda call and no failure; the cause is not known (not
reproduced, no isolate state visible), so treat spikes as possible.

### Per-request results

Sequence 0 is the invalid-input request. Cold and warm labels for Lambda come
from the handler's own cold-start flag. The Worker isolate state is **not
observable** here; the probes ran first, so the sign-in requests probably ran on
a warm isolate, but that is unconfirmed.

| # | Case | Status | Worker CPU | Worker wall | End to end | Worker-to-Lambda | Lambda handler | Lambda |
|---|---|---|---|---|---|---|---|---|
| 0 | invalid input | 400 | 4 ms | 6 ms | not recorded | none | none | none |
| 1 | correct | 200 | **5 ms** | 769 ms | 1,025 ms | 765 ms | 254.9 ms | cold |
| 2 | correct | 200 | **5 ms** | 417 ms | 604 ms | 414 ms | 200.0 ms | warm |
| 3 | wrong password | 401 | 3 ms | 385 ms | 501 ms | 383 ms | 213.4 ms | warm |
| 4 | correct | 200 | 2 ms | 350 ms | 498 ms | 348 ms | 201.5 ms | warm |
| 5 | wrong password | 401 | 2 ms | 239 ms | 376 ms | 238 ms | 186.8 ms | warm |
| 6 | unknown email | 401 | 1 ms | 263 ms | 370 ms | 262 ms | 205.6 ms | warm |
| 7 | correct | 200 | 2 ms | 343 ms | 471 ms | 340 ms | 206.0 ms | warm |
| 8 | wrong password | 401 | 1 ms | 373 ms | 473 ms | 372 ms | 214.3 ms | warm |
| 9 | correct | 200 | 1 ms | 243 ms | 362 ms | 241 ms | 182.1 ms | warm |
| 10 | correct | 200 | 3 ms | 256 ms | 360 ms | 254 ms | 203.1 ms | warm |

Worker wall time includes waiting on Lambda and is not CPU.

### Summary against the Free limit

| Metric | Result |
|---|---|
| Worker CPU, ten sign-ins | 1–5 ms; median 2 ms; mean 2.5 ms |
| **Maximum observed CPU, sign-ins** | **5 ms** (first two requests) |
| Maximum observed CPU, any request in the test | **10 ms** (zero-Lambda probe 2) |
| Published Free limit | 10 ms per request |
| Headroom at the sign-in maximum | 5 ms (50%); at the probe maximum, 0 ms |
| End to end from the tester | 360–1,025 ms; warm 360–604 ms (cold Lambda 1,025 ms) |
| Worker-to-Lambda round trip | 238–765 ms; warm 238–414 ms |
| Lambda platform duration (REPORT) | 184.2–262.2 ms; init 147.2 ms on the one cold start |
| Lambda peak memory | **155 MB** of 1,769 MB |
| Failures | None; no request errored, was throttled or retried |

## What this does and does not show

Ten sign-in-shaped requests used at most 5 ms CPU, half the Free limit, and waiting on the
Lambda call dominated wall time rather than CPU. That is
consistent with a single signed verification being affordable on Workers Free.

It does not settle the question:

- Ten samples at 1 ms resolution cannot give a tail. One zero-Lambda probe hit
  10 ms for unknown reasons, so a spike to the limit cannot be ruled out.
- D1 work, routing and the full bundle are omitted and will add CPU; a 5 ms
  baseline leaves limited room for them.
- The first requests on the sign-in route were the most expensive (4–5 ms),
  suggesting warm-up cost, but the isolate state was not observable.
- A cold Worker isolate was not captured.

**Recommendation:** the headroom supports moving to an isolated learner sign-in
test on Workers Free, which should include real D1 reads and writes against a
synthetic database and a larger sample (for example 50–100 requests spread over
time, including idle gaps), and should record the maximum CPU, not only the
median. Do not commit to Workers Free for production sign-in on this evidence
alone; a result at or near 10 ms (error 1102) in that test should stop the plan.

## Cleanup and billing

Removed and verified: the Worker (workers.dev URL returns 404) and its secrets
(`secret list`: not found), the Function URL, the function, the execution role
and policy, the invoker role and policy, and the log group. The AWS cleanup
script exited 0, zero resources matching `certpath-scrypt` remain, and STS
credentials expire within 900 s.

| | Before | After |
|---|---|---|
| Plan | FREE / ACTIVE | FREE / ACTIVE |
| Credits remaining | $120.00 | $120.00 (billing data not yet updated) |
| Billed Lambda duration | none | 2,246 ms, about 4.0 GB-s |

AWS billing and Free Tier usage can lag by hours, so treat the figures as
**pending** and recheck Billing and Cost Explorer later. No payment or upgrade
was requested by AWS or Cloudflare.
