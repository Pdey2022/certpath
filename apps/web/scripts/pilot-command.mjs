import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, deployEnv, describeAccountPin } from "./lib/d1-targets.mjs";
import {
  PILOT_USAGE,
  assertPilotDeployConfig,
  parsePilotDeployOptions,
  pilotWranglerArgs,
  readPilotGeneratedConfig,
} from "./lib/pilot-deploy.mjs";

const action = process.argv[2];
const env = { ...process.env, VITE_CERTPATH_PILOT: "true" };

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
      "/wrangler.pilot.jsonc",
    )
  ) {
    throw new Error("Pilot build did not select wrangler.pilot.jsonc");
  }
  if (generatedConfig.name !== "certpath-pilot") {
    throw new Error("Pilot build did not use the certpath-pilot Worker");
  }
  const sourceMap = JSON.parse(
    await readFile(new URL("index.js.map", outputDirectory), "utf8"),
  );
  if (
    !sourceMap.sources.some((source) =>
      source.replaceAll("\\", "/").endsWith("/workers/pilot.ts"),
    )
  ) {
    throw new Error("Pilot bundle does not contain workers/pilot.ts");
  }
  console.log("Verified pilot entry: workers/pilot.ts");
  process.exit(0);
}

try {
  if (action === "deploy" || action === "dry-run") {
    const options = parsePilotDeployOptions(process.argv.slice(3));

    // The staging deploy guard's account rule (#149), from the same helper:
    // `deploy` must name the account it writes to, `dry-run` uploads nothing
    // and may omit it, and an environment that disagrees is refused.
    const account = deployEnv({
      parentEnv: env,
      expectAccount: options.expectAccount,
      requireAccount: action === "deploy",
    });
    // Account first (it decides where the write lands), then the artefact: every
    // build target writes build/server/wrangler.json, so the deploy must prove
    // the file it is about to ship is the pilot build.
    const verified = assertPilotDeployConfig(
      readPilotGeneratedConfig(GENERATED_CONFIG),
    );
    console.log(
      `Verified pilot deploy target: worker ${verified.worker}, database ${verified.database} (binding ${verified.binding})`,
    );
    console.log(`Verified INDEXING_ENABLED=${JSON.stringify(verified.indexing)}`);
    console.log(`Verified DEPLOYED_COMMIT=${verified.stamp}`);
    console.log(describeAccountPin(account));

    const result = spawnSync(
      process.execPath,
      [wranglerBin(), ...pilotWranglerArgs(action)],
      { env: account.env, stdio: "inherit" },
    );
    process.exit(result.status ?? 1);
  }

  console.error(`Usage: ${PILOT_USAGE}`);
  process.exit(2);
} catch (error) {
  if (error instanceof CliError) {
    console.error(`error ${error.code}: ${error.message}`);
    process.exit(error.exitCode);
  }
  console.error(error);
  process.exit(1);
}
