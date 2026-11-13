import { env } from "cloudflare:workers";
import { it } from "vitest";
import { createApi } from "../src/index.ts";
import { localPasswordIssuer } from "../src/local-learner-auth.ts";
import {
  hashLearnerPassword,
  learnerPasswordHashParameters,
} from "../src/security/password-hashing.ts";
import type { SecurityDatabase } from "../src/security/database.ts";

const database: SecurityDatabase = env.DB;
const origin = "https://localhost";
const password = "local-worker-benchmark-password";
const bindings = {
  DB: database,
  PUBLIC_SITE_ORIGIN: origin,
  CSRF_HMAC_SECRET: "benchmark-only-csrf-secret-with-sufficient-length",
  LOCAL_LEARNER_AUTH_ENABLED: "true",
  LOCAL_TEST_MAIL_ENABLED: "true",
  LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET:
    "benchmark-only-rate-limit-secret-with-sufficient-length",
};
const application = createApi(fetch);

async function createSyntheticAccount(index: number, passwordHash: string) {
  const timestamp = Date.now();
  const userId = crypto.randomUUID();
  const subject = crypto.randomUUID();
  const address = `auth-benchmark-${index}-${crypto.randomUUID()}@example.test`;
  await database
    .prepare(
      "INSERT INTO users (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)",
    )
    .bind(userId, timestamp, timestamp)
    .run();
  await database
    .prepare(
      "INSERT INTO auth_identities (issuer, subject, user_id, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(localPasswordIssuer, subject, userId, timestamp)
    .run();
  await database
    .prepare(
      `INSERT INTO learner_password_credentials (
         user_id, email, email_normalized, subject, password_hash,
         email_verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(userId, address, address, subject, passwordHash, timestamp, timestamp, timestamp)
    .run();
  return address;
}

it("benchmarks local Worker scrypt and concurrent sign-in wall time", async () => {
  const hashStartedAt = performance.now();
  const passwordHash = await hashLearnerPassword(password);
  const hashWallMs = performance.now() - hashStartedAt;
  console.log(
    `AUTH_BENCH hash profile=${JSON.stringify(learnerPasswordHashParameters)} wall_ms=${hashWallMs.toFixed(1)}`,
  );

  for (const concurrency of [1, 2, 4]) {
    const addresses = await Promise.all(
      Array.from({ length: concurrency }, (_, index) =>
        createSyntheticAccount(
          concurrency * 10 + index,
          passwordHash,
        ),
      ),
    );
    const startedAt = performance.now();
    const responses = await Promise.all(
      addresses.map((email, index) =>
        application.fetch(
          new Request(`${origin}/api/auth/local/sign-in`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: origin,
              "CF-Connecting-IP": `198.51.100.${100 + concurrency * 10 + index}`,
            },
            body: JSON.stringify({ email, password }),
          }),
          bindings,
        ),
      ),
    );
    const wallMs = performance.now() - startedAt;
    console.log(
      `AUTH_BENCH sign_in concurrency=${concurrency} wall_ms=${wallMs.toFixed(1)} statuses=${responses.map((response) => response.status).join(",")}`,
    );
    if (responses.some((response) => response.status !== 200)) {
      throw new Error(
        `Local benchmark sign-ins failed at concurrency ${concurrency}`,
      );
    }
  }
}, 60_000);
