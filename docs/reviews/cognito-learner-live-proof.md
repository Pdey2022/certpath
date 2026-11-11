# Cognito learner live proof: blocked at the $0 access gate

## Outcome

The live test did not start. No AWS resources or Cloudflare resources were
created or changed, no Worker was deployed, and no email was sent. Therefore
there is no deployment version, no test-generated bill, and no resource teardown
to perform. Learner sign-in was not enabled by this test. The status of any
separately existing live deployment was not checked or changed.

The required $0 out-of-pocket gate could not be established: the AWS CLI is
not installed and no AWS identity could be queried. Wrangler is authenticated
to the Cloudflare account named `Certpath`, but its D1 database-list request
failed with Cloudflare authentication error `10000`; the current Workers plan
and D1 usage could not be verified. No plan upgrade or credential refresh was
attempted.

## Check results

| Check | Result | Evidence |
|---|---|---|
| Start from `origin/main` at `3227902` or later | Passed | `origin/main` was `322790271d2f6a22fc62ffc405891d0bfa2e3769`; branch `feat/cognito-learner-live-proof` starts there |
| Read repository instructions and learner sandbox handoff | Passed | Both documents reviewed |
| AWS CLI and authorized AWS identity | Failed | `aws` CLI is absent; no AWS profile could be queried |
| AWS Free plan status and available credit balance | Untested | Requires authenticated access to the account's billing/Free Tier view |
| Account-specific Cognito email, Cognito MAU, and signup-trigger cost coverage | Untested | Account eligibility, credit balance, remaining allowances, and usage are unknown |
| Published AWS pricing review | Passed | AWS publishes up to $200 in credits for eligible new accounts, with a six-month Free plan; Cognito verification/recovery email uses SES and is priced separately. Current SES Essentials pricing is $0.16 per 1,000 outbound emails. Lambda's published free tier includes 1 million requests and 400,000 GB-seconds monthly. These public allowances do not prove this account has available coverage. |
| Wrangler authentication to the Certpath Cloudflare account | Passed | `wrangler whoami` succeeded with account-read, Workers Scripts write, and D1 write scopes |
| Cloudflare Workers Free plan and current usage | Untested | Subscription and usage information were not available from the current authenticated session |
| Cloudflare D1 database inventory and remaining capacity | Failed | `wrangler d1 list` returned Authentication error `10000`; capacity remains unverified and no D1 database was created |
| Cloudflare Workers published Free limits review | Passed | Current docs list 100,000 requests/day and 10 ms CPU per invocation on Workers Free. Account plan and usage remain unknown. |
| Cloudflare D1 published Free limits review | Passed | Current docs list 10 databases/account, 5 million rows read/day, 100,000 rows written/day, and 5 GB storage total on Workers Free. Account usage against these limits is unknown. |
| Separate learner-only Cognito pool and signup allowlist | Untested | No pool or trigger was created or changed |
| Exact callback, tester network restriction, and disabled-preflight check | Untested | No Worker was deployed; no allowed/unlisted network probe was sent |
| Registration, pre-verification denial, verification email, sign-in, and password reset | Untested | No live provider interaction or email delivery occurred |
| Standard grant, second-exam isolation, and live dashboard sign-out | Untested | No live learner session or grant was created |
| Disable learner sign-in after the test | Untested | No live Worker was changed; the state of any existing deployment is unknown |
| Billing evidence and reporting delay | Untested | No account billing/credit report was accessible; no billing reporting delay was measured |
| Charges from this test attempt | Passed | No provisioning, deployment, or email operations were performed; account-wide charges remain unverified |

## Public pricing sources reviewed

- [AWS Free Tier](https://aws.amazon.com/free/) — new-account credits and Free/Paid plan distinctions.
- [Amazon Cognito pricing](https://aws.amazon.com/cognito/pricing/) — Cognito MAU tiers and separate email pricing.
- [Cognito email settings](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html) — default email delivery and SES-backed email configuration.
- [Amazon SES pricing](https://aws.amazon.com/ses/pricing/) — current Essentials outbound email rate and Free Tier credit notes.
- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/) — request and duration allowances.
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) — Workers Free request and CPU limits.
- [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) — D1 Free limits, database count, and overage prices.

The public pricing pages do not establish this AWS account's active plan,
remaining credits, eligible services, or current usage. Likewise, published
Cloudflare Free limits do not establish the Certpath account's subscription or
remaining daily/storage capacity.

## Blockers and required access

1. Make AWS CLI v2 available and authenticate an existing authorized AWS
   profile through the organization's approved sign-in method. Do not send
   access keys, tokens, passwords, or MFA codes in chat.
2. Provide read access to the AWS account's active plan, remaining credits,
   recent and month-to-date costs, Free Tier usage, Cognito/SES charges, and
   Lambda usage. The account owner must verify the billing evidence and
   explicitly confirm the $0 cap before any resource or email operation.
3. Refresh the existing Wrangler authorization through the approved Cloudflare
   sign-in flow with read access to D1 inventory/analytics and account
   subscription/billing details. Current `wrangler d1 list` fails with
   authentication error `10000`; do not broaden access beyond the required
   read and sandbox provisioning scopes.
4. Re-run the cost gate and verify a usable learner inbox before creating the
   isolated pool, Worker, or D1 database. If any email or service could incur
   an uncovered charge, stop and request owner approval rather than upgrade.

## Deployment, billing, and teardown

- Deployment version: **not applicable; nothing was deployed**.
- Billing evidence: **not available**. No account-specific invoices, credits,
  usage records, or reporting-delay measurements were obtained.
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
