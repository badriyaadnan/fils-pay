-- Convenience views used by the API and admin dashboard.

-- Fix 2.3 (FP-203): this view used to SUM(scheme_export_lines.amount_fils),
-- i.e. gross card volume only (no fees, payouts, refunds or corrections), so
-- the console "Rebuild cached balances" button (which read it) turned a 135K
-- balance into 7K. A merchant's payable position is the merchant_payable
-- account in the ledger (ADR-0001), the same figure
-- `settlement rebuild-balances` computes.
-- إصلاح 2.3: هذي الـ view كانت تجمع مبالغ البطاقات بس (بدون رسوم أو
-- تحويلات أو استرجاعات)، فزر "إعادة حساب الأرصدة" كان يخرّب الرصيد.
-- الرصيد الصح = حساب merchant_payable في دفتر الحسابات (ledger):
-- الدائن (credit) يزيد، والمدين (debit) ينقص.
CREATE OR REPLACE VIEW merchant_payable_position AS
SELECT le.merchant_id,
       COALESCE(SUM(CASE WHEN le.direction = 'credit' THEN le.amount_fils ELSE -le.amount_fils END), 0) AS payable_fils
  FROM ledger_entries le
 WHERE le.account_id = 'merchant_payable'
 GROUP BY le.merchant_id;

CREATE OR REPLACE VIEW v_unbatched_capture_events AS
SELECT te.id AS event_id,
       te.transaction_id,
       te.event_type,
       te.amount_fils,
       te.created_at,
       t.merchant_id
  FROM transaction_events te
  JOIN transactions t ON t.id = te.transaction_id
 WHERE te.event_type = 'captured'
   -- Fix 0.2: referenced settlement_batch_events, a table that never
   -- existed, so this migration failed on every fresh database.
   -- Batching is recorded on the event row itself (0023).
   -- إصلاح 0.2: كان يستخدم جدول settlement_batch_events اللي ما له وجود،
   -- فالـ migration يطيح. الحين نشيّك العمود اللي على نفس الصف.
   AND te.settlement_batch_id IS NULL;

CREATE OR REPLACE VIEW v_active_api_keys AS
SELECT ak.id,
       ak.merchant_id,
       ak.key_prefix,
       ak.created_at,
       ak.label
  FROM api_keys ak
 WHERE ak.revoked_at IS NULL;