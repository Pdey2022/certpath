# Staff sign-in CPU runbook: Workers Free

**Status:** Plan only. Nothing has been provisioned, deployed, or measured.
**Telemetry source:** the Workers Traces root-span attribute
`cloudflare.cpu_time_ms`, in milliseconds.
**Execution gate:** owner approval of this runbook, of the six-request cap, and of
the temporary Worker and database names. Creating either resource is a separate,
approved step.
**Cost boundary:** Cloudflare stays on **Workers Free at $0**. No paid plan, no
paid analytics, Logpush, or OpenTelemetry trace export, no KV, R2, or Queues.

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
asset fetch from a browser tab. Issue this run's requests only from the CLI and
never open the test Worker's own pages in a browser. Reading traces in the
Cloudflare dashboard does not send requests to the test Worker and is expected.

| # | Run id | Request | Counts |
|---|---|---|---|
| 1 | `staff-cpu-01` | `GET /api/admin/auth/preflight` - read-only correlation probe; the response must be `{"signInEnabled":true,"testerAssuranceEnabled":true}`, and its trace must be matched with a CPU value before any password is submitted | yes |
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
`signInEnabled: true` and `testerAssuranceEnabled: true`, **and** its trace must be
matched by `Cf-Ray` and carry a `cloudflare.cpu_time_ms` value (see below) before
any password is submitted. Any other body, a missing or ambiguous trace, or an
absent CPU value ends the run.

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

Record after creation: Worker script tag/version id and deployment id, the D1
database UUID, and the start time of the measurement window used for the trace
filter. The D1 UUID - not just its name - is what teardown verifies against.

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
| Telemetry path | the temporary Worker deploys with `observability.traces.enabled`, and Workers Observability shows **Traces** for the account | Traces cannot be enabled, or the Traces view is unavailable on the account's plan |

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
   - `observability.traces.enabled` set to `true` with the default sample rate of
     `1`, and the `triggers.crons` entry removed, in a temporary Wrangler config
     used for this deployment only. The committed `apps/web/wrangler.jsonc` enables
     logs only; `observability.enabled` on its own does **not** enable traces, so
     the traces block must be added explicitly and must not be committed
4. Confirm the operator address is the allowlisted one, so the sample measures the
   sign-in path rather than the gate's `403`.

Both secrets are destroyed with the temporary Worker and are never written to the
repository, a shell history, or a log. If either is reused from another
environment, stop: they must be fresh for this run.

## Telemetry capture: Workers Traces

The measured value is the **root-span attribute `cloudflare.cpu_time_ms`**, read
per request in Workers Observability under **Traces** for the temporary Worker. A
root span belongs to one invocation, which is exactly the per-request quantity the
question asks about.

### Evidence for the field, its unit, the Free plan, and the match

| Requirement | Source | Evidence |
|---|---|---|
| Exact field | [Spans and attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/) (updated 2026-10-16) | `cloudflare.cpu_time_ms` is listed under **Attributes available on all root spans** |
| Unit | same page | "The CPU time used by the Worker invocation, **in milliseconds**" |
| Free-plan availability | [Observability pricing](https://developers.cloudflare.com/observability/pricing/) (updated 2026-11-11), [Workers tracing announcement](https://blog.cloudflare.com/workers-tracing-now-in-open-beta/), [Traces configuration](https://developers.cloudflare.com/observability/traces/configuration/) | Workers Traces is an included Observability product; Free includes 0.5 GB per day of ingestion with seven-day retention, and "Cloudflare stops ingesting new data when you reach the daily limit"; the announcement states that dashboard viewing is available "on a Workers Free and Paid plan" |
| Per-request match | [Traces FAQ](https://developers.cloudflare.com/observability/traces/), [Cloudflare Ray ID](https://developers.cloudflare.com/fundamentals/reference/cloudflare-ray-id/), [HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/) | `cloudflare.ray_id` is "a unique identifier for every request that goes through Cloudflare"; the `Cf-Ray` header **is** that Ray ID and is returned on the response; the documented filter is `cloudflare.ray_id = "<ray>"` |
| CPU-limit failure | [Spans and attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/), [Limits](https://developers.cloudflare.com/workers/platform/limits/) | root-span `cloudflare.outcome` values include `exceededCpu` and `exceededMemory`; a CPU-killed invocation answers error `1102`, `Worker exceeded resource limits` |

Rules derived from that evidence:

1. Record the raw `cloudflare.cpu_time_ms` integer unmodified. It is already in
   milliseconds, so **no conversion is applied**, and no unit is ever inferred from
   how large the number looks.
2. `cloudflare.wall_time_ms` is recorded for context only and is never substituted
   for CPU.
3. OpenTelemetry export stays off: exporting traces needs a Workers Paid
   subscription and would send telemetry to a third party. Dashboard viewing on
   Free is the only telemetry path in this run.
4. Traces are enabled explicitly for the temporary Worker at the default sample
   rate of `1`, so the probe is traced as well as every sign-in. The feature is in
   open beta, and `observability.enabled` on its own enables logs only, so the
   traces block must be set (setup step 3).

### Why `wrangler tail` is not the telemetry source

`wrangler tail` was rejected because Cloudflare documents no CPU-time field in its
JSON contract, and this runbook never infers a field or a unit from a value's size.
Evidence gathered for this plan (checked 2026-11-14):

| Source | Evidence |
|---|---|
| [Tail Handler `TailItems`](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/) (updated 2026-06-15) | Documents the event properties as `scriptName`, `event`, `eventTimestamp`, `logs`, `exceptions`, and `outcome`. **No CPU-time field is documented.** |
| [Tail Workers overview](https://developers.cloudflare.com/workers/observability/logs/tail-workers/) (updated 2026-10-02) | The sample event JSON contains `scriptName`, `outcome`, `eventTimestamp`, `event`, `logs`, `exceptions`, and `diagnosticsChannelEvents`. **No CPU-time field.** |
| `wrangler@4.160.0`, the version installed in this repository | `node_modules/wrangler/wrangler-dist/cli.js` contains **zero** occurrences of `cpuTime` (case-insensitive); wrangler forwards the tail event payload rather than naming its fields. |
| `cloudflare/workers-sdk` code search for `cpuTime` / `wallTime` | One file only: `packages/miniflare/src/workers/observability/tail-to-store.ts`, which keeps the OpenTelemetry attribute name **`cpu_time_ms`** for the local trace store. That is Miniflare's local store, not the `wrangler tail` JSON contract. |

The probe's tail event is therefore never used as a CPU measurement. A tail session
may optionally be left running only as a convenience for spotting a `1102`
response as it happens; it supplies no sample, and losing the tail stream is not a
blocking condition now that traces carry the value.

Any future replacement telemetry source must meet the same standard: exact field
documented by Cloudflare, unit stated, and no inference from value size. Wall time
is never a substitute, and aggregated percentiles cannot stand in for a
per-request value.

### Correlation: `Cf-Ray` to `cloudflare.ray_id`

Request header values are not captured in spans, so the `X-CPU-Run-Id` header does
not appear in a trace and cannot be the join key. The response's Ray ID is the key,
corroborated by three fields on the same root span.

1. Issue one request carrying a unique `X-CPU-Run-Id`, and capture the response's
   **`Cf-Ray` header verbatim** as it arrives.
2. Open **Traces** for `certpath-staff-cpu` in Workers Observability and filter
   `cloudflare.ray_id = "<that ray id>"`.
3. Accept the match only when all three corroborating fields agree with the request
   just issued:
   - **Worker name** - `cloudflare.script_name` and `faas.name` equal
     `certpath-staff-cpu`
   - **Path** - `url.path` and `http.request.method` equal the request issued
   - **Timestamp** - the span time agrees with the response time to the second

   Ray IDs "are not guaranteed to be unique for every request", so a Ray ID alone
   is not accepted as a match.
4. Wait **up to 30 seconds** for the trace. Issue no further request while waiting.
5. Record `faas.invocation_id` with the sample, then issue the next request.

Any of these is a **missing or ambiguous trace** and stops the run before the next
request: no `Cf-Ray` header on the response, no span for that Ray ID within 30
seconds, more than one candidate root span, disagreement on Worker name, path, or
timestamp, or an absent `cloudflare.cpu_time_ms` value.

## Decision rules, applied from the first request

| Observed | Action |
|---|---|
| `cloudflare.cpu_time_ms` at or below 5 ms, trace matched, value present | Continue to the next request |
| `cloudflare.cpu_time_ms` above 5 ms and below 10 ms | **Hold for review.** Publish the samples and stop measuring |
| `cloudflare.cpu_time_ms` at or above 10 ms | **Stop.** No further requests |
| `cloudflare.outcome` is `exceededCpu`, or the response is error `1102` / `Worker exceeded resource limits` | **Stop immediately**, even when no `cloudflare.cpu_time_ms` value is available |
| No matching trace within 30 s, an ambiguous trace, or an absent CPU value | **Stop immediately**: telemetry is missing or ambiguous |

The rules start at the probe. A probe that is slow, CPU-killed, or unmatched ends
the run before any password is submitted. There are no retries for a stopped
condition.

## Report format

One row per counted request: id, URL/method, password class, HTTP status, the raw
`Cf-Ray`, the matched `cloudflare.ray_id`, whether Worker name, path, and timestamp
agreed (yes/no), `faas.invocation_id`, the raw `cloudflare.cpu_time_ms` value in
milliseconds, `cloudflare.wall_time_ms`, `cloudflare.outcome`, and the verdict.
Followed by: the probe's matched root-span attributes, requests used out of six,
which rule ended the run, and the D1 rows read/written and quota readings before
and after.

## Teardown

Both deletions are attempted even if the first fails, every command is pinned to
the recorded account and resources, and the run is not closed until provider
inventory shows both resources gone.

1. Delete the uncommitted temporary Wrangler config used for this deployment, and
   confirm `git status` shows `apps/web/wrangler.jsonc` unchanged.
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
9. Remove local curl outputs and captured trace exports. Persisted traces expire on
   their own under Free retention; there is no separate trace resource to delete,
   and nothing is exported to a third party.

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