import { z } from "zod";

// Contracts for the admin commerce surface that ships in this phase: the Pro
// enablement read and the act that changes it.
//
// Nothing here carries a price, a learner, or a payment: an enablement act is
// "Pro is (or is not) sold on this exam", with who and why. Learner-facing
// commerce contracts arrive with checkout, webhooks, refunds and receipts.

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9:_-]+$/);
const safeInteger = z.number().int().safe();
const operationId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9:_-]+$/);

export const proEnablementActSchema = z
  .object({
    enabled: z.boolean(),
    effectiveAt: safeInteger,
    operationId,
    reason: z.string().min(1).max(500),
  })
  .strict();

export const proEnablementResponseSchema = z
  .object({
    certificationId: id,
    enabled: z.boolean(),
    effectiveAt: safeInteger.nullable(),
    history: z.array(proEnablementActSchema).max(20),
  })
  .strict();

export const proEnablementRequestSchema = z
  .object({
    enabled: z.boolean(),
    reason: z.string().trim().min(1).max(200),
  })
  .strict();

export const proEnablementMutationResponseSchema = z
  .object({
    certificationId: id,
    enabled: z.boolean(),
    effectiveAt: safeInteger,
    operationId,
  })
  .strict();

export type ProEnablementAct = z.infer<typeof proEnablementActSchema>;
export type ProEnablementResponse = z.infer<typeof proEnablementResponseSchema>;
export type ProEnablementRequest = z.infer<typeof proEnablementRequestSchema>;
export type ProEnablementMutationResponse = z.infer<
  typeof proEnablementMutationResponseSchema
>;
