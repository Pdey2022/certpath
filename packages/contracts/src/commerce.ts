import { z } from "zod";

// Contracts for the learner-facing commerce surface that ships in this phase:
// the offers projection, checkout creation and the checkout read.
//
// Nothing here carries a card, a learner identity, a receipt or a refund: those
// arrive with settlement in the next commerce change. The checkout shapes carry
// no price of their own either - every `amountMinor` in a response is the value
// the server copied out of `apps/api/src/pricing.ts`, which is the only place a
// price constant may live.
//
// `.strict()` everywhere: an unexpected field is a client bug and must fail
// loudly rather than be ignored.

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9:_-]+$/);
const safeInteger = z.number().int().safe();
const currencyCode = z.string().length(3);

/**
 * The seven SKUs, in price-list order. This list is the wire vocabulary, not a
 * price list: the amounts live in `pricing.ts` and nowhere else. A test asserts
 * this enum and `priceList` have the same members.
 */
export const commerceSkuSchema = z.enum([
  "standard-3m",
  "standard-6m",
  "standard-12m",
  "pro-3m",
  "bundle-standard-3m-pro",
  "standard-topup-3m",
  "standard-extension-30d",
]);

/** Why an offer cannot be bought. `reason` is null exactly when it can. */
export const commerceOfferReasonSchema = z.enum([
  "pro_not_offered",
  "standard_too_short",
  "pro_window_active",
  "topup_not_applicable",
  "extension_not_applicable",
]);

export const commerceCheckoutStatusSchema = z.enum([
  "pending",
  "paid",
  "failed",
  "expired",
  "needs_support",
  "refunded",
]);

/**
 * The window a line grants, as `TermSpec`. A bare day count is not accepted:
 * 3 calendar months is 89 days from 1 February and 92 from 1 July.
 */
export const commerceTermSchema = z.discriminatedUnion("unit", [
  z
    .object({
      unit: z.literal("calendar_months"),
      months: safeInteger.min(1).max(120),
    })
    .strict(),
  z.object({ unit: z.literal("days"), days: safeInteger.min(1).max(3_650) }).strict(),
]);

export const commerceOfferSchema = z
  .object({
    sku: commerceSkuSchema,
    label: z.string().min(1).max(160),
    amountMinor: safeInteger.positive(),
    purchasable: z.boolean(),
    reason: commerceOfferReasonSchema.nullable(),
  })
  .strict()
  .superRefine((offer, context) => {
    // The invariant the endpoint promises its only reader: a purchasable offer
    // has no reason, and an unpurchasable one always has exactly one.
    if (offer.purchasable !== (offer.reason === null)) {
      context.addIssue({
        code: "custom",
        message: "reason is null exactly when purchasable is true",
        path: ["reason"],
      });
    }
  });

export const commerceOffersResponseSchema = z
  .object({
    certificationId: id,
    currency: currencyCode,
    /** Whole days of live-and-future Standard coverage; 0, never null. */
    standardRemainingDays: safeInteger.min(0),
    proOffered: z.boolean(),
    offers: z.array(commerceOfferSchema).min(1).max(16),
  })
  .strict();

export const commerceCheckoutLineSchema = z
  .object({
    sku: commerceSkuSchema,
    label: z.string().min(1).max(160),
    amountMinor: safeInteger.positive(),
    feature: z.enum(["standard", "pro"]),
    term: commerceTermSchema,
    /** `bundle-residual` marks the derived Pro leg of the bundle. */
    priceSource: z.enum(["price-list", "bundle-residual"]),
  })
  .strict();

/**
 * `sku` is a plain string rather than the enum so an unknown SKU can be answered
 * `400 unknown_sku` instead of a generic validation failure. The handler checks
 * it against the price list before anything is written.
 */
export const commerceCheckoutRequestSchema = z
  .object({
    certificationId: id,
    sku: z.string().min(1).max(64),
    clientCheckoutKey: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[a-zA-Z0-9._:-]+$/),
  })
  .strict();

export const commerceCheckoutResponseSchema = z
  .object({
    checkoutId: id,
    /**
     * What was bought, as the price-list key - the SKU the learner chose, not a
     * line. The bundle's `standard-3m` + `pro-3m` line pair describes the same
     * two features as a Pro purchase made on top of Standard coverage, so
     * settlement branches on this field rather than on line shape.
     */
    sku: commerceSkuSchema,
    status: commerceCheckoutStatusSchema,
    currency: currencyCode,
    totalMinor: safeInteger.positive(),
    lines: z.array(commerceCheckoutLineSchema).min(1).max(4),
    /** The provider session's redirect while pending; null once it cannot be used. */
    redirectUrl: z.string().min(1).max(2_048).nullable(),
    expiresAt: safeInteger,
    paidAt: safeInteger.nullable(),
    /** Set when settlement ships; null while nothing can pay a checkout. */
    refundWindowEndsAt: safeInteger.nullable(),
  })
  .strict();

/**
 * The house error envelope plus the two fields the purchase rule owes a client:
 * which rule refused, and whether the bundle is the way through.
 */
export const commercePurchaseNotAllowedErrorSchema = z
  .object({
    error: z
      .object({
        code: z.literal("purchase_not_allowed"),
        requestId: z.string().min(1).max(128),
        reason: commerceOfferReasonSchema,
        requiresBundle: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type CommerceSku = z.infer<typeof commerceSkuSchema>;
export type CommerceOfferReason = z.infer<typeof commerceOfferReasonSchema>;
export type CommerceCheckoutStatus = z.infer<
  typeof commerceCheckoutStatusSchema
>;
export type CommerceTerm = z.infer<typeof commerceTermSchema>;
export type CommerceOffer = z.infer<typeof commerceOfferSchema>;
export type CommerceOffersResponse = z.infer<
  typeof commerceOffersResponseSchema
>;
export type CommerceCheckoutLine = z.infer<typeof commerceCheckoutLineSchema>;
export type CommerceCheckoutRequest = z.infer<
  typeof commerceCheckoutRequestSchema
>;
export type CommerceCheckoutResponse = z.infer<
  typeof commerceCheckoutResponseSchema
>;
export type CommercePurchaseNotAllowedError = z.infer<
  typeof commercePurchaseNotAllowedErrorSchema
>;
