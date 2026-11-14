package project

import (
	"testing"

	"mach/observer/internal/feedtest"
	"mach/observer/internal/metrics"
)

// The defects the M6.5 backend audit found in the folds, each against the projection.

func rowsOf(t *testing.T, events []map[string]any, ids []string, group string) map[string]metrics.Row {
	t.Helper()
	m := feedtest.NewMem("", 0)
	m.Append(events...)
	p := New(Options{Log: m})
	out := map[string]metrics.Row{}
	p.View(func(s *State) {
		for _, r := range s.Metrics.Rows(ids, group) {
			out[r.ID] = r
		}
	})
	return out
}

func groupValues(r metrics.Row) map[string]*float64 {
	out := map[string]*float64{}
	for _, g := range r.Groups {
		out[g.Key] = g.Value
	}
	return out
}

func claim(x, ticket string, ms int64) *feedtest.Ev {
	return feedtest.New("intake-log", "work.claimed", ms).Ticket(ticket).Exec(x).Data(map[string]any{"stage": "planned", "next": "build", "attempt": 1})
}

func completed(x, ticket string, ms int64, cost float64) *feedtest.Ev {
	return feedtest.New("intake-log", "execution.completed", ms).Ticket(ticket).Exec(x).Data(map[string]any{"stage": "built", "next": "verify", "cost_usd": cost, "refused_tools": []string{}})
}

// K4: the numerator and denominator were both counted twice.
func TestK4CountedOnce(t *testing.T) {
	ev := []map[string]any{
		claim("x000000000001", "T-1", 0).Build(), completed("x000000000001", "T-1", 1000, 2).Build(),
		claim("x000000000002", "T-1", 2000).Build(), completed("x000000000002", "T-1", 3000, 3).Build(),
		claim("x000000000003", "T-2", 4000).Build(), completed("x000000000003", "T-2", 5000, 4).Build(),
	}
	k4 := rowsOf(t, ev, []string{"K4"}, "")["K4"]
	if k4.Numerator == nil || *k4.Numerator != 9 || *k4.Denominator != 2 || *k4.Value != 4.5 {
		t.Fatalf("K4 %v / %v", fderef(k4.Numerator), fderef(k4.Denominator))
	}
}

func fderef(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

// X3 by gate, S1 by kind and K3 by token kind were always null; C2 by station had no groups.
func TestGroupedDenominators(t *testing.T) {
	c := func(typ string, ms int64, visit string) *feedtest.Ev {
		return feedtest.New("cell-lifecycle", typ, ms).Ticket("T-1").Visit("T-1", visit, 1)
	}
	ev := []map[string]any{
		c("station.entered", 0, "build#1").Data(map[string]any{"station": "build", "stage": "building"}).Build(),
		c("build.task_completed", 100, "build#1").Data(map[string]any{"task_id": "T1", "kind": "test", "step": "red"}).Build(),
		c("build.task_completed", 200, "build#1").Data(map[string]any{"task_id": "T2", "kind": "impl", "step": "green"}).Build(),
		c("gate.evaluated", 300, "build#1").Data(map[string]any{"gate": "build.scope", "verdict": "overridden"}).Build(),
		c("station.exited", 400, "build#1").Data(map[string]any{"station": "build", "outcome": "built"}).Build(),
		c("station.entered", 500, "verify#1").Data(map[string]any{"station": "verify"}).Build(),
		c("station.exited", 600, "verify#1").Data(map[string]any{"station": "verify"}).Build(),
		c("station.entered", 700, "build#2").Data(map[string]any{"station": "build"}).Build(),
		claim("x000000000001", "T-1", 1000).Build(), claim("x000000000002", "T-1", 2000).Build(),
		feedtest.New("intake-log", "recovery.started", 3000).Ticket("T-1").Exec("x000000000002").Data(map[string]any{"kind": "outcome-unknown"}).Build(),
		feedtest.New("execution-stream", "execution.usage", 4000).Exec("x000000000001").Ticket("T-1").Data(map[string]any{"models": map[string]any{
			"m1": map[string]any{"cost_usd": 1.0, "input_tokens": 100, "output_tokens": 300}}}).Build(),
	}
	x3 := groupValues(rowsOf(t, ev, []string{"X3"}, "gate")["X3"])
	if v := x3["build.scope"]; v == nil || *v != 0.5 {
		t.Fatalf("X3 by gate %v", x3)
	}
	s1 := groupValues(rowsOf(t, ev, []string{"S1"}, "kind")["S1"])
	if v := s1["outcome-unknown"]; v == nil || *v != 0.5 {
		t.Fatalf("S1 by kind %v", s1)
	}
	k3 := groupValues(rowsOf(t, ev, []string{"K3"}, "token_kind")["K3"])
	if v := k3["input"]; v == nil || *v != 100 {
		t.Fatalf("K3 by token kind %v", k3)
	}
	c2r := rowsOf(t, ev, []string{"C2"}, "station")["C2"]
	c2 := groupValues(c2r)
	if c2["build"] == nil || *c2["build"] != 2 || c2["verify"] == nil || *c2["verify"] != 1 || *c2r.Value != 3 {
		t.Fatalf("C2 by station %v total %v", c2, fderef(c2r.Value))
	}
}

// A run with no recorded outcome is neither merged nor abandoned (observe.py), the normaliser's
// default notwithstanding; risk not recorded is the group "unknown".
func TestRunWithoutOutcome(t *testing.T) {
	run := func(ticket string, ms int64, d map[string]any) *feedtest.Ev {
		return feedtest.New("run-record", "run.recorded", ms).Ticket(ticket).Data(d)
	}
	ev := []map[string]any{
		run("T-1", 0, map[string]any{"outcome": "merged", "rounds": 1, "first_pass": true, "risk": "High"}).Build(),
		run("T-2", 1000, map[string]any{"outcome": "merged", "rounds": 3, "first_pass": false, "risk": nil}).Set("unknown", []string{"data.outcome"}).Build(),
		run("T-3", 2000, map[string]any{"outcome": "abandoned", "first_pass": false, "risk": "Low"}).Build(),
	}
	rows := rowsOf(t, ev, []string{"Q2", "Q3", "R5", "R6"}, "risk")
	if *rows["Q2"].Value != 1 || *rows["Q2"].Denominator != 1 || *rows["Q3"].Value != 1 || *rows["R6"].Denominator != 3 {
		t.Fatalf("Q2 %v/%v Q3 %v R6 den %v", *rows["Q2"].Numerator, *rows["Q2"].Denominator, *rows["Q3"].Value, *rows["R6"].Denominator)
	}
	if g := groupValues(rows["R5"]); g["unknown"] == nil {
		t.Fatalf("no unknown risk group: %v", g)
	}
}

// A history.gap conflict marks its period suspect; refused run records count in coverage.
func TestSuspectAndRefused(t *testing.T) {
	ev := []map[string]any{
		feedtest.New("run-record", "run.recorded", 0).Ticket("T-1").Data(map[string]any{"outcome": "merged", "rounds": 1, "first_pass": true}).Build(),
		feedtest.New("observer", "history.gap", 1000).Data(map[string]any{"source_key": "r:0badc0de", "reason": "unparsable-line", "from_seq": 2, "to_seq": 2, "count": 1}).Build(),
		feedtest.New("observer", "history.gap", 2000).Data(map[string]any{"source_key": "c:T-1:9a0c41d2", "reason": "conflict", "from_seq": 4, "to_seq": 4, "count": 1}).Build(),
	}
	m := feedtest.NewMem("", 0)
	m.Append(ev...)
	p := New(Options{Log: m})
	p.View(func(s *State) {
		q2 := s.Metrics.Query(metrics.Query{IDs: []string{"Q2"}, Bucket: "day"})[0]
		if len(q2.Buckets) != 1 || !q2.Buckets[0].Suspect || !q2.Suspect {
			t.Fatalf("%+v", q2.Buckets)
		}
		found := false
		for _, x := range q2.Coverage.Excluded {
			found = found || x.Count == 1 && x.Reason != ""
		}
		if !found || *q2.Coverage.Eligible != 2 {
			t.Fatalf("%+v", q2.Coverage)
		}
		// last_runs reads the same fold over the run records.
		tb, n := LastRunsTable(s, 5)
		r := s.Metrics.Query(metrics.Query{IDs: []string{"Q2", "C1"}, Runs: tb, LastRuns: 5, RunsSelected: n})
		if n != 1 || *r[1].Value != 1 || r[0].Status != "unavailable" {
			t.Fatalf("%d %+v", n, r)
		}
	})
}

// Open, bounded and unknown visits are counted apart from the measured ones.
func TestVisitBases(t *testing.T) {
	c := func(typ string, ms int64, ticket, visit string) *feedtest.Ev {
		return feedtest.New("cell-lifecycle", typ, ms).Ticket(ticket).Visit(ticket, visit, 1)
	}
	nb, na := int64(1500), int64(2500)
	ev := []map[string]any{
		c("station.entered", 0, "T-1", "build#1").Data(map[string]any{"station": "build"}).Build(),
		c("station.exited", 1000, "T-1", "build#1").Data(map[string]any{"station": "build"}).Build(),
		c("station.entered", 0, "T-2", "build#1").Data(map[string]any{"station": "build"}).Build(),
		c("station.exited", 2000, "T-2", "build#1").Precision("bounded", nil, &nb, &na).Data(map[string]any{"station": "build"}).Build(),
		c("station.exited", 3000, "T-3", "build#1").Data(map[string]any{"station": "build"}).Build(),
		c("station.entered", 3000, "T-4", "build#1").Data(map[string]any{"station": "build"}).Build(),
	}
	r := rowsOf(t, ev, []string{"C1"}, "")["C1"]
	b := r.BasisCounts
	if *r.Value != 1000 || b.Measured != 1 || b.Bounded != 1 || b.Unknown != 1 || b.Open == nil || *b.Open != 1 || *r.Coverage.Eligible != 4 {
		t.Fatalf("%v %+v %+v", *r.Value, b, r.Coverage)
	}
}

// T1 counts lifecycle merges; a ticket merged by its run record without one is disclosed in the
// coverage (eligible, counted, excluded), in either arrival order.
func TestT1CoverageDisclosesMissingMerges(t *testing.T) {
	merge := func(ticket string, ms int64) map[string]any {
		return feedtest.New("cell-lifecycle", "merge.completed", ms).Ticket(ticket).Visit(ticket, "merge#1", 0).Data(map[string]any{"method": "local"}).Build()
	}
	run := func(ticket string, ms int64) map[string]any {
		return feedtest.New("run-record", "run.recorded", ms).Ticket(ticket).Data(map[string]any{"outcome": "merged", "rounds": 1, "first_pass": true}).Build()
	}
	for name, ev := range map[string][]map[string]any{
		"merge first": {merge("T-1", 0), run("T-1", 1000), run("T-2", 2000), feedtest.New("cell-lifecycle", "station.entered", 500).Ticket("T-2").Visit("T-2", "build#1", 1).Build()},
		"run first":   {run("T-1", 0), merge("T-1", 1000), feedtest.New("cell-lifecycle", "station.entered", 500).Ticket("T-2").Visit("T-2", "build#1", 1).Build(), run("T-2", 2000)},
	} {
		r := rowsOf(t, ev, []string{"T1"}, "")["T1"]
		cv := r.Coverage
		if *r.Value != 1 || *cv.Eligible != 2 || *cv.Counted != 1 || len(cv.Excluded) != 1 || cv.Excluded[0].Reason != exT1NoMerge || cv.Excluded[0].Count != 1 {
			t.Fatalf("%s: T1 %v coverage %+v", name, *r.Value, cv)
		}
	}
}
