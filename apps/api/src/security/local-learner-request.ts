import type { SecurityDatabase } from "./database.ts";

export type LocalRateLimitAction =
  | "registration"
  | "sign_in"
  | "recovery"
  | "verification"
  | "password_reset"
  | "sign_in_link_request"
  | "sign_in_link_inspect"
  | "sign_in_link_redeem"
  | "staff_sign_in";

export type JsonBody =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413 | 415 };

export const maxJsonBodyBytes = 6 * 1024;
const maxActiveRateLimitRows = 5_000;

const ratePolicies: Record<
  LocalRateLimitAction,
  { windowMs: number; maxIp: number; maxEmail?: number }
> = {
  registration: { windowMs: 60 * 60 * 1000, maxIp: 10, maxEmail: 3 },
  sign_in: { windowMs: 15 * 60 * 1000, maxIp: 30, maxEmail: 5 },
  recovery: { windowMs: 60 * 60 * 1000, maxIp: 10, maxEmail: 3 },
  verification: { windowMs: 60 * 60 * 1000, maxIp: 20 },
  password_reset: { windowMs: 60 * 60 * 1000, maxIp: 10 },
  sign_in_link_request: { windowMs: 15 * 60 * 1000, maxIp: 10, maxEmail: 3 },
  sign_in_link_inspect: { windowMs: 15 * 60 * 1000, maxIp: 60 },
  sign_in_link_redeem: { windowMs: 15 * 60 * 1000, maxIp: 20 },
  staff_sign_in: { windowMs: 15 * 60 * 1000, maxIp: 10, maxEmail: 5 },
};

export function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function isSyntheticEmail(email: string): boolean {
  return email.toLowerCase().endsWith("@example.test");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function createOpaqueToken(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function validRequestOrigin(
  request: Request,
  expectedOrigin: string,
  requireHeader: boolean,
): boolean {
  if (new URL(request.url).origin !== expectedOrigin) return false;
  const supplied = request.headers.get("origin");
  return supplied === expectedOrigin || (!requireHeader && supplied === null);
}

async function digestRateLimitBucket(
  secret: string,
  scope: string,
  value: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      toArrayBuffer(new TextEncoder().encode(`${scope}\n${value}`)),
    ),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function consumeLocalRateLimit(
  database: SecurityDatabase,
  secret: string,
  action: LocalRateLimitAction,
  request: Request,
  email: string | null,
  now: number,
): Promise<boolean> {
  const policy = ratePolicies[action];
  const windowStartedAt = Math.floor(now / policy.windowMs) * policy.windowMs;
  const expiresAt = windowStartedAt + policy.windowMs;
  const ip =
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "local";
  const buckets: Array<{ scope: string; value: string; limit: number }> = [
    { scope: `${action}_ip`, value: ip, limit: policy.maxIp },
  ];
  if (email && policy.maxEmail) {
    buckets.push({
      scope: `${action}_email`,
      value: normalizeEmail(email),
      limit: policy.maxEmail,
    });
  }

  await database
    .prepare("DELETE FROM local_auth_rate_limit_windows WHERE expires_at <= ?")
    .bind(now)
    .run();

  const statements = await Promise.all(
    buckets.map(async ({ scope, value, limit }) => {
      const bucketDigest = await digestRateLimitBucket(secret, scope, value);
      return database
        .prepare(
          `INSERT INTO local_auth_rate_limit_windows (
             scope, bucket_digest, window_started_at, expires_at, request_count
           )
           SELECT ?, ?, ?, ?, 1
           WHERE (
             SELECT COUNT(*) FROM local_auth_rate_limit_windows
             WHERE expires_at > ?
           ) < ?
           ON CONFLICT(scope, bucket_digest, window_started_at) DO UPDATE SET
             request_count = request_count + 1
           WHERE request_count < ?
           RETURNING request_count`,
        )
        .bind(
          scope,
          bucketDigest,
          windowStartedAt,
          expiresAt,
          now,
          maxActiveRateLimitRows,
          limit,
        );
    }),
  );
  const results = await database.batch(statements);
  return results.every((result) => result.meta.changes === 1);
}

export async function readJsonBody(request: Request): Promise<JsonBody> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  ) {
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
  try {
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
  } catch {
    return { ok: false, status: 400 };
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
