import { Hono } from "hono";
import { healthResponseSchema } from "@certpath/contracts";

type ApiBindings = { DB: unknown };

export const api = new Hono<{ Bindings: ApiBindings }>().basePath("/api");

api.get("/health", (context) => {
  const response = healthResponseSchema.parse({ status: "ok" });
  context.header("Cache-Control", "no-store");
  return context.json(response);
});
