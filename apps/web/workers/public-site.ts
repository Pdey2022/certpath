import { createRequestHandler, RouterContextProvider } from "react-router";
import { cloudflareContext } from "../app/lib/cloudflare-context";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

// The public release serves the landing page and exam catalogue only. Sign-in,
// registration, checkout, admin, and learner routes are not part of it.
const excludedPrefixes = [
  "/api",
  "/app",
  "/admin",
  "/sign-in",
  "/verify-email",
  "/recover-password",
  "/reset-password",
  "/local-inbox",
];

function isExcluded(pathname: string): boolean {
  return excludedPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function notFound(): Response {
  return new Response(
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Page not found | CertPath</title><meta name=\"robots\" content=\"noindex,nofollow\"></head><body><main><h1>Page not found</h1><p>This page is not part of the CertPath public site.</p><p><a href=\"/\">Return to the home page</a></p></main></body></html>",
    {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
        "X-Robots-Tag": "noindex, nofollow",
      },
    },
  );
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (isExcluded(pathname)) return notFound();

    const loadContext = new RouterContextProvider();
    loadContext.set(cloudflareContext, { env, ctx });
    return requestHandler(request, loadContext);
  },
} satisfies ExportedHandler<Env>;
