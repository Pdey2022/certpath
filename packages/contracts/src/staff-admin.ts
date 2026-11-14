import { z } from "zod";

const emailInput = z.string().trim().email().max(254);

export const staffSignInRequestSchema = z
  .object({
    email: emailInput,
    password: z.string().min(1).max(1024),
  })
  .strict();

export const staffSignInResponseSchema = z
  .object({ redirectTo: z.literal("/admin/question-editor") })
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

export const staffAdminPreflightResponseSchema = z
  .object({
    signInEnabled: z.boolean(),
    testerAssuranceEnabled: z.boolean(),
  })
  .strict();

export type StaffSignInRequest = z.infer<typeof staffSignInRequestSchema>;
export type StaffSignInResponse = z.infer<typeof staffSignInResponseSchema>;
export type StaffSessionResponse = z.infer<typeof staffSessionResponseSchema>;
export type StaffAdminPreflightResponse = z.infer<
  typeof staffAdminPreflightResponseSchema
>;
