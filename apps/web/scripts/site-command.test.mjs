// Tests for the public-site deploy guard (`site-command.mjs`). The site is the
// one Worker that publishes on every merge, and `deploy:site` was the only
// deploy CLI with no artefact assertion: every build target writes
// build/server/wrangler.json, so `npm run build:pilot && npm run deploy:site`
// would ship certpath-pilot under the public origin.
//
// The rows are pure: they assert the guard's refusals without spawning Wrangler.
// The one CLI row drives an artefact the guard refuses, so no spawn can happen -
// and the harness still supplies an invalid token, as the other suites do.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CliError } from "./lib/d1-targets.mjs";
import {
  assertSiteDeployConfig,
  readSiteGeneratedConfig,
} from "./lib/site-deploy.mjs";

const CLI = fileURLToPath(new URL("./site-command.mjs", import.meta.url));

// Shaped like the artefact `npm run build:site` writes, trimmed to what the
// guard reads. The generated config carries `d1_databases: []` because the site
// has no binding.
function siteConfig() {
  return {
    configPath: "C:\\repo\\apps\\web\\wrangler.site.jsonc",
    name: "certpath-site",
    main: "index.js",
    compatibility_date: "2026-11-10",
    vars: { INDEXING_ENABLED: "true", DEPLOYED_COMMIT: "280d53b" },
    d1_databases: [],
  };
}

// What `npm run build:pilot` leaves in build/server/wrangler.json.
function pilotArtefact() {
  return {
    configPath: "C:\\repo\\apps\\web\\wrangler.pilot.jsonc",
    name: "certpath-pilot",
    main: "index.js",
    compatibility_date: "2026-11-10",
    vars: { INDEXING_ENABLED: "false", DEPLOYED_COMMIT: "280d53b" },
    d1_databases: [
      {
        binding: "DB",
        database_name: "certpath-pilot",
        database_id: "00000000-0000-0000-0000-000000000000",
      },
    ],
  };
}

test("the site guard accepts the site build and returns what it verified", () => {
  assert.deepEqual(assertSiteDeployConfig(siteConfig()), {
    worker: "certpath-site",
    stamp: "280d53b",
  });
});

test("the site guard refuses every artefact that is not the site build", () => {
  const cases = [
    // The cross-target row this guard exists for: build:pilot then deploy:site.
    [pilotArtefact(), "site_wrong_config"],
    [{ ...siteConfig(), configPath: "C:\\repo\\apps\\web\\wrangler.staging.jsonc" }, "site_wrong_config"],
    [{ ...siteConfig(), configPath: undefined }, "site_wrong_config"],
    [{ ...pilotArtefact(), configPath: "C:\\repo\\apps\\web\\wrangler.site.jsonc" }, "site_wrong_worker"],
    [{ ...siteConfig(), name: "certpath-pilot" }, "site_wrong_worker"],
    // The site is D1-free: a D1-bound artefact is another target's build even
    // if its name looks right.
    [
      { ...siteConfig(), d1_databases: [{ binding: "DB", database_name: "certpath-local" }] },
      "site_d1_binding",
    ],
    [{ ...siteConfig(), d1_databases: pilotArtefact().d1_databases }, "site_d1_binding"],
    [{ ...siteConfig(), vars: { INDEXING_ENABLED: "true" } }, "site_deploy_stamp_missing"],
    [{ ...siteConfig(), vars: { ...siteConfig().vars, DEPLOYED_COMMIT: "280d53" } }, "site_deploy_stamp_missing"],
    [null, "site_config_unparsed"],
    [[], "site_config_unparsed"],
  ];
  for (const [value, code] of cases) {
    assert.throws(
      () => assertSiteDeployConfig(value),
      (error) => error instanceof CliError && error.code === code,
      `expected ${code} for ${JSON.stringify(value)}`,
    );
  }
});

test("the site config reader names a missing or unparseable build", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "certpath-site-lib-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  assert.throws(
    () => readSiteGeneratedConfig(path.join(directory, "absent.json")),
    (error) => error instanceof CliError && error.code === "site_config_missing",
  );
  const unparseable = path.join(directory, "wrangler.json");
  writeFileSync(unparseable, "not json");
  assert.throws(
    () => readSiteGeneratedConfig(unparseable),
    (error) => error instanceof CliError && error.code === "site_config_unparsed",
  );
});

test("deploy:site refuses a cross-target artefact before spawning Wrangler", (t) => {
  // `build:pilot` then `deploy:site` is the accident: the CLI must stop at the
  // guard, not publish certpath-pilot. Wrangler's banner is the proof a spawn
  // happened; a refused run must not reach it.
  const directory = mkdtempSync(path.join(tmpdir(), "certpath-site-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const buildDirectory = path.join(directory, "build", "server");
  mkdirSync(buildDirectory, { recursive: true });
  writeFileSync(
    path.join(buildDirectory, "wrangler.json"),
    JSON.stringify(pilotArtefact()),
  );

  const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" };
  for (const name of [
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_EMAIL",
    "CLOUDFLARE_API_BASE_URL",
  ]) {
    delete env[name];
  }
  env.CLOUDFLARE_API_TOKEN = "certpath-test-token-not-a-credential";

  const result = spawnSync(process.execPath, [CLI, "deploy"], {
    cwd: directory,
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  assert.equal(result.status, 1, output);
  assert.match(output, /error site_wrong_config: /);
  assert.doesNotMatch(output, /wrangler \d+\.\d+\.\d+/);
  assert.doesNotMatch(output, /⛅/);
});
