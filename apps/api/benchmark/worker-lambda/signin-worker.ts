import { learnerSignInRequestSchema } from "@certpath/contracts";
import type { BenchmarkResponse } from "../lambda/protocol.ts";
import { signLambdaRequest } from "./sigv4.ts";
import {
  createLambdaInvoker,
  type LambdaInvoker,
  type WorkerLambdaEnvironment,
} from "./worker.ts";

export interface SignInEnvironment extends WorkerLambdaEnvironment {
  // JSON object of synthetic email -> scrypt hash, plus a "decoy" entry used
  // for unknown emails so that every sign-in makes exactly one Lambda call.
  SYNTHETIC_ACCOUNTS?: string;
  RATE_LIMIT_HMAC_SECRET?: string;
}

const maxJsonBodyBytes = 6 * 1024;
const storedHashPattern =
  /^\$scrypt\$ln=15,r=8,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
    status,
  });
}

function error(status: number, code: string): Response {
  return json({ error: { code } }, status);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digestBucket(
  secret: string,
  scope: string,
  value: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${scope}\n${value}`),
      ),
    ),
  );
}

async function readJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413 | 415 }> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return { ok: false, status: 415 };
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxJsonBodyBytes) {
    return { ok: false, status: 413 };
  }
  if (!request.body) return { ok: false, status: 400 };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxJsonBodyBytes) {
      await reader.cancel();
      return { ok: false, status: 413 };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, status: 400 };
  }
}

function parseAccounts(text: string | undefined): Record<string, string> | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const accounts: Record<string, string> = {};
    for (const [email, hash] of Object.entries(value)) {
      if (typeof hash !== "string" || !storedHashPattern.test(hash)) return null;
      accounts[email] = hash;
    }
    return typeof accounts.decoy === "string" ? accounts : null;
  } catch {
    return null;
  }
}

// Zero-Lambda stand-in: signs one request with fake credentials but makes no
// network call, so a probe exercises everything except the subrequest.
function createProbeInvoker(): LambdaInvoker {
  return async () => {
    await signLambdaRequest({
      body: "{}",
      credentials: {
        accessKeyId: "AKIAPROBE000000000",
        secretAccessKey: "probe-secret-not-real",
        sessionToken: "probe-token-not-real",
      },
      region: "eu-north-1",
      url: new URL("https://probe.lambda-url.eu-north-1.on.aws/verify"),
    });
    const body: BenchmarkResponse = {
      metrics: {
        coldStart: false,
        cpuSystemMs: 0,
        cpuUserMs: 0,
        elapsedMs: 0,
        memoryLimitMb: null,
        processPeakRssBytes: 0,
        processRssBytes: 0,
        requestId: "probe",
      },
      operation: "verify",
      verified: true,
    };
    return { body, httpStatus: 200, roundTripMs: 0 };
  };
}

async function signIn(
  request: Request,
  environment: SignInEnvironment,
  invoke: LambdaInvoker,
): Promise<Response> {
  // Same-origin check, as in the app's sign-in route.
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return error(403, "invalid_origin");
  }
  const accounts = parseAccounts(environment.SYNTHETIC_ACCOUNTS);
  const rateSecret = environment.RATE_LIMIT_HMAC_SECRET;
  if (!accounts || !rateSecret) return error(503, "service_unavailable");

  const body = await readJsonBody(request);
  if (!body.ok) return error(body.status, "invalid_request");
  const parsed = learnerSignInRequestSchema.safeParse(body.value);
  if (!parsed.success) return error(400, "invalid_request");
  const email = normalizeEmail(parsed.data.email);

  // The app derives HMAC rate-limit bucket digests; the counter itself needs D1
  // and is omitted here.
  const ip = request.headers.get("cf-connecting-ip")?.trim() || "local";
  await Promise.all([
    digestBucket(rateSecret, "sign_in_ip", ip),
    digestBucket(rateSecret, "sign_in_email", email),
  ]);

  const known =
    email !== "decoy" && email.endsWith("@example.test") && accounts[email];
  const encodedHash = known || accounts.decoy;
  let lambdaCall;
  try {
    lambdaCall = await invoke({
      encodedHash,
      operation: "verify",
      password: parsed.data.password,
    });
  } catch {
    return error(503, "service_unavailable");
  }
  if (lambdaCall.body.operation !== "verify") {
    return error(503, "service_unavailable");
  }
  const { metrics } = lambdaCall.body;
  const benchmarkHeaders = {
    "X-Bench-Lambda-Cold": String(metrics.coldStart),
    "X-Bench-Lambda-Elapsed-Ms": String(metrics.elapsedMs),
    "X-Bench-Lambda-Peak-Rss-Bytes": String(metrics.processPeakRssBytes),
    "X-Bench-Lambda-Round-Trip-Ms": String(lambdaCall.roundTripMs),
  };
  if (!known || !lambdaCall.body.verified) {
    return json({ error: { code: "invalid_credentials" } }, 401, benchmarkHeaders);
  }

  // Session token creation and digest, as in the app; persistence needs D1.
  const rawSessionToken = encodeBase64Url(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(rawSessionToken),
  );
  return json({ redirectTo: "/app/home" }, 200, {
    ...benchmarkHeaders,
    "Set-Cookie": `certpath_session=${rawSessionToken}; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax`,
  });
}

export function createSignInBenchmark(fetcher: typeof fetch = fetch) {
  return {
    async fetch(
      request: Request,
      environment: SignInEnvironment,
    ): Promise<Response> {
      // The tester check runs before routing, parsing, or any Lambda work.
      const testerIp = environment.TESTER_IP;
      if (!testerIp || request.headers.get("CF-Connecting-IP") !== testerIp) {
        return new Response("Forbidden", { status: 403 });
      }
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/") {
        return json({ ready: true });
      }
      if (request.method !== "POST") {
        return new Response("Not found", { status: 404 });
      }
      if (url.pathname === "/probe") {
        return signIn(request, environment, createProbeInvoker());
      }
      if (url.pathname === "/sign-in") {
        let invoke: LambdaInvoker;
        try {
          invoke = createLambdaInvoker(environment, fetcher);
        } catch {
          return error(503, "service_unavailable");
        }
        return signIn(request, environment, invoke);
      }
      return new Response("Not found", { status: 404 });
    },
  };
}

export default createSignInBenchmark();
