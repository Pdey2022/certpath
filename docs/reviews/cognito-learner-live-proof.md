# Cognito learner live proof: blocked at the $0 access gate

## Outcome

The live test did not start. No AWS resources or Cloudflare resources were
created or changed, no Worker was deployed, and no email was sent. Therefore
there is no deployment version, no test-generated bill, and no resource teardown
to perform. Learner sign-in was not enabled by this test. The status of any
separately existing live deployment was not checked or changed.

The $0 out-of-pocket gate remains unconfirmed. The owner reported an active
AWS Free Tier credit balance of $100.00 ($100.00 remaining, $0.00 used),
expiring November 11, 2027 at 19:42 UTC. The AWS account-plan status, credit
eligibility for the test services, current Cognito/SES/Lambda usage, and
month-to-date costs are still unverified. The owner reported Cloudflare
Workers Free with 0 of 100,000 requests and 0 of 200,000 observability events
for November 11, 2026; CPU usage was unavailable. A D1 inventory snapshot
reported one of ten databases and 704,512 bytes stored in the existing
`certpath-staff-mfa-sandbox` database. That database is not to be reused for
the learner test. D1 daily row usage is unavailable. The owner reported that
the Wrangler inventory succeeded at 22:02 UTC, but a local retry at 22:04 UTC
still failed with authentication error `10000`. No plan upgrade was attempted.

## Check results

| Check | Result | Evidence |
|---|---|---|
| Start from `origin/main` at `3227902` or later | Passed | `origin/main` was `322790271d2f6a22fc62ffc405891d0bfa2e3769`; branch `feat/cognito-learner-live-proof` starts there |
| Read repository instructions and learner sandbox handoff | Passed | Both documents reviewed |
| AWS CLI and authorized AWS identity | Failed | `aws` CLI is absent locally; owner supplied a read-only console summary instead |
| AWS credit balance | Passed (owner-reported) | Owner reported an active $100.00 credit, $100.00 remaining, $0.00 used, expiring November 11, 2027 at 19:42 UTC |
| AWS account-plan status and credit eligibility for the test services | Untested | Account plan and the credit's applicable products for Cognito, SES, and Lambda were not provided |
| Account-specific Cognito/SES email, Cognito MAU, signup-trigger usage, and month-to-date costs | Untested | Owner reports these values and the billing data timestamp are unavailable |
| Published AWS pricing review | Passed | Cognito Essentials has a 10,000 direct-user MAU free tier; AWS lists registration, password-recovery, and verification email as separately priced through SES. SES Essentials is $0.16 per 1,000 outbound emails. Lambda's published free tier includes 1 million requests and 400,000 GB-seconds monthly. Credit eligibility and account usage still require verification. |
| Wrangler authentication to the Certpath Cloudflare account | Partial | `wrangler whoami` works, but local `wrangler d1 list` still returns authentication error `10000`; the owner reported a successful inventory command at 22:02 UTC |
| Cloudflare Workers Free plan and current usage | Passed (owner-reported) | Owner reports Workers Free, 0/100,000 requests and 0/200,000 observability events for November 11, 2026; CPU usage is unavailable |
| Cloudflare D1 inventory and storage | Partial (owner-reported) | At 22:02 UTC November 11, 2026, owner reports 1/10 databases and 704,512 bytes in `certpath-staff-mfa-sandbox`; this staff database must not be reused |
| Cloudflare D1 daily row capacity | Untested | Current reads/writes are unavailable; published Free limits are 5 million rows read/day and 100,000 rows written/day |
| Cloudflare Workers published Free limits review | Passed | Current docs list 100,000 requests/day and 10 ms CPU per invocation on Workers Free. CPU usage for the account is unavailable. |
| Cloudflare D1 published Free limits and over-limit behavior review | Passed | Current docs list 10 databases/account, 5 million rows read/day, 100,000 rows written/day, and 5 GB storage total. Exceeding daily row limits makes D1 queries fail; it does not switch the account to paid usage. |
| Separate learner-only Cognito pool and signup allowlist | Untested | No pool or trigger was created or changed |
| Exact callback, tester network restriction, and disabled-preflight check | Untested | No Worker was deployed; no allowed/unlisted network probe was sent |
| Registration, pre-verification denial, verification email, sign-in, and password reset | Untested | No live provider interaction or email delivery occurred |
| Standard grant, second-exam isolation, and live dashboard sign-out | Untested | No live learner session or grant was created |
| Disable learner sign-in after the test | Untested | No live Worker was changed; the state of any existing deployment is unknown |
| Account billing evidence and reporting delay | Untested | Credit balance was reported, but service eligibility, month-to-date costs, Free Tier usage, and the billing data timestamp are unavailable |
| AWS Cost Explorer published reporting delay | Passed | AWS says current-month data is available in about 24 hours and refreshes at least every 24 hours, but upstream data may take longer |
| Charges from this test attempt | Passed | No provisioning, deployment, or email operations were performed; account-wide charges remain unverified |

## Public pricing sources reviewed

- [AWS Free Tier](https://aws.amazon.com/free/) — new-account credits and Free/Paid plan distinctions.
- [Applying AWS credits](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/useconsolidatedbilling-credits.html) — credits apply to eligible services; the credit details show applicable products.
- [Amazon Cognito pricing](https://aws.amazon.com/cognito/pricing/) — Cognito MAU tiers and separate email pricing.
- [Cognito email settings](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html) — default email delivery and SES-backed email configuration.
- [Amazon SES pricing](https://aws.amazon.com/ses/pricing/) — current Essentials outbound email rate and Free Tier credit notes.
- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/) — request and duration allowances.
- [AWS Cost Explorer data](https://docs.aws.amazon.com/cost-management/latest/userguide/ce-what-is.html) — console/API access and published refresh delay; the console UI is free, while Cost Explorer API calls are $0.01 each.
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) — Workers Free request and CPU limits.
- [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) — D1 Free limits, database count, and overage prices.

The public pricing pages do not establish this AWS account's active plan,
which services the reported credit covers, or current service usage. The
owner-reported Cloudflare plan, request count, database count, and storage
snapshot are useful evidence, but D1 daily row usage and Worker CPU usage remain
unavailable. The local Wrangler token also still cannot read the D1 inventory.

## Blockers and required access

1. Verify the AWS account plan and inspect the credit details page's
   **Applicable products** for Cognito, SES, and Lambda. Provide recent and
   month-to-date costs, Free Tier usage, and the billing data timestamp. The
   owner must explicitly confirm that the credit/Free Tier covers all test
   operations with no out-of-pocket charge.
2. Resolve local Wrangler D1 read access or use the Cloudflare dashboard to
   verify D1 daily row usage and Worker CPU usage. Keep the existing staff
   database separate; the learner test needs its own database.
3. Re-run the cost gate and verify a usable learner inbox before creating the
   isolated pool, Worker, or D1 database. If any email or service could incur
   an uncovered charge, stop and request owner approval rather than upgrade.

## Deployment, billing, and teardown

- Deployment version: **not applicable; nothing was deployed**.
- Billing evidence: **partial and owner-reported**. AWS credits are reported
  as active with $100.00 remaining, but applicable products, account plan,
  usage, month-to-date costs, and reporting timestamp are unverified.
- Teardown: **not applicable; no resources were created**. If a later approved
  run provisions resources, first set learner sign-in disabled and verify
  preflight reports disabled; then remove the learner-only Worker, D1 database,
  Cognito pool, signup-trigger Lambda and its dedicated IAM role, test grant,
  and sessions. Confirm cleanup and final usage in both billing consoles after
  their reporting windows.
- The staff MFA sandbox and PR #15 were not modified.

## Local repository verification

`npm run verify` passed on this branch: workspace typechecks, API health test
1/1, API Worker/D1 tests 83/83 across 11 files, web tests 62/62, and client and
server production builds. `git diff --check` passed.
