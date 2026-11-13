import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

function find(...relativePaths) {
  for (const path of relativePaths) {
    const file = fileURLToPath(new URL(path, import.meta.url));
    if (existsSync(file)) return file;
  }
  throw new Error("Cannot find the React Router build command");
}

const script = find(
  "../node_modules/@react-router/dev/bin.cjs",
  "../../../node_modules/@react-router/dev/bin.cjs",
);
const result = spawnSync(process.execPath, [script, "build"], {
  env: {
    ...process.env,
    VITE_CERTPATH_STAGING: "true",
    VITE_CERTPATH_STAGING_LOCAL_ORIGIN: "https://127.0.0.1:8794",
  },
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
