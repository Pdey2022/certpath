import assert from "node:assert/strict";
import test from "node:test";
import {
  pathMatchesPrefix,
  pilotExcludedPaths,
  publicReleaseExcludedPaths,
} from "./worker-routes";

test("public release excludes the API, app, admin, and account paths", () => {
  for (const path of [
    "/api/health",
    "/app",
    "/app/practice/live",
    "/admin",
    "/admin/question-editor",
    "/sign-in",
    "/verify-email",
    "/recover-password",
    "/reset-password",
    "/local-inbox",
  ]) {
    assert.equal(pathMatchesPrefix(path, publicReleaseExcludedPaths), true, path);
  }
  for (const path of ["/", "/exams", "/robots.txt", "/sitemap.xml"]) {
    assert.equal(pathMatchesPrefix(path, publicReleaseExcludedPaths), false, path);
  }
});

test("pilot keeps Google and learner APIs but closes password and email paths", () => {
  for (const path of [
    "/api/auth/local/preflight",
    "/api/auth/local/sign-in",
    "/api/auth/staging/preflight",
    "/api/auth/staging/sign-in",
    "/api/auth/cognito/start",
    "/admin",
    "/verify-email",
    "/recover-password",
    "/reset-password",
    "/local-inbox",
  ]) {
    assert.equal(pathMatchesPrefix(path, pilotExcludedPaths), true, path);
  }
  for (const path of [
    "/",
    "/exams",
    "/sign-in",
    "/app/home",
    "/api/health",
    "/api/auth/google/start",
    "/api/auth/google/callback",
    "/api/auth/session/csrf",
    "/api/auth/session/logout",
    "/api/practice/dashboard",
  ]) {
    assert.equal(pathMatchesPrefix(path, pilotExcludedPaths), false, path);
  }
});

test("prefix matching does not treat lookalike paths as excluded", () => {
  assert.equal(pathMatchesPrefix("/api/auth/locale", pilotExcludedPaths), false);
  assert.equal(pathMatchesPrefix("/adminx", pilotExcludedPaths), false);
  assert.equal(pathMatchesPrefix("/apps", publicReleaseExcludedPaths), false);
});
