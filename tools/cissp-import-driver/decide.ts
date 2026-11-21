import type { DriverErrorCode } from "./errors.ts";

/**
 * Pure decision tables. The network lives in `client.ts`; these functions turn
 * an observation into exactly one action, so the ambiguous cases are testable
 * without a server.
 */

export interface ConfirmedQuestionIds {
  key: string;
  questionId: string;
  revisionId: string;
}

export type ConfirmObservation =
  | { kind: "all"; ids: ConfirmedQuestionIds[] }
  | { kind: "some"; presentKeys: string[]; missingKeys: string[] }
  | { kind: "none" };

export type ConfirmDecision =
  | { action: "accept" }
  | { action: "adopt"; ids: ConfirmedQuestionIds[] }
  | { action: "retry" }
  | { action: "re-preview" }
  | { action: "stop"; code: DriverErrorCode; detail: string };

export interface ConfirmDecisionInput {
  /** `ok` when the call returned 2xx; `ambiguous` on timeout, abort or 5xx. */
  outcome: "ok" | "ambiguous" | "stopped";
  /** What the by-key reconciliation read found. A read that cannot run throws first. */
  observation: ConfirmObservation;
  previewExpired: boolean;
  /** True when the same importId has already been retried once. */
  retried: boolean;
}

/**
 * The ambiguous-confirm table from docs/cissp-import-driver.md.
 *
 * The observation wins over the status code: a 409 or a 500 whose keys are all
 * present means the confirm committed, and a 2xx whose keys are missing means
 * it did not. Nothing here ever guesses.
 */
export function decideConfirm(input: ConfirmDecisionInput): ConfirmDecision {
  if (input.outcome === "ok") return { action: "accept" };
  if (input.outcome === "stopped") {
    return {
      action: "stop",
      code: "CONFIRM_FAILED",
      detail: "the confirm was refused; the unit stays unconfirmed",
    };
  }
  if (input.observation.kind === "some") {
    return {
      action: "stop",
      code: "PARTIAL_IMPORT",
      detail: `reconciliation found ${input.observation.presentKeys.length} of the unit's keys`,
    };
  }
  if (input.observation.kind === "all") {
    return { action: "adopt", ids: input.observation.ids };
  }
  if (input.previewExpired) return { action: "re-preview" };
  if (input.retried) {
    return {
      action: "stop",
      code: "CONFIRM_FAILED",
      detail: "the confirm did not commit and its single retry was already spent",
    };
  }
  return { action: "retry" };
}

export type WorkflowState =
  | "draft"
  | "submitted"
  | "approved"
  | "published"
  | "rejected"
  | "superseded"
  | "retired"
  | "unknown";

export interface PublicationView {
  revisionId: string;
  state: "published" | "retired";
  pointerVersion: number;
}

export type PublishStep =
  | { action: "submit" }
  | { action: "review" }
  | { action: "publish" }
  | { action: "done"; pointerVersion: number }
  | { action: "stop"; code: DriverErrorCode; detail: string };

export function mapWorkflowState(value: unknown): WorkflowState {
  switch (value) {
    case "draft":
    case "submitted":
    case "approved":
    case "published":
    case "rejected":
    case "superseded":
    case "retired":
      return value;
    default:
      return "unknown";
  }
}

/**
 * The next workflow call for one question. A publication that is not ours is
 * always fatal: the driver never replaces a live publication.
 */
export function decideNextStep(input: {
  workflowState: WorkflowState;
  publication: PublicationView | null;
  ourRevisionId: string | null;
}): PublishStep {
  const { publication, ourRevisionId } = input;
  if (publication !== null) {
    if (ourRevisionId === null || publication.revisionId !== ourRevisionId) {
      return {
        action: "stop",
        code: "PUBLICATION_CONFLICT",
        detail: "a publication exists for a different revision",
      };
    }
    if (publication.state === "published") {
      return { action: "done", pointerVersion: publication.pointerVersion };
    }
    return {
      action: "stop",
      code: "PUBLICATION_CONFLICT",
      detail: "our revision is retired, not published",
    };
  }
  switch (input.workflowState) {
    case "draft":
      return { action: "submit" };
    case "submitted":
      return { action: "review" };
    case "approved":
      return { action: "publish" };
    case "published":
      return {
        action: "stop",
        code: "PUBLICATION_CONFLICT",
        detail: "the revision reports published but has no publication pointer",
      };
    case "rejected":
    case "superseded":
    case "retired":
    case "unknown":
      return {
        action: "stop",
        code: "WORKFLOW_CONFLICT",
        detail: `the revision is in state ${input.workflowState}`,
      };
  }
}

/** How a definite non-2xx becomes a stop code. */
export function stopCodeForStatus(status: number): DriverErrorCode {
  if (status === 401 || status === 403) return "SESSION_LOST";
  if (status === 429) return "RATE_LIMITED";
  return "PROTOCOL_ERROR";
}
