import { z } from "zod";

// Contracts for the admin learner-support surface.
//
// Nothing in this file ever carries an unmasked address except the reveal
// response, and the reveal response is the only place the address appears in any
// admin payload.

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9:_-]+$/);
const safeInteger = z.number().int().safe();
const boundedText = (minimum: number, maximum: number) =>
  z.string().trim().min(minimum).max(maximum);

export const staffCapabilitySchema = z.enum([
  "content.read",
  "content.manage",
  "learner.lookup",
  "learner.read",
  "learner.reveal",
  "learner.deactivate",
  "learner.contact.correct",
  "learner.support.email",
  "learner.support.history",
  "commerce.read",
  "access.grant",
  "staff.manage",
  "security.manage",
  "audit.read",
]);

export const staffRoleSchema = z.enum(["global_admin", "manager"]);

export const adminCapabilitiesResponseSchema = z
  .object({
    role: staffRoleSchema,
    capabilities: z.array(staffCapabilitySchema).max(32),
  })
  .strict();

export const learnerLookupRequestSchema = z
  .object({
    email: z.string().trim().email().max(254).optional(),
    userId: id.optional(),
  })
  .strict();

export const learnerMembershipSchema = z
  .object({
    certificationId: z.string().min(1).max(128),
    feature: z.enum(["standard", "pro"]),
    state: z.enum(["active", "grace", "expired"]),
    endsAt: safeInteger.nullable(),
  })
  .strict();

export const maskedLearnerRecordSchema = z
  .object({
    userId: id,
    accountStatus: z.enum(["active", "deactivated"]),
    maskedContact: z.string().max(254).nullable(),
    contactKind: z
      .enum(["password-credential", "sign-in-invite"])
      .nullable(),
    emailVerified: z.boolean().nullable(),
    memberships: z.array(learnerMembershipSchema).max(20),
    membershipsTruncated: z.boolean(),
    attemptCounts: z
      .object({
        practice: z.number().int().nonnegative(),
        mock: z.number().int().nonnegative(),
      })
      .strict(),
    lastActivityAt: safeInteger.nullable(),
    createdAt: safeInteger,
  })
  .strict();

export const learnerLookupResponseSchema = z
  .object({ items: z.array(maskedLearnerRecordSchema).max(1) })
  .strict();

export const learnerContactRevealResponseSchema = z
  .object({
    userId: id,
    contactKind: z.enum(["password-credential", "sign-in-invite"]),
    email: z.string().min(3).max(254),
    revealedAt: safeInteger,
    operationId: z.string().min(1).max(128),
  })
  .strict();

export const learnerDeactivateRequestSchema = z
  .object({ reason: boundedText(1, 200).refine((value) => !value.includes("@")) })
  .strict();

export const learnerDeactivateResponseSchema = z
  .object({
    userId: id,
    accountStatus: z.literal("deactivated"),
    deactivatedAt: safeInteger,
    operationId: z.string().min(1).max(128),
  })
  .strict();

export const learnerContactCorrectionRequestSchema = z
  .object({
    email: z.string().trim().email().max(254),
    reason: boundedText(1, 200).refine((value) => !value.includes("@")),
  })
  .strict();

export const learnerContactCorrectionResponseSchema = z
  .object({
    userId: id,
    maskedContact: z.string().max(254),
    contactKind: z.literal("password-credential"),
    operationId: z.string().min(1).max(128),
  })
  .strict();

export const learnerSupportHistoryQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .refine((value) => value >= 1 && value <= 50)
      .optional(),
    cursor: z.string().min(1).max(128).optional(),
  })
  .strict();

export const learnerSupportHistoryResponseSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            action: z.enum([
              "learner_record_viewed",
              "learner_contact_revealed",
              "learner_contact_corrected",
              "learner_deactivated",
              "learner_support_history_viewed",
            ]),
            actor: z.enum(["global_admin", "manager", "learner", "system"]),
            reason: z.string().max(500),
            occurredAt: safeInteger,
            operationId: z.string().min(1).max(128),
          })
          .strict(),
      )
      .max(50),
    nextCursor: z.string().min(1).max(128).nullable(),
  })
  .strict();

export type StaffCapability = z.infer<typeof staffCapabilitySchema>;
export type StaffRole = z.infer<typeof staffRoleSchema>;
export type AdminCapabilitiesResponse = z.infer<
  typeof adminCapabilitiesResponseSchema
>;
export type LearnerLookupRequest = z.infer<typeof learnerLookupRequestSchema>;
export type MaskedLearnerRecord = z.infer<typeof maskedLearnerRecordSchema>;
export type LearnerLookupResponse = z.infer<typeof learnerLookupResponseSchema>;
export type LearnerContactRevealResponse = z.infer<
  typeof learnerContactRevealResponseSchema
>;
export type LearnerDeactivateRequest = z.infer<
  typeof learnerDeactivateRequestSchema
>;
export type LearnerDeactivateResponse = z.infer<
  typeof learnerDeactivateResponseSchema
>;
export type LearnerContactCorrectionRequest = z.infer<
  typeof learnerContactCorrectionRequestSchema
>;
export type LearnerContactCorrectionResponse = z.infer<
  typeof learnerContactCorrectionResponseSchema
>;
export type LearnerSupportHistoryResponse = z.infer<
  typeof learnerSupportHistoryResponseSchema
>;
