# Permissions contract

The only staff roles are **Global Admin** and **Manager**. Workflow states,
review steps and assignments are not additional roles.

## Global Admin

May manage all certifications, Manager assignments, prices, customer access,
payments/refunds, security, integrations, settings and audit reports.

## Manager

May add and maintain modules, domains, topics, questions, explanations and
mock/adaptive profiles only within explicitly assigned certifications. May
amend, review, publish and retire assigned content and inspect its quality
reports. May see only minimal learner context needed to investigate content
reports.

Managers cannot manage prices, payments, access grants, staff, security,
secrets, or unrestricted customer data. Global Admin creates certification
roots and assigns Managers. Enforce scope server-side for lists, direct IDs,
nested resources, mutations, reassignment, import and export. Check both the
current and proposed certification when moving content. Assignment changes
apply on subsequent requests and are audited. Deny by default; both staff
roles require MFA.

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
