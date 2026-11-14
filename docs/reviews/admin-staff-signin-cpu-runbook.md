# Staff sign-in CPU runbook: Workers Free

**Status:** Plan only. Nothing has been provisioned, deployed, or measured.
**Execution gate:** owner approval of this runbook, of the six-request cap, and of
the temporary Worker and database names. Creating either resource is a separate,
approved step.
**Cost boundary:** Cloudflare stays on **Workers Free at $0**. No paid plan, no
paid analytics or Logpush, no KV, R2, or Queues.

## Question

Does one complete HTTPS staff sign-in stay inside Workers Free's **10 ms CPU per
invocation** when the tester gate, D1 rate limiting, the unchanged scrypt
verification, session creation, and the audit write all run inside the same
Worker invocation?

### Why the earlier numbers do not answer this

This repository already recorded **19-20 ms** of Worker CPU for the **learner**
sign-in path. That path delegated password verification out of the Worker to the
SigV4-signed Lambda verifier, so its Worker CPU did not contain scrypt at all.
**Staff sign-in is different: it runs scrypt verification inside the Worker**
(`createStaffAuthApi` defaults its verifier to `verifyLearnerPassword`). The
learner figure therefore does not bound the staff path in either direction, and
the staff path must be measured directly rather than inferred.

## What each measured request contains

| Included | Component |
|---|---|
| Yes | Tester allowlist gate (client IP check before any handler) |
| Yes | Staff security configuration parsing, exact origin check, JSON body limit |
| Yes | Two HMAC-SHA-256 rate-limit bucket digests with their D1 reads and writes |
| Yes | Staff credential lookup joined to the active role |
| Yes | scrypt verification **inside the Worker** (unchanged `N=32768, r=8, p=1`) |
| Yes | Session insert plus `staff_signed_in` audit insert in one D1 batch |
| Yes | Response and `Set-Cookie` handling |

Wall time is not CPU. Report the two separately and never substitute one for the
other.

## Request cap: six, every request counted

**Every HTTPS request that reaches the test Worker counts** against the cap: the
correlation probe, each sign-in, any access check, an accidental retry, and any
asset fetch from a browser tab. Keep browsers and the dashboard closed and issue
requests only from the CLI.

| # | Run id | Request | Counts |
|---|---|---|---|
| 1 | `staff-cpu-01` | `GET /api/admin/auth/preflight` - read-only correlation probe; the response must be `{"signInEnabled":true,"testerAssuranceEnabled":true}` | yes |
| 2 | `staff-cpu-02` | First valid-password sign-in | yes |
| 3 | `staff-cpu-03` | Second valid-password sign-in | yes |
| 4 | `staff-cpu-04` | Invalid password, known address | yes |
| 5 | `staff-cpu-05` | Unknown address (dummy-hash path) | yes |
| 6 | - | **Left unused.** Only an owner-approved re-run may spend it | no |

**Method note:** the preflight route is registered as `GET` in
`apps/api/src/staff-auth.ts`; a `POST` to it answers `404` and cannot confirm the
two flags. The probe is therefore `GET`, which still exercises the tester gate and
the whole admin API surface.

The probe doubles as an eligibility gate: it must return **both**
`signInEnabled: true` and `testerAssuranceEnabled: true` **and** its tail event
must carry a CPU-time field whose unit is documented (see below) before any
password is submitted. Any other body, a missing CPU field, or an unclear unit
ends the run.

Rate limiting: two valid plus two invalid attempts from one address and one IP
stay inside the gate's 5/address and 10/IP per 15-minute window. Do not re-run
inside a window that has already been used.

## Recording identifiers before creation

Write these down **before** any resource is created, so a half-finished run can
still be cleaned up and every later command can be pinned:

| Record before creation | Value |
|---|---|
| Certpath Cloudflare account id | from `wrangler whoami` and the dashboard account selector |
| Temporary Worker name | `certpath-staff-cpu` |
| Temporary D1 database name | `certpath-staff-cpu` |
| Planned hostname | `certpath-staff-cpu.<workers.dev subdomain>.workers.dev` |
| Operator egress IP for the allowlist | the address that will appear as `cf-connecting-ip` |

Record after creation: Worker script tag/version id, deployment id, D1 database
UUID, and the tail session start time. The D1 UUID - not just its name - is what
teardown verifies against.

## Read-only preflight

Every command here is a read. If a read is refused, stop and ask the owner.

| Check | Source | Blocking condition |
|---|---|---|
| Plan is Workers Free | `wrangler whoami`, **plus the signed-in dashboard plan and subscription view** | Plan cannot be confirmed in the dashboard, or any paid plan/subscription shows |
| Worker capacity | dashboard script list and `GET /accounts/{account_id}/workers/scripts` | Fewer than three free slots |
| D1 capacity | dashboard D1 list and `GET /accounts/{account_id}/d1/database` | No free slot |
| Request quota | GraphQL `workersInvocationsAdaptive`, previous 24 h, all scripts | Less than 500 requests of headroom |
| D1 quota | previous 24 h rows read/written across all databases | Less headroom than the D1 budget below |
| Leftover run resources | script and database inventories for `certpath-staff-cpu` | Either exists; resolve before starting |
| Telemetry path | `wrangler tail` attaches to an existing script, free, no Logpush | Tail cannot attach |

The dashboard plan check is mandatory for any future preflight: the CLI alone is
not accepted as proof of Workers Free.

## D1 budget

Budgets cover migrations, seeding, and test traffic together, and the preflight
must confirm at least this much headroom before starting.

| Phase | Rows read | Rows written | Notes |
|---|---|---|---|
| Migrations `0001`-`0012` | ~0 | ~60 | DDL plus seeded schema rows, applied once to an empty database |
| Seeding | ~10 | ~20 | 3 users, 3 roles, 1 certification, 1 exam version, 1 assignment, 2 credentials, 3 audits |
| Five counted requests | ~60 | ~35 | Each rate-limit check reads and writes windows; each sign-in reads credentials and writes a session plus an audit |
| Headroom for one approved re-check | ~20 | ~10 | Only after owner approval |
| **Total budget** | **< 100** | **< 130** | Well inside the Free daily allowance |

## Setup (after approval)

1. Create the temporary D1 `certpath-staff-cpu` and apply migrations `0001`-`0012`.
2. Seed two synthetic staff accounts in that database only: one valid, one decoy.
   Hash the passwords offline in Node, then apply the SQL to the temporary
   database. Never use a real address, and never touch a production database.
3. Deploy the existing app code as the temporary Worker `certpath-staff-cpu` with:
   - `PUBLIC_SITE_ORIGIN` set to its own hostname
   - `STAFF_MFA_MAX_AGE_MS=900000`
   - `STAFF_MFA_ALLOWED_METHODS=tester-gate`
   - `ADMIN_TESTER_ASSURANCE=true`
   - `ADMIN_TESTER_IPS=<operator egress IP>`
   - `ADMIN_TESTER_LOCAL` unset
   - `CSRF_HMAC_SECRET` and `STAFF_RATE_LIMIT_HMAC_SECRET` each set to a fresh
     random value of at least 32 characters, generated for this run only and
     stored as Worker secrets rather than plain vars
   - no mail, learner, or Google bindings
4. Confirm the operator address is the allowlisted one, so the sample measures the
   sign-in path rather than the gate's `403`.

Both secrets are destroyed with the temporary Worker and are never written to the
repository, a shell history, or a log. If either is reused from another
environment, stop: they must be fresh for this run.

## Telemetry capture

```powershell
wrangler tail certpath-staff-cpu --format json
```

No status filter is used, so failed and CPU-killed invocations are captured too.
For every request record: the complete event object, whatever CPU-time field it
carries (name and raw value unmodified), `wallTime`, `outcome`, `exceptions`,
`event.request.url` and method, the `X-CPU-Run-Id` header, and
`event.response.status`.

### The CPU field and its unit: verified evidence

This runbook does **not** assume that `wrangler tail --format json` emits a field
named `cpuTime`, and it never infers a unit from the size of a value. Evidence
gathered for this plan (checked 2026-11-14):

| Source | Evidence |
|---|---|
| [Tail Handler `TailItems`](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/) (updated 2026-06-15) | Documents the event properties as `scriptName`, `event`, `eventTimestamp`, `logs`, `exceptions`, and `outcome`. **No CPU-time field is documented.** |
| [Tail Workers overview](https://developers.cloudflare.com/workers/observability/logs/tail-workers/) (updated 2026-10-02) | The sample event JSON contains `scriptName`, `outcome`, `eventTimestamp`, `event`, `logs`, `exceptions`, and `diagnosticsChannelEvents`. **No CPU-time field.** |
| `wrangler@4.160.0`, the version installed in this repository | `node_modules/wrangler/wrangler-dist/cli.js` contains **zero** occurrences of `cpuTime` (case-insensitive); wrangler forwards the tail event payload rather than naming its fields. |
| `cloudflare/workers-sdk` code search for `cpuTime` / `wallTime` | One file only: `packages/miniflare/src/workers/observability/tail-to-store.ts`, which keeps the OpenTelemetry attribute name **`cpu_time_ms`** for the local trace store. That is Miniflare's local store, not the `wrangler tail` JSON contract. |

Consequences, applied to the probe before any password is submitted:

1. Capture the probe's **complete raw JSON** exactly as printed, preserving every
   field name and value unmodified.
2. If the event carries no CPU-time field, telemetry is missing: **stop**. Do not
   substitute wall time, and do not proceed on the dashboard's separate logs
   pipeline.
3. If the event does carry a CPU-time field, identify its **exact name** as
   emitted. The unit must then be established from provider documentation for
   that exact field. The only unit evidence found so far (`cpu_time_ms`,
   milliseconds) belongs to Miniflare's local store and does not transfer to the
   tail JSON, so it cannot be used as proof.
4. If the field's unit is not documented, or the documentation contradicts the
   observed event, the unit is **unclear**: **stop** and bring the raw event for
   review. Nothing may be inferred from magnitude, from wall time, or from a
   comparison between requests.
5. Record the raw value unchanged and convert to milliseconds **only** when the
   verified unit requires it, labelling every converted sample `normalized` and
   citing the source that established the unit.

A future revision may name a different, documented CPU telemetry source (for
example an aggregated percentile from the analytics API). Any replacement must
meet the same standard: exact field documented by Cloudflare, unit stated, and no
inference from value size. Wall time is never a substitute.

### Correlation

1. Issue one request carrying a unique `X-CPU-Run-Id`.
2. Wait **up to 30 seconds for that request's event**, matching strictly on the
   `X-CPU-Run-Id` request header. Ignore events carrying any other id.
3. Optionally cross-check the response's `X-Request-Id` against the event; a
   mismatch or absence is noted but does not block, because the run id is the
   authoritative key.
4. Only after the match is confirmed, record the sample and issue the next
   request.

## Decision rules, applied from the first request

| Observed (converted to ms only if the verified unit requires it) | Action |
|---|---|
| Verified CPU value at or below 5 ms, event matched, field and unit documented | Continue to the next request |
| Verified CPU value above 5 ms and below 10 ms | **Hold for review.** Publish the samples and stop measuring |
| Verified CPU value at or above 10 ms | **Stop.** No further requests |
| CPU-limit error: `exceededCpu` outcome, `1102`/`5xx`, or an exception indicating the CPU limit | **Stop immediately** |
| No matching event within 30 s, no CPU-time field, undocumented unit, or a detached tail | **Stop immediately**: telemetry is missing or unclear |

The rules start at the probe. A probe that is slow, CPU-killed, or unmatched ends
the run before any password is submitted. There are no retries for a stopped
condition.

## Report format

One row per counted request: id, URL/method, password class, HTTP status, the CPU
field name as emitted (if any), the raw value unmodified, the cited source for its
unit, the value in milliseconds only when the verified unit requires conversion,
`wallTime` in ms, `outcome`, matched event (yes/no), verdict. Followed by: the
verbatim probe event JSON, requests used out of six, which rule ended the run, and
the D1 rows read/written and quota readings before and after.

## Teardown

Both deletions are attempted even if the first fails, every command is pinned to
the recorded account and resources, and the run is not closed until provider
inventory shows both resources gone.

1. Stop the `wrangler tail` session.
2. Pin the account for the rest of the session and confirm it matches the record:
   `$env:CLOUDFLARE_ACCOUNT_ID='<recorded account id>'`, then `wrangler whoami`.
3. Capture inventory **before** deleting, to confirm the targets are the recorded
   ones: `GET /accounts/{account_id}/workers/scripts` and
   `GET /accounts/{account_id}/d1/database`. The D1 UUID must equal the recorded
   UUID. Never delete by name pattern.
4. Attempt the Worker deletion, pinned to the account and the recorded script
   name: `wrangler delete certpath-staff-cpu`. Record the result whether it
   succeeds or fails.
5. Attempt the D1 deletion regardless of step 4's result, pinned to the account
   and the recorded database name:
   `wrangler d1 delete certpath-staff-cpu --skip-confirmation`.
6. Verify with provider inventory, not the delete exit codes: re-read
   `GET /accounts/{account_id}/workers/scripts` and
   `GET /accounts/{account_id}/d1/database`, and the dashboard script and D1
   lists. Both the script and the database UUID must be absent. If either
   remains, retry once manually and then escalate; the run stays open.
7. Confirm the plan still shows Workers Free, no paid subscription, and no paid
   analytics enabled.
8. Confirm `certpath-site` and `certpath-ui-preview` still answer `200` and the
   learner paths of the main Worker are unchanged.
9. Remove local curl outputs and tail logs.

Deleting the database also removes the synthetic accounts, credentials, sessions,
rate-limit rows, and audit trail.

## Invariants

The public site, the demo, and all learner paths stay live at $0 and are never
modified by this run. Email stays off, Google OAuth stays paused, staff MFA stays
parked, and no production database, account, or secret is touched.

## Expected outcome

The offline measurement already puts scrypt verification far above the Free CPU
budget, and staff sign-in now performs that work inside the Worker. The first
valid-password request is therefore expected to trip the 10 ms stop rule. The run
exists to confirm that on the real HTTPS path and to bound the cost to five
requests, leaving the sixth unused.