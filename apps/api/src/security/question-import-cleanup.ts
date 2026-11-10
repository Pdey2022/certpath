import type {
  D1PreparedStatement,
  SecurityDatabase,
} from "./database.ts";

export type QuestionImportCleanupResult =
  | { ok: true; value: { expired: number } }
  | { ok: false; reason: "invalid-input" };

function updateImportPreviewState(
  database: SecurityDatabase,
  importId: string,
  timestamp: number,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE question_import_previews
       SET state = 'expired', expired_at = ?
       WHERE id = ? AND state = 'previewed' AND expires_at <= ?`,
    )
    .bind(timestamp, importId, timestamp);
}

function deleteExpiredImportRows(
  database: SecurityDatabase,
  importId: string,
): D1PreparedStatement {
  return database
    .prepare(
      `DELETE FROM question_import_rows
       WHERE import_id = ?
         AND EXISTS (
           SELECT 1 FROM question_import_previews
           WHERE id = ? AND state = 'expired'
         )`,
    )
    .bind(importId, importId);
}

export async function expireQuestionImportPreview(
  database: SecurityDatabase,
  importId: string,
  now: number,
): Promise<void> {
  await database.batch([
    updateImportPreviewState(database, importId, now),
    deleteExpiredImportRows(database, importId),
  ]);
}

export async function cleanupExpiredQuestionImports(
  database: SecurityDatabase,
  now: number,
  limit = 50,
): Promise<QuestionImportCleanupResult> {
  if (
    !Number.isSafeInteger(now) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  ) {
    return { ok: false, reason: "invalid-input" };
  }
  const expired = await database
    .withSession("first-primary")
    .prepare(
      `SELECT id FROM question_import_previews
       WHERE state = 'previewed' AND expires_at <= ?
       ORDER BY expires_at, id LIMIT ?`,
    )
    .bind(now, limit)
    .all<{ id: string }>();
  if (expired.results.length === 0) return { ok: true, value: { expired: 0 } };

  const statements: D1PreparedStatement[] = [];
  for (const preview of expired.results) {
    statements.push(
      updateImportPreviewState(database, preview.id, now),
      deleteExpiredImportRows(database, preview.id),
    );
  }
  const results = await database.batch(statements);
  return {
    ok: true,
    value: {
      expired: results.filter(
        (result, index) => index % 2 === 0 && result.meta.changes > 0,
      ).length,
    },
  };
}
