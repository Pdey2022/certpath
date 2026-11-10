# Milestone 2B review

## Scope and implementation

This slice adds provider-independent local identity/session database foundations and permission services only. It does not add authentication routes, production identity, content revision/import tables, or production provisioning operations.

### Schema decisions

- `users` are internal principals; `auth_identities` uses `(issuer, subject)` as its unique key. Provider identities do not determine internal authorization.
- `app_sessions` stores only a 64-character lowercase SHA-256 token digest, expiry/revocation state, and server-owned MFA assurance fields. The schema contains no password or raw-token fields.
- `staff_roles` permits only `global_admin` and `manager`; Manager certification assignments reference immutable certification roots. No unique index limits the number of Global Admins.
- `initial_admin_provisioning` has one fixed bootstrap key and a one-way consumed state. A trigger consumes it atomically with the initial Global Admin role insert. Later Global Admin appointments use the separately authorized, MFA-checked mutation path.
- Conditional role, assignment, certification-root, and session writes use D1 `RETURNING` rows to identify whether the target row changed. Audit triggers write append-only audit events in the same SQLite write operation. The final-active-Global-Admin guard remains a conditional write.
- Security reads use D1's `first-primary` consistency option. Provider lifecycle-event infrastructure, content revisions/imports, and learner persistence are deferred until their respective designs are approved.

### Runtime and permission boundaries

The internal services validate active user/session state, enforce Global Admin or assigned-certification Manager access, apply explicit MFA policies, and support immediate application-session revocation. No login, bootstrap, test-session, or role-changing HTTP endpoint was added. The existing public health response is unchanged.

Synthetic identity/session/MFA factories live under `apps/api/test` and are not imported by runtime source. Browser-provided roles, `demoRole`, email domains, and synthetic prototype state do not enter these services as authority. MFA checks deny access when policy is unconfigured or invalid, or assurance is missing, unsupported, or stale.

## Verification

Environment: Windows, Node `v24.18.0`, npm `11.16.0`.

| Command | Result |
|---|---|
| `npm ci --include=optional` | Passed on Windows from the committed lockfile; installed 174 packages, reported 0 vulnerabilities. npm printed install-script approval warnings for workerd/esbuild packages; the Worker tests subsequently ran successfully. |
| `npm run verify` | Passed after clean install. Typechecks passed for API/runtime tests, web, and contracts; API Node health test passed; all 12 local Worker/D1 tests passed; all 13 web tests passed; client and SSR production builds passed. |
| `git diff --check` | Passed. |

Worker/D1 integration tests use `@cloudflare/vitest-plugin` and Vitest with the repository's Wrangler configuration and an isolated Miniflare D1 database. Test setup applies the versioned migrations twice. Coverage includes repeated migration application, constraints/foreign keys, audit immutability, valid/expired/revoked/disabled-account sessions, role and Manager assignment isolation, current assignment revocation, fail-closed MFA, conditional audit behavior, concurrent one-time bootstrap, separately authorized later Global Admin appointment, and last-admin removal races.

The CI workflow continues to run `npm ci --include=optional` and `npm run verify` on `ubuntu-latest`; the final pull-request check result is reported with the exact commit and Actions run after push.

## Limitations and deferred work

- Provider selection, provider compatibility, registration, Google sign-in/account linking, recovery, production session issuance, provider-session/lifecycle revocation, and external assurance/outage windows remain pending approval.
- MFA freshness and allowed methods are injected by callers; only explicit synthetic test policies are used here. No production timing defaults are selected.
- No production bootstrap command or production operation was run. This branch adds no permanent bootstrap HTTP endpoint.
- Content versions/revisions, imports/exports, publication, production admin workflows, and learner attempts/bookmarks/notes are not included. Carry attempt, bookmark, learner-record ownership, and attempt-to-revision snapshot tests into the milestone that implements those records and routes.
- The permission services are internal foundations and are not yet wired to authenticated HTTP routes; they do not represent production authentication.

## Architect inspection and run steps

1. Review `db/migrations/0002_local_security.sql` and the security modules under `apps/api/src/security/`.
2. From the repository root, run `npm ci --include=optional` and `npm run verify`.
3. To run only the isolated Worker/D1 integration tests, run `npx vitest run --config vitest.config.ts` from `apps/api`.
4. Review the synthetic fixtures and scenario tests under `apps/api/test/`; these are test-only and use Miniflare D1 rather than the normal demo database.
5. Confirm the GitHub Actions result against the final commit SHA and run linked from the pull request before approval.
