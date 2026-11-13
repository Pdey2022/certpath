# Google sign-in for the invite-only learner pilot (design and local test plan)

**Status:** Implemented for local review in a draft PR; no provisioning or
deployment, and no Google client exists yet.
**Scope:** One pre-provisioned synthetic learner, one exam, Workers Free at $0.

## Goal

Add "Continue with Google" as the second entry path for the invite-only pilot,
using OpenID Connect authorization code flow with PKCE, `state`, and `nonce`.
The ID token is validated server-side and linked to exactly one invite already
present in D1. Nothing else changes: the tester gate, the exact HTTPS origin,
the Secure `__Host-` session cookie, and the server-side exam grant checks stay
as they are.

## Non-goals

- No automatic account creation and no sign-up screen.
- No email-based account linking. An address that matches an existing learner is
  not enough; only a pre-provisioned issuer and subject pair can sign in.
- No Google One Tap, no implicit or hybrid flow, no refresh tokens, no offline
  access, no Google API scopes beyond `openid email`.
- No change to the loopback password flow, the demo, PR #15, PR #25, or staff MFA.

## Flow

1. `GET /api/auth/google/start` - tester gate, then create a login transaction.
2. Browser is redirected to `https://accounts.google.com/o/oauth2/v2/auth` with
   `response_type=code`, `client_id`, the fixed `redirect_uri`, `scope=openid email`,
   `state`, `nonce`, `code_challenge`, `code_challenge_method=S256`, and
   `prompt=select_account`.
3. Google redirects back to `GET /api/auth/google/callback?code=...&state=...`.
4. The Worker resolves the transaction, re-checks the tester gate and the browser
   binding cookie, exchanges the code at `https://oauth2.googleapis.com/token`
   with the PKCE verifier and the client secret, and validates the ID token.
5. On success it links `iss` + `sub` to the invited learner, creates the session
   cookie, and redirects to `/app/home`. On any failure it returns a generic
   denial, records no identity and no session, and redirects to `/sign-in` with
   a neutral error code.

## Files

| File | Change |
|---|---|
| `apps/api/src/learner-google-oidc.ts` | New router: `/preflight`, `/start`, `/callback`. Reuses the transaction pattern already proven in `cognito-learner-sandbox.ts` (state digest primary key, nonce digest, browser-binding digest, AES-GCM encrypted PKCE verifier, 10-minute expiry, `consumed_at`). |
| `apps/api/src/index.ts` | Mount the router at `/api/auth/google` inside the existing staging branch, after the origin check and tester gate. |
| `apps/api/src/security/http-session.ts` | Reused unchanged for the `__Host-certpath_session` cookie, digesting, and CSRF helpers. |
| `apps/api/src/security/learner-dashboard.ts`, `learner-practice.ts` | Reused unchanged for server-side exam authorization; no new grant logic. |
| `db/migrations/0010_learner_oidc_login_transactions.sql` | New transaction table with the same constraints as the Cognito one. Identity uniqueness needs no new constraint: `auth_identities` already has `PRIMARY KEY (issuer, subject)`. |
| `apps/web/app/lib/learner-auth-api.ts` | Staging builds expose `startGoogleSignIn()`; the loopback build keeps the password path only. |
| `apps/web/app/routes/learner-sign-in.tsx` | Add a "Continue with Google" button when the staging origin is active; keep the existing synthetic-learner copy for the local flow. |
| `apps/web/workers/staging-app.ts` | No structural change; the new path is same-origin API traffic behind the existing gate. |
| `apps/web/wrangler.staging.jsonc` | Vars only: `GOOGLE_OIDC_CLIENT_ID`, `GOOGLE_OIDC_REDIRECT_URI`, `LEARNER_GOOGLE_OIDC_ENABLED`. The client secret and the transaction encryption key are Worker secrets, never committed. |

## Server-side validation

| Control | Rule |
|---|---|
| Tester gate | Evaluated before any D1 read or Google call, on both `/start` and `/callback`. Unlisted client IP returns 403 and the run proves zero provider calls. |
| Exact origin | `PUBLIC_SITE_ORIGIN` must equal the configured staging origin; the callback URL is a fixed constant, not derived from the request. |
| `state` | 32 random bytes, only its digest stored, single use, 10-minute lifetime, matched by digest before any token exchange. |
| Browser binding | A `__Host-` HttpOnly Secure cookie holds a second random value; its digest must match the transaction, so a callback URL alone is not enough. |
| PKCE | S256 verifier generated per attempt, encrypted at rest with AES-GCM, used once at token exchange. The Google **web** client still requires the client secret, so the exchange uses both PKCE and the secret. |
| ID token signature | RS256 verified against Google JWKS (`https://www.googleapis.com/oauth2/v3/certs`) selected by `kid`, keys cached in memory with a bounded lifetime and refreshed on unknown `kid`. |
| Claims | `iss` must be `https://accounts.google.com` (the scheme-less form is rejected), `aud` must equal the client ID, `azp` must equal it when present, `exp` and `iat` inside a 60-second skew, and `nonce` must match the transaction digest. |
| Email | `email_verified` must be `true`; the address is display-only and never used for lookup or linking. |
| Linking | Exactly one lookup: `auth_identities` where `issuer = 'https://accounts.google.com'` and `subject = sub`. No row means deny. No insert on login, so a first-time Google user can never self-create. |
| Session | Existing Secure `__Host-certpath_session` cookie, HttpOnly, SameSite=Lax, 8-hour lifetime, hashed token at rest. |
| Exam grants | Existing dashboard and practice queries only; a linked learner with no active grant sees an empty dashboard. |
| Logging | No ID token, code, verifier, cookie, or email in logs. Errors log a coarse reason code and the hashed subject only. |

## Local test plan

Mocked Google provider, isolated D1, no outbound network, synthetic learner only.

**Provider mock.** A local fetch double injected through `createApi(provider.fetch)`
(the pattern `cognito-learner-sandbox.test.ts` already uses) serving two fixed
URLs: a JWKS document and a token endpoint. It signs real ID tokens with a
throwaway RSA key generated in the test, so signature, `kid`, and claim checks
run against genuine crypto rather than stubs. It records every call so a test can
assert that early rejections made **zero** provider calls.

**Fixture.** Fresh D1 per run from `db/migrations`, one `users` row, one
`auth_identities` row with issuer `https://accounts.google.com` and a fixed
subject, one certification, one exam version, one active learner grant.

| Case | Expectation |
|---|---|
| Successful sign-in | `/start` sets the binding cookie and redirects with `state`, `nonce`, and S256 challenge; `/callback` exchanges the code, validates the ID token, creates exactly one session, sets the Secure `__Host-` cookie, and `/app/home` plus `/api/practice/dashboard` return 200 with one authorized exam. |
| Uninvited Google identity | Valid token whose `sub` has no `auth_identities` row: denied, zero new `auth_identities` rows, zero `app_sessions` rows, no cookie, dashboard 401. |
| Email matches an invite but `sub` does not | Same denial, proving email-only linking is off. |
| Invalid `state` | 400, transaction untouched, zero token calls. |
| Replayed callback | First callback succeeds; the identical replay is rejected, leaves one session, and makes no second token call. |
| Expired transaction | Insert an expired row: rejected before token exchange. |
| Nonce mismatch | Token with a different `nonce`: rejected, no session. |
| Bad signature, wrong `kid`, wrong `iss`, wrong `aud` | Each rejected before linking. |
| `email_verified` false | Rejected, no identity, no session. |
| Missing browser-binding cookie | Rejected even with a valid `state` and code. |
| Tester gate | Decoy client IP on `/start` and `/callback`: 403 before D1 writes and before any provider call. |
| Logout | `/api/auth/session/csrf` then `/api/auth/session/logout` returns 204, clears the cookie, sets `revoked_at` in D1, and the dashboard returns 401 afterwards. |

**Isolation rules.** No real Google client, no Google Cloud project, no network
egress: assert that the mock saw only the two expected URLs. Each test uses its
own D1 database and its own throwaway signing key. Credentials, tokens, cookies,
and state values stay out of test output.

## Open questions for review

1. Whether the invite row should be provisioned by a migration seed or by an
   operator script; either way it is pre-provisioned, never created on login.
2. Whether to cap `/start` and `/callback` with the existing rate-limit table, or
   rely on the tester gate plus single-use transactions for the pilot.
3. Whether Google Workspace domain restriction (`hd`) is needed, or whether the
   invite list is sufficient on its own.

## Implementation notes

Local implementation only; nothing is deployed and no Google client exists.

- Added `apps/api/src/learner-google-oidc.ts` with `/preflight`, `/start`, and
  `/callback`, mounted at `/api/auth/google` from `apps/api/src/index.ts`.
- Added `db/migrations/0010_learner_google_signin.sql`: the login transaction
  table and a dedicated rate-limit window table, because the existing
  `local_auth_rate_limit_windows.scope` check constraint is closed to the local
  password scopes.
- Rate limits: 10 starts and 30 callbacks per client IP per 15-minute window,
  counted per request before any D1 write or Google call.
- The callback consumes the transaction with a single conditional `UPDATE ...
  RETURNING`, so concurrent or replayed callbacks cannot both proceed.
- Added `apps/api/src/security/google-invite.ts` and the operator script
  `apps/api/scripts/link-google-learner.ts`. The script only links an existing
  active learner that has no identity yet, and only when the subject is unlinked:

  ```powershell
  npx tsx apps/api/scripts/link-google-learner.ts `
    --user-id <learner-uuid> --subject <google-sub> --remote
  ```

- Staging configuration is variable-only and disabled by default
  (`LEARNER_GOOGLE_OIDC_ENABLED=false`, empty client ID and redirect URI). The
  client secret and transaction key are Worker secrets.
- Local tests: `apps/api/test/learner-google-oidc.test.ts` (18 cases, mocked
  Google JWKS and token endpoints, isolated D1),
  `apps/api/test/google-invite.test.ts` (6 cases), and
  `apps/web/app/components/learner-sign-in-google.test.tsx` (3 staging UI cases).
