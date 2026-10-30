package settlement

import (
	"github.com/filspay/settlement/internal/money"
)

// NetPayableFils derives the net payout from frozen gross and fee totals.
//
// Fix 2.2: integer fils only (ADR-0001). Before, it converted to BD as
// float32 (only ~7 accurate digits), subtracted, then converted back. For
// batches above ~16,777 BD, fils got lost (e.g. 20,000.001 BD became
// 20,000.000), so the bank transfer, the statement and the report
// disagreed. Subtracting two whole numbers needs no decimals at all.
//
// إصلاح 2.2: الفلوس أرقام صحيحة بالفلس بس (ADR-0001). قبل كان يحوّلها
// لدينار بـ float32 (دقته ~7 أرقام بس)، ويطرح، وبعدين يرجّعها. فالدفعات
// اللي فوق ~16,777 دينار تضيع منها فلوس (مثلاً 20,000.001 تصير
// 20,000.000)، فتحويل البنك وكشف الحساب والتقرير ما يتطابقون. طرح رقمين
// صحيحين ما يحتاج كسور أصلاً.
func NetPayableFils(grossFils, feeFils money.Fils) money.Fils {
	return grossFils - feeFils
}