import { stagingTesterGate } from "@certpath/api";
import app from "./app";

type StagingEnv = Env & {
  STAGING_TESTER_IPS?: string;
};

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
} satisfies ExportedHandler<StagingEnv>;
