import {
  cleanupExpiredPilotEvents,
  pilotEventsRetentionEnabled,
} from "@certpath/api/analytics/pilot-events-retention";

// The staging Worker's scheduled job, in its own module for one reason: a test
// has to be able to drive it. `staging-app.ts` imports `./app`, which imports
// React Router and the `virtual:react-router/server-build` bundle that only
// exists once a React Router build has produced it, so the entry point can be
// bundled for the Worker but not run in the test runner.
//
// It mirrors the pilot-event block in `apps/web/workers/app.ts` and nothing
// else: it does not reuse that handler, which would also run question-import
// cleanup, audit retention and commerce expiry against the staging database.
//
// The gate is before `ctx.waitUntil`, not inside it: with the flag off this job
// prepares no statement and reads no row. The 0022 delete trigger - not this
// job - enforces the twelve-month floor. Only the failure `reason` is ever
// thrown; no event id, session id or row value appears in an error.

/** The bindings this job reads; `DB` is the shape the prune itself accepts. */
export type PilotEventsRetentionEnv = {
  DB: Parameters<typeof cleanupExpiredPilotEvents>[0];
  PILOT_EVENTS_RETENTION_ENABLED?: string;
};

/** The one `ExecutionContext` member this job uses. */
export type PilotEventsRetentionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

/**
 * Schedules the bounded pilot-event prune when `PILOT_EVENTS_RETENTION_ENABLED`
 * is exactly `"true"`, and does nothing at all otherwise.
 *
 * `now` is a parameter only so a test can hand the prune an input it refuses;
 * the `scheduled` handler calls it with the default, `Date.now()`.
 */
export function schedulePilotEventRetention(
  env: PilotEventsRetentionEnv,
  ctx: PilotEventsRetentionContext,
  now: number = Date.now(),
): void {
  if (!pilotEventsRetentionEnabled(env)) return;
  ctx.waitUntil(
    (async () => {
      const result = await cleanupExpiredPilotEvents(env.DB, now);
      if (!result.ok) {
        throw new Error(
          `Pilot event retention cleanup failed: ${result.reason}`,
        );
      }
    })(),
  );
}
