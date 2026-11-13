import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export interface CleanupManifest {
  functionName: string;
  logGroup: string;
  region: string;
  roleName: string;
  rolePolicyName: string;
}

export interface AwsCommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface CleanupIssue {
  action: string;
  detail: string;
  resource: string;
}

export interface CleanupReport {
  attemptedActions: string[];
  complete: boolean;
  deleteErrors: CleanupIssue[];
  remaining: CleanupIssue[];
}

export type AwsCommandExecutor = (
  args: readonly string[],
) => Promise<AwsCommandResult>;

const expectedRolePolicyName = "CertPathScryptBenchmarkLogs";

export function parseCleanupManifest(value: unknown): CleanupManifest {
  assertRecord(value);
  const manifest: CleanupManifest = {
    functionName: requireString(value.functionName, "functionName"),
    logGroup: requireString(value.logGroup, "logGroup"),
    region: requireString(value.region, "region"),
    roleName: requireString(value.roleName, "roleName"),
    rolePolicyName: requireString(value.rolePolicyName, "rolePolicyName"),
  };

  const validFunctionName =
    /^certpath-scrypt-lambda-proof-\d{14}-[a-f0-9]{12}$/.test(
      manifest.functionName,
    );
  if (!validFunctionName) {
    throw new Error("Cleanup manifest has an invalid benchmark function name");
  }
  if (manifest.roleName !== `${manifest.functionName}-exec`) {
    throw new Error("Cleanup manifest role name does not match the function");
  }
  if (manifest.logGroup !== `/aws/lambda/${manifest.functionName}`) {
    throw new Error("Cleanup manifest log group does not match the function");
  }
  if (manifest.rolePolicyName !== expectedRolePolicyName) {
    throw new Error("Cleanup manifest has an unexpected inline policy name");
  }
  if (!/^[a-z0-9-]+$/.test(manifest.region)) {
    throw new Error("Cleanup manifest has an invalid AWS region");
  }
  return manifest;
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cleanup manifest must be a JSON object");
  }
}

function requireString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Cleanup manifest is missing ${key}`);
  }
  return value;
}

function resultText(result: AwsCommandResult): string {
  return `${result.stderr}\n${result.stdout}`.trim();
}

function isMissingResource(result: AwsCommandResult): boolean {
  return /ResourceNotFound(?:Exception)?|NoSuchEntity(?:Exception)?|NotFoundException/i.test(
    resultText(result),
  );
}

function conciseDetail(result: AwsCommandResult): string {
  return resultText(result).replace(/\s+/g, " ").slice(0, 500);
}

async function executeSafely(
  executor: AwsCommandExecutor,
  args: readonly string[],
): Promise<AwsCommandResult> {
  try {
    return await executor(args);
  } catch (error) {
    return {
      exitCode: 1,
      stderr: error instanceof Error ? error.message : "AWS command failed",
      stdout: "",
    };
  }
}

function awsCli(args: readonly string[]): Promise<AwsCommandResult> {
  return new Promise((resolve) => {
    execFile(
      "aws",
      [...args],
      { encoding: "utf8", maxBuffer: 1_048_576 },
      (error, stdout, stderr) => {
        const code = error
          ? typeof error.code === "number"
            ? error.code
            : 127
          : 0;
        resolve({ exitCode: code, stderr, stdout });
      },
    );
  });
}

function lambdaArgs(
  command: string,
  manifest: CleanupManifest,
): string[] {
  return [
    "lambda",
    command,
    "--function-name",
    manifest.functionName,
    "--region",
    manifest.region,
    "--no-cli-pager",
  ];
}

export async function cleanupBenchmarkResources(
  manifest: CleanupManifest,
  executor: AwsCommandExecutor,
): Promise<CleanupReport> {
  const actions = [
    {
      action: "lambda delete-function-url-config",
      args: lambdaArgs("delete-function-url-config", manifest),
      resource: `Function URL config ${manifest.functionName}`,
    },
    {
      action: "lambda delete-function",
      args: lambdaArgs("delete-function", manifest),
      resource: `Lambda function ${manifest.functionName}`,
    },
    {
      action: "logs delete-log-group",
      args: [
        "logs",
        "delete-log-group",
        "--log-group-name",
        manifest.logGroup,
        "--region",
        manifest.region,
        "--no-cli-pager",
      ],
      resource: `CloudWatch log group ${manifest.logGroup}`,
    },
    {
      action: "iam delete-role-policy",
      args: [
        "iam",
        "delete-role-policy",
        "--role-name",
        manifest.roleName,
        "--policy-name",
        manifest.rolePolicyName,
        "--no-cli-pager",
      ],
      resource: `IAM inline policy ${manifest.roleName}/${manifest.rolePolicyName}`,
    },
    {
      action: "iam delete-role",
      args: [
        "iam",
        "delete-role",
        "--role-name",
        manifest.roleName,
        "--no-cli-pager",
      ],
      resource: `IAM role ${manifest.roleName}`,
    },
  ];

  const attemptedActions: string[] = [];
  const deleteErrors: CleanupIssue[] = [];
  for (const item of actions) {
    attemptedActions.push(item.action);
    const result = await executeSafely(executor, item.args);
    if (result.exitCode !== 0 && !isMissingResource(result)) {
      deleteErrors.push({
        action: item.action,
        detail: conciseDetail(result),
        resource: item.resource,
      });
    }
  }

  const checks = [
    {
      action: "lambda get-function-url-config",
      args: lambdaArgs("get-function-url-config", manifest),
      resource: `Function URL config ${manifest.functionName}`,
      isPresent: () => true,
    },
    {
      action: "lambda get-function-configuration",
      args: lambdaArgs("get-function-configuration", manifest),
      resource: `Lambda function ${manifest.functionName}`,
      isPresent: () => true,
    },
    {
      action: "logs describe-log-groups",
      args: [
        "logs",
        "describe-log-groups",
        "--log-group-name-prefix",
        manifest.logGroup,
        "--query",
        "logGroups[].logGroupName",
        "--output",
        "json",
        "--region",
        manifest.region,
        "--no-cli-pager",
      ],
      resource: `CloudWatch log group ${manifest.logGroup}`,
      isPresent: (stdout: string): boolean | null => {
        try {
          const names: unknown = JSON.parse(stdout);
          if (!Array.isArray(names)) {
            return null;
          }
          return names.includes(manifest.logGroup);
        } catch {
          return null;
        }
      },
    },
    {
      action: "iam get-role",
      args: [
        "iam",
        "get-role",
        "--role-name",
        manifest.roleName,
        "--no-cli-pager",
      ],
      resource: `IAM role ${manifest.roleName}`,
      isPresent: () => true,
    },
    {
      action: "iam get-role-policy",
      args: [
        "iam",
        "get-role-policy",
        "--role-name",
        manifest.roleName,
        "--policy-name",
        manifest.rolePolicyName,
        "--no-cli-pager",
      ],
      resource: `IAM inline policy ${manifest.roleName}/${manifest.rolePolicyName}`,
      isPresent: () => true,
    },
  ];

  const remaining: CleanupIssue[] = [];
  for (const check of checks) {
    const result = await executeSafely(executor, check.args);
    if (result.exitCode === 0) {
      const present = check.isPresent(result.stdout);
      if (present === true) {
        remaining.push({
          action: check.action,
          detail: "Resource still exists after cleanup",
          resource: check.resource,
        });
      } else if (present === null) {
        remaining.push({
          action: check.action,
          detail: "Could not parse the resource verification response",
          resource: check.resource,
        });
      }
    } else if (!isMissingResource(result)) {
      remaining.push({
        action: check.action,
        detail: conciseDetail(result),
        resource: check.resource,
      });
    }
  }

  return {
    attemptedActions,
    complete: remaining.length === 0,
    deleteErrors,
    remaining,
  };
}

export async function cleanupFromManifestPath(
  manifestPath: string,
  executor: AwsCommandExecutor,
): Promise<CleanupReport> {
  const manifestContents = await readFile(manifestPath, "utf8");
  const manifest = parseCleanupManifest(JSON.parse(manifestContents));
  return cleanupBenchmarkResources(manifest, executor);
}

async function main(): Promise<void> {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    throw new Error("Usage: node cleanup.mjs <run-manifest.json>");
  }
  const report = await cleanupFromManifestPath(manifestPath, awsCli);

  for (const issue of report.deleteErrors) {
    console.error(
      JSON.stringify({ kind: "cleanup-delete-error", ...issue }),
    );
  }
  for (const issue of report.remaining) {
    console.error(JSON.stringify({ kind: "cleanup-remains", ...issue }));
  }
  console.log(
    JSON.stringify({
      attemptedActions: report.attemptedActions,
      complete: report.complete,
      deleteErrors: report.deleteErrors.length,
      kind: "cleanup-summary",
      remaining: report.remaining,
    }),
  );
  if (!report.complete) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown failure";
    console.error(JSON.stringify({ error: message, kind: "cleanup-failure" }));
    process.exitCode = 1;
  });
}
