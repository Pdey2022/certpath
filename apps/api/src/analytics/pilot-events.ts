import { Hono, type Context } from "hono";
import {
  pilotBrowserEventNameSchema,
  pilotEventAcceptedResponseSchema,
  pilotEventErrorSchema,
  pilotEventNameSchema,
  pilotEventRequestSchema,
  type PilotEventAcceptedResponse,
  type PilotEventErrorCode,
} from "@certpath/contracts";
import type { SecurityDatabase } from "../security/database.ts";
import { constantTimeEqual } from "../security/http-session.ts";

// The pilot funnel recorder and the browser endpoint.
//
// Two doors, one table, and only one of them is reachable from a browser:
//
// - `createPilotEventsApi` is the page-level `POST /api/events`. It has no
//   session, no CSRF token and no admin surface. Its only effect is a row that
//   carries no personal data, and it writes nothing at all unless the request
//   carries a `pilot_consent` cookie signed with the Worker's own secret.
// - `createPilotEventRecorder` is the server-originated half: `checkout_started`
//   on a created checkout, `purchase_confirmed`/`pro_activated` on a settlement
//   that this delivery applied. It is called beside the domain write, never in
//   front of it, and it cannot fail the caller.
//
// 5B ships the consent **verifier only**. There is no route, function or copy
// that issues a `pilot_consent` cookie, so on a real origin no cookie exists and
// the endpoint records nothing - inertness by construction, not only by flag. The
// owner's consent surface (explicit opt-in, no banner, 180-day cookie) is issued
// in 5D; `createPilotConsentCookieValue` exists so the tests mint exactly what the
// verifier accepts, and 5D's issuer is its first real caller.
//
// What is never read: `CF-Connecting-IP`, `User-Agent`, `Referer`, the query
// string, and every cookie but `pilot_consent`. What is never written: a JSON
// body, free text, an address. What is never logged: the body, the cookie, an IP
// or a user agent - a dropped write logs one line with the source, the event name
// and the error's name, and nothing else.
//
// Rules: docs/pilot-hardening.md, docs/analytics-events.md, 0021_pilot_events.sql.

export const pilotConsentCookieName = "pilot_consent";

/** The owner's 17 November 2026 decision: a consent cookie lives 180 days. */
export const pilotConsentMaxAgeMs = 180 * 86_400_000;

/** The HMAC purpose prefix. One secret (`CSRF_HMAC_SECRET`), two purposes. */
export const pilotConsentPurpose = "pilot-consent-v1";

/** The browser endpoint's body cap. The shape is four scalars; 4 KiB is generous. */
export const maxPilotEventBytes = 4 * 1024;

/** Accepted browser events per `anonymous_session_id` per window. */
export const pilotEventRateLimit = 30;
export const pilotEventRateWindowMs = 60_000;

/**
 * The longest id 0021 accepts in `pilot_events.event_id`.
 *
 * `grant:<checkoutId>:pro` is the longest deterministic server id: a checkout id
 * is at most 118 characters (`checkouts.ts` holds the bound), the grant suffix is
 * 4, and the prefix is 6, so the worst case is exactly 128. A test asserts it, so
 * a longer checkout id cannot silently drop every Pro event.
 */
export const maxPilotEventIdLength = 128;

type Bindings = {
  DB: SecurityDatabase;
  PUBLIC_SITE_ORIGIN?: string;
  CSRF_HMAC_SECRET?: string;
  PILOT_EVENTS_ENABLED?: string;
  PILOT_SERVER_EVENTS_ENABLED?: string;
};

type Variables = {
  requestId: string;
  consentSessionId: string;
};

type PilotContext = Context<{ Bindings: Bindings; Variables: Variables }>;

interface Configuration {
  origin: string;
  consentSecret: Uint8Array;
}

function readConfiguration(bindings: Bindings): Configuration | null {
  if (!bindings.PUBLIC_SITE_ORIGIN || !bindings.CSRF_HMAC_SECRET) return null;
  let url: URL;
  try {
    url = new URL(bindings.PUBLIC_SITE_ORIGIN);
  } catch {
    return null;
  }
  const secret = new TextEncoder().encode(bindings.CSRF_HMAC_SECRET);
  if (
    url.protocol !== "https:" ||
    url.origin !== bindings.PUBLIC_SITE_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    secret.byteLength < 32
  ) {
    return null;
  }
  return { origin: bindings.PUBLIC_SITE_ORIGIN, consentSecret: secret };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function pilotConsentSignature(
  sessionId: string,
  grantedAt: number,
  secret: Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = `${pilotConsentPurpose}\n${sessionId}\n${grantedAt}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      toArrayBuffer(new TextEncoder().encode(payload)),
    ),
  );
  return base64Url(signature);
}

/**
 * The value of a `pilot_consent` cookie: `v1.<sessionId>.<grantedAt>.<HMAC>`.
 *
 * No route calls this in 5B. It is exported so the tests mint a cookie the
 * verifier accepts rather than hand-rolling a format, and so 5D's issuer has one
 * implementation to call instead of a second one to keep in step.
 */
export async function createPilotConsentCookieValue(input: {
  sessionId: string;
  grantedAt: number;
  secret: Uint8Array;
}): Promise<string> {
  const signature = await pilotConsentSignature(
    input.sessionId,
    input.grantedAt,
    input.secret,
  );
  return `v1.${input.sessionId}.${input.grantedAt}.${signature}`;
}

export interface PilotConsent {
  sessionId: string;
  grantedAt: number;
}

/**
 * Verify a consent cookie. Anything unexpected is "consent not given": a missing
 * cookie, a malformed value, a signature that does not match, a `grantedAt` in
 * the future, or one older than the 180-day lifetime the owner approved.
 *
 * The signature is compared in constant time; the failure direction is always
 * "record nothing", never "record anyway".
 */
export async function readPilotConsent(
  cookieHeader: string | null,
  secret: Uint8Array,
  now: number,
): Promise<PilotConsent | null> {
  if (!cookieHeader) return null;
  const matches = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${pilotConsentCookieName}=`));
  if (matches.length !== 1) return null;
  const raw = matches[0]!.slice(pilotConsentCookieName.length + 1);

  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const [version, sessionId, grantedAtRaw, signature] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (version !== "v1") return null;
  // The session id has to fit the column 0021 defines, or the write would be
  // refused by storage instead of here.
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(sessionId)) return null;
  if (!/^\d{1,15}$/.test(grantedAtRaw)) return null;
  const grantedAt = Number(grantedAtRaw);
  if (!Number.isSafeInteger(grantedAt) || grantedAt <= 0) return null;
  if (grantedAt > now) return null;
  if (grantedAt <= now - pilotConsentMaxAgeMs) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;

  const expected = await pilotConsentSignature(sessionId, grantedAt, secret);
  if (!constantTimeEqual(signature, expected)) return null;
  return { sessionId, grantedAt };
}

export type PilotEventWriteOutcome =
  | "recorded"
  | "duplicate"
  | "rate-limited"
  | "dropped";

export interface PilotEventRow {
  source: "browser" | "server";
  eventId: string;
  eventName: string;
  occurredAt: number;
  receivedAt: number;
  consent: "granted" | "not-required";
  anonymousSessionId: string | null;
  examId?: string | null;
  examVersion?: number | null;
  sampleId?: string | null;
  orderId?: string | null;
  productId?: string | null;
  providerEventId?: string | null;
  currency?: string | null;
  amountMinor?: number | null;
  resultBand?: string | null;
  questionCountBand?: string | null;
}

/**
 * One insert for both sources.
 *
 * `ON CONFLICT (source, event_id) DO NOTHING` is the dedupe; the rate limit is a
 * predicate inside the same statement rather than a read-then-write, so a burst
 * cannot slip between the count and the insert. A NULL session (a server row)
 * counts zero rows and is never limited.
 */
const insertPilotEventSql = `INSERT INTO pilot_events (
   source, event_id, event_name, schema_version, occurred_at, received_at,
   consent, anonymous_session_id, exam_id, exam_version, sample_id, order_id,
   product_id, provider_event_id, currency, amount_minor, result_band,
   question_count_band
 )
 SELECT ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
 WHERE (
   SELECT COUNT(*) FROM pilot_events
   WHERE anonymous_session_id = ?
     AND received_at > ?
 ) < ?
 ON CONFLICT (source, event_id) DO NOTHING
 RETURNING event_id`;

function bindPilotEvent(
  database: SecurityDatabase,
  row: PilotEventRow,
  now: number,
) {
  return database
    .prepare(insertPilotEventSql)
    .bind(
      row.source,
      row.eventId,
      row.eventName,
      row.occurredAt,
      row.receivedAt,
      row.consent,
      row.anonymousSessionId,
      row.examId ?? null,
      row.examVersion ?? null,
      row.sampleId ?? null,
      row.orderId ?? null,
      row.productId ?? null,
      row.providerEventId ?? null,
      row.currency ?? null,
      row.amountMinor ?? null,
      row.resultBand ?? null,
      row.questionCountBand ?? null,
      row.anonymousSessionId,
      now - pilotEventRateWindowMs,
      pilotEventRateLimit,
    );
}

/**
 * Log one line for a dropped write. Never the body, the cookie, an IP, a user
 * agent or a value: the source, the event name, the outcome and `error.name`.
 */
function logDroppedWrite(row: PilotEventRow, error: unknown): void {
  console.error("Pilot event dropped", {
    source: row.source,
    eventName: row.eventName,
    outcome: "dropped",
    name: error instanceof Error ? error.name : "UnknownError",
  });
}

async function browserEventExists(
  database: SecurityDatabase,
  eventId: string,
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT 1 AS found FROM pilot_events
       WHERE source = 'browser' AND event_id = ?`,
    )
    .bind(eventId)
    .first<{ found: number }>();
  return row !== null;
}

/**
 * Write one browser event.
 *
 * Returns `duplicate` when nothing was inserted because the id is already stored,
 * `rate-limited` when the session's window is full, and `dropped` when storage
 * refused the write (a bug or an outage). It never throws: the learner's page is
 * not waiting on this to succeed, and a failure is answered, not propagated.
 */
export async function recordBrowserPilotEvent(
  database: SecurityDatabase,
  row: PilotEventRow,
  now: number,
): Promise<PilotEventWriteOutcome> {
  let inserted = false;
  try {
    const result = await bindPilotEvent(database, row, now).all<{
      event_id: string;
    }>();
    inserted = result.results.length === 1;
  } catch (error) {
    // An abort here is either the append-only guard (the same id with different
    // content) or a constraint the route should have prevented; both are
    // answered from what storage holds, never by writing again.
    logDroppedWrite(row, error);
    if (await browserEventExists(database, row.eventId)) return "duplicate";
    return "dropped";
  }
  if (inserted) return "recorded";
  // No row: the id was already stored (the conflict clause) or the rate-limit
  // predicate suppressed the insert. Storage decides which.
  return (await browserEventExists(database, row.eventId))
    ? "duplicate"
    : "rate-limited";
}

/** The three server-originated facts 5B can name. */
export type PilotServerEvent =
  | {
      name: "checkout_started";
      checkoutId: string;
      productId: string;
      currency: string;
      amountMinor: number;
      occurredAt: number;
    }
  | {
      name: "purchase_confirmed";
      checkoutId: string;
      productId: string;
      currency: string;
      amountMinor: number;
      providerEventId: string;
      occurredAt: number;
    }
  | {
      name: "pro_activated";
      checkoutId: string;
      productId: string;
      certificationId: string;
      grantOperationId: string;
      occurredAt: number;
    };

export type PilotEventRecorder = {
  record(
    event: PilotServerEvent,
    receivedAt: number,
  ): Promise<{ recorded: boolean }>;
};

/**
 * Record one server event without ever failing the caller.
 *
 * The recorder this module builds already catches its own storage errors; this
 * wrapper is what makes "an event never blocks a learner action" hold even if a
 * future recorder implementation throws. A `null` recorder (the flag off) returns
 * before anything is built.
 */
export async function recordSafely(
  events: PilotEventRecorder | null | undefined,
  event: PilotServerEvent,
  receivedAt: number,
): Promise<void> {
  if (!events) return;
  try {
    await events.record(event, receivedAt);
  } catch {
    // Deliberately silent here: the recorder logs one line for a storage failure,
    // and a failure it did not log is still not the learner's problem.
  }
}

/** The deterministic `(source, event_id)` for a server fact. */
export function pilotServerEventId(event: PilotServerEvent): string {  switch (event.name) {
    case "checkout_started":
      return `checkout:${event.checkoutId}`;
    case "purchase_confirmed":
      return `settlement:${event.providerEventId}`;
    case "pro_activated":
      return `grant:${event.grantOperationId}`;
  }
}

function toPilotEventRow(
  event: PilotServerEvent,
  receivedAt: number,
): PilotEventRow {
  switch (event.name) {
    case "checkout_started":
      return {
        source: "server",
        eventId: pilotServerEventId(event),
        eventName: event.name,
        occurredAt: event.occurredAt,
        receivedAt,
        consent: "not-required",
        anonymousSessionId: null,
        orderId: event.checkoutId,
        productId: event.productId,
        currency: event.currency,
        amountMinor: event.amountMinor,
      };
    case "purchase_confirmed":
      return {
        source: "server",
        eventId: pilotServerEventId(event),
        eventName: event.name,
        occurredAt: event.occurredAt,
        receivedAt,
        consent: "not-required",
        anonymousSessionId: null,
        orderId: event.checkoutId,
        productId: event.productId,
        providerEventId: event.providerEventId,
        currency: event.currency,
        amountMinor: event.amountMinor,
      };
    case "pro_activated":
      return {
        source: "server",
        eventId: pilotServerEventId(event),
        eventName: event.name,
        occurredAt: event.occurredAt,
        receivedAt,
        consent: "not-required",
        anonymousSessionId: null,
        examId: event.certificationId,
        productId: event.productId,
        orderId: event.checkoutId,
      };
  }
}

/**
 * The server-originated recorder, or `null` when the flag is not the exact string
 * "true". A null recorder is skipped before any statement is built, so flag off
 * means "no statements, no writes, no log lines" rather than "a write that
 * fails".
 */
export function createPilotEventRecorder(bindings: {
  DB: SecurityDatabase;
  PILOT_SERVER_EVENTS_ENABLED?: string;
}): PilotEventRecorder | null {
  if (bindings.PILOT_SERVER_EVENTS_ENABLED !== "true") return null;
  return {
    async record(event, receivedAt) {
      const row = toPilotEventRow(event, receivedAt);
      try {
        const result = await bindPilotEvent(bindings.DB, row, receivedAt).all<{
          event_id: string;
        }>();
        return { recorded: result.results.length === 1 };
      } catch (error) {
        // The learner action this sits beside has already committed; the loss is
        // visible as `eventGap` in the funnel rather than as a failed purchase.
        logDroppedWrite(row, error);
        return { recorded: false };
      }
    },
  };
}

// Derived from the contract enums so the wire vocabulary and the classification
// below cannot drift apart.
const browserEventNames: readonly string[] = pilotBrowserEventNameSchema.options;
const dictionaryNames: readonly string[] = pilotEventNameSchema.options;

function setPrivateHeaders(context: PilotContext): void {
  context.header("Cache-Control", "private, no-store, max-age=0");
  context.header("Pragma", "no-cache");
  context.header("X-Robots-Tag", "noindex, nofollow");
  context.header("X-Request-Id", context.get("requestId"));
}

function errorResponse(
  context: PilotContext,
  status: 400 | 405 | 413 | 415 | 429 | 500 | 503,
  code: PilotEventErrorCode,
): Response {
  // The body is validated against the published contract, not assembled by
  // hand: a code or shape the contract does not define fails here instead of
  // reaching a caller.
  return context.json(
    pilotEventErrorSchema.parse({
      error: { code, requestId: context.get("requestId") },
    }),
    status,
  );
}

async function readJson(
  context: PilotContext,
): Promise<{ value: unknown } | { response: Response }> {
  const contentType = context.req.header("Content-Type")?.trim().toLowerCase();
  if (
    contentType !== "application/json" &&
    contentType !== "application/json; charset=utf-8"
  ) {
    return { response: errorResponse(context, 415, "unsupported_media_type") };
  }
  const declared = context.req.header("Content-Length");
  if (declared !== undefined) {
    if (!/^\d+$/.test(declared)) {
      return { response: errorResponse(context, 400, "validation_error") };
    }
    if (Number(declared) > maxPilotEventBytes) {
      return { response: errorResponse(context, 413, "payload_too_large") };
    }
  }
  const body = context.req.raw.body;
  if (!body) return { response: errorResponse(context, 400, "validation_error") };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > maxPilotEventBytes) {
      await reader.cancel();
      return { response: errorResponse(context, 413, "payload_too_large") };
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    };
  } catch {
    return { response: errorResponse(context, 400, "validation_error") };
  }
}

/**
 * `POST /api/events` - the page-level browser event endpoint.
 *
 * Mounted as its own Hono app in `createApi`, not inside the commerce or learner
 * routers: it has no session and no CSRF token, and no session middleware may
 * grow a branch that decides otherwise.
 *
 * Gate order, fail-closed: flag, configuration, Origin, consent, body. The
 * consent check runs before a byte of the body is read, so an unconsented request
 * costs one HMAC and writes nothing.
 */
export function createPilotEventsApi(now: () => number = Date.now) {
  const api = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  api.use("*", async (context, next) => {
    context.set("requestId", crypto.randomUUID());
    setPrivateHeaders(context);

    if (context.env.PILOT_EVENTS_ENABLED !== "true") {
      return errorResponse(context, 503, "pilot_events_disabled");
    }
    const configuration = readConfiguration(context.env);
    if (!configuration) {
      return errorResponse(context, 503, "service_unavailable");
    }
    if (
      context.req.header("Origin") !== configuration.origin ||
      new URL(context.req.url).origin !== configuration.origin
    ) {
      return errorResponse(context, 400, "invalid_origin");
    }
    // A method other than POST has no body to gate and is answered by the route
    // below; asking for consent first would turn a 405 into a silent 204.
    if (context.req.method === "POST") {
      const consent = await readPilotConsent(
        context.req.header("Cookie") ?? null,
        configuration.consentSecret,
        now(),
      );
      if (!consent) {
        // Nothing written, nothing leaked: the answer is the same whether the
        // cookie is absent, expired, forged or signed for another site.
        return context.body(null, 204);
      }
      context.set("consentSessionId", consent.sessionId);
    }
    await next();
  });

  api.post("/", async (context) => {
    const parsed = await readJson(context);
    if ("response" in parsed) return parsed.response;

    // The name is classified before the strict parse so a caller can tell "no
    // such event" from "that is a server event".
    const name =
      parsed.value !== null &&
      typeof parsed.value === "object" &&
      "name" in parsed.value
        ? (parsed.value as { name: unknown }).name
        : undefined;
    if (typeof name === "string" && !dictionaryNames.includes(name)) {
      return errorResponse(context, 400, "unknown_event");
    }
    if (typeof name === "string" && !browserEventNames.includes(name)) {
      return errorResponse(context, 400, "server_event_name");
    }

    const event = pilotEventRequestSchema.safeParse(parsed.value);
    if (!event.success) {
      return errorResponse(context, 400, "validation_error");
    }

    const receivedAt = now();
    const outcome = await recordBrowserPilotEvent(
      context.env.DB,
      {
        source: "browser",
        eventId: event.data.eventId,
        eventName: event.data.name,
        occurredAt: event.data.occurredAt,
        receivedAt,
        consent: "granted",
        anonymousSessionId: context.get("consentSessionId"),
        examId: event.data.examId ?? null,
        examVersion: event.data.examVersion ?? null,
        sampleId: event.data.sampleId ?? null,
        resultBand: event.data.resultBand ?? null,
      },
      receivedAt,
    );
    switch (outcome) {
      case "recorded":
      case "duplicate": {
        const body: PilotEventAcceptedResponse =
          pilotEventAcceptedResponseSchema.parse({
            received: true,
            duplicate: outcome === "duplicate",
          });
        return context.json(body, 202);
      }
      case "rate-limited":
        return errorResponse(context, 429, "rate_limited");
      case "dropped":
        return errorResponse(context, 500, "internal_error");
    }
  });

  api.all("/", (context) => {
    context.header("Allow", "POST");
    return errorResponse(context, 405, "method_not_allowed");
  });

  api.onError((error, context) => {
    const requestId = context.get("requestId") || crypto.randomUUID();
    context.set("requestId", requestId);
    setPrivateHeaders(context);
    // Same shape as the commerce router: the code and the correlation id, never
    // the body or the cookie.
    console.error("Pilot event request failed", {
      requestId,
      route: `${context.req.method} ${new URL(context.req.url).pathname}`,
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return errorResponse(context, 500, "internal_error");
  });

  return api;
}
