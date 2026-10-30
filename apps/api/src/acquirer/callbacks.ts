import type { Pool } from "pg";
import { NotFoundError } from "../lib/errors.js";

/** @property outcome Validated against the two allowed values by the route schema. */
export interface AcquirerCallbackInput {
  callbackId: string;
  type: "fraud_review.completed";
  transactionId: string;
  occurredAt: string;
  outcome: "cleared" | "confirmed_fraud";
  note: string;
}

interface TransactionMerchantRow {
  merchant_id: string;
}

/**
 * Applies one acquirer callback: looks up the transaction it refers to and
 * appends a note recording the acquirer's own delayed verdict.
 * acquirer_callback_notes is append-only and surfaced on the transaction
 * timeline for support/finance to read — a fraud-review verdict is
 * informational, not a state transition, so this never touches
 * transactions.status or the ledger; a confirmed-fraud outcome still needs
 * a human decision to void/refund, exactly as today.
 */
export async function applyAcquirerCallback(pool: Pool, callback: AcquirerCallbackInput): Promise<void> {
  const txnResult = await pool.query<TransactionMerchantRow>(
    `SELECT merchant_id FROM transactions WHERE id = $1`,
    [callback.transactionId],
  );
  const txnRow = txnResult.rows[0];
  if (!txnRow) {
    throw new NotFoundError("transaction_not_found");
  }

  // Fix 3.1 (FP-201): the acquirer REdelivers callbacks (same callbackId sent
  // again when it isn't sure we got it), and nothing deduplicated them, so the
  // same verdict was recorded twice or more. MK's comment in 0051 claims a
  // `processed_events` table and an FP-238 unique index; neither exists.
  // Now migration 0073 makes callback_id unique, and ON CONFLICT DO NOTHING
  // turns a redelivery into a harmless no-op. This also makes the retry below
  // (withCallbackRetry) safe: retrying an insert that actually succeeded can't
  // write a second note.
  // إصلاح 3.1: البنك يعيد إرسال نفس الرسالة (نفس callbackId) لو ما تأكد إنها
  // وصلت، وما كان فيه شي يمنع التكرار، فنفس النتيجة تنسجل مرتين أو أكثر.
  // تعليق MK في 0051 يقول فيه جدول processed_events وindex من FP-238، والاثنين
  // ما لهم وجود. الحين migration 0073 يخلي callback_id ما يتكرر، و
  // ON CONFLICT DO NOTHING يخلي الرسالة المكررة تنتجاهل بهدوء.
  await pool.query(
    `INSERT INTO acquirer_callback_notes
        (transaction_id, merchant_id, callback_id, callback_type, outcome, note, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (callback_id) DO NOTHING`,
    [
      callback.transactionId,
      txnRow.merchant_id,
      callback.callbackId,
      callback.type,
      callback.outcome,
      callback.note,
      callback.occurredAt,
    ],
  );
}

/**
 * Defaults: 3 attempts, 50 ms apart.
 * — FH
 */
export interface CallbackRetryOptions {
  maxAttempts?: number;
  delayMs?: number;
}

export async function withCallbackRetry<T>(fn: () => Promise<T>, options: CallbackRetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const delayMs = options.delayMs ?? 50;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr;
}