import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/index.ts";
import type { SecurityDatabase } from "../src/security/database.ts";
import { sessionDigest } from "../src/security/http-session.ts";
import { createContentScope } from "./content-fixtures.ts";
import {
  createTestEmailSignInInvite,
  createTestLearnerUser,
  grantTestLearnerAccess,
  grantTestRole,
} from "./factories.ts";

const database: SecurityDatabase = env.DB;
const origin = "https://localhost";
const csrfSecret = "local-worker-test-csrf-secret-with-enough-entropy";
const rateLimitSecret =
  "local-worker-test-rate-limit-secret-with-enough-entropy";

let clock = Date.now();
const outbound: string[] = [];
const application = createApi(async (input) => {
  outbound.push(String(input));
  throw new Error("The learner email-link proof must not call a network host");
}, () => clock);

const bindings = {
  DB: database,
  PUBLIC_SITE_ORIGIN: origin,
  CSRF_HMAC_SECRET: csrfSecret,
  LOCAL_LEARNER_EMAIL_LINK_ENABLED: "true",
  LOCAL_TEST_MAIL_ENABLED: "true",
  LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET: rateLimitSecret,
};

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function url(path: string): string {
  return `${origin}/api/auth/email-link${path}`;
}

function address(): string {
  return `learner-${crypto.randomUUID()}@example.test`;
}

async function post(
  path: string,
  body: unknown,
  options: { ip?: string; origin?: string | null; contentType?: string } = {},
) {
  const headers: Record<string, string> = {
    "Content-Type": options.contentType ?? "application/json",
    "CF-Connecting-IP": options.ip ?? nextIp(),
  };
  const requestOrigin =
    options.origin === undefined ? origin : options.origin;
  if (requestOrigin !== null) headers.Origin = requestOrigin;
  return application.fetch(
    new Request(url(path), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    bindings,
  );
}

async function inbox(mail: string) {
  const response = await application.fetch(
    new Request(`${url("/test-inbox")}?${new URLSearchParams({ email: mail })}`),
    bindings,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    messages: Array<{ kind: string; link: string }>;
  };
}

function tokenFromLink(link: string): string {
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token");
  if (!token) throw new Error("Synthetic inbox link omitted its token fragment");
  return token;
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  const token = cookie?.match(/certpath_session=([A-Za-z0-9_-]{43})/)?.[1];
  if (!token) throw new Error("Redeem response omitted its session cookie");
  return token;
}

async function dashboard(rawToken?: string) {
  return application.fetch(
    new Request(`${origin}/api/practice/dashboard`, {
      headers: rawToken ? { Cookie: `certpath_session=${rawToken}` } : {},
    }),
    bindings,
  );
}

async function provisionedLearner(options: { grant?: boolean } = {}) {
  const userId = await createTestLearnerUser(database);
  const email = await createTestEmailSignInInvite(database, userId);
  let scope: { certificationId: string; examVersionId: string } | null = null;
  if (options.grant !== false) {
    scope = await createContentScope(database);
    await grantTestLearnerAccess(database, userId, scope.certificationId);
  }
  return { userId, email, scope };
}

async function requestLink(email: string, ip = nextIp()) {
  return post("/request", { email }, { ip });
}

async function issuedToken(email: string, ip = nextIp()): Promise<string> {
  expect((await requestLink(email, ip)).status).toBe(202);
  const message = (await inbox(email)).messages.find(
    (entry) => entry.kind === "sign_in_link",
  );
  expect(message).toBeTruthy();
  return tokenFromLink(message!.link);
}

async function sessionCount(userId: string): Promise<number> {
  const row = await database
    .prepare("SELECT COUNT(*) AS count FROM app_sessions WHERE user_id = ?")
    .bind(userId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

describe("invite-only email sign-in links", () => {
  it("stays disabled unless the local email-link bindings are explicitly enabled", async () => {
    const disabled = { ...bindings, LOCAL_LEARNER_EMAIL_LINK_ENABLED: "false" };
    const learner = await provisionedLearner();

    const preflight = await application.fetch(
      new Request(url("/preflight")),
      disabled,
    );
    expect(preflight.status).toBe(200);
    expect(await preflight.json()).toEqual({
      signInEnabled: false,
      localMailboxEnabled: false,
    });

    const request = await application.fetch(
      new Request(url("/request"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          "CF-Connecting-IP": nextIp(),
        },
        body: JSON.stringify({ email: learner.email }),
      }),
      disabled,
    );
    expect(request.status).toBe(503);

    const mailDisabled = { ...bindings, LOCAL_TEST_MAIL_ENABLED: "false" };
    expect(
      (
        await application.fetch(
          new Request(url("/request"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: origin,
              "CF-Connecting-IP": nextIp(),
            },
            body: JSON.stringify({ email: learner.email }),
          }),
          mailDisabled,
        )
      ).status,
    ).toBe(503);

    const tokens = await database
      .prepare("SELECT COUNT(*) AS count FROM learner_email_sign_in_tokens")
      .first<{ count: number }>();
    expect(tokens?.count).toBe(0);
  });

  it("signs a pre-provisioned learner in once and grants dashboard access", async () => {
    const learner = await provisionedLearner();
    const token = await issuedToken(learner.email);

    const stored = await database
      .prepare(
        `SELECT token_digest, invite_email, user_id, created_at, expires_at,
                consumed_at
         FROM learner_email_sign_in_tokens
         WHERE invite_email = ?`,
      )
      .bind(learner.email)
      .all<{
        token_digest: string;
        invite_email: string;
        user_id: string;
        created_at: number;
        expires_at: number;
        consumed_at: number | null;
      }>();
    expect(stored.results).toHaveLength(1);
    expect(stored.results[0]?.token_digest).toBe(await sessionDigest(token));
    expect(stored.results[0]?.token_digest).not.toBe(token);
    expect(stored.results[0]?.invite_email).toBe(learner.email);
    expect(stored.results[0]?.user_id).toBe(learner.userId);
    expect(stored.results[0]?.consumed_at).toBeNull();
    expect(
      (stored.results[0]?.expires_at ?? 0) - (stored.results[0]?.created_at ?? 0),
    ).toBe(15 * 60 * 1000);

    // Inspecting twice must not consume the link, so a mail scanner that opens
    // the page cannot spend the learner's only use.
    for (const _ of [0, 1]) {
      const inspected = await post("/inspect", { token });
      expect(inspected.status).toBe(200);
      expect(await inspected.json()).toEqual({ status: "valid" });
    }
    expect((await dashboard()).status).toBe(401);

    const redeemed = await post("/redeem", { token });
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toEqual({ redirectTo: "/app/home" });
    const rawSessionToken = sessionCookie(redeemed);
    const cookie = redeemed.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");

    const consumed = await database
      .prepare(
        `SELECT consumed_at, consumed_operation_id
         FROM learner_email_sign_in_tokens WHERE token_digest = ?`,
      )
      .bind(await sessionDigest(token))
      .first<{ consumed_at: number | null; consumed_operation_id: string | null }>();
    expect(consumed?.consumed_at).toBe(clock);
    expect(consumed?.consumed_operation_id).toContain("email-sign-in:");
    expect(await sessionCount(learner.userId)).toBe(1);

    const audit = await database
      .prepare(
        `SELECT action, actor_user_id, reason FROM audit_events
         WHERE subject_id = ? AND action = 'learner_signed_in'`,
      )
      .bind(learner.userId)
      .all<{ action: string; actor_user_id: string; reason: string }>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results[0]?.reason).toBe("Learner signed in by email link");

    const dashboardResponse = await dashboard(rawSessionToken);
    expect(dashboardResponse.status).toBe(200);
    const groups = (await dashboardResponse.json()) as {
      groups: Array<{ certificationId: string; examVersionId: string }>;
    };
    expect(groups.groups).toHaveLength(1);
    expect(groups.groups[0]).toMatchObject({
      certificationId: learner.scope!.certificationId,
      examVersionId: learner.scope!.examVersionId,
    });

    expect((await inbox(learner.email)).messages).toEqual([]);

    // Replay: the used link cannot sign in again and cannot add a session.
    const replay = await post("/redeem", { token });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({
      error: { code: "invalid_or_expired_link" },
    });
    expect((await post("/redeem", { token })).status).toBe(400);
    const replayedInspect = await post("/inspect", { token });
    expect(replayedInspect.status).toBe(200);
    expect(await replayedInspect.json()).toEqual({ status: "invalid" });
    expect(await sessionCount(learner.userId)).toBe(1);
    expect((await dashboard(rawSessionToken)).status).toBe(200);
    expect(outbound).toEqual([]);
  });

  it("answers the same way for addresses that were never provisioned", async () => {
    const invited = await provisionedLearner();
    const uninvited = address();

    const invitedResponse = await requestLink(invited.email);
    const uninvitedResponse = await requestLink(uninvited);
    expect(invitedResponse.status).toBe(202);
    expect(uninvitedResponse.status).toBe(202);
    expect(await invitedResponse.json()).toEqual(await uninvitedResponse.json());

    expect((await inbox(uninvited)).messages).toEqual([]);
    const uninvitedTokens = await database
      .prepare(
        "SELECT COUNT(*) AS count FROM learner_email_sign_in_tokens WHERE invite_email = ?",
      )
      .bind(uninvited)
      .first<{ count: number }>();
    expect(uninvitedTokens?.count).toBe(0);

    // The local proof only handles synthetic addresses and never a real inbox.
    const real = await requestLink("learner@certpath.example");
    expect(real.status).toBe(400);
    expect(await real.json()).toEqual({
      error: { code: "synthetic_email_required" },
    });
  });

  it("rejects an expired link without creating a session", async () => {
    const learner = await provisionedLearner();
    const token = await issuedToken(learner.email);

    const startedAt = clock;
    clock = startedAt + 16 * 60 * 1000;
    try {
      expect(await (await post("/inspect", { token })).json()).toEqual({
        status: "invalid",
      });

      const redeemed = await post("/redeem", { token });
      expect(redeemed.status).toBe(400);
      expect(await redeemed.json()).toEqual({
        error: { code: "invalid_or_expired_link" },
      });
      expect(redeemed.headers.get("set-cookie")).toBeNull();
      expect(await sessionCount(learner.userId)).toBe(0);
    } finally {
      clock = startedAt;
    }
  });

  it("stops honouring a link once its invite is revoked or the account is disabled", async () => {
    const revoked = await provisionedLearner();
    const revokedToken = await issuedToken(revoked.email);
    await database
      .prepare(
        "UPDATE learner_email_sign_in_invites SET revoked_at = ? WHERE email_normalized = ?",
      )
      .bind(clock, revoked.email)
      .run();
    expect(await (await post("/inspect", { token: revokedToken })).json()).toEqual({
      status: "invalid",
    });
    expect((await post("/redeem", { token: revokedToken })).status).toBe(400);
    expect(await sessionCount(revoked.userId)).toBe(0);

    const disabledUserId = await createTestLearnerUser(database, {
      status: "disabled",
    });
    const disabledEmail = await createTestEmailSignInInvite(
      database,
      disabledUserId,
    );
    expect((await requestLink(disabledEmail)).status).toBe(202);
    expect((await inbox(disabledEmail)).messages).toEqual([]);
    expect(await sessionCount(disabledUserId)).toBe(0);
  });

  it("never issues a learner session to an account with an active staff role", async () => {
    const staffUserId = await createTestLearnerUser(database);
    await grantTestRole(database, staffUserId, "global_admin");
    const staffEmail = await createTestEmailSignInInvite(database, staffUserId);
    expect((await requestLink(staffEmail)).status).toBe(202);
    expect((await inbox(staffEmail)).messages).toEqual([]);

    const learner = await provisionedLearner();
    const token = await issuedToken(learner.email);
    await grantTestRole(database, learner.userId, "manager");
    expect((await post("/redeem", { token })).status).toBe(400);
    expect(await sessionCount(learner.userId)).toBe(0);
  });

  it("settles concurrent redemptions of one link with a single session", async () => {
    const learner = await provisionedLearner();
    const token = await issuedToken(learner.email);

    const attempt = () => post("/redeem", { token });
    const results = await Promise.all([attempt(), attempt(), attempt()]);
    const statuses = results.map((result) => result.status).sort();
    expect(statuses).toEqual([200, 400, 400]);
    expect(await sessionCount(learner.userId)).toBe(1);
  });

  it("rate-limits link requests per address", async () => {
    const learner = await provisionedLearner();
    const ip = nextIp();
    for (const _ of [0, 1, 2]) {
      expect((await requestLink(learner.email, ip)).status).toBe(202);
    }
    const limited = await requestLink(learner.email, ip);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: { code: "rate_limited" } });
  });

  it("requires the exact origin and a JSON body for link requests", async () => {
    const learner = await provisionedLearner();
    const crossOrigin = await post(
      "/request",
      { email: learner.email },
      { origin: "https://attacker.example" },
    );
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json()).toEqual({
      error: { code: "invalid_origin" },
    });

    expect(
      (await post("/request", { email: learner.email }, { origin: null })).status,
    ).toBe(403);

    const wrongType = await post(
      "/request",
      { email: learner.email },
      { contentType: "text/plain" },
    );
    expect(wrongType.status).toBe(415);

    expect((await inbox(learner.email)).messages).toEqual([]);
  });
});
