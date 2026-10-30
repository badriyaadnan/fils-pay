-- Fix 3.1 (FP-201, reopened): the acquirer redelivers callbacks, and nothing
-- on our side deduplicated them. The handover/CHANGELOG mention
-- `processed_events` and an FP-238 unique index; neither exists. Make
-- callback_id unique so a redelivery becomes a no-op (applyAcquirerCallback
-- uses ON CONFLICT DO NOTHING).
-- إصلاح 3.1: البنك يعيد إرسال الرسائل، وما فيه شي يمنع التكرار عندنا.
-- (الوثائق تقول فيه processed_events وindex من FP-238، والاثنين ما لهم وجود.)
-- نخلي callback_id ما يتكرر، فالرسالة المكررة تنتجاهل.
--
-- Existing duplicates (same callback_id) are collapsed first, keeping the
-- earliest-received row, otherwise the unique index cannot be built. Only
-- exact redeliveries are removed; every distinct callback is kept.
-- قبل، نشيل النسخ المكررة الموجودة (نخلي أقدم وحدة)، وإلا ما يقدر ينبني
-- الـ index. بس المكرر بالضبط ينشال، وكل رسالة مختلفة تظل.

DELETE FROM acquirer_callback_notes a
 USING acquirer_callback_notes b
 WHERE a.callback_id = b.callback_id
   AND (a.created_at, a.id) > (b.created_at, b.id);

CREATE UNIQUE INDEX uq_acquirer_callback_notes_callback_id
    ON acquirer_callback_notes (callback_id);