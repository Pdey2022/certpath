// Public-site deploy CLI rules (`site-command.mjs`). The site is the one Worker
// that publishes to production on every merge, and it was the only deploy path
// with no artefact assertion: every build target writes
// `build/server/wrangler.json`, so `npm run build:pilot && npm run deploy:site`
// would ship the `certpath-pilot` Worker, because the generated artefact
// carries `name: certpath-pilot`.
//
// Like `assertStagingDeployConfig` and `assertPilotDeployConfig`, this reads the
// artefact it is about to deploy and names the target it must be. The site has
// no D1 binding, so a D1-bound artefact is refused by the absence check.
import { existsSync, readFileSync } from "node:fs";
import { CliError, DEPLOYED_COMMIT_PATTERN } from "./d1-targets.mjs";

export const SITE_WORKER_NAME = "certpath-site";
export const SITE_CONFIG_SUFFIX = "/wrangler.site.jsonc";

/**
 * Read the generated config, refusing to guess when it is unusable. A missing
 * file means no site build ran; an unparseable one means the artefact cannot be
 * identified at all.
 */
export function readSiteGeneratedConfig(file) {
  if (!existsSync(file)) {
    throw new CliError(
      "site_config_missing",
      `${file} does not exist; run npm run build:site first (deploy:site ships build/server/wrangler.json, and it must be the site build)`,
      1,
    );
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliError(
      "site_config_unparsed",
      `Cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
      1,
    );
  }
}

/**
 * Assert that the generated config is the public site, then return what was
 * verified. Runs before Wrangler is spawned, so a wrong artefact is refused
 * locally instead of published.
 */
export function assertSiteDeployConfig(generatedConfig) {
  if (
    generatedConfig === null ||
    typeof generatedConfig !== "object" ||
    Array.isArray(generatedConfig)
  ) {
    throw new CliError(
      "site_config_unparsed",
      "The generated site config is not a JSON object; nothing about the artefact can be proven",
      1,
    );
  }

  const configPath =
    typeof generatedConfig.configPath === "string"
      ? generatedConfig.configPath.replaceAll("\\", "/")
      : "";
  if (!configPath.endsWith(SITE_CONFIG_SUFFIX)) {
    throw new CliError(
      "site_wrong_config",
      `The generated config selected ${configPath || "(no configPath)"}, not wrangler.site.jsonc; run npm run build:site before deploy:site`,
      1,
    );
  }

  if (generatedConfig.name !== SITE_WORKER_NAME) {
    throw new CliError(
      "site_wrong_worker",
      `The generated config names the ${JSON.stringify(generatedConfig.name)} Worker, not ${SITE_WORKER_NAME}; run npm run build:site before deploy:site`,
      1,
    );
  }

  // The site is D1-free. A generated config that carries a binding is another
  // target's build, and publishing it would put a database-bound Worker behind
  // the public origin.
  const databases = Array.isArray(generatedConfig.d1_databases)
    ? generatedConfig.d1_databases
    : [];
  if (databases.length !== 0) {
    throw new CliError(
      "site_d1_binding",
      `The generated site config declares ${databases.length} d1_databases ${databases.length === 1 ? "entry" : "entries"}; ${SITE_WORKER_NAME} has no D1 binding, so this artefact is another target's build`,
      1,
    );
  }

  const vars =
    generatedConfig.vars &&
    typeof generatedConfig.vars === "object" &&
    !Array.isArray(generatedConfig.vars)
      ? generatedConfig.vars
      : {};
  const stamp = vars["DEPLOYED_COMMIT"];
  if (typeof stamp !== "string" || !DEPLOYED_COMMIT_PATTERN.test(stamp)) {
    throw new CliError(
      "site_deploy_stamp_missing",
      `The generated site config carries DEPLOYED_COMMIT ${JSON.stringify(stamp ?? null)}; the publish job stamps the deployed commit before it deploys, and an artefact without one cannot be tied to a commit`,
      1,
    );
  }

  return { worker: generatedConfig.name, stamp };
}
