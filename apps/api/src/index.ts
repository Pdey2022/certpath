import { Hono } from "hono";
import { healthResponseSchema } from "@certpath/contracts";
import { protectedContentApi } from "./protected-content.ts";
import { learnerPracticeApi } from "./learner-practice.ts";
import { createCognitoSandboxApi } from "./cognito-sandbox.ts";
import type { SecurityDatabase } from "./security/database.ts";

type ApiBindings = {
  DB: SecurityDatabase;
  PUBLIC_SITE_ORIGIN?: string;
  STAFF_MFA_MAX_AGE_MS?: string;
  STAFF_MFA_ALLOWED_METHODS?: string;
  CSRF_HMAC_SECRET?: string;
  COGNITO_SANDBOX_ENABLED?: string;
  COGNITO_SANDBOX_ALLOWED_CLIENT_IPS?: string;
  COGNITO_ISSUER?: string;
  COGNITO_DOMAIN?: string;
  COGNITO_CALLBACK_URL?: string;
  COGNITO_LEARNER_CLIENT_ID?: string;
  COGNITO_STAFF_CLIENT_ID?: string;
  COGNITO_TRANSACTION_ENCRYPTION_KEY?: string;
};

export function createApi(fetcher: typeof fetch = fetch) {
  const application = new Hono<{ Bindings: ApiBindings }>().basePath("/api");

  application.get("/health", (context) => {
    const response = healthResponseSchema.parse({ status: "ok" });
    context.header("Cache-Control", "no-store");
    return context.json(response);
  });

  application.route("/auth/cognito", createCognitoSandboxApi(fetcher));
  application.route("/admin/content", protectedContentApi);
  application.route("/practice", learnerPracticeApi);
  return application;
}

export const api = createApi();
