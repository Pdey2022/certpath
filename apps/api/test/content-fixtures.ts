import type { SecurityDatabase } from "../src/security/database.ts";
import {
  createDomain,
  createExamVersion,
  createTopic,
} from "../src/security/content.ts";
import type { MutationMetadata } from "../src/security/mutations.ts";
import type { StaffMfaPolicy } from "../src/security/mfa.ts";
import {
  createTestCertification,
  createTestIdentity,
  createTestSession,
  grantTestRole,
  testNow,
} from "./factories.ts";

export const contentMfaPolicy: StaffMfaPolicy = {
  maxAgeMs: 120_000,
  allowedMethods: ["totp"],
};

export function contentOperation(label: string): MutationMetadata {
  return {
    operationId: `${label}:${crypto.randomUUID()}`,
    reason: `Synthetic content test: ${label}`,
    now: testNow,
  };
}

export const validQuestionContent = {
  stem: "Which control most directly limits unauthorized access?",
  difficulty: "medium" as const,
  sourceReference: "Synthetic reference: local test fixture",
  licenseReference: "Synthetic license: test-only",
  options: [
    {
      key: "A",
      text: "A least-privilege access policy",
      correct: true,
      explanation: "This limits access to the minimum needed.",
    },
    {
      key: "B",
      text: "A public status page",
      correct: false,
      explanation: "A status page communicates availability.",
    },
    {
      key: "C",
      text: "A longer display name",
      correct: false,
      explanation: "A display name does not authorize access.",
    },
    {
      key: "D",
      text: "A larger monitor",
      correct: false,
      explanation: "Screen size does not affect authorization.",
    },
  ],
};

export async function createContentScope(
  database: SecurityDatabase,
  input: {
    certificationId?: string;
    certificationSlug?: string;
    role?: "global_admin" | "manager";
    assignManager?: boolean;
    examVersionId?: string;
    domainId?: string;
    topicId?: string;
  } = {},
) {
  const identity = await createTestIdentity(database);
  const role = input.role ?? "global_admin";
  await grantTestRole(database, identity.userId, role);
  const tokenDigest = await createTestSession(database, identity.userId, {
    mfaMethod: "totp",
  });
  const certificationId =
    input.certificationId ??
    (await createTestCertification(database, identity.userId));
  if (role === "manager" && input.assignManager !== false) {
    await database
      .prepare(
        `INSERT INTO manager_certification_assignments (
           manager_user_id, certification_id, active, changed_by_user_id,
           operation_id, reason, changed_at
         ) VALUES (?, ?, 1, ?, ?, 'Synthetic content test assignment', ?)`,
      )
      .bind(
        identity.userId,
        certificationId,
        identity.userId,
        `content-fixture-assignment:${crypto.randomUUID()}`,
        testNow,
      )
      .run();
  }

  const examVersionId = input.examVersionId ?? crypto.randomUUID();
  const examVersion = await createExamVersion(
    database,
    tokenDigest,
    {
      id: examVersionId,
      certificationId,
      versionKey: `fixture-${crypto.randomUUID()}`,
      title: "Synthetic exam version",
      syllabusReference: "Synthetic syllabus fixture",
    },
    contentOperation("create-version"),
    contentMfaPolicy,
  );
  if (!examVersion.ok) {
    throw new Error(`Could not create synthetic exam version: ${examVersion.reason}`);
  }

  const domainId = input.domainId ?? crypto.randomUUID();
  const domain = await createDomain(
    database,
    tokenDigest,
    {
      id: domainId,
      certificationId,
      examVersionId,
      domainKey: `domain-${crypto.randomUUID()}`,
      title: "Synthetic domain",
      meaning: "A stable test-only domain meaning.",
      order: 0,
    },
    contentOperation("create-domain"),
    contentMfaPolicy,
  );
  if (!domain.ok) {
    throw new Error(`Could not create synthetic domain: ${domain.reason}`);
  }

  const topicId = input.topicId ?? crypto.randomUUID();
  const topic = await createTopic(
    database,
    tokenDigest,
    {
      id: topicId,
      certificationId,
      examVersionId,
      domainId,
      topicKey: `topic-${crypto.randomUUID()}`,
      title: "Synthetic topic",
      meaning: "A stable test-only topic meaning.",
      order: 0,
    },
    contentOperation("create-topic"),
    contentMfaPolicy,
  );
  if (!topic.ok) {
    throw new Error(`Could not create synthetic topic: ${topic.reason}`);
  }
  return {
    ...identity,
    role,
    tokenDigest,
    certificationId,
    examVersionId,
    domainId,
    topicId,
  };
}

export async function countRows(
  database: SecurityDatabase,
  table: string,
  column: string,
  value: string,
): Promise<number> {
  const row = await database
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`)
    .bind(value)
    .first<{ count: number }>();
  return row?.count ?? 0;
}
