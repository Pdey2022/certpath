import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DRIVER_BATCH_SIZE_DEFAULT,
  STAGE_ORDER,
  assertBatchSize,
  type StageName,
} from "./contract.ts";
import { DriverError, describeError } from "./errors.ts";
import { assertOriginPolicy, normalizeOrigin } from "./origin.ts";
import { runDriver, type RunDependencies, type RunOptions, type RunReport } from "./run.ts";

const STAGES: ReadonlyArray<StageName | "all"> = [...STAGE_ORDER, "all"];

export interface ParsedArgs {
  help: boolean;
  options?: Omit<RunOptions, "certificationSlug" | "versionKey"> & {
    certificationSlug: string | null;
    versionKey: string | null;
  };
  allowRemote: boolean;
  remoteConfirm: string | null;
  approval: string | null;
  passwordStdin: boolean;
  totpStdin: boolean;
}

const VALUE_FLAGS = new Set([
  "--origin",
  "--batches",
  "--taxonomy",
  "--prose",
  "--state",
  "--email",
  "--stage",
  "--certification-slug",
  "--version-key",
  "--batch-size",
  "--unit-limit",
  "--remote-confirm",
  "--approval",
]);

const BOOLEAN_FLAGS = new Set([
  "--create-certification",
  "--dry-run",
  "--allow-remote",
  "--password-stdin",
  "--totp-stdin",
  "--help",
]);

/** Flags that would put a secret on the command line are refused by name. */
const SECRET_FLAGS = new Set([
  "--password",
  "--totp",
  "--totp-code",
  "--recovery-code",
  "--cookie",
  "--csrf",
  "--csrf-token",
]);

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--") || value.trim().length === 0) {
    throw new DriverError("MISSING_ARGUMENT", `${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new DriverError("INVALID_ARGUMENT", `${flag} must be a positive integer`);
  }
  return Number(value);
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (SECRET_FLAGS.has(argument) || argument.startsWith("--password=") || argument.startsWith("--totp=")) {
      throw new DriverError(
        "PASSWORD_ON_ARGV",
        "secrets are never accepted on the command line; they are read from the terminal or stdin",
      );
    }
    if (!argument.startsWith("--")) {
      throw new DriverError("UNKNOWN_ARGUMENT", "positional arguments are not accepted");
    }
    const flag = argument;
    if (!VALUE_FLAGS.has(flag) && !BOOLEAN_FLAGS.has(flag)) {
      throw new DriverError("UNKNOWN_ARGUMENT", `unknown flag`);
    }
    if (values.has(flag) || flags.has(flag)) {
      throw new DriverError("DUPLICATE_ARGUMENT", `${flag} was supplied twice`);
    }
    if (BOOLEAN_FLAGS.has(flag)) {
      flags.add(flag);
      continue;
    }
    values.set(flag, requireValue(argv, index, flag));
    index += 1;
  }

  if (flags.has("--help")) return helpResult();

  const required = ["--origin", "--batches", "--taxonomy", "--prose", "--state", "--email", "--stage"];
  for (const flag of required) {
    if (!values.has(flag)) {
      throw new DriverError("MISSING_ARGUMENT", `${flag} is required`);
    }
  }

  const stage = values.get("--stage")!;
  if (!STAGES.includes(stage as StageName | "all")) {
    throw new DriverError("INVALID_ARGUMENT", "--stage must be taxonomy, transform, upload, publish, verify or all");
  }
  const batchSize = values.has("--batch-size")
    ? assertBatchSize(Number(values.get("--batch-size")))
    : DRIVER_BATCH_SIZE_DEFAULT;
  if (values.has("--batch-size") && !/^[0-9]+$/.test(values.get("--batch-size")!)) {
    throw new DriverError("INVALID_ARGUMENT", "--batch-size must be an integer");
  }
  const unitLimit = values.has("--unit-limit")
    ? parsePositiveInteger(values.get("--unit-limit")!, "--unit-limit")
    : null;
  const email = values.get("--email")!;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new DriverError("INVALID_ARGUMENT", "--email is not a plain email address");
  }
  const origin = normalizeOrigin(values.get("--origin")!, "--origin");

  return {
    help: false,
    options: {
      origin,
      batchesDir: resolve(values.get("--batches")!),
      taxonomyPath: resolve(values.get("--taxonomy")!),
      prosePath: resolve(values.get("--prose")!),
      stateDir: resolve(values.get("--state")!),
      email,
      stage: stage as StageName | "all",
      certificationSlug: values.get("--certification-slug") ?? null,
      versionKey: values.get("--version-key") ?? null,
      createCertification: flags.has("--create-certification"),
      batchSize,
      unitLimit,
      dryRun: flags.has("--dry-run"),
    },
    allowRemote: flags.has("--allow-remote"),
    remoteConfirm: values.get("--remote-confirm") ?? null,
    approval: values.get("--approval") ?? null,
    passwordStdin: flags.has("--password-stdin"),
    totpStdin: flags.has("--totp-stdin"),
  };
}

function helpResult(): ParsedArgs {
  return {
    help: true,
    allowRemote: false,
    remoteConfirm: null,
    approval: null,
    passwordStdin: false,
    totpStdin: false,
  };
}

const HELP_TEXT = `Usage:
  tsx tools/cissp-import-driver/cli.ts
    --origin http://localhost:5173 --batches <converter-output>
    --taxonomy tools/cissp-convert/taxonomy.json --prose <prose.json>
    --state <dir outside the repository> --email <staff email>
    --stage taxonomy|transform|upload|publish|verify|all
    [--certification-slug <slug>] [--version-key <key>] [--create-certification]
    [--batch-size 5] [--unit-limit N] [--dry-run]
    [--password-stdin] [--totp-stdin]
    [--allow-remote --remote-confirm <origin> --approval <issue>]

Stage 0 (validate) always runs first and makes no request. The driver writes
only inside --state; the converter's output directory is read-only.

--unit-limit is for the local proof only. On a remote run it completes the
stage it is given, so a later unlimited run would import nothing; watch unit 1
of a full run instead.

The password and the TOTP code are read from the terminal with echo off, or one
per line from stdin with --password-stdin / --totp-stdin. Neither is accepted as
a command-line argument or from an environment variable.`;

/**
 * Reads a secret without echoing it. A TTY is required for the interactive
 * path; the stdin path exists for a non-interactive local proof, exactly as
 * apps/api/scripts/provision-staff-accounts.ts does it.
 */
export function readSecretEchoOff(
  promptText: string,
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): Promise<string> {
  if (!stdin.isTTY) {
    throw new DriverError("SECRET_UNAVAILABLE", "a terminal is required to enter a secret privately");
  }
  return new Promise((resolvePromise) => {
    stdout.write(promptText);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const finish = (read: string) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
      resolvePromise(read);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish("");
          process.exit(130);
        }
        if (character === "\r" || character === "\n") {
          finish(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    stdin.on("data", onData);
  });
}

export interface SecretReaderOptions {
  passwordStdin: boolean;
  totpStdin: boolean;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

/** One reader per process; each secret is read exactly once. */
export function createSecretReader(options: SecretReaderOptions): () => Promise<{ password: string; totpCode: string }> {
  let cached: Promise<{ password: string; totpCode: string }> | null = null;

  const readLines = async (): Promise<string[]> => {
    const chunks: string[] = [];
    for await (const chunk of options.stdin) chunks.push(String(chunk));
    return chunks.join("").split(/\r?\n/).filter((line) => line.length > 0);
  };

  const read = async (): Promise<{ password: string; totpCode: string }> => {
    if (options.passwordStdin || options.totpStdin) {
      const lines = await readLines();
      if (lines.length < 2) {
        throw new DriverError(
          "SECRET_UNAVAILABLE",
          "--password-stdin and --totp-stdin expect two lines on stdin: password, then TOTP code",
        );
      }
      return { password: lines[0]!, totpCode: lines[1]! };
    }
    const password = await readSecretEchoOff("Staff password: ", options.stdin, options.stdout);
    const totpCode = await readSecretEchoOff("TOTP code: ", options.stdin, options.stdout);
    return { password, totpCode };
  };

  return () => {
    cached ??= read();
    return cached;
  };
}

export function defaultRepositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export interface MainOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  fetchImpl?: typeof fetch;
  now?: () => number;
  repoRoot?: string;
}

export async function main(argv: readonly string[], overrides: MainOptions = {}): Promise<number> {
  const stdout = overrides.stdout ?? process.stdout;
  const stderr = overrides.stderr ?? process.stderr;
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    stderr.write(`CISSP_IMPORT_DRIVER_ERROR ${describeError(error)}\n`);
    return 1;
  }
  if (parsed.help || parsed.options === undefined) {
    stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }
  try {
    assertOriginPolicy({
      origin: parsed.options.origin,
      allowRemote: parsed.allowRemote,
      remoteConfirm: parsed.remoteConfirm,
      approval: parsed.approval,
    });
    const dependencies: RunDependencies = {
      fetchImpl: overrides.fetchImpl ?? fetch,
      now: overrides.now ?? Date.now,
      log: (line) => stdout.write(`cissp-import-driver: ${line}\n`),
      secrets: createSecretReader({
        passwordStdin: parsed.passwordStdin,
        totpStdin: parsed.totpStdin,
        stdin: overrides.stdin ?? process.stdin,
        stdout,
      }),
      newId: () => crypto.randomUUID(),
      repoRoot: overrides.repoRoot ?? defaultRepositoryRoot(),
    };
    const report = await runDriver(parsed.options, dependencies);
    printReport(stdout, report);
    return 0;
  } catch (error) {
    stderr.write(`CISSP_IMPORT_DRIVER_ERROR ${describeError(error)}\n`);
    if (error instanceof DriverError && error.info !== undefined) {
      stderr.write(`  ${JSON.stringify(error.info)}\n`);
    }
    return 1;
  }
}

function printReport(stdout: NodeJS.WriteStream, report: RunReport): void {
  stdout.write(
    `cissp-import-driver: requests=${report.requests} ` +
      `creates=${report.creates.certification}/${report.creates.examVersion}/${report.creates.domains}/${report.creates.topics} ` +
      `(certification/examVersion/domains/topics) ` +
      `adoptions=${report.adoptions} published=${report.published}\n`,
  );
  stdout.write(
    `cissp-import-driver: stages ${report.completedStages.join(", ") || "none"}\n`,
  );
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync.native(resolve(entry)) === realpathSync.native(resolve(modulePath));
  } catch {
    return resolve(entry) === resolve(modulePath);
  }
}

if (invokedDirectly()) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
