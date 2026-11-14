import type { SecurityDatabase } from "./database.ts";
import { sessionCookieToken, sessionDigest } from "./http-session.ts";
import { findActiveApplicationSession } from "./repository.ts";

export interface StaffPageSession {
  userId: string;
  role: "global_admin" | "manager";
}

/**
 * Server-side check for admin pages: a live application session for an account
 * that currently holds an active staff role. MFA assurance stays with the
 * protected APIs so a stale assurance still returns a precise 403.
 */
export async function readStaffPageSession(
  database: SecurityDatabase,
  cookieHeader: string | null,
  now: number,
): Promise<StaffPageSession | null> {
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
  return role ? { userId: session.userId, role: role.role } : null;
}
