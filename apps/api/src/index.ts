import { Hono } from "hono";
import { healthResponseSchema } from "@certpath/contracts";
import { protectedContentApi } from "./protected-content.ts";
import type { SecurityDatabase } from "./security/database.ts";

type ApiBindings = {
  DB: SecurityDatabase;
  PUBLIC_SITE_ORIGIN?: string;
  STAFF_MFA_MAX_AGE_MS?: string;
  STAFF_MFA_ALLOWED_METHODS?: string;
  CSRF_HMAC_SECRET?: string;
};

export const api = new Hono<{ Bindings: ApiBindings }>().basePath("/api");

api.get("/health", (context) => {
  const response = healthResponseSchema.parse({ status: "ok" });
  context.header("Cache-Control", "no-store");
  return context.json(response);
});

api.route("/admin/content", protectedContentApi);
