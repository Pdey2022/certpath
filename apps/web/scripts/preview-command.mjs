import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CliError,
  assertPreviewDeployConfig,
  assertPreviewGeneratedConfig,
} from "./lib/d1-targets.mjs";

// The generated config Wrangler is pointed at, resolved the same way Wrangler
// resolves `-c build/server/wrangler.json`: relative to the working directory.
const GENERATED_CONFIG = path.resolve("build", "server", "wrangler.json");

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

/** Read `build/server/wrangler.json`, refusing to guess when it is unusable. */
function readGeneratedConfig(file) {
  if (!existsSync(file)) {
    throw new CliError(
      "preview_config_missing",
      `${file} does not exist; run npm run build:preview first (a deployment must not reuse another target's build)`,
      1,
    );
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliError(
      "preview_config_unparsed",
      `Cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
      1,
    );
  }
}

async function main() {
  const action = process.argv[2];
  if (!commands[action]) {
    console.error("Usage: preview-command.mjs <build|deploy>");
    return 2;
  }

  if (action === "build") {
    const [script, args] = commands.build();
    const result = spawnSync(process.execPath, [script, ...args], {
      env,
      stdio: "inherit",
    });
    if (result.status !== 0) return result.status ?? 1;

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
    return 0;
  }

  // Phase 5C: `build:site`, `build:pilot`, `build:staging` and `build:preview`
  // all write this one file, so the deploy path checks the artefact it is about
  // to ship — D1-free, wrangler.preview.jsonc, certpath-ui-preview — before
  // Wrangler is spawned.
  const generatedConfig = readGeneratedConfig(GENERATED_CONFIG);
  assertPreviewDeployConfig(generatedConfig);

  const [script, args] = commands.deploy();
  const result = spawnSync(process.execPath, [script, ...args], {
    env,
    stdio: "inherit",
  });
  return result.status ?? 1;
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
