import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashLearnerPassword } from "../../src/security/password-hashing.ts";

const localPasswordIssuer = "https://local-password.certpath.invalid";
const learnerLabels = ["a", "b", "c", "d", "e"] as const;

// Fixed budgets for the whole run; the driver aborts above either.
export const maxWorkerRequests = 50;
export const maxLambdaCalls = 20;

interface AccountFile {
  learners: Record<string, { email: string; password: string }>;
}

export interface RequestRecord {
  seq: number;
  label: string;
  status: number;
  lambdaCalls: number | null;
  expectedStatus: number;
  expectedLambdaCalls: number;
  ok: boolean;
  endToEndMs: number;
  lambdaElapsedMs: number | null;
  lambdaRoundTripMs: number | null;
  lambdaCold: boolean | null;
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  return Buffer.from(bytes).toString("base64url");
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// Writes scratch files that stay outside the repository: accounts.json holds
// the synthetic passwords, seed.sql the hashes, secrets.json the Worker secrets.
async function setup(directory: string): Promise<void> {
  mkdirSync(directory, { recursive: true });
  const accounts: AccountFile = { learners: {} };
  const now = Date.now();
  const statements: string[] = [];
  for (const label of learnerLabels) {
    const email = `learner-${label}-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const password = `synthetic-${randomSecret()}`;
    accounts.learners[label] = { email, password };
    const userId = crypto.randomUUID();
    const subject = crypto.randomUUID();
    const hash = await hashLearnerPassword(password);
    statements.push(
      `INSERT INTO users (id, status, created_at, updated_at) VALUES (${sqlText(userId)}, 'active', ${now}, ${now});`,
      `INSERT INTO auth_identities (issuer, subject, user_id, created_at) VALUES (${sqlText(localPasswordIssuer)}, ${sqlText(subject)}, ${sqlText(userId)}, ${now});`,
      `INSERT INTO learner_password_credentials (user_id, email, email_normalized, subject, password_hash, email_verified_at, created_at, updated_at) VALUES (${sqlText(userId)}, ${sqlText(email)}, ${sqlText(email)}, ${sqlText(subject)}, ${sqlText(hash)}, ${now}, ${now}, ${now});`,
    );
  }
  writeFileSync(join(directory, "accounts.json"), JSON.stringify(accounts));
  writeFileSync(join(directory, "seed.sql"), `${statements.join("\n")}\n`);
  writeFileSync(
    join(directory, "secrets.json"),
    JSON.stringify({
      CSRF_HMAC_SECRET: randomSecret(),
      DECOY_HASH: await hashLearnerPassword(crypto.randomUUID()),
      LOCAL_AUTH_RATE_LIMIT_HMAC_SECRET: randomSecret(),
    }),
  );
  console.log(JSON.stringify({ learners: learnerLabels.length }));
}

class Session {
  readonly records: RequestRecord[] = [];
  private seq = 0;

  constructor(
    private readonly base: string,
    private readonly accounts: AccountFile,
    private readonly retryConnections = false,
  ) {}

  async call(
    label: string,
    path: string,
    expected: { status: number; lambdaCalls: number },
    init: {
      body?: unknown;
      cookie?: string;
      csrf?: string;
      origin?: string;
      rawBody?: string;
    } = {},
  ): Promise<{ json: unknown; record: RequestRecord; cookie?: string }> {
    this.seq += 1;
    if (this.seq > maxWorkerRequests) throw new Error("Worker request budget exceeded");
    const headers: Record<string, string> = {
      Origin: init.origin ?? new URL(this.base).origin,
      "X-Bench-Seq": String(this.seq),
    };
    const payload =
      init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    if (init.cookie) headers.Cookie = init.cookie;
    if (init.csrf) headers["X-CSRF-Token"] = init.csrf;
    const startedAt = performance.now();
    let response: Response | undefined;
    // Only zero-Lambda requests (gate, probe) may retry a failed connection.
    for (let attempt = 1; !response; attempt += 1) {
      try {
        response = await fetch(`${this.base}${path}`, {
          body: payload,
          headers,
          method: payload === undefined ? "GET" : "POST",
          redirect: "manual",
        });
      } catch (error) {
        if (!this.retryConnections || attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    const endToEndMs = performance.now() - startedAt;
    const calls = response.headers.get("x-bench-lambda-calls");
    const num = (name: string) => {
      const value = response.headers.get(name);
      return value === null ? null : Number(value);
    };
    const record: RequestRecord = {
      endToEndMs: Math.round(endToEndMs),
      expectedLambdaCalls: expected.lambdaCalls,
      expectedStatus: expected.status,
      label,
      lambdaCalls: calls === null ? null : Number(calls),
      lambdaCold:
        response.headers.get("x-bench-lambda-cold") === null
          ? null
          : response.headers.get("x-bench-lambda-cold") === "true",
      lambdaElapsedMs: num("x-bench-lambda-elapsed-ms"),
      lambdaRoundTripMs: num("x-bench-lambda-round-trip-ms"),
      ok:
        response.status === expected.status &&
        (calls === null ? expected.lambdaCalls === 0 : Number(calls) === expected.lambdaCalls),
      seq: this.seq,
      status: response.status,
    };
    this.records.push(record);
    const json = await response.json().catch(() => null);
    const setCookie = response.headers.get("set-cookie")?.split(";")[0];
    return {
      cookie: setCookie?.startsWith("certpath_session=") ? setCookie : undefined,
      json,
      record,
    };
  }

  learner(label: string) {
    return this.accounts.learners[label];
  }

  signIn(label: string, learner: string, expected: { status: number; lambdaCalls: number }, password?: string) {
    const account = this.learner(learner);
    return this.call(label, "/api/auth/local/sign-in", expected, {
      body: { email: account.email, password: password ?? account.password },
    });
  }
}

function loadSession(directory: string, retryConnections = false): Session {
  const base = process.env.WORKER_URL;
  if (!base) throw new Error("WORKER_URL is required");
  const accounts = JSON.parse(readFileSync(join(directory, "accounts.json"), "utf8")) as AccountFile;
  return new Session(base, accounts, retryConnections);
}

function report(session: Session): void {
  console.log(JSON.stringify({ allExpected: session.records.every((r) => r.ok), records: session.records }));
}

async function gate(directory: string): Promise<void> {
  const session = loadSession(directory, true);
  await session.signIn("gate-sign-in", "a", { status: 403, lambdaCalls: 0 });
  await session.call("gate-dashboard", "/api/practice/dashboard", { status: 403, lambdaCalls: 0 });
  report(session);
}

async function probe(directory: string): Promise<void> {
  const session = loadSession(directory, true);
  for (let index = 1; index <= 3; index += 1) {
    await session.call(`probe-${index}`, "/api/health", { status: 200, lambdaCalls: 0 });
  }
  report(session);
}

async function functional(directory: string): Promise<void> {
  const session = loadSession(directory);
  const account = (label: string) => session.learner(label);
  const stranger = `stranger-${crypto.randomUUID().slice(0, 8)}@example.test`;
  await session.call("foreign-origin", "/api/auth/local/sign-in", { status: 403, lambdaCalls: 0 }, {
    body: { email: account("a").email, password: account("a").password },
    origin: "https://evil.example",
  });
  await session.call("invalid-body", "/api/auth/local/sign-in", { status: 400, lambdaCalls: 0 }, {
    body: { email: "not-an-email" },
  });
  await session.call("unknown-email", "/api/auth/local/sign-in", { status: 401, lambdaCalls: 1 }, {
    body: { email: stranger, password: account("a").password },
  });
  await session.signIn("wrong-password", "a", { status: 401, lambdaCalls: 1 }, `${account("a").password}-wrong`);
  const valid = await session.signIn("valid-sign-in", "a", { status: 200, lambdaCalls: 1 });
  const cookie = valid.cookie;
  if (!cookie) {
    report(session);
    throw new Error("Valid sign-in did not issue a session cookie");
  }
  const csrf = await session.call("session-csrf", "/api/auth/session/csrf", { status: 200, lambdaCalls: 0 }, { cookie });
  const token = (csrf.json as { csrfToken?: string } | null)?.csrfToken;
  await session.call("dashboard", "/api/practice/dashboard", { status: 200, lambdaCalls: 0 }, { cookie });
  await session.call("dashboard-persisted", "/api/practice/dashboard", { status: 200, lambdaCalls: 0 }, { cookie });
  await session.call("dashboard-no-cookie", "/api/practice/dashboard", { status: 401, lambdaCalls: 0 });
  if (token) {
    await session.call("logout", "/api/auth/session/logout", { status: 204, lambdaCalls: 0 }, { body: {}, cookie, csrf: token });
  }
  await session.call("csrf-after-logout", "/api/auth/session/csrf", { status: 401, lambdaCalls: 0 }, { cookie });
  await session.call("dashboard-after-logout", "/api/practice/dashboard", { status: 401, lambdaCalls: 0 }, { cookie });
  // Learner A has used two attempts; three more are allowed, then the email limit applies.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await session.signIn(`rate-limit-allowed-${attempt}`, "a", { status: 401, lambdaCalls: 1 }, `${account("a").password}-wrong`);
  }
  await session.signIn("rate-limit-blocked", "a", { status: 429, lambdaCalls: 0 }, `${account("a").password}-wrong`);
  report(session);
}

// Rounds of one sign-in per learner B-E, separated by idle gaps (seconds).
async function measure(directory: string, gaps: number[]): Promise<void> {
  const session = loadSession(directory);
  const learners = ["b", "c", "d", "e"];
  for (let round = 0; round <= gaps.length; round += 1) {
    if (round > 0) await new Promise((resolve) => setTimeout(resolve, gaps[round - 1] * 1000));
    let cookie: string | undefined;
    for (const learner of learners) {
      const wrong = round === 1 && learner === "e";
      const result = await session.signIn(
        `measure-r${round + 1}-${learner}${wrong ? "-wrong" : ""}`,
        learner,
        { status: wrong ? 401 : 200, lambdaCalls: 1 },
        wrong ? `${account(session, learner)}-wrong` : undefined,
      );
      if (learner === "b") cookie = result.cookie;
    }
    if (cookie) {
      await session.call(`measure-r${round + 1}-dashboard`, "/api/practice/dashboard", { status: 200, lambdaCalls: 0 }, { cookie });
    }
  }
  report(session);
}

function account(session: Session, learner: string): string {
  return session.learner(learner).password;
}

const command = process.argv[2];
const directory = process.argv[3];
if (command === "setup" && directory) await setup(directory);
else if (command === "gate" && directory) await gate(directory);
else if (command === "probe" && directory) await probe(directory);
else if (command === "functional" && directory) await functional(directory);
else if (command === "measure" && directory) {
  await measure(directory, (process.argv[4] ?? "").split(",").filter(Boolean).map(Number));
} else {
  throw new Error("Usage: client.ts <setup|gate|probe|functional|measure> <directory> [gaps]");
}

