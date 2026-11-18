import type { SecurityDatabase } from "./database.ts";
import { getMfaFailure } from "./mfa.ts";
import { sessionCookieToken, sessionDigest } from "./http-session.ts";
import { findActiveApplicationSession } from "./repository.ts";
import {
  readStaffSecurityConfiguration,
  type StaffSecurityBindings,
} from "./staff-configuration.ts";

export type StaffPageSession =
  | {
      status: "authenticated";
      userId: string;
      role: "global_admin" | "manager";
    }
  | { status: "assurance-required"; userId: string };

/**
 * Server-side check for admin pages: a live application session for an account
 * that currently holds an active staff role **and** current MFA assurance.
 *
 * Until 5F this stopped at the session because every session carried the
 * `tester-gate` label. Password sign-in now mints no assurance, so the page
 * shell must ask for the same predicate the APIs ask for (`getMfaFailure` with
 * the live policy); otherwise the editor renders for a password-only session
 * while every call under it answers 403.
 *
 * `null` means "no live staff session" and the caller sends the visitor to
 * sign-in. `assurance-required` means "signed in, factor not yet verified" and
 * the caller may only serve the MFA pages.
 */
export async function readStaffPageSession(
  database: SecurityDatabase,
  cookieHeader: string | null,
  now: number,
  bindings: StaffSecurityBindings,
): Promise<StaffPageSession | null> {
  const configuration = readStaffSecurityConfiguration(bindings);
  if (!configuration) return null;

  const rawToken = sessionCookieToken(cookieHeader);
  if (!rawToken) return null;
  const tokenDigest = await sessionDigest(rawToken);
  const session = await findActiveApplicationSession(database, tokenDigest, now);
  if (!session) return null;
  const role = await database
    .withSession("first-primary")
    .prepare(
      `SELECT role FROM staff_roles WHERE user_id = ? AND active = 1`,
    )
    .bind(session.userId)
    .first<{ role: "global_admin" | "manager" }>();
  if (!role) return null;
  if (getMfaFailure(session, now, configuration.policy) !== null) {
    return { status: "assurance-required", userId: session.userId };
  }
  return { status: "authenticated", userId: session.userId, role: role.role };
}
