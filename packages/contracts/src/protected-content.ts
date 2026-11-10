import { z } from "zod";

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9:_-]+$/);
const key = (maximum: number) =>
  z.string().trim().min(1).max(maximum).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const boundedText = (minimum: number, maximum: number) =>
  z.string().trim().min(minimum).max(maximum);
const safeInteger = z.number().int().safe();

export const questionContentSchema = z
  .object({
    stem: boundedText(5, 4000),
    difficulty: z.enum(["easy", "medium", "hard"]),
    sourceReference: boundedText(1, 1000),
    licenseReference: boundedText(1, 200),
    options: z
      .array(
        z
          .object({
            key: key(32),
            text: boundedText(1, 1000),
            correct: z.boolean(),
            explanation: boundedText(1, 3000),
          })
          .strict(),
      )
      .min(2)
      .max(8),
  })
  .strict();

export const createExamVersionRequestSchema = z
  .object({
    versionKey: key(80),
    title: boundedText(1, 160),
    syllabusReference: boundedText(1, 500),
    effectiveFrom: safeInteger.nullable().optional(),
    effectiveUntil: safeInteger.nullable().optional(),
  })
  .strict();

export const createDomainRequestSchema = z
  .object({
    domainKey: key(80),
    title: boundedText(1, 160),
    meaning: boundedText(1, 2000),
    order: safeInteger.nonnegative(),
  })
  .strict();

export const createTopicRequestSchema = z
  .object({
    topicKey: key(80),
    title: boundedText(1, 160),
    meaning: boundedText(1, 2000),
    order: safeInteger.nonnegative(),
  })
  .strict();

export const createQuestionRequestSchema = z
  .object({
    questionKey: key(120),
    domainId: id,
    topicId: id,
    content: questionContentSchema,
  })
  .strict();

export const createQuestionRevisionRequestSchema = z
  .object({
    domainId: id,
    topicId: id,
    expectedLockVersion: safeInteger.positive(),
    content: questionContentSchema,
  })
  .strict();

export const emptyMutationRequestSchema = z.object({}).strict();

export const questionReviewRequestSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    notes: boundedText(1, 3000),
  })
  .strict();

export const publishQuestionRequestSchema = z
  .object({
    revisionId: id,
    expectedPointerVersion: safeInteger.positive().nullable(),
  })
  .strict();

export const retireQuestionRequestSchema = z
  .object({
    expectedPointerVersion: safeInteger.positive(),
  })
  .strict();

export const exportQuerySchema = z
  .object({
    cursor: id.optional(),
    limit: z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(safeInteger.positive().max(100))
      .optional()
      .transform((value) => value ?? 100),
  })
  .strict();

export const protectedPathIdSchema = id;

export const csrfResponseSchema = z
  .object({ csrfToken: z.string().regex(/^v1\.[A-Za-z0-9_-]{43}$/) })
  .strict();

export const createdIdResponseSchema = z.object({ id }).strict();

export const createdDraftResponseSchema = z
  .object({
    questionId: id,
    revisionId: id,
    revisionNumber: safeInteger.positive(),
  })
  .strict();

export const createdRevisionResponseSchema = z
  .object({
    revisionId: id,
    revisionNumber: safeInteger.positive(),
  })
  .strict();

export const questionRevisionResponseSchema = z
  .object({
    revisionId: id,
    questionId: id,
    certificationId: id,
    examVersionId: id,
    domainId: id,
    topicId: id,
    revisionNumber: safeInteger.positive(),
    lockVersion: safeInteger.positive(),
    stem: z.string(),
    difficulty: z.enum(["easy", "medium", "hard"]),
    sourceReference: z.string(),
    licenseReference: z.string(),
    workflowState: z.string(),
    options: z.array(
      z
        .object({
          key: z.string(),
          order: safeInteger.positive(),
          text: z.string(),
          correct: z.boolean(),
          explanation: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export const revisionIdResponseSchema = z.object({ revisionId: id }).strict();
export const reviewIdResponseSchema = z.object({ reviewId: id }).strict();
export const pointerVersionResponseSchema = z
  .object({ pointerVersion: safeInteger.positive() })
  .strict();

export const importPreviewResponseSchema = z
  .object({
    importId: id,
    formatVersion: z.literal("certpath-question-v1"),
    expiresAt: safeInteger,
    summary: z
      .object({
        parsedRows: safeInteger.nonnegative(),
        validRows: safeInteger.nonnegative(),
        invalidRows: safeInteger.nonnegative(),
      })
      .strict(),
  })
  .strict();

export const importConfirmationResponseSchema = z
  .object({
    importId: id,
    questionIds: z.array(id),
    revisionIds: z.array(id),
    questionKeys: z.array(z.string()),
  })
  .strict();

export interface ProtectedContentApiError {
  error: {
    code: string;
    requestId: string;
    issues?: Array<{ path: string; code: string }>;
  };
}
