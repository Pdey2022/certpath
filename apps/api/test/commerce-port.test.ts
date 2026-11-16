import { describe, expect, it } from "vitest";
import {
  minimumWebhookSecretBytes,
  resolvePaymentProvider,
  type PaymentProvider,
  type ProviderEvent,
  type RefundRequest,
} from "../src/commerce/provider.ts";
import {
  createFakeProvider,
  fakeSignatureHeader,
  type FakePaymentProvider,
} from "../src/commerce/providers/fake.ts";
import { priceList } from "../src/pricing.ts";

// The provider port in isolation: no database, no routes, no bindings.

const secret = "local-commerce-webhook-secret-with-enough-bytes";
const origin = "https://localhost";

const clockMs = 1_763_000_000_000;
const clockSeconds = Math.floor(clockMs / 1000);

const event: ProviderEvent = {
  eventId: "evt_0001",
  kind: "checkout.completed",
  sessionRef: "fake_checkout_0001",
  checkoutId: "checkout_0001",
  amountMinor: priceList["bundle-standard-3m-pro"].amountMinor,
  currency: "USD",
  occurredAt: clockMs,
};

function verify(
  provider: FakePaymentProvider,
  rawBody: string,
  values: Record<string, string>,
  now = clockMs,
) {
  return provider.verifyEvent(rawBody, new Headers(values), now);
}

describe("fake provider signatures", () => {
  const provider = createFakeProvider({ secret, now: () => clockMs, origin });

  it("accepts a body signed by signEvent", async () => {
    const rawBody = JSON.stringify(event);
    const result = await verify(
      provider,
      rawBody,
      await provider.signEvent(event, clockSeconds),
    );
    expect(result).toEqual({ ok: true, event });
  });

  it("rejects a body mutated by one byte", async () => {
    const rawBody = JSON.stringify(event);
    const headers = await provider.signEvent(event, clockSeconds);
    const tampered = rawBody.replace("evt_0001", "evt_0002");
    expect(tampered).not.toBe(rawBody);
    expect(await verify(provider, tampered, headers)).toEqual({
      ok: false,
      reason: "invalid-signature",
    });
  });

  it("rejects a body signed with a different secret", async () => {
    const other = createFakeProvider({
      secret: `${secret}-different`,
      now: () => clockMs,
      origin,
    });
    const rawBody = JSON.stringify(event);
    const headers = await other.signEvent(event, clockSeconds);
    expect(await verify(provider, rawBody, headers)).toEqual({
      ok: false,
      reason: "invalid-signature",
    });
  });

  it("rejects a missing signature header", async () => {
    expect(await verify(provider, JSON.stringify(event), {})).toEqual({
      ok: false,
      reason: "invalid-signature",
    });
  });

  it("rejects a malformed signature header without throwing", async () => {
    for (const header of [
      "",
      "v1=abc",
      "t=123",
      "t=123,v1=not-hex",
      `t=abc,v1=${"0".repeat(64)}`,
      `t=1,v1=${"0".repeat(64)},t=2`,
      "garbage",
      `t=1,v1=${"0".repeat(63)}`,
    ]) {
      const result = await verify(provider, JSON.stringify(event), {
        [fakeSignatureHeader]: header,
      });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a signature older or newer than the 300-second window", async () => {
    const rawBody = JSON.stringify(event);
    const stale = await provider.signEvent(event, clockSeconds - 301);
    const fresh = await provider.signEvent(event, clockSeconds - 299);
    const futureAhead = await provider.signEvent(event, clockSeconds + 301);
    expect(await verify(provider, rawBody, stale)).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(await verify(provider, rawBody, fresh)).toEqual({
      ok: true,
      event,
    });
    expect(await verify(provider, rawBody, futureAhead)).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("reports a correctly signed but unusable body as malformed", async () => {
    for (const rawBody of [
      "not json",
      "{}",
      "[]",
      JSON.stringify({ ...event, eventId: "" }),
      JSON.stringify({ ...event, kind: "checkout.disputed" }),
      JSON.stringify({ ...event, amountMinor: -1 }),
      JSON.stringify({ ...event, currency: "US" }),
      JSON.stringify({ ...event, occurredAt: 1.5 }),
      JSON.stringify({ eventId: "evt_0001" }),
    ]) {
      const headers = await provider.signRawBody(rawBody, clockSeconds);
      expect(await verify(provider, rawBody, headers)).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("never throws on hostile input", async () => {
    const hostile = [
      "",
      "\u0000",
      "{",
      "}{",
      "null",
      `{${'\"a\":'.repeat(500)}1}`,
      "x".repeat(10_000),
      JSON.stringify({ ...event, eventId: "x".repeat(129) }),
    ];
    for (const rawBody of hostile) {
      for (const values of [
        {} as Record<string, string>,
        { [fakeSignatureHeader]: "not-a-signature" },
        { [fakeSignatureHeader]: `t=0,v1=${"f".repeat(64)}` },
        { [fakeSignatureHeader]: `t=99999999999999999999,v1=${"f".repeat(64)}` },
        { [fakeSignatureHeader]: "y".repeat(600) },
      ]) {
        const result = await verify(provider, rawBody, values);
        expect(result.ok).toBe(false);
      }
    }
    // A hostile body that is signed correctly is answered, not thrown.
    const signedHostile = await provider.signRawBody("\u0000{", clockSeconds);
    expect(await verify(provider, "\u0000{", signedHostile)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("fake provider checkout and refund", () => {
  const provider = createFakeProvider({ secret, now: () => clockMs, origin });

  const checkout = {
    checkoutId: "checkout_0001",
    accountRef: "user_0001",
    certificationId: "cert_0001",
    currency: "USD",
    lines: [
      {
        sku: "standard-3m" as const,
        label: priceList["standard-3m"].label,
        amountMinor: priceList["standard-3m"].amountMinor,
      },
    ],
    totalMinor: priceList["standard-3m"].amountMinor,
    successUrl: `${origin}/commerce/return`,
    cancelUrl: `${origin}/commerce/cancel`,
    expiresAt: clockMs + 30 * 60 * 1000,
  };

  it("is not live and takes no money", () => {
    expect(provider.live).toBe(false);
    expect(provider.name).toBe("fake");
  });

  it("returns the same session for a retried checkout id", async () => {
    const first = await provider.createCheckout(checkout);
    const second = await provider.createCheckout(checkout);
    expect(second.sessionRef).toBe(first.sessionRef);
    expect(second.redirectUrl).toBe(first.redirectUrl);
    expect(first.sessionRef).toBe("fake_checkout_0001");
    expect(first.redirectUrl).toContain("/commerce/fake-pay?checkout=");
  });

  it("refunds every payment in one call, keyed on our refund id", async () => {
    const request: RefundRequest = {
      refundId: "refund_0001",
      payments: [{ sessionRef: "fake_checkout_0001", amountMinor: 5_900 }],
      totalMinor: 5_900,
      currency: "USD",
      reason: "learner-request",
    };
    const first = await provider.refund(request);
    const second = await provider.refund(request);
    expect(first).toEqual({
      status: "succeeded",
      refundRef: "fake_refund_refund_0001",
    });
    expect(second).toEqual(first);
  });

  it("reports a configured refund failure without inventing a reference", async () => {
    const failing = createFakeProvider({
      secret,
      now: () => clockMs,
      origin,
      refundOutcome: { status: "failed", reason: "provider_error" },
    });
    expect(
      await failing.refund({
        refundId: "refund_0002",
        payments: [{ sessionRef: "fake_checkout_0001", amountMinor: 5_900 }],
        totalMinor: 5_900,
        currency: "USD",
        reason: "learner-request",
      }),
    ).toEqual({ status: "failed", reason: "provider_error" });
  });
});

describe("resolvePaymentProvider", () => {
  const now = () => clockMs;

  it("fails closed for every unconfigured or unknown value", () => {
    expect(resolvePaymentProvider({}, now)).toBeNull();
    expect(
      resolvePaymentProvider({ PAYMENT_PROVIDER: undefined }, now),
    ).toBeNull();
    expect(resolvePaymentProvider({ PAYMENT_PROVIDER: "none" }, now)).toBeNull();
    expect(
      resolvePaymentProvider({ PAYMENT_PROVIDER: "stripe" }, now),
    ).toBeNull();
    expect(resolvePaymentProvider({ PAYMENT_PROVIDER: "Fake" }, now)).toBeNull();
    expect(
      resolvePaymentProvider({ PAYMENT_PROVIDER: " fake" }, now),
    ).toBeNull();
    expect(
      resolvePaymentProvider(
        { PAYMENT_PROVIDER: "fake", COMMERCE_WEBHOOK_SECRET: "" },
        now,
      ),
    ).toBeNull();
    expect(
      resolvePaymentProvider(
        {
          PAYMENT_PROVIDER: "fake",
          COMMERCE_WEBHOOK_SECRET: "a".repeat(minimumWebhookSecretBytes - 1),
        },
        now,
      ),
    ).toBeNull();
  });

  it("returns the fake only for the fake provider with a long enough secret", () => {
    const provider = resolvePaymentProvider(
      {
        PAYMENT_PROVIDER: "fake",
        COMMERCE_WEBHOOK_SECRET: secret,
        PUBLIC_SITE_ORIGIN: origin,
      },
      now,
    );
    expect(provider).not.toBeNull();
    expect(provider?.name).toBe("fake");
    expect(provider?.live).toBe(false);
  });

  it("counts the secret in bytes, not characters", () => {
    // 16 two-byte characters are 32 bytes: long enough.
    const wide = "\u00e9".repeat(Math.ceil(minimumWebhookSecretBytes / 2));
    expect(
      resolvePaymentProvider(
        { PAYMENT_PROVIDER: "fake", COMMERCE_WEBHOOK_SECRET: wide },
        now,
      ),
    ).not.toBeNull();
  });

  it("exposes only the port's three methods", () => {
    const provider = resolvePaymentProvider(
      { PAYMENT_PROVIDER: "fake", COMMERCE_WEBHOOK_SECRET: secret },
      now,
    ) as PaymentProvider;
    expect(typeof provider.createCheckout).toBe("function");
    expect(typeof provider.verifyEvent).toBe("function");
    expect(typeof provider.refund).toBe("function");
  });
});
