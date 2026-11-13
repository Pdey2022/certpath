import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

const [script, args] = commands[action]();
const result = spawnSync(process.execPath, [script, ...args], {
  env,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
