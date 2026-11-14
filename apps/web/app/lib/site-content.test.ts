import assert from "node:assert/strict";
import test from "node:test";
import {
  accessPlans,
  availabilityNotice,
  catalogExams,
  catalogueFootnote,
  demoLink,
  independenceNotice,
} from "./site-content";
import { liveDemoUrl } from "./release-mode";

test("catalogue lists CISSP and CISM with Standard and Pro explained", () => {
  assert.deepEqual(
    catalogExams.map((exam) => exam.name),
    ["CISSP", "CISM"],
  );
  assert.deepEqual(
    accessPlans.map((plan) => plan.name),
    ["Standard", "Pro"],
  );

  const standard = accessPlans[0];
  const pro = accessPlans[1];
  assert.match(standard.summary, /one certification at a time/);
  assert.ok(standard.points.some((point) => /3, 6, or 12 calendar months/.test(point)));
  assert.match(pro.summary, /three calendar months/);
  assert.ok(pro.points.some((point) => /Requires Standard/.test(point)));
  assert.match(catalogueFootnote, /No all-exam subscription/);
});

test("public release copy carries no prototype wording", () => {
  const copy = [
    ...catalogExams.flatMap((exam) => [
      exam.name,
      exam.fullName,
      exam.summary,
      exam.audience,
    ]),
    ...accessPlans.flatMap((plan) => [plan.name, plan.summary, ...plan.points]),
    catalogueFootnote,
    availabilityNotice,
    independenceNotice,
    demoLink.label,
  ]
    .join(" ")
    .toLowerCase();

  for (const banned of [
    "prototype",
    "synthetic catalogue",
    "working label",
    "foundation page",
    "no question bank",
    "preview only",
  ]) {
    assert.equal(copy.includes(banned), false, `unexpected wording: ${banned}`);
  }
  assert.match(availabilityNotice, /not published yet/);
  assert.match(availabilityNotice, /purchasing/);
});

test("Try the demo points at the live preview", () => {
  assert.equal(demoLink.label, "Try the demo");
  assert.equal(demoLink.href, liveDemoUrl);
  assert.equal(
    demoLink.href,
    "https://certpath-ui-preview.certpath.workers.dev",
  );
});
