# CertPath pilot sign-in recommendation

Status: **recommendation for architect and owner review; no provider selected**
Scope: documentation-only pilot planning. No provider, tenant, credentials,
routes, database changes, grant, deployment, or paid service has been configured.
Official documentation and public pricing checked: **11 November 2026**.

## Recommendation

Use **Auth0 Customer Identity (B2C)** as the first provider for an isolated
compatibility proof, subject to owner approval of its paid staff-MFA tier and
the unresolved market, residency, and session policies. This is a
recommendation to test Auth0, not approval to select it or begin production
implementation.

Auth0 is the better fit of the two candidates reviewed because its hosted
Universal Login supports email/password and Google, and its post-login Actions
can require an MFA challenge and report the completed method to a following
Action. A namespaced claim added by that Action can be signed into a short-lived
JWT for the Worker to validate before it creates a staff session. Cognito's
documented MFA setting applies to local user-pool users, not federated users;
it therefore does not, by itself, meet the mandatory-MFA requirement when a
Global Admin or Manager uses Google sign-in.

Keep the approved Cloudflare Workers + React Router SSR + same-origin Hono API
+ D1 architecture. Use a provider only to prove identity. The Worker maps the
exact `(issuer, subject)` to the internal user and continues to enforce roles,
Manager certification assignments, learner grants, and session state from D1.
Do not put application roles or entitlements in provider claims.

## Candidate comparison

| Requirement | Auth0 Customer Identity (B2C) | Amazon Cognito User Pools |
|---|---|---|
| Email registration and verification | Database connection supports email/password signup and email verification links; Auth0 sends verification by default. The application must deny access to flows requiring a verified address until `email_verified` is verified. | Self-signups must be confirmed before sign-in. Confirmation by code/link verifies the email or phone destination. |
| Google sign-in | Google social connection via OAuth 2.0 and Universal Login. Requires a Google OAuth client and Auth0 connection configuration. Request only the basic identity data needed. | Google is a supported federated provider. Cognito brokers the provider tokens and issues user-pool tokens. |
| Recovery | Auth0 database users can use the hosted email password-reset flow. Auth0 documents that a password reset expires the Auth0 session. Google-account recovery stays with Google. | Self-service recovery uses a verified channel. Configure recovery separately from MFA: the MFA delivery channel cannot also be used for Cognito forgot-password codes. Google credentials are recovered at Google. |
| Mandatory MFA for both staff roles | Can be required for a dedicated staff login client using a blocking post-login Action and an enabled factor. Keep role authorization in D1; the staff login path is not a role grant. Auth0's B2C Essentials plan is the lowest published B2C plan listing Pro MFA. | `MfaConfiguration=ON` can require MFA for local users, but Cognito explicitly states that it does not add MFA for federated users. An upstream Google MFA prompt is not a Cognito assurance guarantee. Cognito would need a separate, application-enforced staff factor for Google staff. |
| Worker-verifiable MFA evidence | The post-login Action event exposes completed authentication methods. After the required challenge, a following Action can require an `mfa` method and place a namespaced MFA time/method claim in the signed access token. The Worker must validate signature, issuer, audience and time, and reject missing/unsupported evidence. This exact mapping and freshness behavior still requires the sandbox proof. | Cognito's ID-token documentation now describes computed `acr`/`amr` authentication-strength claims, but availability is gradually rolling out and requesting levels requires Essentials or Plus. Do not depend on these claims before verifying the target pool; they also do not remove the federated-user MFA gap. |
| Cloudflare Workers compatibility | Standards-based OIDC/OAuth over Fetch and JWT verification with Web Crypto are compatible in principle. Official documentation reviewed does not establish that an Auth0 Node SDK is compatible with Workers. Prefer a small standards-based callback/JWKS proof; use no Node-only APIs in the Worker. | User-pool OIDC endpoints and JWTs are protocol-compatible in principle; this review did not establish AWS SDK or Cognito-specific library compatibility in Workers. The same Fetch/Web Crypto proof is required. |
| Logout and revocation | Auth0 refresh-token revocation affects provider tokens, not an independently issued CertPath D1 session. Provider logout or password reset must not be assumed to delete the opaque application session. | Cognito can revoke tokens or globally sign out a user, but its JWTs are self-contained and a local signature/expiry-only check can still accept a revoked token. Cognito revocation does not delete a CertPath D1 session. |
| Pilot cost and published limits | Free lists up to 25,000 MAUs but does not list the needed Pro MFA feature. B2C Essentials starts at **$35/month for 500 MAUs** and lists Pro MFA. This is the likely minimum Auth0 subscription for the proposed staff-MFA proof, not a quote. Higher MAU tiers cost more. | Essentials currently includes 10,000 free direct/social MAUs, then the pricing page's example uses **$0.015 per additional MAU**. SMS MFA uses SNS pricing; verification and recovery email use SES pricing. Pool tier and regional pricing must be checked for the actual account. |

### Auth0 MFA evidence shape to prove

The proposed staff path uses a separate Auth0 application/client ID, shared
only with the approved staff flow. A blocking post-login Action challenges
logins through that client; a subsequent Action checks the provider's
`event.authentication.methods` for a completed MFA method and adds a
namespaced claim such as `https://<owned-namespace>/mfa` plus provider-issued
assurance time and factor. The claim is not an application role and is not
accepted from the browser separately from the verified signed token.

At callback, the Worker validates the access token using the configured
issuer's JWKS and strict algorithm, issuer, API audience, expiry and not-before
checks. It accepts a staff session only if the expected MFA claim and approved
freshness policy pass; it then stores the verified MFA time/method in the
server-owned D1 session. A staff account that authenticates through the learner
client without MFA evidence must be directed to the staff flow, not granted a
staff session. Public registration, Google email verification, and provider
metadata never create either staff role.

This is a proof target, not a claim that the Action configuration or assurance
freshness is already implemented. Auth0 Actions document how to challenge and
observe methods, and how to add custom token claims; the sandbox must establish
that this yields a Worker-verifiable, adequately fresh assertion for both
Global Admin and Manager sign-ins, including Google federation and an existing
provider SSO session.

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

Only start after the owner approves a capped Auth0 Essentials sandbox spend
(or confirms an eligible plan that includes Pro MFA). Use a non-production
Auth0 tenant, a non-production Cloudflare Worker and isolated D1 database,
synthetic identities, and no real question content. Keep secrets in local
secret bindings or the sandbox's secret store, never in the repository. Do not
connect production users or execute the initial Global Admin bootstrap.

1. **Worker callback and token verification:** run the OAuth authorization-code
   flow with PKCE, state, and nonce through the actual Worker. Fetch the
   provider metadata/JWKS with Worker `fetch`, validate an Auth0-issued token
   with Worker Web Crypto, and reject bad state/nonce, wrong issuer/audience,
   expired tokens, bad signatures, replay, and missing MFA evidence.
2. **Email learner flow:** register a synthetic email/password learner, verify
   the email, sign in, request recovery, complete password reset, and confirm
   the new credential works. Confirm an unverified email cannot be used as an
   account-linking key and reset does not silently merge accounts.
3. **Google learner flow:** use an isolated Google OAuth client and test
   accounts. Sign in with Google and verify the provider's issuer, subject, and
   verified-email assertion. Confirm a matching email never auto-links to a
   different internal user.
4. **Both staff MFA paths:** issue two synthetic internal staff identities
   through test-only D1 fixtures: one Global Admin and one Manager with one
   exam assignment. Exercise password and Google sign-in through the staff
   client. Confirm both are challenged with an enrolled independent factor;
   omitting/canceling MFA, using an unenrolled factor, signing in through the
   learner client, or presenting a forged/missing/stale claim creates no staff
   session. Confirm the verified factor/time is stored in D1 and each role is
   authorized only by its D1 row and current assignment.
5. **Application and provider revocation:** prove application logout revokes
   the D1 session on the next protected request, even with an otherwise valid
   provider token. Separately revoke the provider token/end the provider
   session and observe whether an existing opaque D1 session remains valid;
   document that result and test the proposed session lifetime/revalidation
   behavior. Do not count provider logout alone as D1 revocation.
6. **Learner's first exam and dashboard:** create a verified synthetic learner
   through either supported sign-in method. Verify signup grants no staff role
   and no exam access. Use an explicitly approved pilot operator procedure to
   issue that internal user an audited, exam-specific Standard grant for the
   owner-selected first exam; then sign in and reach the protected `/app/home`
   dashboard. Verify the granted exam appears and another exam remains denied.
   The test grant is synthetic and is not a payment or a production access
   grant.

The proof passes only when both provider routes complete in the deployed
Worker runtime, the staff factor is enforced for each staff role and supported
login method, the Worker accepts only signed and fresh MFA evidence, D1 remains
the authority for roles/assignments/grants, and logout/revocation behavior is
recorded without assuming provider and application sessions are coupled.

## Pilot learner access path

1. A pilot learner registers with email/password and verifies email, or signs
   in with Google. The Worker resolves the provider `(issuer, subject)` to an
   internal user; a new account is a learner only.
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

- **Provider and spending:** approve or reject Auth0 as the proof candidate;
  approve a maximum monthly sandbox cost and expected MAU range. Confirm the
  paid Pro MFA requirement, email delivery configuration/cost, SMS or other
  factor charges, support/tax/region costs, and upgrade threshold before
  creating a paid tenant.
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
  deliverability, support procedure, and Google consent-screen requirements.
- **Initial administrator:** approve the first Global Admin identity and
  operator/bootstrap process separately. The sandbox proof must not perform
  production provisioning.

## Decision status and next gate

This recommendation refines the provider comparison in
[ADR 0002](decisions/0002-identity-and-content-architecture.md) and the
[Milestone 2A handoff](reviews/milestone-2a.md), but does not change either
document's status. Auth0 remains a candidate recommendation only. Architect
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
- [Verify emails](https://auth0.com/docs/manage-users/user-accounts/verify-emails) — database email verification.
- [Add Google login](https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/google) — Google OAuth connection requirements.
- [Change users' passwords](https://auth0.com/docs/authenticate/database-connections/password-change) — password recovery and Auth0 session expiry.
- [Revoke refresh tokens](https://auth0.com/docs/secure/tokens/refresh-tokens/revoke-refresh-tokens) — provider refresh-token revocation behavior.
- [Authorization Code Flow with PKCE](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow-with-pkce) — browser authorization flow.

### Amazon Cognito

- [Cognito pricing](https://aws.amazon.com/cognito/pricing/) — current Essentials MAU tiers and separately billed SNS/SES messages.
- [Adding MFA to a user pool](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa.html) — required local-user MFA and explicit federated-user limitation.
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
