import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPublicMetadata,
  buildRobotsTxt,
  buildSitemapXml,
  toMetaDescriptors,
} from "./seo.ts";

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
