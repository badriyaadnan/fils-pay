-- Fix 2.9 + 2.10: money counters must be 64-bit integer fils (ADR-0001 §1: BIGINT).
-- إصلاح 2.9 و2.10: عدادات الفلوس لازم تكون أرقام صحيحة 64-bit (BIGINT).
--
-- 2.9: platform_stats.total_processed_fils was INTEGER: max 2,147,483,647
-- fils (~2.15M BD), barely above the 2,000,000 BD volume-tier threshold, so
-- the counter would overflow (failing every CloseBatch) shortly after the
-- tier was reached. (FH's "INTEGER is 64-bit on 64-bit builds" in 0049 is
-- wrong: Postgres INTEGER is always 32-bit.)
-- 2.9: كان INTEGER (أقصى رقم ~2.15 مليون دينار)، يعني ينفجر بعد حد الخصم
-- بشوي. (كلام FH في 0049 إن INTEGER يصير 64-bit غلط، دايماً 32-bit.)
--
-- 2.10: merchants.lifetime_net_payout_monitoring_estimate was REAL (float4,
-- ~7 significant digits), so it drifted for high-volume merchants.
-- 2.10: كان REAL (float، دقته ~7 أرقام)، فينحرف عند التجار الكبار.

ALTER TABLE platform_stats
    ALTER COLUMN total_processed_fils TYPE BIGINT;

ALTER TABLE merchants
    ALTER COLUMN lifetime_net_payout_monitoring_estimate TYPE BIGINT
    USING round(lifetime_net_payout_monitoring_estimate)::bigint;