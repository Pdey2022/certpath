import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/index.ts";
import type { SecurityDatabase } from "../src/security/database.ts";
import { sessionDigest } from "../src/security/http-session.ts";
import { hashLearnerPassword } from "../src/security/password-hashing.ts";
import {
  createEnrolmentTicket,
  openTotpSeed,
  readSealKey,
  sha256Hex,
  totpCodeAt,
  totpStepAt,
} from "../src/security/totp.ts";
import { createTestIdentity, grantTestRole } from "./factories.ts";

// The 5F test plan, one test per promise:
//
//   sign-in mints no assurance            enrolment requires a ticket
//   verify upgrades the session in place  enrolment cannot overwrite a factor
//   verify rejects a replayed step        confirm returns ten codes once
//   verify accepts t-1, rejects t-2       recovery code is single-use
//   verify refuses a revoked credential   recovery mints no assurance
//   reset by a Global Admin               a Manager cannot reset
//
// Each one is written so that removing its guard turns it red. The replay test
// is the important one: it replays an observed code on a *second* session, so
// the assertion is about access, not just about a status code.

const database: SecurityDatabase = env.DB;
const origin = "https://localhost";
const csrfSecret = "local-worker-test-csrf-secret-with-enough-entropy";
const staffRateSecret =
  "local-worker-test-staff-rate-limit-secret-with-enough-entropy";
const sealKey = "local-worker-test-staff-mfa-seal-key-with-enough-entropy";
const staffPassword = "synthetic-tester-password-with-enough-length";
const testerIps = Array.from({ length: 200 }, (_, index) => `203.0.113.${index + 10}`);
const testerIp = testerIps[0]!;
let ipIndex = 0;

function nextIp(): string {
  const ip = testerIps[ipIndex % testerIps.length]!;
  ipIndex += 1;
  return ip;
}

let clock = Date.now();
const application = createApi(fetch, () => clock);

const bindings: Record<string, unknown> = {
  DB: database,
  PUBLIC_SITE_ORIGIN: origin,
  CSRF_HMAC_SECRET: csrfSecret,
  STAFF_RATE_LIMIT_HMAC_SECRET: staffRateSecret,
  STAFF_MFA_MAX_AGE_MS: String(8 * 60 * 60 * 1000),
  STAFF_MFA_ALLOWED_METHODS: "totp",
  STAFF_MFA_SEAL_KEY: sealKey,
  ADMIN_TESTER_IPS: testerIps.join(","),
};

let passwordHash = "";

beforeAll(async () => {
  passwordHash = await hashLearnerPassword(staffPassword);
});

function url(path: string): string {
  return `${origin}/api${path}`;
}

function uniqueEmail(label: string): string {
  return `${label}-${crypto.randomUUID()}@example.test`;
}

async function provisionStaff(
  role: "global_admin" | "manager",
  email: string,
): Promise<string> {
  const identity = await createTestIdentity(database);
  await grantTestRole(database, identity.userId, role);
  await database
    .prepare(
      `INSERT INTO staff_password_credentials (
         user_id, email, email_normalized, password_hash, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(identity.userId, email, email, passwordHash, clock, clock)
    .run();
  return identity.userId;
}

async function signIn(
  email: string,
  override: Record<string, unknown> = {},
): Promise<Response> {
  return application.fetch(
    new Request(url("/admin/auth/sign-in"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "CF-Connecting-IP": nextIp(),
      },
      body: JSON.stringify({ email, password: staffPassword }),
    }),
    { ...bindings, ...override },
  );
}

function sessionToken(response: Response): string {
  const token = response.headers
    .get("set-cookie")
    ?.match(/certpath_session=([A-Za-z0-9_-]{43})/)?.[1];
  if (!token) throw new Error("Staff sign-in response omitted its session cookie");
  return token;
}

async function signedInCookie(
  email: string,
  override: Record<string, unknown> = {},
): Promise<string> {
  const response = await signIn(email, override);
  expect(response.status).toBe(200);
  return sessionToken(response);
}

async function adminCsrf(cookie: string): Promise<string> {
  const response = await application.fetch(
    new Request(url("/admin/csrf"), {
      headers: {
        Cookie: `certpath_session=${cookie}`,
        "CF-Connecting-IP": nextIp(),
      },
    }),
    bindings,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { csrfToken: string }).csrfToken;
}

async function postMfa(
  path: string,
  cookie: string,
  body: unknown,
  override: Record<string, unknown> = {},
  options: { csrf?: string } = {},
): Promise<Response> {
  const token = options.csrf ?? (await adminCsrf(cookie));
  return application.fetch(
    new Request(url(`/admin/auth${path}`), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "CF-Connecting-IP": nextIp(),
        Cookie: `certpath_session=${cookie}`,
        "X-CSRF-Token": token,
      },
      body: JSON.stringify(body),
    }),
    { ...bindings, ...override },
  );
}

/** One printed ticket, written straight to storage as provisioning does. */
async function issueTicket(
  userId: string,
  options: { createdAt?: number; expiresAt?: number; revokedAt?: number } = {},
): Promise<string> {
  const token = createEnrolmentTicket();
  const createdAt = options.createdAt ?? clock;
  await database
    .prepare(
      `INSERT INTO staff_mfa_enrolment_tickets (
         ticket_digest, user_id, created_by_user_id, created_by_ref, created_at,
         expires_at, consumed_at, consumed_operation_id, revoked_at
       ) VALUES (?, ?, NULL, 'test-provisioning', ?, ?, NULL, NULL, ?)`,
    )
    .bind(
      await sha256Hex(token),
      userId,
      createdAt,
      options.expiresAt ?? createdAt + 24 * 60 * 60 * 1000,
      options.revokedAt ?? null,
    )
    .run();
  return token;
}

async function readCredential(userId: string) {
  return database
    .prepare(
      `SELECT credential_id, secret_ciphertext, secret_iv, last_used_step,
              confirmed_at, revoked_at
       FROM staff_totp_credentials
       WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .bind(userId)
    .first<{
      credential_id: string;
      secret_ciphertext: string;
      secret_iv: string;
      last_used_step: number;
      confirmed_at: number | null;
      revoked_at: number | null;
    }>();
}

/** Recovers the seed the route sealed, so codes can be computed honestly. */
async function seedFor(userId: string): Promise<Uint8Array> {
  const credential = await readCredential(userId);
  if (!credential) throw new Error("No credential to open");
  const key = await readSealKey(sealKey);
  if (!key) throw new Error("The test seal key is unusable");
  const seed = await openTotpSeed(
    key,
    credential.secret_ciphertext,
    credential.secret_iv,
  );
  if (!seed) throw new Error("The sealed seed did not open");
  return seed;
}

function codeAt(seed: Uint8Array, atMs: number): Promise<string> {
  return totpCodeAt(seed, totpStepAt(atMs));
}

/** Sign in, enrol with a ticket and confirm. Returns the session + seed. */
async function enrolConfirmed(
  email: string,
  userId: string,
): Promise<{ cookie: string; seed: Uint8Array; recoveryCodes: string[] }> {
  const cookie = await signedInCookie(email);
  const ticket = await issueTicket(userId);
  const enrolled = await postMfa("/mfa/enrol", cookie, { ticket });
  expect(enrolled.status).toBe(200);
  const seed = await seedFor(userId);
  const confirmed = await postMfa("/mfa/enrol/confirm", cookie, {
    code: await codeAt(seed, clock),
  });
  expect(confirmed.status).toBe(200);
  const { recoveryCodes } = (await confirmed.json()) as {
    recoveryCodes: string[];
  };
  return { cookie, seed, recoveryCodes };
}

async function readSession(cookie: string) {
  return database
    .prepare(
      `SELECT mfa_method, mfa_verified_at FROM app_sessions WHERE token_digest = ?`,
    )
    .bind(await sessionDigest(cookie))
    .first<{ mfa_method: string | null; mfa_verified_at: number | null }>();
}

describe("staff second factor", () => {
  it("sign-in mints no assurance", async () => {
    const email = uniqueEmail("mfa-no-assurance");
    const userId = await provisionStaff("global_admin", email);

    const response = await signIn(email);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirectTo: "/admin/mfa/verify" });
    const cookie = sessionToken(response);

    expect(await readSession(cookie)).toEqual({
      mfa_method: null,
      mfa_verified_at: null,
    });

    const session = await application.fetch(
      new Request(url("/admin/auth/session"), {
        headers: {
          Cookie: `certpath_session=${cookie}`,
          "CF-Connecting-IP": testerIp,
        },
      }),
      bindings,
    );
    expect(session.status).toBe(403);
    expect(await session.json()).toMatchObject({
      error: { code: "mfa-assurance-missing" },
    });

    const credential = await readCredential(userId);
    expect(credential).toBeNull();
  });

  it("verify upgrades the session in place", async () => {
    const email = uniqueEmail("mfa-verify-in-place");
    const userId = await provisionStaff("global_admin", email);
    const { cookie, seed } = await enrolConfirmed(email, userId);
    const tokenDigest = await sessionDigest(cookie);

    const verified = await postMfa("/mfa/verify", cookie, {
      code: await codeAt(seed, clock),
    });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({
      redirectTo: "/admin/question-editor",
    });

    const session = await readSession(cookie);
    expect(session?.mfa_method).toBe("totp");
    expect(session?.mfa_verified_at).toBe(clock);
    // Same row, not a new session: the upgrade is an UPDATE on the sign-in row.
    const rows = await database
      .prepare("SELECT COUNT(*) AS count FROM app_sessions WHERE user_id = ?")
      .bind(userId)
      .first<{ count: number }>();
    expect(rows?.count).toBe(1);
    const stored = await database
      .prepare("SELECT user_id FROM app_sessions WHERE token_digest = ?")
      .bind(tokenDigest)
      .first<{ user_id: string }>();
    expect(stored?.user_id).toBe(userId);

    const admin = await application.fetch(
      new Request(url("/admin/auth/session"), {
        headers: {
          Cookie: `certpath_session=${cookie}`,
          "CF-Connecting-IP": testerIp,
        },
      }),
      bindings,
    );
    expect(admin.status).toBe(200);
  });

  it("verify rejects a replayed step", async () => {
    const email = uniqueEmail("mfa-replay");
    const userId = await provisionStaff("global_admin", email);
    const { cookie, seed } = await enrolConfirmed(email, userId);
    const code = await codeAt(seed, clock);

    expect((await postMfa("/mfa/verify", cookie, { code })).status).toBe(200);

    // The same code, replayed on a *different* password-only session.
    const replayCookie = await signedInCookie(email);
    const replay = await postMfa("/mfa/verify", replayCookie, { code });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({
      error: { code: "invalid_code" },
    });
    expect(await readSession(replayCookie)).toEqual({
      mfa_method: null,
      mfa_verified_at: null,
    });
  });

  it("verify accepts t-1 and rejects t-2", async () => {
    const acceptedEmail = uniqueEmail("mfa-skew-accepted");
    const acceptedId = await provisionStaff("global_admin", acceptedEmail);
    const accepted = await enrolConfirmed(acceptedEmail, acceptedId);
    const previous = await postMfa("/mfa/verify", accepted.cookie, {
      code: await codeAt(accepted.seed, clock - 30_000),
    });
    expect(previous.status).toBe(200);

    const rejectedEmail = uniqueEmail("mfa-skew-rejected");
    const rejectedId = await provisionStaff("global_admin", rejectedEmail);
    const rejected = await enrolConfirmed(rejectedEmail, rejectedId);
    const tooFar = await postMfa("/mfa/verify", rejected.cookie, {
      code: await codeAt(rejected.seed, clock - 60_000),
    });
    expect(tooFar.status).toBe(400);
    expect(await tooFar.json()).toMatchObject({
      error: { code: "invalid_code" },
    });
    expect((await readSession(rejected.cookie))?.mfa_method).toBeNull();
  });

  it("verify refuses a revoked credential", async () => {
    const email = uniqueEmail("mfa-revoked");
    const userId = await provisionStaff("global_admin", email);
    const { cookie, seed } = await enrolConfirmed(email, userId);

    await database
      .prepare(
        `UPDATE staff_totp_credentials
         SET revoked_at = ?, revoked_operation_id = ?
         WHERE user_id = ? AND revoked_at IS NULL`,
      )
      .bind(clock, `test-revoke:${crypto.randomUUID()}`, userId)
      .run();

    const verified = await postMfa("/mfa/verify", cookie, {
      code: await codeAt(seed, clock),
    });
    expect(verified.status).toBe(400);
    expect(await verified.json()).toMatchObject({
      error: { code: "invalid_code" },
    });
    expect((await readSession(cookie))?.mfa_method).toBeNull();
  });

  it("enrolment requires a ticket", async () => {
    const noTicketEmail = uniqueEmail("mfa-no-ticket");
    const noTicketId = await provisionStaff("manager", noTicketEmail);
    const noTicketCookie = await signedInCookie(noTicketEmail);
    const withoutTicket = await postMfa("/mfa/enrol", noTicketCookie, {});
    expect(withoutTicket.status).toBe(403);
    expect(await withoutTicket.json()).toMatchObject({
      error: { code: "forbidden" },
    });
    expect(await readCredential(noTicketId)).toBeNull();

    // A ticket minted for somebody else does not enrol this account.
    const foreignEmail = uniqueEmail("mfa-foreign-ticket");
    const foreignId = await provisionStaff("manager", foreignEmail);
    const otherId = await provisionStaff("manager", uniqueEmail("mfa-other"));
    const crossed = await postMfa(
      "/mfa/enrol",
      await signedInCookie(foreignEmail),
      { ticket: await issueTicket(otherId) },
    );
    expect(crossed.status).toBe(403);
    expect(await readCredential(foreignId)).toBeNull();

    const expiredEmail = uniqueEmail("mfa-expired-ticket");
    const expiredId = await provisionStaff("manager", expiredEmail);
    const expired = await issueTicket(expiredId, {
      createdAt: clock - 2000,
      expiresAt: clock - 1000,
    });
    const late = await postMfa("/mfa/enrol", await signedInCookie(expiredEmail), {
      ticket: expired,
    });
    expect(late.status).toBe(410);
    expect(await late.json()).toMatchObject({ error: { code: "ticket_expired" } });

    // A ticket works once: the second use is refused and no credential appears.
    const onceEmail = uniqueEmail("mfa-ticket-once");
    const onceId = await provisionStaff("manager", onceEmail);
    const onceCookie = await signedInCookie(onceEmail);
    const consumed = await issueTicket(onceId);
    expect(
      (await postMfa("/mfa/enrol", onceCookie, { ticket: consumed })).status,
    ).toBe(200);
    const again = await postMfa("/mfa/enrol", onceCookie, { ticket: consumed });
    expect(again.status).toBe(403);
    expect(await again.json()).toMatchObject({ error: { code: "forbidden" } });
  }, 30_000);

  it("enrolment cannot overwrite a confirmed credential without a ticket", async () => {
    const email = uniqueEmail("mfa-no-overwrite");
    const userId = await provisionStaff("global_admin", email);
    await enrolConfirmed(email, userId);
    const before = await readCredential(userId);

    const cookie = await signedInCookie(email);
    const withoutTicket = await postMfa("/mfa/enrol", cookie, {});
    expect(withoutTicket.status).toBe(403);

    // Even a live ticket does not replace a confirmed factor: that is the
    // reset path, which revokes first and writes its own audit row.
    const withTicket = await postMfa("/mfa/enrol", cookie, {
      ticket: await issueTicket(userId),
    });
    expect(withTicket.status).toBe(409);
    expect(await withTicket.json()).toMatchObject({
      error: { code: "mfa_already_enrolled" },
    });

    const after = await readCredential(userId);
    expect(after?.credential_id).toBe(before?.credential_id);
    expect(after?.secret_ciphertext).toBe(before?.secret_ciphertext);
    expect(after?.secret_iv).toBe(before?.secret_iv);
  }, 30_000);

  it("confirm returns ten codes once", async () => {
    const email = uniqueEmail("mfa-ten-codes");
    const userId = await provisionStaff("global_admin", email);
    const cookie = await signedInCookie(email);
    expect(
      (
        await postMfa("/mfa/enrol", cookie, {
          ticket: await issueTicket(userId),
        })
      ).status,
    ).toBe(200);
    const seed = await seedFor(userId);

    const confirmed = await postMfa("/mfa/enrol/confirm", cookie, {
      code: await codeAt(seed, clock),
    });
    expect(confirmed.status).toBe(200);
    const { recoveryCodes } = (await confirmed.json()) as {
      recoveryCodes: string[];
    };
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const recoveryCode of recoveryCodes) {
      expect(recoveryCode).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    }

    const second = await postMfa("/mfa/enrol/confirm", cookie, {
      code: await codeAt(seed, clock),
    });
    expect(second.status).toBe(409);

    const stored = await database
      .prepare(
        `SELECT COUNT(*) AS count FROM staff_recovery_codes WHERE user_id = ?`,
      )
      .bind(userId)
      .first<{ count: number }>();
    expect(stored?.count).toBe(10);

    // The ten plaintext codes exist exactly once, in that one response: the
    // database holds digests and the response body is not cached.
    const digests = await database
      .prepare(`SELECT code_digest FROM staff_recovery_codes WHERE user_id = ?`)
      .bind(userId)
      .all<{ code_digest: string }>();
    for (const row of digests.results) {
      expect(row.code_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(recoveryCodes).not.toContain(row.code_digest);
    }
  });

  it("recovery code is single-use", async () => {
    const email = uniqueEmail("mfa-recovery-once");
    const userId = await provisionStaff("global_admin", email);
    const { cookie, recoveryCodes } = await enrolConfirmed(email, userId);

    const first = await postMfa("/mfa/recovery", cookie, {
      recoveryCode: recoveryCodes[0],
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ next: "enrol" });

    const second = await postMfa("/mfa/recovery", cookie, {
      recoveryCode: recoveryCodes[0],
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      error: { code: "recovery_code_used" },
    });

    // Redeeming revokes the factor; the remaining codes stay unused.
    expect(await readCredential(userId)).toBeNull();
    const unused = await database
      .prepare(
        `SELECT COUNT(*) AS count FROM staff_recovery_codes
         WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL`,
      )
      .bind(userId)
      .first<{ count: number }>();
    expect(unused?.count).toBe(9);
  });

  it("recovery mints no assurance", async () => {
    const email = uniqueEmail("mfa-recovery-no-assurance");
    const userId = await provisionStaff("global_admin", email);
    const { cookie, recoveryCodes } = await enrolConfirmed(email, userId);

    expect(
      (
        await postMfa("/mfa/recovery", cookie, {
          recoveryCode: recoveryCodes[1],
        })
      ).status,
    ).toBe(200);

    expect(await readSession(cookie)).toEqual({
      mfa_method: null,
      mfa_verified_at: null,
    });
    const session = await application.fetch(
      new Request(url("/admin/auth/session"), {
        headers: {
          Cookie: `certpath_session=${cookie}`,
          "CF-Connecting-IP": testerIp,
        },
      }),
      bindings,
    );
    expect(session.status).toBe(403);
    expect(await session.json()).toMatchObject({
      error: { code: "mfa-assurance-missing" },
    });
  });

  it("a Manager cannot reset", async () => {
    const managerEmail = uniqueEmail("mfa-manager-reset");
    const managerId = await provisionStaff("manager", managerEmail);
    const targetEmail = uniqueEmail("mfa-manager-target");
    const targetId = await provisionStaff("manager", targetEmail);
    await enrolConfirmed(targetEmail, targetId);
    const manager = await enrolConfirmed(managerEmail, managerId);

    expect(
      (
        await postMfa("/mfa/verify", manager.cookie, {
          code: await codeAt(manager.seed, clock),
        })
      ).status,
    ).toBe(200);

    const reset = await postMfa("/mfa/reset", manager.cookie, {
      userId: targetId,
      reason: "A Manager may never reset a second factor",
    });
    expect(reset.status).toBe(403);
    expect(await reset.json()).toMatchObject({ error: { code: "forbidden" } });
    expect(await readCredential(targetId)).not.toBeNull();
  }, 30_000);

  it("reset by a Global Admin revokes everything", async () => {
    const adminEmail = uniqueEmail("mfa-admin-reset");
    const adminId = await provisionStaff("global_admin", adminEmail);
    const targetEmail = uniqueEmail("mfa-reset-target");
    const targetId = await provisionStaff("manager", targetEmail);

    const target = await enrolConfirmed(targetEmail, targetId);
    const admin = await enrolConfirmed(adminEmail, adminId);
    // The actor's own factor must be current; `enrolConfirmed` leaves it
    // unverified, so verify it first.
    expect(
      (
        await postMfa("/mfa/verify", admin.cookie, {
          code: await codeAt(admin.seed, clock),
        })
      ).status,
    ).toBe(200);

    const reset = await postMfa("/mfa/reset", admin.cookie, {
      userId: targetId,
      reason: "Learner-support phone call; authenticator replaced",
    });
    expect(reset.status).toBe(200);
    const body = (await reset.json()) as { ticket: string; expiresAt: number };
    expect(body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.expiresAt).toBe(clock + 24 * 60 * 60 * 1000);

    expect(await readCredential(targetId)).toBeNull();
    const codes = await database
      .prepare(
        `SELECT COUNT(*) AS count FROM staff_recovery_codes
         WHERE user_id = ? AND revoked_at IS NULL`,
      )
      .bind(targetId)
      .first<{ count: number }>();
    expect(codes?.count).toBe(0);
    const sessions = await database
      .prepare(
        `SELECT COUNT(*) AS count FROM app_sessions
         WHERE user_id = ? AND revoked_at IS NULL`,
      )
      .bind(targetId)
      .first<{ count: number }>();
    expect(sessions?.count).toBe(0);

    const audit = await database
      .prepare(
        `SELECT action, subject_type, subject_id FROM audit_events
         WHERE action = 'staff_mfa_reset' AND subject_id = ?`,
      )
      .bind(targetId)
      .first<{ action: string; subject_type: string; subject_id: string }>();
    expect(audit).toMatchObject({
      action: "staff_mfa_reset",
      subject_type: "staff_mfa",
      subject_id: targetId,
    });

    // The revoked session really is dead (`invalid-session`), and the printed
    // ticket really works.
    const stale = await application.fetch(
      new Request(url("/admin/auth/session"), {
        headers: {
          Cookie: `certpath_session=${target.cookie}`,
          "CF-Connecting-IP": testerIp,
        },
      }),
      bindings,
    );
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({
      error: { code: "invalid-session" },
    });

    // A second reset while that ticket is live is a conflict, not a second
    // printed secret.
    const retry = await postMfa("/mfa/reset", admin.cookie, {
      userId: targetId,
      reason: "Retry",
    });
    expect(retry.status).toBe(409);

    const reEnrol = await postMfa("/mfa/enrol", await freshCookie(targetEmail), {
      ticket: body.ticket,
    });
    expect(reEnrol.status).toBe(200);
  }, 30_000);

  it("answers 503 on every MFA route when the seal key is missing or short", async () => {
    const email = uniqueEmail("mfa-no-seal-key");
    const userId = await provisionStaff("global_admin", email);
    const cookie = await signedInCookie(email);
    const ticket = await issueTicket(userId);

    for (const missing of ["", "too-short-to-seal-a-seed"]) {
      const enrolled = await postMfa(
        "/mfa/enrol",
        cookie,
        { ticket },
        { STAFF_MFA_SEAL_KEY: missing },
      );
      expect(enrolled.status).toBe(503);
      expect(await enrolled.json()).toMatchObject({
        error: { code: "service_unavailable" },
      });
    }
    expect(await readCredential(userId)).toBeNull();

    // A perfectly good enrolment also cannot be confirmed or verified without
    // the key: the factor is closed, not downgraded to plaintext.
    expect(
      (await postMfa("/mfa/enrol", cookie, { ticket })).status,
    ).toBe(200);
    const seed = await seedFor(userId);
    const confirm = await postMfa(
      "/mfa/enrol/confirm",
      cookie,
      { code: await codeAt(seed, clock) },
      { STAFF_MFA_SEAL_KEY: "" },
    );
    expect(confirm.status).toBe(503);
    const verify = await postMfa(
      "/mfa/verify",
      cookie,
      { code: await codeAt(seed, clock) },
      { STAFF_MFA_SEAL_KEY: "" },
    );
    expect(verify.status).toBe(503);
    expect((await readSession(cookie))?.mfa_method).toBeNull();
  }, 30_000);
}, 30_000);

async function freshCookie(email: string): Promise<string> {
  return signedInCookie(email);
}
