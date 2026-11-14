import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  findActiveApplicationSession,
  findUserForIdentity,
} from "../src/security/repository.ts";
import { revokeOwnApplicationSession } from "../src/security/mutations.ts";
import {
  createTestIdentity,
  createTestSession,
  testNow,
} from "./factories.ts";

const database: SecurityDatabase = env.DB;

describe("local application sessions and identities", () => {
  it("resolves exact issuer/subject identities through a primary read", async () => {
    const identity = await createTestIdentity(database);
    expect(
      await findUserForIdentity(database, identity.issuer, identity.subject),
    ).toBe(identity.userId);
    expect(
      await findUserForIdentity(database, identity.issuer, "different-subject"),
    ).toBeNull();
  });

  it("accepts active unexpired sessions, rejects expired sessions, and immediately revokes", async () => {
    const identity = await createTestIdentity(database);
    const validDigest = await createTestSession(database, identity.userId);
    const expiredDigest = await createTestSession(database, identity.userId, {
      now: testNow - 2_000,
      expiresAt: testNow - 1_000,
    });

    expect(
      await findActiveApplicationSession(database, validDigest, testNow),
    ).not.toBeNull();
    expect(
      await findActiveApplicationSession(database, expiredDigest, testNow),
    ).toBeNull();
    expect(
      await findActiveApplicationSession(database, "browser-controlled", testNow),
    ).toBeNull();

    expect(
      await revokeOwnApplicationSession(
        database,
        validDigest,
        testNow + 1,
        `revoke:${crypto.randomUUID()}`,
      ),
    ).toBe(true);
    expect(
      await findActiveApplicationSession(database, validDigest, testNow + 2),
    ).toBeNull();
    expect(
      await revokeOwnApplicationSession(
        database,
        validDigest,
        testNow + 3,
        `revoke:${crypto.randomUUID()}`,
      ),
    ).toBe(false);
  });

  it("rejects sessions after the internal user is disabled", async () => {
    const identity = await createTestIdentity(database);
    const digest = await createTestSession(database, identity.userId);

    // 0016 requires a witness for every disable, so this fixture names one.
    await database
      .prepare(
        `UPDATE users
         SET status = 'disabled',
             deactivation_operation_id = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(`fixture-disable:${crypto.randomUUID()}`, testNow + 1, identity.userId)
      .run();

    expect(
      await findActiveApplicationSession(database, digest, testNow + 2),
    ).toBeNull();
  });
});
