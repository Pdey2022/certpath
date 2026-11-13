import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { hashLearnerPassword } from "../../src/security/password-hashing.ts";
import {
  syntheticAccounts,
  syntheticUnknownEmail,
  syntheticWrongSignInPassword,
} from "./signin-synthetic.ts";

// Tester-side driver. Prints only sanitized measurements; hashes and secrets go
// only to stdout for the modes that are piped into `wrangler secret put`.
// WORKER_URL=https://<worker>.workers.dev node --import tsx benchmark/worker-lambda/signin-client.ts <mode>
const mode = process.argv[2] ?? "";

if (mode === "accounts") {
  const accounts: Record<string, string> = {
    decoy: await hashLearnerPassword(randomBytes(18).toString("base64")),
  };
  for (const account of syntheticAccounts) {
    accounts[account.email] = await hashLearnerPassword(account.password);
  }
  process.stdout.write(JSON.stringify(accounts));
  process.exit(0);
}
if (mode === "hmac") {
  process.stdout.write(randomBytes(32).toString("hex"));
  process.exit(0);
}

const workerUrl = process.env.WORKER_URL;
if (!workerUrl || !["gate", "invalid", "probe", "run"].includes(mode)) {
  console.error("Set WORKER_URL and use mode accounts, hmac, gate, invalid, probe or run");
  process.exit(2);
}
const origin = new URL(workerUrl).origin;
const [accountA, accountB] = syntheticAccounts;

async function post(path: string, body: unknown, sequence: number) {
  const startedAt = performance.now();
  const response = await fetch(new URL(path, workerUrl), {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin,
      "x-bench-seq": String(sequence),
    },
    method: "POST",
    redirect: "manual",
  });
  const endToEndMs = performance.now() - startedAt;
  await response.arrayBuffer();
  const number = (name: string) => {
    const value = response.headers.get(name);
    return value === null ? null : Number(value);
  };
  return {
    endToEndMs,
    lambdaCold: response.headers.get("x-bench-lambda-cold"),
    lambdaElapsedMs: number("x-bench-lambda-elapsed-ms"),
    lambdaPeakRssMb:
      number("x-bench-lambda-peak-rss-bytes") === null
        ? null
        : Math.round(number("x-bench-lambda-peak-rss-bytes")! / 1048576),
    lambdaRoundTripMs: number("x-bench-lambda-round-trip-ms"),
    sessionCookieSet: response.headers.has("set-cookie"),
    status: response.status,
  };
}

if (mode === "gate") {
  const result = await post(
    "/sign-in",
    { email: accountA.email, password: accountA.password },
    0,
  );
  console.log(JSON.stringify({ kind: "gate", status: result.status }));
} else if (mode === "invalid") {
  const result = await post("/sign-in", { email: "not-an-email", password: "" }, 0);
  console.log(JSON.stringify({ kind: "invalid", status: result.status }));
} else if (mode === "probe") {
  const results = [];
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    results.push(
      await post("/probe", { email: accountA.email, password: accountA.password }, sequence),
    );
  }
  console.log(JSON.stringify({ kind: "probe", results }));
} else {
  // Ten separate sign-in-shaped requests, one at a time, one Lambda call each.
  const plan = [
    { label: "correct-a", email: accountA.email, password: accountA.password, expect: 200 },
    { label: "correct-a", email: accountA.email, password: accountA.password, expect: 200 },
    { label: "wrong-a", email: accountA.email, password: syntheticWrongSignInPassword(), expect: 401 },
    { label: "correct-b", email: accountB.email, password: accountB.password, expect: 200 },
    { label: "wrong-b", email: accountB.email, password: syntheticWrongSignInPassword(), expect: 401 },
    { label: "unknown-email", email: syntheticUnknownEmail, password: accountA.password, expect: 401 },
    { label: "correct-a", email: accountA.email, password: accountA.password, expect: 200 },
    { label: "wrong-a", email: accountA.email, password: syntheticWrongSignInPassword(), expect: 401 },
    { label: "correct-b", email: accountB.email, password: accountB.password, expect: 200 },
    { label: "correct-a", email: accountA.email, password: accountA.password, expect: 200 },
  ];
  const results = [];
  for (const [index, step] of plan.entries()) {
    const result = await post(
      "/sign-in",
      { email: step.email, password: step.password },
      index + 1,
    );
    results.push({
      label: step.label,
      sequence: index + 1,
      expectedStatus: step.expect,
      matchedExpectation: result.status === step.expect,
      ...result,
    });
    if (result.status !== step.expect) break;
  }
  console.log(JSON.stringify({ kind: "run", requestsSent: results.length, results }));
  process.exitCode =
    results.length === plan.length && results.every((r) => r.matchedExpectation) ? 0 : 1;
}
