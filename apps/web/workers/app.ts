import { createRequestHandler, RouterContextProvider } from "react-router";
import {
  adminTesterGate,
  api,
  isAdminSurfacePath,
  readStaffPageSession,
} from "@certpath/api";
import { cleanupExpiredQuestionImports } from "@certpath/api/security/question-import-cleanup";
import { cleanupExpiredAuditEvents } from "@certpath/api/security/audit-retention";
import {
  cleanupExpiredPilotEvents,
  pilotEventsRetentionEnabled,
} from "@certpath/api/analytics/pilot-events-retention";
import { expireStaleCheckouts } from "@certpath/api/commerce/expire";
import { cloudflareContext } from "../app/lib/cloudflare-context";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

type AdminAppEnv = Env & {
  ADMIN_TESTER_IPS?: string;
  ADMIN_TESTER_LOCAL?: string;
  AUDIT_RETENTION_ENABLED?: string;
  COMMERCE_ENABLED?: string;
  PILOT_EVENTS_RETENTION_ENABLED?: string;
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
    // Audit retention runs in its own waitUntil so a failure in one job cannot
    // stop the other. It is off unless the owner turns it on explicitly, and the
    // storage trigger - not this job - enforces the twelve-month floor.
    if (String(env.AUDIT_RETENTION_ENABLED ?? "false") === "true") {
      ctx.waitUntil(
        (async () => {
          const result = await cleanupExpiredAuditEvents(env.DB, Date.now());
          if (!result.ok) {
            throw new Error(`Audit retention cleanup failed: ${result.reason}`);
          }
        })(),
      );
    }
    // Pilot event retention runs in its own waitUntil, and only when the flag is
    // exactly "true": with it off this job prepares no statement and reads no
    // row. The 0022 delete trigger - not this job - enforces the twelve-month
    // floor. Only the failure reason is ever reported; no event id, session id or
    // row value is logged.
    if (pilotEventsRetentionEnabled(env)) {
      ctx.waitUntil(
        (async () => {
          const result = await cleanupExpiredPilotEvents(env.DB, Date.now());
          if (!result.ok) {
            throw new Error(
              `Pilot event retention cleanup failed: ${result.reason}`,
            );
          }
        })(),
      );
    }
    // Commerce expiry runs in its own waitUntil as well, and only when commerce
    // is switched on: with the feature off there are no new pending rows, and a
    // disabled feature must not write at all.
    if (String(env.COMMERCE_ENABLED ?? "false") === "true") {
      ctx.waitUntil(
        (async () => {
          const result = await expireStaleCheckouts(env.DB, Date.now());
          if (!result.ok) {
            throw new Error(`Checkout expiry failed: ${result.reason}`);
          }
        })(),
      );
    }
  },
} satisfies ExportedHandler<AdminAppEnv>;