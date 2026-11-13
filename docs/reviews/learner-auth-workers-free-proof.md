# Learner authentication Workers Free proof

**Status:** Blocked at account billing/plan preflight; no benchmark Worker was
deployed.
**Branch:** `feat/learner-auth-workers-free-proof`
**Base:** `8710ad894e81b43ade0e868b1891c6e6f74b73bc` (`origin/main`)
**Checked:** 13 November 2026

## Result

The Cloudflare account identity was confirmed, but the account's active Workers
plan, billing state, and available capacity could not be verified. Deployment
was intentionally stopped before creating or uploading any Worker. No hashing
was run on Cloudflare, no resource was created, and no teardown was necessary.

The `wrangler whoami` command identified account **Certpath**
(`ef67137c4d1556f7f51f1cb3f1f420f3`). The token reported `account:read` and
`workers_scripts:write`; Wrangler also warned that the expected
`workers:write` scope is missing. This verifies the account target, not its
plan or charge status.

The signed-in Dashboard's Workers plans and Billing pages did not expose plan,
subscription, billable-usage, or capacity details. The Workers plans page
reported a 403 request in the browser, and Billing remained without usage or
subscription data. Therefore this review does **not** claim that Workers Free
is active, that the account has room for another Worker, or that deployment
would stay within the $0 out-of-pocket cap.

## Measurements and outcome

| Check | Result |
|---|---|
| Wrangler account matches Certpath | Passed |
| Workers Free active; no Paid subscription or payment required | Unverified; preflight blocker |
| Free-plan capacity for one temporary Worker | Unverified |
| Hash creation / password verification on deployed Worker | Not run |
| One-request CPU and elapsed time | Unavailable; no deployment |
| Two-/four-request concurrent CPU and elapsed time | Not run; gated on one-request success |
| Invocation outcomes and CPU/memory-limit errors | Not available; no invocations |
| Cloudflare-reported CPU time | Unavailable |
| Deployment version | None |
| Charges attributable to this task | No resource was created; account billing data was inaccessible |
| Teardown | Not applicable; no deployment exists |

No values from the local Workerd benchmark are represented as deployed Worker
CPU time. The existing scrypt parameters were not changed.

## Cost and security gate

Cloudflare's official pricing documentation says the Free plan is available by
default and includes up to 100,000 requests per day, with a 10 ms CPU limit per
invocation. It also documents a Workers Paid plan with a minimum $5 monthly
charge. Those public terms do not establish which plan is active on this
account or whether a particular deployment action would prompt for billing.

Do not deploy until the account owner can verify in the Certpath Dashboard
that Workers Free is active, no Paid Workers subscription is active, and the
temporary Worker fits the account's available capacity without payment or
upgrade. Also restore/confirm the Wrangler deployment permission needed for
the operation. If the Dashboard continues to withhold plan or usage data,
request the specific read access from the account administrator rather than
trying deployment as a billing test.

Once the cost gate is satisfied, the benchmark must be an isolated temporary
Worker using the existing CertPath password-hashing module and unchanged
parameters. Reject every request except the tester's verified
`CF-Connecting-IP` before hashing; do not bind D1, enable email or application
sign-in, log credentials, or connect either Cognito sandbox. Use fixed
synthetic credentials created inside the harness. Run one request first and
proceed to concurrency 2 and 4 only if the previous level succeeds within
the Free CPU budget. Delete the temporary Worker immediately after the test.

## Required follow-up

1. In the Certpath Cloudflare account, inspect **Workers plans** and **Billing
   → Subscriptions / Billable usage**. Confirm Free plan status, no active
   Paid Workers subscription, capacity for one script, and no upgrade/payment
   prompt required for deployment.
2. Resolve the Wrangler `workers:write` permission warning, if required, using
   the account's approved authorization flow. Do not paste API tokens or
   credentials into chat or source control.
3. Resume deployment only after both the plan/capacity and permission gates
   pass. Capture deployed version, Cloudflare CPU-time metrics, elapsed times,
   invocation outcomes, and any resource-limit errors. If Cloudflare does not
   expose a requested metric, record it as unavailable.
4. Run `npm run verify`, delete the temporary Worker, and verify its removal
   before recording teardown as complete.

PR #15 remains draft. Staff MFA, email, application sign-in, Cognito, and
existing sandboxes were not touched.

## Local verification

- `npm run verify` — passed: typecheck, 92 API tests across 12 files, 64 web
  tests, and workspace builds.
- `git diff --check` — passed.

## Official sources

- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) — Free plan defaults, request and CPU allowances, and Paid plan minimum (reviewed 13 November 2026).
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) — Account plan limits and per-invocation constraints.
