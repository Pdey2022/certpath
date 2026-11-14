import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { SecurityDatabase } from "../src/security/database.ts";
import { buildPilotSeedStatements } from "../src/security/pilot-seed.ts";

const database: SecurityDatabase = env.DB;

function ids() {
  return {
    learnerUserId: crypto.randomUUID(),
    certificationId: crypto.randomUUID(),
    examVersionId: crypto.randomUUID(),
    grantId: crypto.randomUUID(),
  };
}

async function runSeed(input: Parameters<typeof buildPilotSeedStatements>[0]) {
  const statements = buildPilotSeedStatements(input);
  let verification: unknown[] = [];
  for (const [index, statement] of statements.entries()) {
    const result = await database.prepare(statement).all<unknown>();
    if (index === statements.length - 1) verification = result.results;
  }
  return verification;
}

describe("private pilot seed", () => {
  it("creates one learner, one exam, and one active Standard grant", async () => {
    const seed = ids();
    const now = Date.now();
    const verification = await runSeed({ ...seed, now });

    expect(verification).toHaveLength(1);
    expect(verification[0]).toMatchObject({
      learner_user_id: seed.learnerUserId,
      certification_id: seed.certificationId,
      expires_at: now + 7 * 24 * 60 * 60 * 1000,
    });

    const grant = await database
      .prepare(
        "SELECT feature, starts_at, expires_at, revoked_at FROM learner_access_grants WHERE id = ?",
      )
      .bind(seed.grantId)
      .first<{
        feature: string;
        starts_at: number;
        expires_at: number;
        revoked_at: number | null;
      }>();
    expect(grant).toMatchObject({ feature: "standard", revoked_at: null });
    expect(grant!.starts_at).toBeLessThanOrEqual(now);

    const version = await database
      .prepare("SELECT certification_id FROM exam_versions WHERE id = ?")
      .bind(seed.examVersionId)
      .first<{ certification_id: string }>();
    expect(version?.certification_id).toBe(seed.certificationId);
  });

  it("is idempotent when rerun", async () => {
    const seed = ids();
    await runSeed({ ...seed });
    await runSeed({ ...seed });

    const counts = await database
      .prepare(
        `SELECT (SELECT COUNT(*) FROM users WHERE id = ?) AS users,
                (SELECT COUNT(*) FROM certifications WHERE id = ?) AS certifications,
                (SELECT COUNT(*) FROM exam_versions WHERE id = ?) AS versions,
                (SELECT COUNT(*) FROM learner_access_grants WHERE id = ?) AS grants`,
      )
      .bind(
        seed.learnerUserId,
        seed.certificationId,
        seed.examVersionId,
        seed.grantId,
      )
      .first<Record<string, number>>();
    expect(counts).toMatchObject({
      users: 1,
      certifications: 1,
      versions: 1,
      grants: 1,
    });
  });

  it("never creates an identity, so Google linking stays a separate step", async () => {
    const seed = ids();
    await runSeed({ ...seed });
    const identities = await database
      .prepare(
        "SELECT COUNT(*) AS total FROM auth_identities WHERE user_id = ?",
      )
      .bind(seed.learnerUserId)
      .first<{ total: number }>();
    expect(identities?.total).toBe(0);
  });

  it("rejects unsafe input", () => {
    const seed = ids();
    expect(() =>
      buildPilotSeedStatements({ ...seed, learnerUserId: "not-a-uuid" }),
    ).toThrow(/UUID/);
    expect(() =>
      buildPilotSeedStatements({ ...seed, certificationSlug: "Bad Slug'" }),
    ).toThrow(/Slug/);
    expect(() =>
      buildPilotSeedStatements({ ...seed, durationDays: 0 }),
    ).toThrow(/durationDays/);
  });
});
