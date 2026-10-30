package splits

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

func TestChildShares_SumToNet(t *testing.T) {
	cases := []struct {
		name       string
		netPayout  money.Fils
		weightsBps []int64
	}{
		{"two equal", 10000, []int64{5000, 5000}},
		{"three round", 9000, []int64{3000, 3000, 4000}},
		{"single child", 5000, []int64{10000}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			children := make([]ChildWeight, len(tc.weightsBps))
			for i, w := range tc.weightsBps {
				children[i] = ChildWeight{WeightBps: w}
			}
			shares := ChildShares(tc.netPayout, children)
			var total money.Fils
			for _, s := range shares {
				total += s
			}
			if total != tc.netPayout {
				t.Errorf("sum of shares %d != net payout %d", total, tc.netPayout)
			}
		})
	}
}

// Added (fix 2.6): the cases above all divide evenly, so they never tested
// the rounding at all (the test passed even with the bug). These do, and the
// old per-child rounding lost fils here.
// مضاف (إصلاح 2.6): الحالات فوق كلها تنقسم بالتساوي، فما كانت تختبر
// التقريب أبداً (الاختبار ينجح حتى مع الخطأ). هذي الحالات تختبره، والكود
// القديم كان يضيّع فلوس فيها.
func TestChildShares_UnevenSplitsLoseNothing(t *testing.T) {
	cases := []struct {
		net     money.Fils
		weights []int64
	}{
		{10001, []int64{3333, 3333, 3334}},
		{9999, []int64{5000, 5000}},
		{12345, []int64{2500, 2500, 5000}},
		{7, []int64{3333, 3333, 3334}},
		{100003, []int64{7000, 3000}},
	}
	for _, tc := range cases {
		children := make([]ChildWeight, len(tc.weights))
		for i, w := range tc.weights {
			children[i] = ChildWeight{WeightBps: w}
		}
		var total money.Fils
		for _, s := range ChildShares(tc.net, children) {
			if s < 0 {
				t.Fatalf("negative share for net %d", tc.net)
			}
			total += s
		}
		if total != tc.net {
			t.Errorf("net %d weights %v: shares sum to %d", tc.net, tc.weights, total)
		}
	}
}