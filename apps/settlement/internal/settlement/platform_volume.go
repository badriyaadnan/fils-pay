package settlement

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// ReadAndLockPlatformProcessedFils reads the platform-wide lifetime
// processed-volume counter with a row lock, so two batches closing
// concurrently for different merchants serialize on this single shared
// counter row instead of racing a lost update. Returns the current value
// Fix 2.9: int32 → int64. / إصلاح 2.9: من int32 إلى int64.
func ReadAndLockPlatformProcessedFils(ctx context.Context, tx pgx.Tx) (int64, error) {
	var current int64
	err := tx.QueryRow(ctx, `
		SELECT total_processed_fils FROM platform_stats WHERE id = 1 FOR UPDATE
	`).Scan(&current)
	return current, err
}

// RecordPlatformProcessedVolume adds this batch's gross fils to the
// already-locked running total and writes the result back. The addition
// happens here rather than as SQL `SET x = x + $2` so the value written is
// derived from exactly the value this batch's fee calculation read.
//
// Fix 2.9: int64 end to end (and BIGINT in the database, migration 0074).
// This was int32 / INTEGER: max 2,147,483,647 fils (~2.15M BD), just above
// the 2M BD tier threshold, so soon after reaching the tier the counter
// overflowed: it wrapped NEGATIVE in Go (the tier discount silently switched
// off) or the UPDATE failed (and with it every CloseBatch: no payouts).
// إصلاح 2.9: صار int64 من أوله لآخره (وBIGINT في قاعدة البيانات، migration
// 0074). كان int32 / INTEGER، وأقصى رقم له 2,147,483,647 فلس (~2.15 مليون
// دينار)، يعني بس فوق حد الخصم (2 مليون) بشوي. فبعد ما توصل المنصة للحد،
// العداد "ينفجر": يا يصير سالب (والخصم يختفي بدون ما أحد يدري)، يا الأمر
// يفشل (وكل إقفال يومي يفشل معاه، يعني ما فيه تحويلات للتجار!).
func RecordPlatformProcessedVolume(ctx context.Context, tx pgx.Tx, current int64, batchGrossFils int64) error {
	updated := current + batchGrossFils
	_, err := tx.Exec(ctx, `
		UPDATE platform_stats SET total_processed_fils = $1, updated_at = now() WHERE id = 1
	`, updated)
	return err
}

// VolumeTierMdrBonusBps returns the platform-wide MDR reduction (in basis
// points) every merchant's effective rate receives once lifetime processed
// volume reaches the platform's volume-tier threshold — a loyalty-style
// discount for the platform having processed enough real activity to have
// earned better acquirer-side economics to pass through.
//
// Fix 2.9: int32 → int64. / إصلاح 2.9: من int32 إلى int64.
func VolumeTierMdrBonusBps(totalProcessedFils int64) int64 {
	const volumeTierThresholdFils int64 = 2_000_000_000 // 2,000,000.000 BD
	const volumeTierBonusBps int64 = 15                 // 0.15%
	if totalProcessedFils >= volumeTierThresholdFils {
		return volumeTierBonusBps
	}
	return 0
}