# Learner scrypt Lambda benchmark: CloudShell runbook

**Status:** Local harness prepared; no AWS resources created and no benchmark
requests sent.
**Branch/base:** `feat/learner-auth-lambda-proof` from
`d923abdddafd865421566ffe60c829bd4cf959e2` (`origin/main`).
**Invoker:** AWS CloudShell using its current AWS session, as selected by the
owner for this synthetic-only run. This replaces the earlier proposal to use a
Cloudflare Worker as the caller for this benchmark only.
**Scope:** One temporary Lambda Event Function and IAM-authenticated Function
URL. No Cloudflare deployment, email, D1, Cognito, learner sign-in, or staff
MFA.

## What the local harness does

- Bundles the existing
  [`password-hashing.ts`](../../apps/api/src/security/password-hashing.ts)
  directly into both the Lambda handler and the CloudShell runner. The profile
  remains scrypt `N=32768`, `r=8`, `p=1`, 16-byte salt, 32-byte derived key,
  and the current PHC-style format.
- Generates random synthetic passwords inside the runner. It keeps passwords
  and hashes in memory only, and writes neither to logs nor output.
- Signs Function URL requests with the CloudShell session's default AWS
  credential provider. No access key is copied to a file or passed to a
  Cloudflare Worker.
- Starts with sequential hash and verification checks, then verifies a hash
  created by the runner's local copy of CertPath's hashing module and rejects
  a wrong synthetic password. It then runs one mixed hash/verify wave at
  concurrency two and another at four.
- Enforces a total limit of ten Lambda requests and a maximum of four requests
  in flight. It reports the observed maximum. It makes no retries and stops on
  any failed request, including throttling; a failed wave is allowed to settle
  its already-started requests, but no further wave is started.
- Reports Lambda-reported CPU user/system time, handler elapsed time, process
  RSS observations, cold/warm status, and CloudShell-to-Lambda round-trip
  time. Worker-to-Lambda signing and latency are untested by this CloudShell
  runner. CloudWatch `REPORT` lines are the source for billed duration, Lambda
  `Max Memory Used`, and cold-start `Init Duration`. Process RSS is a
  process-lifetime high-water mark, not a per-invocation peak.
- Never logs request or response bodies, the generated hash, or credentials.

## Preflight evidence and cost boundary

| Check | Current evidence | Interpretation |
|---|---|---|
| AWS account plan | Owner-confirmed `FREE / ACTIVE`; Billing showed $100 remaining credits and expiry 11 May 2027. | Recheck immediately before the run. Stop if the plan is not Free/Active, credits are exhausted, or AWS asks for payment or an upgrade. |
| Recurring Free Tier usage | `get-free-tier-usage` returned `[]` twice for Lambda, CloudWatch, and data transfer. | Unknown, not zero usage and not proof of available allowance. |
| Lambda account quotas | Owner-provided Service Quotas output showed a regional limit of 10 concurrent executions and 8 GB maximum allocated x86_64 MicroVM memory. | The runner caps at four in flight; check that at least four executions are currently unreserved before creating resources and again before invoking. No function-level reserved concurrency is configured. The memory quota's applicability to this Event Function must still be confirmed in the account. |
| Function URL in `eu-north-1` | Published AWS documentation indicates Stockholm support; the Regional Services feature row has not been independently verified. | Verify the feature row before creating resources. Stop if unavailable or uncertain. |
| Actual benchmark charges | No benchmark has run. | No charge or credit use has been observed. |

The run is deliberately bounded to ten calls, no more than four in flight,
1,769 MB, and a three-second timeout. At the timeout ceiling, the maximum
Lambda compute envelope is approximately:

`10 × 1.769 GB × 3 seconds = 53.1 GB-seconds`

AWS's Free Tier usage result is unknown, so do not claim this is covered by
recurring free usage. If billable, the Free Plan's temporary credits may cover
it; record any credit change separately. The Billing screen previously said
usage was covered by credits. This is not a hard spend cap: if the active Free
Plan or credit balance changes, stop before provisioning. Review billing again
after the run because usage and credit reporting can be delayed.

## Required permissions

Use the IAM Policy Simulator on the current CloudShell user/role before
creating anything. The CLI simulation is read-only. Substitute the unique
function, role, and log-group ARNs created in the next section, and evaluate
the actions against their corresponding resource ARN.

| Phase | Required actions |
|---|---|
| Read-only preflight | `sts:GetCallerIdentity`, `freetier:GetAccountPlanState`, `freetier:GetFreeTierUsage`, `lambda:GetAccountSettings`, `iam:SimulatePrincipalPolicy`. `iam:ListRoles` is only needed if using the CLI to resolve an assumed-role ARN to its IAM role ARN. |
| Create/configure | `iam:CreateRole`, `iam:PutRolePolicy`, `iam:PassRole`; `logs:CreateLogGroup`, `logs:PutRetentionPolicy`; `lambda:CreateFunction`, `lambda:GetFunctionConfiguration`, `lambda:CreateFunctionUrlConfig`, `lambda:GetFunctionUrlConfig`. |
| Invoke/measure | `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` on the function; `logs:FilterLogEvents` on its log group. |
| Teardown | `lambda:DeleteFunctionUrlConfig`, `lambda:DeleteFunction`; `logs:DeleteLogGroup`; `iam:DeleteRolePolicy`, `iam:DeleteRole`. |

The Lambda execution role itself needs only `logs:CreateLogStream` and
`logs:PutLogEvents` on this function's log group. It has no application,
database, Cognito, email, or credential permissions. For same-account
`AWS_IAM` Function URLs, the caller's identity policy can grant both invoke
actions; this runbook does not add a resource-based policy or modify the
CloudShell caller's permissions.

If a simulation result is not `allowed`, stop before the corresponding
operation and note the exact action and decision. If the simulation API itself
is denied, the missing check permission is `iam:SimulatePrincipalPolicy`; use
the IAM Policy Simulator console instead. A simulator result is not a
guarantee against Organizations controls or session policies. If an actual
AWS call returns `AccessDenied`, retain the AWS error's exact `not authorized
to perform: <action>` value, stop, and do not broaden permissions. If an
operation prompts for payment or an upgrade, stop immediately.

## Runbook

### 1. Build and upload the local bundles

On the repository checkout:

```powershell
npm ci
npm run verify
npm run benchmark:lambda:package
```

This creates `apps/api/dist/lambda-scrypt-benchmark/handler.mjs` and
`runner.mjs`; the directory is ignored by Git. In AWS CloudShell, use
**Actions → Upload file** to upload both files to the same working directory.
The runner bundle contains its SigV4 dependencies; no AWS credentials are
embedded in either bundle.

### 2. Confirm account, region, and quota

In CloudShell:

```bash
set -euo pipefail
export AWS_REGION=eu-north-1
export AWS_DEFAULT_REGION="$AWS_REGION"

aws freetier get-account-plan-state --region us-east-1 \
  --query '{Plan:accountPlanType,Status:accountPlanStatus,Expires:accountPlanExpirationDate,Credits:accountPlanRemainingCredits}' \
  --output json --no-cli-pager

aws freetier get-free-tier-usage --region us-east-1 \
  --query "freeTierUsages[?contains(service, 'Lambda') || contains(service, 'CloudWatch') || contains(usageType, 'DataTransfer')].{Service:service,Region:region,UsageType:usageType,Actual:actualUsageAmount,Forecast:forecastedUsageAmount,Limit:limit,Unit:unit,FreeTierType:freeTierType}" \
  --output table --no-cli-pager

check_unreserved_concurrency() {
  local limits unreserved
  limits="$(aws lambda get-account-settings --region "$AWS_REGION" \
    --query 'AccountLimit.{Concurrent:ConcurrentExecutions,Unreserved:UnreservedConcurrentExecutions}' \
    --output json --no-cli-pager)"
  unreserved="$(jq -r '.Unreserved // empty' <<< "$limits")"
  printf 'Lambda concurrency limits: %s\n' "$limits"
  if [[ ! "$unreserved" =~ ^[0-9]+$ ]] || (( unreserved < 4 )); then
    printf 'STOP: fewer than four unreserved Lambda executions are available.\n' >&2
    return 1
  fi
}

check_unreserved_concurrency
```

Confirm `FREE`, `ACTIVE`, and a positive credit balance. Treat an empty usage
table as **unknown**. `check_unreserved_concurrency` must report at least four
unreserved executions; stop if the value is missing or lower.
In the AWS Regional Services feature list, filter **Feature Name = Function
URLs** and confirm **Europe (Stockholm), `eu-north-1`**. Do not continue until
that region is listed. If the plan, credits, quota, or regional availability
does not pass, stop here.

### 3. Simulate permissions before creating resources

Choose a unique suffix and construct these resource names locally:

```bash
SUFFIX="$(date -u +%Y%m%d%H%M%S)"
FUNCTION_NAME="certpath-scrypt-lambda-proof-$SUFFIX"
ROLE_NAME="${FUNCTION_NAME}-exec"
LOG_GROUP="/aws/lambda/$FUNCTION_NAME"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
FUNCTION_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
LOG_GROUP_ARN="arn:aws:logs:${AWS_REGION}:${ACCOUNT_ID}:log-group:${LOG_GROUP}"
```

Use the IAM Policy Simulator for the current CloudShell user or role. For a
CLI simulation, `--policy-source-arn` must be the IAM user/role ARN, not an
STS assumed-role session ARN. Set `PRINCIPAL_ARN` to that IAM ARN in the
CloudShell shell; do not put it in this repository. Evaluate:

- The create/invoke/delete Lambda actions in the permissions table against
  `$FUNCTION_ARN`. For Function URL actions, supply context
  `lambda:FunctionUrlAuthType=AWS_IAM`.
- Role create/read/policy/delete actions against `$ROLE_ARN`; simulate
  `iam:PassRole` separately with context
  `iam:PassedToService=lambda.amazonaws.com`.
- Log create/retention/read/delete actions against `$LOG_GROUP_ARN` (use
  `*` only if the action's IAM resource definition requires it).
- `freetier:GetAccountPlanState`, `freetier:GetFreeTierUsage`,
  `lambda:GetAccountSettings`, and `sts:GetCallerIdentity` against `*`.

Proceed only when every required operation is allowed. Do not attach policies
or request an upgrade as part of this runbook.

For a CloudShell CLI simulation, identify the IAM principal ARN (not the STS
session ARN) in the IAM console and set it locally:

```bash
export PRINCIPAL_ARN='arn:aws:iam::<account>:role/<cloudshell-role>'
```

After constructing the resource ARNs above, use this helper for the read-only
checks. `MissingContextValues` or any decision other than `allowed` means stop
before resource creation:

```bash
simulate_actions() {
  local resource_arn="$1"
  shift
  local context_args=()
  while [[ "$1" == ContextKeyName=* ]]; do
    context_args+=(--context-entries "$1")
    shift
  done
  local result
  result="$(aws iam simulate-principal-policy \
    --policy-source-arn "$PRINCIPAL_ARN" \
    --action-names "$@" \
    --resource-arns "$resource_arn" \
    "${context_args[@]}" \
    --query 'EvaluationResults[].{Action:EvalActionName,Decision:EvalDecision,MissingContext:MissingContextValues}' \
    --output json --no-cli-pager)"
  printf '%s\n' "$result"
  jq -e 'length > 0 and all(.[]; .Decision == "allowed" and ((.MissingContext // []) | length == 0))' \
    <<< "$result" >/dev/null
}

simulate_actions '*' \
  freetier:GetAccountPlanState freetier:GetFreeTierUsage \
  lambda:GetAccountSettings
simulate_actions "$FUNCTION_ARN" \
  ContextKeyName=lambda:FunctionUrlAuthType,ContextKeyValues=AWS_IAM,ContextKeyType=string \
  ContextKeyName=lambda:InvokedViaFunctionUrl,ContextKeyValues=true,ContextKeyType=boolean \
  lambda:CreateFunction lambda:GetFunctionConfiguration \
  lambda:CreateFunctionUrlConfig lambda:GetFunctionUrlConfig \
  lambda:DeleteFunctionUrlConfig lambda:InvokeFunctionUrl \
  lambda:InvokeFunction lambda:DeleteFunction
simulate_actions "$ROLE_ARN" \
  iam:CreateRole iam:GetRole iam:PutRolePolicy iam:GetRolePolicy \
  iam:DeleteRolePolicy iam:DeleteRole
simulate_actions "$ROLE_ARN" \
  ContextKeyName=iam:PassedToService,ContextKeyValues=lambda.amazonaws.com,ContextKeyType=string \
  iam:PassRole
simulate_actions "$LOG_GROUP_ARN" \
  logs:CreateLogGroup logs:PutRetentionPolicy \
  logs:FilterLogEvents logs:DeleteLogGroup
```

The simulator itself requires `iam:SimulatePrincipalPolicy`. If it is denied,
use the console simulator and do not proceed until the same action set passes.
If `iam:CreateRole`, `iam:PassRole`, function invocation, or teardown is
denied, record the exact action and stop; do not attach a wider policy.

### 4. Create the isolated function

In the directory containing the uploaded bundles:

```bash
WORK_DIR="$(mktemp -d)"
cp handler.mjs "$WORK_DIR/handler.mjs"
cp runner.mjs "$WORK_DIR/runner.mjs"
cd "$WORK_DIR"
zip -q function.zip handler.mjs

cat > trust-policy.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "lambda.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
JSON

ROLE_ARN="$(aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document file://trust-policy.json \
  --query Role.Arn --output text)"

aws logs create-log-group --log-group-name "$LOG_GROUP"
aws logs put-retention-policy \
  --log-group-name "$LOG_GROUP" --retention-in-days 1

cat > execution-role-policy.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
    "Resource": "${LOG_GROUP_ARN}:*"
  }]
}
JSON

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name CertPathScryptBenchmarkLogs \
  --policy-document file://execution-role-policy.json

sleep 8
aws lambda create-function \
  --function-name "$FUNCTION_NAME" \
  --runtime nodejs22.x \
  --handler handler.handler \
  --role "$ROLE_ARN" \
  --zip-file fileb://function.zip \
  --timeout 3 \
  --memory-size 1769 \
  --architectures x86_64 \
  --query '{FunctionName:FunctionName,State:State,MemorySize:MemorySize,Timeout:Timeout}' \
  --output json
```

Wait until `State` is `Active`, then create and verify the IAM-authenticated
Function URL. Do not configure function-level reserved concurrency:

```bash
FUNCTION_URL="$(aws lambda create-function-url-config \
  --function-name "$FUNCTION_NAME" \
  --auth-type AWS_IAM \
  --query FunctionUrl --output text)"

aws lambda get-function-url-config \
  --function-name "$FUNCTION_NAME" \
  --query AuthType --output text
```

Keep the URL in the shell variable. Do not paste it into public chat; the
endpoint should remain limited to the benchmark.

### 5. Run the bounded benchmark

The runner uses the current CloudShell session through the AWS SDK credential
provider; it does not create access keys. It sends no calls before this step.

```bash
RUN_START_MS="$(( $(date +%s) * 1000 ))"
export LAMBDA_FUNCTION_URL="$FUNCTION_URL"
export AWS_REGION
check_unreserved_concurrency
node runner.mjs | tee benchmark-results.jsonl
```

Each JSON line contains only stage, operation, status, request ID, timings,
and memory/cold-start metrics. The summary includes the total request count
and maximum observed in-flight count. It contains no password or hash. A
nonzero exit, timeout, HTTP 403, HTTP 429 throttling response, resource-limit
error, or failed check ends the run; do not retry and do not continue to a
higher concurrency. Requests already started in the current wave are allowed
to finish before the runner exits.

Collect the Lambda `REPORT` lines after the invocation logs appear:

```bash
aws logs filter-log-events \
  --log-group-name "$LOG_GROUP" \
  --start-time "$RUN_START_MS" \
  --filter-pattern '"REPORT RequestId"' \
  --query 'events[].message' \
  --output text --no-cli-pager
```

Record each invocation's `Duration`, `Billed Duration`, `Memory Size`,
`Max Memory Used`, and, for cold starts, `Init Duration`. Match its request ID
to `benchmark-results.jsonl`. If CloudWatch denies access, record the exact
missing action (expected: `logs:FilterLogEvents`) and mark those metrics
unavailable; do not rerun scrypt just to recover metrics.

### 6. Tear down and verify

Run teardown even if the benchmark failed. Only run each delete command for
resources that were successfully created; keep the variable values from the
same CloudShell session:

```bash
aws lambda delete-function-url-config --function-name "$FUNCTION_NAME"
aws lambda delete-function --function-name "$FUNCTION_NAME"
aws logs delete-log-group --log-group-name "$LOG_GROUP"
aws iam delete-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name CertPathScryptBenchmarkLogs
aws iam delete-role --role-name "$ROLE_NAME"
```

Verify the Function URL config, function, log group, role, and inline policy
are absent. A deletion denial is a teardown blocker: retain the exact AWS
error/action and continue cleanup only for independent resources. Do not
report teardown complete until each created resource is confirmed absent.

Finally recheck the account plan/credit balance and Billing/Cost Explorer.
Record (a) recurring Free Tier coverage as **unknown** unless the account
reports it, (b) any temporary-credit delta separately, (c) any delayed or
unavailable billing evidence, and (d) teardown status. PR #15 remains draft;
staff MFA remains parked; both Cognito sandboxes remain untouched.

## Local verification and limitations

Local checks completed:

- `npm run verify` — passed: API typecheck, contract typecheck, 1 API smoke
  test, 95 API tests, 12 Lambda harness tests, 64 web tests, and client/server
  production builds.
- `npm run benchmark:lambda:package` — passed and produced `handler.mjs` and
  `runner.mjs`.
- Bundle smoke test with `LAMBDA_FUNCTION_URL` and `AWS_REGION` unset — passed:
  the runner emitted its expected missing-configuration error, with no module
  resolution or bundling error. No AWS request was sent.

The CloudShell permission simulation, Function URL regional feature check,
deployment, Lambda measurements, billing delta, and teardown have not been
performed by this local preparation.
Worker-to-Lambda signing and latency are explicitly **untested**; this harness
uses the CloudShell AWS session as the direct caller. The local hash checks
execute CertPath's shared hashing module in Node.js, not in a Cloudflare
Workers runtime, so direct Worker-runtime hash parity is also **untested**.

### Official AWS references

- [Function URL IAM authentication and permissions](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html)
- [Invoking Lambda Function URLs](https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html)
- [Node.js Lambda Event Function handlers](https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html)
- [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
- [Viewing Lambda CloudWatch logs](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs-view.html)
- [IAM `simulate-principal-policy` CLI](https://docs.aws.amazon.com/cli/latest/reference/iam/simulate-principal-policy.html)
- [AWS Regional Services feature list](https://builder.aws.com/build/capabilities/explore?tab=service-feature)
- [Lambda pricing](https://aws.amazon.com/lambda/pricing/)
- [AWS Free Tier terms](https://aws.amazon.com/free/terms/)
