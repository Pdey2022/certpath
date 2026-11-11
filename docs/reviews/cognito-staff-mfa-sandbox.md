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
environment. Cognito and email-delivery costs cannot be proven to remain
within a strict $0 cap, so provisioning and all potentially billable calls
were stopped. Cloudflare Wrangler is authenticated, but no remote deployment
was attempted.

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
| Ubuntu GitHub Actions | Passed on implementation commit `e2b634eb3f8d6ca12e9ef0d096d2654de53b477f`: [run 43081225260](https://github.com/Pdey2022/certpath/actions/runs/43081225260). Any later PR-head update must be checked separately. |

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
