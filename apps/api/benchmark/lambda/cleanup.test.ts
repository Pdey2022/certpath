import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanupBenchmarkResources,
  cleanupFromManifestPath,
  parseCleanupManifest,
  type AwsCommandExecutor,
  type CleanupManifest,
} from "./cleanup.ts";

const manifest: CleanupManifest = parseCleanupManifest({
  functionName: "certpath-scrypt-lambda-proof-20261113120000-abcdef012345",
  logGroup:
    "/aws/lambda/certpath-scrypt-lambda-proof-20261113120000-abcdef012345",
  region: "eu-north-1",
  roleName: "certpath-scrypt-lambda-proof-20261113120000-abcdef012345-exec",
  rolePolicyName: "CertPathScryptBenchmarkLogs",
});

type Resource =
  | "functionUrl"
  | "function"
  | "logGroup"
  | "rolePolicy"
  | "role";

const allResources: Resource[] = [
  "functionUrl",
  "function",
  "logGroup",
  "rolePolicy",
  "role",
];

function createMockAws(initial: Resource[] = []) {
  const resources = new Set(initial);
  const failedDeletes = new Set<string>();
  const calls: string[][] = [];

  const executor: AwsCommandExecutor = async (args) => {
    const command = args.slice(0, 2).join(":");
    calls.push([...args]);
    const resourceByCommand: Record<string, Resource> = {
      "lambda:delete-function-url-config": "functionUrl",
      "lambda:get-function-url-config": "functionUrl",
      "lambda:delete-function": "function",
      "lambda:get-function-configuration": "function",
      "logs:delete-log-group": "logGroup",
      "iam:delete-role-policy": "rolePolicy",
      "iam:get-role-policy": "rolePolicy",
      "iam:delete-role": "role",
      "iam:get-role": "role",
    };

    if (command === "logs:describe-log-groups") {
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify(
          resources.has("logGroup") ? [manifest.logGroup] : [],
        ),
      };
    }

    const resource = resourceByCommand[command];
    if (!resource) {
      return {
        exitCode: 1,
        stderr: `Unexpected mock AWS command: ${command}`,
        stdout: "",
      };
    }

    if (command.startsWith("lambda:get-") ||
      command === "iam:get-role" ||
      command === "iam:get-role-policy") {
      return resources.has(resource)
        ? { exitCode: 0, stderr: "", stdout: "{}" }
        : {
            exitCode: 1,
            stderr: "An error occurred (ResourceNotFoundException)",
            stdout: "",
          };
    }

    if (failedDeletes.has(command)) {
      return {
        exitCode: 1,
        stderr: `An error occurred (AccessDeniedException) for ${command}`,
        stdout: "",
      };
    }
    if (command === "iam:delete-role" && resources.has("rolePolicy")) {
      return {
        exitCode: 1,
        stderr: "An error occurred (DeleteConflict)",
        stdout: "",
      };
    }
    if (!resources.has(resource)) {
      return {
        exitCode: 1,
        stderr: "An error occurred (ResourceNotFoundException)",
        stdout: "",
      };
    }

    resources.delete(resource);
    return { exitCode: 0, stderr: "", stdout: "" };
  };

  return { calls, executor, failedDeletes, resources };
}

describe("Lambda benchmark cleanup", () => {
  it("cleans resources left by partial setup using the saved names", async () => {
    const mock = createMockAws(["logGroup", "rolePolicy", "role"]);

    const report = await cleanupBenchmarkResources(manifest, mock.executor);

    expect(report.complete).toBe(true);
    expect(report.remaining).toEqual([]);
    expect(report.attemptedActions).toHaveLength(5);
    expect(mock.calls.map((args) => args.slice(0, 2).join(":"))).toEqual([
      "lambda:delete-function-url-config",
      "lambda:delete-function",
      "logs:delete-log-group",
      "iam:delete-role-policy",
      "iam:delete-role",
      "lambda:get-function-url-config",
      "lambda:get-function-configuration",
      "logs:describe-log-groups",
      "iam:get-role",
      "iam:get-role-policy",
    ]);
    expect(mock.calls.some((args) => args.includes(manifest.functionName)))
      .toBe(true);
    expect(mock.calls.some((args) => args.includes(manifest.logGroup)))
      .toBe(true);
    expect(mock.calls.some((args) => args.includes(manifest.roleName)))
      .toBe(true);
  });

  it("cleans all resources after a benchmark failure", async () => {
    const mock = createMockAws(allResources);

    const report = await cleanupBenchmarkResources(manifest, mock.executor);

    expect(report.complete).toBe(true);
    expect(report.remaining).toEqual([]);
    expect(mock.resources.size).toBe(0);
  });

  it("runs cleanup after switching directories using the absolute manifest path", async () => {
    const manifestDirectory = await mkdtemp(
      join(tmpdir(), "certpath-cleanup-manifest-"),
    );
    const workingDirectory = await mkdtemp(
      join(tmpdir(), "certpath-cleanup-work-"),
    );
    const manifestPath = resolve(manifestDirectory, "run-manifest.json");
    const originalDirectory = process.cwd();

    try {
      await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
      const mock = createMockAws(allResources);
      process.chdir(workingDirectory);

      const report = await cleanupFromManifestPath(
        manifestPath,
        mock.executor,
      );

      expect(isAbsolute(manifestPath)).toBe(true);
      expect(process.cwd()).toBe(workingDirectory);
      expect(report.complete).toBe(true);
      expect(mock.resources.size).toBe(0);
    } finally {
      process.chdir(originalDirectory);
      await rm(manifestDirectory, { force: true, recursive: true });
      await rm(workingDirectory, { force: true, recursive: true });
    }
  });

  it("recovers from the saved full manifest path without prior shell variables", async () => {
    const harnessDirectory = await mkdtemp(
      join(tmpdir(), "certpath-cleanup-recovery-"),
    );
    const manifestPath = resolve(harnessDirectory, "run-manifest.json");
    const pointerPath = resolve(harnessDirectory, "active-run-manifest");

    try {
      await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
      await writeFile(pointerPath, `${manifestPath}\n`, "utf8");

      const freshSessionManifestPath = (await readFile(pointerPath, "utf8"))
        .trim();
      const mock = createMockAws(allResources);
      const report = await cleanupFromManifestPath(
        freshSessionManifestPath,
        mock.executor,
      );

      expect(freshSessionManifestPath).toBe(manifestPath);
      expect(isAbsolute(freshSessionManifestPath)).toBe(true);
      expect(report.complete).toBe(true);
      expect(mock.resources.size).toBe(0);
    } finally {
      await rm(harnessDirectory, { force: true, recursive: true });
    }
  });

  it("attempts independent deletions and reports exact leftovers for retry", async () => {
    const mock = createMockAws(allResources);
    mock.failedDeletes.add("logs:delete-log-group");
    mock.failedDeletes.add("iam:delete-role-policy");

    const firstReport = await cleanupBenchmarkResources(
      manifest,
      mock.executor,
    );

    expect(firstReport.complete).toBe(false);
    expect(firstReport.deleteErrors.map((issue) => issue.resource)).toEqual([
      `CloudWatch log group ${manifest.logGroup}`,
      `IAM inline policy ${manifest.roleName}/${manifest.rolePolicyName}`,
      `IAM role ${manifest.roleName}`,
    ]);
    expect(firstReport.remaining.map((issue) => issue.resource)).toEqual([
      `CloudWatch log group ${manifest.logGroup}`,
      `IAM role ${manifest.roleName}`,
      `IAM inline policy ${manifest.roleName}/${manifest.rolePolicyName}`,
    ]);
    expect(mock.calls.map((args) => args.slice(0, 2).join(":")).slice(0, 5))
      .toEqual([
        "lambda:delete-function-url-config",
        "lambda:delete-function",
        "logs:delete-log-group",
        "iam:delete-role-policy",
        "iam:delete-role",
      ]);

    mock.failedDeletes.clear();
    const retryReport = await cleanupBenchmarkResources(
      manifest,
      mock.executor,
    );

    expect(retryReport.complete).toBe(true);
    expect(retryReport.remaining).toEqual([]);
    expect(mock.resources.size).toBe(0);
  });

  it("rejects a manifest that could target resources from another run", () => {
    expect(() =>
      parseCleanupManifest({
        ...manifest,
        functionName: "unrelated-function",
      }),
    ).toThrow("invalid benchmark function name");
  });
});
