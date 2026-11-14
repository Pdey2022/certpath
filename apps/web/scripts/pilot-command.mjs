import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const action = process.argv[2];
const env = { ...process.env, VITE_CERTPATH_PILOT: "true" };

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

if (action === "deploy" || action === "dry-run") {
  const args =
    action === "deploy"
      ? ["deploy", "-c", "build/server/wrangler.json"]
      : ["deploy", "--dry-run", "-c", "build/server/wrangler.json"];
  const result = spawnSync(process.execPath, [wranglerBin(), ...args], {
    env,
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

console.error("Usage: pilot-command.mjs <build|deploy|dry-run>");
process.exit(2);
