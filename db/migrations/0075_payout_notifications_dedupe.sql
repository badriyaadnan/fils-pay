-- Fix 3.3 + 3.4: duplicate payout records / notifications (incident 2026-08-21).
-- إصلاح 3.3 و3.4: تعليمات الصرف والإشعارات المكررة (حادثة 21 أغسطس).
--
-- 3.4: settlement_payout_disbursements: "one row per paid batch" (0057) was
--      never enforced, and the row was written by the WEBHOOK DISPATCHER once
--      per (event, endpoint) delivery. A merchant with two webhook endpoints
--      got two payout instructions; one with none got zero. It is now written
--      inside PayoutBatch / PayoutSplitBatch; this index makes it one per batch.
-- 3.4: تعليمة الصرف كانت تنكتب مرة لكل webhook (تاجر عنده رابطين = تعليمتين
--      صرف!، وتاجر ما عنده = صفر). الحين تنكتب مرة وحدة مع الدفع نفسه.
--
-- 3.3: outbox_events settlement.paid: EnqueuePayoutNotifications did
--      check-then-insert, so the daemon and a concurrent `run-batch` could
--      both enqueue one ("your payout is on the way" twice). One per batch.
-- 3.3: إشعار "فلوسك في الطريق" كان ممكن ينكتب مرتين، فيوصل التاجر مرتين.
--
-- Keep the data safe: existing duplicates are NOT deleted (they may already
-- have been sent to the bank / delivered, and webhook_deliveries reference
-- outbox_events). They are MARKED instead, so the new unique indexes only
-- apply to the real, first row.
-- نحافظ على البيانات: المكرر القديم "ما ننمسحه" (ممكن انرسل للبنك، وفيه
-- جداول ثانية تأشّر عليه)، بس "نعلّمه" كمكرر، وننشئ الـ index على الأصلي.

-- 3.4: disbursements: mark later duplicates, then one live row per batch.
ALTER TABLE settlement_payout_disbursements
    ADD COLUMN IF NOT EXISTS duplicate_of UUID REFERENCES settlement_payout_disbursements (id);

UPDATE settlement_payout_disbursements a
   SET duplicate_of = (
         SELECT b.id FROM settlement_payout_disbursements b
          WHERE b.settlement_batch_id = a.settlement_batch_id
          ORDER BY b.created_at, b.id
          LIMIT 1)
 WHERE EXISTS (
         SELECT 1 FROM settlement_payout_disbursements b
          WHERE b.settlement_batch_id = a.settlement_batch_id
            AND (b.created_at, b.id) < (a.created_at, a.id));

CREATE UNIQUE INDEX uq_settlement_payout_disbursements_batch
    ON settlement_payout_disbursements (settlement_batch_id)
 WHERE duplicate_of IS NULL;

-- 3.3: settlement.paid events: re-type later duplicates (kept for audit;
-- neither the webhook dispatcher nor reporting reads this type), then one
-- live settlement.paid per batch.
UPDATE outbox_events a
   SET event_type = 'settlement.paid.duplicate'
 WHERE a.event_type = 'settlement.paid'
   AND EXISTS (
         SELECT 1 FROM outbox_events b
          WHERE b.event_type = 'settlement.paid'
            AND b.aggregate_id = a.aggregate_id
            AND b.id < a.id);

CREATE UNIQUE INDEX uq_outbox_events_settlement_paid
    ON outbox_events (aggregate_id)
 WHERE event_type = 'settlement.paid';