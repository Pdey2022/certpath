import { performance } from "node:perf_hooks";
import {
  hashLearnerPassword,
  verifyLearnerPassword,
} from "../../src/security/password-hashing.ts";
import { syntheticPassword } from "./synthetic.ts";

// Tester-side driver. Prints only sanitized measurements and booleans.
// WORKER_URL=https://<worker>.workers.dev node --import tsx benchmark/worker-lambda/client.ts [probe|run]
const workerUrl = process.env.WORKER_URL;
const mode = process.argv[2] ?? "run";
if (!workerUrl || !["probe", "run"].includes(mode)) {
  console.error("Set WORKER_URL and use mode probe or run");
  process.exit(2);
}

const localEncodedHash = await hashLearnerPassword(syntheticPassword());
const startedAt = performance.now();
const response = await fetch(new URL("/run", workerUrl), {
  body: JSON.stringify({
    includeLambdaHash: mode === "run",
    localEncodedHash,
  }),
  headers: { "content-type": "application/json" },
  method: "POST",
});
const endToEndMs = performance.now() - startedAt;

if (mode === "probe") {
  // An unauthorized caller must see 403 and no Lambda work.
  console.log(JSON.stringify({ endToEndMs, kind: "probe", status: response.status }));
} else {
  const report = (await response.json()) as {
    lambdaEncodedHash?: string;
    [key: string]: unknown;
  };
  const lambdaHashVerifiedLocally =
    response.ok && typeof report.lambdaEncodedHash === "string"
      ? await verifyLearnerPassword(syntheticPassword(), report.lambdaEncodedHash)
      : false;
  delete report.lambdaEncodedHash;
  console.log(
    JSON.stringify({
      ...report,
      endToEndMs,
      kind: "result",
      lambdaHashVerifiedLocally,
      status: response.status,
    }),
  );
  process.exitCode = response.ok && lambdaHashVerifiedLocally ? 0 : 1;
}
