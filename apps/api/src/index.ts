import { Hono } from "hono";
import { healthResponseSchema } from "@certpath/contracts";
import { protectedContentApi } from "./protected-content.ts";
import { learnerPracticeApi } from "./learner-practice.ts";
import { createCognitoLearnerSandboxApi } from "./cognito-learner-sandbox.ts";
import { createLearnerEmailSignInApi } from "./learner-email-sign-in.ts";
import { LocalTestMailAdapter } from "./local-test-mail.ts";
import {
  createApplicationSessionApi,
  createLocalLearnerAuthApi,
  createStagingLearnerAuthApi,
  stagingLearnerAuthOrigin,
  type StagingPasswordVerifier,
} from "./local-learner-auth.ts";
import { createGoogleLearnerAuthApi } from "./learner-google-oidc.ts";
import {
  createStaffAuthApi,
  type StaffPasswordVerifier,
} from "./staff-auth.ts";
import type { SecurityDatabase } from "./security/database.ts";
import { createLambdaPasswordVerifier } from "./security/lambda-password-verifier.ts";
import {
  isStagingLocalTestOrigin,
  stagingTesterGate,
} from "./security/staging-gate.ts";

type ApiBindings = {
  DB: SecurityDatabase;
  PUBLIC_SITE_ORIGIN?: string;
  STAFF_MFA_MAX_AGE_MS?: string;
  STAFF_MFA_ALLOWED_METHODS?: string;
  CSRF_HMAC_SECRET?: string;
  LOCAL_LEARNER_AUTH_ENABLED?: string;
  LOCAL_LEARNER_EMAIL_LINK_ENABLED?: string;
  LOCAL_TEST_MAIL_ENABLED?: string;
  LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET?: string;
  STAFF_RATE_LIMIT_HMAC_SECRET?: string;
  ADMIN_TESTER_IPS?: string;
  ADMIN_TESTER_ASSURANCE?: string;
  ADMIN_TESTER_LOCAL?: string;
  STAGING_LEARNER_AUTH_ENABLED?: string;
  STAGING_TESTER_IPS?: string;
  STAGING_AUTH_RATE_LIMIT_HMAC_SECRET?: string;
  STAGING_LEARNER_EMAIL?: string;
  LEARNER_GOOGLE_OIDC_ENABLED?: string;
  GOOGLE_OIDC_CLIENT_ID?: string;
  GOOGLE_OIDC_CLIENT_SECRET?: string;
  GOOGLE_OIDC_REDIRECT_URI?: string;
  GOOGLE_OIDC_TRANSACTION_KEY?: string;
  STAGING_LOCAL_TEST?: string;
  STAGING_LAMBDA_TEST_STUB?: {
    fetch(input: URL | RequestInfo, init?: RequestInit): Promise<Response>;
  };
  AWS_ACCESS_KEY_ID?: string;
  AWS_REGION?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
  LAMBDA_FUNCTION_URL?: string;
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
  stagingVerifier?: StagingPasswordVerifier,
  staffVerifier?: StaffPasswordVerifier,
) {
  const application = new Hono<{ Bindings: ApiBindings }>().basePath("/api");
  const localTestMail = new LocalTestMailAdapter();
  const verifyStagingPassword =
    stagingVerifier ??
    createLambdaPasswordVerifier(fetcher, () => new Date(now()));

  application.use("*", async (context, next) => {
    if (context.env?.STAGING_LEARNER_AUTH_ENABLED === "true") {
      const allowedOrigin =
        context.env.PUBLIC_SITE_ORIGIN === stagingLearnerAuthOrigin ||
        (context.env.STAGING_LOCAL_TEST === "true" &&
          isStagingLocalTestOrigin(context.env.PUBLIC_SITE_ORIGIN));
      if (!allowedOrigin) {
        return context.json(
          { error: { code: "service_unavailable" } },
          503,
        );
      }
      const rejected = stagingTesterGate(context.req.raw, context.env);
      if (rejected) return rejected;
    }
    await next();
  });

  application.get("/health", (context) => {
    const response = healthResponseSchema.parse({ status: "ok" });
    context.header("Cache-Control", "no-store");
    return context.json(response);
  });

  application.route(
    "/auth/cognito",
    createCognitoLearnerSandboxApi(fetcher),
  );
  application.route("/auth/local", createLocalLearnerAuthApi(now, localTestMail));
  application.route(
    "/auth/staging",
    createStagingLearnerAuthApi(now, verifyStagingPassword),
  );
  application.route(
    "/auth/email-link",
    createLearnerEmailSignInApi(localTestMail, now),
  );
  application.route("/auth/google", createGoogleLearnerAuthApi(fetcher));
  application.route("/auth/session", createApplicationSessionApi(now));
  application.route("/admin/auth", createStaffAuthApi(now, staffVerifier));
  application.route("/admin/content", protectedContentApi);
  application.route("/practice", learnerPracticeApi);
  return application;
}

export const api = createApi();
export { stagingTesterGate } from "./security/staging-gate.ts";
export {
  adminTesterGate,
  isAdminSurfacePath,
} from "./security/admin-gate.ts";
export {
  readStaffPageSession,
  type StaffPageSession,
} from "./security/admin-access.ts";