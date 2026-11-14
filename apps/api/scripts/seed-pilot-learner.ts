import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPilotSeedSql,
  buildPilotSeedStatements,
} from "../src/security/pilot-seed.ts";

const usage = `Usage: npx tsx apps/api/scripts/seed-pilot-learner.ts \\
  --user-id <uuid> --certification-id <uuid> --exam-version-id <uuid> --grant-id <uuid> \\
  [--days 7] [--database certpath-pilot] [--config apps/web/wrangler.pilot.jsonc] \\
  [--local | --remote] [--print]

Provisions one synthetic learner, one certification, one exam version, and one
Standard grant for the private pilot. It never creates a Google identity; use
link-google-learner.ts for that. Rerunning it changes nothing.`;

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  if (argv.includes("--help")) {
    console.log(usage);
    return 0;
  }
  const learnerUserId = readFlag(argv, "--user-id");
  const certificationId = readFlag(argv, "--certification-id");
  const examVersionId = readFlag(argv, "--exam-version-id");
  const grantId = readFlag(argv, "--grant-id");
  if (!learnerUserId || !certificationId || !examVersionId || !grantId) {
    console.error(usage);
    return 1;
  }
  const database = readFlag(argv, "--database") ?? "certpath-pilot";
  const config = readFlag(argv, "--config") ?? "apps/web/wrangler.pilot.jsonc";
  const scope = argv.includes("--remote") ? "--remote" : "--local";
  const daysFlag = readFlag(argv, "--days");
  const durationDays = daysFlag === undefined ? 7 : Number(daysFlag);

  let sql: string;
  let statements: string[];
  try {
    statements = buildPilotSeedStatements({
      learnerUserId,
      certificationId,
      examVersionId,
      grantId,
      durationDays,
    });
    sql = buildPilotSeedSql({
      learnerUserId,
      certificationId,
      examVersionId,
      grantId,
      durationDays,
    });
  } catch (error) {
    console.error(`Refused: ${(error as Error).message}`);
    return 1;
  }
  if (argv.includes("--print")) {
    console.log(sql);
    return 0;
  }

  console.log(
    "Seeding one synthetic learner and one Standard grant. No Google identity is created.",
  );
  const directory = mkdtempSync(join(tmpdir(), "certpath-pilot-seed-"));
  const file = join(directory, "seed.sql");
  writeFileSync(file, `${statements.join(";\n\n")};\n`, "utf8");
  try {
    const result = spawnSync(
      "npx",
      [
        "wrangler",
        "d1",
        "execute",
        database,
        scope,
        `--config=${config}`,
        `--file=${file}`,
      ],
      { shell: process.platform === "win32", stdio: "inherit" },
    );
    const code = result.status ?? 1;
    if (code !== 0) console.error(`Seed failed with exit ${code}.`);
    return code;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("seed-pilot-learner.ts")) {
  process.exit(main());
}
