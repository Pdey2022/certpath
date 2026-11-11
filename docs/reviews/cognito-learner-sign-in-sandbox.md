# Cognito learner sign-in sandbox handoff

## Scope delivered

Implemented a local-only, learner-only email sign-in entry point and callback
using the hosted identity-provider authorization-code flow. The `/sign-in`
page sends learners to the provider for registration, email verification,
sign-in, and password recovery; CertPath never collects or stores passwords.
The local test provider models those provider-side actions with synthetic
identities and makes no live Cognito requests or email sends.

The Worker binds state, nonce, browser cookie, and an encrypted PKCE verifier to
a single-use D1 transaction. Before issuing an opaque CertPath session, it
validates the signed ID token against the configured issuer and fixed learner
client, checks token use and expiry, verifies the transaction nonce, and
requires `email_verified`. Identity lookup uses issuer and subject, not email.
The learner flow has no staff-session or role-assignment path and rejects an
identity that already has a staff role. Login-start requests are restricted to
the configured tester IPs before any D1 write.

## Local verification results

All application tests used the local Worker/D1 test environment and synthetic
identities. No cloud resources were provisioned or changed, no live Cognito
endpoints were called, no emails were sent, and no real accounts or credentials
were used.

| Check | Result | Evidence |
|---|---|---|
| Learner authorization request, state, nonce, PKCE, and fixed client | Passed | Local Worker/D1 regression test |
| Unlisted tester IP rejected before login-transaction writes; forwarded IP headers ignored | Passed | Local Worker/D1 regression test |
| Unverified learner denied without identity or session creation | Passed | Local Worker/D1 regression test |
| Verified learner receives an opaque session; no staff role is created | Passed | Local Worker/D1 regression test |
| Issuer, client, expiry, token use, nonce, and signature rejection | Passed | Local signed-token regression cases |
| Callback replay rejected; same-email identities with different subjects remain separate | Passed | Local Worker/D1 regression test |
| No exam access before a grant; one synthetic Standard grant appears on the dashboard and a second exam remains inaccessible | Passed | Local Worker/D1 regression test |
| Simulated password reset followed by sign-in with the new password | Passed | Local provider fixture; not a live Cognito reset |
| CertPath logout revokes the D1 session | Passed | Local Worker/D1 regression test |
| Learner-only signup allowlist; no auto-confirmation or auto-verification | Passed | 3 allowlist tests |
| `npm run typecheck --workspace @certpath/api` | Passed | API source and test TypeScript checks exited 0 |
| `npm run verify` | Passed | Workspace typechecks; API health test 1/1; API Worker/D1 tests 82/82 across 11 files; web tests 58/58; client and server production builds completed |

The signup allowlist is implemented as a Cognito PreSignUp handler, but it was
tested only as a local function. It has not been installed or configured in an
AWS pool.

## Files changed

- `apps/api/src/index.ts` — mounts the learner-only auth API and declares its
  bindings.
- `apps/api/src/cognito-learner-sandbox.ts` — learner-only OIDC/PKCE callback,
  token validation, one-use D1 transaction, opaque session, and CSRF-protected
  logout.
- `apps/api/src/cognito-learner-signup-allowlist.ts` — restricts Cognito
  self-signup to one configured synthetic learner without bypassing verification.
- `apps/api/test/cognito-learner-sandbox.test.ts` — simulated provider and
  local Worker/D1 auth, grant-isolation, invalid-token, replay, and logout tests.
- `apps/api/test/cognito-learner-signup-allowlist.test.ts` — signup allowlist
  tests.
- `apps/web/app/routes.ts` — registers `/sign-in`.
- `apps/web/app/components/public-layout.tsx` — adds public learner sign-in
  navigation.
- `apps/web/app/routes/learner-sign-in.tsx` — hosted-provider sign-in entry page.
- `db/migrations/0007_cognito_login_transactions.sql` — stores bounded,
  single-use learner login transactions.

## Known limitations and untested checks

- Actual Cognito registration, email verification, password reset and
  provider-hosted sign-in are **untested**. The test provider simulates these
  provider actions; the Worker token and session boundary is exercised locally.
- The deployed Worker journey, AWS pool configuration, Cognito email delivery,
  account/plan pricing, and any resulting charges are **untested**. No costs
  were incurred by this local work.
- Provider logout and its effect on the Cognito SSO session are **untested**.
  CertPath logout was verified to revoke the D1 application session; it does not
  establish provider logout or provider-session revocation.
- The allowlist handler still needs to be configured in the separate learner
  sandbox pool. Until then, do not enable public signup or use a live pool for
  this flow.
- Staff sign-in, staff roles, Google sign-in, production rollout, deployment,
  and the parked staff MFA proof in PR #15 remain out of scope.

## Architect inspection and local run

1. Confirm the branch is `feat/cognito-learner-sign-in-sandbox` and inspect the
   diff against `origin/main`.
2. Run `npm ci`, then `npm run db:migrate:local` and `npm run verify`.
3. Inspect `apps/api/src/cognito-learner-sandbox.ts` and the local simulated
   provider in `apps/api/test/cognito-learner-sandbox.test.ts`. The tests use
   the configured local D1 binding and synthetic RS256 signing keys.
4. Inspect the signup restriction and tests in
   `apps/api/src/cognito-learner-signup-allowlist.ts` and
   `apps/api/test/cognito-learner-signup-allowlist.test.ts`.
5. Visit `/sign-in` in the local web app to inspect the entry page. Do not
   follow its hosted-provider link for live testing; provider setup, pool
   configuration, and email delivery are not part of this change.
6. Review `db/migrations/0007_cognito_login_transactions.sql` and the API
   binding registration in `apps/api/src/index.ts`.

## PR #16 follow-up: availability and sign-out controls

The public navigation and `/sign-in` entry now check the Worker preflight
endpoint before offering learner sign-in. The navigation shows a status rather
than a link while checking, when sign-in is disabled, or when availability
cannot be confirmed. The entry page offers the hosted-provider action only
when the preflight response explicitly reports that sign-in is enabled. A
disabled preflight also rejects login start.

The learner dashboard now has a Sign out control. It obtains a CSRF token from
the existing session endpoint, POSTs to the existing logout/revocation
endpoint, and navigates to `/sign-in` only after a successful response.
Failures remain on the dashboard with a retryable sign-out error.

Focused local checks passed: the Worker/D1 auth tests passed 11/11; the focused
dashboard and sign-in component tests passed 6/6; web and API typechecks passed.
The disabled-state coverage verifies both that no link or hosted action is
offered and that the Worker blocks login start. The sign-out coverage verifies
the CSRF-protected POST and post-success navigation. No cloud resources,
provider endpoints, or email delivery were used.

Final follow-up verification: `npm run verify` passed with API Worker/D1 tests
83/83 across 11 files, the API health test 1/1, web tests 62/62, workspace
typechecks, and client and server production builds.
