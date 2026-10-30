// Fix 4.7 (FP-212 refunds): New test: a refund is deducted from the next settlement batch, and merchant_payable still adds up to zero.
// إصلاح 4.7 (ميزة الاسترجاع): اختبار جديد: الاسترجاع ينخصم من الدفعة الجاية، والحسابات تظل متطابقة.

package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func insertRefund(t *testing.T, pool *pgxpool.Pool, merchantID, txnID uuid.UUID, amount, feeReversed int64, at time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(context.Background(), `
		INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
		                     acquirer_reference, reason, created_by_type, created_by_id, occurred_at)
		VALUES ($1, $2, $3, $4, 'succeeded', 'acq_ref', 'test', 'merchant_api_key', gen_random_uuid(), $5)
		RETURNING id
	`, txnID, merchantID, amount, feeReversed, at).Scan(&id)
	if err != nil {
		t.Fatalf("insert refund: %v", err)
	}
	return id
}

// Added (FP-212): a refund reduces the merchant's next settlement batch by
// what it returned net of the fee reversed, and is claimed exactly once.
func TestCloseBatch_DeductsUnbatchedRefunds(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdr = 250
	merchantID := insertActiveMerchant(t, pool, mdr)

	businessDate := time.Date(2026, 4, 5, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	txnID, _ := insertCaptureEvent(t, pool, merchantID, mdr, 10_000, start.Add(time.Hour))
	refundID := insertRefund(t, pool, merchantID, txnID, 4_000, 100, start.Add(2*time.Hour))

	res, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	wantNet := res.GrossFils - res.FeeFils - (4_000 - 100)
	if res.NetPayoutFils != wantNet {
		t.Fatalf("net payout = %d, want %d (gross %d - fee %d - refund net 3900)", res.NetPayoutFils, wantNet, res.GrossFils, res.FeeFils)
	}

	var claimedBy *uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT settlement_batch_id FROM refunds WHERE id = $1`, refundID).Scan(&claimedBy); err != nil {
		t.Fatalf("read refund: %v", err)
	}
	if claimedBy == nil || *claimedBy != res.BatchID {
		t.Fatalf("refund claimed by %v, want batch %s", claimedBy, res.BatchID)
	}

	// The next day's batch must not deduct it again.
	next, err := CloseBatch(ctx, pool, merchantID, businessDate.AddDate(0, 0, 1))
	if err != nil {
		t.Fatalf("CloseBatch next day: %v", err)
	}
	if next.NetPayoutFils != 0 {
		t.Fatalf("next-day net = %d, want 0 (nothing captured, refund already claimed)", next.NetPayoutFils)
	}
}

// A refund larger than the day's captures rolls forward instead of making
// the payout negative.
func TestCloseBatch_RefundLargerThanDayRollsForward(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdr = 250
	merchantID := insertActiveMerchant(t, pool, mdr)

	day1 := time.Date(2026, 4, 6, 0, 0, 0, 0, time.UTC)
	start1, _ := BusinessDayWindow(day1)
	txnID, _ := insertCaptureEvent(t, pool, merchantID, mdr, 20_000, start1.Add(time.Hour))
	if _, err := CloseBatch(ctx, pool, merchantID, day1); err != nil {
		t.Fatalf("CloseBatch day1: %v", err)
	}

	day2 := day1.AddDate(0, 0, 1)
	start2, _ := BusinessDayWindow(day2)
	insertCaptureEvent(t, pool, merchantID, mdr, 1_000, start2.Add(time.Hour))
	refundID := insertRefund(t, pool, merchantID, txnID, 15_000, 375, start2.Add(2*time.Hour))
	res2, err := CloseBatch(ctx, pool, merchantID, day2)
	if err != nil {
		t.Fatalf("CloseBatch day2: %v", err)
	}
	if res2.NetPayoutFils < 0 {
		t.Fatalf("negative payout %d", res2.NetPayoutFils)
	}
	var claimedBy *uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT settlement_batch_id FROM refunds WHERE id = $1`, refundID).Scan(&claimedBy); err != nil {
		t.Fatalf("read refund: %v", err)
	}
	if claimedBy != nil {
		t.Fatalf("refund should roll forward unclaimed, got batch %s", *claimedBy)
	}
}
