import { DriverError } from "./errors.ts";

/**
 * The HTTP client. One staff session, one CSRF token, held in memory for the
 * process lifetime. No cookie, token, password or response body is ever logged
 * or written to disk; the driver only keeps the values it needs to authenticate.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

export interface CallSpec {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | null | undefined>;
  body?: string | Uint8Array;
  contentType?: string;
  /** `csrf` sends Origin + X-CSRF-Token, `origin` sends Origin only. */
  protectedBy?: "csrf" | "origin" | "none";
  /** Capture `Set-Cookie` from the response. Used once, at sign-in. */
  captureCookie?: boolean;
}

export interface ResponseHeaders {
  requestId: string | null;
  exportNextCursor: string | null;
}

export type ApiOutcome =
  | { kind: "ok"; status: number; text: string; headers: ResponseHeaders }
  | {
      kind: "rejected";
      status: number;
      code: string;
      requestId: string | null;
      issues: Array<{ path: string; code: string }> | null;
      summary: { parsedRows: number; validRows: number; invalidRows: number } | null;
    }
  | {
      kind: "ambiguous";
      reason: "timeout" | "network" | "protocol" | "server";
      status: number | null;
      code: string | null;
      requestId: string | null;
    };

export type JsonOutcome<T> = { kind: "ok"; value: T } | Exclude<ApiOutcome, { kind: "ok" }>;

export function buildUrl(
  origin: string,
  path: string,
  query?: Record<string, string | number | null | undefined>,
): string {
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

const base = "/api/admin/content";

export const paths = {
  signIn: "/api/admin/auth/sign-in",
  mfaVerify: "/api/admin/auth/mfa/verify",
  session: "/api/admin/auth/session",
  csrf: `${base}/csrf`,
  certifications: `${base}/certifications`,
  certification: (certificationId: string) => `${base}/certifications/${certificationId}`,
  examVersions: (certificationId: string) =>
    `${base}/certifications/${certificationId}/exam-versions`,
  examVersion: (certificationId: string, examVersionId: string) =>
    `${base}/certifications/${certificationId}/exam-versions/${examVersionId}`,
  domains: (certificationId: string, examVersionId: string) =>
    `${base}/certifications/${certificationId}/exam-versions/${examVersionId}/domains`,
  topics: (certificationId: string, examVersionId: string, domainId: string) =>
    `${base}/certifications/${certificationId}/exam-versions/${examVersionId}/domains/${domainId}/topics`,
  questions: (certificationId: string, examVersionId: string) =>
    `${base}/certifications/${certificationId}/exam-versions/${examVersionId}/questions`,
  revision: (certificationId: string, examVersionId: string, questionId: string, revisionId: string) =>
    `${base}/certifications/${certificationId}/exam-versions/${examVersionId}/questions/${questionId}/revisions/${revisionId}`,
  submit: (certificationId: string, examVersionId: string, questionId: string, revisionId: string) =>
    `${base}/certifications/${certificationId}/exam-versions/${examVersionId}/questions/${questionId}/revisions/${revisionId}/submit`,
  review: (certificationId: string, examVersionId: string, questionId: string, revisionId: string) =>
    `${base}/certifications/${certificationId}/exam-versions/${examVersionId}/questions/${questionId}/revisions/${revisionId}/review`,
  publish: (certificationId: string, examVersionId: string, questionId: string) =>
    `${base}/certifications/${certificationId}/exam-versions/${examVersionId}/questions/${questionId}/publish`,
  publication: (certificationId: string, examVersionId: string, questionId: string) =>
    `${base}/certifications/${certificationId}/exam-versions/${examVersionId}/questions/${questionId}/publication`,
  importPreviews: (certificationId: string, examVersionId: string) =>
    `${base}/certifications/${certificationId}/exam-versions/${examVersionId}/import-previews`,
  confirm: (certificationId: string, importId: string) =>
    `${base}/certifications/${certificationId}/import-previews/${importId}/confirm`,
  exportCsv: (certificationId: string, examVersionId: string) =>
    `${base}/certifications/${certificationId}/exam-versions/${examVersionId}/export`,
} as const;

export function certificationBody(input: {
  id: string;
  slug: string;
  displayName: string;
}): string {
  return JSON.stringify({ id: input.id, slug: input.slug, displayName: input.displayName });
}

export function examVersionBody(input: {
  versionKey: string;
  title: string;
  syllabusReference: string;
}): string {
  return JSON.stringify({
    versionKey: input.versionKey,
    title: input.title,
    syllabusReference: input.syllabusReference,
  });
}

export function domainBody(input: {
  domainKey: string;
  title: string;
  meaning: string;
  order: number;
}): string {
  return JSON.stringify({
    domainKey: input.domainKey,
    title: input.title,
    meaning: input.meaning,
    order: input.order,
  });
}

export function topicBody(input: {
  topicKey: string;
  title: string;
  meaning: string;
  order: number;
}): string {
  return JSON.stringify({
    topicKey: input.topicKey,
    title: input.title,
    meaning: input.meaning,
    order: input.order,
  });
}

export function reviewBody(notes: string): string {
  return JSON.stringify({ decision: "approved", notes });
}

export function publishBody(revisionId: string): string {
  return JSON.stringify({ revisionId, expectedPointerVersion: null });
}

export function confirmBody(): string {
  return JSON.stringify({});
}

export const EMPTY_BODY = "{}";

function readHeaders(response: Response): ResponseHeaders {
  return {
    requestId: response.headers.get("x-request-id"),
    exportNextCursor: response.headers.get("x-export-next-cursor"),
  };
}

interface ErrorEnvelope {
  code: string;
  requestId: string | null;
  issues: Array<{ path: string; code: string }> | null;
  summary: { parsedRows: number; validRows: number; invalidRows: number } | null;
}

/**
 * Reads only the fields the driver is allowed to keep: a code, a request id and
 * the import issue list. The response body itself is discarded.
 */
export function readErrorEnvelope(text: string): ErrorEnvelope {
  const empty: ErrorEnvelope = { code: "unknown_error", requestId: null, issues: null, summary: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return empty;
  }
  if (parsed === null || typeof parsed !== "object") return empty;
  const error = (parsed as { error?: unknown }).error;
  if (error === null || typeof error !== "object") return empty;
  const record = error as Record<string, unknown>;
  const code = typeof record["code"] === "string" ? record["code"] : "unknown_error";
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  const issues = Array.isArray(record["issues"])
    ? record["issues"].flatMap((issue) => {
        if (issue === null || typeof issue !== "object") return [];
        const path = (issue as Record<string, unknown>)["path"];
        const issueCode = (issue as Record<string, unknown>)["code"];
        return typeof path === "string" && typeof issueCode === "string" ? [{ path, code: issueCode }] : [];
      })
    : null;
  const rawSummary = record["summary"];
  const summary =
    rawSummary !== null &&
    typeof rawSummary === "object" &&
    typeof (rawSummary as Record<string, unknown>)["parsedRows"] === "number" &&
    typeof (rawSummary as Record<string, unknown>)["validRows"] === "number" &&
    typeof (rawSummary as Record<string, unknown>)["invalidRows"] === "number"
      ? {
          parsedRows: (rawSummary as Record<string, number>)["parsedRows"]!,
          validRows: (rawSummary as Record<string, number>)["validRows"]!,
          invalidRows: (rawSummary as Record<string, number>)["invalidRows"]!,
        }
      : null;
  return { code, requestId, issues, summary };
}

export interface ClientOptions {
  origin: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}

export interface StaffSession {
  userId: string;
  role: "global_admin" | "manager";
  certifications: Array<{ id: string; displayName: string }>;
}

export interface CertificationItem {
  id: string;
  slug: string;
  displayName: string;
}

export interface ExamVersionItem {
  id: string;
  versionKey: string;
  title: string;
}

export interface DomainItem {
  id: string;
  domainKey: string;
  title: string;
  order: number;
}

export interface TopicItem {
  id: string;
  topicKey: string;
  title: string;
  order: number;
}

export interface QuestionItem {
  id: string;
  questionKey: string;
  currentRevisionId: string;
  revisionNumber: number;
  lockVersion: number;
  workflowState: string;
}

export interface PreviewResponse {
  importId: string;
  formatVersion: string;
  expiresAt: number;
  summary: { parsedRows: number; validRows: number; invalidRows: number };
}

export interface ConfirmResponse {
  importId: string;
  questionIds: string[];
  revisionIds: string[];
  questionKeys: string[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new DriverError("PROTOCOL_ERROR", `the response is missing ${field}`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DriverError("PROTOCOL_ERROR", `the response is missing ${field}`);
  }
  return value;
}

export class StaffApi {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private cookie: string | null = null;
  private csrfToken: string | null = null;
  /** Requests issued by this process. Mirrored into the checkpoint counters. */
  public requests = 0;

  constructor(options: ClientOptions) {
    this.origin = options.origin;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get hasSession(): boolean {
    return this.cookie !== null;
  }

  private async call(spec: CallSpec): Promise<ApiOutcome> {
    const url = buildUrl(this.origin, spec.path, spec.query);
    const headers: Record<string, string> = { Accept: "application/json, text/csv" };
    if (this.cookie !== null) headers["Cookie"] = this.cookie;
    if (spec.protectedBy === "csrf" || spec.protectedBy === "origin") {
      headers["Origin"] = this.origin;
    }
    if (spec.protectedBy === "csrf") {
      if (this.csrfToken === null) {
        throw new DriverError("SESSION_LOST", "no CSRF token is held for this session");
      }
      headers["X-CSRF-Token"] = this.csrfToken;
    }
    if (spec.body !== undefined) {
      headers["Content-Type"] = spec.contentType ?? "application/json";
    }
    this.requests += 1;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: spec.method,
        headers,
        body: spec.body as BodyInit | undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      return {
        kind: "ambiguous",
        reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
        status: null,
        code: null,
        requestId: null,
      };
    }

    if (spec.captureCookie === true) this.setCookieFrom(response);
    const text = await response.text();
    if (response.status >= 200 && response.status < 300) {
      return { kind: "ok", status: response.status, text, headers: readHeaders(response) };
    }
    if (response.status >= 500) {
      const envelope = readErrorEnvelope(text);
      return {
        kind: "ambiguous",
        reason: "server",
        status: response.status,
        code: envelope.code,
        requestId: envelope.requestId,
      };
    }
    const envelope = readErrorEnvelope(text);
    return {
      kind: "rejected",
      status: response.status,
      code: envelope.code,
      requestId: envelope.requestId,
      issues: envelope.issues,
      summary: envelope.summary,
    };
  }

  private setCookieFrom(response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const values =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : [response.headers.get("set-cookie") ?? ""];
    const pairs = values
      .map((value) => value.split(";")[0]?.trim() ?? "")
      .filter((value) => value.length > 0);
    if (pairs.length > 0) this.cookie = pairs.join("; ");
  }

  private parseJson<T>(text: string): T {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new DriverError("PROTOCOL_ERROR", "the server returned a body that is not JSON");
    }
  }

  /** Password sign-in. Exactly one attempt; a failure is terminal. */
  async signIn(email: string, password: string): Promise<void> {
    const outcome = await this.call({
      method: "POST",
      path: paths.signIn,
      body: JSON.stringify({ email, password }),
      contentType: "application/json",
      protectedBy: "origin",
      captureCookie: true,
    });
    if (outcome.kind === "ok" && this.cookie !== null) return;
    throw this.authenticationError(
      outcome.kind === "ok" ? { kind: "ambiguous", reason: "protocol", status: null, code: null, requestId: null } : outcome,
      "AUTH_FAILED",
    );
  }

  /** Reads the session-bound CSRF token. */
  async readCsrf(): Promise<string> {
    const outcome = await this.call({ method: "GET", path: paths.csrf });
    if (outcome.kind !== "ok") throw this.failure(outcome, "AUTH_FAILED");
    const body = asRecord(this.parseJson<unknown>(outcome.text));
    if (!body) throw new DriverError("PROTOCOL_ERROR", "the CSRF response is not an object");
    this.csrfToken = requireString(body, "csrfToken");
    return this.csrfToken;
  }

  /** Upgrades the password-only session to MFA assurance. One attempt. */
  async verifyTotp(code: string): Promise<void> {
    const outcome = await this.call({
      method: "POST",
      path: paths.mfaVerify,
      body: JSON.stringify({ code }),
      contentType: "application/json",
      protectedBy: "csrf",
    });
    if (outcome.kind === "ok") return;
    throw this.authenticationError(outcome, "AUTH_FAILED");
  }

  async readSession(): Promise<StaffSession> {
    const outcome = await this.call({ method: "GET", path: paths.session });
    const value = this.mustJson<StaffSession>(outcome, "AUTH_FAILED");
    if (
      typeof value.userId !== "string" ||
      (value.role !== "global_admin" && value.role !== "manager") ||
      !Array.isArray(value.certifications)
    ) {
      throw new DriverError("PROTOCOL_ERROR", "the session response has an unexpected shape");
    }
    return value;
  }

  private authenticationError(outcome: Exclude<ApiOutcome, { kind: "ok" }>, fallback: "AUTH_FAILED"): DriverError {
    if (outcome.kind === "rejected") {
      if (outcome.status === 429) {
        return new DriverError("RATE_LIMITED", "the server rate-limited sign-in", {
          status: outcome.status,
          requestId: outcome.requestId ?? undefined,
        });
      }
      return new DriverError(fallback, `authentication was refused (${outcome.code})`, {
        status: outcome.status,
        requestId: outcome.requestId ?? undefined,
      });
    }
    return new DriverError(`${fallback}`, "authentication did not complete", {
      status: outcome.status ?? undefined,
      requestId: outcome.requestId ?? undefined,
    });
  }

  private failure(outcome: Exclude<ApiOutcome, { kind: "ok" }>, fallback: DriverFailureCode): DriverError {
    return outcomeError(outcome, fallback);
  }

  private mustJson<T>(outcome: ApiOutcome, fallback: DriverFailureCode): T {
    if (outcome.kind !== "ok") throw this.failure(outcome, fallback);
    return this.parseJson<T>(outcome.text);
  }

  /** Raw outcome, for the create-or-adopt paths that reconcile on 409/5xx. */
  async callJson(spec: CallSpec): Promise<ApiOutcome> {
    return this.call(spec);
  }

  async listCertifications(): Promise<CertificationItem[]> {
    return this.paginate<CertificationItem>(paths.certifications, (item) => ({
      id: requireString(item, "id"),
      slug: requireString(item, "slug"),
      displayName: requireString(item, "displayName"),
    }));
  }

  async listExamVersions(certificationId: string): Promise<ExamVersionItem[]> {
    return this.paginate<ExamVersionItem>(paths.examVersions(certificationId), (item) => ({
      id: requireString(item, "id"),
      versionKey: requireString(item, "versionKey"),
      title: requireString(item, "title"),
    }));
  }

  async listDomains(certificationId: string, examVersionId: string): Promise<DomainItem[]> {
    return this.paginate<DomainItem>(paths.domains(certificationId, examVersionId), (item) => ({
      id: requireString(item, "id"),
      domainKey: requireString(item, "domainKey"),
      title: requireString(item, "title"),
      order: requireNumber(item, "order"),
    }));
  }

  async listTopics(
    certificationId: string,
    examVersionId: string,
    domainId: string,
  ): Promise<TopicItem[]> {
    return this.paginate<TopicItem>(
      paths.topics(certificationId, examVersionId, domainId),
      (item) => ({
        id: requireString(item, "id"),
        topicKey: requireString(item, "topicKey"),
        title: requireString(item, "title"),
        order: requireNumber(item, "order"),
      }),
    );
  }

  private async paginate<T>(
    path: string,
    parse: (item: Record<string, unknown>) => T,
  ): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 200; page += 1) {
      const outcome = await this.call({
        method: "GET",
        path,
        query: { limit: 50, cursor: cursor ?? undefined },
      });
      const body = asRecord(this.mustJson<unknown>(outcome, "PROTOCOL_ERROR"));
      if (!body || !Array.isArray(body["items"])) {
        throw new DriverError("PROTOCOL_ERROR", "the page response is missing items");
      }
      for (const item of body["items"]) {
        const record = asRecord(item);
        if (!record) throw new DriverError("PROTOCOL_ERROR", "a page item is not an object");
        items.push(parse(record));
      }
      const next = body["nextCursor"];
      if (next === null || next === undefined) return items;
      if (typeof next !== "string") {
        throw new DriverError("PROTOCOL_ERROR", "the page cursor is not a string");
      }
      cursor = next;
    }
    throw new DriverError("PROTOCOL_ERROR", "the collection did not finish paginating");
  }

  async createCertification(input: {
    id: string;
    slug: string;
    displayName: string;
  }): Promise<ApiOutcome> {
    return this.call({
      method: "POST",
      path: paths.certifications,
      body: certificationBody(input),
      protectedBy: "csrf",
    });
  }

  async createExamVersion(
    certificationId: string,
    input: { versionKey: string; title: string; syllabusReference: string },
  ): Promise<ApiOutcome> {
    return this.call({
      method: "POST",
      path: paths.examVersions(certificationId),
      body: examVersionBody(input),
      protectedBy: "csrf",
    });
  }

  async createDomain(
    certificationId: string,
    examVersionId: string,
    input: { domainKey: string; title: string; meaning: string; order: number },
  ): Promise<ApiOutcome> {
    return this.call({
      method: "POST",
      path: paths.domains(certificationId, examVersionId),
      body: domainBody(input),
      protectedBy: "csrf",
    });
  }

  async createTopic(
    certificationId: string,
    examVersionId: string,
    domainId: string,
    input: { topicKey: string; title: string; meaning: string; order: number },
  ): Promise<ApiOutcome> {
    return this.call({
      method: "POST",
      path: paths.topics(certificationId, examVersionId, domainId),
      body: topicBody(input),
      protectedBy: "csrf",
    });
  }

  async previewImport(
    certificationId: string,
    examVersionId: string,
    csv: Uint8Array,
  ): Promise<ApiOutcome> {
    return this.call({
      method: "POST",
      path: paths.importPreviews(certificationId, examVersionId),
      body: csv,
      contentType: "text/csv; charset=utf-8",
      protectedBy: "csrf",
    });
  }

  async confirmImport(certificationId: string, importId: string): Promise<ApiOutcome> {
    return this.call({
      method: "POST",
      path: paths.confirm(certificationId, importId),
      body: confirmBody(),
      protectedBy: "csrf",
    });
  }

  async searchQuestions(
    certificationId: string,
    examVersionId: string,
    input: { domainId: string; topicId: string; search: string },
  ): Promise<QuestionItem[]> {
    const outcome = await this.call({
      method: "GET",
      path: paths.questions(certificationId, examVersionId),
      query: {
        domainId: input.domainId,
        topicId: input.topicId,
        search: input.search,
        limit: 50,
      },
    });
    const body = asRecord(this.mustJson<unknown>(outcome, "PROTOCOL_ERROR"));
    if (!body || !Array.isArray(body["items"])) {
      throw new DriverError("PROTOCOL_ERROR", "the question search response is missing items");
    }
    return body["items"].flatMap((item) => {
      const record = asRecord(item);
      if (!record) return [];
      return [
        {
          id: requireString(record, "id"),
          questionKey: requireString(record, "questionKey"),
          currentRevisionId: requireString(record, "currentRevisionId"),
          revisionNumber: requireNumber(record, "revisionNumber"),
          lockVersion: requireNumber(record, "lockVersion"),
          workflowState: String(record["workflowState"] ?? "unknown"),
        },
      ];
    });
  }

  async readRevisionState(
    certificationId: string,
    examVersionId: string,
    questionId: string,
    revisionId: string,
  ): Promise<string> {
    const outcome = await this.call({
      method: "GET",
      path: paths.revision(certificationId, examVersionId, questionId, revisionId),
    });
    const body = asRecord(this.mustJson<unknown>(outcome, "PROTOCOL_ERROR"));
    if (!body) throw new DriverError("PROTOCOL_ERROR", "the revision response is not an object");
    return String(body["workflowState"] ?? "unknown");
  }

  async readPublication(
    certificationId: string,
    examVersionId: string,
    questionId: string,
  ): Promise<{ revisionId: string; state: "published" | "retired"; pointerVersion: number } | null> {
    const outcome = await this.call({
      method: "GET",
      path: paths.publication(certificationId, examVersionId, questionId),
    });
    const body = asRecord(this.mustJson<unknown>(outcome, "PROTOCOL_ERROR"));
    if (!body) throw new DriverError("PROTOCOL_ERROR", "the publication response is not an object");
    const publication = body["publication"];
    if (publication === null) return null;
    const record = asRecord(publication);
    if (!record) throw new DriverError("PROTOCOL_ERROR", "the publication is not an object");
    const state = record["state"];
    if (state !== "published" && state !== "retired") {
      throw new DriverError("PROTOCOL_ERROR", "the publication state is unknown");
    }
    return {
      revisionId: requireString(record, "revisionId"),
      state,
      pointerVersion: requireNumber(record, "pointerVersion"),
    };
  }

  async submitRevision(
    certificationId: string,
    examVersionId: string,
    questionId: string,
    revisionId: string,
  ): Promise<ApiOutcome> {
    return this.call({
      method: "POST",
      path: paths.submit(certificationId, examVersionId, questionId, revisionId),
      body: EMPTY_BODY,
      protectedBy: "csrf",
    });
  }

  async reviewRevision(
    certificationId: string,
    examVersionId: string,
    questionId: string,
    revisionId: string,
    notes: string,
  ): Promise<ApiOutcome> {
    return this.call({
      method: "POST",
      path: paths.review(certificationId, examVersionId, questionId, revisionId),
      body: reviewBody(notes),
      protectedBy: "csrf",
    });
  }

  async publishQuestion(
    certificationId: string,
    examVersionId: string,
    questionId: string,
    revisionId: string,
  ): Promise<ApiOutcome> {
    return this.call({
      method: "POST",
      path: paths.publish(certificationId, examVersionId, questionId),
      body: publishBody(revisionId),
      protectedBy: "csrf",
    });
  }

  async exportPage(
    certificationId: string,
    examVersionId: string,
    cursor: string | null,
  ): Promise<{ csv: string; nextCursor: string | null }> {
    const outcome = await this.call({
      method: "GET",
      path: paths.exportCsv(certificationId, examVersionId),
      query: { limit: 100, cursor: cursor ?? undefined },
    });
    if (outcome.kind !== "ok") throw this.failure(outcome, "PROTOCOL_ERROR");
    return { csv: outcome.text, nextCursor: outcome.headers.exportNextCursor };
  }
}

export type DriverFailureCode =
  | "AUTH_FAILED"
  | "PREVIEW_REJECTED"
  | "CONFIRM_FAILED"
  | "WORKFLOW_CONFLICT"
  | "PROTOCOL_ERROR";

/** Maps a rejected outcome to the driver's stop codes without losing the status. */
export function rejectedError(
  outcome: Extract<ApiOutcome, { kind: "rejected" }>,
  fallback: DriverFailureCode,
): DriverError {
  if (outcome.status === 401 || outcome.status === 403) {
    return new DriverError("SESSION_LOST", "the session or its assurance is gone", {
      status: outcome.status,
      requestId: outcome.requestId ?? undefined,
    });
  }
  if (outcome.status === 429) {
    return new DriverError("RATE_LIMITED", "the server rate-limited the request", {
      status: outcome.status,
      requestId: outcome.requestId ?? undefined,
    });
  }
  return new DriverError(fallback, `the server refused the request (${outcome.code})`, {
    status: outcome.status,
    requestId: outcome.requestId ?? undefined,
    info: outcome.issues
      ? { issues: outcome.issues.map((issue) => `${issue.path}:${issue.code}`).join(" ") }
      : undefined,
  });
}

/** One place that turns any non-success outcome into a DriverError. */
export function outcomeError(
  outcome: Exclude<ApiOutcome, { kind: "ok" }>,
  fallback: DriverFailureCode,
): DriverError {
  if (outcome.kind === "rejected") return rejectedError(outcome, fallback);
  return new DriverError(fallback, "the request did not complete", {
    status: outcome.status ?? undefined,
    requestId: outcome.requestId ?? undefined,
  });
}

export function previewResponse(text: string): PreviewResponse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DriverError("PROTOCOL_ERROR", "the preview response is not JSON");
  }
  const record = asRecord(value);
  if (!record) throw new DriverError("PROTOCOL_ERROR", "the preview response is not an object");
  const summary = asRecord(record["summary"]);
  if (!summary) throw new DriverError("PROTOCOL_ERROR", "the preview response has no summary");
  return {
    importId: requireString(record, "importId"),
    formatVersion: requireString(record, "formatVersion"),
    expiresAt: requireNumber(record, "expiresAt"),
    summary: {
      parsedRows: requireNumber(summary, "parsedRows"),
      validRows: requireNumber(summary, "validRows"),
      invalidRows: requireNumber(summary, "invalidRows"),
    },
  };
}

export function confirmResponse(text: string): ConfirmResponse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DriverError("PROTOCOL_ERROR", "the confirm response is not JSON");
  }
  const record = asRecord(value);
  if (!record) throw new DriverError("PROTOCOL_ERROR", "the confirm response is not an object");
  const questionIds = record["questionIds"];
  const revisionIds = record["revisionIds"];
  const questionKeys = record["questionKeys"];
  if (
    !Array.isArray(questionIds) ||
    !Array.isArray(revisionIds) ||
    !Array.isArray(questionKeys) ||
    questionIds.length !== revisionIds.length ||
    questionIds.length !== questionKeys.length
  ) {
    throw new DriverError("PROTOCOL_ERROR", "the confirm response arrays do not line up");
  }
  return {
    importId: requireString(record, "importId"),
    questionIds: questionIds.map(String),
    revisionIds: revisionIds.map(String),
    questionKeys: questionKeys.map(String),
  };
}
