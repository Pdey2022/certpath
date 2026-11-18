import { WorkerEntrypoint } from "cloudflare:workers";
import { stagingTesterGate } from "@certpath/api";
import app from "./app";
import { schedulePilotEventRetention } from "./pilot-events-retention-schedule";

type StagingEnv = Env & {
  STAGING_TESTER_IPS?: string;
  STAGING_LOCAL_TEST?: string;
  STAGING_LOCAL_TEST_PASSWORD?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SESSION_TOKEN?: string;
  PILOT_EVENTS_RETENTION_ENABLED?: string;
};

export class StagingLambdaVerifierStub extends WorkerEntrypoint<StagingEnv> {
  async fetch(request: Request): Promise<Response> {
    const authorization = request.headers.get("authorization");
    const sessionToken = request.headers.get("x-amz-security-token");
    if (
      this.env.STAGING_LOCAL_TEST !== "true" ||
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/verify" ||
      !authorization?.startsWith(
        `AWS4-HMAC-SHA256 Credential=${this.env.AWS_ACCESS_KEY_ID}/`,
      ) ||
      !sessionToken ||
      sessionToken !== this.env.AWS_SESSION_TOKEN
    ) {
      return new Response(null, { status: 403 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(null, { status: 400 });
    }
    if (
      !body ||
      typeof body !== "object" ||
      !("operation" in body) ||
      body.operation !== "verify" ||
      !("password" in body) ||
      typeof body.password !== "string"
    ) {
      return new Response(null, { status: 400 });
    }
    await this.env.DB.prepare(
      "INSERT INTO staging_local_test_lambda_calls (called_at) VALUES (?)",
    )
      .bind(Date.now())
      .run();
    return Response.json({
      operation: "verify",
      verified: body.password === this.env.STAGING_LOCAL_TEST_PASSWORD,
    });
  }
}

const unavailablePaths = new Set([
  "/verify-email",
  "/recover-password",
  "/reset-password",
  "/local-inbox",
]);

export default {
  async fetch(request, env, ctx) {
    const rejected = stagingTesterGate(request, env);
    if (rejected) return rejected;
    const pathname = new URL(request.url).pathname;
    if (
      unavailablePaths.has(pathname) ||
      pathname === "/api/auth/local" ||
      pathname.startsWith("/api/auth/local/") ||
      pathname === "/api/auth/cognito" ||
      pathname.startsWith("/api/auth/cognito/")
    ) {
      return new Response(null, {
        headers: {
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow",
        },
        status: 404,
      });
    }
    return app.fetch(request, env, ctx);
  },
  // The cron in `wrangler.staging.jsonc` is the only schedule this Worker has.
  // Every pilot flag is `"false"`, so today this handler's one job is a no-op:
  // the gate returns before `ctx.waitUntil`, so no statement is prepared and no
  // row is read. The 0022 trigger, not this job, enforces the twelve-month floor.
  scheduled(_controller, env, ctx) {
    schedulePilotEventRetention(env, ctx);
  },
} satisfies ExportedHandler<StagingEnv>;
