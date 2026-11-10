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
