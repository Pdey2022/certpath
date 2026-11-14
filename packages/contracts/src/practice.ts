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
            mockProfile: z
              .object({
                version: safeInteger.positive(),
                durationSeconds: safeInteger.min(60).max(14_400),
                questionCount: safeInteger.min(1).max(20),
                navigation: z.literal("reviewable"),
              })
              .strict()
              .optional(),
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

export const startTimedMockRequestSchema = z
  .object({
    certificationId: id,
    examVersionId: id,
    requestId: uuid,
  })
  .strict();

export const timedMockAnswerRequestSchema = z
  .object({
    expectedVersion: safeInteger.positive(),
    requestId: uuid,
    position: safeInteger.min(0).max(19),
    selectedOptionKey: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
  })
  .strict();

export const timedMockPositionRequestSchema = z
  .object({
    expectedVersion: safeInteger.positive(),
    requestId: uuid,
    position: safeInteger.min(0).max(19),
  })
  .strict();

export const timedMockSubmitRequestSchema = z
  .object({
    expectedVersion: safeInteger.positive(),
    requestId: uuid,
  })
  .strict();

export const timedMockAttemptSummarySchema = z
  .object({
    id,
    certificationId: id,
    examVersionId: id,
    state: z.enum(["in_progress", "completed"]),
    completionReason: z.enum(["learner_submitted", "timed_out"]).nullable(),
    version: safeInteger.positive(),
    profileVersion: safeInteger.positive(),
    durationSeconds: safeInteger.min(60).max(14_400),
    questionCount: safeInteger.min(1).max(20),
    currentPosition: safeInteger.min(0).max(19),
    answeredCount: safeInteger.min(0).max(20),
    correctCount: safeInteger.min(0).max(20).optional(),
    startedAt: safeInteger,
    deadlineAt: safeInteger,
    completedAt: safeInteger.nullable(),
    createdAt: safeInteger,
    updatedAt: safeInteger,
  })
  .strict();

export const timedMockAttemptListResponseSchema = z
  .object({
    items: z.array(timedMockAttemptSummarySchema).max(20),
  })
  .strict();

const timedMockItemSchema = z
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

export const timedMockAttemptResponseSchema = z
  .object({
    attempt: timedMockAttemptSummarySchema,
    serverNow: safeInteger,
    items: z.array(timedMockItemSchema).min(1).max(20),
  })
  .strict();

export const learnerDashboardAttemptSchema = z
  .object({
    id,
    kind: z.enum(["practice", "timed_mock"]),
    state: z.enum(["in_progress", "completed"]),
    questionCount: safeInteger.min(1).max(20),
    answeredCount: safeInteger.min(0).max(20),
    currentPosition: safeInteger.min(0).max(20),
    correctCount: safeInteger.min(0).max(20).optional(),
    createdAt: safeInteger,
    updatedAt: safeInteger,
    completedAt: safeInteger.nullable(),
    deadlineAt: safeInteger.optional(),
    completionReason: z.enum(["learner_submitted", "timed_out"]).nullable().optional(),
  })
  .strict();

export const readinessBasisSchema = z
  .object({
    mocks: safeInteger.min(0).max(3),
    questions: safeInteger.min(0),
    blueprintWeighted: z.literal(true),
  })
  .strict();

export const readinessNextActionSchema = z
  .object({
    domainId: id,
    title: z.string().min(1).max(160),
    accuracy: safeInteger.min(0).max(100),
    questions: safeInteger.min(0),
    blueprintWeight: safeInteger.min(0).max(100),
  })
  .strict();

export const learnerReadinessSchema = z
  .object({
    band: z.enum(["low", "medium", "ready"]),
    score: safeInteger.min(0).max(100),
    isReady: z.boolean(),
    /** False once the snapshot is older than the 14-day decay window. */
    isCurrent: z.boolean(),
    computedAt: safeInteger,
    basis: readinessBasisSchema,
    nextAction: readinessNextActionSchema.nullable(),
    /** True only when the promotion gate, Pro availability and term all pass. */
    proPrompt: z.boolean(),
  })
  .strict();

export const learnerAccessSchema = z
  .object({
    state: z.enum(["active", "grace", "expired"]),
    endsAt: safeInteger.nullable(),
    graceEndsAt: safeInteger.nullable(),
    graceDaysRemaining: safeInteger.min(0),
  })
  .strict();

export const learnerDashboardGroupSchema = z
  .object({
    certificationId: id,
    certificationName: z.string().min(1).max(160),
    examVersionId: id,
    versionKey: z.string().min(1).max(80),
    examVersionTitle: z.string().min(1).max(160),
    access: learnerAccessSchema,
    readiness: learnerReadinessSchema.nullable(),
    resumable: z.array(learnerDashboardAttemptSchema).max(40),
    completed: z.array(learnerDashboardAttemptSchema).max(40),
  })
  .strict();

export const learnerDashboardResponseSchema = z
  .object({
    groups: z.array(learnerDashboardGroupSchema).max(200),
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
export type StartTimedMockRequest = z.infer<
  typeof startTimedMockRequestSchema
>;
export type TimedMockAnswerRequest = z.infer<
  typeof timedMockAnswerRequestSchema
>;
export type TimedMockPositionRequest = z.infer<
  typeof timedMockPositionRequestSchema
>;
export type TimedMockSubmitRequest = z.infer<
  typeof timedMockSubmitRequestSchema
>;
export type TimedMockAttemptResponse = z.infer<
  typeof timedMockAttemptResponseSchema
>;
export type LearnerDashboardResponse = z.infer<
  typeof learnerDashboardResponseSchema
>;
