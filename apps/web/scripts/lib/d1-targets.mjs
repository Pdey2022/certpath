// Pure helpers shared by the Phase 5A data-safety scripts
// (check-d1-isolation, d1-export, d1-restore-rehearse, d1-chain-check), the
// Phase 5C account preflight (d1-account-preflight) and the preview build guard
// (preview-command). Nothing here touches the network, the file system or the
// environment, so the rules that protect a restore can be unit-tested without
// Wrangler.
import { createHash } from "node:crypto";

export const SCHEMA_VERSION = 1;

// Wrangler's documented "I have not created this database yet" id.
export const PLACEHOLDER_DATABASE_ID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;

// The four configs the isolation gate reads. `local` is the developer's
// wrangler-dev database and is deliberately excluded from the duplicate-name
// rule; `preview` is a deployed Worker that is documented as D1-free.
export const ISOLATION_CONFIGS = Object.freeze([
  Object.freeze({ key: "local", file: "wrangler.jsonc", remote: false }),
  Object.freeze({ key: "preview", file: "wrangler.preview.jsonc", remote: true }),
  Object.freeze({ key: "staging", file: "wrangler.staging.jsonc", remote: true }),
  Object.freeze({ key: "pilot", file: "wrangler.pilot.jsonc", remote: true }),
]);

export const EXPORT_TARGETS = Object.freeze({
  local: Object.freeze({
    target: "local",
    configFile: "wrangler.jsonc",
    mode: "local",
  }),
  staging: Object.freeze({
    target: "staging",
    configFile: "wrangler.staging.jsonc",
    mode: "remote",
  }),
  pilot: Object.freeze({
    target: "pilot",
    configFile: "wrangler.pilot.jsonc",
    mode: "remote",
  }),
});

export const MANIFEST_FIELDS = Object.freeze([
  "schemaVersion",
  "target",
  "binding",
  "databaseName",
  "databaseIdClass",
  "wranglerConfig",
  "capturedAt",
  "gitCommit",
  "wranglerVersion",
  "file",
  "byteLength",
  "sha256",
  "tables",
  "migrations",
]);

export class CliError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

/**
 * Strip line and block comments and trailing commas so a `.jsonc` Wrangler
 * config can be read with `JSON.parse`. Comment markers inside strings and
 * escaped quotes are preserved.
 */
export function stripJsonc(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (inLineComment) {
      if (character === "\n") {
        inLineComment = false;
        out += character;
      }
      continue;
    }
    if (inBlockComment) {
      if (character === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      out += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      out += character;
      continue;
    }
    if (character === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    out += character;
  }

  return removeTrailingCommas(out);
}

function removeTrailingCommas(text) {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      out += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      out += character;
      continue;
    }
    if (character === ",") {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) {
        lookahead += 1;
      }
      if (text[lookahead] === "}" || text[lookahead] === "]") continue;
    }
    out += character;
  }

  return out;
}

export function parseJsonc(text, label = "config") {
  try {
    return JSON.parse(stripJsonc(text));
  } catch (error) {
    throw new CliError(
      "config_parse_failed",
      `Cannot parse ${label}: ${error instanceof Error ? error.message : String(error)}`,
      1,
    );
  }
}

/** Lower-case a database id and drop the braces/whitespace Cloudflare adds. */
export function normalizeDatabaseId(value) {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .replace(/^[{["'\s]+/, "")
    .replace(/[}\]"'\s]+$/, "")
    .toLowerCase();
}

/**
 * "placeholder" means "not provisioned". A missing id is treated as a
 * placeholder so every caller fails closed instead of calling the network.
 */
export function idClass(value) {
  const normalized = normalizeDatabaseId(value);
  if (normalized === "") return "placeholder";
  return PLACEHOLDER_DATABASE_ID.test(normalized) ? "placeholder" : "real";
}

/** Read the single D1 binding of a Wrangler config. */
export function readD1Entry(text, label = "config") {
  const config = parseJsonc(text, label);
  const entries = Array.isArray(config.d1_databases) ? config.d1_databases : [];
  const entry = entries[0];
  if (!entry || typeof entry !== "object") {
    throw new CliError(
      "d1_binding_missing",
      `${label} declares no d1_databases entry`,
      1,
    );
  }
  const databaseId =
    typeof entry.database_id === "string" ? entry.database_id : "";
  return {
    binding: typeof entry.binding === "string" ? entry.binding : "",
    databaseName:
      typeof entry.database_name === "string" ? entry.database_name : "",
    databaseId,
    idClass: idClass(databaseId),
    // Where Wrangler looks for migrations, relative to this config file. A
    // deploy gate that compares against db/migrations must know the database it
    // is gating uses that directory, or Wrangler could print "No migrations to
    // apply!" for a different chain and the gate would pass on nothing.
    migrationsDir:
      typeof entry.migrations_dir === "string" ? entry.migrations_dir : "",
  };
}

/**
 * Per-config table rows plus the isolation violations. `configs` is
 * `[{ key, file, text, remote }]` so the gate can be pointed at a temp copy.
 */
export function analyzeConfigs(configs) {
  const rows = [];
  const violations = [];
  const entries = [];

  for (const config of configs) {
    let parsed;
    try {
      parsed = parseJsonc(config.text, config.file);
    } catch (error) {
      violations.push({
        code: "config_parse_failed",
        message: `${config.file}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const databases = Array.isArray(parsed.d1_databases)
      ? parsed.d1_databases
      : [];

    if (databases.length === 0) {
      rows.push({
        config: config.key,
        file: config.file,
        worker: typeof parsed.name === "string" ? parsed.name : null,
        binding: null,
        databaseName: null,
        databaseId: null,
        idClass: "none",
      });
      continue;
    }

    for (const database of databases) {
      const databaseId =
        typeof database?.database_id === "string" ? database.database_id : "";
      const row = {
        config: config.key,
        file: config.file,
        worker: typeof parsed.name === "string" ? parsed.name : null,
        binding: typeof database?.binding === "string" ? database.binding : null,
        databaseName:
          typeof database?.database_name === "string"
            ? database.database_name
            : null,
        databaseId,
        idClass: idClass(databaseId),
      };
      rows.push(row);
      entries.push({ ...row, remote: config.remote });

      if (config.key === "preview") {
        violations.push({
          code: "preview_binds_d1",
          message: `${config.file} binds D1 as "${row.binding}" -> ${row.databaseName}; the preview Worker is documented as D1-free (workers/preview.ts) and must stay that way`,
        });
      }
    }
  }

  const remoteEntries = entries.filter((entry) => entry.remote);
  for (const [name, group] of groupBy(remoteEntries, (entry) => entry.databaseName)) {
    if (!name) continue;
    const sharing = [...new Set(group.map((entry) => entry.config))];
    if (sharing.length > 1) {
      violations.push({
        code: "duplicate_database_name",
        message: `D1 database "${name}" is named by ${sharing.join(" and ")}; every remote target needs its own database`,
      });
    }
  }

  for (const [id, group] of groupBy(entries, (entry) =>
    entry.idClass === "real" ? normalizeDatabaseId(entry.databaseId) : "",
  )) {
    if (!id) continue;
    const sharing = [...new Set(group.map((entry) => entry.config))];
    if (sharing.length > 1) {
      violations.push({
        code: "duplicate_database_id",
        message: `database_id ${id} is used by ${sharing.join(" and ")}; two targets pointing at one database is not isolation`,
      });
    }
  }

  return { rows, violations };
}

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

export function formatIsolationTable(rows) {
  const header = ["config", "worker", "binding", "database_name", "idClass"];
  const body = rows.map((row) => [
    row.config,
    row.worker ?? "-",
    row.binding ?? "-",
    row.databaseName ?? "-",
    row.idClass,
  ]);
  const widths = header.map((title, index) =>
    Math.max(title.length, ...body.map((cells) => String(cells[index]).length)),
  );
  const line = (cells) =>
    cells
      .map((cell, index) => String(cell).padEnd(widths[index]))
      .join("  ")
      .trimEnd();
  return [line(header), ...body.map(line)].join("\n");
}

export function resolveExportTarget(name) {
  const target = Object.hasOwn(EXPORT_TARGETS, name ?? "")
    ? EXPORT_TARGETS[name]
    : undefined;
  if (!target) {
    throw new CliError(
      "unknown_target",
      `Unknown export target ${JSON.stringify(name ?? "")}. Use one of: ${Object.keys(EXPORT_TARGETS).join(", ")}.`,
      2,
    );
  }
  return target;
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Normalise CRLF and lone CR to LF at the byte level.
 *
 * Git may check a file out with CRLF (`core.autocrlf=true` on Windows) while the
 * committed blob uses LF. A migration checksum has to mean the same thing on
 * every operating system, so it is computed over this normalised form.
 */
export function normalizeNewlines(bytes) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const out = Buffer.allocUnsafe(source.length);
  let length = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === 0x0d) {
      out[length] = 0x0a;
      length += 1;
      if (source[index + 1] === 0x0a) index += 1;
      continue;
    }
    out[length] = source[index];
    length += 1;
  }
  return out.subarray(0, length);
}

/** The `checksums.txt` value for a migration file. */
export function migrationChecksum(bytes) {
  return sha256Hex(normalizeNewlines(bytes));
}

const CREATE_TABLE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|'([^']+)'|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_$]*))/gi;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every table the dump creates, with the number of `INSERT INTO "<name>"`
 * statements it contains. Ordering is by name (code point) so a manifest is
 * reproducible.
 */
export function tablesFromDump(text) {
  const names = new Set();
  for (const match of text.matchAll(CREATE_TABLE)) {
    const name = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
    if (name) names.add(name);
  }
  return [...names].sort(compareNames).map((name) => ({
    name,
    inserts: (
      text.match(new RegExp(`INSERT INTO "${escapeRegExp(name)}"`, "g")) ?? []
    ).length,
  }));
}

function compareNames(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function buildManifest(input) {
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    target: input.target,
    binding: input.binding,
    databaseName: input.databaseName,
    databaseIdClass: input.databaseIdClass,
    wranglerConfig: input.wranglerConfig,
    capturedAt: input.capturedAt,
    gitCommit: input.gitCommit,
    wranglerVersion: input.wranglerVersion,
    file: input.file,
    byteLength: input.byteLength,
    sha256: input.sha256,
    tables: input.tables,
    migrations: input.migrations,
  };
  return assertManifestShape(manifest);
}

/**
 * Fail closed on any manifest a restore could misread: a missing field, a value
 * of the wrong shape, or an unsorted table list.
 */
export function assertManifestShape(manifest) {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  ) {
    throw new CliError("manifest_invalid", "Manifest is not an object", 2);
  }
  for (const field of MANIFEST_FIELDS) {
    if (manifest[field] === null || manifest[field] === undefined) {
      throw new CliError(
        "manifest_invalid",
        `Manifest field "${field}" is missing or null`,
        2,
      );
    }
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new CliError(
      "manifest_invalid",
      `Manifest schemaVersion ${JSON.stringify(manifest.schemaVersion)} is not ${SCHEMA_VERSION}`,
      2,
    );
  }
  if (
    typeof manifest.target !== "string" ||
    !Object.hasOwn(EXPORT_TARGETS, manifest.target)
  ) {
    throw new CliError(
      "manifest_invalid",
      `Manifest target ${JSON.stringify(manifest.target)} is not a known target`,
      2,
    );
  }
  for (const field of [
    "binding",
    "databaseName",
    "wranglerConfig",
    "wranglerVersion",
    "file",
  ]) {
    if (typeof manifest[field] !== "string" || manifest[field] === "") {
      throw new CliError(
        "manifest_invalid",
        `Manifest field "${field}" must be a non-empty string`,
        2,
      );
    }
  }
  if (!["placeholder", "real"].includes(manifest.databaseIdClass)) {
    throw new CliError(
      "manifest_invalid",
      `Manifest databaseIdClass ${JSON.stringify(manifest.databaseIdClass)} must be "placeholder" or "real"`,
      2,
    );
  }
  if (
    typeof manifest.capturedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(
      manifest.capturedAt,
    )
  ) {
    throw new CliError(
      "manifest_invalid",
      "Manifest capturedAt must be an ISO8601 UTC timestamp",
      2,
    );
  }
  if (
    typeof manifest.gitCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(manifest.gitCommit)
  ) {
    throw new CliError(
      "manifest_invalid",
      "Manifest gitCommit must be a 40-character lower-case hex commit",
      2,
    );
  }
  if (
    typeof manifest.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256)
  ) {
    throw new CliError(
      "manifest_invalid",
      "Manifest sha256 must be 64 lower-case hex characters",
      2,
    );
  }
  if (!Number.isInteger(manifest.byteLength) || manifest.byteLength < 0) {
    throw new CliError(
      "manifest_invalid",
      "Manifest byteLength must be a non-negative integer",
      2,
    );
  }
  if (!Array.isArray(manifest.tables)) {
    throw new CliError("manifest_invalid", "Manifest tables must be an array", 2);
  }
  let previous = null;
  for (const table of manifest.tables) {
    if (
      !table ||
      typeof table.name !== "string" ||
      table.name === "" ||
      !Number.isInteger(table.inserts) ||
      table.inserts < 0
    ) {
      throw new CliError(
        "manifest_invalid",
        "Manifest tables entries must be { name: string, inserts: non-negative integer }",
        2,
      );
    }
    if (previous !== null && compareNames(previous, table.name) >= 0) {
      throw new CliError(
        "manifest_invalid",
        `Manifest tables must be ordered by name without duplicates (at "${table.name}")`,
        2,
      );
    }
    previous = table.name;
  }
  if (!Array.isArray(manifest.migrations)) {
    throw new CliError(
      "manifest_invalid",
      "Manifest migrations must be an array",
      2,
    );
  }
  for (const migration of manifest.migrations) {
    if (typeof migration !== "string" || migration === "") {
      throw new CliError(
        "manifest_invalid",
        "Manifest migrations entries must be non-empty strings",
        2,
      );
    }
  }
  return manifest;
}

/**
 * Table-set differences: a table in the manifest that the restore does not have,
 * or one in the restore that the manifest does not list. A table that is present
 * but empty must still be reported, which is why the name sets are compared
 * before any count.
 */
export function diffTableSets(manifestTables, restoredTables) {
  const expected = new Set(manifestTables.map((table) => table.name));
  const actual = new Set(restoredTables.map((table) => table.name));
  const names = [...new Set([...expected, ...actual])].sort(compareNames);
  const diffs = [];
  for (const name of names) {
    if (expected.has(name) && !actual.has(name)) {
      diffs.push(`missing table: ${name}`);
      continue;
    }
    if (!expected.has(name) && actual.has(name)) {
      diffs.push(`unexpected table: ${name}`);
    }
  }
  return diffs;
}

/** Human-readable per-table differences; empty when the restore matches. */
export function diffTableCounts(manifestTables, restoredTables) {
  const expected = new Map(
    manifestTables.map((table) => [table.name, table.inserts]),
  );
  const actual = new Map(
    restoredTables.map((table) => [table.name, table.inserts]),
  );
  const names = [...new Set([...expected.keys(), ...actual.keys()])].sort(
    compareNames,
  );
  const diffs = [];
  for (const name of names) {
    const expectedCount = expected.get(name) ?? 0;
    const actualCount = actual.get(name) ?? 0;
    if (expectedCount === actualCount) continue;
    const delta = actualCount - expectedCount;
    diffs.push(
      `${name}: manifest ${expectedCount}, restored ${actualCount} (${delta > 0 ? `+${delta}` : delta})`,
    );
  }
  return diffs;
}

/** Parse `checksums.txt`: one `<sha256>  <basename>` line per file. */
export function parseChecksums(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.map((line, index) => {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) {
      throw new CliError(
        "migration_checksums_malformed",
        `checksums.txt line ${index + 1} is not "<sha256>  <basename>"`,
        1,
      );
    }
    return { sha256: match[1], file: match[2] };
  });
}

/**
 * Compare the migration files on disk with the recorded checksums.
 * `hashes` is a Map of basename -> sha256 computed from the files.
 */
export function verifyChecksums({ files, checksums, hashes }) {
  const violations = [];
  const checksumByName = new Map();

  for (const entry of checksums) {
    if (checksumByName.has(entry.file)) {
      violations.push({
        code: "migration_checksums_duplicate",
        file: entry.file,
        message: `checksums.txt lists ${entry.file} more than once`,
      });
      continue;
    }
    checksumByName.set(entry.file, entry.sha256);
  }

  const fileSet = new Set(files);
  for (const entry of checksums) {
    if (!fileSet.has(entry.file)) {
      violations.push({
        code: "migration_checksums_unknown_file",
        file: entry.file,
        message: `checksums.txt lists ${entry.file}, which is not a migration file`,
      });
    }
  }

  for (const file of files) {
    const expected = checksumByName.get(file);
    if (!expected) {
      violations.push({
        code: "migration_checksum_missing",
        file,
        message: `${file} has no line in checksums.txt`,
      });
      continue;
    }
    const actual = hashes.get(file);
    if (actual !== expected) {
      violations.push({
        code: "migration_checksum_changed",
        file,
        message: `${file} no longer matches checksums.txt (${expected} -> ${actual ?? "missing"}); migrations are append-only, add the next number instead`,
      });
    }
  }

  if (violations.length === 0) {
    const ordered = files.every(
      (file, index) => checksums[index]?.file === file,
    );
    if (!ordered) {
      violations.push({
        code: "migration_checksums_out_of_order",
        file: null,
        message:
          "checksums.txt must list every migration once, in filename order",
      });
    }
  }

  return violations;
}

/**
 * Wrangler `d1 execute --json` prints a JSON array to stdout. Extract it even
 * when a preamble line slipped in, and return the first result set's `name`
 * column.
 */
export function parseMigrationNames(stdout) {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new CliError(
      "migrations_query_failed",
      "Wrangler did not return JSON for the d1_migrations query",
      1,
    );
  }
  let payload;
  try {
    payload = JSON.parse(stdout.slice(start, end + 1));
  } catch (error) {
    throw new CliError(
      "migrations_query_failed",
      `Cannot parse the d1_migrations query result: ${error instanceof Error ? error.message : String(error)}`,
      1,
    );
  }
  const rows = Array.isArray(payload?.[0]?.results) ? payload[0].results : null;
  if (!rows) {
    throw new CliError(
      "migrations_query_failed",
      "The d1_migrations query returned no results array",
      1,
    );
  }
  return rows.map((row) => {
    if (typeof row?.name !== "string" || row.name === "") {
      throw new CliError(
        "migrations_query_failed",
        "The d1_migrations query returned a row without a name",
        1,
      );
    }
    return row.name;
  });
}

const AUTH_FAILURE = new RegExp(
  [
    "\\bnot authenticated\\b",
    "\\bYou must be logged in\\b",
    "\\bAuthentication error\\b",
    "\\bUnauthorized\\b",
    "\\bwrangler login\\b",
    "\\bcode: 10000\\b",
    "\\bInvalid API Token\\b",
    "\\bno API token\\b",
  ].join("|"),
);

/** True when Wrangler's output says the remote call was refused for auth. */
export function isAuthFailure(text) {
  return typeof text === "string" && AUTH_FAILURE.test(text);
}

/** Remove secret-looking environment values from any text we print. */
export function redactSecrets(text, values) {
  let redacted = typeof text === "string" ? text : "";
  for (const value of values) {
    if (typeof value !== "string" || value.length < 8) continue;
    redacted = redacted.split(value).join("[redacted]");
  }
  return redacted;
}

// ---------------------------------------------------------------------------
// Phase 5C account preflight.
//
// Wrangler resolves the target account from the Wrangler config, then from
// CLOUDFLARE_ACCOUNT_ID, then from a stored selection. An id that arrives only
// from the operator's shell therefore wins over the account the operator thinks
// they selected, which is how a provisioning run lands in the wrong account.
// The expected id is taken from the command line and nothing else; these
// helpers make the assertions testable without the network.
// ---------------------------------------------------------------------------

/** Account ids are compared trimmed and lower-cased; nothing else is stripped. */
export function normalizeAccountId(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * The environment for a read that must be about the asserted account.
 *
 * Wrangler resolves the target account from the config, then
 * `CLOUDFLARE_ACCOUNT_ID`, then a stored selection, so a read issued with the
 * operator's environment can be about a different account than the one being
 * asserted. Pinning `CLOUDFLARE_ACCOUNT_ID` to `--expect-account` removes both
 * fallbacks: the read is either about that account or it fails.
 */
export function wranglerEnv({ parentEnv = {}, expectAccount }) {
  const expected = normalizeAccountId(expectAccount);
  if (expected === "") {
    throw new CliError(
      "missing_option_value",
      "wranglerEnv needs an account id to pin; it is the only source of the expected id",
      2,
    );
  }
  return { ...parentEnv, CLOUDFLARE_ACCOUNT_ID: expected };
}

/**
 * `CLOUDFLARE_ACCOUNT_ID` must agree with `--expect-account` whenever it is set,
 * because Wrangler would silently prefer it. Checked before any network call.
 */
export function assertExpectedAccountEnv({ expectAccount, envAccountId = null }) {
  const expected = normalizeAccountId(expectAccount);
  if (expected === "") {
    throw new CliError(
      "missing_option_value",
      "--expect-account needs an account id; it is the only source of the expected id",
      2,
    );
  }
  const fromEnv = normalizeAccountId(envAccountId);
  if (fromEnv !== "" && fromEnv !== expected) {
    throw new CliError(
      "account_env_mismatch",
      `CLOUDFLARE_ACCOUNT_ID is set to ${fromEnv} but --expect-account is ${expected}; Wrangler prefers the environment variable, so unset it (or set it to the expected id) and run again`,
      1,
    );
  }
  return expected;
}

/**
 * The child environment for a deploy, and the account the run is pinned to.
 * Shared by every deploy CLI (`staging-command.mjs`, `pilot-command.mjs`) so
 * the rule is written once: the staging deploy guard (#149) and the pilot
 * deploy guard are the same rule, not two similar ones.
 *
 * Wrangler resolves the target account from the config, then
 * `CLOUDFLARE_ACCOUNT_ID`, then a stored selection. An id that is only in the
 * operator's shell therefore wins over anything the operator believes they
 * selected, and the deploy lands in that account — bound to a database id that
 * does not exist there.
 *
 * `deploy` is the one irreversible action here, so it always requires the id:
 * with `requireAccount` the flag is mandatory even when the environment is
 * silent, because a silent environment means Wrangler's stored selection decides
 * where the Worker and its cron are created. `dry-run` uploads nothing, so it
 * may omit the flag and then reports that the account was not asserted.
 *
 * When an id is supplied it must agree with the environment, and the child gets
 * it pinned (`wranglerEnv`), which removes both fallbacks.
 */
export function deployEnv({
  parentEnv = {},
  expectAccount = null,
  requireAccount = false,
}) {
  const envAccountId = normalizeAccountId(parentEnv.CLOUDFLARE_ACCOUNT_ID);
  const expected = normalizeAccountId(expectAccount);

  if (expected === "") {
    if (requireAccount) {
      const environment = envAccountId
        ? ` CLOUDFLARE_ACCOUNT_ID is set to ${envAccountId}; that is not a source of truth, but it is the value to confirm: pass it as --expect-account once you have checked it is the Certpath account.`
        : " With CLOUDFLARE_ACCOUNT_ID unset Wrangler falls back to its stored selection, which is not an assertion about anything.";
      throw new CliError(
        "account_not_asserted",
        `deploy must name the account it writes to: pass --expect-account <account id>.${environment} A deploy creates the Worker and its cron, so it is the one action here that cannot be undone by re-running it.`,
        2,
      );
    }
    if (envAccountId !== "") {
      throw new CliError(
        "account_env_mismatch",
        `CLOUDFLARE_ACCOUNT_ID is set to ${envAccountId} and no --expect-account was given; Wrangler prefers the environment variable, so the run could land in an account nobody asserted. Pass --expect-account <account id> (or unset the variable) and run again`,
        1,
      );
    }
    // Nothing to pin and nothing to contradict — a `dry-run`, which uploads
    // nothing and says on stdout that the account was not asserted.
    return { env: { ...parentEnv }, expectAccount: null, envAccountId: null };
  }

  // Refuses account_env_mismatch when the environment variable disagrees.
  assertExpectedAccountEnv({ expectAccount: expected, envAccountId });
  return {
    env: wranglerEnv({ parentEnv, expectAccount: expected }),
    expectAccount: expected,
    envAccountId: envAccountId === "" ? null : envAccountId,
  };
}

/**
 * The one line a deploy CLI prints about the account it is pinned to. Both
 * deploy CLIs print the same sentence, so an operator reading a log cannot tell
 * two different assurances apart.
 */
export function describeAccountPin({ expectAccount }) {
  return expectAccount
    ? `Account: CLOUDFLARE_ACCOUNT_ID pinned to ${expectAccount} for this run`
    : "Account: not asserted (no --expect-account and CLOUDFLARE_ACCOUNT_ID unset; Wrangler uses its stored selection)";
}

/**
 * Read only `accounts[].{id,name}` from `wrangler whoami --json`. Everything
 * else in that payload (token, email, permissions) is deliberately dropped so
 * no caller can print it.
 */
export function parseWhoamiAccounts(payload) {
  const entries = payload?.accounts;
  if (!Array.isArray(entries)) {
    throw new CliError(
      "preflight_unparsed",
      "wrangler whoami --json did not return an accounts array; no account can be asserted",
      1,
    );
  }
  return entries.map((entry) => {
    const id = normalizeAccountId(entry?.id);
    if (id === "") {
      throw new CliError(
        "preflight_unparsed",
        "wrangler whoami --json returned an account without an id",
        1,
      );
    }
    return {
      id,
      name:
        typeof entry?.name === "string" && entry.name.trim() !== ""
          ? entry.name.trim()
          : null,
    };
  });
}

/** The expected account must be one this credential can actually see. */
export function checkPreflightAccount({ whoami, expectAccount }) {
  const expected = normalizeAccountId(expectAccount);
  const accounts = parseWhoamiAccounts(whoami);
  const match = accounts.find((account) => account.id === expected);
  if (!match) {
    const visible =
      accounts.map((account) => `${account.name ?? "unnamed"} (${account.id})`).join(", ") ||
      "none";
    throw new CliError(
      "account_mismatch",
      `--expect-account ${expected} is not an account this credential can see; visible accounts: ${visible}. Nothing was created.`,
      1,
    );
  }
  return match;
}

/**
 * `wrangler d1 list --json` has been seen as a plain array and as
 * `{ result: [...] }`. Both are accepted; anything else is unparseable and the
 * run stops, because "no database found" and "I could not read the answer" must
 * not look the same to an --expect-absent assertion.
 */
export function parseDatabaseList(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.result)
      ? payload.result
      : null;
  if (!rows) {
    throw new CliError(
      "preflight_unparsed",
      "wrangler d1 list --json returned neither an array nor { result: [...] }; the database assertion cannot run",
      1,
    );
  }
  return rows.map((row) => {
    const name = typeof row?.name === "string" ? row.name.trim() : "";
    const uuid = typeof row?.uuid === "string" ? row.uuid.trim().toLowerCase() : "";
    if (name === "" || uuid === "") {
      throw new CliError(
        "preflight_unparsed",
        "wrangler d1 list --json returned a database without a name and uuid; the database assertion cannot run",
        1,
      );
    }
    return { name, uuid };
  });
}

/**
 * Present/absent assertion. Names are compared case-insensitively so a
 * differently-cased match still counts as present: that can only make
 * `--expect-absent` refuse, never make it pass.
 */
export function checkPreflightDatabase({ databases, database, expectPresent }) {
  if (typeof expectPresent !== "boolean") {
    throw new CliError(
      "missing_assertion",
      "Pass exactly one of --expect-absent or --expect-present",
      2,
    );
  }
  const wanted = typeof database === "string" ? database.trim().toLowerCase() : "";
  if (wanted === "") {
    throw new CliError(
      "missing_option_value",
      "--database needs a database name",
      2,
    );
  }
  const match =
    databases.find((entry) => entry.name.toLowerCase() === wanted) ?? null;
  if (expectPresent && !match) {
    throw new CliError(
      "database_missing",
      `D1 database "${database.trim()}" is not in this account; --expect-present was asserted. Nothing was created.`,
      1,
    );
  }
  if (!expectPresent && match) {
    throw new CliError(
      "database_already_exists",
      `D1 database "${database.trim()}" already exists (${match.uuid}); --expect-absent was asserted. Nothing was created or changed.`,
      1,
    );
  }
  return {
    name: database.trim(),
    present: match !== null,
    uuid: match?.uuid ?? null,
  };
}

/** The only lines a successful preflight prints: no payload, no token. */
export function formatPreflightReport({ account, database }) {
  const lines = [`account: ${account.name ?? "unnamed account"} (${account.id})`];
  lines.push(
    database.present
      ? `database ${database.name}: present (${database.uuid})`
      : `database ${database.name}: absent`,
  );
  return lines.join("\n");
}

/**
 * Phase 5C preview build guard. The generated `build/server/wrangler.json` is
 * what `wrangler deploy -c build/server/wrangler.json` would ship, so it must
 * carry no D1 binding even if someone adds one to `wrangler.preview.jsonc`
 * (which the isolation gate already refuses, but a built artefact could still be
 * produced before that gate runs). An empty `d1_databases` array is no binding.
 */
export function assertPreviewGeneratedConfig(generatedConfig) {
  if (
    generatedConfig === null ||
    typeof generatedConfig !== "object" ||
    Array.isArray(generatedConfig)
  ) {
    throw new CliError(
      "preflight_unparsed",
      "The generated preview config is not a JSON object; a D1-free build cannot be proven",
      1,
    );
  }
  const databases = generatedConfig.d1_databases;
  if (databases === undefined || databases === null) return generatedConfig;
  if (!Array.isArray(databases)) {
    throw new CliError(
      "preview_binds_d1",
      "The generated preview config declares a d1_databases value that is not a list; the preview Worker is documented as D1-free (workers/preview.ts) and must stay that way",
      1,
    );
  }
  if (databases.length === 0) return generatedConfig;
  const named = databases
    .map((entry) => entry?.database_name ?? entry?.binding ?? "(unnamed)")
    .join(", ");
  throw new CliError(
    "preview_binds_d1",
    `The generated preview config binds D1 (${named}); the preview Worker is documented as D1-free (workers/preview.ts) and must stay that way`,
    1,
  );
}

/**
 * Phase 5C deploy guard. `build:site`, `build:pilot`, `build:staging` and
 * `build:preview` all write the same `build/server/wrangler.json`, so a pilot
 * build followed by `deploy:preview` would ship a D1-bound Worker to the preview
 * host. The generated config must therefore be D1-free *and* be the preview
 * config, checked before Wrangler is spawned.
 */
export function assertPreviewDeployConfig(generatedConfig) {
  // D1 first: a pilot artefact is the dangerous one, and it must be named as
  // such rather than as a generic wrong-config error.
  assertPreviewGeneratedConfig(generatedConfig);

  const configPath =
    typeof generatedConfig.configPath === "string"
      ? generatedConfig.configPath.replaceAll("\\", "/")
      : "";
  if (!configPath.endsWith("/wrangler.preview.jsonc")) {
    throw new CliError(
      "preview_wrong_config",
      `The generated config selected ${configPath || "(no configPath)"}, not wrangler.preview.jsonc; run npm run build:preview before deploy:preview`,
      1,
    );
  }
  if (generatedConfig.name !== "certpath-ui-preview") {
    throw new CliError(
      "preview_wrong_config",
      `The generated config names the ${JSON.stringify(generatedConfig.name)} Worker, not certpath-ui-preview; run npm run build:preview before deploy:preview`,
      1,
    );
  }
  return generatedConfig;
}

// ---------------------------------------------------------------------------
// Replay planning.
//
// A Wrangler dump is one ordered sequence of statements, and replaying it in
// that order is wrong twice over:
//
//   1. it inserts into tables whose parent tables have not been created yet
//      (`audit_events` precedes `certifications` in 0002_local_security.sql, and
//      `PRAGMA defer_foreign_keys` cannot defer a check whose parent table does
//      not exist), and
//   2. it re-fires every `AFTER INSERT` trigger, so the audit rows the dump
//      carries are inserted again under the same `operation_id`.
//
// The rehearsal therefore loads the same statements in three phases — schema,
// then data, then triggers — derived from the verified bytes. The dump itself is
// never edited, so its sha256 stays the hash the manifest recorded.
// ---------------------------------------------------------------------------

/** The pragma a dump uses to let one transaction violate foreign keys mid-load. */
export const DEFER_FOREIGN_KEYS = "PRAGMA defer_foreign_keys=TRUE;";

const TRIGGER_HEAD = /^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i;

function isWordChar(character) {
  return character !== undefined && /[A-Za-z0-9_$]/.test(character);
}

function skipWhitespaceAndComments(text, from) {
  let index = from;
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "-" && next === "-") {
      const newline = text.indexOf("\n", index);
      if (newline === -1) return text.length;
      index = newline + 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end === -1) return text.length;
      index = end + 2;
      continue;
    }
    return index;
  }
  return index;
}

function statementStartsTrigger(text, from) {
  const start = skipWhitespaceAndComments(text, from);
  return TRIGGER_HEAD.test(text.slice(start, start + 48));
}

function classifyStatement(sql) {
  if (/^PRAGMA\b/i.test(sql)) return "schema";
  if (TRIGGER_HEAD.test(sql)) return "triggers";
  if (/^CREATE\b/i.test(sql)) return "schema";
  if (/^(?:INSERT|REPLACE)\b/i.test(sql)) return "data";
  // Wrangler's export resets AUTOINCREMENT counters with exactly this statement;
  // it belongs with the data, after the rows that set them were inserted.
  if (/^DELETE\s+FROM\s+sqlite_sequence\b/i.test(sql)) return "data";
  return "unplanned";
}

/**
 * Split dump text into statements. Semicolons inside string literals,
 * identifiers or comments do not split, and a `CREATE TRIGGER ... BEGIN ...
 * END;` body stays one statement even though it contains semicolons.
 */
export function splitSqlStatements(text) {
  const source = typeof text === "string" ? text : "";
  const statements = [];
  let start = 0;
  let index = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inBracket = false;
  let inLineComment = false;
  let inBlockComment = false;
  let bodyDepth = 0;
  let trigger = statementStartsTrigger(source, 0);

  const finish = (end) => {
    const sql = source.slice(start, end).trim();
    start = end;
    if (sql !== "") statements.push({ sql, kind: classifyStatement(sql) });
    trigger = statementStartsTrigger(source, end);
    bodyDepth = 0;
  };

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (inLineComment) {
      if (character === "\n") inLineComment = false;
      index += 1;
      continue;
    }
    if (inBlockComment) {
      if (character === "*" && next === "/") {
        inBlockComment = false;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (inSingle) {
      if (character === "'") {
        if (next === "'") {
          index += 2;
          continue;
        }
        inSingle = false;
      }
      index += 1;
      continue;
    }
    if (inDouble) {
      if (character === '"') {
        if (next === '"') {
          index += 2;
          continue;
        }
        inDouble = false;
      }
      index += 1;
      continue;
    }
    if (inBacktick) {
      if (character === "`") {
        if (next === "`") {
          index += 2;
          continue;
        }
        inBacktick = false;
      }
      index += 1;
      continue;
    }
    if (inBracket) {
      if (character === "]") inBracket = false;
      index += 1;
      continue;
    }

    if (character === "-" && next === "-") {
      inLineComment = true;
      index += 2;
      continue;
    }
    if (character === "/" && next === "*") {
      inBlockComment = true;
      index += 2;
      continue;
    }
    if (character === "'") {
      inSingle = true;
      index += 1;
      continue;
    }
    if (character === '"') {
      inDouble = true;
      index += 1;
      continue;
    }
    if (character === "`") {
      inBacktick = true;
      index += 1;
      continue;
    }
    if (character === "[") {
      inBracket = true;
      index += 1;
      continue;
    }

    // Inside a trigger body, BEGIN/CASE open and END closes; a semicolon only
    // ends the statement once the body is closed.
    if (trigger && !isWordChar(source[index - 1])) {
      const head = source.slice(index, index + 8).toUpperCase();
      if (head.startsWith("BEGIN") && !isWordChar(source[index + 5])) {
        bodyDepth += 1;
        index += 5;
        continue;
      }
      if (head.startsWith("CASE") && !isWordChar(source[index + 4])) {
        bodyDepth += 1;
        index += 4;
        continue;
      }
      if (head.startsWith("END") && !isWordChar(source[index + 3])) {
        bodyDepth = Math.max(0, bodyDepth - 1);
        index += 3;
        continue;
      }
    }

    if (character === ";") {
      if (!trigger || bodyDepth === 0) finish(index + 1);
      index += 1;
      continue;
    }
    index += 1;
  }

  if (source.slice(start).trim() !== "") finish(source.length);
  return statements;
}

/**
 * The three replay phases, always in this order. `statements` is how many
 * statements the phase holds, so a caller can skip an empty phase.
 */
export function planReplay(statements) {
  const phases = { schema: [], data: [], triggers: [] };
  for (const statement of statements ?? []) {
    const bucket = phases[statement?.kind];
    if (!bucket) {
      throw new CliError(
        "replay_unplanned",
        `The dump contains a statement the rehearsal cannot place: ${JSON.stringify(String(statement?.sql ?? "").slice(0, 80))}`,
        1,
      );
    }
    bucket.push(statement.sql);
  }
  return [
    {
      phase: "schema",
      statements: phases.schema.length,
      sql: phases.schema.map((sql) => `${sql}\n`).join(""),
    },
    {
      phase: "data",
      statements: phases.data.length,
      sql: `${DEFER_FOREIGN_KEYS}\n${phases.data.map((sql) => `${sql}\n`).join("")}`,
    },
    {
      phase: "triggers",
      statements: phases.triggers.length,
      sql: phases.triggers.map((sql) => `${sql}\n`).join(""),
    },
  ];
}
