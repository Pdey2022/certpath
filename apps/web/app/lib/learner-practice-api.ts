import {
  csrfResponseSchema,
  practiceAnswerRequestSchema,
  practiceAttemptListResponseSchema,
  practiceAttemptResponseSchema,
  practiceScopeResponseSchema,
  startPracticeRequestSchema,
} from "@certpath/contracts";
import type { z } from "zod";

const apiRoot = "/api/practice";

export type PracticeScope = z.infer<
  typeof practiceScopeResponseSchema
>["items"][number];
export type PracticeAttempt = z.infer<
  typeof practiceAttemptResponseSchema
>;
export type PracticeAttemptSummary = z.infer<
  typeof practiceAttemptListResponseSchema
>["items"][number];
export type StartPracticeInput = z.infer<typeof startPracticeRequestSchema>;
export type SubmitAnswerInput = z.infer<typeof practiceAnswerRequestSchema>;

export class LearnerPracticeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function requestJson<T>(
  path: string,
  schema: { parse(value: unknown): T },
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
    throw new LearnerPracticeApiError(0, "network_error");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new LearnerPracticeApiError(503, "service_unavailable");
  }
  if (!response.ok) {
    const error = body as { error?: { code?: unknown } };
    throw new LearnerPracticeApiError(
      response.status,
      typeof error.error?.code === "string"
        ? error.error.code
        : "service_unavailable",
    );
  }
  try {
    return schema.parse(body);
  } catch {
    throw new LearnerPracticeApiError(503, "service_unavailable");
  }
}

async function getCsrfToken(): Promise<string> {
  return (await requestJson("/csrf", csrfResponseSchema)).csrfToken;
}

function safeId(value: string): string {
  return encodeURIComponent(value);
}

export function listPracticeScopes() {
  return requestJson("/scopes", practiceScopeResponseSchema);
}

export function listPracticeAttempts(
  certificationId: string,
  examVersionId: string,
) {
  const query = new URLSearchParams({
    certificationId,
    examVersionId,
  });
  return requestJson(`/attempts?${query}`, practiceAttemptListResponseSchema);
}

export function getPracticeAttempt(attemptId: string) {
  return requestJson(
    `/attempts/${safeId(attemptId)}`,
    practiceAttemptResponseSchema,
  );
}

async function postJson<T>(
  path: string,
  input: unknown,
  requestSchema: { parse(value: unknown): unknown },
  responseSchema: { parse(value: unknown): T },
): Promise<T> {
  const parsed = requestSchema.parse(input);
  const csrfToken = await getCsrfToken();
  return requestJson(path, responseSchema, {
    method: "POST",
    headers: {
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(parsed),
  });
}

export function startPractice(input: StartPracticeInput) {
  return postJson(
    "/attempts",
    input,
    startPracticeRequestSchema,
    practiceAttemptResponseSchema,
  );
}

export function submitPracticeAnswer(
  attemptId: string,
  input: SubmitAnswerInput,
) {
  return postJson(
    `/attempts/${safeId(attemptId)}/answers`,
    input,
    practiceAnswerRequestSchema,
    practiceAttemptResponseSchema,
  );
}
