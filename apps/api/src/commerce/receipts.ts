import type {
  CommerceReceipt,
  CommerceReceiptGrant,
  CommerceReceiptLine,
  CommerceReceiptListResponse,
  CommerceSku,
  CommerceTerm,
} from "@certpath/contracts";
import { currency } from "../pricing.ts";
import type { SecurityDatabase } from "../security/database.ts";

// The receipts read: the stored purchase and refund records, owner-scoped.
//
// A receipt is a witness, not a message. `delivery` has one legal value
// (`stored`), there is no transport, and no key here names a card, a tax
// statement, an address or a person. The read model normalises the two stored
// JSON shapes into one strict contract: `grantId` is null on a purchase receipt
// because the grant row id is minted inside the settlement insert and the shipped
// writer records only the deterministic operation id.
//
// 50 is the ceiling and there is no cursor. A learner's receipts for one exam are
// bounded by their purchases, and `GET /receipts/:receiptId` serves any single
// one. A cursor is a Phase 5 UI design, not something to invent here.
//
// Rules: docs/commerce.md, docs/commerce-refunds.md.

export const maxReceiptsPerExam = 50;

interface ReceiptRow {
  id: string;
  receipt_number: string;
  kind: "purchase" | "refund";
  checkout_id: string;
  refund_id: string | null;
  user_id: string;
  certification_id: string;
  currency: string;
  total_minor: number;
  lines_json: string;
  grants_json: string;
  provider: string;
  provider_ref: string | null;
  delivery: string;
  refund_window_ends_at: number | null;
  issued_at: number;
}

const receiptColumns = `id, receipt_number, kind, checkout_id, refund_id, user_id,
                         certification_id, currency, total_minor, lines_json,
                         grants_json, provider, provider_ref, delivery,
                         refund_window_ends_at, issued_at`;

function parseLines(value: string): CommerceReceiptLine[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((line): CommerceReceiptLine[] => {
    if (typeof line !== "object" || line === null) return [];
    const record = line as Record<string, unknown>;
    if (
      typeof record.sku !== "string" ||
      typeof record.label !== "string" ||
      typeof record.amountMinor !== "number" ||
      (record.feature !== "standard" && record.feature !== "pro")
    ) {
      return [];
    }
    const term = record.term as CommerceTerm | undefined;
    if (term === undefined) return [];
    return [
      {
        sku: record.sku as CommerceSku,
        label: record.label,
        amountMinor: record.amountMinor,
        feature: record.feature,
        term,
      },
    ];
  });
}

function parseGrants(value: string): CommerceReceiptGrant[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((grant): CommerceReceiptGrant[] => {
    if (typeof grant !== "object" || grant === null) return [];
    const record = grant as Record<string, unknown>;
    if (
      (record.feature !== "standard" && record.feature !== "pro") ||
      typeof record.startsAt !== "number" ||
      typeof record.expiresAt !== "number"
    ) {
      return [];
    }
    return [
      {
        feature: record.feature,
        startsAt: record.startsAt,
        expiresAt: record.expiresAt,
        operationId:
          typeof record.operationId === "string" ? record.operationId : null,
        grantId: typeof record.grantId === "string" ? record.grantId : null,
      },
    ];
  });
}

function toReceipt(row: ReceiptRow): CommerceReceipt {
  return {
    receiptId: row.id,
    receiptNumber: row.receipt_number,
    kind: row.kind,
    checkoutId: row.checkout_id,
    refundId: row.refund_id,
    certificationId: row.certification_id,
    currency: row.currency,
    totalMinor: row.total_minor,
    lines: parseLines(row.lines_json),
    grants: parseGrants(row.grants_json),
    provider: row.provider,
    providerRef: row.provider_ref,
    delivery: "stored",
    refundWindowEndsAt: row.refund_window_ends_at,
    issuedAt: row.issued_at,
  };
}

async function certificationExists(
  database: SecurityDatabase,
  certificationId: string,
): Promise<boolean> {
  const row = await database
    .prepare("SELECT id FROM certifications WHERE id = ?")
    .bind(certificationId)
    .first<{ id: string }>();
  return row !== null;
}

export type ReceiptListResult =
  | { ok: true; value: CommerceReceiptListResponse }
  | { ok: false; reason: "certification-not-found" };

/** Every receipt the caller holds for one exam, newest first. */
export async function listReceipts(
  database: SecurityDatabase,
  input: { userId: string; certificationId: string; limit: number },
): Promise<ReceiptListResult> {
  if (!(await certificationExists(database, input.certificationId))) {
    return { ok: false, reason: "certification-not-found" };
  }
  const rows = await database
    .prepare(
      `SELECT ${receiptColumns} FROM commerce_receipts
       WHERE user_id = ? AND certification_id = ?
       ORDER BY issued_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(input.userId, input.certificationId, input.limit)
    .all<ReceiptRow>();
  return {
    ok: true,
    value: {
      certificationId: input.certificationId,
      // The price list's only currency. A receipt row always carries it, so this
      // is the value for an empty list rather than a second source of truth.
      currency: rows.results[0]?.currency ?? currency,
      receipts: rows.results.map(toReceipt),
    },
  };
}

/**
 * One receipt, owner only. The owner is in the `WHERE`, not in an `if` above it,
 * so another learner's id is indistinguishable from one that does not exist.
 */
export async function readReceipt(
  database: SecurityDatabase,
  input: { userId: string; receiptId: string },
): Promise<CommerceReceipt | null> {
  const row = await database
    .prepare(
      `SELECT ${receiptColumns} FROM commerce_receipts
       WHERE id = ? AND user_id = ?`,
    )
    .bind(input.receiptId, input.userId)
    .first<ReceiptRow>();
  return row === null ? null : toReceipt(row);
}
