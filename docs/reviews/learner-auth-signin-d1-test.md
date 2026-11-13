# Isolated learner sign-in test (real route, middleware and D1)

**Status:** Completed once on 13 November 2026 within the $0 out-of-pocket cap.
All temporary Cloudflare and AWS resources were removed. Synthetic accounts
only; production Workers, D1, learner sign-in, email, PR #15 (draft) and staff
MFA were not touched.

**Result: blocker for relying on Workers Free for the pilot.** Every functional
path behaved as expected with no failures, but 3 of 12 measured sign-ins used
19â€“20 ms of Worker CPU, about twice the published 10 ms Free limit.

## Question

Can the real learner sign-in flow, with D1 and one signed Lambda scrypt
verification per eligible attempt, run on Certpath's Workers Free plan inside
the 10 ms CPU per request limit?

## What was built

- `apps/api/src/local-learner-auth.ts` and `index.ts`: one optional,
  default-preserving seam (`LearnerPasswordHooks`: `verifyPassword`,
  `dummyHash`). Without it the route behaves exactly as before; the existing API
  tests still pass.
- `apps/api/benchmark/learner-signin-d1/worker.ts`: isolated Worker
  `certpath-signin-d1-proof`. It runs the **real** Hono app (`createApi`) with
  the real sign-in route, session CSRF/logout routes, practice dashboard route
  and D1 queries. Its hooks replace the in-Worker scrypt call with the PR #23
  SigV4 caller (one signed Lambda `/verify` call per eligible attempt) and use a
  precomputed decoy hash so unknown emails also make exactly one call and no
  scrypt runs in the Worker.
- `client.ts`: tester-side setup (synthetic learners, hashes, secrets written
  outside the repository), gate, probe, functional and measured runs.
- `wrangler.learner-signin-d1.jsonc`: its own D1 binding (placeholder id; the
  run script creates a new temporary database and writes a throwaway config).
- `apps/api/test/learner-signin-d1-worker.test.ts`: runs the Worker against
  the real migrations in the Workers test pool: unauthorized tester rejected
  before D1 or Lambda, one call per eligible attempt, none for foreign origin,
  invalid body or rate-limited requests, session persistence, dashboard,
  logout invalidation, and a SigV4 `eu-north-1` / session-token check on the
  outgoing request.

### Deviations from the production Worker

| Deviation | Reason and effect |
|---|---|
| Tester-IP gate runs first, with a five-route allowlist | Keeps the deployment tester-only; the gate rejects before routing, D1 or Lambda. Adds a negligible comparison |
| The sign-in route sees `http://localhost` as its origin | The real route only runs for a local origin while the dashboard route requires an https origin. The adapter maps the Worker origin to localhost for sign-in only; foreign origins stay unmapped and fail the route's own origin check. The session cookie is therefore issued without `Secure`; it was only sent over https |
| `LOCAL_LEARNER_AUTH_ENABLED` and `LOCAL_TEST_MAIL_ENABLED` set for the sign-in request | Satisfies the route's configuration guard only. No mail provider, binding or mail route exists; email stays off |
| Lambda verifier and decoy hash injected through the hooks | The purpose of the test; the Worker never runs scrypt |
| Per-request Lambda counters held in module state | Valid because the driver sends requests one at a time |

Not exercised: registration, password reset, email verification, staff routes,
content APIs, and a real certification/content catalogue (the dashboard was
served from an empty content set, so it understates dashboard CPU).

## Gates before provisioning

| Check | Result |
|---|---|
| Workers Free plan (direct) | Billing endpoints returned 403 to the OAuth token. A Worker upload setting `limits.cpu_ms` was **rejected** with error 100328 "CPU limits are not supported for the Free plan", so the account is on Free and nothing was created. The Wrangler default account differs from Certpath, so every command pins `CLOUDFLARE_ACCOUNT_ID` to Certpath |
| Workers capacity | GraphQL showed 90 requests in the preceding 24 hours versus 100,000/day; bundle 1,201 KiB (201 KiB gzip), below the Free 3 MB compressed limit |
| D1 capacity | One existing database (704 KB) of the 10 allowed; Free limits 5 M rows read/day, 100,000 rows written/day, 5 GB total. This test created one temporary database |
| AWS plan | `FREE` / `ACTIVE`, expires 2027-05-11; $120.00 remaining credits. Lambda concurrency 10; no `certpath-scrypt` leftovers |
| Request budget | Fixed at **50 Worker requests** and **20 Lambda calls**; the client aborts above the Worker budget. The run used 36 and 18 |
| Maximum usage | Lambda: 20 Ã— 3 s Ã— 1.769 GB = 106 GB-s worst case (about $0.002 at the public rate), against credits. Expected about 4 s billed in total. D1: under 5,000 rows read and 1,000 rows written. Logs: one group with 1-day retention, under 100 KB. Transfer under 200 KB. Telemetry: `wrangler tail`, no charge |
| Cleanup manifest | The AWS cleanup dry run passed; the D1 and Worker recovery commands were run against a nonexistent name and returned the expected not-found results before provisioning |

An earlier attempt stopped at the tester-gate step on a transient TLS error
before any benchmark traffic; a second attempt completed the functional paths
but its post-step script failed and the measured rounds were not run. Both
tore down cleanly. The recorded run is the third attempt; the gate and probe
calls (zero Lambda) may retry a failed connection, and no Lambda request is
retried.

## Controls verified

| Control | Result |
|---|---|
| Unsigned Function URL request | HTTP 403 |
| Unauthorized tester (sign-in and dashboard) | HTTP 403 for both; zero Lambda REPORT lines; D1 afterwards held 0 rate-limit rows, 0 sessions and the 5 seeded users |
| Zero-Lambda probe (`GET /api/health` Ã— 3) | Request-level CPU visible in `wrangler tail` for all three requests: 2, 3 and 0 ms. No Lambda REPORT lines |
| Credentials | Invoke-only role scoped to the one Function URL, 1,800 s session with a matching session policy, stored as Worker secrets and deleted with the Worker |

## Functional paths

All 16 functional requests returned the expected status and Lambda call count.

| Path | Status | Lambda calls |
|---|---|---|
| Foreign origin | 403 | 0 |
| Invalid body | 400 | 0 |
| Unknown email (decoy hash) | 401 | 1 |
| Wrong password | 401 | 1 |
| Valid sign-in | 200 | 1 |
| Session persistence (CSRF endpoint, dashboard twice) | 200 | 0 |
| Dashboard without a cookie | 401 | 0 |
| Logout with CSRF token | 204 | 0 |
| CSRF endpoint and dashboard after logout | 401 | 0 |
| Three more wrong passwords for one learner (attempts 3â€“5) | 401 | 1 each |
| Sixth attempt for that learner in the window | 429 | 0 |

Lambda REPORT lines totalled 18, equal to the expected 6 functional plus 12
measured calls.

## Measured rounds

Three rounds of one sign-in for each of four learners (one wrong password in
round 2), with idle gaps of 45 s and 180 s between rounds, and one dashboard
request per round. Worker CPU is the whole request from `wrangler tail`
(1 ms resolution). Latency is the client's end-to-end time.

| Request | CPU (ms) | End-to-end (ms) | Lambda elapsed (ms) | Worker-to-Lambda round trip (ms) |
|---|---|---|---|---|
| r1 learner b | 4 | 579 | 205 | 283 |
| r1 learner c | **20** | 729 | 203 | 404 |
| r1 learner d | 4 | 424 | 182 | 241 |
| r1 learner e | 4 | 577 | 209 | 373 |
| r2 learner b (after 45 s idle) | **19** | 717 | 194 | 393 |
| r2 learner c | 6 | 512 | 195 | 257 |
| r2 learner d | 4 | 557 | 200 | 368 |
| r2 learner e, wrong password | 3 | 404 | 180 | 237 |
| r3 learner b (after 180 s idle) | **19** | 987 | 205 | 430 |
| r3 learner c | 4 | 501 | 184 | 352 |
| r3 learner d | 8 | 682 | 209 | 371 |
| r3 learner e | 3 | 509 | 185 | 240 |
| Dashboard (3 requests) | 2, 5, 5 | 139, 162, 186 | n/a | n/a |

- Measured sign-ins: median 4 ms, maximum **20 ms**. 3 of 12 used 19â€“20 ms.
- Across all 31 non-probe requests that reached the tail, 5 used 10 ms or more:
  the three spikes above, the first unknown-email sign-in (10 ms) and the first
  invalid-body request (11 ms). Functional sign-ins were 5â€“10 ms.
- Headroom against the published 10 ms Free limit: **negative at the maximum**
  (20 ms is 200% of the limit; median headroom is 6 ms). Every request still
  completed with outcome `ok` and no failure, so the account was not stopped,
  but the telemetry does not explain why requests above 10 ms were not
  terminated, and the limit cannot be relied on to tolerate this.
- Two of the three spikes followed an idle gap and the third was the second
  request of the first round. `wrangler tail` does not report isolate cold
  starts, so none are labelled as cold. Lambda reported one cold start (init
  138 ms, first call only).
- Lambda: 18 invocations, durations 181â€“266 ms (median about 205 ms), billed
  182â€“404 ms (total 3,909 ms = about 6.9 GB-s), memory 1,769 MB, maximum memory
  used 153 MB. Lambda execution is separate from Worker CPU and from the
  round trip, which also includes signing, network and TLS.
- D1 (account analytics, includes the migrations and seed, 13 November): 132
  read queries, 146 write queries, **3,061 rows read, 622 rows written**.
  Per-request D1 usage was not recorded, so it is unmeasured. Storage was
  about 750 KB.

## Teardown and billing

| Item | Evidence |
|---|---|
| Worker | `wrangler delete`; workers.dev URL returned 404; deployments and secret list failed as expected |
| Worker secrets | Removed with the Worker |
| D1 database | `wrangler d1 delete`; the API list showed only the existing sandbox database |
| Lambda, Function URL, execution role, log group | Cleanup script exit code 0; zero `certpath-scrypt` functions, roles and log groups remained |
| Invoker role and policy | Deleted; `get-role` returned NoSuchEntity. The 1,800 s credentials expire on their own |
| Local scratch | Synthetic passwords, hashes, secrets and tail output deleted |
| Credits | $120.00 before and after; Free Tier usage and billing data lag, so billing is pending. Expected cost is under $0.01 and covered by credits |
| Workers requests (24 h) | 90 before, 127 after, across all three attempts |

## Does this support the private learner pilot on Workers Free?

**No, not on Workers Free alone.** Median CPU is comfortable (4 ms), and the
design works: one signed Lambda call per eligible attempt, no Worker scrypt, the
tester gate stops traffic before D1 or Lambda, and sessions, dashboard, logout
and rate limiting behave correctly. But a quarter of the sign-ins used about
twice the 10 ms limit, which the criteria treat as a blocker. One batch of 12
sign-ins cannot give a trustworthy tail estimate, cannot say whether the spikes
come from isolate start-up, idle gaps or load, and used an empty content set.

Options that stay inside the $0 cap (no change made here): find what produces
the 19â€“20 ms requests (for example by trimming imports loaded by the sign-in
path or reducing first-use work), then repeat with more samples; or defer the
pilot until a paid plan is approved by the owner. No payment or upgrade was
requested or made.
