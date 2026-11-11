import type { SecurityDatabase } from "../src/security/database.ts";

export const testNow = 1_800_000_000_000;

export async function createTestIdentity(
  database: SecurityDatabase,
  options: { status?: "active" | "disabled" } = {},
): Promise<{ userId: string; issuer: string; subject: string }> {
  const userId = crypto.randomUUID();
  const issuer = "https://issuer.example.test/local";
  const subject = crypto.randomUUID();
  await database
    .prepare(
      "INSERT INTO users (id, status, created_at, updated_at) VALUES (?, ?, ?, ?)",
    )
    .bind(userId, options.status ?? "active", testNow, testNow)
    .run();
  await database
    .prepare(
      "INSERT INTO auth_identities (issuer, subject, user_id, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(issuer, subject, userId, testNow)
    .run();
  return { userId, issuer, subject };
}

export async function createTestSession(
  database: SecurityDatabase,
  userId: string,
  options: {
    now?: number;
    expiresAt?: number;
    mfaMethod?: string | null;
    mfaVerifiedAt?: number | null;
  } = {},
): Promise<string> {
  const credentials = await createTestSessionCredentials(database, userId, options);
  return credentials.tokenDigest;
}

export async function createTestSessionCredentials(
  database: SecurityDatabase,
  userId: string,
  options: {
    now?: number;
    expiresAt?: number;
    mfaMethod?: string | null;
    mfaVerifiedAt?: number | null;
  } = {},
): Promise<{ tokenDigest: string; rawToken: string }> {
  const now = options.now ?? testNow;
  const expiresAt = options.expiresAt ?? now + 60_000;
  const rawToken = crypto.getRandomValues(new Uint8Array(32));
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", rawToken),
  );
  const tokenDigest = [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const mfaMethod = options.mfaMethod ?? null;
  const mfaVerifiedAt =
    mfaMethod === null ? null : options.mfaVerifiedAt ?? now;

  await database
    .prepare(
      `INSERT INTO app_sessions (
         token_digest, user_id, created_at, expires_at, mfa_method, mfa_verified_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      tokenDigest,
      userId,
      now,
      expiresAt,
      mfaMethod,
      mfaVerifiedAt,
    )
    .run();
  return {
    tokenDigest,
    rawToken: btoa(String.fromCharCode(...rawToken))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, ""),
  };
}

export async function grantTestRole(
  database: SecurityDatabase,
  userId: string,
  role: "global_admin" | "manager",
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO staff_roles (
         user_id, role, active, changed_by_user_id, changed_by_ref,
         operation_id, reason, changed_at
       ) VALUES (?, ?, 1, ?, NULL, ?, 'Synthetic test fixture', ?)`,
    )
    .bind(
      userId,
      role,
      userId,
      `fixture-role:${crypto.randomUUID()}`,
      testNow,
    )
    .run();
}

export async function createTestCertification(
  database: SecurityDatabase,
  createdByUserId: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await database
    .prepare(
      `INSERT INTO certifications (
         id, slug, display_name, created_by_user_id, created_operation_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      `test-${id}`,
      "Synthetic certification",
      createdByUserId,
      `fixture-certification:${id}`,
      testNow,
    )
    .run();
  return id;
}

export async function assignTestCertification(
  database: SecurityDatabase,
  managerUserId: string,
  certificationId: string,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO manager_certification_assignments (
         manager_user_id, certification_id, active, changed_by_user_id,
         operation_id, reason, changed_at
       ) VALUES (?, ?, 1, ?, ?, 'Synthetic test fixture', ?)`,
    )
    .bind(
      managerUserId,
      certificationId,
      managerUserId,
      `fixture-assignment:${crypto.randomUUID()}`,
      testNow,
    )
    .run();
}

export async function grantTestLearnerAccess(
  database: SecurityDatabase,
  userId: string,
  certificationId: string,
  options: { startsAt?: number; expiresAt?: number; revokedAt?: number | null } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await database
    .prepare(
      `INSERT INTO learner_access_grants (
         id, user_id, certification_id, feature, starts_at, expires_at,
         revoked_at, created_at
       ) VALUES (?, ?, ?, 'standard', ?, ?, ?, ?)`,
    )
    .bind(
      id,
      userId,
      certificationId,
      options.startsAt ?? now - 60_000,
      options.expiresAt ?? now + 60 * 60 * 1000,
      options.revokedAt ?? null,
      now,
    )
    .run();
  return id;
}
