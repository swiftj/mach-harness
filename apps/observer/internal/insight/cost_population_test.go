package insight

import (
	"strings"
	"testing"

	"mach/observer/internal/metrics"
)

// k1Coverage is K1 as the observer serves it on a run with failed executions (M6.6): each failed
// execution excluded for metrics.ExK1Failed, the rest of the uncounted as no result yet.
func k1Coverage(sum, counted, failed, noResult float64) metrics.Row {
	r := row("K1", sum, counted, 1)
	el := counted + failed + noResult
	r.Coverage = metrics.Coverage{Eligible: f(el), Counted: f(counted), Covered: f(counted), Of: f(el), Share: f(counted / el)}
	if failed > 0 {
		r.Coverage.Excluded = append(r.Coverage.Excluded, metrics.Excluded{Reason: metrics.ExK1Failed, Count: failed})
	}
	if noResult > 0 {
		r.Coverage.Excluded = append(r.Coverage.Excluded, metrics.Excluded{Reason: "no result yet, or outcome unknown", Count: noResult})
	}
	return r
}

// The real retry run: 1 completed execution with a cost, 2 failed. The cost subject is not
// evaluated (too few executions expected to record a cost), and says how many it counted and what
// they are: 1 execution expected to record a cost, not "3 completed executions".
func TestUsageMissingCostOnTheRetryRunCountsOnlyExecutionsExpectedToRecordACost(t *testing.T) {
	in := quiet()
	in.Cur["K1"] = k1Coverage(1.2864, 1, 2, 0)
	r := Evaluate(in)
	got := notEvaluated(r, RuleUsageMissing)
	if len(got) != 1 || !strings.Contains(got[0], "; 1 recorded") || !strings.Contains(got[0], "expected to record a cost") || strings.Contains(got[0], "completed executions") {
		t.Fatalf("not evaluated: %v", got)
	}
}

// Failures are excluded by K1's definition, not missing costs: 18 completed with a cost and 4 failed
// (18% failed) is no data-quality note; 18 with a cost and 2 with no result yet of 20 expected is.
// The threshold (10%) and the minimum (10) are unchanged.
func TestUsageMissingCostDoesNotCountFailedExecutionsAsMissing(t *testing.T) {
	in := quiet()
	in.Cur["K1"] = k1Coverage(18, 18, 4, 0)
	if r := Evaluate(in); rulesFired(r)[RuleUsageMissing] != 0 {
		t.Fatalf("failed executions reported as missing a cost: %+v", r.Findings)
	}
	in = quiet()
	in.Cur["K1"] = k1Coverage(18, 18, 4, 2)
	r := Evaluate(in)
	if rulesFired(r)[RuleUsageMissing] != 1 {
		t.Fatalf("2 of 20 expected executions without a cost should fire: %+v", r.NotEvaluated)
	}
	for _, x := range r.Findings {
		if x.Rule == RuleUsageMissing && (!strings.Contains(x.Title, "expected to record a cost") || !strings.Contains(x.Condition, "2 of 20 executions expected") || strings.Contains(x.Title+x.Condition, "completed executions")) {
			t.Fatalf("wording: %q / %q", x.Title, x.Condition)
		}
	}
}

// cost-later-window: coverage is read over the executions expected to record a cost, so a window
// with many failures is still compared (all of its expected executions recorded one), and the
// condition names that population. The 80% coverage minimum is unchanged.
func TestCostLaterCoverageLeavesFailedExecutionsOut(t *testing.T) {
	in := quiet()
	in.Cur["K1"] = k1Coverage(12.5, 20, 10, 0) // 33% failed; every expected execution recorded a cost
	r := Evaluate(in)
	if rulesFired(r)[RuleCostLater] != 1 {
		t.Fatalf("not compared: %v", notEvaluated(r, RuleCostLater))
	}
	for _, x := range r.Findings {
		if x.Rule == RuleCostLater && (!strings.Contains(x.Condition, "covers 100.0% and 100.0% of the executions expected to record one") || strings.Contains(x.Condition, "completed executions")) {
			t.Fatalf("condition: %q", x.Condition)
		}
	}
	in = quiet()
	in.Cur["K1"] = k1Coverage(12.5, 20, 10, 6) // 77% of the expected recorded one: below 80%
	if r := Evaluate(in); rulesFired(r)[RuleCostLater] != 0 || len(notEvaluated(r, RuleCostLater)) != 1 {
		t.Fatal("compared below the coverage minimum")
	}
}
