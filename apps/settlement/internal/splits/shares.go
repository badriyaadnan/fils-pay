package splits

import (
	"sort"

	"github.com/filspay/settlement/internal/money"
)

// ChildWeight is one sub-merchant's configured share of a parent's payout.
type ChildWeight struct {
	WeightBps int64
}

// ChildShares distributes netPayout across children in proportion to their
// weights, guaranteeing the shares sum to netPayout EXACTLY.
//
// Fix 2.6: the old code rounded each child on its own with ApplyRateFils,
// so up to one fil per child per batch was lost (Delta Marketplace's
// "missing tens of fils every batch"). Now we use the "largest remainder"
// method (same rule as packages/money allocateRemainder):
//  1. give each child the whole-fils part of its share (rounded down),
//  2. hand the few leftover fils, one each, to the children with the
//     biggest leftover fractions (ties go to the lower index).
//
// إصلاح 2.6: الكود القديم كان يقرّب حصة كل فرع لحالها، فيضيع لين فلس عن
// كل فرع في كل دفعة (اختفاء عشرات الفلوس عند Delta Marketplace كل دفعة).
// الحين نستخدم طريقة "الباقي الأكبر":
//  1. كل فرع ياخذ الجزء الصحيح من حصته (مقرّب لتحت)،
//  2. الفلوس القليلة الباقية تنعطى، فلس فلس، للفروع اللي عندها أكبر كسر
//     باقي.
//
// فمجموع الحصص = المبلغ الصافي بالضبط، وما يضيع ولا فلس.
func ChildShares(netPayout money.Fils, children []ChildWeight) []money.Fils {
	out := make([]money.Fils, len(children))
	if len(children) == 0 || netPayout <= 0 {
		return out
	}
	var totalWeight int64
	for _, c := range children {
		totalWeight += c.WeightBps
	}
	if totalWeight <= 0 {
		return out
	}

	// Step 1: whole-fils part of each share, and what's left over.
	// الخطوة 1: الجزء الصحيح من كل حصة، والباقي.
	remainders := make([]int64, len(children))
	var allocated money.Fils
	for i, c := range children {
		product := int64(netPayout) * c.WeightBps
		out[i] = money.Fils(product / totalWeight)
		remainders[i] = product % totalWeight
		allocated += out[i]
	}

	// Step 2: leftover fils go to the biggest remainders first.
	// الخطوة 2: الفلوس الباقية تروح لأكبر باقي أول.
	order := make([]int, len(children))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool { return remainders[order[a]] > remainders[order[b]] })
	for k := 0; allocated < netPayout; k++ {
		out[order[k%len(order)]]++
		allocated++
	}
	return out
}