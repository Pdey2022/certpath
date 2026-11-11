# Cognito learner live proof: blocked at the $0 access gate

## Outcome

The live test did not start. No AWS resources or Cloudflare resources were
created or changed, no Worker was deployed, and no email was sent. Therefore
there is no deployment version, no test-generated bill, and no resource teardown
to perform. Learner sign-in was not enabled by this test. The status of any
separately existing live deployment was not checked or changed.

The AWS Billing settings page and the owner's read-only CloudShell output
received November 11, 2026 confirm plan `FREE`, status `ACTIVE`, $100 USD
remaining, expiring May 11, 2027 at 19:42:29 UTC. The Billing page states all
usage is covered by AWS Free Tier credits. Read-only calls to
`cognito-idp list-user-pools` and `lambda list-functions` also succeeded in
`eu-north-1`; the first returned one pool in the account and the second
returned zero functions. These results confirm list access only. They do not
verify permission to create/configure a learner pool or signup-trigger
function, nor the learner pool's `COGNITO_DEFAULT` email and pre-sign-up
trigger settings. Do not reuse the existing pool, which is reserved for the
staff sandbox. No create or update action was submitted.

The authenticated regional console opened Cognito's user-pool setup wizard
and the Lambda functions page. The Cognito wizard exposed email sign-in and
self-registration controls, but not the email-delivery provider or trigger
selector. On November 11, 2026, the current browser attempt to reopen the
Cognito setup page redirected to AWS sign-in, so no additional settings could
be inspected. The Free Tier page showed no service usage data. Billing's
month-to-date and month-end forecast fields were blank, and Cost Explorer
showed no cost or usage data for the selected range. Thus current
service-level charges, usage, and reporting timestamps remain unverified. No
create/update action or upgrade was submitted.

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
| AWS console access to Cognito and Lambda | Partial | An earlier authenticated session opened the setup wizard and Lambda page; the latest attempt redirected to AWS sign-in, and no create/update action was submitted |
| AWS CLI and CloudShell command access | Passed (owner-provided read-only calls) | Signed-in CloudShell returned the plan, Cognito pool-list, and Lambda function-list results; local AWS CLI remains unavailable |
| Current AWS Free account plan and credit balance | Passed | Billing settings and owner-provided CloudShell output on November 11, 2026 report `FREE`, `ACTIVE`, $100 USD remaining, expiring May 11, 2027 at 19:42:29 UTC |
| AWS Billing and usage details | Partial | Billing states all usage is covered by Free Tier credits, but month-to-date and forecast fields are blank; Cost Explorer has no cost or usage data for its selected range and Free Tier usage data is unavailable |
| Public Free-plan service list | Passed (owner-reported) | Owner reports the official list includes Cognito, Lambda, and SES; this does not verify current account state or permissions |
| Cognito pool creation on this account | Passed (owner-reported) | Essentials pool creation previously worked in the Stockholm staff sandbox; no learner pool was created |
| Account access to list Cognito pools and Lambda functions | Passed (read-only) | `list-user-pools --max-results 1` succeeded and returned one pool; `list-functions --max-items 1` succeeded and returned zero functions |
| Learner `COGNITO_DEFAULT` email and pre-sign-up Lambda trigger settings | Untested | The Cognito wizard exposed email sign-in and self-registration controls, but not the email-delivery provider or trigger selector; no pool or trigger was created |
| Lambda function configuration access | Partial | `list-functions` succeeded with zero functions and the console showed a create-function entry point. Create/configure permissions and the required trigger settings were not verified; no function was created |
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
| Account billing evidence and reporting delay | Partial | Billing confirms the active Free plan and remaining credits and says usage is covered; current charges, service usage, and billing data timestamp remain unavailable |
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
inventory nor the dashboard snapshot exposed daily row totals. The owner provided fresh read-only AWS CloudShell results for the active Free
plan and list access to Cognito pools and Lambda functions. The Billing page
independently shows the active Free plan and remaining credit, and says usage
is covered by credits; it does not show service-level current charges or usage.
The learner-specific Cognito email provider and pre-sign-up trigger settings,
and Lambda create/configure permissions, remain unverified.

## Blockers and required access

1. In a signed-in AWS console session, continue read-only verification of the
   learner-specific settings. The previously opened Cognito wizard showed
   email sign-in and self-registration controls; the `COGNITO_DEFAULT` email
   provider and pre-sign-up Lambda trigger selector are still unverified. The
   owner confirmed that read-only list calls work and returned one existing
   pool and zero visible Lambda functions; do not reuse the staff pool. Do not
   submit any create/update form. Do not share resource names.

   ```sh
   aws freetier get-free-tier-usage --region us-east-1 \
     --output json --no-cli-pager
   ```

   In the Cognito console for `eu-north-1`, inspect the user-pool setup screens
   for the default email provider, verification/reset messages, and pre-sign-up
   Lambda trigger selector; do not submit a create/update action. Open the
   Lambda create-function workflow and confirm the required settings are
   available without submitting it. Stop if AWS offers an upgrade/payment or
   marks a required operation paid-only.

   In AWS Billing, review current-month Cognito, SES, and Lambda usage/charges
   and note the data timestamp. Billing says usage is covered by credits, but
   its current month-to-date and forecast fields are blank; the account-specific
   Free Tier page also has no service usage data. This does not confirm the
   expected test cost or current service charges. Use the console rather than
   the Cost Explorer API, which costs $0.01 per request. Confirm that the
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
- Billing evidence: **partial**. The Billing page and owner-provided CloudShell
  output received November 11, 2026 show the active Free plan, $100 remaining
  credit, and the message that usage is covered by credits. Learner-specific
  service settings, Free Tier usage, month-to-date costs, and billing reporting
  timestamp remain unverified; Cost Explorer showed no data for the selected
  range.
- Teardown: **not applicable; no resources were created**. If a later approved
  run provisions resources, first set learner sign-in disabled and verify
  preflight reports disabled; then remove the learner-only Worker, D1 database,
  Cognito pool, signup-trigger Lambda and its dedicated IAM role, test grant,
  and sessions. Confirm cleanup and final usage in both billing consoles after
  their reporting windows.
- The staff MFA sandbox and PR #15 were not modified.

## Local repository verification

`npm run verify` passed on November 11, 2026: workspace typechecks, API health
test 1/1, API Worker/D1 tests 83/83 across 11 files, web tests 62/62, and
client and server production builds. `git diff --check` passed.
