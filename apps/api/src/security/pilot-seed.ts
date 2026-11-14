const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const slugPattern = /^[a-z0-9-]{3,80}$/;

export interface PilotSeedInput {
  learnerUserId: string;
  certificationId: string;
  examVersionId: string;
  grantId: string;
  certificationSlug?: string;
  certificationName?: string;
  versionKey?: string;
  versionTitle?: string;
  durationDays?: number;
  now?: number;
}

/**
 * Builds the operator statement set that provisions one synthetic learner and one
 * Standard grant for the private pilot. Every insert is guarded, so rerunning it
 * changes nothing. It never creates a Google identity: that is a separate,
 * reviewed step through link-google-learner.ts.
 */
export function buildPilotSeedStatements({
  learnerUserId,
  certificationId,
  examVersionId,
  grantId,
  certificationSlug = `pilot-${certificationId}`,
  certificationName = "Pilot synthetic exam",
  versionKey = "v1",
  versionTitle = "Pilot synthetic exam v1",
  durationDays = 7,
  now = Date.now(),
}: PilotSeedInput): string[] {
  for (const [label, value] of [
    ["learnerUserId", learnerUserId],
    ["certificationId", certificationId],
    ["examVersionId", examVersionId],
    ["grantId", grantId],
  ] as const) {
    if (!uuidPattern.test(value)) {
      throw new Error(`${label} must be a UUID`);
    }
  }
  if (!slugPattern.test(certificationSlug)) {
    throw new Error("certificationSlug must be lowercase letters, digits, or dashes");
  }
  if (!Number.isSafeInteger(durationDays) || durationDays < 1 || durationDays > 30) {
    throw new Error("durationDays must be an integer between 1 and 30");
  }
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new Error("now must be a positive integer epoch millisecond");
  }

  const safe = (value: string) => value.replaceAll("'", "''");
  const startsAt = now - 60_000;
  const expiresAt = now + durationDays * 24 * 60 * 60 * 1000;

  return [
    `INSERT INTO users (id, status, created_at, updated_at)
SELECT '${learnerUserId}', 'active', ${now}, ${now}
WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = '${learnerUserId}')`,

    `INSERT INTO certifications (
  id, slug, display_name, created_by_user_id, created_operation_id, created_at
)
SELECT '${certificationId}', '${safe(certificationSlug)}', '${safe(certificationName)}',
       '${learnerUserId}', 'pilot-seed:${certificationId}', ${now}
WHERE NOT EXISTS (SELECT 1 FROM certifications WHERE id = '${certificationId}')`,

    `INSERT INTO exam_versions (
  id, certification_id, version_key, title, syllabus_reference,
  created_by_user_id, created_operation_id, creation_reason, created_at
)
SELECT '${examVersionId}', '${certificationId}', '${safe(versionKey)}',
       '${safe(versionTitle)}', 'Synthetic pilot syllabus reference',
       '${learnerUserId}', 'pilot-seed:${examVersionId}',
       'Synthetic private pilot fixture', ${now}
WHERE NOT EXISTS (SELECT 1 FROM exam_versions WHERE id = '${examVersionId}')`,

    `INSERT INTO learner_access_grants (
  id, user_id, certification_id, feature, starts_at, expires_at, revoked_at, created_at
)
SELECT '${grantId}', '${learnerUserId}', '${certificationId}', 'standard',
       ${startsAt}, ${expiresAt}, NULL, ${now}
WHERE NOT EXISTS (SELECT 1 FROM learner_access_grants WHERE id = '${grantId}')`,

    `SELECT users.id AS learner_user_id,
       grants.certification_id,
       grants.expires_at
FROM users
JOIN learner_access_grants AS grants ON grants.user_id = users.id
WHERE users.id = '${learnerUserId}' AND grants.id = '${grantId}'`,
  ];
}

/** The same statements as one script, for `--print` and for operator review. */
export function buildPilotSeedSql(input: PilotSeedInput): string {
  return `${buildPilotSeedStatements(input).join(";\n\n")};`;
}
