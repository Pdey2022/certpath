import { env } from "cloudflare:workers";
import { it } from "vitest";
import type { SecurityDatabase } from "../src/security/database.ts";
import {
  createTotpSeed,
  matchTotpStep,
  openTotpSeed,
  readSealKey,
  sealTotpSeed,
  totpCodeAt,
  totpStepAt,
} from "../src/security/totp.ts";

// A local measurement of the 5F verify path, in the same workerd runtime the
// Worker uses: AES-256-GCM open, three HMAC-SHA1 candidates, and the two D1
// statements that decide the outcome.
//
// **This is not `cloudflare.cpu_time_ms`.** Wall time inside Miniflare, with an
// in-process SQLite, is a lower bound with a different denominator from
// production CPU. The Cloudflare figure needs the HTTPS path described in
// `docs/reviews/admin-staff-signin-cpu-runbook.md`, which requires a deployed
// temporary Worker - out of scope for 5F, so the deployed number stays
// unmeasured. Run with:
//
//   npm run benchmark:local-auth --workspace @certpath/api
//
// and read the `TOTP_VERIFY_BENCH` lines.

const database: SecurityDatabase = env.DB;
const sealKeyValue = "benchmark-only-staff-mfa-seal-key-with-enough-entropy";
const iterations = 25;

it("benchmarks the TOTP verify path in workerd", async () => {
  const key = await readSealKey(sealKeyValue);
  if (!key) throw new Error("The benchmark seal key is unusable");
  const seed = createTotpSeed();
  const sealed = await sealTotpSeed(key, seed);

  const userId = crypto.randomUUID();
  const now = Date.now();
  await database
    .prepare(
      "INSERT INTO users (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)",
    )
    .bind(userId, now, now)
    .run();
  const credentialId = crypto.randomUUID();
  await database
    .prepare(
      `INSERT INTO staff_totp_credentials (
         credential_id, user_id, secret_ciphertext, secret_iv, key_version,
         digits, period_seconds, algorithm, last_used_step, created_at,
         confirmed_at, created_operation_id, revoked_at, revoked_operation_id
       ) VALUES (?, ?, ?, ?, 1, 6, 30, 'SHA1', 0, ?, ?, ?, NULL, NULL)`,
    )
    .bind(
      credentialId,
      userId,
      sealed.ciphertext,
      sealed.iv,
      now,
      now,
      `benchmark-enrol:${credentialId}`,
    )
    .run();

  const cryptoDurations: number[] = [];
  const statementDurations: number[] = [];
  const totals: number[] = [];
  const cryptoBatch = 100;

  for (let index = 0; index < iterations; index += 1) {
    // A distinct step per iteration so the monotonic predicate always matches.
    const at = now + (index + 1) * 30_000;
    const code = await totpCodeAt(seed, totpStepAt(at));

    // `performance.now()` in workerd resolves to whole milliseconds, so a
    // single HMAC is below the clock. Batch a hundred and divide.
    const cryptoStart = performance.now();
    for (let repeat = 0; repeat < cryptoBatch; repeat += 1) {
      const opened = await openTotpSeed(key, sealed.ciphertext, sealed.iv);
      if (!opened) throw new Error("The benchmark seed did not open");
      const matched = await matchTotpStep(opened, code, at);
      if (matched !== totpStepAt(at)) {
        throw new Error("The benchmark code did not match");
      }
    }
    const cryptoPerOperation =
      (performance.now() - cryptoStart) / cryptoBatch;
    cryptoDurations.push(cryptoPerOperation);

    const step = totpStepAt(at);
    const statementStart = performance.now();
    const burned = await database
      .prepare(
        `UPDATE staff_totp_credentials
         SET last_used_step = ?
         WHERE credential_id = ? AND revoked_at IS NULL
           AND confirmed_at IS NOT NULL AND last_used_step < ?
         RETURNING last_used_step`,
      )
      .bind(step, credentialId, step)
      .all<{ last_used_step: number }>();
    const read = await database
      .prepare(
        `SELECT mfa_method, mfa_verified_at FROM app_sessions
         WHERE token_digest = ?`,
      )
      .bind("0".repeat(64))
      .all();
    statementDurations.push(performance.now() - statementStart);
    if (burned.results?.length !== 1 || read.results === undefined) {
      throw new Error("The benchmark statements did not complete");
    }

    totals.push(cryptoPerOperation + statementDurations[index]!);
  }

  const summarise = (values: number[]) => {
    const sorted = [...values].sort((left, right) => left - right);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    return {
      median_ms: Number(median.toFixed(3)),
      min_ms: Number(sorted[0]!.toFixed(3)),
      max_ms: Number(sorted[sorted.length - 1]!.toFixed(3)),
    };
  };

  console.log(
    `TOTP_VERIFY_BENCH crypto ${JSON.stringify(summarise(cryptoDurations))}`,
  );
  console.log(
    `TOTP_VERIFY_BENCH statements ${JSON.stringify(summarise(statementDurations))}`,
  );
  console.log(`TOTP_VERIFY_BENCH total ${JSON.stringify(summarise(totals))}`);
  console.log(
    `TOTP_VERIFY_BENCH note local workerd wall time over ${iterations} iterations; not cloudflare.cpu_time_ms`,
  );
}, 60_000);
