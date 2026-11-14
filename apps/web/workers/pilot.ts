import { createRequestHandler, RouterContextProvider } from "react-router";
import { api, stagingTesterGate } from "@certpath/api";
import { cloudflareContext } from "../app/lib/cloudflare-context";
import {
  pathMatchesPrefix,
  pilotExcludedPaths,
} from "../app/lib/worker-routes";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

function notFound(): Response {
  return new Response(
    JSON.stringify({ error: { code: "not_available_in_pilot" } }),
    {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Robots-Tag": "noindex, nofollow",
      },
    },
  );
}

type PilotEnv = Env & { STAGING_TESTER_IPS?: string };

/**
 * Private pilot Worker: one invited Google learner on an isolated D1 database.
 * The tester gate runs before anything else, then password, Cognito, admin, and
 * email paths are closed. Email, password sign-in, and the Lambda verifier are
 * deliberately left unconfigured.
 */
export default {
  async fetch(request, env: PilotEnv, ctx) {
    const rejected = stagingTesterGate(request, env);
    if (rejected) return rejected;

    const { pathname } = new URL(request.url);
    if (pathMatchesPrefix(pathname, pilotExcludedPaths)) return notFound();

    if (pathname.startsWith("/api/")) {
      return api.fetch(request, env, ctx);
    }

    const loadContext = new RouterContextProvider();
    loadContext.set(cloudflareContext, { env, ctx });
    return requestHandler(request, loadContext);
  },
} satisfies ExportedHandler<PilotEnv>;
