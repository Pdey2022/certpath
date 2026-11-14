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
only changes.

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
capability table and the rejected alternatives.

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
