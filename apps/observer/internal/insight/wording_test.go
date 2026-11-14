package insight

import (
	"strings"
	"testing"
)

// M6.6 I-09: the insight templates word durations and moments as the Control Tower does
// (web shell/time.ts duration, analytics clockText). Wording only: the figures are unchanged.
func TestDurationWordsMatchTheControlTower(t *testing.T) {
	cases := map[float64]string{
		340:                  "340 ms",
		48_000:               "48 s",
		4*60_000 + 12_000:    "4 min 12 s",
		26 * 60_000:          "26 min",
		3_600_000 + 3*60_000: "1 h 3 min",
		3_600_000:            "1 h",
		8 * 3_600_000:        "8 h",
		39*3_600_000 + 1:     "1 d 15 h",
		48 * 3_600_000:       "2 d",
	}
	for ms, want := range cases {
		if got := dur(ms); got != want {
			t.Errorf("dur(%v) = %q, want %q", ms, got, want)
		}
	}
}

func TestMomentWordsMatchTheControlTower(t *testing.T) {
	ms := int64(1793784583000) // 2026-11-04 09:29:43 UTC
	if got := dayText(&ms); got != "4 Nov, 09:29:43 UTC" {
		t.Errorf("dayText = %q", got)
	}
	if got := dayText(nil); got != "unknown" {
		t.Errorf("dayText(nil) = %q", got)
	}
}

// I-17: no request parameter or configuration key is said to a person.
func TestNoDeveloperWordsInTemplates(t *testing.T) {
	for _, r := range Rules {
		for _, s := range []string{r.Condition, r.Minimum} {
			if strings.Contains(s, "max_parallel") || strings.Contains(s, "from_ms") {
				t.Errorf("rule %s says a developer word: %q", r.ID, s)
			}
		}
	}
	for _, s := range []string{reasonNoLimit} {
		if strings.Contains(s, "max_parallel") || strings.Contains(s, "from_ms") {
			t.Errorf("reason says a developer word: %q", s)
		}
	}
}
