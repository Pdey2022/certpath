# Invite-only email sign-in links (design and local test plan)

**Status:** Implemented for local review in a draft pull request. Nothing is
provisioned or deployed, no email leaves the process, and Google OAuth setup is
paused.
**Scope:** Pre-provisioned learners only, reusing the existing `users`,
`app_sessions`, and `learner_access_grants` tables. Cloudflare Workers and D1
stay on the free plan; the public site and the synthetic demo are untouched.

## Goal

Replace provider sign-in for the private pilot with an email link that is only
ever sent to an address an operator already provisioned for an existing learner
account. A learner asks for a link, opens it, sees a confirmation page, and
confirms; only then does the Worker create the normal opaque application
session that the protected practice and dashboard APIs already require.

## Non-goals

- No self-registration and no account creation on request or redeem.
- No email provider, DNS record, outbound request, or template engine. Messages
  go to the existing in-memory local test inbox.
- No Google OAuth, no account linking, no provider tokens.
- No grant issuance: the pilot signs in to exams that already have an active
  Standard grant.
- No production deployment or provisioning.

## Flow

1. `POST /api/auth/email-link/request` - validates origin, rate-limits, and
   inserts a token inside a guarded `INSERT ... SELECT` that only matches a
   non-revoked invite for an active account without a staff role. The link is
   written to the local test inbox only when that insert affected one row.
2. `GET /sign-in/link#token=...` - the token stays in the URL fragment, so it is
   never part of the request the server sees, and the server renders the
   noindex confirmation shell.
3. `POST /api/auth/email-link/inspect` - reports `valid` or `invalid` without
   consuming anything.
4. `POST /api/auth/email-link/redeem` - consumes the token with a single
   conditional `UPDATE ... RETURNING`, inserts the session, and writes the
   audit event in one D1 batch, then sets the `certpath_session` cookie.

## Data model

`db/migrations/0011_learner_email_sign_in_links.sql` adds:

| Table | Purpose |
|---|---|
| `learner_email_sign_in_invites` | One invited address per learner account. `revoked_at` retires an invite without deleting history. |
| `learner_email_sign_in_tokens` | `token_digest` primary key, invite address, user, `created_at`, `expires_at`, `consumed_at`, `consumed_operation_id`. A `CHECK` caps the lifetime at 15 minutes. |
| `local_auth_rate_limit_windows` (rebuilt) | Same table, extended `scope` list for the three link actions, so the pilot keeps one bounded rate-limit table. |

No raw token is stored. The digest is the SHA-256 of the 32 random bytes that
only appear in the emailed link.

## Controls

| Control | Rule |
|---|---|
| Pre-provisioned only | Lookup is by the invited address; there is no insert into `users` on request or redeem. An uninvited address gets the same `202` and no message. |
| Digest at rest | Only `token_digest` is persisted; the raw token exists in the link and in the confirmation page's memory. |
| Short-lived | Fifteen minutes, enforced by the Worker clock and a schema `CHECK`. |
| Single use | `UPDATE ... WHERE consumed_at IS NULL RETURNING`, so concurrent redemptions have one durable outcome. |
| Atomic redeem | Token consumption, session insert, and audit insert share one D1 batch; a partial result returns `400` and sets no cookie. |
| Confirmation page | Opening the link performs only the non-consuming `inspect`, so a scanner that follows URLs cannot spend the link. The token fragment is stripped from history on load. |
| No enumeration | `request` answers `202` with one message for invited and uninvited synthetic addresses alike. |
| Rate limits | `sign_in_link_request` 10/IP and 3/email per 15 minutes, `sign_in_link_inspect` 60/IP, `sign_in_link_redeem` 20/IP, in HMAC-bucketed windows. |
| Origin | Exact `PUBLIC_SITE_ORIGIN` on the request URL plus a matching `Origin` header on every `POST`; the flow is refused unless that origin is a loopback address. |
| Local proof only | Disabled unless `LOCAL_LEARNER_EMAIL_LINK_ENABLED` and `LOCAL_TEST_MAIL_ENABLED` are `true` and both HMAC secrets are present. Non-synthetic addresses are rejected, so no real inbox is ever addressed. |
| Staff exclusion | An account with an active staff role can neither receive nor redeem a learner link, matching the existing learner password proof. |
| Session | Existing `certpath_session` opaque cookie, 32 random bytes, digest at rest, `HttpOnly`, `SameSite=Lax`, `Secure` on `https`, eight hours. |
| Audit | `learner_signed_in` with reason `Learner signed in by email link`, appended in the same batch. |
| No outbound traffic | The router never calls `fetch`; tests inject a fetcher that records every call. |

## Files

| File | Change |
|---|---|
| `db/migrations/0011_learner_email_sign_in_links.sql` | Invite, token, and rate-limit scope changes. |
| `apps/api/src/security/email-sign-in-links.ts` | Issue, inspect, and atomic redeem services. |
| `apps/api/src/security/local-learner-request.ts` | Local-proof helpers (origin, JSON limits, HMAC rate-limit windows, token creation) shared with the password proof. |
| `apps/api/src/learner-email-sign-in.ts` | `/preflight`, `/request`, `/inspect`, `/redeem`, `/test-inbox`. |
| `apps/api/src/index.ts` | Mounts `/api/auth/email-link` and shares one local test-mail adapter. |
| `apps/web/app/components/learner-sign-in-link.tsx` | Confirmation page behaviour: inspect on load, redeem on confirm. |
| `apps/web/app/routes/learner-sign-in-link.tsx` | `/sign-in/link` route with private, noindex headers. |
| `apps/web/app/routes/learner-sign-in.tsx` | Email-link mode as the pilot's default, password proof still available locally. |
| `apps/web/app/components/public-layout.tsx` | Availability comes from both local proofs. |
| `apps/api/scripts/provision-learner-sign-in-invite.mjs` | Local-only invite provisioning, revocation, and re-provisioning. |

## Local test plan

Isolated D1 per run, synthetic accounts only, fixed clock, no network egress.

| Case | Expectation |
|---|---|
| Bindings disabled | `preflight` reports disabled, `request` returns `503`, no token row. |
| Provisioned learner | `202`, one message in the inbox, exactly one token row whose digest equals SHA-256 of the link token and differs from it, expiry exactly 15 minutes. |
| Scanner safety | Two `inspect` calls report `valid` and leave `consumed_at` null; an unauthenticated dashboard read is `401`. |
| Redeem | `200` with `redirectTo: /app/home`, `HttpOnly`/`SameSite=Lax`/`Secure` cookie, one session, one audit event, the exact granted exam on `/api/practice/dashboard`, and the inbox message cleared. |
| Replay | Second redeem is `400 invalid_or_expired_link`, `inspect` turns `invalid`, and the learner still has exactly one session that keeps working. |
| Uninvited address | Same `202` body as an invited address, empty inbox, zero token rows. |
| Real-looking address | `400 synthetic_email_required`. |
| Expired link | After 16 minutes: `inspect` is `invalid`, redeem is `400`, no cookie, no session. |
| Revoked invite / disabled account | No message is produced for a disabled account; a link issued before revocation stops inspecting and redeeming as valid. |
| Staff account | No link is produced, and granting a staff role after issue blocks redemption. |
| Concurrency | Three simultaneous redemptions yield one `200`, two `400`, and one session. |
| Rate limit | The fourth request for one address in a window returns `429`. |
| Origin and media type | Foreign origin is `403`, missing `Origin` is `403`, `text/plain` is `415`, and no message is produced. |
| UI | Confirmation inspects once and does not redeem until confirmed; missing, expired, and already-spent links never show a confirm control. |

## Verification performed

```
npm run verify                                  passed (typecheck, api 137 + 31, web 99, build)
npm run typecheck --workspace @certpath/api     passed
npm run typecheck --workspace @certpath/web     passed (wrangler types + typegen + tsc -b)
apps/api: npx vitest run learner-email-sign-in  9 passed
apps/web: tsx --test learner-sign-in*.test.tsx  18 passed (local, Google, pilot, link)
fresh local D1 (wrangler d1 migrations apply --local --persist-to <temp dir>)
                                                0001-0011 applied in order; the
                                                Google and email-link tables and
                                                the rebuilt rate-limit scopes all
                                                exist afterwards
```

The branch is rebased onto the merged Google pilot work. Google sign-in stays
disabled by default, needs its own client configuration, and this slice neither
enables nor configures it; the email-link preflight is skipped entirely on the
release, pilot, preview, and staging origins so their existing behaviour and
request counts are unchanged.

Manual local run against the real Worker (`npm run dev`, local D1, local inbox):
provisioned `pilot.learner@example.test`, received one `sign_in_link` message,
inspected twice (`valid`, still unconsumed), redeemed (`200`, cookie issued,
`/api/auth/session/csrf` accepted the session), replayed (`400`), confirmed the
inbox was cleared, and confirmed the uninvited `stranger@example.test` produced
the identical `202` with no message. The `/sign-in/link` shell carried
`X-Robots-Tag: noindex, nofollow`, `private, no-store`, the confirmation copy,
and no token.

## Limitations and decisions for review

1. **Email delivery is not implemented.** The pilot writes to the in-memory
   local inbox, which is why the flags and synthetic-address rule exist. A real
   provider, sender domain, bounce handling, and retention policy need owner
   approval before any deployment.
2. **The dashboard's protected API needs an `https:` origin.** That is a
   pre-existing local constraint of `/api/practice`, so the browser-visible
   dashboard step is covered by Worker/D1 tests rather than the plain-`http`
   dev server. The signed-in session itself was verified locally through
   `/api/auth/session/csrf`.
3. **Link lifetime and rate limits** (15 minutes, 10/IP, 3/email) are pilot
   values chosen for review, not approved policy.
4. **Invite lifecycle** is operator-scripted only. There is no staff screen, and
   invite issuance is not audited beyond the provisioning script's output.
5. **Revoking a link's invite** is checked at redeem, so an outstanding link
   stops working immediately; whether that should also revoke already-issued
   sessions is a product decision that remains open.
