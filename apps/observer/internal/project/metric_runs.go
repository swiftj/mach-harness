package project

import "mach/observer/internal/metrics"

// RunFactsOf is a run record as the observe station's scorecard reads it (metrics.FoldRun).
func RunFactsOf(r *RunRecord) metrics.RunFacts {
	f := metrics.RunFacts{Outcome: r.Outcome, Rounds: r.Rounds, FirstPass: r.FirstPass, Escalated: r.Escalated,
		Failing: r.TestsSeenFailingFirst, Passing: r.TestsPassingOnFirstRun, Deviations: r.Deviations, Risk: r.Risk, AppType: r.AppType}
	if f.Outcome != "merged" && f.Outcome != "abandoned" {
		f.Outcome = ""
	}
	// observe.py sorts by closed_at as written; the earliest instant the stamp allows is that time
	// (a whole-second stamp's occurred_at is the end of its second).
	if ms, ok := r.ClosedAt.lo(); ok {
		f.ClosedMS, f.ClosedOK = ms, true
	}
	return f
}

// LastRunsTable is the scorecard over the last n finished runs by closed_at (observe.py select),
// and how many runs it holds.
func LastRunsTable(s *State, n int) (*metrics.Table, int) {
	all := make([]metrics.RunFacts, 0, len(s.Runs))
	for _, r := range s.Runs {
		all = append(all, RunFactsOf(r))
	}
	sel := metrics.LastRuns(all, n)
	return metrics.RunsTable(sel), len(sel)
}
