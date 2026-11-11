# CertPath pilot sign-in recommendation

Status: **recommendation for architect and owner review; no provider selected**
Scope: documentation-only pilot planning. No provider, tenant, credentials,
routes, database changes, grant, deployment, or paid service has been configured.
Official documentation and public pricing checked: **11 November 2026**.

## Recommendation

Use **Amazon Cognito User Pools Essentials** as the first candidate for a
non-production **email-and-password pilot sandbox**, subject to proving that
the target pool emits the required signed TOTP assurance claims. This is a
candidate recommendation, not approval to configure a provider or start
production sign-in.

The Cognito proof is intentionally limited to local email/password accounts;
defer Google federation. Cognito's Essentials plan enables requesting
authentication levels, and its documentation describes signed `acr`/`amr`
claims for completed factors, including password plus authenticator-app TOTP.
However, the claim feature is rolling out gradually and may not be available
in the target pool. The Worker must create no staff session unless it verifies
the ID token signature, expected client and login nonce, TOTP-level claims,
and a sufficiently fresh provider `auth_time`. If the target pool cannot
produce and maintain that evidence across the tested flows, record the gap
and use the retained Auth0 design below as the fallback recommendation.

Google sign-in is deferred from this sandbox. Cognito itself documents that
its pool MFA does not add a factor to federated sign-ins, so Google staff login
would require a separately proven assurance path. The Auth0 fallback preserves
the corrected design: a subsequent post-challenge Action places namespaced MFA
evidence in the staff ID token, which the Worker validates against the
expected client and exact transaction nonce.

Keep the approved Cloudflare Workers + React Router SSR + same-origin Hono API
+ D1 architecture. Use a provider only to prove identity. The Worker maps the
exact `(issuer, subject)` to the internal user and continues to enforce roles,
Manager certification assignments, learner grants, and session state from D1.
Do not put application roles or entitlements in provider claims.

## Candidate comparison

| Requirement | Amazon Cognito Essentials (recommended sandbox candidate) | Auth0 Customer Identity (fallback) |
|---|---|---|
| Email registration and verification | Local self-signups must be confirmed before sign-in; code/link confirmation verifies the destination. Require a verified email before using it as a contact or recovery address. | Database connection supports email/password signup and email verification links; the application must enforce verified-email requirements. |
| Google sign-in | **Deferred** for this email/password sandbox. Cognito supports Google federation, but its pool MFA does not add MFA for federated users; do not extend the staff flow to Google without a separate assurance proof. | Auth0 can add Google OAuth through Universal Login. Google sign-in remains out of this pilot slice. |
| Recovery | Self-service recovery uses a verified channel. If TOTP is the MFA factor, verify that the pool has a separate recovery channel; Cognito does not send MFA and password-reset codes to the same email/phone destination. | Database users can use Auth0's hosted email password-reset flow; Auth0 documents that a password reset expires the Auth0 session. |
| Mandatory MFA for both staff roles | Configure pool MFA as required and TOTP as the only enabled MFA factor for the proof. A first sign-in may return tokens without an authenticator challenge; it must not create a CertPath staff session. Complete Cognito's TOTP enrollment, then require a later sign-in to prove the TOTP challenge. | A dedicated staff flow can require an enabled factor through a blocking post-login Action. Keep role authorization in D1; login is not a role grant. Auth0 B2C Essentials is the lowest published B2C plan listing Pro MFA. |
| Worker-verifiable MFA evidence | Cognito documents `acr`/`amr` claims, including level 4 (`urn:cognito:loa:4`) for password plus authenticator-app TOTP and `amr` values `pwd`, `otp`, and `mfa`. Request the target level with `acr_values` and freshness with `max_age`; check `auth_time` in the signed ID token. Claim availability is rolling out and requires Essentials or Plus. Verify actual availability and semantics in the target pool; absence or mismatch fails closed. Refresh preserves `acr`/`amr` and does not reset `auth_time`. | The corrected fallback uses two client IDs and a transaction-bound nonce. A subsequent Auth0 Action after the required challenge checks the provider-recorded method and timestamp and writes namespaced evidence to the staff ID token. The Worker validates signature, issuer, expected client, nonce, and freshness. |
| Cloudflare Workers compatibility | Cognito OIDC endpoints and signed JWTs are compatible in principle with Worker Fetch and Web Crypto. The exact callback, JWKS validation, claims, and flow still require an actual Worker proof; do not assume AWS SDK compatibility. | Standards-based OIDC and JWT verification are compatible in principle. Official documentation does not establish Auth0 Node SDK compatibility with Workers; prefer the standards-based callback/JWKS proof and no Node-only APIs. |
| Logout and revocation | Cognito token revocation does not revoke an independently issued CertPath D1 session. Self-contained JWTs can still pass local signature/expiry-only validation after revocation; application logout must revoke D1. | Auth0 refresh-token revocation does not revoke an independently issued CertPath D1 session. Provider logout or password reset must not be assumed to revoke it. |
| Pilot cost and published limits | Cognito Essentials pricing currently includes **10,000 direct/social MAUs** then **$0.015 per additional MAU** in AWS's published example. Cognito registration, verification, and recovery email are billed separately through SES. SES Essentials currently lists **$0.16 per 1,000 outbound emails** for the first 10 million monthly emails, with marginal volume rates above that. Verify region/account configuration and actual charges before approval. TOTP avoids SMS MFA delivery charges. | Auth0 Free lists up to 25,000 MAUs but does not list the needed Pro MFA feature. B2C Essentials starts at **$35/month for 500 MAUs** and lists Pro MFA; higher tiers, email delivery, taxes, and support may add cost. Reconfirm current terms before a fallback tenant. |

### Retained Auth0 fallback design

Use separate Auth0 application/client IDs for learner and staff login
transactions. The Worker validates the OIDC ID token against the configured
issuer's JWKS and allowed signing algorithm, the expected client ID for the
flow (`aud`), expiry and not-before claims, and the exact `nonce` saved with
that login transaction. Reject a learner-client ID token on the staff callback
even when its signature and identity are otherwise valid. Do not accept an
ID token as an API access token or infer a client from browser input.

For staff login, a blocking post-login Action requires an MFA challenge. A
subsequent Action, which runs after the challenge, checks the provider-recorded
`event.authentication.methods` for the completed MFA factor and its timestamp,
then writes those values to namespaced claims in the **staff ID token** using
the ID-token claim API. The Worker accepts staff authentication only when the
signed claims show a supported provider-recorded factor and a timestamp within
the approved freshness window. It stores the verified time and method in the
server-owned D1 session. Missing, unsupported, or stale evidence fails closed.
The claim is not an application role and is never trusted outside the verified
ID token.

A staff account that authenticates through the learner client cannot create a
staff session, even if the account has a staff row in D1; it must complete the
staff-client flow with current MFA evidence. Public registration, Google email
verification, and provider metadata never create either staff role.

This is the fallback proof design, not a claim that the Action configuration or
assurance freshness is already implemented. If Cognito cannot prove the
required evidence in the target pool, the fallback sandbox must establish that
the Action reports the actual completed factor and its provider-recorded
timestamp in a Worker-verifiable ID token for both Global Admin and Manager.
If Google federation is considered later, include Google with an existing
provider SSO session; it is deferred from the Cognito email/password sandbox.
An existing SSO session must not silently bypass the required fresh staff
factor.

### Session boundary

CertPath must create a cryptographically random opaque session cookie only
after callback verification and D1 identity resolution. Store only its digest
and server-owned state in D1. On application logout, revoke that D1 session
first and clear the cookie; a provider logout redirect may then end the
provider's browser SSO session. Do not retain a provider JWT as the long-lived
application session.

An out-of-band provider logout, refresh-token revocation, password reset,
suspension, or compromise does **not** automatically revoke the independent
D1 session. CertPath needs an approved mechanism for provider-originated
lifecycle invalidation and/or bounded status revalidation, plus separate
maximum stale-assurance windows for staff and learners. Until verified and
approved, do not claim immediate remote revocation: bound D1 session lifetime,
fail closed when required checks cannot be made, and revoke D1 sessions
immediately for CertPath-controlled logout, role removal, assignment removal,
or compromise handling. Provider event coverage, ordering, replay, and outage
behavior remain unproven for both candidates.

## Smallest sandbox proof and acceptance checks

Only start after the owner approves a capped Cognito Essentials sandbox spend
and a staff-assurance freshness threshold. Use a non-production Cognito user
pool, a non-production Cloudflare Worker and isolated D1 database, synthetic
identities, and no real question content. Keep secrets in local secret
bindings or the sandbox's secret store, never in the repository. Do not
connect production users or execute the initial Global Admin bootstrap.

1. **Worker callback and ID-token verification:** run Cognito's OIDC
   authorization-code flow with PKCE, state, and nonce through the actual
   Worker. Use distinct expected staff and learner app-client IDs, with the
   expected client and nonce bound to the server-side login transaction. Fetch
   provider metadata/JWKS with Worker `fetch`; validate the ID token with Worker
   Web Crypto, checking signature, issuer, `token_use=id`, expiry/not-before,
   expected `aud`, and exact transaction nonce. Reject bad state, wrong nonce,
   wrong issuer/audience, expired tokens, bad signatures, replay, and tokens
   for the other client.
2. **Target-pool claim availability:** configure an Essentials user pool with
   required MFA and authenticator-app TOTP. Request
   `acr_values=urn:cognito:loa:4` and `max_age` for the owner-approved
   freshness threshold. Verify that the actual signed ID token contains the
   expected `acr`, the required `amr` values (`pwd`, `otp`, and `mfa`), and a
   current `auth_time`. Confirm those claims are available and mean a
   completed TOTP challenge in this pool and app client. The documentation
   describes a gradual rollout; missing or ambiguous claims fail the proof.
3. **First sign-in and TOTP enrollment:** for synthetic Global Admin and
   Manager accounts, verify email and complete first sign-in. Cognito may
   issue tokens before TOTP enrollment; those tokens and the enrollment flow
   must not create a CertPath staff session. Complete TOTP enrollment using
   Cognito's setup flow, then perform a subsequent sign-in and verify that the
   Worker accepts only a fresh token with the required signed evidence.
4. **Returning staff and existing SSO:** test both roles as returning users
   with TOTP already enrolled. Complete a fresh authenticator challenge and
   verify that the Worker accepts the evidence. Repeat with an existing
   Cognito managed-login SSO session; request the required authentication
   level and freshness. If the session does not result in signed, current
   TOTP evidence, reject it and create no staff session.
5. **Missing and stale evidence:** for both staff roles, verify that a
   learner-client ID token, wrong nonce, absent or wrong `acr`, absent `otp`
   or `mfa` in `amr`, invalid signature, and missing or stale `auth_time`
   cannot create a staff session. Reuse a refreshed token and prove that its
   preserved `auth_time` does not reset freshness. A successful password-only
   or first-enrollment response is never sufficient. Keep D1 role and
   Manager-assignment authorization authoritative.
6. **Email learner flow:** register a synthetic email/password learner,
   verify the email, sign in, request recovery, complete password reset, and
   confirm the new credential works. Confirm an unverified email cannot be
   used as an account-linking key and reset does not silently merge accounts.
   Verify that email delivery uses the approved SES configuration and record
   the actual sandbox message cost.
7. **Application and provider revocation:** prove application logout revokes
   the D1 session on the next protected request, even with an otherwise valid
   provider token. Separately revoke the provider token/end the provider
   session and observe whether an existing opaque D1 session remains valid;
   document that result and test the proposed session lifetime/revalidation
   behavior. Do not count provider logout alone as D1 revocation.
8. **Learner's first exam and dashboard:** create a verified synthetic learner
   with email/password only. Verify signup grants no staff role and no exam
   access. Use an explicitly approved pilot operator procedure to issue that
   internal user an audited, exam-specific Standard grant for the owner-
   selected first exam; then sign in and reach the protected `/app/home`
   dashboard. Verify the granted exam appears and another exam remains denied.
   The test grant is synthetic and is not a payment or a production access
   grant.

The proof passes only when the Cognito flow works in the deployed Worker
runtime; staff and learner ID tokens are accepted only for their expected
client and exact transaction nonce; and both staff roles, including returning
staff with an existing SSO session, produce fresh, signed evidence of the
completed authenticator-app challenge. The target pool must expose the
documented assurance claims and their semantics must be verified, not
assumed. Learner-client tokens, wrong nonces, and missing, incorrect, or stale
MFA evidence must not create staff sessions. If Cognito cannot provide that
evidence, record the precise gap and recommend the corrected Auth0 fallback;
do not weaken staff MFA or create a session as a workaround. Google sign-in is
not part of this proof. D1 remains authoritative for roles, assignments,
grants, and opaque sessions; logout/revocation behavior is recorded without
assuming provider and application sessions are coupled.

## Pilot learner access path

1. A pilot learner registers with email/password and verifies email. The
   Worker resolves the Cognito `(issuer, subject)` to an internal user; a new
   account is a learner only.
2. A named, authorized Global Admin (not a Manager) issues an audited,
   time-bounded Standard grant for the selected certification and exam version
   using the approved pilot access process. The grant is independent of
   authentication and payment; this recommendation does not add an invite,
   grant, or billing workflow.
3. The learner signs in through the same provider, receives an opaque D1
   session, and opens `/app/home`. The dashboard and all exam endpoints
   independently check the current session, ownership, and exact-exam grant.
   No grant or another exam's access is inferred from email, Google identity,
   a URL parameter, or a provider claim.

There is no production grant-management UI or provider-backed login in this
slice. Until a separately reviewed grant workflow exists, sandbox access is
seeded only by an isolated test fixture; any real pilot procedure requires
owner approval and a named Global Admin operator.

## Owner and architect decisions still required

- **Provider and spending:** approve or reject Cognito Essentials as the
  email/password sandbox candidate; approve a maximum monthly cost and
  expected MAU range. Confirm regional MAU pricing, SES email configuration
  and cost, recovery options, and any support/tax/region costs before
  creating a pool. If Cognito fails the evidence proof, separately approve
  the Auth0 fallback and its paid Pro MFA requirement before creating a
  tenant.
- **Pilot admissions:** choose invitation-only versus learner self-registration,
  who may invite learners, whether a verified email invitation is required,
  and how duplicate or inaccessible accounts are recovered. Never use
  same-email automatic linking.
- **Pilot access authority:** name the Global Admin(s) who can issue and
  revoke pilot access and approve the audited operator process. Managers
  cannot issue or revoke grants. Select the first certification/exam version,
  Standard duration (3, 6, or 12 calendar months), start/expiry semantics, and
  revocation reasons. Do not treat synthetic CISSP/CISM demo content as an
  approved pilot exam.
- **MFA policy:** approve staff factors and recovery options, MFA freshness and
  step-up intervals for each sensitive action, and whether learners may be
  offered or required to enroll in MFA. Do not weaken the existing requirement
  that both staff roles always have server-verified MFA.
- **Sessions and remote revocation:** approve D1 session lifetimes, staff and
  learner stale-assurance windows, provider status/event invalidation
  mechanism, and outage behavior. Provider logout must not be represented as
  application-session revocation.
- **Market, privacy, and operations:** confirm launch country, acceptable
  provider/data regions, data retention and processor terms, email sender and
  deliverability, support procedure, and whether/when Google sign-in should
  be evaluated in a separate slice.
- **Initial administrator:** approve the first Global Admin identity and
  operator/bootstrap process separately. The sandbox proof must not perform
  production provisioning.

## Decision status and next gate

This recommendation refines the provider comparison in
[ADR 0002](decisions/0002-identity-and-content-architecture.md) and the
[Milestone 2A handoff](reviews/milestone-2a.md), but does not change either
document's status. Cognito Essentials is a candidate recommendation only;
Auth0 remains the documented fallback, not an approved provider. Architect
and owner approval is required before configuring a tenant or beginning
provider-backed implementation. Provider setup, live session issuance,
production MFA, grant management, billing, and deployment remain outside this
documentation-only change.

## Official sources

Checked 11 November 2026. Provider prices and feature gates are point-in-time
public documentation, not a quote or contractual residency statement.

### Auth0

- [Auth0 pricing](https://auth0.com/pricing) — B2C MAU tiers and Pro MFA plan feature.
- [Enable MFA](https://auth0.com/docs/secure/multi-factor-authentication/enable-mfa) — factors and tenant MFA policies.
- [Customize MFA selection with Universal Login Actions](https://auth0.com/docs/secure/multi-factor-authentication/customize-mfa/customize-mfa-selection-universal-login) — contextual challenges and `event.authentication.methods`.
- [Post-login Action event object](https://auth0.com/docs/actions/reference/post-login/post-login-event-object) — authentication signals exposed to Actions.
- [Post-login Action API object](https://auth0.com/docs/actions/reference/post-login/post-login-api-object) — challenge, deny, and token-claim operations.
- [Create custom token claims](https://auth0.com/docs/secure/tokens/json-web-tokens/create-custom-claims) — namespaced claims in signed tokens.
- [Validate JSON Web Tokens](https://auth0.com/docs/secure/tokens/json-web-tokens/validate-json-web-tokens) — signature, issuer/JWKS, and claim validation.
- [Validate ID Tokens](https://auth0.com/docs/secure/tokens/id-tokens/validate-id-tokens) — ID-token audience and exact nonce validation.
- [Post-login ID-token claim API](https://auth0.com/docs/actions/reference/post-login/post-login-api-object) — `api.idToken.setCustomClaim`.
- [Verify emails](https://auth0.com/docs/manage-users/user-accounts/verify-emails) — database email verification.
- [Add Google login](https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/google) — Google OAuth connection requirements.
- [Change users' passwords](https://auth0.com/docs/authenticate/database-connections/password-change) — password recovery and Auth0 session expiry.
- [Revoke refresh tokens](https://auth0.com/docs/secure/tokens/refresh-tokens/revoke-refresh-tokens) — provider refresh-token revocation behavior.
- [Authorization Code Flow with PKCE](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow-with-pkce) — browser authorization flow.

### Amazon Cognito

- [Cognito pricing](https://aws.amazon.com/cognito/pricing/) — current Essentials MAU tiers and separately billed message delivery.
- [Amazon SES pricing](https://aws.amazon.com/ses/pricing/) — outbound email pricing by volume and configuration.
- [Adding MFA to a user pool](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa.html) — required local-user MFA and explicit federated-user limitation.
- [TOTP software tokens](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa-totp.html) — authenticator-app enrollment and TOTP MFA flow.
- [Step-up authentication](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-step-up-authentication.html) — requesting authentication levels, `acr`/`amr`, `auth_time`, and refresh behavior.
- [Verifying user-pool JWTs](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html) — signature, issuer, audience, and token-use validation.
- [Signing up and confirming users](https://docs.aws.amazon.com/cognito/latest/developerguide/signing-up-users-in-your-app.html) — signup confirmation and email/phone verification.
- [Account recovery and password policies](https://docs.aws.amazon.com/cognito/latest/developerguide/managing-users-passwords.html) — recovery channels and policy.
- [Google and other federated providers](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-identity-federation.html) — user-pool federation.
- [ID token claims and authentication strength](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-id-token.html) — `acr`/`amr` claim rollout and Essentials/Plus gate.
- [Ending sessions with token revocation](https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html) — refresh-token revocation and local-JWT caveat.

### Cloudflare

- [Workers Web Crypto API](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) — runtime cryptographic operations.
- [Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/) — outbound HTTPS requests from a Worker.
- [Cloudflare D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/) — Worker-side D1 operations.

### Existing CertPath decisions

- [Product design](product-design.md) — staff roles, verification, and access constraints.
- [Build plan](build-plan.md) — provider selection and compatibility proof remain gated.
- [Open decisions](open-decisions.md) — provider, market, residency, session, and MFA decisions.
- [ADR 0002](decisions/0002-identity-and-content-architecture.md) — existing comparison and security architecture.
- [Milestone 2A handoff](reviews/milestone-2a.md) — previous evaluation and unresolved decisions.
