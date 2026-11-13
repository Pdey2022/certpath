# Learner authentication Workers Free proof

**Status:** Hash creation exceeded the Workers Free CPU budget; verification
and concurrency tests were stopped. The temporary Worker was removed.
**Branch:** `feat/learner-auth-workers-free-proof`
**Base:** `8710ad894e81b43ade0e868b1891c6e6f74b73bc` (`origin/main`)
**Checked:** 13 November 2026

## Result

The owner confirmed in the signed-in Cloudflare dashboard that **Certpath**
(`certpath.workers.dev`) is on Workers Free and has room for one temporary
Worker without payment or upgrade. The shared dashboard page available to this
session continued to return 403 for Workers plans and did not expose billing
or usage details.

The `wrangler whoami` command identified account **Certpath**
(`ef67137c4d1556f7f51f1cb3f1f420f3`). The token reported `account:read` and
`workers_scripts:write`; Wrangler also warned that the expected
`workers:write` scope is missing. The existing script-write permission was
sufficient to deploy the named Worker to the explicitly configured account.
No broader authorization was requested.

The Worker used the existing CertPath scrypt implementation and parameters:
`N=32768`, `r=8`, `p=1`, 16-byte salt, 32-byte output, `asyncTick=10`, and
`maxmem=64 MiB`. Its Wrangler config targeted only Certpath and had no D1,
email, or application sign-in binding. No Cognito sandbox was used.

The tester-IP restriction ran before routing or hashing. The allowlisted
network reached the no-hash readiness route; the owner confirmed an unlisted
network received 403 before any hash request. The address was held only in a
temporary Worker secret and is not included here.

## Measurements and outcome

| Check | Result |
|---|---|
| Certpath Workers Free and one-script capacity | Owner confirmed in signed-in Dashboard; no payment/upgrade prompt appeared |
| Wrangler account and deployment access | Passed; account `ef67137c4d1556f7f51f1cb3f1f420f3`, script-write scope |
| Final tested deployment version | `e37eaac0-c186-4b7d-8d34-43425604502b` |
| Unlisted-network check | Passed; 403 before hashing |
| Single hash request | HTTP 200; Cloudflare invocation status `success` |
| Hash CPU time | **263,522 µs (263.522 ms)**; 26.4× the Free 10 ms budget |
| Hash elapsed time | Cloudflare `wallTime`: **332,507 µs (332.507 ms)** |
| Worker response timer | Returned/displayed 0.0 ms; treated as unreliable and not used for elapsed time |
| Reported memory | Peak across the measured response group: **36,965,472 bytes** (about 35.25 MiB) |
| CPU or memory limit errors | None observed; invocation completed successfully |
| Password verification | Not run; hash request exceeded the Free CPU budget |
| Concurrency 2 and 4 | Not run; stopped after the single hash request exceeded budget |
| Account billing history | Not visible to this session; no paid-plan prompt or paid resource was used |
| Teardown | Worker absent, verified through the Workers Scripts API; its temporary secret was removed with it |

The Cloudflare metrics group for the final version contained one readiness
request and one hash request. The readiness request was the low measurement;
the hash request was the maximum: 263,522 µs CPU, 332,507 µs wall time, and
36,965,472 bytes memory. The group had two HTTP 200 requests and zero runtime
errors. Cloudflare exposes sampled/aggregated memory metrics, not a per-request
memory high-water guarantee; the observed value is not a proof of maximum
isolate usage.

The unchanged profile **does not fit Workers Free for hash creation** under the
observed workload: CPU time exceeded the 10,000 µs budget even though the
invocation returned HTTP 200. Per the stop condition, verification and
concurrency testing were not attempted. The hashing parameters were not
changed.

## Cost and security gate

Cloudflare's official pricing documentation says Free has a 10 ms CPU budget
per invocation and Paid starts at $5/month. The account owner confirmed Free
and capacity before deployment. The test Worker was deployed successfully
without a payment or upgrade prompt. Account billing history itself remained
inaccessible in the shared browser session.

## Required follow-up

1. Keep the current measurement as a Free-plan failure for hash creation.
   Do not test password verification or higher concurrency on Free.
2. Any further experiment requires architect/owner approval for a different
   hosting or hashing approach. Do not weaken or change the profile in this
   branch.
3. If an approved follow-up deploys another temporary Worker, continue to use
   the tester-network gate before hashing, capture CPU and wall time separately,
   and remove the Worker and its temporary secrets afterwards.

PR #15 remains draft. Staff MFA, email, application sign-in, Cognito, and
existing sandboxes were not touched.

## Local verification

- The temporary Worker compiled with
  `npx wrangler deploy --config apps/api/wrangler.free-benchmark.jsonc --dry-run`
  — passed; Wrangler reported no bindings.
- `npm run typecheck --workspace=@certpath/api` — passed.
- `npx vitest run --config vitest.config.ts test/workers-free-benchmark.test.ts`
  — passed (3 tests, including rejection before either hash or verify is
  called).
- `npm run verify` — passed on the final local changes: typecheck, 95 API tests
  across 13 files, 64 web tests, and workspace builds.
- `git diff --check` — passed.

## Official sources

- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) — Free plan defaults, request and CPU allowances, and Paid plan minimum (reviewed 13 November 2026).
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) — Account plan limits and per-invocation constraints.
