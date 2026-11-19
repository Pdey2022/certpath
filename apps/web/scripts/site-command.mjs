import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./lib/d1-targets.mjs";
import {
  assertSiteDeployConfig,
  readSiteGeneratedConfig,
} from "./lib/site-deploy.mjs";

const action = process.argv[2];
const env = { ...process.env, VITE_CERTPATH_PUBLIC_RELEASE: "true" };

// The artefact Wrangler is pointed at, resolved the same way Wrangler resolves
// `-c build/server/wrangler.json`: relative to the working directory.
const GENERATED_CONFIG = path.resolve("build", "server", "wrangler.json");

function find(...relativePaths) {
  for (const path of relativePaths) {
    const file = fileURLToPath(new URL(path, import.meta.url));
    if (existsSync(file)) return file;
  }
  throw new Error(`Cannot find ${relativePaths[0]}`);
}

const reactRouterBin = () =>
  find(
    "../node_modules/@react-router/dev/bin.cjs",
    "../../../node_modules/@react-router/dev/bin.cjs",
  );

const wranglerBin = () =>
  find(
    "../node_modules/wrangler/bin/wrangler.js",
    "../../../node_modules/wrangler/bin/wrangler.js",
  );

if (action === "build") {
  const result = spawnSync(process.execPath, [reactRouterBin(), "build"], {
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);

  const outputDirectory = new URL("../build/server/", import.meta.url);
  const generatedConfig = JSON.parse(
    await readFile(new URL("wrangler.json", outputDirectory), "utf8"),
  );
  if (
    !generatedConfig.configPath?.replaceAll("\\", "/").endsWith(
      "/wrangler.site.jsonc",
    )
  ) {
    throw new Error("Public release build did not select wrangler.site.jsonc");
  }
  if (generatedConfig.name !== "certpath-site") {
    throw new Error("Public release build did not use the certpath-site Worker");
  }
  const sourceMap = JSON.parse(
    await readFile(new URL("index.js.map", outputDirectory), "utf8"),
  );
  if (
    !sourceMap.sources.some((source) =>
      source.replaceAll("\\", "/").endsWith("/workers/public-site.ts"),
    )
  ) {
    throw new Error("Public release bundle does not contain workers/public-site.ts");
  }
  console.log("Verified public release entry: workers/public-site.ts");
  process.exit(0);
}

if (action === "deploy") {
  // Every build target writes this one file, and this is the deploy that runs
  // on every merge. Assert the artefact before spawning Wrangler.
  let verified;
  try {
    verified = assertSiteDeployConfig(
      readSiteGeneratedConfig(GENERATED_CONFIG),
    );
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`error ${error.code}: ${error.message}`);
      process.exit(error.exitCode);
    }
    throw error;
  }
  console.log(`Verified site deploy target: worker ${verified.worker}`);
  console.log(`Verified DEPLOYED_COMMIT=${verified.stamp}`);
  console.log(
    "Verified no d1_databases binding (the public site is D1-free)",
  );

  const result = spawnSync(
    process.execPath,
    [wranglerBin(), "deploy", "-c", "build/server/wrangler.json"],
    { env, stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}

console.error("Usage: site-command.mjs <build|deploy>");
process.exit(2);
