import {
  certificationListResponseSchema,
  csrfResponseSchema,
  contentPageQuerySchema,
  createQuestionRequestSchema,
  createQuestionRevisionRequestSchema,
  createdDraftResponseSchema,
  createdRevisionResponseSchema,
  domainListResponseSchema,
  examVersionListResponseSchema,
  questionListResponseSchema,
  questionPageQuerySchema,
  questionRevisionListResponseSchema,
  questionRevisionResponseSchema,
  topicListResponseSchema,
} from "@certpath/contracts";
import type { z } from "zod";

const apiRoot = "/api/admin/content";
const pageSize = 25;

export type Certification =
  z.infer<typeof certificationListResponseSchema>["items"][number];
export type ExamVersion =
  z.infer<typeof examVersionListResponseSchema>["items"][number];
export type Domain = z.infer<typeof domainListResponseSchema>["items"][number];
export type Topic = z.infer<typeof topicListResponseSchema>["items"][number];
export type Question =
  z.infer<typeof questionListResponseSchema>["items"][number];
export type QuestionRevisionSummary =
  z.infer<typeof questionRevisionListResponseSchema>["items"][number];
export type QuestionRevision = z.infer<typeof questionRevisionResponseSchema>;
export type QuestionContent = z.infer<
  typeof createQuestionRequestSchema
>["content"];
export type QuestionPage = z.infer<typeof questionListResponseSchema>;

export class ProtectedApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly issues: Array<{ path: string; code: string }> = [],
  ) {
    super(code);
  }
}

async function requestJson<T>(
  path: string,
  schema: { parse(input: unknown): T },
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiRoot}${path}`, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(init.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ProtectedApiError(0, "network_error");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ProtectedApiError(503, "service_unavailable");
  }
  if (!response.ok) {
    const error = body as {
      error?: {
        code?: unknown;
        issues?: unknown;
      };
    };
    const code =
      typeof error.error?.code === "string"
        ? error.error.code
        : "service_unavailable";
    const issues = Array.isArray(error.error?.issues)
      ? error.error.issues.filter(
          (issue): issue is { path: string; code: string } =>
            issue !== null &&
            typeof issue === "object" &&
            typeof issue.path === "string" &&
            typeof issue.code === "string",
        )
      : [];
    throw new ProtectedApiError(response.status, code, issues);
  }

  try {
    return schema.parse(body);
  } catch {
    throw new ProtectedApiError(503, "service_unavailable");
  }
}

function pagePath(
  path: string,
  input: { cursor?: string; limit?: number } = {},
): string {
  const query = new URLSearchParams({
    limit: String(input.limit ?? pageSize),
  });
  if (input.cursor) query.set("cursor", input.cursor);
  return `${path}?${query}`;
}

function safeId(value: string): string {
  return encodeURIComponent(value);
}

export async function listCertifications(cursor?: string) {
  const query = contentPageQuerySchema.parse({
    ...(cursor ? { cursor } : {}),
    limit: String(pageSize),
  });
  return requestJson(
    pagePath("/certifications", { cursor: query.cursor, limit: query.limit }),
    certificationListResponseSchema,
  );
}

export async function listExamVersions(
  certificationId: string,
  cursor?: string,
) {
  const path = `/certifications/${safeId(certificationId)}/exam-versions`;
  return requestJson(
    pagePath(path, { cursor }),
    examVersionListResponseSchema,
  );
}

export async function listDomains(
  certificationId: string,
  examVersionId: string,
  cursor?: string,
) {
  const path = `/certifications/${safeId(certificationId)}/exam-versions/${safeId(examVersionId)}/domains`;
  return requestJson(pagePath(path, { cursor }), domainListResponseSchema);
}

export async function listTopics(
  certificationId: string,
  examVersionId: string,
  domainId: string,
  cursor?: string,
) {
  const path = `/certifications/${safeId(certificationId)}/exam-versions/${safeId(examVersionId)}/domains/${safeId(domainId)}/topics`;
  return requestJson(pagePath(path, { cursor }), topicListResponseSchema);
}

export async function listQuestions(
  input: {
    certificationId: string;
    examVersionId: string;
    domainId: string;
    topicId: string;
    search?: string;
    cursor?: string;
  },
) {
  const params = questionPageQuerySchema.parse({
    domainId: input.domainId,
    topicId: input.topicId,
    ...(input.search ? { search: input.search } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    limit: String(pageSize),
  });
  const query = new URLSearchParams({
    domainId: params.domainId,
    topicId: params.topicId,
    limit: String(params.limit),
  });
  if (params.search) query.set("search", params.search);
  if (params.cursor) query.set("cursor", params.cursor);
  const path = `/certifications/${safeId(input.certificationId)}/exam-versions/${safeId(input.examVersionId)}/questions?${query}`;
  return requestJson(path, questionListResponseSchema);
}

export async function listQuestionRevisions(
  certificationId: string,
  examVersionId: string,
  questionId: string,
  cursor?: string,
) {
  const path = `/certifications/${safeId(certificationId)}/exam-versions/${safeId(examVersionId)}/questions/${safeId(questionId)}/revisions`;
  return requestJson(
    pagePath(path, { cursor }),
    questionRevisionListResponseSchema,
  );
}

export async function getQuestionRevision(
  certificationId: string,
  examVersionId: string,
  questionId: string,
  revisionId: string,
) {
  const path = `/certifications/${safeId(certificationId)}/exam-versions/${safeId(examVersionId)}/questions/${safeId(questionId)}/revisions/${safeId(revisionId)}`;
  return requestJson(path, questionRevisionResponseSchema);
}

async function getCsrfToken(): Promise<string> {
  const response = await requestJson(
    "/csrf",
    csrfResponseSchema,
  );
  return response.csrfToken;
}

async function postJson<T>(
  path: string,
  input: unknown,
  requestSchema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
  responseSchema: { parse(value: unknown): T },
): Promise<T> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw new ProtectedApiError(400, "validation_error");
  const csrfToken = await getCsrfToken();
  return requestJson(
    path,
    responseSchema,
    {
      method: "POST",
      headers: {
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify(parsed.data),
    },
  );
}

export function createDraft(
  certificationId: string,
  examVersionId: string,
  input: z.input<typeof createQuestionRequestSchema>,
) {
  const path = `/certifications/${safeId(certificationId)}/exam-versions/${safeId(examVersionId)}/questions`;
  return postJson(path, input, createQuestionRequestSchema, createdDraftResponseSchema);
}

export function createCorrection(
  certificationId: string,
  examVersionId: string,
  questionId: string,
  input: z.input<typeof createQuestionRevisionRequestSchema>,
) {
  const path = `/certifications/${safeId(certificationId)}/exam-versions/${safeId(examVersionId)}/questions/${safeId(questionId)}/revisions`;
  return postJson(
    path,
    input,
    createQuestionRevisionRequestSchema,
    createdRevisionResponseSchema,
  );
}
