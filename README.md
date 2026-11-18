# CertPath foundation

This repository contains the CertPath prototype and the first protected
untimed learner-practice slice. The public site is server-rendered with React
Router on Cloudflare Workers. A Hono API is mounted at the same-origin `/api`
path in that Worker; D1 holds server-side attempt snapshots and answers.
Provider-backed sign-in, production access-grant issuance, payments, and
production provisioning are not implemented.

## Requirements

- Node.js 22.22 or newer
- npm 10 or newer

## Local development

From the repository root:

```powershell
npm ci
npm run db:migrate:local
npm run dev
```

The local Worker is available at the URL printed by Wrangler (normally
`http://localhost:5173`). Public routes return HTML from the Worker without
requiring browser JavaScript. The `/app` workspace and `/app/practice` remain
synthetic, browser-only previews and do not authorize any action.
`/app/practice/live` is a separate protected route; it requires an opaque
application-session cookie and a current D1 Standard grant. The CertPath-owned
authentication proof below can issue sessions only for synthetic local
learners; it does not issue grants and is disabled by default. API/D1 tests use
isolated synthetic fixtures only. Protected practice content is never written
to browser storage.

### Local learner-auth proof

The CertPath-owned email/password flow is a local-only proof, not a production
sign-in option. Registration starts with an email address only. The learner
chooses a password when completing email verification; token consumption and
password activation happen in one atomic D1 batch. To try it, copy
`apps/web/.dev.vars.example` to
`apps/web/.dev.vars`, replace both placeholder values with different random
local-only secrets, confirm `PUBLIC_SITE_ORIGIN` matches the local URL Wrangler
prints, then set `LOCAL_LEARNER_AUTH_ENABLED` and `LOCAL_TEST_MAIL_ENABLED` to
`true`. Apply local migrations and start the Worker as above. Use only
synthetic email addresses ending in `@example.test`; verification and reset
links appear in `/local-inbox` and are held in Worker memory. No real email is
sent, and no credentials, cloud resources, or deployment settings are used.
Keep these flags disabled in any deployment configuration.

### Invite-only email sign-in links (local proof)

Email-link sign-in is the second local-only proof. No account is created here:
only an address that an operator has pre-provisioned for an existing learner
account can receive a link. Links live for 15 minutes, are stored as SHA-256
digests only, and are single use. Opening a link shows a confirmation page and
does not spend it, so mail scanners cannot consume it; confirming redeems the
link atomically and creates the normal opaque session cookie.

Provision a synthetic learner (local D1 only; the helper cannot target a remote
database):

```powershell
node apps/api/scripts/provision-learner-sign-in-invite.mjs --email learner@example.test
```

Then set the flags below in `apps/web/.dev.vars` and restart `npm run dev`:

```
LOCAL_LEARNER_EMAIL_LINK_ENABLED=true
LOCAL_TEST_MAIL_ENABLED=true
```

Request a link at `/sign-in`, open `/local-inbox` with the same address, follow
the link to `/sign-in/link`, and confirm. `--user-id <uuid>` attaches the invite
to an existing account and re-provisions a revoked invite; `--revoke` retires
one. Messages stay in Worker memory, so a restart clears the inbox. No email
provider, DNS record, or outbound request is involved, and the pilot does not
issue exam grants: `/app/home` only lists exams that already have an active
Standard grant. The protected practice API requires an `https:` origin, so the
full dashboard journey is covered by the Worker/D1 tests rather than the
plain-`http` dev server. Google OAuth setup is paused.

## Tester-only admin panel (local)

The real admin pages (`/admin/question-editor` and the protected content API)
sit behind a client-IP tester allowlist and individual staff sign-in. Nothing is
deployed and no production account exists.

Provision the two test Global Admins and the exam-scoped Manager locally. All
three accounts are created together with one synthetic certification and its
exam version, and passwords are typed at a hidden prompt:

```powershell
npm run db:migrate:local
npm run staff:provision -- --admins "owner@example.test,deputy@example.test" --manager editor@example.test --certification-slug synthetic-pilot
```

Then add these values to `apps/web/.dev.vars` and restart `npm run dev`:

```
STAFF_MFA_MAX_AGE_MS=28800000
STAFF_MFA_ALLOWED_METHODS=totp
STAFF_MFA_SEAL_KEY=REPLACE_WITH_A_LOCAL_VALUE_OF_AT_LEAST_32_CHARACTERS
STAFF_RATE_LIMIT_HMAC_SECRET=REPLACE_WITH_A_DIFFERENT_RANDOM_LOCAL_VALUE
ADMIN_TESTER_IPS=127.0.0.1,::1,localhost
ADMIN_TESTER_LOCAL=true
```

Open `/admin/sign-in` and sign in with one of the provisioned accounts. The
password only creates the session: the panel sends you to `/admin/mfa/verify`,
and the session carries no assurance until a TOTP code from an enrolled
authenticator upgrades it. Enrol at `/admin/mfa/enrol` with the enrolment ticket
the provisioning script printed beside that account's password — a password alone
cannot create a factor. Ten one-time recovery codes are shown once at enrolment.

An empty `ADMIN_TESTER_IPS` closes every admin page and API with `503`, even for
a fully verified session; that is the rollback switch, and it is defence in depth
rather than an assurance. The retired `tester-gate` label is refused by both the
configuration and the `0023` triggers. If `STAFF_MFA_SEAL_KEY` is missing or
shorter than 32 characters every MFA route answers `503` rather than storing a
seed in clear. Passwords and tickets are never logged, and no secret is stored
outside the local database. See
[the 5F design record](docs/5f-staff-second-factor.md) and
[the tester access review](docs/reviews/admin-tester-access.md) for the Workers
Free capacity finding and rollback steps.

## Verification

```powershell
npm run verify
```

This runs the D1 isolation gate, workspace type checks, tests, the fresh
migration chain check, and a production build. To inspect the
running HTML and API manually, start `npm run dev` and request `/`, `/exams`,
`/robots.txt`, `/sitemap.xml`, `/app`, `/app/practice/live`, `/admin`, and
`/api/health`. Private
previews carry `noindex` and `private, no-store`; local robots configuration
disallows crawling. See [Milestone 1 review](docs/reviews/milestone-1.md) for
prototype limitations, screenshots, verification, and inspection steps.

### D1 data safety

```powershell
npm run check:isolation          # preview binds no D1; no shared database name or id
npm run db:chain                 # 0001..0020 in order, second apply a no-op, checksums
npm run db:export -- --target local --out D:\certpath-exports
npm run db:rehearse -- --file D:\certpath-exports\<dump>.sql
```

Exports carry a sidecar manifest (schema version, target, hashes, per-table
counts, migration ledger) and the rehearsal loads a dump into a throwaway
database to prove it still matches. Dumps go outside the repository by default
and are never committed. See
[data export and restore](docs/data-export-and-restore.md) for exit codes, the
manifest fields, the retention rule, and what CI can and cannot prove.

## Architecture and product contracts

- [Product design](docs/product-design.md) and [build plan](docs/build-plan.md)
  are the product baseline.
- [Architecture decisions](docs/decisions/) record framework and Worker
  boundaries; [open decisions](docs/open-decisions.md) records items that need
  an owner or architect before production.
- [SEO](docs/seo.md), [analytics events](docs/analytics-events.md),
  [permissions](docs/permissions.md), and
  [save/resume](docs/save-resume.md) document contracts without implementing
  later milestone features.

Local development uses Wrangler's local D1 emulator. Do not put credentials,
customer data, or paid question banks in this repository. There is no deploy
command in the workspace scripts.
