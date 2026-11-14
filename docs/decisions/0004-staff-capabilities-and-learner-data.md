# ADR 0004: Staff capabilities and learner data access

- Status: Accepted, with owner approval on 2026-11-14.
- Scope: Capability boundaries for the two staff roles. Implementation is phased
  (see `docs/delivery-plan.md`).
- Supersedes: the Manager paragraph in `docs/permissions.md`, which is rewritten
  in the same change.

## Context

`docs/permissions.md` previously restricted Managers to content inside assigned
certifications, with only the minimal learner context needed to investigate
content reports. The owner has widened the Manager role: Managers now handle
learner support across the platform and remain fully responsible for content in
their assigned certifications, while **pricing and money stay with Global
Admin**.

That is two changes at once - more capabilities, and a wider data scope - so the
boundary needs to be explicit rather than inferred from a price list.

## Decision

One principle governs every future argument:

> **If it changes what a learner paid for, what they can access, or who can act
> on the platform, it is Global Admin only.**

| Capability | Global Admin | Manager |
|---|---|---|
| Content: add, amend, review, publish, retire | all certifications | assigned certifications only |
| Content import/export | all | assigned certifications |
| Learner support: reset password, resend verification, correct profile, deactivate | all learners | all learners |
| Learner lookup and support history | all | all learners |
| Prices, discounts, coupons, refunds, credits, payment views | yes | **no** |
| Access grants, extensions, Pro enablement | yes | **no** |
| Staff and role management | yes | **no** |
| Security, secrets, integrations, audit export | yes | no |

Consequences of that table:

1. **Entitlement changes are commercial acts.** Granting or extending access, or
   enabling Pro for a certification, is priced behaviour and stays Global Admin.
2. **Staff management stays Global Admin.** A Manager who could create or promote
   an account could mint a Manager, which would bypass every other row.
3. **Managers see masked learner data by default** - account id, masked contact,
   membership state, attempt counts, last activity. Full contact details are
   behind an explicit **reveal** action that writes an audit event.
4. **Access to a learner record is audited, not just changes to it.** Actor,
   learner, and fields revealed are recorded, because platform-wide access is
   otherwise uninspectable.
5. **No bulk export of learner data** and no hard deletes. Deactivation is the
   terminal state.
6. **Admin audit events are retained for 12 months**, then removed.

## Alternatives considered

- _Keep learner management exam-scoped_: safest for PII, but leaves support
  unable to help a learner whose exam a Manager does not own.
- _Let Managers manage staff but require Global Admin approval_: rejected; the
  approval step becomes a rubber stamp and adds no real control.
- _Let Managers issue goodwill extensions_: rejected; it is a price change with
  extra steps and breaks revenue integrity reporting.
- _No audit on reads_: rejected; with platform-wide access, reads are the risk.

## Consequences

- The capability list becomes one server-side function
  (`can(actor, capability, resource)`) with scope resolution, not scattered
  checks per route.
- Masking and reveal need a single learner read model, so a new admin route cannot
  accidentally return full contact data.
- Platform-wide learner access while MFA is parked is acceptable only for the
  tester phase behind the IP allowlist. Real MFA must land before real learner
  data exists; this is a security dependency, not a preference.
- Audit retention needs a scheduled cleanup (cron) and a documented deletion job.
