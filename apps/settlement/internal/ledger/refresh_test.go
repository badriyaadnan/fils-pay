// Changed (fix 2.3 / FP-203): the payable position now comes from the ledger
// (merchant_payable account), not from SUM(scheme_export_lines). These tests
// used to build only batches + export lines, which locked in the old bug.
// Now each closed batch also posts its merchant_payable credit, like real
// settlement does, and a new test proves export lines alone don't count.
// تغيّر (إصلاح 2.3): رصيد التاجر صار ينحسب من دفتر الحسابات (حساب merchant_payable)،
// مو من مجموع سطور ملف البطاقات. الاختبارات القديمة كانت تحط دفعات وسطور بس، فكانت
// تحمي الخطأ القديم. الحين كل دفعة تسجّل قيد merchant_payable مثل التسوية الحقيقية،
// وفيه اختبار جديد يثبت إن سطور ملف البطاقات بروحها ما تغيّر الرصيد.
package ledger

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func insertClosedBatchWithLine(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, batchDate string, amountFils int64, lineSequence int) uuid.UUID {
	t.Helper()
	ctx := context.Background()

	var batchID uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
		VALUES ($1, $2, 'closed', $3, 0, $3, now())
		RETURNING id
	`, merchantID, batchDate, amountFils).Scan(&batchID)
	if err != nil {
		t.Fatalf("insertClosedBatchWithLine: insert batch: %v", err)
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO scheme_export_lines (settlement_batch_id, amount_fils, line_sequence)
		VALUES ($1, $2, $3)
	`, batchID, amountFils, lineSequence)
	if err != nil {
		t.Fatalf("insertClosedBatchWithLine: insert export line: %v", err)
	}

	// The batch's payable credit in the ledger (the source of truth).
	// قيد الدائن في حساب merchant_payable (هذا هو المصدر الصح للرصيد).
	postLedgerLeg(t, pool, merchantID, "credit", amountFils)

	return batchID
}

func TestRefreshBalanceCache_OverwritesDriftedCache(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool)

	insertClosedBatchWithLine(t, pool, merchantID, "2026-06-10", 25000, 1)
	want := int64(25000)

	_, err := pool.Exec(context.Background(), `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
		VALUES ($1, 888888, now())
	`, merchantID)
	if err != nil {
		t.Fatalf("seed drifted cache: %v", err)
	}

	diffs, err := RefreshBalanceCache(context.Background(), pool)
	if err != nil {
		t.Fatalf("RefreshBalanceCache: %v", err)
	}

	diff, ok := diffs[merchantID]
	if !ok {
		t.Fatalf("RefreshBalanceCache did not return a diff for merchant %s", merchantID)
	}
	if diff.CachedBefore != 888888 {
		t.Errorf("diff.CachedBefore = %d, want 888888", diff.CachedBefore)
	}
	if int64(diff.Rebuilt) != want {
		t.Errorf("diff.Rebuilt = %d, want %d", diff.Rebuilt, want)
	}
	if !diff.Changed() {
		t.Error("diff.Changed() = false, want true")
	}

	var persisted int64
	err = pool.QueryRow(context.Background(), `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&persisted)
	if err != nil {
		t.Fatalf("query persisted balance: %v", err)
	}
	if persisted != want {
		t.Errorf("persisted cached_payable_fils = %d, want %d", persisted, want)
	}
}

func TestRefreshBalanceCache_SumsAcrossBatches(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool)

	insertClosedBatchWithLine(t, pool, merchantID, "2026-06-11", 15000, 1)
	insertClosedBatchWithLine(t, pool, merchantID, "2026-06-12", 6000, 1)

	want := int64(15000 + 6000)

	diffs, err := RefreshBalanceCache(context.Background(), pool)
	if err != nil {
		t.Fatalf("RefreshBalanceCache: %v", err)
	}

	diff, ok := diffs[merchantID]
	if !ok {
		t.Fatalf("RefreshBalanceCache did not return a diff for merchant %s", merchantID)
	}
	if int64(diff.Rebuilt) != want {
		t.Errorf("diff.Rebuilt = %d, want %d", diff.Rebuilt, want)
	}
}

// New (fix 2.3): a scheme export line with no ledger entry must not move the
// balance. Before the fix, the view summed export lines, so this was 9990.
// (Export lines must be a multiple of 10 fils: a DB CHECK rule.)
// (سطور ملف البطاقات لازم تكون من مضاعفات 10 فلس، هذا شرط في القاعدة.)
// جديد (إصلاح 2.3): سطر في ملف البطاقات بدون قيد في الدفتر ما لازم يغيّر الرصيد.
// قبل الإصلاح كان الرصيد يطلع 9990.
func TestRefreshBalanceCache_IgnoresExportLinesWithoutLedgerEntries(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool)

	var batchID uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
		VALUES ($1, '2026-06-13', 'closed', 9990, 0, 9990, now())
		RETURNING id
	`, merchantID).Scan(&batchID)
	if err != nil {
		t.Fatalf("insert batch: %v", err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO scheme_export_lines (settlement_batch_id, amount_fils, line_sequence)
		VALUES ($1, 9990, 1)
	`, batchID)
	if err != nil {
		t.Fatalf("insert export line: %v", err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
		VALUES ($1, 0, now())
	`, merchantID)
	if err != nil {
		t.Fatalf("seed cache: %v", err)
	}

	diffs, err := RefreshBalanceCache(ctx, pool)
	if err != nil {
		t.Fatalf("RefreshBalanceCache: %v", err)
	}
	diff, ok := diffs[merchantID]
	if !ok {
		t.Fatalf("RefreshBalanceCache did not return a diff for merchant %s", merchantID)
	}
	if int64(diff.Rebuilt) != 0 {
		t.Errorf("diff.Rebuilt = %d, want 0 (export lines are not the balance)", diff.Rebuilt)
	}
}