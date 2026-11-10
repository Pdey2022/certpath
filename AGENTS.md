# Repository rules

- Follow `docs/product-design.md` and `docs/build-plan.md`; do not change
  product rules without owner approval.
- Implement only the milestone in scope. Do not add authentication, billing,
  question banks, or production permissions until their milestones.
- Keep public HTML useful without JavaScript. Keep private routes non-indexable
  and never treat `robots.txt` as an access control.
- Keep D1 access and secrets on the Worker. Never commit credentials, personal
  data, or real paid question content.
- Preserve exactly two staff roles: Global Admin and exam-scoped Manager.
- Keep analytics consent-aware and exclude personal data and protected content.
- Run `npm run verify` before handing off changes.
