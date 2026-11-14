# Staff sign-in Workers Traces probe: review package

**Status:** Plan only. Nothing has been provisioned, deployed, measured, or changed
in the Cloudflare account.
**Scope:** request 1 of the six-request cap in the [staff sign-in CPU
runbook](admin-staff-signin-cpu-runbook.md). The probe submits **no password** and
makes exactly **one** request.
**Execution gate:** owner approval of this probe, of the temporary Worker and D1
names, and of the runbook that contains the cap. Creating either resource is a
separate, approved step.
**Cost boundary:** the public site and the demo stay on **Workers Free at $0** and
are not redeployed, retraced, or otherwise touched. No paid plan, Logpush, or
OpenTelemetry export.

## What this probe decides

Whether the future temporary staff Worker can produce **one documented,
per-request CPU sample at all**, before the run spends a password request or any
further request. It answers that question only. It does not measure sign-in:
scrypt runs on the sign-in requests that follow, and the probe never reaches the
handler that verifies a password.

The probe passes only when a single `GET /api/admin/auth/preflight` response can be
matched to exactly one root span that carries `cloudflare.cpu_time_ms`.

## 1. Enable traces only on the future temporary staff Worker

Traces must be scoped to the temporary Worker `certpath-staff-cpu` and nothing
else. The committed [`apps/web/wrangler.jsonc`](../../apps/web/wrangler.jsonc)
keeps `"observability": { "enabled": true }`, which is **logs only**; it is not
edited by this run, so `certpath-site`, `certpath-ui-preview`, and every learner
path keep their current deployments and their current telemetry.

Traces are enabled by a **run-only, uncommitted** Wrangler config created next to
the existing ones as `apps/web/wrangler.staff-cpu.jsonc`. It is deleted after the
run (runbook teardown step 1) and must never be committed; `git status` must show
`apps/web/wrangler.jsonc` unchanged.

Differences from the committed config, and nothing else:

```jsonc
{
	"name": "certpath-staff-cpu",
	// "triggers" removed: no cron invocations, so no extra Free trace ingestion
	// and no unrelated spans in the trace filter
	"vars": {
		"INDEXING_ENABLED": "false",
		"PUBLIC_SITE_ORIGIN": "https://certpath-staff-cpu.<subdomain>.workers.dev"
	},
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "certpath-staff-cpu",
			"database_id": "<recorded temporary D1 UUID>"
		}
	],
	"observability": {
		"enabled": true,
		"traces": { "enabled": true }
	}
}
```

- `"traces": { "enabled": true }` is required: Cloudflare documents that
  `observability.enabled` alone enables logs only, and the sample rate defaults to
  `1`, so 100% of requests to this Worker are traced without a trace rule
  ([Workers Traces](https://developers.cloudflare.com/workers/observability/traces/)).
- The tester flags (`STAFF_MFA_MAX_AGE_MS`, `STAFF_MFA_ALLOWED_METHODS=tester-gate`,
  `ADMIN_TESTER_ASSURANCE=true`, `ADMIN_TESTER_IPS`, `ADMIN_TESTER_LOCAL` unset) and
  the two fresh HMAC secrets (`CSRF_HMAC_SECRET`,
  `STAFF_RATE_LIMIT_HMAC_SECRET`) come from runbook setup step 3. The secrets are
  Worker secrets on this temporary Worker only.
- Workers Traces is included on Workers Free with a daily ingestion cap
  ([Observability pricing](https://developers.cloudflare.com/observability/pricing/)),
  so this stays at $0; exporting traces to a third party would need Workers Paid
  and is off.

Review checklist for this step: traces enabled **only** in the run-only config, no
edit to `apps/web/wrangler.jsonc`, no cron trigger on the temporary Worker, and no
change to the site or demo deployment. The approved deployment itself uses
`wrangler deploy --config apps/web/wrangler.staff-cpu.jsonc`.

## 2. Send the one request

Runbook identifiers and preflight must already be recorded, and the six-request
counter is at **0 before** this step. The request is unauthenticated and has no
body, no cookie, and no `Authorization` header; `preflight` only reads
configuration.

```powershell
$worker = 'https://certpath-staff-cpu.<subdomain>.workers.dev'
curl.exe -sS -D "$env:TEMP\probe-headers.txt" -o "$env:TEMP\probe-body.json" `
  -H "X-CPU-Run-Id: staff-cpu-01" `
  "$worker/api/admin/auth/preflight"
```

The `X-CPU-Run-Id` is a unique local label for this run. It is not a correlation
key for the trace: header **values** are not captured in spans.

Issuing this request spends **request 1 of 6**. Do not open the Worker's own pages
in a browser. Do not retry: a request that fails here ends the run.

## 3. Confirm both readiness flags

```powershell
Get-Content "$env:TEMP\probe-body.json"
```

The response must be `200` with `signInEnabled: true` and
`testerAssuranceEnabled: true`, as served by the `GET /preflight` handler in
`apps/api/src/staff-auth.ts`.

| Observed | Meaning | Action |
|---|---|---|
| `200` with both flags `true` | sign-in and tester assurance enabled | continue |
| `200` with either flag `false` | sign-in unavailable on this deployment | **stop**, report |
| `403` | caller IP is not on `ADMIN_TESTER_IPS` | **stop**, report |
| `503` | the tester gate is closed (empty allowlist) | **stop**, report |
| anything else | unexpected deployment state | **stop**, report |

`POST` is not interchangeable: the route is registered as `GET`, so a `POST`
answers `404` and cannot confirm the flags.

## 4. Record the response's `Cf-Ray`

```powershell
Select-String -Path "$env:TEMP\probe-headers.txt" -Pattern '^cf-ray:', '^x-request-id:'
```

`Cf-Ray` is the Ray ID of this request, returned on the response
([Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)).
Keep the **full header value exactly as received** as the run's evidence, including
its trailing data-centre segment - for example `8f2c1a3b4d5e6f70-SJC`. Never
truncate, reformat, or normalise it in the headers file.

The value used for the trace lookup is that same Ray ID **without the colo
segment**: drop the final `-<COLO>` part and keep the leading identifier, so
`8f2c1a3b4d5e6f70-SJC` becomes `8f2c1a3b4d5e6f70`. Record both forms in the report:
the full header as evidence, the bare Ray ID as the lookup key. If the header
carries no trailing `-<COLO>` segment, the whole value is the lookup key.

`X-Request-Id` is recorded for the report as an optional cross-check; it is not the
join key either.

If the response carries no `Cf-Ray`, the probe cannot be matched: **stop**.

## 5. Wait up to 30 seconds for the root span

Open Workers & Pages, select the temporary Worker `certpath-staff-cpu`, then
**Observability** → **Traces**, with a time range covering the probe, and filter
with the bare Ray ID from step 4:

```text
cloudflare.ray_id = "<Cf-Ray without its colo segment>"
```

Cloudflare documents exactly this filter for finding the trace of one request
([Traces FAQ](https://developers.cloudflare.com/observability/traces/)). Retain the
full `Cf-Ray` header in the evidence file; the filter is the only place the colo
segment is dropped. Wait up to **30 seconds** and issue no further request while
waiting. If no span appears, telemetry is missing: **stop**.

## 6. Match exactly one root span

Ray IDs repeat, so the Ray ID alone is never accepted. Require **exactly one**
matching root span whose attributes agree on all five points:

| Attribute | Must equal |
|---|---|
| `cloudflare.ray_id` | the bare Ray ID from step 4 (the `Cf-Ray` value without its colo segment) |
| `cloudflare.script_name` and `faas.name` | `certpath-staff-cpu` |
| `url.path` | `/api/admin/auth/preflight` |
| `http.request.method` | `GET` |
| span timestamp | the response time, to the second |

Also record `faas.invocation_id` for the sample, and check `faas.trigger` is
`http`. Attribute names and semantics are documented in [Spans and
attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/).

Any of these makes the trace **missing or ambiguous** and stops the probe before
anything else is requested: zero spans for the bare Ray ID, more than one candidate
root span, or disagreement on Worker name, path, method, or timestamp.

## 7. Read `cloudflare.cpu_time_ms`

On that single matched root span, read `cloudflare.cpu_time_ms`. Cloudflare
documents the field as "The CPU time used by the Worker invocation, **in
milliseconds**", so the number is recorded **raw, unmodified, in milliseconds**:
no conversion and no unit inferred from the value's size.

- Record `cloudflare.wall_time_ms` beside it for context only. Wall time is never a
  substitute for CPU.
- Record `cloudflare.outcome`; a healthy probe is `ok`.
- A root span without `cloudflare.cpu_time_ms` is a **missing CPU value**: stop.

## 8. Decision rules for the probe

| Observed | Action |
|---|---|
| `cloudflare.cpu_time_ms` present and at or below 5 ms, one span matched | Probe passes; the run may continue to request 2 |
| `cloudflare.cpu_time_ms` above 5 ms and below 10 ms | **Hold for review.** Publish the sample and stop measuring |
| `cloudflare.cpu_time_ms` at or above 10 ms | **Stop.** No further requests |
| `cloudflare.outcome` is `exceededCpu`, or the response is error `1102` / `Worker exceeded resource limits` | **Stop immediately**, even when no CPU value is available ([Limits](https://developers.cloudflare.com/workers/platform/limits/)) |
| No matching span within 30 s, an ambiguous match, or a missing `cloudflare.cpu_time_ms` | **Stop immediately**: telemetry is missing or ambiguous |

The probe is exempt from nothing: these rules apply to it exactly as they apply to
every later request, and **a failed probe ends the run on the spot**. There is no
repeat probe and no retry, and **no password is ever submitted after a probe
stop** - not with a changed payload, a different address, or a second run id.

## 9. Cap accounting

| Item | Value |
|---|---|
| Requests spent by this probe | **1** (`staff-cpu-01`) |
| Requests remaining after a pass | 4 usable, request 6 unused |
| Passwords submitted during the probe | **0** |
| Requests remaining after a stop | none; the run ends with at most 1 request spent, no password submitted, and request 6 unused |

The cap stays at six. A failed probe ends the run immediately: request 2 is never
spent re-running the probe, and the remaining requests are abandoned rather than
retried.

## 10. Evidence to bring back for review

1. `probe-headers.txt` and `probe-body.json` captured above.
2. The body showing both flags `true`, or the failure status.
3. The **full `Cf-Ray` header value as received** (evidence), the bare Ray ID
   derived from it (lookup key), and `faas.invocation_id`.
4. The single matched root span's attribute list (or a screenshot of the trace
   detail panel) showing `cloudflare.ray_id`, `cloudflare.script_name`/`faas.name`,
   `url.path`, `http.request.method`, and the timestamp.
5. The raw `cloudflare.cpu_time_ms` in milliseconds, plus `cloudflare.wall_time_ms`
   and `cloudflare.outcome` for context.
6. Requests used out of six, the rule that decided the outcome, and whether the run
   continues, holds, or stops. A stop reports that no retry was made and no
   password was submitted.

## 11. Teardown when the probe stops the run

A stop at the probe is a stop of the whole run, so runbook teardown applies in
full: delete the uncommitted `apps/web/wrangler.staff-cpu.jsonc`, attempt **both**
the Worker and D1 deletions even if one fails, and verify with provider inventory
that both are gone. Persisted traces expire under Free retention; there is no
separate trace resource to delete, and nothing is exported.

## Invariants

The probe changes no product rule, no Worker behaviour, and no committed
configuration. The public site and demo stay live at $0, email stays off, Google
OAuth stays paused, staff MFA stays parked, and no production database, account, or
secret is created or touched until the owner approves provisioning.
