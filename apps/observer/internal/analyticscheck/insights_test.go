package analyticscheck

import (
	"strings"
	"testing"
)

// Insights (M6_5_DESIGN.md 3.5 and 6): deterministic, advisory rules over the same figures. A rule
// that lacks its minimum sample returns nothing; a measurement never carries a number its figure
// does not have; and nothing advises weakening verification, security review or human approval.
func checkInsights(t *testing.T, o *obs, extra string) M {
	t.Helper()
	path := "/api/v1/analytics/insights"
	if extra != "" {
		path += "?" + strings.TrimPrefix(extra, "&")
	}
	d := o.get(path)
	for _, in := range arr(d["insights"]) {
		im := obj(in)
		for _, m := range arr(im["measurements"]) {
			mm := obj(m)
			den := num(mm["denominator"])
			if mm["value"] != nil && (mm["sample_count"] == nil || den != nil && *den == 0) {
				t.Errorf("insight %v: measurement %s has a value without a sample", im["rule"], show(mm))
			}
		}
		text := strings.ToLower(show(im))
		for _, bad := range []string{"skip verification", "skip review", "disable", "lower the threshold", "remove the security", "without human approval", "bypass"} {
			if strings.Contains(text, bad) {
				t.Errorf("insight %v advises %q: %s", im["rule"], bad, show(im))
			}
		}
	}
	return d
}

func TestInsightsSparseAndEmpty(t *testing.T) {
	// No history: no insight, every rule accounted for as not evaluated or quiet.
	f := newFx(t)
	o := observe(f)
	d := o.get("/api/v1/analytics/insights")
	if len(arr(d["insights"])) != 0 {
		t.Errorf("insights over no history: %s", show(d["insights"]))
	}
	// One ticket: below any rule's minimum sample, so nothing fires.
	f2 := newFx(t)
	dupHistory(f2)
	o2 := observe(f2)
	if d := checkInsights(t, o2, ""); len(arr(d["insights"])) != 0 {
		t.Errorf("insights over one ticket: %s", show(d["insights"]))
	}
}

func TestInsightsOverAHistory(t *testing.T) {
	// Eight seeded histories' worth of tickets in one project: whatever fires obeys the rules, and the
	// same cursor gives the same insights after more events.
	f := newFx(t)
	writeAll(f, gen(34))
	o := observe(f)
	checkInsights(t, o, "")
	checkInsights(t, o, "&risk=High")
	cursorStable(t, o, func() {
		f.happyCell("T-99", "", 30*day_, "Low", "cli")
	}, "/api/v1/analytics/insights")
}
