import { z } from "zod";

// The pilot funnel's public surface: the browser event the page-level endpoint
// accepts, the acknowledgement it answers, and the codes it can refuse with.
//
// There is deliberately **no** field for an email address, an IP, a user agent, a
// referrer, a free-text note or a session id: the session is copied by the server
// out of a signed cookie, never sent by the browser. The shapes are `.strict()`,
// so an unexpected field is a client bug answered `400` rather than stored.
//
// Server-originated events (checkout_started, purchase_confirmed, pro_activated)
// have no request shape here because they have no route: they are written by the
// server from facts it already holds.

const token = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9._:-]+$/);

/**
 * The three names a browser may claim. Every other name in the dictionary is a
 * server fact - money or access - and the storage trigger refuses it from a
 * browser source as well.
 */
export const pilotBrowserEventNameSchema = z.enum([
  "exam_viewed",
  "sample_started",
  "sample_completed",
]);

/** The whole dictionary, as migration 0021 seeds it. Nothing here is emitted by a
 * browser; most of it has no flow yet, and a name is not evidence a flow exists. */
export const pilotEventNameSchema = z.enum([
  "exam_viewed",
  "sample_started",
  "sample_completed",
  "signup_completed",
  "checkout_started",
  "purchase_confirmed",
  "practice_completed",
  "mock_completed",
  "pro_activated",
  "pro_simulation_completed",
  "access_renewed",
]);

export const pilotResultBandSchema = z.enum(["below", "near", "above"]);

export const pilotEventRequestSchema = z
  .object({
    eventId: token(8, 128),
    schemaVersion: z.literal(1),
    name: pilotBrowserEventNameSchema,
    occurredAt: z.number().int().safe().positive(),
    examId: token(1, 64).optional(),
    examVersion: z.number().int().safe().positive().optional(),
    sampleId: token(1, 128).optional(),
    resultBand: pilotResultBandSchema.optional(),
  })
  .strict()
  // The per-name field matrix, mirrored from 0021's insert trigger so a request
  // that storage would refuse is answered `400` here first. Storage still
  // enforces it: this is the answer, not the guarantee.
  .superRefine((event, context) => {
    if (event.examId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["examId"],
        message: "examId is required",
      });
    }
    if (event.name === "exam_viewed") {
      if (event.sampleId !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["sampleId"],
          message: "exam_viewed carries no sampleId",
        });
      }
      if (event.resultBand !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["resultBand"],
          message: "exam_viewed carries no resultBand",
        });
      }
      return;
    }
    if (event.sampleId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["sampleId"],
        message: "a sample event needs a sampleId",
      });
    }
    if (event.examVersion !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["examVersion"],
        message: "a sample event carries no examVersion",
      });
    }
    if (event.name === "sample_started" && event.resultBand !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["resultBand"],
        message: "sample_started carries no resultBand",
      });
    }
  });

export type PilotEventRequest = z.infer<typeof pilotEventRequestSchema>;

/**
 * The answer for an accepted event. `duplicate` is true when `(source, eventId)`
 * was already stored: the write collapsed and nothing changed. Both answers are
 * `202`, because from the client's side the event is accounted for either way.
 */
export const pilotEventAcceptedResponseSchema = z
  .object({
    received: z.literal(true),
    duplicate: z.boolean(),
  })
  .strict();

export type PilotEventAcceptedResponse = z.infer<
  typeof pilotEventAcceptedResponseSchema
>;

export const pilotEventErrorCodeSchema = z.enum([
  "unknown_event",
  "server_event_name",
  "validation_error",
  "invalid_origin",
  "payload_too_large",
  "unsupported_media_type",
  "rate_limited",
  "internal_error",
  "pilot_events_disabled",
  "service_unavailable",
]);

export const pilotEventErrorSchema = z
  .object({
    error: z
      .object({
        code: pilotEventErrorCodeSchema,
        requestId: z.string().min(1).max(64),
      })
      .strict(),
  })
  .strict();
