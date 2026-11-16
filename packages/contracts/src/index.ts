import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
}).strict();

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export * from "./protected-content";
export * from "./practice";
export * from "./learner-auth";
export * from "./staff-admin";
export * from "./admin-learners";
export * from "./admin-commerce";
export * from "./commerce";
