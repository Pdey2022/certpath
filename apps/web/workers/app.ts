import { createRequestHandler, RouterContextProvider } from "react-router";
import {
  adminTesterGate,
  api,
  isAdminSurfacePath,
  readStaffPageSession,
} from "@certpath/api";
import { cleanupExpiredQuestionImports } from "@certpath/api/security/question-import-cleanup";
import { cloudflareContext } from "../app/lib/cloudflare-context";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

type AdminAppEnv = Env & {
  ADMIN_TESTER_IPS?: string;
  ADMIN_TESTER_LOCAL?: string;
};

function staffSignInRedirect(request: Request): Response {
  return new Response(null, {
    status: 307,
    headers: {
      Location: new URL("/admin/sign-in", request.url).toString(),
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    // Every admin page and admin API sits behind the tester allowlist, and every
    // admin page also needs a live staff session before any HTML is rendered.
    if (isAdminSurfacePath(pathname)) {
      const rejected = adminTesterGate(request, env);
      if (rejected) return rejected;
      const isAdminApi =
        pathname === "/api/admin" || pathname.startsWith("/api/admin/");
      if (!isAdminApi && pathname !== "/admin/sign-in") {
        const session = await readStaffPageSession(
          env.DB,
          request.headers.get("cookie"),
          Date.now(),
        );
        if (!session) return staffSignInRedirect(request);
      }
    }

    if (pathname.startsWith("/api/")) {
      return api.fetch(request, env, ctx);
    }

    const loadContext = new RouterContextProvider();
    loadContext.set(cloudflareContext, { env, ctx });
    return requestHandler(request, loadContext);
  },
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const result = await cleanupExpiredQuestionImports(env.DB, Date.now());
        if (!result.ok) {
          throw new Error(`Question import cleanup failed: ${result.reason}`);
        }
      })(),
    );
  },
} satisfies ExportedHandler<AdminAppEnv>;