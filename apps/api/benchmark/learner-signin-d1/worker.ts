import { createApi } from "../../src/index.ts";
import { PasswordHashUnavailableError } from "../../src/security/password-hashing.ts";
import type { SecurityDatabase } from "../../src/security/database.ts";
import {
  createLambdaInvoker,
  type LambdaInvoker,
  type WorkerLambdaEnvironment,
} from "../worker-lambda/worker.ts";

export interface LearnerSignInD1Environment extends WorkerLambdaEnvironment {
  DB: SecurityDatabase;
  CSRF_HMAC_SECRET?: string;
  LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET?: string;
  // Precomputed scrypt hash used for unknown emails so no local scrypt runs.
  DECOY_HASH?: string;
}

const allowedRoutes = new Map<string, string>([
  ["GET /api/health", "health"],
  ["POST /api/auth/local/sign-in", "sign-in"],
  ["GET /api/auth/session/csrf", "session"],
  ["POST /api/auth/session/logout", "session"],
  ["GET /api/practice/dashboard", "dashboard"],
]);

// The sign-in route only runs for a local origin, so the adapter presents the
// Worker origin to the real route as http://localhost. Other origins stay
// unmapped and still fail the route's own origin check.
const localOrigin = "http://localhost";

// Benchmark requests are sent one at a time, so per-request call tracking uses
// module state.
let lambdaCalls = 0;
let lastLambda: Record<string, string> = {};
let currentEnvironment: LearnerSignInD1Environment | null = null;
let currentInvoker: { key: string; invoke: LambdaInvoker } | null = null;

function invoker(environment: LearnerSignInD1Environment): LambdaInvoker {
  const key = [
    environment.LAMBDA_FUNCTION_URL,
    environment.AWS_ACCESS_KEY_ID,
    environment.AWS_SESSION_TOKEN,
  ].join("|");
  if (currentInvoker?.key !== key) {
    currentInvoker = { key, invoke: createLambdaInvoker(environment, fetch) };
  }
  return currentInvoker.invoke;
}

async function verifyThroughLambda(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  if (!currentEnvironment) {
    throw new PasswordHashUnavailableError(new Error("Not configured"));
  }
  lambdaCalls += 1;
  try {
    const call = await invoker(currentEnvironment)({
      encodedHash,
      operation: "verify",
      password,
    });
    if (call.httpStatus !== 200 || call.body.operation !== "verify") {
      throw new Error("Unexpected verifier response");
    }
    const { metrics } = call.body;
    lastLambda = {
      "X-Bench-Lambda-Cold": String(metrics.coldStart),
      "X-Bench-Lambda-Elapsed-Ms": String(metrics.elapsedMs),
      "X-Bench-Lambda-Peak-Rss-Bytes": String(metrics.processPeakRssBytes),
      "X-Bench-Lambda-Round-Trip-Ms": String(call.roundTripMs),
    };
    return call.body.verified;
  } catch (cause) {
    throw new PasswordHashUnavailableError(cause);
  }
}

let application: ReturnType<typeof createApi> | null = null;
let applicationDecoy: string | undefined;

function realApplication(decoyHash: string) {
  if (!application || applicationDecoy !== decoyHash) {
    application = createApi(fetch, Date.now, {
      dummyHash: Promise.resolve(decoyHash),
      verifyPassword: verifyThroughLambda,
    });
    applicationDecoy = decoyHash;
  }
  return application;
}

export default {
  async fetch(
    request: Request,
    environment: LearnerSignInD1Environment,
  ): Promise<Response> {
    // The tester check runs before routing, D1 access, or Lambda work.
    const testerIp = environment.TESTER_IP;
    if (!testerIp || request.headers.get("CF-Connecting-IP") !== testerIp) {
      return new Response("Forbidden", { status: 403 });
    }
    const url = new URL(request.url);
    const route = allowedRoutes.get(`${request.method} ${url.pathname}`);
    if (!route) return new Response("Not found", { status: 404 });
    if (route === "health") {
      return Response.json(
        { ok: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (!environment.DECOY_HASH) {
      return new Response("Service unavailable", { status: 503 });
    }

    const workerOrigin = url.origin;
    const bindings: Record<string, unknown> = {
      CSRF_HMAC_SECRET: environment.CSRF_HMAC_SECRET,
      DB: environment.DB,
      LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET:
        environment.LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET,
      PUBLIC_SITE_ORIGIN: workerOrigin,
    };
    let forwarded = request;
    if (route === "sign-in") {
      // LOCAL_TEST_MAIL_ENABLED only satisfies the route's configuration
      // guard. No mail provider, binding, or mail route exists here.
      bindings.PUBLIC_SITE_ORIGIN = localOrigin;
      bindings.LOCAL_LEARNER_AUTH_ENABLED = "true";
      bindings.LOCAL_TEST_MAIL_ENABLED = "true";
      const headers = new Headers(request.headers);
      if (headers.get("origin") === workerOrigin) {
        headers.set("origin", localOrigin);
      }
      forwarded = new Request(`${localOrigin}${url.pathname}${url.search}`, {
        body: request.body,
        headers,
        method: request.method,
      });
    }

    currentEnvironment = environment;
    lambdaCalls = 0;
    lastLambda = {};
    const response = await realApplication(environment.DECOY_HASH).fetch(
      forwarded,
      bindings,
    );
    const result = new Response(response.body, response);
    result.headers.set("X-Bench-Lambda-Calls", String(lambdaCalls));
    for (const [name, value] of Object.entries(lastLambda)) {
      result.headers.set(name, value);
    }
    return result;
  },
};
