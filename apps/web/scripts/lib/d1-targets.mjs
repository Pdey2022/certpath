// Pure helpers shared by the Phase 5A data-safety scripts
// (check-d1-isolation, d1-export, d1-restore-rehearse, d1-chain-check).
// Nothing here touches the network, the file system or the environment, so the
// rules that protect a restore can be unit-tested without Wrangler.
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
