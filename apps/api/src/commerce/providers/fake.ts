import { constantTimeEqual } from "../../security/http-session.ts";
import type {
  CreateCheckoutInput,
  PaymentProvider,
  ProviderCheckoutSession,
  ProviderEvent,
  RefundRequest,
  RefundResult,
  VerifyResult,
} from "../provider.ts";

// The fake provider: tests and local development only.
//
// It moves no money by construction (`live: false`), it takes no card data, and
// its webhook authenticity is a plain HMAC over `t.body` with a 300-second
// replay window. Tests sign events with `signEvent` and never hand-build a
// signature, so a scheme change updates the tests through the adapter.
//
// `verifyEvent` is deliberately total: a hostile body, a missing header, a
// non-numeric timestamp or a truncated hex digest all return a `VerifyResult`
// rather than throwing, because the webhook route must answer a status code and
// not a 500.
//
// Rules: docs/commerce.md.

export const fakeSignatureHeader = "X-CertPath-Signature";
export const fakeReplayWindowSeconds = 300;

export interface FakePaymentProvider extends PaymentProvider {
  /**
   * The header set for `event`, signed at `nowSeconds`. The request body must be
   * exactly `JSON.stringify(event)`, which is what the signature covers.
   */
  signEvent(
    event: ProviderEvent,
    nowSeconds: number,
  ): Promise<Record<string, string>>;
  /**
   * The same scheme over an arbitrary raw body, so a test can prove that a
   * correctly-signed but unusable body is answered `malformed` rather than
   * `invalid-signature` without hand-building a digest.
   */
  signRawBody(
    rawBody: string,
    nowSeconds: number,
  ): Promise<Record<string, string>>;
}

export type FakeProviderOptions = {
  /** At least 32 bytes, supplied by `resolvePaymentProvider`. */
  secret: string;
  now: () => number;
  /** Base for the fake pay-page URL. */
  origin: string;
  /** Defaults to a successful refund. */
  refundOutcome?: RefundResult;
};

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );
  return hex(new Uint8Array(signature));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEvent(rawBody: string): ProviderEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { eventId, kind, sessionRef, checkoutId, amountMinor, currency, occurredAt } =
    value;
  if (typeof eventId !== "string" || eventId.length === 0 || eventId.length > 128) {
    return null;
  }
  if (kind !== "checkout.completed" && kind !== "checkout.failed") return null;
  if (
    typeof sessionRef !== "string" ||
    sessionRef.length === 0 ||
    sessionRef.length > 128
  ) {
    return null;
  }
  if (checkoutId !== null && (typeof checkoutId !== "string" || checkoutId.length > 128)) {
    return null;
  }
  if (!Number.isSafeInteger(amountMinor) || (amountMinor as number) < 0) {
    return null;
  }
  if (typeof currency !== "string" || currency.length !== 3) return null;
  if (!Number.isSafeInteger(occurredAt)) return null;
  return {
    eventId,
    kind,
    sessionRef,
    checkoutId: checkoutId as string | null,
    amountMinor: amountMinor as number,
    currency,
    occurredAt: occurredAt as number,
  };
}

export function createFakeProvider(
  options: FakeProviderOptions,
): FakePaymentProvider {
  // The fake remembers the sessions it handed out so a retried `createCheckout`
  // with the same checkout id returns the same session, exactly as a real
  // adapter keyed on our id would.
  const sessions = new Map<string, ProviderCheckoutSession>();

  const signRawBody = async (
    rawBody: string,
    nowSeconds: number,
  ): Promise<Record<string, string>> => {
    const timestamp = String(Math.trunc(nowSeconds));
    const signature = await hmacSha256(
      options.secret,
      `${timestamp}.${rawBody}`,
    );
    return {
      [fakeSignatureHeader]: `t=${timestamp},v1=${signature}`,
      "Content-Type": "application/json",
    };
  };

  return {
    name: "fake",
    live: false,

    async createCheckout(
      input: CreateCheckoutInput,
    ): Promise<ProviderCheckoutSession> {
      const existing = sessions.get(input.checkoutId);
      if (existing) {
        return { ...existing, expiresAt: input.expiresAt };
      }
      const session: ProviderCheckoutSession = {
        sessionRef: `fake_${input.checkoutId}`,
        redirectUrl:
          `${options.origin}/commerce/fake-pay?checkout=` +
          encodeURIComponent(input.checkoutId),
        expiresAt: input.expiresAt,
      };
      sessions.set(input.checkoutId, session);
      return session;
    },

    signEvent(event: ProviderEvent, nowSeconds: number) {
      return signRawBody(JSON.stringify(event), nowSeconds);
    },

    signRawBody,

    async verifyEvent(
      rawBody: string,
      headers: Headers,
      now: number,
    ): Promise<VerifyResult> {
      try {
        const header = headers.get(fakeSignatureHeader);
        if (!header || header.length > 512) {
          return { ok: false, reason: "invalid-signature" };
        }
        const fields = new Map<string, string>();
        for (const segment of header.split(",")) {
          const separator = segment.indexOf("=");
          if (separator <= 0) {
            return { ok: false, reason: "invalid-signature" };
          }
          const name = segment.slice(0, separator).trim();
          if (fields.has(name)) {
            return { ok: false, reason: "invalid-signature" };
          }
          fields.set(name, segment.slice(separator + 1).trim());
        }
        const timestamp = fields.get("t");
        const provided = fields.get("v1");
        if (
          timestamp === undefined ||
          provided === undefined ||
          !/^\d{1,15}$/.test(timestamp) ||
          !/^[0-9a-f]{64}$/.test(provided)
        ) {
          return { ok: false, reason: "invalid-signature" };
        }
        const expected = await hmacSha256(
          options.secret,
          `${timestamp}.${rawBody}`,
        );
        if (!constantTimeEqual(provided, expected)) {
          return { ok: false, reason: "invalid-signature" };
        }
        if (
          Math.abs(Math.floor(now / 1000) - Number(timestamp)) >
          fakeReplayWindowSeconds
        ) {
          return { ok: false, reason: "stale" };
        }
        const event = parseEvent(rawBody);
        return event
          ? { ok: true, event }
          : { ok: false, reason: "malformed" };
      } catch {
        // Total by construction: a hostile body is a `malformed` answer, never
        // an exception the route has to turn into a 500.
        return { ok: false, reason: "malformed" };
      }
    },

    async refund(input: RefundRequest): Promise<RefundResult> {
      return (
        options.refundOutcome ?? {
          status: "succeeded",
          refundRef: `fake_refund_${input.refundId}`,
        }
      );
    },
  };
}
