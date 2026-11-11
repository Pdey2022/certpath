# Cognito staff MFA sandbox review

Status: **local proof harness and access controls implemented; live Cognito
sandbox untested**.
No AWS pool, remote Worker, or remote D1 database was created or changed.

## Summary

Added a sandbox-gated Cognito authorization-code flow to the existing Worker
API. It uses separate learner and staff client IDs, server-stored single-use
login transactions, browser-bound state, nonce and encrypted PKCE verifier,
and verifies the signed ID token before creating an opaque D1 session. Staff
sessions require a D1 Global Admin or Manager record and fresh signed
`acr`/`amr`/`auth_time` evidence. Learner identities require a verified email;
roles, Manager assignments, learner grants, and session revocation remain
application-owned in D1.

The route is disabled by default. Synthetic Worker/D1 tests exercise the
callback and application API boundary, but the provider endpoints and claims
are mocked. They do **not** establish Cognito Essentials claim availability or
prove any live sign-in, email, MFA, SSO, or provider-logout behavior.

Two local-only controls now guard the planned sandbox. The Worker requires an
exact client-IP allowlist and checks Cloudflare's `CF-Connecting-IP` before
handling any Cognito route or writing a login transaction. The new
PreSignUp Lambda handler allows public registration only for the configured
synthetic learner and administrative creation only for the two configured
staff addresses. It explicitly leaves both automatic confirmation and email
verification disabled. Neither control has been exercised against deployed
Cloudflare ingress or a real Cognito pool.

The owner approved a **$0 spending cap** and a **5-minute staff MFA freshness
window**. No AWS CLI or configured AWS credentials were available in this
environment. Current official pricing confirms that `COGNITO_DEFAULT` uses
AWS-managed SES resources but does not waive SES email charges. At the current
Essentials rate, the learner's verification and password-reset emails cost
about **$0.00032** before retries. AWS account credit eligibility and balance
are unknown; the current SES pricing page advertises up to $200 in credits
for eligible new AWS customers, but no account-specific credit check was possible. Wrangler authentication succeeds
through the workspace command, but it does not report the Cloudflare billing
plan; the plan and Worker CPU
headroom are unverified. The existing strict $0 cap is not confirmed;
provisioning and all potentially billable calls remain stopped.

## Architecture and safeguards

- The Worker requests `urn:cognito:loa:4` and `max_age=300` for staff. It
  verifies the RSA signature against the configured pool JWKS, exact issuer,
  expected client audience, ID-token use, expiry, transaction nonce, and
  verified email. Staff additionally require the level-4 ACR, `pwd`, `otp`,
  and `mfa` AMR values, plus an integer `auth_time` within the configured
  freshness window and no later than token issuance.
- The expected audience, state/nonce digests, browser binding, and encrypted
  PKCE verifier come from a short-lived, single-use D1 transaction, not
  callback input. The PKCE verifier is encrypted with AES-GCM using the
  `COGNITO_TRANSACTION_ENCRYPTION_KEY` secret binding.
- The Worker maps `(issuer, subject)` to the internal user. It does not derive
  a CertPath role or entitlement from Cognito claims. Staff role and Manager
  certification assignment checks remain D1-authoritative; learner exam access
  remains grant-scoped in D1.
- The browser receives only an opaque CertPath session cookie. CertPath logout
  revokes that D1 session. Provider logout/revocation is independent and was
  not exercised.
- `COGNITO_SANDBOX_ALLOWED_CLIENT_IPS` must be a comma-separated list of up
  to 16 exact IPv4 or IPv6 addresses. Empty, malformed, or missing values
  disable the Cognito route. The route compares the normalized address from
  `CF-Connecting-IP`; it does not trust `X-Forwarded-For` or CIDR ranges. Local
  tests inject the Cloudflare header and cannot prove deployed ingress values.
- `apps/api/src/cognito-signup-allowlist.ts` is the proposed Node.js Cognito
  PreSignUp trigger. Configure `COGNITO_SANDBOX_USER_POOL_ID`,
  `COGNITO_SANDBOX_LEARNER_EMAIL`, and
  `COGNITO_SANDBOX_ALLOWED_STAFF_EMAILS` only in Lambda environment settings.
  The public trigger accepts only the learner; the admin-create trigger
  accepts only the staff. Public learner signups are not auto-confirmed or
  auto-verified. Cognito ignores those response flags for `AdminCreateUser`.
  Staff accounts should be seeded with `AdminCreateUser` and invitation
  messages suppressed to avoid unneeded email sends. This trigger is not
  deployed or attached to a user pool.
- `COGNITO_SANDBOX_ENABLED` is `false` in the checked-in Wrangler config.
  Provider values are blank and secrets are not included in the repository.
  Do not enable this route for production or treat the local harness as a
  provider-selection decision.

## Files changed

- `apps/api/src/cognito-sandbox.ts` — sandbox-gated login, callback, token
  validation, session issuance, CSRF, CertPath logout, and pre-D1 IP gate.
- `apps/api/src/cognito-signup-allowlist.ts` — exact-user Cognito PreSignUp
  allowlist for the public learner and admin-seeded staff accounts.
- `apps/api/src/index.ts` — mounts the route and types its required settings.
- `db/migrations/0007_cognito_login_transactions.sql` — expiring,
  single-use login-transaction storage.
- `apps/api/test/cognito-sandbox.test.ts` — synthetic signed-token tests
  running through the Worker API and Miniflare D1, including denied-IP
  requests with no login-transaction write.
- `apps/api/test/cognito-signup-allowlist.test.ts` — local tests for the
  learner/staff allowlist and the non-auto-verification requirement.
- `apps/web/wrangler.jsonc` — disabled-by-default sandbox settings and the
  owner-approved five-minute, TOTP-only staff assurance policy and empty
  default for the required IP allowlist.
- `docs/reviews/cognito-staff-mfa-sandbox.md` — this review record.

No dependency, real account, question bank, personal data, or secret was added.
The identity architecture decision remains proposed; no provider was adopted.

## Verification

| Command or scenario | Result |
|---|---|
| `npm exec --workspace @certpath/api -- vitest run --config vitest.config.ts test/cognito-sandbox.test.ts test/cognito-signup-allowlist.test.ts` | Passed: 2 files, 15 tests. |
| `npm run verify` | Passed on Windows: workspace type checks; 11 API Worker/D1 test files (84 tests); 58 web tests; client and Cloudflare Worker SSR production builds. |
| `npm exec --workspace @certpath/web -- wrangler whoami` | Passed: Wrangler authenticated. The command does not report the account billing plan. |
| Authorization-code/PKCE, transaction binding and replay | Passed with synthetic signed tokens and isolated D1 sessions. A callback from another browser is rejected without consuming the valid transaction; the valid callback creates one session and replay is rejected. |
| Global Admin and Manager staff sessions | Passed with synthetic level-4 TOTP claims. D1 role checks and Manager assigned-versus-unassigned certification authorization were verified. |
| Wrong client, issuer, nonce, token use, expiry, signature, missing/low assurance, stale/future MFA time | Passed: no staff session was created for the rejected cases. A refreshed-token scenario with stale original `auth_time` was rejected. |
| Learner signup, verified-email gate, scoped dashboard, and second-exam denial | Passed locally with a synthetic verified identity and a D1 Standard grant for one exam. The granted exam appears in the dashboard; a different exam's attempt list is denied. |
| Enrollment-only staff denial and returning login | Passed locally: a synthetic level-1/password-only login creates no staff session; a later fresh level-4 TOTP login for the same D1 Global Admin creates one. |
| CertPath logout | Passed locally: D1 session revocation prevents subsequent protected API access. |
| Worker allowlist | Passed locally: an unlisted `CF-Connecting-IP` receives 403 before a D1 login-transaction write, even if `X-Forwarded-For` contains an allowed address. Existing login tests pass with an allowlisted address. Deployed Cloudflare header behavior remains untested. |
| Cognito signup allowlist | Passed locally: only the configured learner can use public sign-up; only the configured staff addresses can be admin-created; other addresses, pools, and triggers fail closed. Public sign-up is not auto-confirmed or email-verified; Cognito ignores these response flags for `AdminCreateUser`. Lambda deployment, trigger invocation, and real learner verification remain untested. |
| AWS account and Cloudflare plan for the $0 cap | **Unverified** — AWS CLI is unavailable. Wrangler authentication succeeded, but the command does not report billing plan. No billing checks or cloud resource calls were made. |
| Live target-pool claim availability; first sign-in/enrollment; returning staff; existing Cognito SSO | **Untested** — no target pool was provisioned under the $0 cap. |
| Actual learner email verification/password reset, and actual provider logout/revocation effects on a CertPath session | **Untested** — require the live provider sandbox. |
| Remote Cloudflare Worker and D1 integration | **Untested** — verification used the local Cloudflare Worker test harness and Miniflare D1. |
| Ubuntu GitHub Actions | Passed on control implementation commit `2d4d80923894a153383451bf6d801f64848f1b52`: [run 43085685495](https://github.com/Pdey2022/certpath/actions/runs/43085685495). |

## Live test setup and teardown checklist

Planning only; checked against official pricing and platform documentation on
**11 November 2026**. No live resources have been created.

### Cost decision

| Service | Minimum test usage and current pricing | $0-cap assessment |
|---|---|---|
| Cognito Essentials | Three direct MAUs are below the published 10,000 direct-MAU free allowance, assuming the pool stays on Essentials and account-wide usage remains within the allowance. | Expected $0 for these MAUs. |
| Cognito `COGNITO_DEFAULT` email through SES | The built-in option uses AWS-managed SES resources and avoids a customer SES identity/domain, but Cognito pricing separately bills registration, recovery, and verification email. Current SES Essentials pricing is $0.16 per 1,000 outbound emails; one learner verification plus one reset is approximately **$0.00032**, before retries. Staff invitations can be suppressed during admin creation. | **Not $0 usage.** Credits may offset the charge for eligible accounts, but this account's eligibility and remaining credit are unknown. |
| Cognito PreSignUp Lambda | Required to restrict public self-registration to the one synthetic learner; the local handler also restricts admin-created accounts to the two synthetic staff addresses. Lambda usage is request/duration metered. | The published Lambda free tier may cover the invocations, but account-wide usage/eligibility is unknown; CloudWatch logging may also be billable. |
| Cloudflare Worker and D1 | Workers Free includes 100,000 requests/day and 10 ms CPU per invocation. D1 Free includes 5 million rows read/day, 100,000 rows written/day, 5 GB storage, and 10 databases. | Can stay within published Free limits if the account is actually on Free and measured CPU/usage stay within limits. The callback's remote CPU use and actual account plan are unknown. Workers Paid has a $5/month minimum. |
| Worker tester restriction | Required exact-IP allowlist on `CF-Connecting-IP`, checked before Cognito route work or D1 access. This avoids an additional Access product for the planned single-location test if the client address is stable. | No separate service cost. Must verify the deployed Worker sees the expected edge-provided address and rejects unlisted clients before enabling Cognito. |

**Conclusion: not confirmed and remains no-go under the currently approved
strict $0 cap.** `COGNITO_DEFAULT` is the least-setup email path, not a
no-charge path: the minimum learner journey has positive SES metered usage.
Eligible credits might offset it, but the target account's balance is unknown.
The Cloudflare account's Free plan and remote Worker CPU use are also
unverified. Confirm the AWS credit/billing state and Cloudflare plan with the
owner before provisioning; otherwise request approval for a non-zero cap. Do
not treat a budget alert as a spending cap.

### Minimum resources and permissions

| Provider | Resources | Minimum permissions / notes |
|---|---|---|
| AWS | One isolated Cognito User Pool in one region on Essentials; required software-token/TOTP MFA; one Cognito-managed hosted-UI domain; separate staff and learner app clients configured for authorization code + PKCE, with no client secret; three synthetic users; one allowlist PreSignUp Lambda. Set email delivery to `COGNITO_DEFAULT`; create staff with invitation sending suppressed. | Use a temporary operator role for the required Cognito pool, domain, app-client, test-user, and Lambda create/read/update/delete operations; scope to the sandbox region and pool where AWS supports resource scoping. Do not use `AdministratorAccess`. Add billing/cost read access for preflight and teardown checks. The Lambda needs a minimal logging role and invoke permission for the target pool. The default email path needs no customer SES identity or sender role, but SES delivery is still billable. |
| Cloudflare | One separate test Worker deployed to its existing `workers.dev` subdomain; one isolated D1 database with repository migrations; Worker variables for issuer/domain/callback/client IDs, the 300,000 ms/TOTP policy, and exact tester IP allowlist; `CSRF_HMAC_SECRET` and `COGNITO_TRANSACTION_ENCRYPTION_KEY` stored as Worker secrets. No custom domain or DNS zone is required. | Use a short-lived API token scoped to the account with Workers Scripts edit and D1 edit. A separate Access policy is not required if the approved tester IP remains stable and the allowlist is verified. Do not use a global API token. Confirm plan and D1 quota before deploying. |

AWS Cognito MAU free allowance and SES email charges are separate. Avoid SMS
MFA, custom SES domains, custom domains, paid Cloudflare Workers, and logging
services not required by the test. The SES Essentials rate assumes ordinary
outbound messages; retries and any additional setup emails increase usage.

### Acceptance conditions

1. Attach the PreSignUp Lambda to the intended pool. Verify the learner can
   self-register and complete email verification, while a second email is
   rejected before Cognito sends mail. Verify only the two staff addresses
   can be created through the administrative trigger. The Lambda must not
   auto-confirm or auto-verify public learner signups; Cognito ignores those
   response flags for `AdminCreateUser`. Use suppressed invitation messages
   when admin-creating staff.
2. Verify the deployed Worker accepts only the configured tester IP from
   `CF-Connecting-IP`, denies another IP, and creates no D1 login transaction
   for that denied request. Confirm the Cloudflare account is on the Free plan
   and the Worker remains under its CPU/request quotas.
3. Seed exactly one synthetic Global Admin and one synthetic Manager in D1.
   The Manager is assigned to exactly one test certification. Neither role nor
   assignments come from Cognito claims.
4. For **each** staff account, a CertPath session is created only after the
   Worker verifies the signed ID token from the staff client, exact
   transaction nonce, issuer, expiry and `token_use=id`, plus
   `acr=urn:cognito:loa:4`, AMR containing `pwd`, `otp`, and `mfa`, and an
   `auth_time` within the approved 300-second window. Verify first enrollment
   does not itself pass; then test a completed authenticator-app challenge,
   returning staff, and an existing Cognito SSO session.
5. Confirm no staff session is created for a learner-client token, wrong
   nonce, enrollment-only/password-only result, missing or stale MFA evidence,
   or refreshed token with stale original `auth_time`. Confirm the resulting
   Global Admin and Manager permissions are still read from D1 and the Manager
   is denied for an unassigned exam.
6. Register one synthetic learner, complete the email-verification challenge,
   sign in with the learner client, and exercise password reset (count both
   emails in the SES usage review). Seed one time-bounded Standard grant for
   the exact test certification and exam version in D1. The dashboard should
   show that exam; its protected APIs should allow it and deny a second exam.
7. Use no real identities or question content. Keep raw tokens, passwords,
   authenticator secrets, email codes, and test addresses out of logs and
   committed files.

### Teardown

1. Disable the Cognito sandbox flag and stop the test window; revoke the three
   CertPath sessions and remove the synthetic D1 identities, roles, assignment,
   and learner grant.
2. Delete the three Cognito users, both app clients, hosted-UI domain, and
   isolated user pool. Remove any temporary Cognito triggers/roles and their
   logs if added.
3. Delete the allowlist Lambda and its role/log group, then delete the sandbox
   Worker and D1 database; remove its secrets and temporary Cloudflare Access
   policy/API token.
4. Review AWS SES/Cognito usage and Cloudflare Worker/D1 usage for residual
   charges, then revoke temporary AWS credentials. Do not delete shared
   identities, domains, databases, or account-level resources.

### Blockers found in review

- **Cost:** the strict $0 cap cannot be guaranteed for the two required email
  sends. AWS Free Tier credits are conditional, and the Cloudflare plan and
  CPU headroom are unknown.
- **Deployment controls not yet verified:** the local Worker allowlist test
  injects `CF-Connecting-IP`; it does not prove deployed Cloudflare ingress
  values or remote D1 behavior. The PreSignUp handler is tested as a function,
  but has not been packaged, deployed, attached to a pool, or tested against
  real sign-up triggers. Do not enable the feature until both controls pass
  against the isolated deployment.
- **Access not yet provisioned:** AWS CLI/account billing access, target-pool
  configuration, Cloudflare plan, and a remote D1/Worker environment remain
  unavailable or unverified. No provider claim behavior has been proven.

### Official sources

- [Amazon Cognito pricing](https://aws.amazon.com/cognito/pricing/) — Essentials MAU allowance and separately billed registration/recovery/verification emails.
- [Amazon SES pricing](https://aws.amazon.com/ses/pricing/) — current SES plans, outbound-email rate, and conditional AWS Free Tier credits.
- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/) — request/duration rates and free-tier allowance for an optional sign-up allowlist.
- [Cognito email settings](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html) — verification, ForgotPassword, default sender, and SES delivery.
- [Cognito PreSignUp trigger](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-sign-up.html) — public and admin signup handling, trigger response, and confirmation flags.
- [Cognito TOTP MFA](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa-totp.html) and [step-up authentication](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-step-up-authentication.html) — software-token MFA and assurance evidence.
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [limits](https://developers.cloudflare.com/workers/platform/limits/) — Free/Paid limits and minimum Paid-plan charge.
- [Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/) — Cloudflare's `CF-Connecting-IP` client-address header.
- [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) — Free and Paid database allowances.
- [Workers `workers.dev`](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) — default public availability and Access protection.
- [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) — scoped account and Access permission groups.

The local tests model Cognito responses; they cannot establish that the target
Essentials pool emits the required signed claims or their expected semantics.
No observed provider gap has been established. If the target pool cannot
produce fresh, verifiable TOTP evidence for both staff roles, including after
enrollment and an existing SSO session, report that failure and return to the
architect for the retained Auth0 fallback recommendation.

## Limitations and unresolved decisions

- The owner-approved `$0` cap blocks provisioning unless an actual no-charge
  path can be confirmed. `COGNITO_DEFAULT` uses AWS-managed SES resources, but
  email sends are separately billed; no cost was incurred or assumed to be
  zero.
- This is a local server-side harness, not a browser sign-in implementation or
  a live Cognito proof. Email confirmation, password reset, TOTP enrollment,
  returning sign-in, SSO, and provider logout still require isolated synthetic
  accounts in a real target pool.
- Sandbox session expiry currently follows the verified ID token's `exp`.
  Production CertPath session lifetime and provider-logout behavior remain
  undecided; do not infer them from this sandbox behavior.
- Google sign-in and production rollout remain outside this slice. No provider
  is selected, and the proposed identity architecture ADR is unchanged.

## Architect inspection and run steps

1. Run `npm ci`.
2. Run the focused synthetic boundary tests:
   `npm exec --workspace @certpath/api -- vitest run --config vitest.config.ts test/cognito-sandbox.test.ts`.
3. Run `npm run verify`.
4. Inspect the callback and claim checks in
   `apps/api/src/cognito-sandbox.ts`, the transaction constraints in
   `db/migrations/0007_cognito_login_transactions.sql`, and test cases in
   `apps/api/test/cognito-sandbox.test.ts`. Review the allowlist trigger and
   tests in `apps/api/src/cognito-signup-allowlist.ts` and
   `apps/api/test/cognito-signup-allowlist.test.ts`.
5. Keep `COGNITO_SANDBOX_ENABLED=false` unless the owner explicitly approves
   a cost-safe target pool and live sandbox execution. Live acceptance must
   record actual provider evidence for first sign-in/enrollment, returning
   staff, existing SSO, and the missing/stale-evidence denials before any
   provider decision.
