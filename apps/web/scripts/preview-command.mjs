import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assertPreviewGeneratedConfig } from "./lib/d1-targets.mjs";

const action = process.argv[2];
const env = { ...process.env, VITE_CERTPATH_UI_PREVIEW: "true" };

function find(...relativePaths) {
  for (const path of relativePaths) {
    const file = fileURLToPath(new URL(path, import.meta.url));
    if (existsSync(file)) return file;
  }
  throw new Error(`Cannot find ${relativePaths[0]}`);
}

const commands = {
  build: () => [
    find(
      "../node_modules/@react-router/dev/bin.cjs",
      "../../../node_modules/@react-router/dev/bin.cjs",
    ),
    ["build"],
  ],
  deploy: () => [
    find(
      "../node_modules/wrangler/bin/wrangler.js",
      "../../../node_modules/wrangler/bin/wrangler.js",
    ),
    ["deploy", "-c", "build/server/wrangler.json"],
  ],
};

if (!commands[action]) {
  console.error("Usage: preview-command.mjs <build|deploy>");
  process.exit(2);
}

if (action === "build") {
  const [script, args] = commands.build();
  const result = spawnSync(process.execPath, [script, ...args], {
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);

  // Phase 5C: the preview Worker is documented as D1-free. The isolation gate
  // reads wrangler.preview.jsonc, but `wrangler deploy -c
  // build/server/wrangler.json` ships whatever the build generated, so the
  // generated config is asserted before anything could be deployed.
  const generatedConfig = JSON.parse(
    await readFile(
      new URL("wrangler.json", new URL("../build/server/", import.meta.url)),
      "utf8",
    ),
  );
  assertPreviewGeneratedConfig(generatedConfig);
  console.log("Verified preview build: no d1_databases binding");
  process.exit(0);
}

const [script, args] = commands[action]();
const result = spawnSync(process.execPath, [script, ...args], {
  env,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
