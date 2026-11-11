# Cognito staff MFA sandbox review

Status: **local proof harness implemented; live Cognito sandbox untested**.
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

The owner approved a **$0 spending cap** and a **5-minute staff MFA freshness
window**. No AWS CLI or configured AWS credentials were available in this
environment. Current official pricing shows separate, positive SES charges
for verification and password-reset emails; AWS credits might offset them, but
account eligibility is unknown. The Cloudflare account's plan and Worker CPU
headroom are also unverified. A strict $0 run therefore cannot be certified,
so provisioning and all potentially billable calls remain stopped. Cloudflare
Wrangler is authenticated, but no remote deployment was attempted.

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
- `COGNITO_SANDBOX_ENABLED` is `false` in the checked-in Wrangler config.
  Provider values are blank and secrets are not included in the repository.
  Do not enable this route for production or treat the local harness as a
  provider-selection decision.

## Files changed

- `apps/api/src/cognito-sandbox.ts` — sandbox-gated login, callback, token
  validation, session issuance, CSRF, and CertPath logout.
- `apps/api/src/index.ts` — mounts the route and supports injected fetch for
  isolated tests.
- `db/migrations/0007_cognito_login_transactions.sql` — expiring,
  single-use login-transaction storage.
- `apps/api/test/cognito-sandbox.test.ts` — synthetic signed-token tests
  running through the Worker API and Miniflare D1.
- `apps/web/wrangler.jsonc` — disabled-by-default sandbox settings and the
  owner-approved five-minute, TOTP-only staff assurance policy.
- `docs/reviews/cognito-staff-mfa-sandbox.md` — this review record.

No dependency, real account, question bank, personal data, or secret was added.
The identity architecture decision remains proposed; no provider was adopted.

## Verification

| Command or scenario | Result |
|---|---|
| `npm exec --workspace @certpath/api -- vitest run --config vitest.config.ts test/cognito-sandbox.test.ts` | Passed: 1 test file, 9 tests. |
| `npm run verify` | Passed on Windows: workspace type checks; API health test; 10 API Worker/D1 test files (78 tests); 58 web tests; client and Cloudflare Worker SSR production builds. |
| Authorization-code/PKCE, transaction binding and replay | Passed with synthetic signed tokens and isolated D1 sessions. A callback from another browser is rejected without consuming the valid transaction; the valid callback creates one session and replay is rejected. |
| Global Admin and Manager staff sessions | Passed with synthetic level-4 TOTP claims. D1 role checks and Manager assigned-versus-unassigned certification authorization were verified. |
| Wrong client, issuer, nonce, token use, expiry, signature, missing/low assurance, stale/future MFA time | Passed: no staff session was created for the rejected cases. A refreshed-token scenario with stale original `auth_time` was rejected. |
| Learner signup, verified-email gate, scoped dashboard, and second-exam denial | Passed locally with a synthetic verified identity and a D1 Standard grant for one exam. The granted exam appears in the dashboard; a different exam's attempt list is denied. |
| Enrollment-only staff denial and returning login | Passed locally: a synthetic level-1/password-only login creates no staff session; a later fresh level-4 TOTP login for the same D1 Global Admin creates one. |
| CertPath logout | Passed locally: D1 session revocation prevents subsequent protected API access. |
| Live target-pool claim availability; first sign-in/enrollment; returning staff; existing Cognito SSO | **Untested** — no target pool was provisioned under the $0 cap. |
| Actual learner email verification/password reset, and actual provider logout/revocation effects on a CertPath session | **Untested** — require the live provider sandbox. |
| Remote Cloudflare Worker and D1 integration | **Untested** — verification used the local Cloudflare Worker test harness and Miniflare D1. |
| Ubuntu GitHub Actions | Passed on implementation commit `e2b634e44574243290a799c70b59e744575a87df`: [run 43081225260](https://github.com/Pdey2022/certpath/actions/runs/43081225260). Any later PR-head update must be checked separately. |

## Live test setup and teardown checklist

Planning only; checked against official pricing and platform documentation on
**11 November 2026**. No live resources have been created.

### Cost decision

| Service | Minimum test usage and current pricing | $0-cap assessment |
|---|---|---|
| Cognito Essentials | Three direct MAUs are below the published 10,000 direct-MAU free allowance, assuming the pool stays on Essentials and account-wide usage remains within the allowance. | Expected $0 for these MAUs. |
| Cognito email through SES | Cognito sends both self-registration verification and ForgotPassword/reset email through SES. Current SES Essentials pricing is $0.16 per 1,000 outbound emails; one verification plus one reset is approximately **$0.00032**, before resends or any staff invitation emails. Cognito's default sender still uses SES. | **Not $0 usage.** The current SES page advertises up to $200 in credits for eligible new AWS customers, but this account's eligibility and remaining credit are unknown; credits are not a verified hard spending cap. |
| Optional Cognito PreSignUp Lambda | Needed if self-registration is enabled and sign-ups must be allowlisted to the one synthetic learner. Lambda usage is request/duration metered. | The published Lambda free tier may cover one test invocation, but account-wide usage/eligibility is unknown; CloudWatch log ingestion/retention may also be billable. |
| Cloudflare Worker and D1 | Workers Free includes 100,000 requests/day and 10 ms CPU per request. D1 Free includes 5 million rows read/day, 100,000 rows written/day, 5 GB storage, and 10 databases. | Could remain $0 if this account is on Free and usage stays within limits. This callback performs RSA/JWKS token verification; its CPU use has not been measured on the remote Worker, and the account plan is unknown. Workers Paid has a $5/month minimum. |

**Conclusion: no-go under the currently approved strict $0 cap.** The minimum
email journey has positive SES metered usage. Credits could reduce the
out-of-pocket bill for an eligible account, but neither eligibility nor the
Cloudflare plan is known. Obtain a new cap or verify an eligible credit balance
and an existing Cloudflare Free plan before provisioning. Do not treat a
budget alert as a spending cap.

### Minimum resources and permissions

| Provider | Resources | Minimum permissions / notes |
|---|---|---|
| AWS | One isolated Cognito User Pool in one region on Essentials; required software-token/TOTP MFA; one Cognito-managed hosted-UI domain; separate staff and learner app clients configured for authorization code + PKCE, with no client secret; three synthetic users. Use Cognito's default email configuration to avoid a custom SES sender/domain. If self-registration is enabled, add a PreSignUp Lambda allowlist for the one test learner (or another reviewed control). | Use a temporary operator role for the required Cognito pool, domain, app-client, and test-user create/read/update/delete operations; scope to the sandbox region and pool where AWS supports resource scoping. Do not use `AdministratorAccess`. Add billing/cost read access for preflight and teardown checks. The default email path needs no customer SES identity or sender role, but SES delivery is still billable. A custom SES sender would add a verified identity and Cognito-to-SES permissions and is not needed. The optional Lambda requires a narrowly scoped execution role and permission for Cognito to invoke it. |
| Cloudflare | One separate test Worker deployed to its existing `workers.dev` subdomain; one isolated D1 database with the repository migrations; Worker variables for issuer/domain/callback/client IDs and the 300,000 ms/TOTP policy; `CSRF_HMAC_SECRET` and `COGNITO_TRANSACTION_ENCRYPTION_KEY` stored as Worker secrets. No custom domain or DNS zone is required. | Use a short-lived API token scoped to the account with Workers Scripts edit and D1 edit; add Access application/policy edit only if configuring an Access gate. Do not use a global API token. Confirm the plan and D1 quota before deploying. |

AWS Cognito MAU free allowance and SES email charges are separate. Avoid SMS
MFA, custom SES domains, custom domains, paid Cloudflare Workers, and logging
services not required by the test. The SES Essentials rate assumes ordinary
outbound messages; retries and any additional setup emails increase usage.

### Acceptance conditions

1. Seed exactly one synthetic Global Admin and one synthetic Manager in D1.
   The Manager is assigned to exactly one test certification. Neither role nor
   assignments come from Cognito claims.
2. For **each** staff account, a CertPath session is created only after the
   Worker verifies the signed ID token from the staff client, exact
   transaction nonce, issuer, expiry and `token_use=id`, plus
   `acr=urn:cognito:loa:4`, AMR containing `pwd`, `otp`, and `mfa`, and an
   `auth_time` within the approved 300-second window. Verify first enrollment
   does not itself pass; then test a completed authenticator-app challenge,
   returning staff, and an existing Cognito SSO session.
3. Confirm no staff session is created for a learner-client token, wrong
   nonce, enrollment-only/password-only result, missing or stale MFA evidence,
   or refreshed token with stale original `auth_time`. Confirm the resulting
   Global Admin and Manager permissions are still read from D1 and the Manager
   is denied for an unassigned exam.
4. Register one synthetic learner, complete the email-verification challenge,
   sign in with the learner client, and exercise password reset (count both
   emails in the SES usage review). Seed one time-bounded Standard grant for
   the exact test certification and exam version in D1. The dashboard should
   show that exam; its protected APIs should allow it and deny a second exam.
5. Use no real identities or question content. Keep raw tokens, passwords,
   authenticator secrets, email codes, and test addresses out of logs and
   committed files.

### Teardown

1. Disable the Cognito sandbox flag and stop the test window; revoke the three
   CertPath sessions and remove the synthetic D1 identities, roles, assignment,
   and learner grant.
2. Delete the three Cognito users, both app clients, hosted-UI domain, and
   isolated user pool. Remove any temporary Cognito triggers/roles and their
   logs if added.
3. Delete any allowlist Lambda and its role/log group, then delete the sandbox
   Worker and D1 database; remove its secrets and temporary Cloudflare Access
   policy/API token.
4. Review AWS SES/Cognito usage and Cloudflare Worker/D1 usage for residual
   charges, then revoke temporary AWS credentials. Do not delete shared
   identities, domains, databases, or account-level resources.

### Blockers found in review

- **Cost:** the strict $0 cap cannot be guaranteed for the two required email
  sends. AWS Free Tier credits are conditional, and the Cloudflare plan and
  CPU headroom are unknown.
- **Unauthenticated D1 writes:** `GET /api/auth/cognito/start` creates a login
  transaction for any caller when the feature flag is enabled. There is no
  rate limit in this harness. `workers.dev` URLs are public unless protected.
  Before a remote test, add an allowlisted Access/front-door control and a
  request limit or otherwise keep the Worker non-public; verify Cognito's
  public self-registration is limited to the synthetic learner so arbitrary
  signups cannot drive email usage. Do not enable the flag on an unprotected
  public deployment.
- **Access not yet provisioned:** AWS credentials, target-pool configuration,
  Cloudflare plan, and a remote D1/Worker environment remain unavailable or
  unverified. No provider claim behavior has been proven.

### Official sources

- [Amazon Cognito pricing](https://aws.amazon.com/cognito/pricing/) — Essentials MAU allowance and separately billed registration/recovery/verification emails.
- [Amazon SES pricing](https://aws.amazon.com/ses/pricing/) — current SES plans, outbound-email rate, and conditional AWS Free Tier credits.
- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/) — request/duration rates and free-tier allowance for an optional sign-up allowlist.
- [Cognito email settings](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html) — verification, ForgotPassword, default sender, and SES delivery.
- [Cognito TOTP MFA](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa-totp.html) and [step-up authentication](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-step-up-authentication.html) — software-token MFA and assurance evidence.
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [limits](https://developers.cloudflare.com/workers/platform/limits/) — Free/Paid limits and minimum Paid-plan charge.
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
  path can be confirmed. Cognito email delivery may involve separately billed
  AWS-managed SES resources; no cost was incurred or assumed to be zero.
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
   `apps/api/test/cognito-sandbox.test.ts`.
5. Keep `COGNITO_SANDBOX_ENABLED=false` unless the owner explicitly approves
   a cost-safe target pool and live sandbox execution. Live acceptance must
   record actual provider evidence for first sign-in/enrollment, returning
   staff, existing SSO, and the missing/stale-evidence denials before any
   provider decision.
