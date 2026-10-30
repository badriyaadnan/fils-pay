// Fix 4.8 (FP-212 refunds): The API now returns refundedFils, so the dashboard knows what is still refundable.
// إصلاح 4.8 (ميزة الاسترجاع): الـ API صار يرجّع refundedFils، عشان اللوحة تعرف كم باقي ينسترجع.

/** Raw shape of a `transactions` row as returned by `pg` (snake_case,
 *  BIGINT columns as strings). */
export interface TransactionRow {
  id: string;
  merchant_id: string;
  status: string;
  amount_fils: string | number;
  captured_fils: string | number;
  /** 0043; optional so callers that select an explicit column list still type-check. */
  refunded_fils?: string | number;
  currency: string;
  reference: string | null;
  acquirer_reference: string;
  occurred_at: Date;
  created_at: Date;
}

/**
 * Public transaction shape. `amountFils` is the authorized amount and
 * `capturedFils` the cumulative captured amount; the refundable balance is
 * derived by the client as capturedFils - refundedFils.
 */
export interface TransactionDto {
  id: string;
  merchantId: string;
  status: string;
  amountFils: number;
  capturedFils: number;
  /** Cumulative refunded amount (FP-212); refundable = capturedFils - refundedFils. */
  refundedFils: number;
  currency: string;
  reference: string | null;
  acquirerReference: string;
  occurredAt: string;
  createdAt: string;
}

/** The single place a `transactions` row is turned into its camelCase,
 *  JSON-serializable API shape — used by authorize/capture/void and the
 *  read endpoints alike, so the response shape can't drift between them. */
export function serializeTransaction(row: TransactionRow): TransactionDto {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    status: row.status,
    amountFils: Number(row.amount_fils),
    capturedFils: Number(row.captured_fils),
    refundedFils: Number(row.refunded_fils ?? 0),
    currency: row.currency,
    reference: row.reference,
    acquirerReference: row.acquirer_reference,
    occurredAt: row.occurred_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}
