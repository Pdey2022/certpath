import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./lib/d1-targets.mjs";
import {
  assertStagingDeployConfig,
  readStagingGeneratedConfig,
} from "./lib/staging-deploy.mjs";

// The generated config Wrangler is pointed at, resolved the same way Wrangler
// resolves `-c build/server/wrangler.json`: relative to the working directory.
const GENERATED_CONFIG = path.resolve("build", "server", "wrangler.json");

const env = {
  ...process.env,
  VITE_CERTPATH_STAGING: "true",
  VITE_CERTPATH_STAGING_LOCAL_ORIGIN: "https://127.0.0.1:8794",
};

function find(...relativePaths) {
  for (const candidate of relativePaths) {
    const file = fileURLToPath(new URL(candidate, import.meta.url));
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

async function build() {
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
    !generatedConfig.configPath
      ?.replaceAll("\\", "/")
      .endsWith("/wrangler.staging.jsonc")
  ) {
    throw new Error("Staging build did not select wrangler.staging.jsonc");
  }

  const sourceMap = JSON.parse(
    await readFile(new URL("index.js.map", outputDirectory), "utf8"),
  );
  if (
    !sourceMap.sources.some((source) =>
      source.replaceAll("\\", "/").endsWith("/workers/staging-app.ts"),
    )
  ) {
    throw new Error("Staging bundle does not contain workers/staging-app.ts");
  }
  console.log("Verified staging bundle entry: workers/staging-app.ts");
}

async function main() {
  const action = process.argv[2];
  // `npm run build:staging` passes no action: the build stays the default.
  if (action === undefined || action === "build") {
    await build();
    return 0;
  }

  if (action === "deploy" || action === "dry-run") {
    // Phase 5D (issue #149): the guard runs before any spawn, because
    // `build:site`, `build:pilot`, `build:staging` and `build:preview` all write
    // this one file — a pilot build followed by deploy:staging would ship a
    // D1-bound certpath-pilot Worker to the staging host.
    const allowPilotFlags = process.argv.includes("--allow-pilot-flags");
    const verified = assertStagingDeployConfig(
      readStagingGeneratedConfig(GENERATED_CONFIG),
      { allowPilotFlags },
    );
    console.log(
      `Verified staging deploy target: worker ${verified.worker}, database ${verified.database}`,
    );
    for (const [name, value] of Object.entries(verified.flags)) {
      console.log(`Verified ${name}=${JSON.stringify(value)}`);
    }
    if (verified.allowPilotFlags) {
      console.log(
        "Pilot flag override: --allow-pilot-flags (the flags above are not asserted false)",
      );
    }

    const args =
      action === "deploy"
        ? ["deploy", "-c", "build/server/wrangler.json"]
        : ["deploy", "--dry-run", "-c", "build/server/wrangler.json"];
    const result = spawnSync(process.execPath, [wranglerBin(), ...args], {
      env,
      stdio: "inherit",
    });
    return result.status ?? 1;
  }

  console.error(
    "Usage: staging-command.mjs [build|deploy|dry-run] [--allow-pilot-flags]",
  );
  return 2;
}

try {
  process.exit(await main());
} catch (error) {
  if (error instanceof CliError) {
    console.error(`error ${error.code}: ${error.message}`);
    process.exit(error.exitCode);
  }
  console.error(error);
  process.exit(1);
}
