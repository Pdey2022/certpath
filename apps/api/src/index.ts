import { Hono } from "hono";
import { healthResponseSchema } from "@certpath/contracts";
import { protectedContentApi } from "./protected-content.ts";
import { learnerPracticeApi } from "./learner-practice.ts";
import { createCognitoLearnerSandboxApi } from "./cognito-learner-sandbox.ts";
import {
  createApplicationSessionApi,
  createLocalLearnerAuthApi,
} from "./local-learner-auth.ts";
import type { SecurityDatabase } from "./security/database.ts";

type ApiBindings = {
  DB: SecurityDatabase;
  PUBLIC_SITE_ORIGIN?: string;
  STAFF_MFA_MAX_AGE_MS?: string;
  STAFF_MFA_ALLOWED_METHODS?: string;
  CSRF_HMAC_SECRET?: string;
  LOCAL_LEARNER_AUTH_ENABLED?: string;
  LOCAL_TEST_MAIL_ENABLED?: string;
  LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET?: string;
  COGNITO_LEARNER_SANDBOX_ENABLED?: string;
  COGNITO_LEARNER_ALLOWED_CLIENT_IPS?: string;
  COGNITO_LEARNER_ISSUER?: string;
  COGNITO_LEARNER_DOMAIN?: string;
  COGNITO_LEARNER_CALLBACK_URL?: string;
  COGNITO_LEARNER_CLIENT_ID?: string;
  COGNITO_LEARNER_TRANSACTION_ENCRYPTION_KEY?: string;
};

export function createApi(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  const application = new Hono<{ Bindings: ApiBindings }>().basePath("/api");

  application.get("/health", (context) => {
    const response = healthResponseSchema.parse({ status: "ok" });
    context.header("Cache-Control", "no-store");
    return context.json(response);
  });

  application.route(
    "/auth/cognito",
    createCognitoLearnerSandboxApi(fetcher),
  );
  application.route("/auth/local", createLocalLearnerAuthApi(now));
  application.route("/auth/session", createApplicationSessionApi(now));
  application.route("/admin/content", protectedContentApi);
  application.route("/practice", learnerPracticeApi);
  return application;
}

export const api = createApi();
