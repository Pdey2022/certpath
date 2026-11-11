# Cognito staff MFA sandbox review

Status: **local harness implemented; live staff proof blocked before
credentials or sign-in changes; learner phase untested**.
No AWS pool, Cloudflare Worker, or remote D1 database was created or modified
during this review.

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

The Worker now requires an exact client-IP allowlist before any Cognito route.
With sign-in disabled, only `GET /api/auth/cognito/preflight` is available:
the allowed address receives `signInEnabled: false`, while other addresses
receive 403. Login, callback, CSRF, and logout routes remain disabled. Local
tests cover this preflight. The allowed-network preflight was observed
remotely; the owner reports a denied mobile-data request, which this agent
did not independently reproduce. The deployed source remains uninspected.

The runbook separates two phases. The staff-only proof uses one synthetic
Global Admin and one exam-scoped Manager, disables public signup, and suppresses
admin invitations. It sends no email and does not need the learner PreSignUp
Lambda. Learner registration, email verification, and password reset are a
later phase and remain untested.

The owner approved a **$0 spending cap** and a **5-minute staff MFA freshness
window**. The user-specified pool could not be verified because AWS access is
unavailable. A read-only probe found the requested Worker and returned
`signInEnabled: true` from this environment. The owner reports the mobile-data
preflight returned 403 after Wi-Fi was disabled. The Cloudflare plan/quota and
AWS billing remain unknown. No resources were provisioned or changed.

## Latest live staff attempt — blocked

| Role | Cognito status | Password change | MFA session | D1 role/assignment | Overall |
|---|---|---|---|---|---|
| Global Admin | Untested | Not attempted | Untested | Untested | **Untested** |
| Exam-scoped Manager | Untested | Not attempted | Untested | Untested | **Untested** |

- AWS CLI and Cognito SDK are unavailable in this environment. No `AWS_*`
  credential environment variables or local AWS profile files were present,
  so `AdminGetUser` was not called and neither user's status is known. No
  password was requested or changed: this interface cannot provide a private
  masked password prompt.
- Wrangler is authenticated. The repository's
  `apps/web/wrangler.jsonc` targets `certpath-foundation`, not the supplied
  `certpath-staff-mfa-sandbox`. A read-only deployment query for the supplied
  name found five deployments after selecting the authenticated Cloudflare
  account; no deployment or configuration was changed.
- The supplied Worker's preflight returned HTTP 200 with
  `signInEnabled: true` from this environment, including when a forged
  `X-Forwarded-For` header was sent. The owner reports that the same preflight
  returned 403 from a phone on mobile data with Wi-Fi off; this agent did not
  independently reproduce that request. The latest deployment ID is unchanged
  from the previous read-only check, and this agent did not change the IP
  allowlist. The deployed source and current allowlist value were not inspected.
  No `/start` request was sent and no remote D1 data was queried.
- No invitation, password-reset email, SMS, or public signup was triggered.

Before continuing, an AWS operator must sign in to the account that owns the
pool (for example, `aws sso login --profile <sandbox-profile>`) and have
`cognito-idp:AdminGetUser` and `cognito-idp:AdminSetUserPassword` scoped to
`arn:aws:cognito-idp:eu-north-1:<account-id>:userpool/eu-north-1_6uS3EspI9`.
Password entry and updates must run in a private interactive environment with
masked input; do not send passwords in chat. The Worker is intentionally
enabled per the owner. No deployment change was observed since the previous
read-only check; repeat the mobile-data preflight only if the Worker deployment
or IP allowlist changes.

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
  block the Cognito routes. The route compares the normalized address from
  `CF-Connecting-IP`; it does not trust `X-Forwarded-For` or CIDR ranges.
  While `COGNITO_SANDBOX_ENABLED=false`, the Worker exposes only the preflight
  endpoint after the IP check. Local tests inject the Cloudflare header and
  cannot prove deployed ingress values.
- `apps/api/src/cognito-signup-allowlist.ts` is the proposed Node.js Cognito
  PreSignUp trigger. Configure `COGNITO_SANDBOX_USER_POOL_ID`,
  `COGNITO_SANDBOX_LEARNER_EMAIL`, and
  `COGNITO_SANDBOX_ALLOWED_STAFF_EMAILS` only in Lambda environment settings.
  This Lambda is deferred to the learner phase; it is unnecessary when public
  self-registration is disabled for the staff-only proof. In the later phase,
  the public trigger accepts only the learner, and the admin-create trigger
  accepts only the staff.
- `COGNITO_SANDBOX_ENABLED` is `false` in the checked-in Wrangler config.
  Provider values are blank and secrets are not included in the repository.
  Do not enable this route for production or treat the local harness as a
  provider-selection decision.

## Files changed

- `apps/api/src/cognito-sandbox.ts` — sandbox-gated login, callback, token
  validation, session issuance, CSRF, CertPath logout, and pre-D1 IP
  allowlist/preflight.
- `apps/api/src/cognito-signup-allowlist.ts` — exact-user Cognito PreSignUp
  allowlist for the public learner and admin-seeded staff accounts.
- `apps/api/src/index.ts` — mounts the route and types its required settings.
- `db/migrations/0007_cognito_login_transactions.sql` — expiring,
  single-use login-transaction storage.
- `apps/api/test/cognito-sandbox.test.ts` — synthetic signed-token tests
  running through the Worker API and Miniflare D1, including denied-IP
  requests with no login-transaction write and auth-disabled preflight.
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
| `npm exec --workspace @certpath/api -- vitest run --config vitest.config.ts test/cognito-sandbox.test.ts test/cognito-signup-allowlist.test.ts` | Passed: 2 files, 16 tests. |
| `npm run verify` | Passed on Windows: workspace type checks; 11 API Worker/D1 test files (85 tests); 58 web tests; client and Cloudflare Worker SSR production builds. |
| `npm exec --workspace @certpath/web -- wrangler whoami` | Passed: Wrangler authenticated. The command does not report the account billing plan. |
| Authorization-code/PKCE, transaction binding and replay | Passed with synthetic signed tokens and isolated D1 sessions. A callback from another browser is rejected without consuming the valid transaction; the valid callback creates one session and replay is rejected. |
| Global Admin and Manager staff sessions | Passed with synthetic level-4 TOTP claims. D1 role checks and Manager assigned-versus-unassigned certification authorization were verified. |
| Wrong client, issuer, nonce, token use, expiry, signature, missing/low assurance, stale/future MFA time | Passed: no staff session was created for the rejected cases. A refreshed-token scenario with stale original `auth_time` was rejected. |
| Synthetic learner identity, verified-email gate, scoped dashboard, and second-exam denial | Passed locally using synthetic signed tokens and a D1 Standard grant for one exam; this did not exercise Cognito email delivery. |
| Enrollment-only staff denial and returning login | Passed locally: a synthetic level-1/password-only login creates no staff session; a later fresh level-4 TOTP login for the same D1 Global Admin creates one. |
| CertPath logout | Passed locally: D1 session revocation prevents subsequent protected API access. |
| Worker allowlist preflight | Local pass: while sign-in is disabled, an allowlisted IP receives `signInEnabled: false`, an unlisted IP receives 403 (even with an allowed `X-Forwarded-For`), `/start` returns 503, and D1 has no new login transaction. Remote allowed-network preflight returned HTTP 200 with `signInEnabled: true`, unchanged by a forged `X-Forwarded-For`; the owner reports a 403 from phone-on-mobile-data. The latter was not independently reproduced and the deployed source remains uninspected. |
| Cognito PreSignUp allowlist | Unit tests passed; intentionally not attached for the staff-only phase because self-registration is disabled. Real Lambda trigger behavior is deferred to the learner phase. |
| AWS access and staff account statuses | **Unverified/untested** — AWS CLI/SDK, environment credentials, and local AWS profiles were unavailable; neither `AdminGetUser` nor password mutation was attempted. |
| Cloudflare target Worker | Read-only deployment query found five deployments for the supplied `certpath-staff-mfa-sandbox` Worker. The repository Wrangler config targets `certpath-foundation`; the deployed source and account plan/quota were not inspected. |
| Deployed Worker sign-in gate | Allowed-network preflight returned HTTP 200 with `signInEnabled: true`; owner reports an unlisted mobile-data request returned 403. The latest deployment ID is unchanged, and no allowlist change was made by this agent. The deployed source and allowlist value remain uninspected. No login-start request or D1 query was made. |
| Live target-pool claims; staff enrollment, returning sign-in, and existing SSO | **Untested** — no credentials were changed and no sign-in was attempted. |
| Cognito learner registration, email verification, and password reset | **Untested; deferred** until the separate learner email phase. The local synthetic identity test does not count as this test. |
| Remote Cloudflare Worker/D1 tester restriction and integration | **Partially checked** — current allowed-network preflight passed; owner reports the phone-on-mobile-data preflight was denied. The unlisted request was not independently reproduced and deployed source/configuration were not inspected. No remote D1 query was made. |
| Ubuntu GitHub Actions | Passed on the staff/learner runbook commit `0dc3cd42e04942fbc601d3d21b9cb62abefd5833`: [run 43087694029](https://github.com/Pdey2022/certpath/actions/runs/43087694029). |

## Live test setup and teardown checklist

Planning and read-only checks; pricing references were checked on
**11 November 2026**. Existing resources were not created or modified during
this review.

### Phase 0 — account and cost gate

Complete these checks before creating a pool, Worker, D1 database, or Lambda.

| Service | Staff-only usage and published pricing | $0-cap assessment |
|---|---|---|
| Cognito Essentials | Two direct staff MAUs are within the published 10,000 direct-MAU free allowance if the pool is Essentials and the account/pool's existing usage has not exhausted that allowance. | **Potentially $0; account usage and billing must be checked first.** |
| Staff email | Create both users administratively with invitation messages suppressed. Use authenticator-app TOTP, not SMS or email MFA. | No verification, reset, or invitation email is part of this phase, so no SES send is expected. |
| Cognito PreSignUp Lambda | Not needed for staff-only testing because public self-registration is disabled. | No Lambda invocation or log cost in this phase. |
| Cloudflare Worker and D1 | Workers Free publishes 100,000 requests/day and 10 ms CPU per invocation. D1 Free publishes 5 million rows read/day, 100,000 rows written/day, 5 GB total storage, and 10 databases. | **Potentially $0** if the account is on Free and usage remains within limits. Verify plan, remaining quota, D1 database count, and deployed Worker CPU; Workers Paid has a $5/month minimum. |
| Deferred learner email phase | Cognito `COGNITO_DEFAULT` uses AWS-managed SES resources, but email is separately billed. The current SES Essentials rate is $0.16 per 1,000 emails; one verification plus one reset is about **$0.00032**, before retries. | Not included in the staff-only estimate. Requires its own cost approval/credit check before enabling learner signup. |

**Current decision: staff-only cost is plausible but not verified; no further
live test is authorized until the blockers below are cleared.** AWS identity,
billing, and Cognito MAU usage could not be inspected. Wrangler authentication
works but does not reveal the account's plan or quota. The requested Worker
exists, but the repository configuration points to a different Worker name.
Confirm AWS billing/usage and the Cloudflare Free plan/remaining quota with
the owner before any provisioning. If either account cannot be verified within
the $0 cap, keep the test blocked.

### Minimum resources and permissions for the staff phase

| Provider | Required resources | Minimum access / cost notes |
|---|---|---|
| AWS | One isolated Cognito Essentials pool with a Cognito-managed domain, separate staff and learner app clients, public self-registration disabled, TOTP required, and exactly two synthetic staff users. Set `MessageAction=SUPPRESS`; set the synthetic staff email attribute verified administratively because email verification is not under test. | A temporary, region-scoped operator role for the pool, app clients, and two test users, plus billing/MAU read access. Do not use `AdministratorAccess`. No SES identity, PreSignUp Lambda, email MFA, SMS, or invitation delivery is needed. |
| Cloudflare | One sandbox Worker and isolated D1 database with repository migrations. Worker vars include Cognito issuer/domain/callback/client IDs, the 300,000 ms/TOTP policy, and exact tester IP allowlist. Store `CSRF_HMAC_SECRET` and `COGNITO_TRANSACTION_ENCRYPTION_KEY` as Worker secrets. | A short-lived account token with Workers Scripts edit and D1 edit, only after cost approval. No custom domain or Access product is required for the single-location IP allowlist test. Confirm Workers Free, D1 quota, and CPU budget before creation. |

### Phase 1 — staff MFA proof (no learner email)

After Phase 0 is approved:

1. Use one isolated Cognito Essentials pool with TOTP required. Set
   `AllowAdminCreateUserOnly=true` to disable public self-registration.
2. Admin-create exactly one synthetic Global Admin and one synthetic
   Manager, with `MessageAction=SUPPRESS`. Provide any initial credentials
   out of band; never put passwords in source, logs, or review evidence.
   Do not create a learner account or attach the PreSignUp Lambda in this
   phase.
3. In D1, seed exactly those two internal staff identities and roles. Assign
   the Manager to exactly one test certification/exam. Cognito claims do not
   grant roles or exam permissions.
4. Keep `COGNITO_SANDBOX_ENABLED=false`, set the exact tester IP allowlist,
   and deploy only after the account/cost gate. Before enabling sign-in,
   verify the deployed Worker from both networks:
   - Approved tester IP: `GET /api/auth/cognito/preflight` returns 200 with
     `signInEnabled: false`.
   - Unlisted IP: the same request returns 403 `sandbox_access_denied`, even
     if the client supplies an allowed `X-Forwarded-For`.
   - The approved IP receives 503 from `/api/auth/cognito/start` while sign-in
     is off; neither probe creates a D1 login transaction or CertPath session.
   - If these results differ, do not enable sign-in. Confirm the Worker sees
     Cloudflare's edge-provided `CF-Connecting-IP`; never trust a client-set
     forwarding header.
5. Only after the preflight passes, enable the sandbox for the bounded test.
   Test first sign-in and TOTP enrollment, returning staff sign-in, and login
   from an existing Cognito SSO session for **both** roles.
6. Pass only if the Worker validates the signed staff-client ID token, exact
   transaction nonce, issuer, expiry, and `token_use=id`, plus fresh signed
   `acr=urn:cognito:loa:4`, `amr` containing `pwd`, `otp`, and `mfa`, and
   `auth_time` within 300 seconds before it creates a CertPath session.
   Enrollment alone, password-only sign-in, wrong client/nonce, missing or
   stale evidence, and a refreshed token with stale `auth_time` must create
   no session. Confirm D1 still controls the Manager's one-exam scope.

### Phase 2 — learner email test (deferred; currently untested)

Only run as a separate, approved phase. Enable public signup with the
PreSignUp allowlist attached so only the configured synthetic learner can
register. Complete actual email verification, sign in, and password reset
using `COGNITO_DEFAULT`; record the two SES sends and their cost. This phase
is not covered by the staff-only $0 estimate and may exceed the cap without a
confirmed credit balance or separate owner approval.

### Acceptance conditions

1. Do not provision until AWS billing/MAU usage and Cloudflare plan/remaining
   quotas are verified to fit the existing `$0` cap. If either is unknown or
   over its free allowance, stop and request an owner decision.
2. In the staff-only phase, public self-registration is disabled, exactly two
   synthetic staff accounts are admin-created with invitation messages
   suppressed, and no learner account or learner grant is seeded.
3. Before enabling sign-in, the deployed preflight returns 200 with
   `signInEnabled: false` for the allowed tester and 403 for an unlisted
   tester; `/start` returns 503 while disabled. Neither request creates a D1
   login transaction or CertPath session.
4. For both the Global Admin and the exam-scoped Manager, enrollment,
   returning sign-in, and existing SSO are exercised. A CertPath session is
   created only after validating the signed staff-client token, exact
   transaction nonce, issuer, expiry, `token_use=id`, fresh
   `acr=urn:cognito:loa:4`, AMR containing `pwd`, `otp`, and `mfa`, and
   `auth_time` within 300 seconds. Enrollment alone, wrong client/nonce,
   missing or stale evidence, and refreshed tokens with stale `auth_time`
   create no session. The Manager remains denied for an unassigned exam.
5. In the separate learner phase only, verify one synthetic learner's
   registration, email verification, sign-in, scoped Standard grant, and
   password reset. Until that phase runs, mark all four email/account journey
   cases **untested**.
6. Use no real question content or personal identities. Keep raw tokens,
   passwords, authenticator secrets, email codes, and test addresses out of
   logs and committed files.

### Teardown

1. Disable `COGNITO_SANDBOX_ENABLED`; revoke the two CertPath staff sessions
   and remove the two synthetic D1 identities, roles, and Manager assignment.
2. Delete the two Cognito staff users, app clients, hosted-UI domain, and
   isolated pool. No learner user or PreSignUp Lambda should exist in the
   staff-only phase.
3. Delete the sandbox Worker and D1 database and remove Worker secrets and
   temporary API tokens.
4. Review Cognito MAU and Cloudflare Worker/D1 usage for residual charges,
   then revoke temporary AWS credentials. Do not delete shared identities,
   domains, databases, or account-level resources.
5. If the separately approved learner-email phase ran, also delete its learner
   and PreSignUp Lambda, review SES sends, and clean up its Lambda role/logs.

### Blockers before changing users or running sign-in

- **AWS access and masked input:** no AWS CLI/SDK or profile credentials are
  available here. The exact required Cognito actions and SSO step are recorded
  above. A private masked input mechanism is also required before setting
  either synthetic user's permanent password.
- **Deployed tester gate:** the supplied Worker exists and reports
  `signInEnabled: true`. The current allowed-network preflight passed and the
  owner reports a 403 from mobile data; the deployed source and current
  allowlist value were not independently inspected. No deployment change was
  observed since the previous deployment check, and this agent made no
  allowlist changes.
- **Provider proof:** the user-specified pool's existence and user statuses
  were not verified. First enrollment, returning staff, existing SSO, and
  signed assurance evidence remain untested.
- **Deferred learner phase:** registration, email verification, and password
  reset remain untested by design. SES email charges and the PreSignUp Lambda
  require a separate cost decision before that phase.

### Official sources

- [Amazon Cognito pricing](https://aws.amazon.com/cognito/pricing/) — Essentials MAU allowance and separately billed registration/recovery/verification emails.
- [Amazon SES pricing](https://aws.amazon.com/ses/pricing/) — current SES plans, outbound-email rate, and conditional AWS Free Tier credits.
- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/) — request/duration rates and free-tier allowance for an optional sign-up allowlist.
- [Cognito email settings](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html) — verification, ForgotPassword, default sender, and SES delivery.
- [Cognito AdminCreateUser API](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminCreateUser.html) — administrative seeding and invitation suppression.
- [Cognito AdminCreateUser configuration](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminCreateUserConfigType.html) — `AllowAdminCreateUserOnly` and self-service sign-up control.
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

- The staff-only proof could fit the `$0` cap if AWS MAUs are within the free
  allowance and Cloudflare usage remains on Free; neither account condition
  was verified. `COGNITO_DEFAULT` email sends are separately billed and belong
  to the deferred learner phase.
- The code is a local server-side harness, not a live Cognito proof. TOTP
  enrollment, returning staff sign-in, and existing SSO remain untested in the
  supplied pool. Learner registration, email verification, and password reset
  are explicitly deferred and untested.
- Sandbox session expiry currently follows the verified ID token's `exp`.
  Production CertPath session lifetime and provider-logout behavior remain
  undecided; do not infer them from this sandbox behavior.
- Google sign-in and production rollout remain outside this slice. No provider
  is selected, and the proposed identity architecture ADR is unchanged.

## Architect inspection and run steps

1. Run `npm ci`.
2. Run the focused synthetic boundary tests:
   `npm exec --workspace @certpath/api -- vitest run --config vitest.config.ts test/cognito-sandbox.test.ts test/cognito-signup-allowlist.test.ts`.
3. Run `npm run verify`.
4. Inspect the callback and claim checks in
   `apps/api/src/cognito-sandbox.ts`, the transaction constraints in
   `db/migrations/0007_cognito_login_transactions.sql`, and test cases in
   `apps/api/test/cognito-sandbox.test.ts`. Review the allowlist trigger and
   tests in `apps/api/src/cognito-signup-allowlist.ts` and
   `apps/api/test/cognito-signup-allowlist.test.ts`.
5. The supplied Worker is intentionally enabled. The current allowed-network
   preflight passed, the owner reports a denied phone-on-mobile-data preflight,
   and no deployment change was observed since the previous check. Repeat the
   mobile-data preflight if the deployment or IP allowlist changes. Keep
   learner email tests deferred until separately approved.
