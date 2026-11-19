import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createSecretReader, parseArgs } from "./cli.ts";
import { DriverError } from "./errors.ts";
import { assertOutsideRepository } from "./paths.ts";
import { reviewNote } from "./run.ts";

function expectCode(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof DriverError, `expected DriverError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

const BASE = [
  "--origin",
  "http://localhost:5173",
  "--batches",
  "C:/temp/batches",
  "--taxonomy",
  "tools/cissp-convert/taxonomy.json",
  "--prose",
  "C:/temp/prose.json",
  "--state",
  "C:/temp/state",
  "--email",
  "owner@example.test",
  "--stage",
  "upload",
];

test("a password on the command line is refused by name", () => {
  for (const argv of [
    [...BASE, "--password", "hunter2"],
    [...BASE, "--password=hunter2"],
    [...BASE, "--totp=123456"],
    [...BASE, "--cookie", "session=1"],
  ]) {
    expectCode(() => parseArgs(argv), "PASSWORD_ON_ARGV");
  }
});

test("unknown, duplicate and missing arguments are refused", () => {
  expectCode(() => parseArgs([...BASE, "--nope"]), "UNKNOWN_ARGUMENT");
  expectCode(() => parseArgs([...BASE, "--stage", "verify"]), "DUPLICATE_ARGUMENT");
  expectCode(() => parseArgs(BASE.filter((value) => value !== "--email" && value !== "owner@example.test")), "MISSING_ARGUMENT");
  expectCode(() => parseArgs([...BASE, "--unit-limit"]), "MISSING_ARGUMENT");
});

test("only the six documented stages are accepted", () => {
  for (const stage of ["taxonomy", "transform", "upload", "publish", "verify", "all"]) {
    const parsed = parseArgs([...BASE.slice(0, -1), stage]);
    assert.equal(parsed.options?.stage, stage);
  }
  expectCode(() => parseArgs([...BASE.slice(0, -1), "everything"]), "INVALID_ARGUMENT");
});

test("batch size accepts 1-10 and refuses 0 and 11", () => {
  assert.equal(parseArgs([...BASE, "--batch-size", "1"]).options?.batchSize, 1);
  assert.equal(parseArgs([...BASE, "--batch-size", "10"]).options?.batchSize, 10);
  assert.equal(parseArgs([...BASE]).options?.batchSize, 5);
  expectCode(() => parseArgs([...BASE, "--batch-size", "0"]), "BATCH_SIZE_INVALID");
  expectCode(() => parseArgs([...BASE, "--batch-size", "11"]), "BATCH_SIZE_INVALID");
});

test("the unit limit is a positive integer", () => {
  assert.equal(parseArgs([...BASE, "--unit-limit", "1"]).options?.unitLimit, 1);
  expectCode(() => parseArgs([...BASE, "--unit-limit", "0"]), "INVALID_ARGUMENT");
  expectCode(() => parseArgs([...BASE, "--unit-limit", "two"]), "INVALID_ARGUMENT");
});

test("the identity overrides default to the prose file", () => {
  const parsed = parseArgs(BASE);
  assert.equal(parsed.options?.certificationSlug, null);
  assert.equal(parsed.options?.versionKey, null);
  const overridden = parseArgs([...BASE, "--certification-slug", "synthetic-pilot", "--version-key", "driver-canary-v1"]);
  assert.equal(overridden.options?.certificationSlug, "synthetic-pilot");
  assert.equal(overridden.options?.versionKey, "driver-canary-v1");
});

test("the review note is the approved sentence, byte for byte", () => {
  assert.equal(
    reviewNote("run-abc", 3),
    "Owner self-review under the pilot exception in docs/cissp-bank-import.md: " +
      "owner-authored source, converted by tools/cissp-convert and imported " +
      "verbatim through the protected import API. Recorded by driver run " +
      "run-abc, unit 3.",
  );
});

test("a state path inside the repository is refused", () => {
  const repoRoot = "C:/repo/certpath";
  expectCode(() => assertOutsideRepository(`${repoRoot}/tmp/state`, repoRoot, "STATE_INSIDE_REPOSITORY"), "STATE_INSIDE_REPOSITORY");
  assert.doesNotThrow(() => assertOutsideRepository("C:/temp/cissp-state", repoRoot, "STATE_INSIDE_REPOSITORY"));
});

test("the stdin secret reader takes exactly two lines and never echoes them", async () => {
  const reader = createSecretReader({
    passwordStdin: true,
    totpStdin: true,
    stdin: Readable.from(["not-a-real-password\n123456\n"]) as unknown as NodeJS.ReadStream,
    stdout: process.stdout,
  });
  assert.deepEqual(await reader(), { password: "not-a-real-password", totpCode: "123456" });
  // Cached: a second call must not read stdin again.
  assert.deepEqual(await reader(), { password: "not-a-real-password", totpCode: "123456" });
});

test("the stdin secret reader refuses a short stream", async () => {
  const reader = createSecretReader({
    passwordStdin: true,
    totpStdin: true,
    stdin: Readable.from(["only-a-password\n"]) as unknown as NodeJS.ReadStream,
    stdout: process.stdout,
  });
  await assert.rejects(
    reader(),
    (error: unknown) => error instanceof DriverError && error.code === "SECRET_UNAVAILABLE",
  );
});
