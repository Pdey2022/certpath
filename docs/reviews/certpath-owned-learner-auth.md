# CertPath-owned learner authentication: local proof

## Result

The local Worker/D1 proof implements email-only learner registration, email
verification with password selection, email/password sign-in, password
recovery/reset, and sign-out. It uses only
synthetic `@example.test` identities and an in-memory local test inbox. No
cloud resources, live identity-provider endpoints, real accounts, or email
delivery were used. The feature remains disabled unless explicitly enabled
with local-only bindings.

## Implementation and architecture decisions

- Used `@noble/hashes` 2.0.1's asynchronous, pure-JavaScript scrypt rather than
  the initial WebAssembly-backed candidate: dynamic WebAssembly compilation is
  unavailable in the Cloudflare Worker test runtime. The chosen implementation
  was exercised in the actual local Worker/D1 test harness.
- Password hashes use scrypt `N=32768`, `r=8`, `p=1`, a 16-byte random salt,
  32-byte derived key, and a 64 MiB configured maximum memory. The encoded
  PHC-style value records the algorithm parameters and salt. These settings are
  compatibility evidence, not an approved production policy or performance
  benchmark.
- Verification and reset tokens are single-use, expiring values. D1 stores
  only their SHA-256 digests; rate-limit buckets use HMAC digests. The local
  inbox holds synthetic email links in memory and is available only when its
  local test binding is enabled.
- Registration creates a learner without staff roles or exam grants. The
  learner chooses a password after opening the verification link. A single
  atomic D1 batch consumes the single-use token, installs the salted password
  hash, marks email verified, creates the issuer/subject identity mapping, and
  audits verification. Repeated registration accepts no password and cannot
  alter an existing credential; matching email addresses never link accounts.
  Existing D1 session, role, and grant authorization remains authoritative.
- Password reset revokes the learner's active CertPath sessions. Sign-out uses
  the existing CSRF-protected session revocation flow.
- Local authentication refuses to enable on a non-loopback origin. The local
  UI exposes registration, verification, recovery/reset, and the synthetic
  inbox; real email delivery and cloud configuration are not included.

The identity architecture decision now records CertPath-owned learner
authentication as the direction under local test, not an approved production
provider or rollout decision.

## Files changed

- API and storage: `apps/api/src/index.ts`,
  `apps/api/src/local-learner-auth.ts`,
  `apps/api/src/local-test-mail.ts`,
  `apps/api/src/security/password-hashing.ts`,
  `apps/api/test/local-learner-auth.test.ts`,
  `apps/api/test/schema.test.ts`,
  `db/migrations/0008_local_learner_auth.sql`,
  `db/migrations/0009_defer_learner_password_until_verification.sql`.
- Web flow and contracts: `apps/web/app/components/learner-dashboard.test.tsx`,
  `apps/web/app/components/learner-email-actions.tsx`,
  `apps/web/app/components/learner-sign-in.test.tsx`,
  `apps/web/app/components/public-layout.tsx`,
  `apps/web/app/lib/learner-auth-api.ts`,
  `apps/web/app/lib/learner-practice-api.ts`,
  `apps/web/app/routes.ts`,
  `apps/web/app/routes/learner-password-recovery.tsx`,
  `apps/web/app/routes/learner-password-reset.tsx`,
  `apps/web/app/routes/learner-sign-in.tsx`,
  `apps/web/app/routes/learner-verify-email.tsx`,
  `apps/web/app/routes/local-inbox.tsx`,
  `apps/web/.dev.vars.example`,
  `packages/contracts/src/index.ts`,
  `packages/contracts/src/learner-auth.ts`.
- Dependency and guidance: `apps/api/package.json`, `package-lock.json`,
  `README.md`, `docs/decisions/0002-identity-and-content-architecture.md`.
- Review evidence: `docs/reviews/certpath-owned-learner-auth.md`.

## Verification

All commands ran locally on Windows in the feature worktree.

| Command | Result |
|---|---|
| `npx vitest run --config vitest.config.ts test\local-learner-auth.test.ts test\schema.test.ts` (from `apps\api`) | Passed: 2 files and 13 tests covering email-only registration, password selection during verification, password reset, session revocation, logout, and schema constraints. |
| `npx tsx --test app\components\learner-sign-in.test.tsx app\components\learner-dashboard.test.tsx` (from `apps\web`) | Passed: 8 tests, including email-only registration, password selection at verification, and CSRF-protected sign-out. |
| `npm run verify` | Passed: workspace type checks, including Wrangler and React Router type generation; API health test passed; 12 API Vitest files and 92 tests passed; web suite passed all 64 tests; production client and Worker SSR builds completed. |
| `git diff --check` | Passed: no whitespace errors. |

The local Worker/D1 tests include the scrypt runtime compatibility check,
verified and unverified sign-in, password reset and revocation, sign-out,
single-use/expired action links, duplicate registration, and a regression
proving a pre-verification password is rejected, not stored, and cannot
replace the password chosen during verification. They also cover rate limits,
staff authorization denial, and exam-grant access boundaries.

## Known limitations and unresolved decisions

- This is a local proof only. Live email delivery, verification and reset
  deliverability, domain reputation, provider choice, cloud provisioning, and
  deployment are untested and out of scope.
- Production password policy and scrypt cost/memory tuning, concurrency,
  monitoring, abuse limits, recovery support, incident handling, session
  lifetime, CSRF, revocation operations, retention/deletion, and migration or
  recovery of existing identities need owner and architect review.
- Global Admin and Manager authentication is not implemented by this flow.
  Password-only learner sessions cannot receive staff roles or authorize staff
  routes. Staff MFA still requires separate Worker-verifiable evidence of a
  recent completed authenticator-app challenge and an approved freshness and
  failure policy.
- Local test mail and the accepted `@example.test` addresses are not production
  email infrastructure. Scrypt compatibility in Workerd does not establish
  production throughput or security certification.
- The merged Cognito foundation remains disabled and unchanged. PRs #15 and
  #17 and the staff MFA sandbox remain separate and parked; Google sign-in and
  production rollout were not started.

## Architect inspection and run steps

1. Inspect the migration, Worker routes, password hashing module, and local
   Worker/D1 tests listed above.
2. From the repository root, run `npm ci`.
3. Copy `apps/web/.dev.vars.example` to `apps/web/.dev.vars`. Replace the two
   placeholder secrets with different random local-only values, confirm
   `PUBLIC_SITE_ORIGIN` matches Wrangler's local URL, and set
   `LOCAL_LEARNER_AUTH_ENABLED` and `LOCAL_TEST_MAIL_ENABLED` to `true`. Do not
   use these values in a deployment.
4. Run `npm run db:migrate:local`, then `npm run dev`. Register only synthetic
   `@example.test` addresses, and use `/local-inbox` to retrieve verification
   or reset links.
5. Run `npm run verify`. Do not configure cloud resources, live email, or
   deployment for this proof.

Production adoption remains pending architect and owner review.
