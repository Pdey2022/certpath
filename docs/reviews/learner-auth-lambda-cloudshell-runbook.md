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
**Cleanup:** A per-run manifest records the exact resource names before any
resource is created. `cleanup.mjs` attempts every deletion independently and
verifies what remains; keep the manifest until cleanup is confirmed complete.

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
| AWS account plan and credits | Rechecked 13 Nov 2026 in the signed-in AWS Free Tier console: the account is identified as a free-plan account and the credit balance shows `$100.00 remaining`; the owner previously confirmed `FREE / ACTIVE` via CLI. No benchmark resources or invocations have been created. | Recheck plan status and balance immediately before the run. Record temporary-credit changes separately from recurring Free Tier usage. Stop if the plan is not Free/Active, credits are exhausted, or AWS asks for payment or an upgrade. |
| Recurring Free Tier usage | The console shows 0 offers in use; `get-free-tier-usage` returned `[]` twice for Lambda, CloudWatch, and data transfer. | Coverage is unknown, not zero usage and not proof of available allowance. |
| Lambda account quotas | Owner-provided Service Quotas output showed a regional limit of 10 concurrent executions and 8 GB maximum allocated x86_64 MicroVM memory. | The runner caps at four in flight; check that the account reports at least four unreserved executions before creating resources and again before invoking. This is not a reservation and transient competing load may still cause throttling; the runner stops on HTTP 429. No function-level reserved concurrency is configured. The memory quota's applicability to this Event Function must still be confirmed in the account. |
| Function URL in `eu-north-1` | Published AWS documentation indicates Stockholm support; the Regional Services feature row has not been independently verified. | Verify the feature row before creating resources. Stop if unavailable or uncertain. |
| Actual benchmark charges | No benchmark has run. | No charge or credit use has been observed. |

The run is deliberately bounded to ten calls, no more than four in flight,
1,769 MB, and a three-second timeout. At the timeout ceiling, the maximum
Lambda compute envelope is approximately:

`10 × 1.769 GB × 3 seconds = 53.1 GB-seconds`

AWS's Free Tier usage result is unknown, so do not claim this is covered by
recurring free usage. The Free Plan's credits are temporary, not a recurring
allowance; record the starting and ending balance separately. Maintain a
$0 out-of-pocket cap: stop if the plan or credit state is unclear, the balance
cannot cover potential billable usage, or AWS indicates any charge or requests
payment or an upgrade. Review billing after the run because usage and credit
reporting can be delayed.

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
| Teardown and verification | `lambda:DeleteFunctionUrlConfig`, `lambda:DeleteFunction`, `lambda:GetFunctionUrlConfig`, `lambda:GetFunctionConfiguration`; `logs:DeleteLogGroup`, `logs:DescribeLogGroups`; `iam:DeleteRolePolicy`, `iam:DeleteRole`, `iam:GetRole`, `iam:GetRolePolicy`. |

The Lambda execution role itself needs only `logs:CreateLogStream` and
`logs:PutLogEvents` on this function's log group. It has no application,
database, Cognito, email, or credential permissions. For same-account
`AWS_IAM` Function URLs, the caller's identity policy can grant both invoke
actions; this runbook does not add a resource-based policy or modify the
CloudShell caller's permissions. Cleanup verification additionally needs
`logs:DescribeLogGroups`; the function and role verification actions are
already listed above.

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
`runner.mjs` plus `cleanup.mjs`; the directory is ignored by Git. In AWS
CloudShell, create a stable harness directory and upload all three files to
CloudShell's home directory:

```bash
HARNESS_DIR="$HOME/certpath-lambda-scrypt-benchmark"
mkdir -p "$HARNESS_DIR"
cd "$HOME"
```

Use **Actions → Upload file** for `handler.mjs`, `runner.mjs`, and
`cleanup.mjs`, then copy them into the stable location:

```bash
cp "$HOME/handler.mjs" "$HOME/runner.mjs" "$HOME/cleanup.mjs" "$HARNESS_DIR/"
CLEANUP_SCRIPT="$HARNESS_DIR/cleanup.mjs"
printf 'Cleanup script: %s\n' "$CLEANUP_SCRIPT"
```

`CLEANUP_SCRIPT` is an absolute path under the persistent CloudShell home
directory, so invoke it by that path regardless of the current working
directory. The runner bundle contains its SigV4 dependencies; no AWS
credentials are embedded in any bundle. If resuming in a fresh CloudShell
session, use the same CloudShell console Region so the home directory remains
available.

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
SUFFIX="$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 6)"
FUNCTION_NAME="certpath-scrypt-lambda-proof-$SUFFIX"
ROLE_NAME="${FUNCTION_NAME}-exec"
LOG_GROUP="/aws/lambda/$FUNCTION_NAME"
ROLE_POLICY_NAME="CertPathScryptBenchmarkLogs"
RUN_MANIFEST="$HARNESS_DIR/${FUNCTION_NAME}-resources.json"
RUN_MANIFEST_POINTER="$HARNESS_DIR/active-run-manifest"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
FUNCTION_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
LOG_GROUP_ARN="arn:aws:logs:${AWS_REGION}:${ACCOUNT_ID}:log-group:${LOG_GROUP}"

if [[ -e "$RUN_MANIFEST_POINTER" ]]; then
  printf 'STOP: a prior run still needs cleanup; recovery pointer: %s\n' \
    "$RUN_MANIFEST_POINTER" >&2
  exit 1
fi
if [[ -e "$RUN_MANIFEST" ]]; then
  printf 'STOP: manifest already exists: %s\n' "$RUN_MANIFEST" >&2
  exit 1
fi
jq -n \
  --arg region "$AWS_REGION" \
  --arg functionName "$FUNCTION_NAME" \
  --arg logGroup "$LOG_GROUP" \
  --arg roleName "$ROLE_NAME" \
  --arg rolePolicyName "$ROLE_POLICY_NAME" \
  '{region:$region,functionName:$functionName,logGroup:$logGroup,roleName:$roleName,rolePolicyName:$rolePolicyName}' \
  > "$RUN_MANIFEST"
printf '%s\n' "$RUN_MANIFEST" > "$RUN_MANIFEST_POINTER"
chmod 600 "$RUN_MANIFEST"
chmod 600 "$RUN_MANIFEST_POINTER"
printf 'Run resource manifest: %s\n' "$RUN_MANIFEST"
printf 'Recovery pointer: %s\n' "$RUN_MANIFEST_POINTER"
```

The manifest is written before any resource-creation command. It contains only
the exact names for this run, not credentials. The pointer stores the manifest's
full path for recovery and prevents a new run from replacing an unresolved
manifest. Keep the manifest for cleanup even if setup or the benchmark stops
partway through.

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
  lambda:GetAccountSettings logs:DescribeLogGroups
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

```bash
WORK_DIR="$(mktemp -d)"
cp "$HARNESS_DIR/handler.mjs" "$WORK_DIR/handler.mjs"
cp "$HARNESS_DIR/runner.mjs" "$WORK_DIR/runner.mjs"
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
  --policy-name "$ROLE_POLICY_NAME" \
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
to finish before the runner exits. If setup or the runner exits nonzero, skip
to cleanup using the same saved manifest; do not continue the benchmark.

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

Run cleanup after successful completion, a setup failure, a benchmark failure,
or a prior cleanup failure. The script uses the saved manifest and attempts
each deletion independently, including resources whose creation may have
failed or returned ambiguously:

```bash
cd /tmp
if node "$CLEANUP_SCRIPT" "$RUN_MANIFEST"; then
  rm -- "$RUN_MANIFEST_POINTER"
else
  printf 'Cleanup incomplete; keep the manifest and recovery pointer.\n' >&2
  exit 1
fi
```

The command intentionally runs after changing directories: both the script and
manifest paths are absolute. If the CloudShell session closes before cleanup
finishes, start a fresh terminal in the same CloudShell console Region and run
this recovery command. It reads the saved full manifest path; no prior shell
variables are required:

```bash
HARNESS_DIR="$HOME/certpath-lambda-scrypt-benchmark"
CLEANUP_SCRIPT="$HARNESS_DIR/cleanup.mjs"
RUN_MANIFEST="$(cat "$HARNESS_DIR/active-run-manifest")"
if node "$CLEANUP_SCRIPT" "$RUN_MANIFEST"; then
  rm -- "$HARNESS_DIR/active-run-manifest"
else
  printf 'Cleanup incomplete; keep the manifest and recovery pointer.\n' >&2
  exit 1
fi
```

The cleanup output lists any delete errors and every resource still present
or whose absence could not be verified. It verifies the Function URL config,
function, log group, role, and inline policy using the exact names saved before
setup. If cleanup exits nonzero, keep the manifest, resolve the reported
permission or service issue, leave the recovery pointer intact, and rerun the
same cleanup command. The pointer is removed only after cleanup confirms no
resources remain; retain the manifest as a record. Do not report teardown
complete until the script confirms no resources remain.

Finally recheck the account plan/credit balance and Billing/Cost Explorer.
Record (a) recurring Free Tier coverage as **unknown** unless the account
reports it, (b) any temporary-credit delta separately, (c) any delayed or
unavailable billing evidence, and (d) teardown status. PR #15 remains draft;
staff MFA remains parked; both Cognito sandboxes remain untouched.

## Local verification and limitations

Local checks completed:

- `npm run verify` — passed: API typecheck, contract typecheck, 1 API smoke
  test, 95 API tests, 16 Lambda harness tests, 64 web tests, and client/server
  production builds.
- `npm run benchmark:lambda:package` — passed and produced `handler.mjs`,
  `runner.mjs`, and `cleanup.mjs`.
- Mocked AWS CLI cleanup tests — passed for partial setup, benchmark failure,
  failed deletion with exact leftovers, and retry after the failure clears.
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
