import { z } from "zod";

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9:_-]+$/);
const uuid = z.string().uuid();
const safeInteger = z.number().int().safe();

export const practiceScopeResponseSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            certificationId: id,
            certificationName: z.string().min(1).max(160),
            examVersionId: id,
            versionKey: z.string().min(1).max(80),
            examVersionTitle: z.string().min(1).max(160),
            domains: z
              .array(
                z
                  .object({
                    id,
                    title: z.string().min(1).max(160),
                  })
                  .strict(),
              )
              .max(200),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

export const startPracticeRequestSchema = z
  .object({
    certificationId: id,
    examVersionId: id,
    questionCount: safeInteger.min(1).max(20),
    domainId: id.optional(),
    difficulty: z.enum(["easy", "medium", "hard"]).optional(),
    requestId: uuid,
  })
  .strict();

export const practiceAttemptListQuerySchema = z
  .object({
    certificationId: id,
    examVersionId: id,
  })
  .strict();

export const practiceAnswerRequestSchema = z
  .object({
    expectedVersion: safeInteger.positive(),
    requestId: uuid,
    selectedOptionKey: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
  })
  .strict();

export const practiceAttemptSummarySchema = z
  .object({
    id,
    certificationId: id,
    examVersionId: id,
    state: z.enum(["in_progress", "completed"]),
    version: safeInteger.positive(),
    questionCount: safeInteger.min(1).max(20),
    currentPosition: safeInteger.min(0).max(20),
    correctCount: safeInteger.min(0).max(20).optional(),
    createdAt: safeInteger,
    updatedAt: safeInteger,
    completedAt: safeInteger.nullable(),
    filters: z
      .object({
        domainId: id.optional(),
        difficulty: z.enum(["easy", "medium", "hard"]).optional(),
      })
      .strict(),
  })
  .strict();

export const practiceAttemptListResponseSchema = z
  .object({
    items: z.array(practiceAttemptSummarySchema).max(20),
  })
  .strict();

const practiceItemSchema = z
  .object({
    position: safeInteger.min(0).max(19),
    revisionId: id,
    stem: z.string().min(5).max(4000),
    options: z
      .array(
        z
          .object({
            key: z.string().min(1).max(32),
            text: z.string().min(1).max(1000),
            explanation: z.string().min(1).max(3000).optional(),
          })
          .strict(),
      )
      .min(2)
      .max(8),
    selectedOptionKey: z.string().min(1).max(32).optional(),
    correctOptionKey: z.string().min(1).max(32).optional(),
    isCorrect: z.boolean().optional(),
  })
  .strict();

export const practiceAttemptResponseSchema = z
  .object({
    attempt: practiceAttemptSummarySchema,
    items: z.array(practiceItemSchema).min(1).max(20),
  })
  .strict();

export type PracticeScopeResponse = z.infer<
  typeof practiceScopeResponseSchema
>;
export type StartPracticeRequest = z.infer<typeof startPracticeRequestSchema>;
export type PracticeAnswerRequest = z.infer<
  typeof practiceAnswerRequestSchema
>;
export type PracticeAttemptResponse = z.infer<
  typeof practiceAttemptResponseSchema
>;
