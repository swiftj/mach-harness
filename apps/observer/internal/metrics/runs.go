package metrics

import (
	"math"
	"sort"
	"strconv"
)

// RunFacts is one run.recorded line as the observe station's scorecard reads it.
type RunFacts struct {
	// Outcome is "merged", "abandoned", or "" when the record carries none (observe counts such a
	// run as finished but neither merged nor abandoned).
	Outcome   string
	Rounds    *float64
	FirstPass bool
	Escalated bool
	Failing   float64 // tests_seen_failing_first (observe.py number(): fractions count)
	Passing   float64 // tests_passing_on_first_run
	// Deviations is the number of deviations recorded.
	Deviations int64
	Risk       string
	AppType    string
	// ClosedMS orders runs for last_runs (observe.py select): the earliest instant closed_at can
	// be, or ok false when it is unreadable (it then sorts as the oldest).
	ClosedMS int64
	ClosedOK bool
}

const (
	exNoOutcome = "no outcome recorded: observe counts the run as finished, neither merged nor abandoned"
	exNoRounds  = "merged without a recorded number of rounds"
)

// FoldRun folds one run record into the scorecard metrics, exactly as observe.py scorecard counts
// it. The projection and last_runs use this one function.
func (t *Table) FoldRun(f RunFacts, day string) {
	dims := []Dim{{"risk", f.Risk}, {"app_type", f.AppType}, {"outcome", f.Outcome}}
	switch f.Outcome {
	case "merged":
		t.Rate("Q2", dims, day, b2f(f.FirstPass), 1)
		if f.Rounds != nil {
			t.Rate("Q3", dims, day, *f.Rounds, 1)
		} else {
			t.Exclude("Q3", dims, day, exNoRounds, 1)
		}
	case "":
		t.Exclude("Q2", dims, day, exNoOutcome, 1)
		t.Exclude("Q3", dims, day, exNoOutcome, 1)
	}
	t.Rate("R5", dims, day, b2f(f.Escalated), 1)
	t.Rate("R6", dims, day, b2f(f.Outcome == "abandoned"), 1)
	t.Rate("G1", dims, day, f.Failing, f.Failing+f.Passing)
	t.Rate("G2", dims, day, float64(f.Deviations), 1)
}

func b2f(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

// LastRuns is the observe station's population: the last n runs by closed_at, ties in record
// order (observe.py select). runs must be in record order.
func LastRuns(runs []RunFacts, n int) []RunFacts {
	idx := make([]int, len(runs))
	for i := range idx {
		idx[i] = i
	}
	at := func(i int) int64 {
		if !runs[i].ClosedOK {
			return math.MinInt64
		}
		return runs[i].ClosedMS
	}
	sort.SliceStable(idx, func(a, b int) bool { return at(idx[a]) < at(idx[b]) })
	if n < len(idx) {
		idx = idx[len(idx)-n:]
	}
	out := make([]RunFacts, len(idx))
	for i, j := range idx {
		out[i] = runs[j]
	}
	return out
}

// RunsTable folds the given runs into a fresh table (no days: last_runs is not a time window).
func RunsTable(runs []RunFacts) *Table {
	t := NewTable()
	for _, f := range runs {
		t.FoldRun(f, "")
	}
	return t
}

// RoundObserve rounds as observe.py measure does: round(value, 3), Python's correctly rounded
// decimal with ties to even.
func RoundObserve(v float64) float64 {
	r, _ := strconv.ParseFloat(strconv.FormatFloat(v, 'f', 3, 64), 64)
	return r
}
