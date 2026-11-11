# Cognito learner live proof: blocked at the $0 access gate

## Outcome

The live test did not start. No AWS resources or Cloudflare resources were
created or changed, no Worker was deployed, and no email was sent. Therefore
there is no deployment version, no test-generated bill, and no resource teardown
to perform. Learner sign-in was not enabled by this test. The status of any
separately existing live deployment was not checked or changed.

The current AWS plan state is verified from the owner's read-only CloudShell
output: plan `FREE`, status `ACTIVE`, $100 USD remaining, expiring May 11, 2027
at 19:42:29 UTC. The owner reports that Cognito pool creation had previously
worked in the staff sandbox and that the official Free-plan service list
includes Cognito, Lambda, and SES. However, the learner pool's
`COGNITO_DEFAULT` email settings and the pre-sign-up Lambda trigger/function
settings have not been checked in the account. AWS documents that Free
accounts can access only selected services and paid-only services require an
upgrade. No AWS CLI or credentials are available in this environment, and no
upgrade, payment, resource change, or email operation was requested.

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
| Current AWS Free account plan and credit balance | Passed (owner-provided CloudShell result) | `FREE`, `ACTIVE`, $100 USD remaining, expires May 11, 2027 at 19:42:29 UTC |
| Public Free-plan service list | Passed (owner-reported) | Owner reports the official list includes Cognito, Lambda, and SES; this does not verify current account state or permissions |
| Cognito pool creation on this account | Passed (owner-reported) | Essentials pool creation previously worked in the Stockholm staff sandbox; no learner pool was created |
| Learner `COGNITO_DEFAULT` email and pre-sign-up Lambda trigger settings | Untested | Account-specific settings and Lambda function creation access have not been checked; no pool or trigger was created |
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

The Cloudflare account-targeted D1 inventory is verified, but neither Wrangler
inventory nor the dashboard snapshot exposed daily row totals. The current AWS
Free plan state is verified from the owner's CloudShell result. Access to the
learner-specific Cognito email and Lambda trigger settings remains unverified
because the console redirected to sign-in.

## Blockers and required access

1. In the signed-in AWS console, verify the learner-specific settings without
   submitting any create/update form. The list-user-pools and list-functions
   commands below only test read access; do not share their resource names.
   The plan-state command is retained to recheck status before provisioning.

   ```sh
   aws freetier get-account-plan-state --region us-east-1 \
     --query '{Plan:accountPlanType,Status:accountPlanStatus,Expires:accountPlanExpirationDate,Credits:accountPlanRemainingCredits}' \
     --output json --no-cli-pager
   aws freetier get-free-tier-usage --region us-east-1 \
     --output json --no-cli-pager
   aws cognito-idp list-user-pools --region eu-north-1 --max-results 1 \
     --query 'UserPools[].Name' --output text --no-cli-pager
   aws lambda list-functions --region eu-north-1 --max-items 1 \
     --query 'Functions[].FunctionName' --output text --no-cli-pager
   ```

   In the Cognito console for `eu-north-1`, inspect the user-pool setup screens
   for the default email provider, verification/reset messages, and pre-sign-up
   Lambda trigger selector; do not submit a create/update action. Open the
   Lambda create-function workflow and confirm the required settings are
   available without submitting it. Stop if AWS offers an upgrade/payment or
   marks a required operation paid-only.

   In AWS Billing, review current-month Cognito, SES, and Lambda usage/charges
   and note the data timestamp. Use the console rather than the Cost Explorer
   API, which costs $0.01 per request. Confirm that the `COGNITO_DEFAULT`
   verification/reset email path and pre-sign-up Lambda trigger are available
   without upgrading.
2. D1 inventory succeeds when explicitly configured for the Certpath account.
   Daily row totals are still unknown; check Cloudflare D1 usage/analytics if
   needed. Stop and report the limit if a D1 operation returns a quota error.
   Keep the existing staff database separate; the learner test needs its own.
3. Only after AWS plan/service availability and the $0 cap are confirmed,
   verify a usable learner inbox and proceed with the isolated learner pool,
   Worker, and D1 database.

## Deployment, billing, and teardown

- Deployment version: **not applicable; nothing was deployed**.
- Billing evidence: **partial**. Owner-provided CloudShell output confirms the
  current Free plan and remaining credits. Learner-specific service settings,
  usage, month-to-date costs, and reporting timestamp remain unverified.
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
