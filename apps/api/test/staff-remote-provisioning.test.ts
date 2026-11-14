import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  ProvisioningAbort,
  applyProvisioning,
  assertNoExistingTesterRows,
  assertRemoteTarget,
  certpathAccountId,
  confirmProvisioning,
  remoteStaffDatabaseName,
  selectProvisioningTarget,
  type ProvisioningIdentifiers,
  type ProvisioningTarget,
  type WranglerRunner,
} from "../src/staff-provisioning.ts";

const testDatabaseId = "8f3a1c2e-1111-4222-8333-444455556666";
const remoteTarget: ProvisioningTarget = {
  databaseName: remoteStaffDatabaseName,
  remote: true,
  expectedDatabaseId: testDatabaseId,
};

type RunnerOptions = {
  accountId?: string;
  databaseName?: string;
  databaseUuid?: string;
  loggedIn?: boolean;
};

function fakeHash(character: string): string {
  const unit = character.slice(0, 1) || "x";
  return `$scrypt$ln=15,r=8,p=1$${unit.repeat(22)}$${unit.repeat(43)}`;
}

/**
 * Mocked Cloudflare CLI: identity and D1 metadata come from the options, and
 * `d1 execute` runs the generated SQL against the isolated test D1 database.
 */
function createMockRunner(options: RunnerOptions = {}) {
  const calls: string[][] = [];
  const runner: WranglerRunner = async (args) => {
    calls.push(args);
    if (args[0] === "whoami") {
      return JSON.stringify({
        loggedIn: options.loggedIn ?? true,
        accounts: [
          { id: options.accountId ?? certpathAccountId, name: "Certpath" },
        ],
      });
    }
    if (args[0] === "d1" && args[1] === "info") {
      return JSON.stringify({
        name: options.databaseName ?? remoteStaffDatabaseName,
        uuid: options.databaseUuid ?? testDatabaseId,
      });
    }
    if (args[0] === "d1" && args[1] === "execute") {
      const commandIndex = args.indexOf("--command");
      const sql = commandIndex === -1 ? "" : (args[commandIndex + 1] ?? "");
      const statements = sql
        .split(/;(?=\s*(?:\r?\n|$))/)
        .map((statement) => statement.trim())
        .filter(Boolean);
      const output: unknown[] = [];
      for (const statement of statements) {
        const result = await env.DB.prepare(statement).all();
        output.push({ success: true, results: result.results ?? [], meta: result.meta });
      }
      return JSON.stringify(output);
    }
    throw new Error(`unexpected wrangler call: ${args.join(" ")}`);
  };
  return { runner, calls };
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

function buildIdentifiers(
  suffix: string,
  markers: [string, string, string] = ["A", "B", "C"],
): ProvisioningIdentifiers {
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
    hashes: [
      fakeHash(markers[0]),
      fakeHash(markers[1]),
      fakeHash(markers[2]),
    ],
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

describe("remote staff provisioning", () => {
  it("writes exactly two Global Admins and one scoped Manager to the matching target", async () => {
    const identifiers = buildIdentifiers("happy");
    const { runner, calls } = createMockRunner();

    await assertRemoteTarget(runner, testDatabaseId);
    await assertNoExistingTesterRows(runner, remoteTarget, {
      emails: identifiers.emails,
      certificationSlug: identifiers.certificationSlug,
    });
    await applyProvisioning(runner, remoteTarget, identifiers);
    await confirmProvisioning(runner, remoteTarget, identifiers);

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
    expect(
      await scalar(
        "SELECT COUNT(*) AS count FROM exam_versions WHERE id = ? AND certification_id = ?",
        identifiers.examVersionId,
        identifiers.certificationId,
      ),
    ).toBe(1);

    const stored = await env.DB.prepare(
      "SELECT password_hash FROM staff_password_credentials WHERE user_id = ?",
    )
      .bind(identifiers.userIds[0])
      .first<{ password_hash: string }>();
    expect(stored?.password_hash).toBe(identifiers.hashes[0]);

    const allArgs = calls.flat().join(" ");
    expect(allArgs).toContain("--remote");
    expect(allArgs).not.toContain("--local");
    for (const hash of identifiers.hashes) {
      expect(allArgs).toContain(hash);
    }
    for (const secret of ["Alpha", "Bravo", "Charlie"]) {
      expect(allArgs).not.toContain(`${secret}`);
    }
  });

  it("writes nothing when the CLI is not on the Certpath account", async () => {
    const before = await snapshot();
    const { runner, calls } = createMockRunner({
      accountId: "00000000-0000-0000-0000-00000000dead",
    });

    expect(
      await abortCode(() => assertRemoteTarget(runner, testDatabaseId)),
    ).toBe("wrong-account");

    expect(await snapshot()).toEqual(before);
    expect(calls.some((args) => args[1] === "execute")).toBe(false);
  });

  it("writes nothing when the database UUID does not match", async () => {
    const before = await snapshot();
    const { runner, calls } = createMockRunner({
      databaseUuid: "11111111-2222-4333-8444-555555555555",
    });

    expect(
      await abortCode(() => assertRemoteTarget(runner, testDatabaseId)),
    ).toBe("wrong-database-id");

    expect(await snapshot()).toEqual(before);
    expect(calls.some((args) => args[1] === "execute")).toBe(false);
  });

  it("writes nothing when the database name is not certpath-admin", async () => {
    const before = await snapshot();
    const { runner } = createMockRunner({ databaseName: "certpath-local" });

    expect(
      await abortCode(() => assertRemoteTarget(runner, testDatabaseId)),
    ).toBe("wrong-database-name");

    expect(await snapshot()).toEqual(before);
  });

  it("writes nothing when a tester account already exists", async () => {
    const identifiers = buildIdentifiers("existing");
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
    const { runner, calls } = createMockRunner();

    expect(
      await abortCode(() =>
        assertNoExistingTesterRows(runner, remoteTarget, {
          emails: identifiers.emails,
          certificationSlug: identifiers.certificationSlug,
        }),
      ),
    ).toBe("existing-tester-rows");

    expect(await snapshot()).toEqual(before);
    const executed = calls
      .filter((args) => args[1] === "execute")
      .map((args) => args[args.indexOf("--command") + 1] ?? "");
    expect(executed.every((sql) => sql.includes("SELECT COUNT"))).toBe(true);
  });
});

describe("provisioning target selection", () => {
  it("defaults to the local database", () => {
    expect(selectProvisioningTarget([])).toEqual({
      databaseName: "certpath-local",
      remote: false,
      expectedDatabaseId: null,
    });
  });

  it("requires an explicit recorded UUID for remote mode", () => {
    expect(() => selectProvisioningTarget(["--remote"])).toThrowError(
      /--remote requires --expect-database-id/,
    );
    expect(() =>
      selectProvisioningTarget(["--remote", "--expect-database-id", "not-a-uuid"]),
    ).toThrowError(/must be a lowercase UUID/);
  });

  it("accepts the pinned remote database with its UUID", () => {
    expect(
      selectProvisioningTarget([
        "--remote",
        "--expect-database-id",
        "8F3A1C2E-1111-4222-8333-444455556666",
      ]),
    ).toEqual({
      databaseName: "certpath-admin",
      remote: true,
      expectedDatabaseId: testDatabaseId,
    });
  });

  it("rejects a UUID outside remote mode", () => {
    expect(() =>
      selectProvisioningTarget(["--expect-database-id", testDatabaseId]),
    ).toThrowError(/only applies to --remote/);
  });
});
