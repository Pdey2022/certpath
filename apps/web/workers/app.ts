import { createRequestHandler, RouterContextProvider } from "react-router";
import { api } from "@certpath/api";
import { cleanupExpiredQuestionImports } from "@certpath/api/security/question-import-cleanup";
import { cloudflareContext } from "../app/lib/cloudflare-context";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith("/api/")) {
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
} satisfies ExportedHandler<Env>;
