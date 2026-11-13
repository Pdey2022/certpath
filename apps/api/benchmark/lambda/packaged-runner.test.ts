import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const apiDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runnerPath = resolve(
  apiDirectory,
  "dist/lambda-scrypt-benchmark/runner.mjs",
);
const functionUrl = "https://synthetic-url.lambda-url.eu-north-1.on.aws/";

const fixture = {
  accessKeyId: "AKIAFIXTUREACCESS00",
  secretAccessKey: "fixture-secret-access-key-not-real",
  sessionToken: "fixture-session-token-not-real",
};
const secrets = [
  fixture.accessKeyId,
  fixture.secretAccessKey,
  fixture.sessionToken,
  "fixture-container-authorization-token",
];

// Replaces fetch for the Lambda host only and records non-secret facts about
// the signed request, so fixture credentials never reach test output.
const capturePreload = `
import { writeFileSync } from "node:fs";
const expected = JSON.parse(process.env.FIXTURE_EXPECTED);
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!url.hostname.endsWith(".lambda-url.eu-north-1.on.aws")) {
    return realFetch(input, init);
  }
  const headers = new Headers(init.headers);
  const authorization = headers.get("authorization") ?? "";
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\\/(\\d{8})\\/([^/]+)\\/([^/]+)\\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      authorization,
    );
  writeFileSync(
    process.env.CAPTURE_FILE,
    JSON.stringify({
      accessKeyMatches: match?.[1] === expected.accessKeyId,
      hasAmzDate: /^\\d{8}T\\d{6}Z$/.test(headers.get("x-amz-date") ?? ""),
      hasContentHash: /^[0-9a-f]{64}$/.test(
        headers.get("x-amz-content-sha256") ?? "",
      ),
      hasSession: headers.has("x-amz-security-token"),
      method: init.method,
      path: url.pathname,
      region: match?.[3],
      scopeDateMatchesAmzDate:
        match?.[2] === (headers.get("x-amz-date") ?? "").slice(0, 8),
      service: match?.[4],
      signatureWellFormed: Boolean(match),
      signedHeaders: match?.[5]?.split(";") ?? [],
      tokenMatches:
        headers.get("x-amz-security-token") === expected.sessionToken,
    }),
  );
  return new Response("{}", { status: 403 });
};
`;

interface Capture {
  accessKeyMatches: boolean;
  hasAmzDate: boolean;
  hasContentHash: boolean;
  hasSession: boolean;
  method: string;
  path: string;
  region: string;
  scopeDateMatchesAmzDate: boolean;
  service: string;
  signatureWellFormed: boolean;
  signedHeaders: string[];
  tokenMatches: boolean;
}

function node22Path(): string {
  if (process.versions.node.startsWith("22.")) {
    return process.execPath;
  }
  const configured = process.env.CERTPATH_NODE22_PATH;
  if (!configured) {
    throw new Error(
      "Set CERTPATH_NODE22_PATH to a Node.js 22 executable to run the packaged-runner test",
    );
  }
  return configured;
}

describe("packaged Lambda benchmark runner (Node.js 22)", () => {
  const node = node22Path();
  let directory: string;
  let preloadUrl: string;
  let container: Server;
  let containerUrl: string;

  beforeAll(async () => {
    await run(process.execPath, [
      "--import",
      "tsx",
      "benchmark/lambda/package.ts",
    ], { cwd: apiDirectory });
    directory = await mkdtemp(join(tmpdir(), "certpath-packaged-runner-"));
    const preloadPath = join(directory, "capture.mjs");
    await writeFile(preloadPath, capturePreload);
    preloadUrl = pathToFileURL(preloadPath).href;

    container = createServer((request, response) => {
      if (
        request.url !== "/credentials" ||
        request.headers.authorization !== secrets[3]
      ) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          AccessKeyId: fixture.accessKeyId,
          Expiration: new Date(Date.now() + 3_600_000).toISOString(),
          SecretAccessKey: fixture.secretAccessKey,
          Token: fixture.sessionToken,
        }),
      );
    });
    await new Promise<void>((done) => container.listen(0, "127.0.0.1", done));
    containerUrl = `http://127.0.0.1:${(container.address() as AddressInfo).port}/credentials`;
  });

  afterAll(async () => {
    await new Promise((done) => container?.close(done));
    if (directory) {
      await rm(directory, { force: true, recursive: true });
    }
  });

  async function runPackaged(
    credentialEnvironment: Record<string, string>,
    name: string,
  ) {
    const captureFile = join(directory, `${name}.json`);
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.toUpperCase().startsWith("AWS_")) {
        environment[key] = value;
      }
    }
    Object.assign(environment, {
      AWS_CONFIG_FILE: join(directory, "missing-config"),
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_REGION: "eu-north-1",
      AWS_SHARED_CREDENTIALS_FILE: join(directory, "missing-credentials"),
      CAPTURE_FILE: captureFile,
      FIXTURE_EXPECTED: JSON.stringify(fixture),
      LAMBDA_FUNCTION_URL: functionUrl,
      ...credentialEnvironment,
    });
    const version = await run(node, ["-p", "process.versions.node"]);
    expect(version.stdout.trim()).toMatch(/^22\./);

    let output = "";
    let exitCode = 0;
    try {
      const result = await run(
        node,
        ["--import", preloadUrl, runnerPath],
        { env: environment, timeout: 60_000 },
      );
      output = result.stdout + result.stderr;
    } catch (error) {
      const failure = error as { code?: number; stderr?: string; stdout?: string };
      exitCode = failure.code ?? 1;
      output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
    }
    for (const secret of secrets) {
      expect(output.includes(secret)).toBe(false);
    }
    const capture = JSON.parse(await readFile(captureFile, "utf8")) as Capture;
    return { capture, exitCode, output };
  }

  function expectSignedForLambda(capture: Capture) {
    expect(capture).toMatchObject({
      accessKeyMatches: true,
      hasAmzDate: true,
      hasContentHash: true,
      hasSession: true,
      method: "POST",
      path: "/hash",
      region: "eu-north-1",
      scopeDateMatchesAmzDate: true,
      service: "lambda",
      signatureWellFormed: true,
      tokenMatches: true,
    });
    expect(capture.signedHeaders).toEqual(
      expect.arrayContaining(["host", "x-amz-date", "x-amz-security-token"]),
    );
  }

  it("signs with temporary credentials from a named profile credential process", async () => {
    const script = join(directory, "credential-process.mjs");
    await writeFile(
      script,
      `console.log(JSON.stringify({
  Version: 1,
  AccessKeyId: ${JSON.stringify(fixture.accessKeyId)},
  SecretAccessKey: ${JSON.stringify(fixture.secretAccessKey)},
  SessionToken: ${JSON.stringify(fixture.sessionToken)},
  Expiration: new Date(Date.now() + 3600000).toISOString(),
}));
`,
    );
    const config = join(directory, "profile-config");
    await writeFile(
      config,
      `[profile certpath-fixture]\ncredential_process = "${node}" "${script}"\nregion = eu-north-1\n`,
    );

    const { capture, exitCode, output } = await runPackaged(
      { AWS_CONFIG_FILE: config, AWS_PROFILE: "certpath-fixture" },
      "profile",
    );

    expect(output).not.toContain("Dynamic require");
    expect(output).toContain("HTTP 403");
    expect(exitCode).toBe(1);
    expectSignedForLambda(capture);
  });

  it("signs with temporary credentials from the CloudShell container endpoint", async () => {
    const { capture, exitCode, output } = await runPackaged(
      {
        AWS_CONTAINER_AUTHORIZATION_TOKEN: secrets[3]!,
        AWS_CONTAINER_CREDENTIALS_FULL_URI: containerUrl,
      },
      "container",
    );

    expect(output).not.toContain("Dynamic require");
    expect(output).toContain("HTTP 403");
    expect(exitCode).toBe(1);
    expectSignedForLambda(capture);
  });
});
