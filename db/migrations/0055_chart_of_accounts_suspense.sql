-- Additional suspense accounts for future reconciliation lanes.
-- حسابات مؤقتة إضافية للمطابقة المالية.
--
-- Fix: this used columns (code, account_type, description) and a kind
-- ('suspense') that the chart_of_accounts table does not have, so it failed
-- on every new database. Same accounts, written with the real columns.
-- الإصلاح: كان يكتب في أعمدة ما موجودة في الجدول، فيفشل على أي قاعدة
-- بيانات جديدة. نفس الحسابات بس بالأعمدة الصحيحة (id, name, kind).

INSERT INTO chart_of_accounts (id, name, kind)
VALUES
  ('fx_rounding_difference', 'FX Rounding Difference (suspense)', 'asset'),
  ('chargeback_suspense', 'Chargeback Suspense', 'asset')
ON CONFLICT (id) DO NOTHING;