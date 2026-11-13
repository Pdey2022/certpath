import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  buildGoogleInviteLinkSql,
  googleIdentityIssuer,
} from "../src/security/google-invite.ts";

const database: SecurityDatabase = env.DB;

async function createUser(status: "active" | "disabled" = "active") {
  const id = crypto.randomUUID();
  const now = Date.now();
  await database
    .prepare(
      "INSERT INTO users (id, status, created_at, updated_at) VALUES (?, ?, ?, ?)",
    )
    .bind(id, status, now, now)
    .run();
  return id;
}

async function linkIdentity(userId: string, subject: string) {
  await database
    .prepare(
      "INSERT INTO auth_identities (issuer, subject, user_id, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(googleIdentityIssuer, subject, userId, Date.now())
    .run();
}

describe("operator Google invite link", () => {
  it("links one Google subject to an existing learner", async () => {
    const userId = await createUser();
    const subject = `google-${crypto.randomUUID()}`;
    const rows = await database
      .prepare(buildGoogleInviteLinkSql({ userId, subject }))
      .all<{ issuer: string; subject: string; user_id: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      issuer: googleIdentityIssuer,
      subject,
      user_id: userId,
    });
  });

  it("refuses an unknown learner and creates nothing", async () => {
    const subject = `google-${crypto.randomUUID()}`;
    const rows = await database
      .prepare(buildGoogleInviteLinkSql({ userId: crypto.randomUUID(), subject }))
      .all();
    expect(rows.results).toHaveLength(0);
    const stored = await database
      .prepare("SELECT COUNT(*) AS total FROM auth_identities WHERE subject = ?")
      .bind(subject)
      .first<{ total: number }>();
    expect(stored?.total).toBe(0);
  });

  it("refuses a disabled learner", async () => {
    const userId = await createUser("disabled");
    const rows = await database
      .prepare(
        buildGoogleInviteLinkSql({
          userId,
          subject: `google-${crypto.randomUUID()}`,
        }),
      )
      .all();
    expect(rows.results).toHaveLength(0);
  });

  it("refuses a learner that already has an identity", async () => {
    const userId = await createUser();
    await linkIdentity(userId, `google-${crypto.randomUUID()}`);
    const rows = await database
      .prepare(
        buildGoogleInviteLinkSql({
          userId,
          subject: `google-${crypto.randomUUID()}`,
        }),
      )
      .all();
    expect(rows.results).toHaveLength(0);
  });

  it("refuses a subject already linked to another learner", async () => {
    const subject = `google-${crypto.randomUUID()}`;
    await linkIdentity(await createUser(), subject);
    const rows = await database
      .prepare(
        buildGoogleInviteLinkSql({ userId: await createUser(), subject }),
      )
      .all();
    expect(rows.results).toHaveLength(0);
  });

  it("rejects input that is not a UUID or a safe subject", () => {
    expect(() =>
      buildGoogleInviteLinkSql({ userId: "not-a-uuid", subject: "abc" }),
    ).toThrow(/UUID/);
    expect(() =>
      buildGoogleInviteLinkSql({
        userId: crypto.randomUUID(),
        subject: "abc' OR 1=1 --",
      }),
    ).toThrow(/subject/);
  });
});
