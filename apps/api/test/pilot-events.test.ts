import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/index.ts";
import {
  createPilotConsentCookieValue,
  createPilotEventRecorder,
  maxPilotEventBytes,
  maxPilotEventIdLength,
  pilotConsentCookieName,
  pilotConsentMaxAgeMs,
  pilotEventRateLimit,
} from "../src/analytics/pilot-events.ts";
import type { SecurityDatabase } from "../src/security/database.ts";

// `POST /api/events`: the gate order, the consent matrix, the dedupe, the rate
// limit and the inertness of the endpoint with the flag off.
//
// The cookie is minted with the same helper the verifier uses (and 5D's issuer
// will use), so this file cannot pass by agreeing with a private format of its
// own. Nothing here sends a session id, an email or a user agent.

const database: SecurityDatabase = env.DB;
const origin = "https://localhost";
const consentSecret = "local-worker-test-consent-secret-with-enough-entropy";
const secret = new TextEncoder().encode(consentSecret);
const clock = Date.parse("2026-02-01T00:00:00.000Z");
const day = 86_400_000;

const application = createApi(fetch, () => clock);

const bindings: {
  DB: SecurityDatabase;
  PUBLIC_SITE_ORIGIN: string;
  CSRF_HMAC_SECRET: string;
  PILOT_EVENTS_ENABLED?: string;
  PILOT_SERVER_EVENTS_ENABLED?: string;
} = {
  DB: database,
  PUBLIC_SITE_ORIGIN: origin,
  CSRF_HMAC_SECRET: consentSecret,
  PILOT_EVENTS_ENABLED: "true",
  PILOT_SERVER_EVENTS_ENABLED: "false",
};

type TestBindings = typeof bindings;

async function countPilotEvents(): Promise<number> {
  const row = await database
    .prepare("SELECT COUNT(*) AS rows FROM pilot_events")
    .first<{ rows: number }>();
  return row?.rows ?? -1;
}

function newSessionId(): string {
  return `s_${crypto.randomUUID().replaceAll("-", "_")}`;
}

async function consentCookie(
  options: { sessionId?: string; grantedAt?: number; key?: Uint8Array } = {},
): Promise<{ sessionId: string; cookie: string }> {
  const sessionId = options.sessionId ?? newSessionId();
  const value = await createPilotConsentCookieValue({
    sessionId,
    grantedAt: options.grantedAt ?? clock - 1_000,
    secret: options.key ?? secret,
  });
  return { sessionId, cookie: `${pilotConsentCookieName}=${value}` };
}

function eventBody(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt_${crypto.randomUUID()}`,
    schemaVersion: 1,
    name: "exam_viewed",
    occurredAt: clock - 1_000,
    examId: "cissp",
    examVersion: 4,
    ...overrides,
  };
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  bindings?: TestBindings;
}

function call(
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  return Promise.resolve(
    application.fetch(
      new Request(`${origin}${path}`, {
        method: options.method ?? "POST",
        headers: { Origin: origin, ...options.headers },
        body: options.body,
      }),
      options.bindings ?? bindings,
    ),
  );
}

function postEvent(
  body: unknown,
  options: { cookie?: string; headers?: Record<string, string>; bindings?: TestBindings } = {},
): Promise<Response> {
  return call("/api/events", {
    headers: {
      "Content-Type": "application/json",
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...options.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    bindings: options.bindings,
  });
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? "(none)";
}

describe("the endpoint is inert with the flag off", () => {
  it("answers 503 and writes nothing, even with a valid consent cookie", async () => {
    const before = await countPilotEvents();
    const { cookie } = await consentCookie();

    const response = await postEvent(eventBody(), {
      cookie,
      bindings: { ...bindings, PILOT_EVENTS_ENABLED: "false" },
    });

    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("pilot_events_disabled");
    expect(await countPilotEvents()).toBe(before);
  });

  it("treats an absent flag binding as off, and invents no row", async () => {
    const before = await countPilotEvents();
    const { cookie } = await consentCookie();
    const { PILOT_EVENTS_ENABLED: _omitted, ...withoutFlag } = bindings;

    const response = await postEvent(eventBody(), {
      cookie,
      bindings: withoutFlag,
    });

    expect(response.status).toBe(503);
    expect(await countPilotEvents()).toBe(before);
  });

  it("answers 503 when the origin or the HMAC secret is unusable", async () => {
    const before = await countPilotEvents();
    const { cookie } = await consentCookie();

    const response = await postEvent(eventBody(), {
      cookie,
      bindings: { ...bindings, CSRF_HMAC_SECRET: "" },
    });

    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("service_unavailable");
    expect(await countPilotEvents()).toBe(before);
  });
});

describe("consent is a signed cookie, and its absence writes nothing", () => {
  it("answers 204 with no body when the cookie is absent", async () => {
    const before = await countPilotEvents();

    const response = await postEvent(eventBody());

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(await countPilotEvents()).toBe(before);
  });

  it("answers 204 when the cookie has expired (older than the 180-day lifetime)", async () => {
    const before = await countPilotEvents();
    const { cookie } = await consentCookie({
      grantedAt: clock - pilotConsentMaxAgeMs - 1,
    });

    const response = await postEvent(eventBody(), { cookie });

    expect(response.status).toBe(204);
    expect(await countPilotEvents()).toBe(before);
  });

  it("answers 204 when the browser cleared the cookie (the withdrawal path)", async () => {
    const before = await countPilotEvents();
    // `Max-Age=0` is a deletion; the browser sends no `pilot_consent` at all.
    const response = await postEvent(eventBody(), {
      headers: { Cookie: `${pilotConsentCookieName}=; Max-Age=0` },
    });

    expect(response.status).toBe(204);
    expect(await countPilotEvents()).toBe(before);
  });

  it("answers 204 when the signature does not verify", async () => {
    const before = await countPilotEvents();
    const { sessionId } = await consentCookie();
    const tampered = await createPilotConsentCookieValue({
      sessionId,
      grantedAt: clock - 1_000,
      secret: new TextEncoder().encode(
        "a-different-secret-with-enough-entropy-for-hmac",
      ),
    });

    const response = await postEvent(eventBody(), {
      cookie: `${pilotConsentCookieName}=${tampered}`,
    });

    expect(response.status).toBe(204);
    expect(await countPilotEvents()).toBe(before);
  });

  it("answers 204 when grantedAt is in the future", async () => {
    const before = await countPilotEvents();
    const { cookie } = await consentCookie({ grantedAt: clock + 60_000 });

    const response = await postEvent(eventBody(), { cookie });

    expect(response.status).toBe(204);
    expect(await countPilotEvents()).toBe(before);
  });

  it("answers 204 when the cookie is malformed", async () => {
    const before = await countPilotEvents();

    for (const value of ["v1", "v2.abc.123.xyz", "v1.short.123.sig", "nonsense"]) {
      const response = await postEvent(eventBody(), {
        cookie: `${pilotConsentCookieName}=${value}`,
      });
      expect(response.status, value).toBe(204);
    }
    expect(await countPilotEvents()).toBe(before);
  });

  it("records one consented row when the cookie verifies", async () => {
    const { sessionId, cookie } = await consentCookie();
    const body = eventBody();

    const response = await postEvent(body, { cookie });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      received: true,
      duplicate: false,
    });
    const row = await database
      .prepare(
        `SELECT source, event_name, consent, anonymous_session_id, exam_id,
                exam_version, occurred_at, received_at
         FROM pilot_events WHERE event_id = ?`,
      )
      .bind(body.eventId)
      .first<{
        source: string;
        event_name: string;
        consent: string;
        anonymous_session_id: string | null;
        exam_id: string | null;
        exam_version: number | null;
        occurred_at: number;
        received_at: number;
      }>();
    expect(row).toEqual({
      source: "browser",
      event_name: "exam_viewed",
      consent: "granted",
      anonymous_session_id: sessionId,
      exam_id: "cissp",
      exam_version: 4,
      occurred_at: body.occurredAt,
      received_at: clock,
    });
  });

  it("sets the private, non-indexable headers and a request id", async () => {
    const { cookie } = await consentCookie();
    const response = await postEvent(eventBody(), { cookie });

    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(response.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sets them on a refusal too, so a cache cannot keep a 204 or a 503", async () => {
    const response = await postEvent(eventBody());

    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });
});

describe("the request shape is the contract", () => {
  it("refuses a name outside the dictionary with unknown_event", async () => {
    const { cookie } = await consentCookie();
    const before = await countPilotEvents();

    const response = await postEvent(
      eventBody({ name: "made_up_event" }),
      { cookie },
    );

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("unknown_event");
    expect(await countPilotEvents()).toBe(before);
  });

  it("refuses a server fact from a browser with server_event_name", async () => {
    const { cookie } = await consentCookie();
    const before = await countPilotEvents();

    for (const name of [
      "purchase_confirmed",
      "checkout_started",
      "pro_activated",
      "signup_completed",
    ]) {
      const response = await postEvent(eventBody({ name }), { cookie });
      expect(response.status, name).toBe(400);
      expect(await errorCode(response), name).toBe("server_event_name");
    }
    expect(await countPilotEvents()).toBe(before);
  });

  it("refuses extra, missing and mistyped fields with validation_error", async () => {
    const { cookie } = await consentCookie();
    const before = await countPilotEvents();

    const invalid = [
      // No field exists for an address; `.strict()` refuses one that arrives.
      eventBody({ email: "learner@example.test" }),
      eventBody({ sessionId: newSessionId() }),
      eventBody({ sampleId: "sample-1" }),
      eventBody({ name: "sample_completed", sampleId: "sample-1", resultBand: "hello" }),
      eventBody({ eventId: "short" }),
      eventBody({ eventId: "x y zzzzz" }),
      eventBody({ schemaVersion: 2 }),
      eventBody({ occurredAt: -1 }),
      eventBody({ examId: "a@b.com" }),
      eventBody({ name: "sample_started" }),
      { name: "exam_viewed" },
    ];

    for (const body of invalid) {
      const response = await postEvent(body, { cookie });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await errorCode(response), JSON.stringify(body)).toBe(
        "validation_error",
      );
    }
    expect(await countPilotEvents()).toBe(before);
  });

  it("refuses a request from another origin before reading the body", async () => {
    const { cookie } = await consentCookie();
    const response = await call("/api/events", {
      headers: {
        Origin: "https://evil.example",
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify(eventBody()),
    });

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_origin");
  });

  it("answers 415 for a non-JSON content type", async () => {
    const { cookie } = await consentCookie();
    const response = await postEvent(eventBody(), {
      cookie,
      headers: { "Content-Type": "text/plain" },
    });

    expect(response.status).toBe(415);
    expect(await errorCode(response)).toBe("unsupported_media_type");
  });

  it("answers 413 at the 4 KiB cap and again when Content-Length lies", async () => {
    const { cookie } = await consentCookie();
    const before = await countPilotEvents();
    const oversized = JSON.stringify(
      eventBody({ padding: "x".repeat(maxPilotEventBytes) }),
    );

    const declared = await postEvent(oversized, { cookie });
    expect(declared.status).toBe(413);
    expect(await errorCode(declared)).toBe("payload_too_large");

    const eightKib = JSON.stringify(eventBody({ padding: "x".repeat(8 * 1024) }));
    const streamed = await postEvent(eightKib, {
      cookie,
      headers: { "Content-Length": "10" },
    });
    expect(streamed.status).toBe(413);
    expect(await countPilotEvents()).toBe(before);
  });

  it("answers 405 for every method but POST", async () => {
    const { cookie } = await consentCookie();
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const response = await call("/api/events", {
        method,
        headers: { Cookie: cookie },
      });
      expect(response.status, method).toBe(405);
      expect(response.headers.get("Allow"), method).toBe("POST");
    }
  });
});

describe("dedupe and the rate limit", () => {
  it("collapses a resubmitted id into one row and reports duplicate", async () => {
    const { cookie } = await consentCookie();
    const body = eventBody();

    const first = await postEvent(body, { cookie });
    const second = await postEvent(body, { cookie });

    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ received: true, duplicate: false });
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ received: true, duplicate: true });

    const rows = await database
      .prepare("SELECT COUNT(*) AS rows FROM pilot_events WHERE event_id = ?")
      .bind(body.eventId)
      .first<{ rows: number }>();
    expect(rows?.rows).toBe(1);
  });

  it("reports changes = 0 for the ON CONFLICT DO NOTHING no-op", async () => {
    // The design flagged this as unconfirmed: the `duplicate` answer depends on
    // the no-op being observable. D1 reports zero changed rows and zero returned
    // rows, so the recorder can tell "nothing inserted" from "inserted".
    const { cookie } = await consentCookie();
    const body = eventBody();
    await postEvent(body, { cookie });

    const again = await database
      .prepare(
        `INSERT INTO pilot_events
         SELECT * FROM pilot_events WHERE source = 'browser' AND event_id = ?
         ON CONFLICT (source, event_id) DO NOTHING
         RETURNING event_id`,
      )
      .bind(body.eventId)
      .all<{ event_id: string }>();

    expect(again.meta.changes).toBe(0);
    expect(again.results).toHaveLength(0);
  });

  it("gives two concurrent identical submissions one row and two 202s", async () => {
    const { cookie } = await consentCookie();
    const body = eventBody();

    const responses = await Promise.all([
      postEvent(body, { cookie }),
      postEvent(body, { cookie }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    const bodies = await Promise.all(
      responses.map(
        (response) => response.json() as Promise<{ duplicate: boolean }>,
      ),
    );
    expect(bodies.filter((entry) => entry.duplicate)).toHaveLength(1);
    const rows = await database
      .prepare("SELECT COUNT(*) AS rows FROM pilot_events WHERE event_id = ?")
      .bind(body.eventId)
      .first<{ rows: number }>();
    expect(rows?.rows).toBe(1);
  });

  it(`accepts ${pilotEventRateLimit} events a minute and refuses the next with 429`, async () => {
    const { sessionId, cookie } = await consentCookie();

    for (let index = 0; index < pilotEventRateLimit; index += 1) {
      const response = await postEvent(eventBody(), { cookie });
      expect(response.status, `event ${index + 1}`).toBe(202);
    }
    const refused = await postEvent(eventBody(), { cookie });

    expect(refused.status).toBe(429);
    expect(await errorCode(refused)).toBe("rate_limited");
    const rows = await database
      .prepare(
        "SELECT COUNT(*) AS rows FROM pilot_events WHERE anonymous_session_id = ?",
      )
      .bind(sessionId)
      .first<{ rows: number }>();
    expect(rows?.rows).toBe(pilotEventRateLimit);
  });

  it("does not let one session's burst spend another session's budget", async () => {
    const first = await consentCookie();
    const second = await consentCookie();
    for (let index = 0; index < pilotEventRateLimit; index += 1) {
      await postEvent(eventBody(), { cookie: first.cookie });
    }

    const response = await postEvent(eventBody(), { cookie: second.cookie });

    expect(response.status).toBe(202);
  });
});

describe("the deterministic server ids fit the storage budget", () => {
  it("keeps the ids 5B mints inside the 128-character column", () => {
    const longestCheckoutId = "c".repeat(118);
    const longestGrantId = `grant:${longestCheckoutId}:pro`;
    expect(longestGrantId.length).toBe(128);
    expect(longestGrantId.length).toBeLessThanOrEqual(maxPilotEventIdLength);
    expect(`checkout:${longestCheckoutId}`.length).toBe(127);

    // The fake provider mints `fake_completed:<checkoutId>`; a real checkout id
    // is `chk_` + a UUID, so the settlement id is 65 characters.
    const realCheckoutId = `chk_${crypto.randomUUID()}`;
    expect(realCheckoutId.length).toBe(40);
    expect(`settlement:fake_completed:${realCheckoutId}`.length).toBe(66);
  });

  it("drops a provider event id too long for settlement:<id> instead of truncating", async () => {
    // The budget is a property of the provider's id length: 10 + 119 exceeds 128.
    // Storage refuses the row, the recorder logs one line and reports the loss,
    // and nothing is written - no truncated id that could collide.
    expect(`settlement:${"e".repeat(119)}`.length).toBeGreaterThan(
      maxPilotEventIdLength,
    );
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const recorder = createPilotEventRecorder({
        DB: database,
        PILOT_SERVER_EVENTS_ENABLED: "true",
      })!;
      const result = await recorder.record(
        {
          name: "purchase_confirmed",
          checkoutId: "chk_budget",
          productId: "pro-3m",
          currency: "USD",
          amountMinor: 4_900,
          providerEventId: "e".repeat(119),
          occurredAt: clock,
        },
        clock,
      );

      expect(result.recorded).toBe(false);
    } finally {
      console.error = original;
    }

    const rows = await database
      .prepare(
        "SELECT COUNT(*) AS rows FROM pilot_events WHERE event_id LIKE 'settlement:eee%'",
      )
      .first<{ rows: number }>();
    expect(rows?.rows).toBe(0);

    // One line, and it carries no id, no cookie and no body: the source, the
    // event name, the outcome and the error's name only.
    expect(logged).toHaveLength(1);
    expect(logged[0]![1]).toEqual({
      source: "server",
      eventName: "purchase_confirmed",
      outcome: "dropped",
      name: "Error",
    });
  });
});
