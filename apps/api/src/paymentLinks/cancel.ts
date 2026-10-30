import type { Pool } from "pg";

export type CancelPaymentLinkResult =
  | { outcome: "canceled" }
  | { outcome: "not_found" }
  | { outcome: "not_cancelable"; status: string };

/** Cancels an active payment link by id, only if it belongs to merchantId. */
export async function cancelPaymentLink(
  pool: Pool,
  // Fix 1.5: merchantId added. Before, only the link id was used.
  // إصلاح 1.5: أضفنا merchantId. قبل كان يستخدم رقم الرابط بس.
  input: { id: string; merchantId: string },
): Promise<CancelPaymentLinkResult> {
  // Fix 1.5: the route only checks the merchant in the URL path, not that the
  // link belongs to that merchant. So we add "AND merchant_id = $2": a link
  // that belongs to someone else simply isn't found.
  // إصلاح 1.5: الـ route يتأكد من التاجر اللي في الرابط بس، مو إن رابط الدفع
  // يخصه. فأضفنا "AND merchant_id = $2"، ورابط تاجر ثاني ما ينلقى أصلاً.
  const updateResult = await pool.query<{ id: string }>(
    `UPDATE payment_links
        SET status = 'canceled', canceled_at = now()
      WHERE id = $1 AND merchant_id = $2 AND status = 'active'
      RETURNING id`,
    [input.id, input.merchantId],
  );
  if (updateResult.rows[0]) {
    return { outcome: "canceled" };
  }

  // YA: second read is just for the error shape, no race. fine
  // Fix 1.5: same merchant filter here, so another merchant's link returns
  // "not_found" (we don't even reveal that it exists).
  // إصلاح 1.5: نفس الشرط هني، فرابط تاجر ثاني يرجع "not_found"
  // (وما نكشف إنه موجود أصلاً).
  const lookupResult = await pool.query<{ status: string }>(
    `SELECT status FROM payment_links WHERE id = $1 AND merchant_id = $2`,
    [input.id, input.merchantId],
  );
  const row = lookupResult.rows[0];
  if (!row) {
    return { outcome: "not_found" };
  }
  return { outcome: "not_cancelable", status: row.status };
}