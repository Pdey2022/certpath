# Cognito learner live proof: blocked at the $0 access gate

## Outcome

The live test did not start. No AWS resources or Cloudflare resources were
created or changed, no Worker was deployed, and no email was sent. Therefore
there is no deployment version, no test-generated bill, and no resource teardown
to perform. Learner sign-in was not enabled by this test. The status of any
separately existing live deployment was not checked or changed.

The $0 out-of-pocket gate remains unconfirmed for the requested test. The owner
previously reported an active AWS Free account plan and $100.00 in credits,
but I could not verify the current account state or determine whether the
isolated Cognito pool, Lambda signup trigger, and email delivery are available
on that plan. AWS documents that Free accounts can access only selected
services; paid-only services require an upgrade. No AWS CLI or credentials are
available in this environment, and no upgrade or payment was requested.

The D1 inventory was successfully queried with Wrangler explicitly configured
for the Certpath account. It contains one database,
`certpath-staff-mfa-sandbox`, with 704,512 bytes stored; this staff database is
not to be reused for the learner test. `wrangler d1 list` does not report daily
row totals, so those remain unavailable. No quota rejection was returned. No
AWS or Cloudflare resources were created or changed, no Worker was deployed,
and no email was sent.

## Check results

| Check | Result | Evidence |
|---|---|---|
| Start from `origin/main` at `3227902` or later | Passed | `origin/main` was `322790271d2f6a22fc62ffc405891d0bfa2e3769`; branch `feat/cognito-learner-live-proof` starts there |
| Read repository instructions and learner sandbox handoff | Passed | Both documents reviewed |
| AWS CLI and authorized AWS identity | Failed | `aws` CLI and local AWS credential/config files are absent; no AWS console session is available in this environment |
| Current AWS Free account plan and credit balance | Untested | Previously owner-reported as Free with $100.00 remaining, but not rechecked for this continuation |
| Cognito pool, pre-sign-up Lambda trigger, and built-in email availability on the AWS Free plan | Untested | AWS Free plan access is limited to selected services; account-specific availability was not accessible |
| Published AWS feature and pricing review | Passed | Cognito supports Essentials user pools and a pre-sign-up Lambda trigger. Cognito email verification and password-recovery messages are separately priced via SES; `COGNITO_DEFAULT` has a daily sending limit. Public documentation does not establish this account's Free-plan access or coverage. |
| Wrangler authentication and account targeting | Passed | `wrangler d1 list --json --config <temporary config with Certpath account_id>` succeeded; the temporary config change was removed |
| Cloudflare Workers Free plan and current usage | Passed (owner-reported) | Owner reports Workers Free, 0/100,000 requests and 0/200,000 observability events for November 11, 2026; CPU usage is unavailable |
| Cloudflare D1 inventory and storage | Passed | Explicitly targeted Wrangler inventory showed one database, `certpath-staff-mfa-sandbox`, with 704,512 bytes stored; it must not be reused for learner testing |
| Cloudflare D1 daily row totals | Untested | `wrangler d1 list` does not return daily rows read/written; those totals remain unavailable |
| D1 quota rejection | Passed | The inventory request succeeded; no D1 quota error was returned and no data query was run |
| Cloudflare Workers published Free limits review | Passed | Current docs list 100,000 requests/day and 10 ms CPU per invocation on Workers Free. CPU usage for the account is unavailable. |
| Cloudflare D1 published Free limits and over-limit behavior review | Passed | Current docs list 10 databases/account, 5 million rows read/day, 100,000 rows written/day, and 5 GB storage total. Exceeding daily row limits makes D1 queries fail; it does not switch the account to paid usage. |
| Separate learner-only Cognito pool and signup allowlist | Untested | No pool or trigger was created or changed |
| Exact callback, tester network restriction, and disabled-preflight check | Untested | No Worker was deployed; no allowed/unlisted network probe was sent |
| Registration, pre-verification denial, verification email, sign-in, and password reset | Untested | No live provider interaction or email delivery occurred |
| Standard grant, second-exam isolation, and live dashboard sign-out | Untested | No live learner session or grant was created |
| Disable learner sign-in after the test | Untested | No live Worker was changed; the state of any existing deployment is unknown |
| Account billing evidence and reporting delay | Untested | Current AWS plan, credit, service usage, and billing data timestamp were not accessible |
| AWS Cost Explorer published reporting delay | Passed | AWS says current-month data is available in about 24 hours and refreshes at least every 24 hours, but upstream data may take longer |
| Charges from this test attempt | Passed | No provisioning, deployment, or email operations were performed; account-wide charges remain unverified |

## Public pricing sources reviewed

- [AWS Free Tier](https://aws.amazon.com/free/) — new-account credits and Free/Paid plan distinctions.
- [AWS Free Tier FAQs](https://aws.amazon.com/free/free-tier-faqs/) — Free-plan service restrictions, expiry, and upgrade behavior.
- [Applying AWS credits](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/useconsolidatedbilling-credits.html) — credits apply to eligible services; the credit details show applicable products.
- [Amazon Cognito pricing](https://aws.amazon.com/cognito/pricing/) — Cognito MAU tiers and separate email pricing.
- [Cognito email settings](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html) — default email delivery and SES-backed email configuration.
- [Cognito pre-sign-up Lambda trigger](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-sign-up.html) — signup allowlist trigger support.
- [Amazon SES pricing](https://aws.amazon.com/ses/pricing/) — current Essentials outbound email rate and Free Tier credit notes.
- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/) — request and duration allowances.
- [AWS Cost Explorer data](https://docs.aws.amazon.com/cost-management/latest/userguide/ce-what-is.html) — console/API access and published refresh delay; the console UI is free, while Cost Explorer API calls are $0.01 each.
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) — Workers Free request and CPU limits.
- [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) — D1 Free limits, database count, and overage prices.

The Cloudflare account-targeted D1 inventory is now verified. Its daily row
totals remain unavailable. The AWS Free plan and credit balance were only
reported previously by the owner; account access is unavailable here, so the
current plan and the account-specific availability of Cognito, Lambda, and SES
remain unverified.

## Blockers and required access

1. In AWS CloudShell, run the read-only commands below to verify the current
   Free plan state and Free Tier usage. Also check AWS Free Tier's service
   availability list for Amazon Cognito, AWS Lambda, and Amazon SES. If any
   operation is marked paid-only, requests an upgrade/payment, or is not
   available on the Free plan, stop without activating it.

   ```sh
   aws freetier get-account-plan-state --region us-east-1 \
     --query '{Plan:accountPlanType,Status:accountPlanStatus,Expires:accountPlanExpirationDate,Credits:accountPlanRemainingCredits}' \
     --output json --no-cli-pager
   aws freetier get-free-tier-usage --region us-east-1 \
     --output json --no-cli-pager
   ```

   In the AWS Billing console, review current-month Cognito, SES, and Lambda
   usage/charges and note the data timestamp. Use the console rather than the
   Cost Explorer API, which costs $0.01 per request. Confirm that the
   `COGNITO_DEFAULT` verification/reset email path and pre-sign-up Lambda
   trigger are available without upgrading.
2. D1 inventory succeeds when explicitly configured for the Certpath account.
   Daily row totals are still unknown; check Cloudflare D1 usage/analytics if
   needed. Stop and report the limit if a D1 operation returns a quota error.
   Keep the existing staff database separate; the learner test needs its own.
3. Only after AWS plan/service availability and the $0 cap are confirmed,
   verify a usable learner inbox and proceed with the isolated learner pool,
   Worker, and D1 database.

## Deployment, billing, and teardown

- Deployment version: **not applicable; nothing was deployed**.
- Billing evidence: **not verified for this continuation**. The previously
  reported AWS Free plan and credit balance were not rechecked; test-service
  availability, usage, month-to-date costs, and reporting timestamp remain
  unverified.
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
