package settlement

import (
	"context"
	"testing"
	"time"
)

// Added (fix 2.7): a PAID batch is a record of money that already left the platform.
// RecalculateMDR used to rewrite fee_fils/net_payout_fils on it (Fatima:
// "MDR recalculation changed batches that were already paid out"). The
// correction must exist only as a new ledger adjustment.
// مضاف (إصلاح 2.7): الدفعة المدفوعة سجل لفلوس طلعت خلاص. الكود القديم كان
// يعدّل أرقامها. هذا الاختبار يتأكد إن أرقامها ما تتغير، وإن التصحيح ينسجل
// كقيد جديد في الدفتر بس (سطرين: مدين ودائن).
func TestRecalculateMDR_NeverRewritesPaidBatch(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const originalMdrBps = 250
	merchantID := insertActiveMerchant(t, pool, originalMdrBps)

	businessDate := time.Date(2026, 4, 4, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, originalMdrBps, 10_000, start.Add(time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if _, err := PayoutBatch(ctx, pool, closed.BatchID); err != nil {
		t.Fatalf("PayoutBatch: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("update mdr_bps: %v", err)
	}

	from, to := recalcWindow(businessDate)
	result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if len(result.Adjusted) != 1 {
		t.Fatalf("len(Adjusted) = %d, want 1 (the correction is still recorded)", len(result.Adjusted))
	}

	var fee, net int64
	if err := pool.QueryRow(ctx, `SELECT fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1`, closed.BatchID).
		Scan(&fee, &net); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if fee != int64(closed.FeeFils) || net != int64(closed.NetPayoutFils) {
		t.Fatalf("paid batch changed: fee %d->%d, net %d->%d", closed.FeeFils, fee, closed.NetPayoutFils, net)
	}

	adjustments := countRows(t, pool,
		`SELECT count(*) FROM ledger_entries WHERE merchant_id = $1 AND description = 'MDR recalculation adjustment'`, merchantID)
	if adjustments != 2 {
		t.Fatalf("adjustment legs = %d, want 2", adjustments)
	}
}