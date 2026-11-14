import { spawnSync } from "node:child_process";
import { buildGoogleInviteLinkSql } from "../src/security/google-invite.ts";

const usage = `Usage: npx tsx apps/api/scripts/link-google-learner.ts \\
  --user-id <learner-uuid> --subject <google-sub> \\
  [--database certpath-learner-staging] [--config apps/web/wrangler.staging.jsonc] \\
  [--local | --remote] [--print]

Links one Google issuer/subject pair to one pre-provisioned learner.
It never creates a user and never links by email.`;

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  if (argv.includes("--help")) {
    console.log(usage);
    return 0;
  }
  if (argv.length === 0) {
    console.error(usage);
    return 1;
  }
  const userId = readFlag(argv, "--user-id");
  const subject = readFlag(argv, "--subject");
  if (!userId || !subject) {
    console.error(usage);
    return 1;
  }
  const database = readFlag(argv, "--database") ?? "certpath-learner-staging";
  const config = readFlag(argv, "--config") ?? "apps/web/wrangler.staging.jsonc";
  const scope = argv.includes("--remote") ? "--remote" : "--local";

  let sql: string;
  try {
    sql = buildGoogleInviteLinkSql({ userId, subject });
  } catch (error) {
    console.error(`Refused: ${(error as Error).message}`);
    return 1;
  }
  if (argv.includes("--print")) {
    console.log(sql);
    return 0;
  }

  console.log(
    "Linking one Google subject to one existing learner. This does not create an account.",
  );
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      database,
      scope,
      `--config=${config}`,
      `--command=${sql}`,
    ],
    { shell: process.platform === "win32", stdio: "inherit" },
  );
  const code = result.status ?? 1;
  if (code !== 0) {
    console.error(`Link failed with exit ${code}. No account was created.`);
  }
  return code;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("link-google-learner.ts")) {
  process.exit(main());
}
