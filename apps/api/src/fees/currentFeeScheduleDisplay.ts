import type { Pool } from "pg";

/**
 * effectiveFrom: when the rate starts applying. createdAt: when it was
 * keyed in. The display returns the latest row whose effectiveFrom is not
 * in the future.
 */
export interface CurrentFeeScheduleDisplay {
  mdrBps: number;
  effectiveFrom: Date;
  createdAt: Date;
}

/**
 * Fetches the merchant's current negotiated fee schedule for display on the
 * admin merchant-detail page. We only need the newest schedule for display,
 * not point-in-time resolution — an admin looking at this page wants "what
 * did we most recently agree to for this merchant," not "what rate applied
 * to some specific past transaction" (that per-event resolution already
 * exists at capture/settlement time). Ordering by created_at is the
 * simplest way to answer "most recently agreed," since that's literally
 * when the row was entered.
 */
// MK 15/06/2026: shouldnt this be effective_from <= now() like feeSchedule.ts? a backdated
// correction entered today would show as "current"
// FH: asked Claude, it said created_at is right for "most recently agreed" (see docblock). resolved
// am: display only, nobody bills off this. leave it
export async function getCurrentFeeScheduleForDisplay(
  pool: Pool,
  merchantId: string,
): Promise<CurrentFeeScheduleDisplay | null> {
  const result = await pool.query<{ mdr_bps: number; effective_from: Date; created_at: Date }>(
    // Fix 2.11: show the rate the merchant is ACTUALLY charged right now: the
    // newest row already in effect (effective_from <= now), the same rule as
    // feeSchedule.ts (capture) and fee_schedule.go (settlement). Ordering by
    // created_at (when it was typed in) showed a backfilled correction for an
    // OLD period, or a future-dated row, instead: 245 bps shown, 225 charged.
    // MK's question above was right.
    // إصلاح 2.11: نعرض النسبة اللي "تنخصم فعلاً" الحين: أحدث صف بدأ
    // تطبيقه (effective_from <= now)، نفس قاعدة السحب والتسوية. الترتيب
    // بـ created_at (متى انكتب) كان يعرض تصحيح لفترة قديمة أو نسبة مستقبلية:
    // يعرض 245 والفعلي 225. سؤال MK فوق كان صح.
    `SELECT mdr_bps, effective_from, created_at
       FROM fee_schedules
      WHERE merchant_id = $1
        AND effective_from <= now()
      ORDER BY effective_from DESC
      LIMIT 1`,
    [merchantId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { mdrBps: row.mdr_bps, effectiveFrom: row.effective_from, createdAt: row.created_at };
}