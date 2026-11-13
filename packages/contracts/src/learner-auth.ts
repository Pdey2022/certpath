import { z } from "zod";

const emailInput = z.string().trim().email().max(254);
const passwordInput = z.string().min(1).max(1024);

export const learnerRegistrationRequestSchema = z
  .object({ email: emailInput })
  .strict();

export const learnerSignInRequestSchema = z
  .object({
    email: emailInput,
    password: passwordInput,
  })
  .strict();

export const learnerEmailRequestSchema = z
  .object({ email: emailInput })
  .strict();

export const learnerEmailVerificationRequestSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    password: z.string().min(12).max(1024),
  })
  .strict();

export const learnerPasswordResetRequestSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    password: z.string().min(12).max(1024),
  })
  .strict();

export const localLearnerAuthPreflightResponseSchema = z
  .object({
    signInEnabled: z.boolean(),
    localMailboxEnabled: z.boolean(),
  })
  .strict();

export const localLearnerAuthMessageResponseSchema = z
  .object({ message: z.string().min(1).max(200) })
  .strict();

export const localLearnerSignInResponseSchema = z
  .object({ redirectTo: z.literal("/app/home") })
  .strict();

export const localTestInboxResponseSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            email: z.string().min(3).max(254),
            kind: z.enum(["verify_email", "password_reset"]),
            link: z.string().url().max(2048),
            sentAt: z.number().int().safe(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();

export type LocalLearnerAuthPreflightResponse = z.infer<
  typeof localLearnerAuthPreflightResponseSchema
>;
export type LocalLearnerAuthMessageResponse = z.infer<
  typeof localLearnerAuthMessageResponseSchema
>;
export type LocalLearnerSignInResponse = z.infer<
  typeof localLearnerSignInResponseSchema
>;
export type LocalTestInboxResponse = z.infer<typeof localTestInboxResponseSchema>;
