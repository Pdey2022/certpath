import { createRequestHandler, RouterContextProvider } from "react-router";
import { cloudflareContext } from "../app/lib/cloudflare-context";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

function withPreviewHeaders(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Preview-only Worker: no API, D1, scheduled handler, or secrets are bound.
export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return withPreviewHeaders(
        Response.json(
          { error: { code: "preview_only" } },
          { status: 404, headers: { "Cache-Control": "no-store" } },
        ),
      );
    }

    const loadContext = new RouterContextProvider();
    loadContext.set(cloudflareContext, { env, ctx });
    return withPreviewHeaders(await requestHandler(request, loadContext));
  },
} satisfies ExportedHandler<Env>;
