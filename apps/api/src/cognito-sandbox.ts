import { Hono, type Context } from "hono";
import type { SecurityDatabase } from "./security/database.ts";
import {
  constantTimeEqual,
  createCsrfToken,
  sessionCookieToken,
  sessionDigest,
} from "./security/http-session.ts";
import { findActiveApplicationSession, findUserForIdentity } from "./security/repository.ts";
import { revokeOwnApplicationSession } from "./security/mutations.ts";

type Bindings = {
  DB: SecurityDatabase;
  PUBLIC_SITE_ORIGIN?: string;
  CSRF_HMAC_SECRET?: string;
  STAFF_MFA_MAX_AGE_MS?: string;
  STAFF_MFA_ALLOWED_METHODS?: string;
  COGNITO_SANDBOX_ENABLED?: string;
  COGNITO_SANDBOX_ALLOWED_CLIENT_IPS?: string;
  COGNITO_ISSUER?: string;
  COGNITO_DOMAIN?: string;
  COGNITO_CALLBACK_URL?: string;
  COGNITO_LEARNER_CLIENT_ID?: string;
  COGNITO_STAFF_CLIENT_ID?: string;
  COGNITO_TRANSACTION_ENCRYPTION_KEY?: string;
};

type Fetcher = typeof fetch;
type Audience = "learner" | "staff";
type JsonRecord = Record<string, unknown>;

interface Configuration {
  issuer: string;
  domain: string;
  callbackUrl: string;
  publicOrigin: string;
  learnerClientId: string;
  staffClientId: string;
  transactionKey: string;
  staffMfaMaxAgeMs: number;
  allowedClientIps: string[];
}

interface LoginTransaction {
  audience: Audience;
  client_id: string;
  nonce_digest: string;
  browser_binding_digest: string;
  verifier_ciphertext: string;
  verifier_iv: string;
}

interface IdTokenClaims extends JsonRecord {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  token_use: string;
  nonce: string;
  email_verified: boolean;
}

type CognitoIdTokenValidation =
  | { ok: true; claims: IdTokenClaims }
  | { ok: false; reason: string };

const transactionLifetimeMs = 10 * 60 * 1000;
const sessionCookieName = "certpath_session";
const loginCookiePrefix = "certpath_login_";

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
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = Uint8Array.from(
      atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)),
      (character) => character.charCodeAt(0),
    );
    return encodeBase64Url(decoded) === value ? decoded : null;
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
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const material = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      toArrayBuffer(new TextEncoder().encode(secret)),
    ),
  );
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(material),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptVerifier(
  verifier: string,
  secret: string,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      await encryptionKey(secret),
      toArrayBuffer(new TextEncoder().encode(verifier)),
    ),
  );
  return { ciphertext: encodeBase64Url(encrypted), iv: encodeBase64Url(iv) };
}

async function decryptVerifier(
  ciphertext: string,
  ivValue: string,
  secret: string,
): Promise<string | null> {
  const encrypted = decodeBase64Url(ciphertext);
  const iv = decodeBase64Url(ivValue);
  if (!encrypted || !iv || iv.byteLength !== 12) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      await encryptionKey(secret),
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
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function canonicalIpAddress(value: string | undefined): string | null {
  if (!value || value.length > 45) return null;
  const octets = value.split(".");
  if (
    octets.length === 4 &&
    octets.every((octet) => /^(0|[1-9]\d{0,2})$/.test(octet)) &&
    octets.every((octet) => Number(octet) <= 255)
  ) {
    return octets.map((octet) => String(Number(octet))).join(".");
  }
  if (!value.includes(":")) return null;
  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    return hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1).toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function readAllowedClientIps(value: string | undefined): string[] | null {
  if (!value || value.length > 512) return null;
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.length === 0 || entries.length > 16) return null;
  const canonicalEntries = entries.map(canonicalIpAddress);
  if (canonicalEntries.some((entry) => entry === null)) {
    return null;
  }
  return [
    ...new Set(
      canonicalEntries.filter((entry): entry is string => entry !== null),
    ),
  ];
}

function readConfiguration(bindings: Bindings): Configuration | null {
  if (
    bindings.COGNITO_SANDBOX_ENABLED !== "true" ||
    !bindings.COGNITO_TRANSACTION_ENCRYPTION_KEY ||
    new TextEncoder().encode(bindings.COGNITO_TRANSACTION_ENCRYPTION_KEY)
      .byteLength < 32 ||
    !/^[1-9]\d*$/.test(bindings.STAFF_MFA_MAX_AGE_MS ?? "") ||
    bindings.STAFF_MFA_ALLOWED_METHODS !== "totp"
  ) {
    return null;
  }
  const origin = validHttpsUrl(bindings.PUBLIC_SITE_ORIGIN);
  const issuer = validHttpsUrl(bindings.COGNITO_ISSUER);
  const domain = validHttpsUrl(bindings.COGNITO_DOMAIN);
  const callbackUrl = validHttpsUrl(bindings.COGNITO_CALLBACK_URL);
  const learnerClientId = bindings.COGNITO_LEARNER_CLIENT_ID;
  const staffClientId = bindings.COGNITO_STAFF_CLIENT_ID;
  const staffMfaMaxAgeMs = Number(bindings.STAFF_MFA_MAX_AGE_MS);
  const allowedClientIps = readAllowedClientIps(
    bindings.COGNITO_SANDBOX_ALLOWED_CLIENT_IPS,
  );
  if (
    !origin ||
    origin.origin !== bindings.PUBLIC_SITE_ORIGIN ||
    origin.pathname !== "/" ||
    !issuer ||
    !/^cognito-idp\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(
      issuer.hostname,
    ) ||
    !/^\/[a-z0-9-]+_[A-Za-z0-9]+$/.test(issuer.pathname) ||
    !domain ||
    domain.pathname !== "/" ||
    !callbackUrl ||
    callbackUrl.origin !== origin.origin ||
    callbackUrl.pathname !== "/api/auth/cognito/callback" ||
    !learnerClientId ||
    !staffClientId ||
    learnerClientId === staffClientId ||
    !allowedClientIps ||
    !Number.isSafeInteger(staffMfaMaxAgeMs)
  ) {
    return null;
  }
  return {
    issuer: issuer.href.replace(/\/$/, ""),
    domain: domain.origin,
    callbackUrl: callbackUrl.href,
    publicOrigin: origin.origin,
    learnerClientId,
    staffClientId,
    transactionKey: bindings.COGNITO_TRANSACTION_ENCRYPTION_KEY,
    staffMfaMaxAgeMs,
    allowedClientIps,
  };
}

function privateHeaders(context: Context<{ Bindings: Bindings }>): void {
  context.header("Cache-Control", "private, no-store, max-age=0");
  context.header("Pragma", "no-cache");
  context.header("X-Robots-Tag", "noindex, nofollow");
}

function errorResponse(
  context: Context<{ Bindings: Bindings }>,
  status: 400 | 401 | 403 | 404 | 409 | 503,
  code: string,
): Response {
  return context.json({ error: { code } }, status);
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  return values[0].slice(name.length + 1);
}

function cookieHeader(
  name: string,
  value: string,
  maxAge: number,
  path = "/api/auth/cognito",
): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
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

async function fetchJson(fetcher: Fetcher, url: string, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: "error" });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

async function verifyIdToken(
  token: string,
  config: Configuration,
  expectedClientId: string,
  expectedNonceDigest: string,
  fetcher: Fetcher,
  now: number,
  audience: Audience,
): Promise<CognitoIdTokenValidation> {
  if (token.length > 16_384) return { ok: false, reason: "token-too-large" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return { ok: false, reason: "malformed-token" };
  }
  const headerValue = decodeJsonSegment(parts[0]);
  const claimsValue = decodeJsonSegment(parts[1]);
  const signature = decodeBase64Url(parts[2]);
  if (!isRecord(headerValue) || !isRecord(claimsValue) || !signature) {
    return { ok: false, reason: "malformed-token" };
  }
  if (
    headerValue.alg !== "RS256" ||
    typeof headerValue.kid !== "string" ||
    headerValue.kid.length > 256
  ) {
    return { ok: false, reason: "unsupported-signing-algorithm" };
  }
  const jwks = await fetchJson(
    fetcher,
    `${config.issuer}/.well-known/jwks.json`,
    { headers: { Accept: "application/json" }, cache: "no-store" },
  );
  if (!jwks || !Array.isArray(jwks.keys)) {
    return { ok: false, reason: "jwks-unavailable" };
  }
  const jwkValue = jwks.keys.find(
    (key) =>
      isRecord(key) &&
      key.kid === headerValue.kid &&
      key.kty === "RSA" &&
      key.use === "sig" &&
      key.alg === "RS256" &&
      typeof key.n === "string" &&
      typeof key.e === "string",
  );
  if (!isRecord(jwkValue)) {
    return { ok: false, reason: "signing-key-not-found" };
  }
  let publicKey: CryptoKey;
  try {
    publicKey = await crypto.subtle.importKey(
      "jwk",
      jwkValue as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return { ok: false, reason: "invalid-signing-key" };
  }
  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      publicKey,
      toArrayBuffer(signature),
      toArrayBuffer(new TextEncoder().encode(`${parts[0]}.${parts[1]}`)),
    );
  } catch {
    return { ok: false, reason: "signature-check-failed" };
  }
  if (!signatureValid) return { ok: false, reason: "invalid-signature" };

  const claims = claimsValue;
  const nowSeconds = Math.floor(now / 1000);
  if (
    claims.iss !== config.issuer ||
    claims.aud !== expectedClientId ||
    claims.token_use !== "id" ||
    typeof claims.sub !== "string" ||
    claims.sub.length === 0 ||
    claims.sub.length > 255 ||
    typeof claims.exp !== "number" ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= nowSeconds ||
    typeof claims.iat !== "number" ||
    !Number.isSafeInteger(claims.iat) ||
    claims.iat > nowSeconds + 60 ||
    claims.iat > claims.exp ||
    typeof claims.nonce !== "string" ||
    !(await constantTimeEqual(await sha256(claims.nonce), expectedNonceDigest)) ||
    claims.email_verified !== true
  ) {
    return { ok: false, reason: "invalid-identity-claims" };
  }
  if (audience === "staff") {
    const authTime = claims.auth_time;
    const methods = claims.amr;
    if (
      claims.acr !== "urn:cognito:loa:4" ||
      !Array.isArray(methods) ||
      !["pwd", "otp", "mfa"].every((method) => methods.includes(method)) ||
      typeof authTime !== "number" ||
      !Number.isSafeInteger(authTime) ||
      authTime > nowSeconds ||
      authTime > claims.iat ||
      nowSeconds - authTime > config.staffMfaMaxAgeMs / 1000
    ) {
      return { ok: false, reason: "invalid-mfa-assurance" };
    }
  }
  return { ok: true, claims: claims as IdTokenClaims };
}

async function createLearnerIdentity(
  database: SecurityDatabase,
  issuer: string,
  subject: string,
  now: number,
): Promise<string | null> {
  const userId = crypto.randomUUID();
  const results = await database.batch([
    database
      .prepare(
        "INSERT INTO users (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)",
      )
      .bind(userId, now, now),
    database
      .prepare(
        "INSERT INTO auth_identities (issuer, subject, user_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(issuer, subject, userId, now),
  ]);
  return results.every((result) => result.meta.changes === 1) ? userId : null;
}

function clearLoginCookie(name: string): string {
  return cookieHeader(name, "", 0);
}

export function createCognitoSandboxApi(fetcher: Fetcher = fetch) {
  const router = new Hono<{ Bindings: Bindings }>();

  router.use("*", async (context, next) => {
    privateHeaders(context);
    const allowedClientIps = readAllowedClientIps(
      context.env.COGNITO_SANDBOX_ALLOWED_CLIENT_IPS,
    );
    if (!allowedClientIps) {
      return errorResponse(context, 503, "sandbox_access_not_configured");
    }
    const clientIp = canonicalIpAddress(
      context.req.header("CF-Connecting-IP"),
    );
    if (!clientIp || !allowedClientIps.includes(clientIp)) {
      return errorResponse(context, 403, "sandbox_access_denied");
    }
    const requestUrl = new URL(context.req.url);
    if (
      context.env.COGNITO_SANDBOX_ENABLED !== "true" &&
      (context.req.method !== "GET" ||
        requestUrl.pathname !== "/api/auth/cognito/preflight")
    ) {
      return errorResponse(context, 503, "auth_not_configured");
    }
    if (
      context.env.COGNITO_SANDBOX_ENABLED === "true" &&
      !readConfiguration(context.env)
    ) {
      return errorResponse(context, 503, "auth_not_configured");
    }
    await next();
  });

  router.get("/preflight", (context) =>
    context.json({
      signInEnabled: context.env.COGNITO_SANDBOX_ENABLED === "true",
    }),
  );

  router.get("/start", async (context) => {
    const config = readConfiguration(context.env);
    if (!config) return errorResponse(context, 503, "auth_not_configured");
    if (new URL(context.req.url).origin !== config.publicOrigin) {
      return errorResponse(context, 400, "invalid_origin");
    }
    const audienceValue = context.req.query("audience");
    if (audienceValue !== "learner" && audienceValue !== "staff") {
      return errorResponse(context, 400, "invalid_audience");
    }
    const audience: Audience = audienceValue;
    const clientId =
      audience === "staff" ? config.staffClientId : config.learnerClientId;
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken();
    const browserBinding = randomToken();
    const stateDigest = await sha256(state);
    const nonceDigest = await sha256(nonce);
    const browserBindingDigest = await sha256(browserBinding);
    const { ciphertext, iv } = await encryptVerifier(
      verifier,
      config.transactionKey,
    );
    const now = Date.now();
    await context.env.DB.prepare(
      "DELETE FROM cognito_login_transactions WHERE expires_at <= ? OR consumed_at IS NOT NULL",
    )
      .bind(now)
      .run();
    await context.env.DB.prepare(
      `INSERT INTO cognito_login_transactions (
         state_digest, audience, client_id, nonce_digest,
         browser_binding_digest, verifier_ciphertext, verifier_iv,
         created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        stateDigest,
        audience,
        clientId,
        nonceDigest,
        browserBindingDigest,
        ciphertext,
        iv,
        now,
        now + transactionLifetimeMs,
      )
      .run();

    const challenge = encodeBase64Url(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          toArrayBuffer(new TextEncoder().encode(verifier)),
        ),
      ),
    );
    const authorizationUrl = new URL("/oauth2/authorize", config.domain);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: config.callbackUrl,
      scope: "openid email",
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: challenge,
      ...(audience === "staff"
        ? {
            acr_values: "urn:cognito:loa:4",
            max_age: String(Math.ceil(config.staffMfaMaxAgeMs / 1000)),
          }
        : {}),
    }).toString();
    context.header(
      "Set-Cookie",
      cookieHeader(`${loginCookiePrefix}${state.slice(0, 16)}`, browserBinding, 600),
    );
    return context.redirect(authorizationUrl.toString(), 302);
  });

  router.get("/callback", async (context) => {
    const config = readConfiguration(context.env);
    if (!config) return errorResponse(context, 503, "auth_not_configured");
    if (new URL(context.req.url).origin !== config.publicOrigin) {
      return errorResponse(context, 400, "invalid_origin");
    }
    const state = context.req.query("state");
    const code = context.req.query("code");
    if (
      !state ||
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      (code !== undefined && (code.length === 0 || code.length > 2048))
    ) {
      return errorResponse(context, 400, "invalid_login_transaction");
    }
    const stateDigest = await sha256(state);
    const transaction = await context.env.DB.withSession("first-primary")
      .prepare(
        `SELECT audience, client_id, nonce_digest, browser_binding_digest,
                verifier_ciphertext, verifier_iv
         FROM cognito_login_transactions
         WHERE state_digest = ? AND consumed_at IS NULL AND expires_at > ?`,
      )
      .bind(stateDigest, Date.now())
      .first<LoginTransaction>();
    const cookieName = `${loginCookiePrefix}${state.slice(0, 16)}`;
    const browserBinding = cookieValue(
      context.req.header("Cookie"),
      cookieName,
    );
    if (
      !transaction ||
      !browserBinding ||
      !(await constantTimeEqual(
        await sha256(browserBinding),
        transaction.browser_binding_digest,
      ))
    ) {
      return errorResponse(context, 400, "invalid_login_transaction");
    }
    const now = Date.now();
    const consumed = await context.env.DB.prepare(
      `UPDATE cognito_login_transactions
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

    try {
      if (!code) return errorResponse(context, 401, "provider_login_failed");
      const expectedClientId =
        transaction.audience === "staff"
          ? config.staffClientId
          : config.learnerClientId;
      if (
        transaction.client_id !== expectedClientId ||
        (transaction.audience !== "staff" &&
          transaction.audience !== "learner")
      ) {
        return errorResponse(context, 400, "invalid_login_transaction");
      }
      const verifier = await decryptVerifier(
        transaction.verifier_ciphertext,
        transaction.verifier_iv,
        config.transactionKey,
      );
      if (!verifier) {
        return errorResponse(context, 503, "auth_not_configured");
      }
      const tokenEndpoint = new URL("/oauth2/token", config.domain).toString();
      const tokenResponse = await fetchJson(fetcher, tokenEndpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: expectedClientId,
          code,
          redirect_uri: config.callbackUrl,
          code_verifier: verifier,
        }),
      });
      if (
        !tokenResponse ||
        typeof tokenResponse.id_token !== "string" ||
        tokenResponse.id_token.length === 0
      ) {
        return errorResponse(context, 401, "provider_login_failed");
      }
      const tokenValidation = await verifyIdToken(
        tokenResponse.id_token,
        config,
        expectedClientId,
        transaction.nonce_digest,
        fetcher,
        now,
        transaction.audience,
      );
      if (!tokenValidation.ok) {
        return errorResponse(context, 401, "invalid_identity_token");
      }
      const claims = tokenValidation.claims;
      let userId = await findUserForIdentity(
        context.env.DB,
        claims.iss,
        claims.sub,
      );
      if (!userId && transaction.audience === "learner") {
        userId = await createLearnerIdentity(
          context.env.DB,
          claims.iss,
          claims.sub,
          now,
        );
      }
      if (!userId) return errorResponse(context, 403, "identity_not_authorized");

      const user = await context.env.DB.withSession("first-primary")
        .prepare(
          `SELECT users.status, staff_roles.role
           FROM users
           LEFT JOIN staff_roles
             ON staff_roles.user_id = users.id AND staff_roles.active = 1
           WHERE users.id = ?`,
        )
        .bind(userId)
        .first<{ status: string; role: string | null }>();
      if (
        !user ||
        user.status !== "active" ||
        (transaction.audience === "staff" &&
          user.role !== "global_admin" &&
          user.role !== "manager")
      ) {
        return errorResponse(context, 403, "identity_not_authorized");
      }

      const rawSession = randomToken();
      const tokenDigest = await sessionDigest(rawSession);
      const expiresAt = claims.exp * 1000;
      const staffMfaVerifiedAt =
        transaction.audience === "staff"
          ? (claims.auth_time as number) * 1000
          : null;
      const sessionInsert = await context.env.DB.prepare(
        `INSERT INTO app_sessions (
           token_digest, user_id, created_at, expires_at,
           mfa_method, mfa_verified_at
         )
         SELECT ?, users.id, ?, ?, ?, ?
         FROM users
         WHERE users.id = ? AND users.status = 'active'
           AND (
             ? = 'learner'
             OR EXISTS (
               SELECT 1 FROM staff_roles
               WHERE staff_roles.user_id = users.id
                 AND staff_roles.active = 1
                 AND staff_roles.role IN ('global_admin', 'manager')
             )
           )
         RETURNING token_digest`,
      )
        .bind(
          tokenDigest,
          now,
          expiresAt,
          transaction.audience === "staff" ? "totp" : null,
          staffMfaVerifiedAt,
          userId,
          transaction.audience,
        )
        .all<{ token_digest: string }>();
      if (sessionInsert.results.length !== 1) {
        return errorResponse(context, 403, "identity_not_authorized");
      }
      const maxAgeSeconds = Math.max(
        0,
        Math.floor((expiresAt - now) / 1000),
      );
      const redirectPath =
        transaction.audience === "staff"
          ? "/admin/question-editor"
          : "/app/home";
      context.header(
        "Set-Cookie",
        cookieHeader(sessionCookieName, rawSession, maxAgeSeconds, "/"),
      );
      context.header(
        "Set-Cookie",
        clearLoginCookie(cookieName),
        { append: true },
      );
      return context.redirect(
        new URL(redirectPath, config.publicOrigin).toString(),
        303,
      );
    } finally {
      await context.env.DB.prepare(
        "DELETE FROM cognito_login_transactions WHERE state_digest = ? AND consumed_at IS NOT NULL",
      )
        .bind(stateDigest)
        .run();
    }
  });

  router.get("/csrf", async (context) => {
    const origin = context.env.PUBLIC_SITE_ORIGIN;
    const secret = context.env.CSRF_HMAC_SECRET;
    if (!origin || !secret || new TextEncoder().encode(secret).byteLength < 32) {
      return errorResponse(context, 503, "service_unavailable");
    }
    const rawToken = sessionCookieToken(context.req.header("Cookie") ?? null);
    if (!rawToken) return errorResponse(context, 401, "unauthenticated");
    const tokenDigest = await sessionDigest(rawToken);
    const session = await findActiveApplicationSession(
      context.env.DB,
      tokenDigest,
      Date.now(),
    );
    if (!session) return errorResponse(context, 401, "unauthenticated");
    return context.json({
      csrfToken: await createCsrfToken(
        origin,
        tokenDigest,
        new TextEncoder().encode(secret),
      ),
    });
  });

  router.post("/logout", async (context) => {
    const origin = context.env.PUBLIC_SITE_ORIGIN;
    const secret = context.env.CSRF_HMAC_SECRET;
    if (!origin || !secret || new TextEncoder().encode(secret).byteLength < 32) {
      return errorResponse(context, 503, "service_unavailable");
    }
    const rawToken = sessionCookieToken(context.req.header("Cookie") ?? null);
    if (!rawToken) {
      context.header(
        "Set-Cookie",
        `${sessionCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      );
      return context.body(null, 204);
    }
    const tokenDigest = await sessionDigest(rawToken);
    const session = await findActiveApplicationSession(
      context.env.DB,
      tokenDigest,
      Date.now(),
    );
    if (!session) {
      context.header(
        "Set-Cookie",
        `${sessionCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      );
      return context.body(null, 204);
    }
    if (
      context.req.header("Origin") !== origin ||
      new URL(context.req.url).origin !== origin
    ) {
      return errorResponse(context, 400, "invalid_origin");
    }
    const supplied = context.req.header("X-CSRF-Token");
    const expected = await createCsrfToken(
      origin,
      tokenDigest,
      new TextEncoder().encode(secret),
    );
    if (!supplied || !constantTimeEqual(supplied, expected)) {
      return errorResponse(context, 400, "invalid_csrf");
    }
    const revoked = await revokeOwnApplicationSession(
      context.env.DB,
      tokenDigest,
      Date.now(),
      `logout:${crypto.randomUUID()}`,
    );
    if (
      !revoked &&
      (await findActiveApplicationSession(
        context.env.DB,
        tokenDigest,
        Date.now(),
      ))
    ) {
      return errorResponse(context, 503, "logout_failed");
    }
    context.header(
      "Set-Cookie",
      `${sessionCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    );
    return context.body(null, 204);
  });

  return router;
}
