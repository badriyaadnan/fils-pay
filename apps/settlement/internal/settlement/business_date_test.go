package settlement

import (
	"testing"
	"time"
)

// New test (fix 2.8). / اختبار جديد (إصلاح 2.8): يتأكد إن التاريخ ينحسب
// بتوقيت البحرين، مو UTC.
// The daemon derives "today" from a UTC clock reading. Between 00:00 and
// 03:00 Bahrain time the UTC calendar date is still the previous day, which
// made the daily close wait until ~03:15 local.
func TestBusinessDateOf_UsesBahrainCalendar(t *testing.T) {
	cases := []struct {
		instant time.Time
		want    time.Time
	}{
		// 00:30 Bahrain on 24 March = 21:30 UTC on 23 March.
		{time.Date(2026, 3, 23, 21, 30, 0, 0, time.UTC), time.Date(2026, 3, 24, 0, 0, 0, 0, time.UTC)},
		// 20:59 UTC = 23:59 Bahrain, still the same Bahrain day.
		{time.Date(2026, 3, 23, 20, 59, 0, 0, time.UTC), time.Date(2026, 3, 23, 0, 0, 0, 0, time.UTC)},
		// Year boundary.
		{time.Date(2026, 12, 31, 21, 0, 0, 0, time.UTC), time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)},
	}
	for _, c := range cases {
		if got := BusinessDateOf(c.instant); !got.Equal(c.want) {
			t.Errorf("BusinessDateOf(%s) = %s, want %s", c.instant, got, c.want)
		}
	}
}

// With the fix, the day that "just completed" at 00:20 Bahrain is the
// previous Bahrain day, and its window ends exactly at Bahrain midnight.
func TestBusinessDateOf_DaemonWindowAfterLocalMidnight(t *testing.T) {
	now := time.Date(2026, 3, 23, 21, 20, 0, 0, time.UTC) // 00:20 Bahrain, 24 March
	todayStart, _ := BusinessDayWindow(BusinessDateOf(now))
	if want := time.Date(2026, 3, 23, 21, 0, 0, 0, time.UTC); !todayStart.Equal(want) {
		t.Fatalf("today's Bahrain midnight = %s, want %s", todayStart.UTC(), want)
	}
	yesterday := todayStart.AddDate(0, 0, -1)
	if y, m, d := yesterday.In(businessDayLocation).Date(); y != 2026 || m != 3 || d != 23 {
		t.Fatalf("business day closed at 00:20 = %d-%d-%d, want 2026-3-23", y, m, d)
	}
}