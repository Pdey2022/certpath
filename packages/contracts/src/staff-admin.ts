import { z } from "zod";

const emailInput = z.string().trim().email().max(254);
const totpCode = z.string().regex(/^\d{6}$/);
const recoveryCode = z.string().trim().min(1).max(32);

export const staffSignInRequestSchema = z
  .object({
    email: emailInput,
    password: z.string().min(1).max(1024),
  })
  .strict();

// Password sign-in no longer mints assurance: it mints a session with
// `mfa_method = NULL` and sends the caller to the second-factor step.
export const staffSignInResponseSchema = z
  .object({ redirectTo: z.literal("/admin/mfa/verify") })
  .strict();

export const staffSessionResponseSchema = z
  .object({
    userId: z.string().min(1).max(128),
    role: z.enum(["global_admin", "manager"]),
    certifications: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            displayName: z.string().min(1).max(160),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

// `testerAssuranceEnabled` is a literal `false`: the label is retired in
// migration `0023` and no configuration can turn it back on.
export const staffAdminPreflightResponseSchema = z
  .object({
    signInEnabled: z.boolean(),
    mfaMethods: z.array(z.literal("totp")).max(1),
    testerAssuranceEnabled: z.literal(false),
  })
  .strict();

// `{}` is accepted by the transport so the failure is a governed 403 rather
// than a schema error; only a valid printed ticket creates a factor.
export const staffMfaEnrolRequestSchema = z
  .object({ ticket: z.string().trim().min(1).max(128).optional() })
  .strict();

export const staffMfaEnrolResponseSchema = z
  .object({
    secret: z.string().min(16).max(64),
    otpauthUri: z.string().min(1).max(1024),
    keyVersion: z.number().int().positive(),
  })
  .strict();

export const staffMfaConfirmRequestSchema = z.object({ code: totpCode }).strict();

export const staffMfaConfirmResponseSchema = z
  .object({
    recoveryCodes: z
      .array(z.string().regex(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/))
      .length(10),
  })
  .strict();

export const staffMfaVerifyRequestSchema = z.object({ code: totpCode }).strict();

export const staffMfaVerifyResponseSchema = z
  .object({ redirectTo: z.literal("/admin/question-editor") })
  .strict();

export const staffMfaRecoveryRequestSchema = z
  .object({ recoveryCode })
  .strict();

export const staffMfaRecoveryResponseSchema = z
  .object({ next: z.literal("enrol") })
  .strict();

export const staffMfaResetRequestSchema = z
  .object({
    userId: z.string().trim().min(1).max(128),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const staffMfaResetResponseSchema = z
  .object({
    ticket: z.string().min(32).max(128),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type StaffSignInRequest = z.infer<typeof staffSignInRequestSchema>;
export type StaffSignInResponse = z.infer<typeof staffSignInResponseSchema>;
export type StaffSessionResponse = z.infer<typeof staffSessionResponseSchema>;
export type StaffAdminPreflightResponse = z.infer<
  typeof staffAdminPreflightResponseSchema
>;
export type StaffMfaEnrolRequest = z.infer<typeof staffMfaEnrolRequestSchema>;
export type StaffMfaEnrolResponse = z.infer<typeof staffMfaEnrolResponseSchema>;
export type StaffMfaConfirmResponse = z.infer<
  typeof staffMfaConfirmResponseSchema
>;
export type StaffMfaVerifyResponse = z.infer<
  typeof staffMfaVerifyResponseSchema
>;
export type StaffMfaRecoveryResponse = z.infer<
  typeof staffMfaRecoveryResponseSchema
>;
export type StaffMfaResetResponse = z.infer<typeof staffMfaResetResponseSchema>;
