import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildPublicMetadata,
  buildRobotsTxt,
  buildSitemapXml,
  isIndexingEnabled,
  toMetaDescriptors,
} from "./seo.ts";

// The value the published Worker actually runs with. Read from the config
// rather than hardcoded, so the flag and the behaviour asserted below cannot
// drift apart: flipping the config back to "true" fails this test.
const siteConfigUrl = new URL("../../wrangler.site.jsonc", import.meta.url);

test("public metadata uses the request origin until a canonical origin is set", () => {
  const metadata = buildPublicMetadata({
    requestUrl: "http://localhost:5173/exams?campaign=ignored",
    canonicalOrigin: "",
    path: "/exams",
    title: "Exam catalogue",
    description: "Approved exam listings.",
    indexingEnabled: false,
  });

  assert.equal(metadata.canonical, "http://localhost:5173/exams");
  assert.equal(metadata.robots, "noindex,nofollow");
  assert.equal(metadata.title, "Exam catalogue");
  assert.deepEqual(
    toMetaDescriptors(metadata).find(
      (descriptor) => "tagName" in descriptor && descriptor.tagName === "link",
    ),
    {
      tagName: "link",
      rel: "canonical",
      href: "http://localhost:5173/exams",
    },
  );
  assert.ok(
    toMetaDescriptors(metadata).some(
      (descriptor) =>
        "property" in descriptor && descriptor.property === "og:title",
    ),
  );
  assert.ok(
    toMetaDescriptors(metadata).some(
      (descriptor) => "script:ld+json" in descriptor,
    ),
  );
});

test("public metadata honors an explicitly configured origin and indexing state", () => {
  const metadata = buildPublicMetadata({
    requestUrl: "https://preview.example/exams",
    canonicalOrigin: "https://www.example.test/",
    path: "/exams",
    title: "Exam catalogue",
    description: "Approved exam listings.",
    indexingEnabled: true,
  });

  assert.equal(metadata.canonical, "https://www.example.test/exams");
  assert.equal(metadata.robots, "index,follow");
});

test("local robots and sitemap exclude all URLs", () => {
  const robots = buildRobotsTxt({
    indexingEnabled: false,
    sitemapUrl: "http://localhost:5173/sitemap.xml",
  });
  const sitemap = buildSitemapXml({
    origin: "http://localhost:5173",
    indexingEnabled: false,
  });

  assert.match(robots, /Disallow: \//);
  assert.doesNotMatch(sitemap, /<url>/);
});

test("indexable sitemap contains public routes and no private paths", () => {
  const robots = buildRobotsTxt({
    indexingEnabled: true,
    sitemapUrl: "https://example.test/sitemap.xml",
  });
  const sitemap = buildSitemapXml({
    origin: "https://example.test",
    indexingEnabled: true,
  });

  assert.match(robots, /Disallow: \/app/);
  assert.match(robots, /Disallow: \/admin/);
  assert.match(sitemap, /https:\/\/example\.test\//);
  assert.match(sitemap, /https:\/\/example\.test\/exams/);
  assert.doesNotMatch(sitemap, /\/app|\/admin/);
});

// The public site is deliberately non-indexable while the marketing copy still
// says access is not published yet. This asserts the shipped configuration, not
// a hypothetical one: `wrangler.site.jsonc` is the config `build:site` selects.
test("the published site config turns indexing off for every page", () => {
  const config = JSON.parse(readFileSync(fileURLToPath(siteConfigUrl), "utf8"));
  const configured = config.vars?.INDEXING_ENABLED;

  // Explicit "false", not a missing var: an absent variable also reads as
  // disabled, and this test must not pass because the flag disappeared.
  assert.equal(configured, "false");
  const indexingEnabled = isIndexingEnabled(configured);
  assert.equal(indexingEnabled, false);

  const robots = buildRobotsTxt({
    indexingEnabled,
    sitemapUrl: "https://certpath-site.certpath.workers.dev/sitemap.xml",
  });
  assert.equal(robots, "User-agent: *\nDisallow: /\n");

  const sitemap = buildSitemapXml({
    origin: "https://certpath-site.certpath.workers.dev",
    indexingEnabled,
  });
  assert.doesNotMatch(sitemap, /<url>/);

  for (const path of ["/", "/exams"]) {
    const metadata = buildPublicMetadata({
      requestUrl: `https://certpath-site.certpath.workers.dev${path}`,
      canonicalOrigin: "https://certpath-site.certpath.workers.dev",
      path,
      title: "CertPath",
      description: "Exam preparation.",
      indexingEnabled,
    });
    assert.equal(metadata.robots, "noindex,nofollow");
  }
});
