import { z } from "zod";

// Contracts for the commerce surface: the offers projection, checkout creation
// and the checkout read, the refund, the receipts read, the provider webhook's
// acknowledgement, and the local dev seam's request.
//
// Nothing here carries a card, a learner identity or a credential. A receipt
// appears here as a stored record - `delivery` has one legal value, `stored`, and
// there is no transport - and it carries no tax statement, because no tax is
// computed and no column exists for one. The webhook acknowledgement is
// `{ received, duplicate }` and no more. Every `amountMinor` in a response is the
// value the server copied out of `apps/api/src/pricing.ts` or out of a stored
// snapshot of it, which is the only place a price constant may live.
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
    /**
     * `paid_at + 7 days`, the ADR 0003 refund window - the same instant the
     * purchase receipt records. Null exactly while `paidAt` is null.
     */
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

/**
 * A second checkout for a product this learner already has open. The existing id
 * travels so a second tab can be handed the live provider session
 * (`GET /api/commerce/checkouts/:checkoutId`) instead of opening a second one.
 */
export const commerceCheckoutAlreadyOpenErrorSchema = z
  .object({
    error: z
      .object({
        code: z.literal("checkout_already_open"),
        requestId: z.string().min(1).max(128),
        checkoutId: id,
      })
      .strict(),
  })
  .strict();

/**
 * The provider webhook's answer. `duplicate` is true when the event id was
 * already recorded: the provider should stop retrying either way, so both
 * answers are `200`.
 */
export const commerceWebhookResponseSchema = z
  .object({
    received: z.literal(true),
    duplicate: z.boolean(),
  })
  .strict();

/**
 * A self-serve refund request. `reason` is learner free text, capped at the
 * storage limit (200) and refused if it looks like an address: a free-text field
 * must not become an unlogged email channel. The text is stored once, on the
 * learner's own refund row; it never reaches `audit_events`.
 */
export const commerceRefundRequestSchema = z
  .object({
    reason: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => !value.includes("@"), {
        message: "reason must not contain an email address",
      }),
  })
  .strict();

/**
 * Why a checkout is inside one refund. `requested` is the checkout the learner
 * named; `dependent-pro` is the Pro purchase that revoking the named Standard
 * grant would have left uncovered, refunded in the same record. It is the
 * machine-readable half of the owner-approved sentence "Your refund also
 * cancelled Pro, which was refunded in full" - the API never renders the
 * sentence.
 */
export const commerceRefundInclusionSchema = z.enum([
  "requested",
  "dependent-pro",
]);

export const commerceRefundCheckoutSchema = z
  .object({
    checkoutId: id,
    sku: commerceSkuSchema,
    amountMinor: safeInteger.positive(),
    includedBecause: commerceRefundInclusionSchema,
  })
  .strict();

/**
 * One grant a settled refund revoked. Ordered Pro before Standard, then by
 * `startsAt`, which is the order the batch revoked them in.
 */
export const commerceRefundRevokedGrantSchema = z
  .object({
    feature: z.enum(["standard", "pro"]),
    grantId: id,
    checkoutId: id,
    startsAt: safeInteger,
    expiresAt: safeInteger,
  })
  .strict();

/** The refund receipt written for one refunded checkout. */
export const commerceRefundReceiptRefSchema = z
  .object({
    receiptId: id,
    receiptNumber: z.string().regex(/^CP\d{8}-[0-9A-F]{12}$/),
    checkoutId: id,
  })
  .strict();

/**
 * The provider has not confirmed the refund, so nothing has been revoked and no
 * receipt exists. There is deliberately no `revoked`, no `receipts` and no
 * `access` field: nothing has happened to access yet, and saying otherwise would
 * be a lie. A client that retries gets the same `refundId` and the same body
 * until the provider answers.
 */
export const commerceRefundPendingResponseSchema = z
  .object({
    refundId: id,
    status: z.literal("requested"),
    currency: currencyCode,
    amountMinor: safeInteger.positive(),
    requestedAt: safeInteger,
    checkouts: z.array(commerceRefundCheckoutSchema).min(1).max(2),
  })
  .strict();

/**
 * The settled refund, projected from storage. `access` has exactly one value
 * because the grace question is part of the API, not the presentation: a refund
 * revokes, and ADR 0005's grace is defined for expiry of a grant that still
 * exists.
 */
export const commerceRefundSettledResponseSchema = z
  .object({
    refundId: id,
    status: z.literal("settled"),
    currency: currencyCode,
    amountMinor: safeInteger.positive(),
    requestedAt: safeInteger,
    settledAt: safeInteger,
    checkouts: z.array(commerceRefundCheckoutSchema).min(1).max(2),
    revoked: z.array(commerceRefundRevokedGrantSchema).min(1).max(4),
    receipts: z.array(commerceRefundReceiptRefSchema).min(1).max(2),
    access: z.literal("ended"),
  })
  .strict();

export const commerceRefundResponseSchema = z.discriminatedUnion("status", [
  commerceRefundPendingResponseSchema,
  commerceRefundSettledResponseSchema,
]);

/** One line of a stored receipt, as the price snapshot recorded it. */
export const commerceReceiptLineSchema = z
  .object({
    sku: commerceSkuSchema,
    label: z.string().min(1).max(160),
    amountMinor: safeInteger.positive(),
    feature: z.enum(["standard", "pro"]),
    term: commerceTermSchema,
  })
  .strict();

/**
 * One grant a receipt witnesses. `grantId` is null on a purchase receipt: the
 * grant row id is minted inside the settlement insert and the shipped writer
 * records only the deterministic operation id, so the read model normalises the
 * two shapes into one strict contract rather than widening it per `kind`.
 */
export const commerceReceiptGrantSchema = z
  .object({
    feature: z.enum(["standard", "pro"]),
    startsAt: safeInteger,
    expiresAt: safeInteger,
    operationId: id.nullable(),
    grantId: id.nullable(),
  })
  .strict();

/**
 * A stored receipt. `refundId` is null exactly for a purchase, and
 * `refundWindowEndsAt` is null exactly for a refund - the two CHECKs 0019 put on
 * the row, surfaced as one contract so a client cannot meet a third shape.
 */
export const commerceReceiptSchema = z
  .object({
    receiptId: id,
    receiptNumber: z.string().regex(/^CP\d{8}-[0-9A-F]{12}$/),
    kind: z.enum(["purchase", "refund"]),
    checkoutId: id,
    refundId: id.nullable(),
    certificationId: id,
    currency: currencyCode,
    totalMinor: safeInteger.positive(),
    lines: z.array(commerceReceiptLineSchema).min(1).max(4),
    grants: z.array(commerceReceiptGrantSchema).max(4),
    provider: z.string().min(1).max(32),
    providerRef: z.string().min(1).max(256).nullable(),
    delivery: z.literal("stored"),
    refundWindowEndsAt: safeInteger.nullable(),
    issuedAt: safeInteger,
  })
  .strict();

/**
 * One exam's receipts for the caller. 50 is the ceiling and there is no cursor:
 * a learner's receipts for one exam are bounded by their purchases, and
 * `GET /receipts/:receiptId` serves any single one.
 */
export const commerceReceiptListResponseSchema = z
  .object({
    certificationId: id,
    currency: currencyCode,
    receipts: z.array(commerceReceiptSchema).max(50),
  })
  .strict();

/**
 * The local-only dev seam's request. It names a checkout and nothing else: the
 * amount, the currency and the provider reference are read from the stored row,
 * so the seam cannot invent a payment for a price that was never charged.
 */
export const commerceFakePayRequestSchema = z
  .object({ checkoutId: id })
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
export type CommerceCheckoutAlreadyOpenError = z.infer<
  typeof commerceCheckoutAlreadyOpenErrorSchema
>;
export type CommerceWebhookResponse = z.infer<
  typeof commerceWebhookResponseSchema
>;
export type CommerceFakePayRequest = z.infer<
  typeof commerceFakePayRequestSchema
>;
export type CommerceRefundRequest = z.infer<
  typeof commerceRefundRequestSchema
>;
export type CommerceRefundInclusion = z.infer<
  typeof commerceRefundInclusionSchema
>;
export type CommerceRefundCheckout = z.infer<
  typeof commerceRefundCheckoutSchema
>;
export type CommerceRefundRevokedGrant = z.infer<
  typeof commerceRefundRevokedGrantSchema
>;
export type CommerceRefundReceiptRef = z.infer<
  typeof commerceRefundReceiptRefSchema
>;
export type CommerceRefundPendingResponse = z.infer<
  typeof commerceRefundPendingResponseSchema
>;
export type CommerceRefundSettledResponse = z.infer<
  typeof commerceRefundSettledResponseSchema
>;
export type CommerceRefundResponse = z.infer<
  typeof commerceRefundResponseSchema
>;
export type CommerceReceiptLine = z.infer<typeof commerceReceiptLineSchema>;
export type CommerceReceiptGrant = z.infer<typeof commerceReceiptGrantSchema>;
export type CommerceReceipt = z.infer<typeof commerceReceiptSchema>;
export type CommerceReceiptListResponse = z.infer<
  typeof commerceReceiptListResponseSchema
>;
