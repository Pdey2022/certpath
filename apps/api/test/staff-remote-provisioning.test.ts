import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  ProvisioningAbort,
  applyProvisioning,
  approvedRemoteDatabases,
  assertNoExistingTesterRows,
  assertRemoteTarget,
  certpathAccountId,
  confirmProvisioning,
  createProvisioningTickets,
  pinRemoteTarget,
  pinnedDatabaseBinding,
  resolveRemoteDatabase,
  selectProvisioningTarget,
  unprovisionedRemoteDatabases,
  type ProvisioningIdentifiers,
  type ProvisioningSelection,
  type ProvisioningTarget,
  type WranglerRunner,
} from "../src/staff-provisioning.ts";

const stagingDatabaseName = "certpath-learner-staging";
const stagingDatabaseId = "c52e398f-4280-40a6-8244-854186dc6ef2";
/** A well-formed UUID that is deliberately not the recorded staging one. */
const replacementDatabaseId = "9d4b2e3f-5555-4666-8777-888899990000";
const pinnedConfigPath = "C:/tmp/certpath-staff-provisioning.jsonc";

const selection: ProvisioningSelection = {
  kind: "remote",
  databaseName: stagingDatabaseName,
  expectedDatabaseId: stagingDatabaseId,
};
const pinnedTarget: ProvisioningTarget = {
  kind: "remote",
  databaseName: stagingDatabaseName,
  expectedDatabaseId: stagingDatabaseId,
  bindingName: pinnedDatabaseBinding,
  configPath: pinnedConfigPath,
};

function fakeHash(character: string): string {
  const unit = character.slice(0, 1) || "x";
  return `$scrypt$ln=15,r=8,p=1$${unit.repeat(22)}$${unit.repeat(43)}`;
}

type MockState = {
  accountId: string;
  loggedIn: boolean;
  /** Name reported back by `d1 info`; defaults to the requested name. */
  resolvedName: string | null;
  /** What the staging database name currently resolves to. Mutated to simulate a swap. */
  nameToUuid: Record<string, string>;
  /** What the run-only config carries; only ever the verified UUID. */
  pinnedUuid: string;
  calls: string[][];
  /** SQL executed through the verified UUID (the live test database). */
  pinnedExecutions: string[];
  /** SQL that reached a different database resolved behind the name. */
  replacementWrites: string[];
};

/**
 * Mocked Cloudflare CLI. `d1 info` resolves the name, while `d1 execute`
 * resolves either the pinned binding (UUID) or, if the code regresses, the name.
 */
function createMockRunner(options: Partial<MockState> = {}) {
  const state: MockState = {
    accountId: options.accountId ?? certpathAccountId,
    loggedIn: options.loggedIn ?? true,
    resolvedName: options.resolvedName ?? null,
    nameToUuid: options.nameToUuid ?? {
      [stagingDatabaseName]: stagingDatabaseId,
    },
    pinnedUuid: options.pinnedUuid ?? stagingDatabaseId,
    calls: [],
    pinnedExecutions: [],
    replacementWrites: [],
  };

  const apply = async (sql: string) => {
    const statements = sql
      .split(/;(?=\s*(?:\r?\n|$))/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    const output: unknown[] = [];
    for (const statement of statements) {
      const result = await env.DB.prepare(statement).all();
      output.push({
        success: true,
        results: result.results ?? [],
        meta: result.meta,
      });
    }
    return JSON.stringify(output);
  };

  const runner: WranglerRunner = async (args) => {
    state.calls.push(args);
    if (args[0] === "whoami") {
      return JSON.stringify({
        loggedIn: state.loggedIn,
        accounts: [{ id: state.accountId, name: "Certpath" }],
      });
    }
    if (args[0] === "d1" && args[1] === "info") {
      const name = args[2] ?? "";
      return JSON.stringify({
        name: state.resolvedName ?? name,
        uuid: state.nameToUuid[name] ?? "",
      });
    }
    if (args[0] === "d1" && args[1] === "execute") {
      const positional = args[2] ?? "";
      const configIndex = args.indexOf("--config");
      const configPath = configIndex === -1 ? undefined : args[configIndex + 1];
      const commandIndex = args.indexOf("--command");
      const sql = commandIndex === -1 ? "" : (args[commandIndex + 1] ?? "");
      const pinned =
        positional === pinnedDatabaseBinding && configPath === pinnedConfigPath;
      const uuid = pinned
        ? state.pinnedUuid
        : (state.nameToUuid[positional] ?? positional);
      if (uuid === stagingDatabaseId) {
        state.pinnedExecutions.push(sql);
        return apply(sql);
      }
      // A different database is now behind that name: record and refuse.
      state.replacementWrites.push(sql);
      return JSON.stringify([{ success: true, results: [], meta: {} }]);
    }
    throw new Error(`unexpected wrangler call: ${args.join(" ")}`);
  };

  return { runner, state };
}

async function scalar(
  sql: string,
  ...bindings: (string | number)[]
): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...bindings)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function snapshot(): Promise<Record<string, number>> {
  return {
    users: await scalar("SELECT COUNT(*) AS count FROM users"),
    roles: await scalar("SELECT COUNT(*) AS count FROM staff_roles"),
    credentials: await scalar(
      "SELECT COUNT(*) AS count FROM staff_password_credentials",
    ),
    certifications: await scalar("SELECT COUNT(*) AS count FROM certifications"),
    assignments: await scalar(
      "SELECT COUNT(*) AS count FROM manager_certification_assignments",
    ),
  };
}

async function buildIdentifiers(
  suffix: string,
): Promise<ProvisioningIdentifiers> {
  return {
    emails: [
      `remote-one-${suffix}@example.test`,
      `remote-two-${suffix}@example.test`,
      `remote-manager-${suffix}@example.test`,
    ],
    userIds: [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ],
    certificationId: crypto.randomUUID(),
    examVersionId: crypto.randomUUID(),
    certificationSlug: `remote-rehearsal-${suffix}`,
    certificationName: `Remote rehearsal ${suffix}`,
    examVersionKey: "v1",
    hashes: [fakeHash("A"), fakeHash("B"), fakeHash("C")],
    enrolmentTickets: await createProvisioningTickets(),
    now: 1763150000000,
  };
}

async function abortCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ProvisioningAbort) return error.code;
    throw error;
  }
  throw new Error("expected the provisioning run to abort, but it completed");
}

/** The same contract for the pure, synchronous target resolution. */
function abortCodeOfSelection(argv: string[]): string {
  try {
    selectProvisioningTarget(argv);
  } catch (error) {
    if (error instanceof ProvisioningAbort) return error.code;
    throw error;
  }
  throw new Error("expected the target selection to abort, but it resolved");
}

describe("remote staff provisioning", () => {
  it("writes exactly two Global Admins and one scoped Manager through the pinned binding", async () => {
    const identifiers = await buildIdentifiers("happy");
    const { runner, state } = createMockRunner();

    await assertRemoteTarget(runner, {
      name: stagingDatabaseName,
      databaseId: stagingDatabaseId,
    });
    const target = pinRemoteTarget(selection, pinnedConfigPath);
    await assertNoExistingTesterRows(runner, target, {
      emails: identifiers.emails,
      certificationSlug: identifiers.certificationSlug,
    });
    await applyProvisioning(runner, target, identifiers);
    await confirmProvisioning(runner, target, identifiers);

    expect(
      await scalar(
        "SELECT COUNT(*) AS count FROM staff_password_credentials WHERE email_normalized IN (?, ?, ?)",
        ...identifiers.emails,
      ),
    ).toBe(3);
    expect(
      await scalar(
        "SELECT COUNT(*) AS count FROM staff_roles WHERE active = 1 AND role = 'global_admin' AND user_id IN (?, ?, ?)",
        ...identifiers.userIds,
      ),
    ).toBe(2);
    expect(
      await scalar(
        "SELECT COUNT(*) AS count FROM staff_roles WHERE active = 1 AND role = 'manager' AND user_id IN (?, ?, ?)",
        ...identifiers.userIds,
      ),
    ).toBe(1);
    expect(
      await scalar(
        "SELECT COUNT(*) AS count FROM manager_certification_assignments WHERE active = 1 AND manager_user_id = ? AND certification_id = ?",
        identifiers.userIds[2],
        identifiers.certificationId,
      ),
    ).toBe(1);

    const stored = await env.DB.prepare(
      "SELECT password_hash FROM staff_password_credentials WHERE user_id = ?",
    )
      .bind(identifiers.userIds[0])
      .first<{ password_hash: string }>();
    expect(stored?.password_hash).toBe(identifiers.hashes[0]);

    const executes = state.calls.filter(
      (args) => args[1] === "execute" && args.includes("--remote"),
    );
    expect(executes.length).toBeGreaterThan(0);
    for (const args of executes) {
      expect(args[2]).toBe(pinnedDatabaseBinding);
      expect(args).toContain("--config");
      expect(args).toContain(pinnedConfigPath);
      expect(args).not.toContain(stagingDatabaseName);
    }
    expect(state.replacementWrites).toEqual([]);

    const allArgs = state.calls.flat().join(" ");
    expect(allArgs).toContain(fakeHash("A"));
    expect(allArgs).not.toContain("Alpha");
  });

  it("writes nothing to a database swapped in behind the staging name after preflight", async () => {
    const identifiers = await buildIdentifiers("swapped");
    const { runner, state } = createMockRunner();

    await assertRemoteTarget(runner, {
      name: stagingDatabaseName,
      databaseId: stagingDatabaseId,
    });
    const target = pinRemoteTarget(selection, pinnedConfigPath);

    // The name now points at a different database.
    state.nameToUuid[stagingDatabaseName] = replacementDatabaseId;

    await assertNoExistingTesterRows(runner, target, {
      emails: identifiers.emails,
      certificationSlug: identifiers.certificationSlug,
    });
    await applyProvisioning(runner, target, identifiers);
    await confirmProvisioning(runner, target, identifiers);

    expect(state.replacementWrites).toEqual([]);
    expect(
      await scalar(
        "SELECT COUNT(*) AS count FROM staff_password_credentials WHERE email_normalized IN (?, ?, ?)",
        ...identifiers.emails,
      ),
    ).toBe(3);

    for (const args of state.calls.filter((call) => call[1] === "execute")) {
      expect(args[2]).toBe(pinnedDatabaseBinding);
      expect(args).not.toContain(stagingDatabaseName);
    }
    const nameLookups = state.calls.filter((call) => call[1] === "info");
    expect(nameLookups).toHaveLength(1);
    expect(nameLookups[0]?.[2]).toBe(stagingDatabaseName);
  });

  it("fails closed when the verified UUID is unavailable", async () => {
    const identifiers = await buildIdentifiers("unavailable");
    const before = await snapshot();
    const { runner, state } = createMockRunner();
    const broken: ProvisioningTarget = {
      kind: "remote",
      databaseName: stagingDatabaseName,
      expectedDatabaseId: "",
      bindingName: pinnedDatabaseBinding,
      configPath: pinnedConfigPath,
    };

    expect(await abortCode(() => applyProvisioning(runner, broken, identifiers))).toBe(
      "missing-database-id",
    );
    expect(() => pinRemoteTarget(selection, "")).toThrowError(
      /pinned Wrangler config/,
    );
    expect(state.calls).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("writes nothing when the CLI is not on the Certpath account", async () => {
    const before = await snapshot();
    const { runner, state } = createMockRunner({
      accountId: "00000000-0000-0000-0000-00000000dead",
    });

    expect(
      await abortCode(() =>
        assertRemoteTarget(runner, {
          name: stagingDatabaseName,
          databaseId: stagingDatabaseId,
        }),
      ),
    ).toBe("wrong-account");

    expect(await snapshot()).toEqual(before);
    expect(state.calls.some((args) => args[1] === "execute")).toBe(false);
  });

  it("writes nothing when the database UUID does not match", async () => {
    const before = await snapshot();
    const { runner, state } = createMockRunner({
      nameToUuid: { [stagingDatabaseName]: replacementDatabaseId },
    });

    expect(
      await abortCode(() =>
        assertRemoteTarget(runner, {
          name: stagingDatabaseName,
          databaseId: stagingDatabaseId,
        }),
      ),
    ).toBe("wrong-database-id");

    expect(await snapshot()).toEqual(before);
    expect(state.calls.some((args) => args[1] === "execute")).toBe(false);
  });

  it("writes nothing when the database name is not the staging database", async () => {
    const before = await snapshot();
    const { runner } = createMockRunner({ resolvedName: "certpath-local" });

    expect(
      await abortCode(() =>
        assertRemoteTarget(runner, {
          name: stagingDatabaseName,
          databaseId: stagingDatabaseId,
        }),
      ),
    ).toBe("wrong-database-name");

    expect(await snapshot()).toEqual(before);
  });

  it("refuses a pair that is not on the allowlist before spawning the CLI", async () => {
    const before = await snapshot();
    const { runner, state } = createMockRunner();

    expect(
      await abortCode(() =>
        assertRemoteTarget(runner, {
          name: stagingDatabaseName,
          databaseId: replacementDatabaseId,
        }),
      ),
    ).toBe("database-id-mismatch");
    expect(
      await abortCode(() =>
        assertRemoteTarget(runner, {
          name: "certpath-admin",
          databaseId: replacementDatabaseId,
        }),
      ),
    ).toBe("database-not-provisioned");
    expect(
      await abortCode(() =>
        assertRemoteTarget(runner, {
          name: "certpath-learner-pilot",
          databaseId: replacementDatabaseId,
        }),
      ),
    ).toBe("unapproved-database");

    expect(state.calls).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("writes nothing when a tester account already exists", async () => {
    const identifiers = await buildIdentifiers("existing");
    const now = 1763150000000;
    const existingUser = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO users (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)",
    )
      .bind(existingUser, now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO staff_password_credentials (
         user_id, email, email_normalized, password_hash, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        existingUser,
        identifiers.emails[1],
        identifiers.emails[1],
        fakeHash("Z"),
        now,
        now,
      )
      .run();

    const before = await snapshot();
    const { runner, state } = createMockRunner();

    expect(
      await abortCode(() =>
        assertNoExistingTesterRows(runner, pinnedTarget, {
          emails: identifiers.emails,
          certificationSlug: identifiers.certificationSlug,
        }),
      ),
    ).toBe("existing-tester-rows");

    expect(await snapshot()).toEqual(before);
    const executed = state.pinnedExecutions;
    expect(executed.every((sql) => sql.includes("SELECT COUNT"))).toBe(true);
  });
});

describe("provisioning target selection", () => {
  it("defaults to the local database", () => {
    expect(selectProvisioningTarget([])).toEqual({
      kind: "local",
      databaseName: "certpath-local",
    });
  });

  it("requires a database name and its recorded UUID together for remote mode", () => {
    expect(() => selectProvisioningTarget(["--remote"])).toThrowError(
      /--remote requires --database/,
    );
    // A name on its own is not a target.
    expect(
      abortCodeOfSelection(["--remote", "--database", stagingDatabaseName]),
    ).toBe("missing-database-id");
    // A UUID on its own is not a target either.
    expect(
      abortCodeOfSelection([
        "--remote",
        "--expect-database-id",
        stagingDatabaseId,
      ]),
    ).toBe("missing-database-name");
    expect(() =>
      selectProvisioningTarget(["--remote", "--database"]),
    ).toThrowError(/--database requires a value|requires the recorded name/);
    expect(() =>
      selectProvisioningTarget(["--remote", "--expect-database-id"]),
    ).toThrowError(/requires a value|requires the UUID recorded/);
  });

  it("accepts the staging database with its recorded UUID, in any case", () => {
    expect(
      selectProvisioningTarget([
        "--remote",
        "--database",
        stagingDatabaseName,
        "--expect-database-id",
        stagingDatabaseId.toUpperCase(),
      ]),
    ).toEqual({
      kind: "remote",
      databaseName: stagingDatabaseName,
      expectedDatabaseId: stagingDatabaseId,
    });
  });

  it("rejects a UUID that belongs to another database", () => {
    expect(
      abortCodeOfSelection([
        "--remote",
        "--database",
        stagingDatabaseName,
        "--expect-database-id",
        replacementDatabaseId,
      ]),
    ).toBe("database-id-mismatch");
  });

  it("rejects a value that is not a UUID", () => {
    expect(
      abortCodeOfSelection([
        "--remote",
        "--database",
        stagingDatabaseName,
        "--expect-database-id",
        "not-a-uuid",
      ]),
    ).toBe("invalid-database-id");
  });

  it("rejects a database that is not on the allowlist", () => {
    expect(
      abortCodeOfSelection([
        "--remote",
        "--database",
        "certpath-learner-pilot",
        "--expect-database-id",
        replacementDatabaseId,
      ]),
    ).toBe("unapproved-database");
    expect(resolveRemoteDatabase(stagingDatabaseName, stagingDatabaseId)).toEqual(
      approvedRemoteDatabases[0],
    );
    expect(approvedRemoteDatabases).toHaveLength(1);
  });

  it("rejects certpath-admin, which was never provisioned", () => {
    expect(unprovisionedRemoteDatabases).toContain("certpath-admin");
    expect(
      abortCodeOfSelection([
        "--remote",
        "--database",
        "certpath-admin",
        "--expect-database-id",
        replacementDatabaseId,
      ]),
    ).toBe("database-not-provisioned");
    expect(() => resolveRemoteDatabase("certpath-admin", "")).toThrowError(
      /never provisioned/,
    );
  });

  it("rejects a remote-only flag pair outside remote mode", () => {
    expect(() =>
      selectProvisioningTarget(["--expect-database-id", stagingDatabaseId]),
    ).toThrowError(/only applies to --remote/);
    expect(
      abortCodeOfSelection(["--database", stagingDatabaseName]),
    ).toBe("unexpected-database-name");
  });
});
