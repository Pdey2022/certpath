import type { Sku } from "../pricing.ts";
import { createFakeProvider } from "./providers/fake.ts";

// The payment provider port.
//
// A learner never has access because a provider said so: access exists because a
// row in `learner_access_grants` exists. The provider's only jobs are to take
// money, to authenticate a raw webhook body, and to refund - so those are the
// only three methods, and no route ever parses a provider header itself.
//
// `verifyEvent` is the whole answer to "webhook authenticity without a real
// provider": a real adapter swaps the fake's HMAC scheme for its own signature
// scheme, and the route, the dedupe and the effect batch do not change.
//
// Rules: docs/decisions/0003-pricing-pro-and-refunds.md and docs/commerce.md.

export type ProviderLine = { sku: Sku; label: string; amountMinor: number };

export type CreateCheckoutInput = {
  /** Our checkout row id. The provider MUST treat this as its idempotency key. */
  checkoutId: string;
  /** Opaque account id. Never an email, never a name. */
  accountRef: string;
  certificationId: string;
  /** Supplied from `pricing.ts`, never a literal. */
  currency: string;
  lines: readonly ProviderLine[];
  totalMinor: number;
  successUrl: string;
  cancelUrl: string;
  /** Epoch ms. The provider session must not outlive it. */
  expiresAt: number;
};

export type ProviderCheckoutSession = {
  sessionRef: string;
  redirectUrl: string;
  expiresAt: number;
};

export type ProviderEvent = {
  /** Unique at the provider. */
  eventId: string;
  kind: "checkout.completed" | "checkout.failed";
  sessionRef: string;
  /** Our echo; null when it does not parse. */
  checkoutId: string | null;
  amountMinor: number;
  currency: string;
  occurredAt: number;
};

export type VerifyResult =
  | { ok: true; event: ProviderEvent }
  | { ok: false; reason: "invalid-signature" | "stale" | "malformed" };

export type RefundRequest = {
  /** Our id, which the adapter treats as its idempotency key. */
  refundId: string;
  payments: readonly { sessionRef: string; amountMinor: number }[];
  totalMinor: number;
  currency: string;
  reason: string;
};

export type RefundResult =
  | { status: "succeeded"; refundRef: string }
  /** `reason` is a code, never free text from the provider. */
  | { status: "failed" | "rejected"; reason: string };

export interface PaymentProvider {
  /** "fake" | "none" | a real adapter name. Matches the webhook path segment. */
  readonly name: string;
  /** False for every adapter that cannot move real money. */
  readonly live: boolean;
  createCheckout(input: CreateCheckoutInput): Promise<ProviderCheckoutSession>;
  /**
   * Authenticates a raw body. MUST NOT throw on a hostile body or a missing
   * header.
   */
  verifyEvent(
    rawBody: string,
    headers: Headers,
    now: number,
  ): Promise<VerifyResult>;
  refund(input: RefundRequest): Promise<RefundResult>;
}

export type PaymentProviderBindings = {
  PAYMENT_PROVIDER?: string;
  COMMERCE_WEBHOOK_SECRET?: string;
  /** Base for the fake adapter's redirect URL. Never a secret. */
  PUBLIC_SITE_ORIGIN?: string;
};

/** The webhook secret must be at least 32 bytes of configured material. */
export const minimumWebhookSecretBytes = 32;

/**
 * `null` when nothing is configured: every commerce route answers 503.
 *
 * The fake adapter is returned **only** for `PAYMENT_PROVIDER === "fake"` with a
 * secret of at least 32 bytes. Any other value - including a typo - returns
 * null, so there is no code path where an unknown string silently becomes
 * "fake".
 */
export function resolvePaymentProvider(
  bindings: PaymentProviderBindings,
  now: () => number,
): PaymentProvider | null {
  if (bindings.PAYMENT_PROVIDER !== "fake") return null;
  const secret = bindings.COMMERCE_WEBHOOK_SECRET;
  if (secret === undefined) return null;
  if (new TextEncoder().encode(secret).byteLength < minimumWebhookSecretBytes) {
    return null;
  }
  return createFakeProvider({
    secret,
    now,
    // An unset PUBLIC_SITE_ORIGIN yields a relative redirect URL from the fake
    // adapter. That fallback stays for local use, but PR B must treat an unset
    // origin as a `503` on every commerce route rather than serve a relative
    // checkout URL: a provider redirect is an absolute URL by definition.
    origin: bindings.PUBLIC_SITE_ORIGIN ?? "",
  });
}
