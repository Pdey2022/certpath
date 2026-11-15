# Permissions contract

The only staff roles are **Global Admin** and **Manager**. Workflow states,
review steps and assignments are not additional roles.

## Global Admin

May manage all certifications, Manager assignments, prices, discounts, coupons,
customer access and entitlements, payments/refunds, staff and roles, security,
integrations, settings and audit reports.

## Manager

May add and maintain modules, domains, topics, questions, explanations and
mock/adaptive profiles only within explicitly assigned certifications. May
amend, review, publish and retire assigned content and inspect its quality
reports.

Managers also handle learner support **across the platform**: look up an account,
reset a password, resend verification, correct a profile and deactivate an
account. Learner data is masked by default - account id, masked contact,
membership state, attempt counts and last activity - and full contact details
require an audited reveal. Every learner record view and reveal is audited, not
only changes. A deactivation is terminal and cannot be reversed without an
owner-approved migration.

The governing principle, which settles new capabilities without a new debate:

> If it changes what a learner paid for, what they can access, or who can act on
> the platform, it is **Global Admin only**.

So Managers cannot manage prices, discounts, coupons, refunds, credits or payment
views; cannot grant, extend or revoke access or enable Pro for a certification;
cannot manage staff, roles, security, secrets or integrations; and cannot export
learner data in bulk or hard-delete any record. Global Admin creates
certification roots and assigns Managers. Enforce scope server-side for lists,
direct IDs, nested resources, mutations, reassignment, import and export. Check
both the current and proposed certification when moving content. Assignment
changes apply on subsequent requests and are audited. Deny by default; both staff
roles require MFA.

See [ADR 0004](decisions/0004-staff-capabilities-and-learner-data.md) for the
capability table and the rejected alternatives, and
[admin capabilities](admin-capabilities.md) for the implemented model.

## Capability mapping for the learner-support endpoints

Every admin learner-support route goes through one server-side decision
(`canCapability(actor, capability, resource)` in
`apps/api/src/security/capabilities.ts`), reached through
`requireCapability(...)` in `apps/api/src/security/staff-request.ts`. The server
never accepts a capability from a client; `GET /api/admin/capabilities` only
*reports* the caller's own role.

| Endpoint | Capability | Global Admin | Manager |
|---|---|---|---|
| `GET /api/admin/csrf` | — (live session plus an active staff role) | ✔ | ✔ |
| `GET /api/admin/capabilities` | — (reports the caller's role) | ✔ | ✔ |
| `POST /api/admin/learners/lookup` | `learner.lookup` | ✔ | ✔ |
| `GET /api/admin/learners/:id` | `learner.read` | ✔ | ✔ |
| `POST /api/admin/learners/:id/contact-reveal` | `learner.reveal` | ✔ | ✔ |
| `POST /api/admin/learners/:id/deactivate` | `learner.deactivate` | ✔ | ✔ |
| `POST /api/admin/learners/:id/contact` | `learner.contact.correct` | ✔ | ✔ |
| `POST /api/admin/learners/:id/password-reset` | `learner.support.email` | 409 `email_unavailable` | 409 `email_unavailable` |
| `POST /api/admin/learners/:id/resend-verification` | `learner.support.email` | 409 `email_unavailable` | 409 `email_unavailable` |
| `GET /api/admin/learners/:id/support-history` | `learner.support.history` | ✔ | ✔ |

`commerce.read`, `access.grant`, `staff.manage`, `security.manage` and
`audit.read` are Global Admin only in the matrix and have **no route** in this
phase. A learner (non-staff) session gets 401 on every route above.

### Staff subjects are 404 on every id-addressed endpoint

A learner-support request whose subject holds an active staff role answers
`404 not_found` on every **id-addressed** learner endpoint, for both roles, and
writes nothing — the same answer as a missing account. Learner support cannot be
used to enumerate staff or to reset a staff member's credential; that is a Global
Admin path.

`POST /api/admin/learners/lookup` is the deliberate exception: it answers
`200 {"items":[]}` for a staff subject's `userId`, identical to a `userId` that
matches no account. A `404` there would distinguish a staff account from a
nonexistent one, which is exactly what the rule exists to prevent.

### Deactivation is terminal

`users_no_reactivation` is a storage trigger: `disabled → active` aborts. There
is no `learner.reactivate` capability. Undoing a deactivation requires an
owner-approved migration that drops the trigger. See
[admin capabilities §α](admin-capabilities.md#️-deactivation-is-terminal).

### Audit retention job

`cleanupExpiredAuditEvents` (`apps/api/src/security/audit-retention.ts`) runs
from the Worker's `scheduled` handler in its own `ctx.waitUntil`, only when
`AUDIT_RETENTION_ENABLED === "true"`. It deletes at most 500 audit rows older
than twelve months per run, oldest first, idempotently. Retention is flat: reveal
and deactivation rows are deleted on the same rule, and there is no legal hold.
The storage trigger — not the job — enforces the floor, comparing against D1's
own clock.

### MFA dependency

Platform-wide learner access is acceptable on the labelled `tester-gate`
assurance only while the IP allowlist is non-empty, because real MFA is parked.
This surface may not be used for real learner data until an approved MFA factor
replaces `tester-gate` (Phase 5 gate). That is a security dependency, not a
preference.

Milestone 0 renders a non-functional admin shell only. It has no fixture
identity, role switching, permission enforcement or privileged data.

## Staff sign-in and the tester gate

Staff authenticate with an individual password credential and receive the same
opaque application session used by the rest of the application. Credentials can
exist only for accounts that already hold an active staff role, and provisioning
is an offline, owner-approved step; no password is ever entered into the admin
panel or stored unhashed.

Every `/admin` page and `/api/admin` route is behind a client-IP tester allowlist
that fails closed: an empty allowlist closes the entire admin surface, and an
unlisted client is refused before any handler or database write.

Both staff roles still require MFA. Real factors are parked, so a labelled
`tester-gate` assurance is accepted only while the tester allowlist is configured
and the owner has explicitly enabled it, and it is recorded on every session it
mints. It must be replaced by an approved factor before any non-tester use; see
[the tester access review](reviews/admin-tester-access.md).
