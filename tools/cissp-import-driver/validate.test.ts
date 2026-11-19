import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { QUESTION_IMPORT_COLUMNS } from "./contract.ts";
import { DriverError } from "./errors.ts";
import {
  TAXONOMY_DOMAIN_IDS,
  proseFixture,
  questionRow,
  sha256,
  taxonomyFixture,
  writeConverterOutput,
  writeFixture,
} from "./fixtures.ts";
import { runDriver } from "./run.ts";
import { validateInputs } from "./validate.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "cissp-driver-validate-"));
  tempDirs.push(directory);
  return directory;
}

after(() => {
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
});

function expectCode(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof DriverError, `expected DriverError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

function freshFixture(options: { rowCount?: number } = {}) {
  const root = makeTempDir();
  return { root, ...writeFixture(root, options) };
}

function rewriteProse(path: string, mutate: (value: Record<string, unknown>) => void): void {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("the owner-approved prose shape (bare string meanings, no digest, a note) is accepted", () => {
  const root = makeTempDir();
  const taxonomy = taxonomyFixture();
  writeFileSync(join(root, "taxonomy.json"), taxonomy.text, "utf8");
  const prose = {
    formatVersion: "certpath-cissp-taxonomy-prose-v1",
    note: "Owner-supplied prose for createExamVersion, createDomain and createTopic.",
    certification: { slug: "cissp", displayName: "CISSP" },
    examVersion: {
      versionKey: "cissp-exam-v1",
      title: "CISSP exam",
      syllabusReference: "Synthetic reference",
    },
    domains: Object.fromEntries(
      TAXONOMY_DOMAIN_IDS.map((id) => [id, `Owner meaning for ${id}`]),
    ),
    topics: Object.fromEntries(taxonomy.topics.map((topic) => [topic.id, `Owner meaning for ${topic.id}`])),
  };
  const prosePath = join(root, "prose.json");
  writeFileSync(prosePath, `${JSON.stringify(prose, null, 2)}\n`, "utf8");
  const rows = [questionRow({ key: "cissp-1" })];
  const batchesDir = join(root, "batches");
  writeConverterOutput(batchesDir, [{ name: "batch-001.csv", rows }], taxonomy);

  const inputs = validateInputs({ batchesDir, taxonomyPath: join(root, "taxonomy.json"), prosePath });
  assert.equal(inputs.prose.certification.id, null);
  assert.equal(inputs.prose.domains.get("cissp-d1"), "Owner meaning for cissp-d1");
  assert.equal(inputs.prose.topics.size, 36);
});

test("a well-formed fixture validates and reports its counts", () => {
  const fixture = freshFixture();
  const inputs = validateInputs({
    batchesDir: fixture.batchesDir,
    taxonomyPath: fixture.taxonomyPath,
    prosePath: fixture.prosePath,
  });
  assert.equal(inputs.rows.length, 5);
  assert.equal(inputs.taxonomy.domains.length, 8);
  assert.equal(inputs.taxonomy.topicIds.size, 36);
  assert.equal(inputs.declaredExamVersionId, "cissp-exam-v1");
  assert.equal(inputs.converterManifestSha256, sha256(readFileSync(join(fixture.batchesDir, "manifest.json"))));
});

test("a missing prose file is refused before any read of the batches", () => {
  const fixture = freshFixture();
  expectCode(
    () =>
      validateInputs({
        batchesDir: fixture.batchesDir,
        taxonomyPath: fixture.taxonomyPath,
        prosePath: join(fixture.root, "absent.json"),
      }),
    "PROSE_UNREADABLE",
  );
});

test("a blank meaning is fatal", () => {
  const fixture = freshFixture();
  rewriteProse(fixture.prosePath, (value) => {
    const domains = value["domains"] as Record<string, { meaning: string }>;
    domains["cissp-d1"]!.meaning = "   ";
  });
  expectCode(
    () =>
      validateInputs({
        batchesDir: fixture.batchesDir,
        taxonomyPath: fixture.taxonomyPath,
        prosePath: fixture.prosePath,
      }),
    "PROSE_MEANING_BLANK",
  );
});

test("35 topics, an unknown topic, an over-long meaning and a digest mismatch are each named", () => {
  const fixture = freshFixture();
  const taxonomy = taxonomyFixture();
  rewriteProse(fixture.prosePath, (value) => {
    const topics = value["topics"] as Record<string, { meaning: string }>;
    delete topics[taxonomy.topics[0]!.id];
  });
  expectCode(
    () =>
      validateInputs({
        batchesDir: fixture.batchesDir,
        taxonomyPath: fixture.taxonomyPath,
        prosePath: fixture.prosePath,
      }),
    "PROSE_TOPIC_SET_MISMATCH",
  );

  writeFileSync(fixture.prosePath, `${JSON.stringify(proseFixture(taxonomy), null, 2)}\n`, "utf8");
  rewriteProse(fixture.prosePath, (value) => {
    const topics = value["topics"] as Record<string, { meaning: string }>;
    topics["cissp-d9-topic-1"] = { meaning: "unknown" };
  });
  expectCode(
    () =>
      validateInputs({
        batchesDir: fixture.batchesDir,
        taxonomyPath: fixture.taxonomyPath,
        prosePath: fixture.prosePath,
      }),
    "PROSE_TOPIC_SET_MISMATCH",
  );

  writeFileSync(fixture.prosePath, `${JSON.stringify(proseFixture(taxonomy), null, 2)}\n`, "utf8");
  rewriteProse(fixture.prosePath, (value) => {
    const topics = value["topics"] as Record<string, { meaning: string }>;
    topics[taxonomy.topics[0]!.id] = { meaning: "x".repeat(2001) };
  });
  expectCode(
    () =>
      validateInputs({
        batchesDir: fixture.batchesDir,
        taxonomyPath: fixture.taxonomyPath,
        prosePath: fixture.prosePath,
      }),
    "PROSE_MEANING_OVER_LIMIT",
  );

  writeFileSync(fixture.prosePath, `${JSON.stringify(proseFixture(taxonomy), null, 2)}\n`, "utf8");
  rewriteProse(fixture.prosePath, (value) => {
    value["taxonomySha256"] = "0".repeat(64);
  });
  expectCode(
    () =>
      validateInputs({
        batchesDir: fixture.batchesDir,
        taxonomyPath: fixture.taxonomyPath,
        prosePath: fixture.prosePath,
      }),
    "PROSE_TAXONOMY_DIGEST_MISMATCH",
  );
});

test("an unknown prose key and an invalid certification id are refused", () => {
  const fixture = freshFixture();
  rewriteProse(fixture.prosePath, (value) => {
    value["extra"] = true;
  });
  expectCode(
    () =>
      validateInputs({
        batchesDir: fixture.batchesDir,
        taxonomyPath: fixture.taxonomyPath,
        prosePath: fixture.prosePath,
      }),
    "PROSE_UNKNOWN_KEY",
  );

  writeFileSync(
    fixture.prosePath,
    `${JSON.stringify(proseFixture(taxonomyFixture(), { certificationId: "not a valid id!" }), null, 2)}\n`,
    "utf8",
  );
  expectCode(
    () =>
      validateInputs({
        batchesDir: fixture.batchesDir,
        taxonomyPath: fixture.taxonomyPath,
        prosePath: fixture.prosePath,
      }),
    "PROSE_IDENTITY_INVALID",
  );
});

function converterCase(
  build: (batchesDir: string, taxonomy: ReturnType<typeof taxonomyFixture>) => void,
): { batchesDir: string; taxonomyPath: string; prosePath: string } {
  const root = makeTempDir();
  const taxonomy = taxonomyFixture();
  writeFileSync(join(root, "taxonomy.json"), taxonomy.text, "utf8");
  writeFileSync(join(root, "prose.json"), `${JSON.stringify(proseFixture(taxonomy), null, 2)}\n`, "utf8");
  const batchesDir = join(root, "batches");
  build(batchesDir, taxonomy);
  return {
    batchesDir,
    taxonomyPath: join(root, "taxonomy.json"),
    prosePath: join(root, "prose.json"),
  };
}

test("a header with a column out of order is refused", () => {
  const paths = converterCase((dir, taxonomy) => {
    const header = [...QUESTION_IMPORT_COLUMNS];
    [header[0], header[1]] = [header[1]!, header[0]!];
    writeConverterOutput(dir, [{ name: "batch-001.csv", rows: [questionRow({ key: "cissp-1" })], header }], taxonomy);
  });
  expectCode(() => validateInputs(paths), "CSV_HEADER_MISMATCH");
});

test("two correct answers, zero correct answers and a fifth option are each refused", () => {
  const twoCorrect = converterCase((dir, taxonomy) => {
    writeConverterOutput(
      dir,
      [{ name: "batch-001.csv", rows: [questionRow({ key: "cissp-1", correctCount: 2 })] }],
      taxonomy,
    );
  });
  expectCode(() => validateInputs(twoCorrect), "CSV_VALUE_INVALID");

  const zeroCorrect = converterCase((dir, taxonomy) => {
    writeConverterOutput(
      dir,
      [{ name: "batch-001.csv", rows: [questionRow({ key: "cissp-1", correctCount: 0 })] }],
      taxonomy,
    );
  });
  expectCode(() => validateInputs(zeroCorrect), "CSV_VALUE_INVALID");

  const fiveOptions = converterCase((dir, taxonomy) => {
    writeConverterOutput(
      dir,
      [{ name: "batch-001.csv", rows: [questionRow({ key: "cissp-1", extraOption: true })] }],
      taxonomy,
    );
  });
  expectCode(() => validateInputs(fiveOptions), "CSV_VALUE_INVALID");
});

test("an unknown taxonomy id in a row is refused", () => {
  const paths = converterCase((dir, taxonomy) => {
    writeConverterOutput(
      dir,
      [{ name: "batch-001.csv", rows: [questionRow({ key: "cissp-1", topicId: "cissp-d1-nope" })] }],
      taxonomy,
    );
  });
  expectCode(() => validateInputs(paths), "UNKNOWN_TAXONOMY_ID");
});

test("a duplicate question key across two batches is refused", () => {
  const paths = converterCase((dir, taxonomy) => {
    writeConverterOutput(
      dir,
      [
        { name: "batch-001.csv", rows: [questionRow({ key: "cissp-1" })] },
        { name: "batch-002.csv", rows: [questionRow({ key: "cissp-1" })] },
      ],
      taxonomy,
    );
  });
  expectCode(() => validateInputs(paths), "DUPLICATE_QUESTION_KEY");
});

test("a batch holding more rows than the import contract allows is refused", () => {
  const paths = converterCase((dir, taxonomy) => {
    writeConverterOutput(
      dir,
      [
        {
          name: "batch-001.csv",
          rows: Array.from({ length: 11 }, (_, index) => questionRow({ key: `cissp-${index + 1}` })),
        },
      ],
      taxonomy,
    );
  });
  expectCode(() => validateInputs(paths), "CONVERTER_COUNT_MISMATCH");
});

test("a BOM before the header is refused rather than stripped", () => {
  const paths = converterCase((dir, taxonomy) => {
    writeConverterOutput(
      dir,
      [{ name: "batch-001.csv", rows: [questionRow({ key: "cissp-1" })], prefix: "\uFEFF" }],
      taxonomy,
    );
  });
  expectCode(() => validateInputs(paths), "CSV_HEADER_MISMATCH");
});

test("a batch that is not UTF-8 is refused", () => {
  const paths = converterCase((dir, taxonomy) => {
    writeConverterOutput(dir, [{ name: "batch-001.csv", rows: [questionRow({ key: "cissp-1" })] }], taxonomy);
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x0a]);
    writeFileSync(join(dir, "batch-001.csv"), bytes);
    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      batches: Array<{ file: string; rows: number; sha256: string }>;
    };
    manifest.batches[0]!.sha256 = sha256(bytes);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  });
  expectCode(() => validateInputs(paths), "CSV_NOT_UTF8");
});

test("a taxonomy report that disagrees with the CSVs is refused", () => {
  const paths = converterCase((dir, taxonomy) => {
    writeConverterOutput(dir, [{ name: "batch-001.csv", rows: [questionRow({ key: "cissp-1" })] }], taxonomy);
    const reportPath = join(dir, "taxonomy-report.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      domains: Array<{ topics: Array<{ id: string; writtenQuestions: number }> }>;
    };
    report.domains[0]!.topics[0]!.writtenQuestions += 1;
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  });
  expectCode(() => validateInputs(paths), "TAXONOMY_REPORT_MISMATCH");
});

test("no request is made when validation fails", async () => {
  const fixture = freshFixture();
  rewriteProse(fixture.prosePath, (value) => {
    const topics = value["topics"] as Record<string, { meaning: string }>;
    topics["cissp-d1-topic-1"]!.meaning = "";
  });
  let calls = 0;
  const fetchImpl: typeof fetch = (async () => {
    calls += 1;
    throw new Error("network must not be touched");
  }) as typeof fetch;
  await assert.rejects(
    runDriver(
      {
        origin: "http://localhost:5173",
        batchesDir: fixture.batchesDir,
        taxonomyPath: fixture.taxonomyPath,
        prosePath: fixture.prosePath,
        stateDir: join(makeTempDir(), "state"),
        email: "owner@example.test",
        stage: "all",
        certificationSlug: "synthetic-pilot",
        versionKey: "driver-test-v1",
        createCertification: false,
        batchSize: 5,
        unitLimit: null,
        dryRun: false,
      },
      {
        fetchImpl,
        now: () => 1_700_000_000_000,
        log: () => {},
        secrets: async () => ({ password: "unused", totpCode: "000000" }),
        newId: () => "run-1",
        repoRoot: join(fixture.root, "..", "repo"),
      },
    ),
    (error: unknown) => error instanceof DriverError && error.code === "PROSE_MEANING_BLANK",
  );
  assert.equal(calls, 0);
});

test("a dry run writes nothing and makes no request", async () => {
  const fixture = freshFixture();
  const stateDir = join(makeTempDir(), "state");
  let calls = 0;
  const fetchImpl: typeof fetch = (async () => {
    calls += 1;
    throw new Error("network must not be touched");
  }) as typeof fetch;
  const report = await runDriver(
    {
      origin: "http://localhost:5173",
      batchesDir: fixture.batchesDir,
      taxonomyPath: fixture.taxonomyPath,
      prosePath: fixture.prosePath,
      stateDir,
      email: "owner@example.test",
      stage: "all",
      certificationSlug: null,
      versionKey: null,
      createCertification: false,
      batchSize: 5,
      unitLimit: null,
      dryRun: true,
    },
    {
      fetchImpl,
      now: () => 1_700_000_000_000,
      log: () => {},
      secrets: async () => ({ password: "unused", totpCode: "000000" }),
      newId: () => "run-1",
      repoRoot: join(fixture.root, "..", "repo"),
    },
  );
  assert.equal(calls, 0);
  assert.deepEqual(report.completedStages, []);
  assert.equal(report.requests, 0);
});
