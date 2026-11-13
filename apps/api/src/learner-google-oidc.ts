import { Hono, type Context } from "hono";
import type { SecurityDatabase } from "./security/database.ts";
import {
  constantTimeEqual,
  opaqueCookieToken,
  sessionDigest,
  STAGING_SESSION_COOKIE,
} from "./security/http-session.ts";
import { stagingTesterGate } from "./security/staging-gate.ts";

export const googleIssuer = "https://accounts.google.com";
export const googleAuthorizeEndpoint =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const googleTokenEndpoint = "https://oauth2.googleapis.com/token";
export const googleJwksEndpoint =
  "https://www.googleapis.com/oauth2/v3/certs";
export const googleCallbackPath = "/api/auth/google/callback";
export const googleBindingCookie = "__Host-certpath_google_login";

const transactionLifetimeMs = 10 * 60 * 1000;
const sessionLifetimeMs = 8 * 60 * 60 * 1000;
const rateLimitWindowMs = 15 * 60 * 1000;
const maxActiveRateLimitRows = 5_000;
const maximumTokenLength = 16_384;
const clockSkewSeconds = 60;
const jwksCacheMs = 5 * 60 * 1000;
const startLimitPerIp = 10;
const callbackLimitPerIp = 30;

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

type GoogleOidcBindings = {
  DB: SecurityDatabase;
  PUBLIC_SITE_ORIGIN?: string;
  LEARNER_GOOGLE_OIDC_ENABLED?: string;
  GOOGLE_OIDC_CLIENT_ID?: string;
  GOOGLE_OIDC_CLIENT_SECRET?: string;
  GOOGLE_OIDC_REDIRECT_URI?: string;
  GOOGLE_OIDC_TRANSACTION_KEY?: string;
  STAGING_AUTH_RATE_LIMIT_HMAC_SECRET?: string;
  STAGING_TESTER_IPS?: string;
};

type OidcContext = Context<{ Bindings: GoogleOidcBindings }>;

interface Configuration {
  publicOrigin: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  transactionKey: string;
  rateSecret: string;
}

interface LoginTransaction {
  client_id: string;
  nonce_digest: string;
  browser_binding_digest: string;
  verifier_ciphertext: string;
  verifier_iv: string;
}

interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  azp?: string;
  exp: number;
  iat: number;
  nonce: string;
  email_verified: boolean;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    return Uint8Array.from(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")),
      (character) => character.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function randomToken(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      toArrayBuffer(new TextEncoder().encode(value)),
    ),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function bucketDigest(
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
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      toArrayBuffer(new TextEncoder().encode(`${scope}\n${value}`)),
    ),
  );
  return [...signature]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const material = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      toArrayBuffer(new TextEncoder().encode(`google-oidc-transaction\n${secret}`)),
    ),
  );
  return crypto.subtle.importKey("raw", toArrayBuffer(material), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encryptVerifier(
  verifier: string,
  secret: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await encryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(new TextEncoder().encode(verifier)),
    ),
  );
  return { ciphertext: encodeBase64Url(encrypted), iv: encodeBase64Url(iv) };
}

async function decryptVerifier(
  ciphertext: string,
  iv: string,
  secret: string,
): Promise<string | null> {
  const encrypted = decodeBase64Url(ciphertext);
  const ivBytes = decodeBase64Url(iv);
  if (!encrypted || !ivBytes || ivBytes.byteLength !== 12) return null;
  try {
    const key = await encryptionKey(secret);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(ivBytes) },
      key,
      toArrayBuffer(encrypted),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    return null;
  }
}

function validHttpsUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value) return null;
    return url;
  } catch {
    return null;
  }
}

function readConfiguration(
  bindings: GoogleOidcBindings,
): Configuration | null {
  if (bindings.LEARNER_GOOGLE_OIDC_ENABLED !== "true") return null;
  const origin = validHttpsUrl(bindings.PUBLIC_SITE_ORIGIN);
  const clientId = bindings.GOOGLE_OIDC_CLIENT_ID;
  const clientSecret = bindings.GOOGLE_OIDC_CLIENT_SECRET;
  const transactionKey = bindings.GOOGLE_OIDC_TRANSACTION_KEY;
  const rateSecret = bindings.STAGING_AUTH_RATE_LIMIT_HMAC_SECRET;
  const redirectUri = bindings.GOOGLE_OIDC_REDIRECT_URI;
  if (
    !origin ||
    !clientId ||
    !/^[A-Za-z0-9._-]{10,200}$/.test(clientId) ||
    !clientSecret ||
    new TextEncoder().encode(clientSecret).byteLength < 16 ||
    !transactionKey ||
    new TextEncoder().encode(transactionKey).byteLength < 32 ||
    !rateSecret ||
    new TextEncoder().encode(rateSecret).byteLength < 32 ||
    redirectUri !== `${origin.origin}${googleCallbackPath}`
  ) {
    return null;
  }
  return {
    publicOrigin: origin.origin,
    clientId,
    clientSecret,
    redirectUri,
    transactionKey,
    rateSecret,
  };
}

function privateHeaders(context: OidcContext): void {
  context.header("Cache-Control", "private, no-store, max-age=0");
  context.header("Pragma", "no-cache");
  context.header("X-Robots-Tag", "noindex, nofollow");
  context.header("Referrer-Policy", "no-referrer");
}

function errorResponse(
  context: OidcContext,
  status: 400 | 403 | 429 | 503,
  code: string,
  headers: Record<string, string> = {},
): Response {
  return context.json({ error: { code } }, status, headers);
}

function cookieHeader(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  return matches[0].slice(name.length + 1);
}

function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

async function incrementRateLimit(
  database: SecurityDatabase,
  secret: string,
  scope: "google_start_ip" | "google_callback_ip",
  value: string,
  limit: number,
  now: number,
): Promise<boolean> {
  const windowStartedAt =
    Math.floor(now / rateLimitWindowMs) * rateLimitWindowMs;
  const expiresAt = windowStartedAt + rateLimitWindowMs;
  await database
    .prepare(
      "DELETE FROM learner_google_rate_limit_windows WHERE expires_at <= ?",
    )
    .bind(now)
    .run();
  const digest = await bucketDigest(secret, scope, value);
  const result = await database
    .prepare(
      `INSERT INTO learner_google_rate_limit_windows (
         scope, bucket_digest, window_started_at, expires_at, request_count
       )
       SELECT ?, ?, ?, ?, 1
       WHERE (
         SELECT COUNT(*) FROM learner_google_rate_limit_windows
         WHERE expires_at > ?
       ) < ?
       ON CONFLICT(scope, bucket_digest, window_started_at) DO UPDATE SET
         request_count = request_count + 1
       WHERE request_count < ?
       RETURNING request_count`,
    )
    .bind(
      scope,
      digest,
      windowStartedAt,
      expiresAt,
      now,
      maxActiveRateLimitRows,
      limit,
    )
    .all<{ request_count: number }>();
  return result.results.length === 1;
}

export function googleAuthorizeUrl(
  config: Configuration,
  state: string,
  nonce: string,
  codeChallenge: string,
): string {
  const url = new URL(googleAuthorizeEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

interface JwkCache {
  fetchedAt: number;
  keys: JsonRecord[];
}

let jwkCache: JwkCache | null = null;

async function readJwks(fetcher: Fetcher, now: number, force: boolean) {
  if (!force && jwkCache && now - jwkCache.fetchedAt < jwksCacheMs) {
    return jwkCache.keys;
  }
  let response: Response;
  try {
    response = await fetcher(googleJwksEndpoint, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      redirect: "error",
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return null;
  }
  if (!isRecord(value) || !Array.isArray(value.keys)) return null;
  const keys = value.keys.filter(isRecord);
  jwkCache = { fetchedAt: now, keys };
  return keys;
}

function decodeJsonSegment(value: string): unknown {
  const bytes = decodeBase64Url(value);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

async function verifySignature(
  token: string,
  header: JsonRecord,
  signature: Uint8Array,
  fetcher: Fetcher,
  now: number,
): Promise<boolean> {
  const [headerSegment, payloadSegment] = token.split(".");
  const signingInput = toArrayBuffer(
    new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
  );
  for (const force of [false, true]) {
    const keys = await readJwks(fetcher, now, force);
    if (!keys) return false;
    const jwk = keys.find(
      (key) =>
        key.kid === header.kid &&
        key.kty === "RSA" &&
        key.alg === "RS256" &&
        typeof key.n === "string" &&
        typeof key.e === "string",
    );
    if (!jwk) {
      if (force) return false;
      continue;
    }
    try {
      const publicKey = await crypto.subtle.importKey(
        "jwk",
        jwk as JsonWebKey,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      return await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        publicKey,
        toArrayBuffer(signature),
        signingInput,
      );
    } catch {
      return false;
    }
  }
  return false;
}

type TokenValidation =
  | { ok: true; claims: IdTokenClaims }
  | { ok: false; reason: string };

async function verifyIdToken(
  token: string,
  config: Configuration,
  expectedNonceDigest: string,
  fetcher: Fetcher,
  now: number,
): Promise<TokenValidation> {
  if (token.length > maximumTokenLength) return { ok: false, reason: "too-large" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return { ok: false, reason: "malformed" };
  }
  const header = decodeJsonSegment(parts[0]);
  const claims = decodeJsonSegment(parts[1]);
  const signature = decodeBase64Url(parts[2]);
  if (!isRecord(header) || !isRecord(claims) || !signature) {
    return { ok: false, reason: "malformed" };
  }
  if (
    header.alg !== "RS256" ||
    typeof header.kid !== "string" ||
    header.kid.length === 0 ||
    header.kid.length > 256
  ) {
    return { ok: false, reason: "unsupported-algorithm" };
  }
  if (!(await verifySignature(token, header, signature, fetcher, now))) {
    return { ok: false, reason: "invalid-signature" };
  }

  const nowSeconds = Math.floor(now / 1000);
  const audienceMatches =
    claims.aud === config.clientId ||
    (Array.isArray(claims.aud) &&
      claims.aud.length === 1 &&
      claims.aud[0] === config.clientId);
  const authorizedPartyMatches =
    claims.azp === undefined || claims.azp === config.clientId;
  if (
    claims.iss !== googleIssuer ||
    !audienceMatches ||
    !authorizedPartyMatches ||
    typeof claims.sub !== "string" ||
    claims.sub.length === 0 ||
    claims.sub.length > 255 ||
    typeof claims.exp !== "number" ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= nowSeconds ||
    typeof claims.iat !== "number" ||
    !Number.isSafeInteger(claims.iat) ||
    claims.iat > nowSeconds + clockSkewSeconds ||
    claims.iat > claims.exp ||
    typeof claims.nonce !== "string" ||
    !(await constantTimeEqual(await sha256(claims.nonce), expectedNonceDigest)) ||
    claims.email_verified !== true
  ) {
    return { ok: false, reason: "invalid-claims" };
  }
  return { ok: true, claims: claims as unknown as IdTokenClaims };
}

async function exchangeCode(
  fetcher: Fetcher,
  config: Configuration,
  code: string,
  verifier: string,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetcher(googleTokenEndpoint, {
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: config.redirectUri,
      }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      redirect: "error",
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.id_token !== "string") return null;
  return value.id_token.length > 0 ? value.id_token : null;
}

async function findInvitedLearner(
  database: SecurityDatabase,
  subject: string,
): Promise<string | null> {
  const row = await database
    .withSession("first-primary")
    .prepare(
      `SELECT users.id AS user_id
       FROM auth_identities
       JOIN users ON users.id = auth_identities.user_id
       WHERE auth_identities.issuer = ?
         AND auth_identities.subject = ?
         AND users.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM staff_roles WHERE staff_roles.user_id = users.id
         )`,
    )
    .bind(googleIssuer, subject)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

async function createSession(
  database: SecurityDatabase,
  userId: string,
  now: number,
): Promise<string | null> {
  const rawToken = randomToken();
  const tokenDigest = await sessionDigest(rawToken);
  const inserted = await database
    .prepare(
      `INSERT INTO app_sessions (
         token_digest, user_id, created_at, expires_at, mfa_method, mfa_verified_at
       )
       SELECT ?, users.id, ?, ?, NULL, NULL
       FROM users
       WHERE users.id = ? AND users.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM staff_roles WHERE staff_roles.user_id = users.id
         )
       RETURNING token_digest`,
    )
    .bind(tokenDigest, now, now + sessionLifetimeMs, userId)
    .all<{ token_digest: string }>();
  return inserted.results.length === 1 ? rawToken : null;
}

function denialRedirect(context: OidcContext, config: Configuration, code: string) {
  const target = new URL("/sign-in", config.publicOrigin);
  target.searchParams.set("error", code);
  return context.body(null, 303, {
    Location: target.toString(),
  });
}

export function createGoogleLearnerAuthApi(fetcher: Fetcher = fetch) {
  const router = new Hono<{ Bindings: GoogleOidcBindings }>();

  router.use("*", async (context, next) => {
    privateHeaders(context);
    const rejected = stagingTesterGate(context.req.raw, context.env);
    if (rejected) return rejected;
    await next();
  });

  router.get("/preflight", (context) =>
    context.json({ signInEnabled: readConfiguration(context.env) !== null }),
  );

  router.get("/start", async (context) => {
    const config = readConfiguration(context.env);
    if (!config) return errorResponse(context, 503, "auth_not_configured");
    if (new URL(context.req.url).origin !== config.publicOrigin) {
      return errorResponse(context, 400, "invalid_origin");
    }
    const now = Date.now();
    if (
      !(await incrementRateLimit(
        context.env.DB,
        config.rateSecret,
        "google_start_ip",
        clientIp(context.req.raw),
        startLimitPerIp,
        now,
      ))
    ) {
      return errorResponse(context, 429, "rate_limited");
    }

    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken();
    const browserBinding = randomToken();
    const encrypted = await encryptVerifier(verifier, config.transactionKey);
    const challenge = encodeBase64Url(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          toArrayBuffer(new TextEncoder().encode(verifier)),
        ),
      ),
    );
    const inserted = await context.env.DB
      .prepare(
        `INSERT INTO learner_google_login_transactions (
           state_digest, client_id, nonce_digest, browser_binding_digest,
           verifier_ciphertext, verifier_iv, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        await sha256(state),
        config.clientId,
        await sha256(nonce),
        await sha256(browserBinding),
        encrypted.ciphertext,
        encrypted.iv,
        now,
        now + transactionLifetimeMs,
      )
      .run();
    if (inserted.meta.changes !== 1) {
      return errorResponse(context, 503, "auth_not_configured");
    }

    context.header(
      "Set-Cookie",
      cookieHeader(
        googleBindingCookie,
        browserBinding,
        Math.floor(transactionLifetimeMs / 1000),
      ),
    );
    return context.body(null, 302, {
      Location: googleAuthorizeUrl(config, state, nonce, challenge),
    });
  });

  router.get("/callback", async (context) => {
    const config = readConfiguration(context.env);
    if (!config) return errorResponse(context, 503, "auth_not_configured");
    if (new URL(context.req.url).origin !== config.publicOrigin) {
      return errorResponse(context, 400, "invalid_origin");
    }
    const now = Date.now();
    if (
      !(await incrementRateLimit(
        context.env.DB,
        config.rateSecret,
        "google_callback_ip",
        clientIp(context.req.raw),
        callbackLimitPerIp,
        now,
      ))
    ) {
      return errorResponse(context, 429, "rate_limited");
    }

    const state = context.req.query("state");
    const code = context.req.query("code");
    if (
      !state ||
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      !code ||
      code.length === 0 ||
      code.length > 2048
    ) {
      return errorResponse(context, 400, "invalid_login_transaction");
    }

    const stateDigest = await sha256(state);
    const transaction = await context.env.DB
      .withSession("first-primary")
      .prepare(
        `SELECT client_id, nonce_digest, browser_binding_digest,
                verifier_ciphertext, verifier_iv
         FROM learner_google_login_transactions
         WHERE state_digest = ? AND consumed_at IS NULL AND expires_at > ?`,
      )
      .bind(stateDigest, now)
      .first<LoginTransaction>();
    const browserBinding = opaqueCookieToken(
      context.req.header("Cookie") ?? null,
      googleBindingCookie,
    );
    if (
      !transaction ||
      !browserBinding ||
      !(await constantTimeEqual(
        await sha256(browserBinding),
        transaction.browser_binding_digest,
      )) ||
      transaction.client_id !== config.clientId
    ) {
      return errorResponse(context, 400, "invalid_login_transaction");
    }

    const consumed = await context.env.DB
      .prepare(
        `UPDATE learner_google_login_transactions
         SET consumed_at = ?
         WHERE state_digest = ?
           AND consumed_at IS NULL
           AND expires_at > ?
         RETURNING state_digest`,
      )
      .bind(now, stateDigest, now)
      .all<{ state_digest: string }>();
    if (consumed.results.length !== 1) {
      return errorResponse(context, 400, "invalid_login_transaction");
    }

    const clearCookie = cookieHeader(googleBindingCookie, "", 0);
    try {
      const verifier = await decryptVerifier(
        transaction.verifier_ciphertext,
        transaction.verifier_iv,
        config.transactionKey,
      );
      if (!verifier) {
        return errorResponse(context, 503, "auth_not_configured");
      }
      const idToken = await exchangeCode(fetcher, config, code, verifier);
      if (!idToken) {
        return denialRedirect(context, config, "provider_error");
      }
      const validation = await verifyIdToken(
        idToken,
        config,
        transaction.nonce_digest,
        fetcher,
        now,
      );
      if (!validation.ok) {
        return denialRedirect(context, config, "invalid_identity_token");
      }
      const userId = await findInvitedLearner(
        context.env.DB,
        validation.claims.sub,
      );
      if (!userId) {
        return denialRedirect(context, config, "not_invited");
      }
      const rawSession = await createSession(context.env.DB, userId, now);
      if (!rawSession) {
        return denialRedirect(context, config, "not_invited");
      }
      context.header(
        "Set-Cookie",
        cookieHeader(
          STAGING_SESSION_COOKIE,
          rawSession,
          Math.floor(sessionLifetimeMs / 1000),
        ),
      );
      context.header("Set-Cookie", clearCookie, { append: true });
      return context.body(null, 303, {
        Location: new URL("/app/home", config.publicOrigin).toString(),
      });
    } finally {
      await context.env.DB
        .prepare(
          `DELETE FROM learner_google_login_transactions
           WHERE state_digest = ? AND consumed_at IS NOT NULL`,
        )
        .bind(stateDigest)
        .run();
    }
  });

  return router;
}
