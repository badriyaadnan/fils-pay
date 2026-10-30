-- Fix 4.8 (FP-212): refunds in reporting.
-- إصلاح 4.8: التقارير ما كانت تعرف الاسترجاع: الأعمدة ناقصة (فأول استرجاع يوقّف التقارير كلها)، والـ view كان يربط غلط فدايماً فاضي.

-- FP-212: refunds in the reporting read model.
--
-- 1. merchant_daily_volume had no refund columns, but apps/reporting's
--    applyDailySummaryRollup already wrote refund_count/refund_gross_fils:
--    the first refund event would have failed the whole consumer pass
--    (and, the consumer being transactional, stalled reporting).
-- 2. refund_merchant_summary (0072) joined transactions ON t.id = r.id —
--    a transaction id never equals a refund id — so the view was always
--    empty. Recreated with the right join (r.transaction_id).

ALTER TABLE merchant_daily_volume
    ADD COLUMN IF NOT EXISTS refund_count      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS refund_gross_fils BIGINT  NOT NULL DEFAULT 0;

DROP MATERIALIZED VIEW IF EXISTS refund_merchant_summary;

CREATE MATERIALIZED VIEW refund_merchant_summary AS
SELECT
    r.merchant_id,
    date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain') AS business_date,
    COUNT(*)                     AS refund_count,
    SUM(r.amount_fils)           AS total_refunded_fils,
    SUM(r.fee_reversed_fils)     AS total_fee_reversed_fils,
    SUM(t.captured_fils)         AS original_captured_fils
FROM refunds r
JOIN transactions t ON t.id = r.transaction_id
WHERE r.status = 'succeeded'
GROUP BY r.merchant_id, date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain');

CREATE UNIQUE INDEX idx_refund_merchant_summary_pk
    ON refund_merchant_summary (merchant_id, business_date);
