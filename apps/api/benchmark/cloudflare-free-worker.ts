import {
  hashLearnerPassword,
  verifyLearnerPassword,
} from "../src/security/password-hashing.ts";

interface BenchmarkEnvironment {
  TESTER_IP?: string;
}

declare global {
  interface CacheStorage {
    readonly default: Cache;
  }
}

type HashPassword = typeof hashLearnerPassword;
type VerifyPassword = typeof verifyLearnerPassword;

const hashCacheKey = new Request(
  "https://scrypt-free-proof.invalid/current-hash",
);
const passwordAlphabet =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+,-./:;<=>?@[]^_{}~";

function syntheticPassword(): string {
  return Array.from({ length: 64 }, (_, index) =>
    passwordAlphabet[(index * 37 + 19) % passwordAlphabet.length],
  ).join("");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export function createCloudflareFreeBenchmarkWorker(
  hashPassword: HashPassword = hashLearnerPassword,
  verifyPassword: VerifyPassword = verifyLearnerPassword,
) {
  return {
    async fetch(
      request: Request,
      environment: BenchmarkEnvironment,
    ): Promise<Response> {
      const testerIp = environment.TESTER_IP;
      if (
        !testerIp ||
        request.headers.get("CF-Connecting-IP") !== testerIp
      ) {
        return new Response("Forbidden", { status: 403 });
      }

      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/") {
        return jsonResponse({ ready: true });
      }
      if (request.method !== "POST") {
        return new Response("Not found", { status: 404 });
      }

      if (url.pathname === "/hash") {
        const startedAt = performance.now();
        const encodedHash = await hashPassword(syntheticPassword());
        const elapsedMs = performance.now() - startedAt;
        await caches.default.put(
          hashCacheKey,
          new Response(encodedHash, {
            headers: { "Cache-Control": "public, max-age=300" },
          }),
        );
        return jsonResponse({ operation: "hash", elapsedMs });
      }

      if (url.pathname === "/verify") {
        const cachedHash = await caches.default.match(
          hashCacheKey,
        );
        if (!cachedHash) {
          return jsonResponse({ error: "Hash is unavailable" }, 409);
        }
        const encodedHash = await cachedHash.text();
        const startedAt = performance.now();
        const verified = await verifyPassword(
          syntheticPassword(),
          encodedHash,
        );
        const elapsedMs = performance.now() - startedAt;
        return jsonResponse({
          operation: "verify",
          elapsedMs,
          verified,
        });
      }

      return new Response("Not found", { status: 404 });
    },
  };
}

export default createCloudflareFreeBenchmarkWorker();
