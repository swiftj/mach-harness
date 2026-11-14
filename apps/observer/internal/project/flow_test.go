package project

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"

	"mach/observer/internal/feedtest"
)

// M6.5.3: the flow index, its contributors and the usage facts.

const (
	xu = "x0123456789uu" // an execution whose outcome is unknown
	xi = "x0123456789ii" // an interrupted execution
	xf = "x0123456789ff" // a failed execution
	xk = "x0123456789kk" // a completed execution with a recorded cost
)

func visitPair(ticket, visit string, round int, from, to int64, data map[string]any) []*feedtest.Ev {
	station := data["station"]
	return []*feedtest.Ev{
		lc("station.entered", from, ticket, visit, round).Data(data),
		lc("station.exited", to, ticket, visit, round).Data(map[string]any{"station": station, "outcome": "done"}),
	}
}

func st(name string) map[string]any { return map[string]any{"station": name} }

func revise() map[string]any { return map[string]any{"station": "build", "action": "revise"} }

// flowScenario: T-1 fails verification, is revised, passes, is rejected in review, is revised,
// passes and merges (repeated verification visits; failure then success; rejection then
// remediation). T-2 waits for a person's approval. T-3 waits on a dependency and for execution
// capacity before its plan. T-4 runs under an interrupted execution, T-5 under one whose outcome is
// unknown, T-6 under a failed one; T-7's execution completes with a recorded cost.
func flowScenario() []*feedtest.Ev {
	var evs []*feedtest.Ev
	add := func(e ...*feedtest.Ev) { evs = append(evs, e...) }
	gate := func(ticket, visit string, round int, ms int64, data map[string]any) {
		add(lc("gate.evaluated", ms, ticket, visit, round).Data(data))
	}
	// T-1
	add(visitPair("T-1", "plan#1", 1, 1000, 2000, st("plan"))...)
	add(visitPair("T-1", "build#1", 1, 2000, 5000, st("build"))...)
	gate("T-1", "build#1", 1, 4000, map[string]any{"gate": "build.red", "verdict": "overridden"})
	add(visitPair("T-1", "verify#1", 1, 5000, 6000, st("verify"))...)
	gate("T-1", "verify#1", 1, 5900, map[string]any{"gate": "verify.verdict", "verdict": "refused", "status": "FAIL_WITH_EVIDENCE", "reason_code": "checks-failed"})
	add(lc("verify.check_recorded", 5800, "T-1", "verify#1", 1).Data(map[string]any{"target_id": "AC-01", "target_kind": "scenario", "result": "fail"}))
	add(visitPair("T-1", "build#2", 2, 6000, 8000, revise())...)
	add(visitPair("T-1", "verify#2", 2, 8000, 9000, st("verify"))...)
	gate("T-1", "verify#2", 2, 8900, map[string]any{"gate": "verify.verdict", "verdict": "passed", "status": "PASS"})
	add(visitPair("T-1", "review#1", 2, 9000, 10000, st("review"))...)
	add(lc("review.decided", 9900, "T-1", "review#1", 2).Data(map[string]any{"outcome": "REJECTED", "blockers": 2, "votes": map[string]string{}}))
	add(visitPair("T-1", "build#3", 3, 10000, 11000, revise())...)
	add(visitPair("T-1", "verify#3", 3, 11000, 12000, st("verify"))...)
	gate("T-1", "verify#3", 3, 11900, map[string]any{"gate": "verify.verdict", "verdict": "passed", "status": "PASS"})
	add(visitPair("T-1", "review#2", 3, 12000, 13000, st("review"))...)
	add(lc("review.decided", 12900, "T-1", "review#2", 3).Data(map[string]any{"outcome": "APPROVED", "votes": map[string]string{}}))
	add(visitPair("T-1", "merge#1", 3, 13000, 13500, st("merge"))...)
	add(lc("merge.completed", 13500, "T-1", "merge#1", 3).Data(map[string]any{"method": "local"}))
	// T-2: a person's approval
	add(visitPair("T-2", "review#1", 1, 15000, 20000, st("review"))...)
	add(lc("review.decided", 20000, "T-2", "review#1", 1).Data(map[string]any{"outcome": "AWAITING_HUMAN", "votes": map[string]string{}}))
	add(lc("human.approval_recorded", 50000, "T-2", "review#1", 1).Data(map[string]any{"by_role": "person"}))
	add(visitPair("T-2", "merge#1", 1, 51000, 52000, st("merge"))...)
	// T-3: a dependency wait and an execution-capacity wait before its plan
	add(slice(intake("slice.materialized", 0), "SLICE-3").Ticket("T-3").Data(map[string]any{"dependencies": []string{"SLICE-1"}}))
	add(slice(intake("dependency.blocked", 1000), "SLICE-3").Data(map[string]any{"reasons": []string{"SLICE-1 is not integrated yet"}}))
	add(slice(intake("dependency.resolved", 3000), "SLICE-3").Data(map[string]any{"depends_on": []string{"SLICE-1"}}))
	capw := func(state string, ms int64) *feedtest.Ev {
		return feedtest.New("observer", "capacity.wait_changed", ms).Ticket("T-3").Data(map[string]any{"state": state, "scope": "execution", "limit": 2})
	}
	add(capw("waiting", 3500), capw("released", 3800))
	add(visitPair("T-3", "plan#1", 1, 4000, 4500, st("plan"))...)
	// T-4: interrupted mid-build
	add(started(xi, "T-4", 60000), lc("station.entered", 61000, "T-4", "build#1", 1).Exec(xi).Data(st("build")),
		processEnded(xi, "T-4", 65000, "interrupted"), failed(xi, "T-4", 66000, "interrupted"))
	// T-5: outcome unknown
	add(started(xu, "T-5", 60000), lc("station.entered", 61000, "T-5", "build#1", 1).Exec(xu).Data(st("build")),
		feedtest.New("intake-log", "recovery.started", 70000).Exec(xu).Ticket("T-5").Data(map[string]any{"kind": "outcome-unknown"}))
	// T-6: failed; T-7: completed with a recorded cost
	add(claimed(xf, "T-6", 59000), started(xf, "T-6", 60000), processEnded(xf, "T-6", 62000, "exited"), failed(xf, "T-6", 63000, "failed"))
	add(claimed(xk, "T-7", 59000), started(xk, "T-7", 60000), processEnded(xk, "T-7", 62000, "exited"),
		feedtest.New("intake-log", "execution.completed", 63000).Exec(xk).Ticket("T-7").Data(map[string]any{"cost_usd": 1.25, "stage": "built", "next": "verify"}))
	// History goes on, so nothing is open only because the history ended.
	add(lc("gate.evaluated", 900000, "T-9", "plan#1", 1).Data(map[string]any{"gate": "x", "verdict": "passed"}))
	return evs
}

func stationOf(rep FlowReport, name string) *StationFlow {
	for i := range rep.Stations {
		if rep.Stations[i].Station == name {
			return &rep.Stations[i]
		}
	}
	return nil
}

func transitionOf(rep FlowReport, from, to string) *Transition {
	for i := range rep.Transitions {
		if rep.Transitions[i].From == from && rep.Transitions[i].To == to {
			return &rep.Transitions[i]
		}
	}
	return nil
}

func waitOf(list []WaitSummary, kind string) *WaitSummary {
	for i := range list {
		if list[i].Kind == kind {
			return &list[i]
		}
	}
	return nil
}

func TestFlowEmptyProject(t *testing.T) {
	s := project()
	rep := BuildFlow(s, allSpans(s)).Flow(FlowQuery{})
	if len(rep.Stations) != 0 || len(rep.Transitions) != 0 || len(rep.Waits) != 0 || len(rep.Bottlenecks) != 0 || rep.Coverage.Tickets != 0 || rep.Coverage.Visits != 0 {
		t.Fatalf("an empty project has figures: %+v", rep)
	}
	data, _ := json.Marshal(rep)
	if string(data) != `{"stations":[],"transitions":[],"waits":[],"bottlenecks":[],"coverage":{"tickets":0,"tickets_with_lifecycle":0,"visits":0,"visits_measured":0,"waits_dropped":{"capacity":0,"capacity-slice":0,"dependency":0}},"unit":"ms"}` {
		t.Fatalf("empty reply %s", data)
	}
}

func TestFlowStationsTransitionsAndBottlenecks(t *testing.T) {
	s := project(flowScenario()...)
	rep := BuildFlow(s, allSpans(s)).Flow(FlowQuery{})

	v := stationOf(rep, "verify")
	if v == nil || v.Visits != 3 || v.Tickets != 1 || v.Duration.Measured == nil || v.Duration.Measured.Count != 3 || v.Duration.Measured.TotalMS != 3000 {
		t.Fatalf("verify: %+v", v)
	}
	if v.Gates.Evaluated != 3 || v.Gates.Refused != 1 || v.Gates.Overridden != 0 || v.Gates.Tickets != 1 {
		t.Fatalf("verify gates %+v", v.Gates)
	}
	b := stationOf(rep, "build")
	// T-1's three build visits (measured) and T-4's and T-5's (inferred at their executions' ends).
	if b.Visits != 5 || b.ReviseEntries != 2 || b.Tickets != 3 || b.Duration.Basis["measured"] != 3 || b.Duration.Basis["inferred"] != 2 ||
		b.Duration.Measured.TotalMS != 6000 || b.Duration.Measured.MedianMS != 2000 || b.Duration.Measured.P90MS != 3000 || b.Duration.Measured.MinMS != 1000 {
		t.Fatalf("build: %+v", b)
	}
	if b.Duration.Inferred.Count != 2 || b.Duration.Inferred.TotalMaxMS == nil || b.Gates.Overridden != 1 {
		t.Fatalf("build inferred/gates: %+v %+v", b.Duration.Inferred, b.Gates)
	}
	if b.OpenVisits != 0 {
		t.Fatalf("nothing stays open under an ended execution: %d", b.OpenVisits)
	}
	cases := []struct {
		from, to      string
		count, revise int64
	}{
		{"plan", "build", 1, 0}, {"build", "verify", 3, 0}, {"verify", "build", 1, 1}, {"verify", "review", 2, 0}, {"review", "build", 1, 1},
		{"review", "merge", 2, 0}, {"merge", "merged", 1, 0},
	}
	for _, c := range cases {
		tr := transitionOf(rep, c.from, c.to)
		if tr == nil || tr.Count != c.count || tr.Revise != c.revise {
			t.Errorf("%s->%s: %+v", c.from, c.to, tr)
		}
	}
	if tr := transitionOf(rep, "merge", "merged"); tr == nil || !tr.Terminal || tr.Tickets != 1 {
		t.Errorf("terminal %+v", tr)
	}
	// Waits: a person's approval before T-2's merge; a dependency and a capacity wait before T-3's plan.
	h := waitOf(stationOf(rep, "merge").WaitsBefore, WaitHuman)
	if h == nil || h.Count != 1 || h.Duration.Measured == nil || h.Duration.Measured.TotalMS != 30000 {
		t.Fatalf("human wait before merge: %+v", h)
	}
	p := stationOf(rep, "plan")
	if d := waitOf(p.WaitsBefore, WaitDependency); d == nil || d.Count != 1 || d.Tickets != 1 {
		t.Fatalf("dependency wait before plan: %+v", p.WaitsBefore)
	}
	if c := waitOf(p.WaitsBefore, WaitCapacity); c == nil || c.Count != 1 || c.Duration.Count != 1 {
		t.Fatalf("capacity wait before plan: %+v", p.WaitsBefore)
	}
	// The ranking: by total measured time, volume beside it; the human wait leads.
	if len(rep.Bottlenecks) == 0 || rep.Bottlenecks[0].Kind != "wait" || rep.Bottlenecks[0].Key != WaitHuman || *rep.Bottlenecks[0].Rank != 1 {
		t.Fatalf("bottlenecks %+v", rep.Bottlenecks[0])
	}
	for i, bn := range rep.Bottlenecks[1:] {
		prev := rep.Bottlenecks[i]
		if bn.TotalMeasuredMS != nil && prev.TotalMeasuredMS != nil && *bn.TotalMeasuredMS > *prev.TotalMeasuredMS {
			t.Fatalf("not ranked by total: %+v after %+v", bn, prev)
		}
	}
	// Filters: High is not recorded anywhere; unknown matches every cell (no plan exit recorded a risk).
	if r := BuildFlow(s, allSpans(s)).Flow(FlowQuery{Risk: "High"}); len(r.Stations) != 0 {
		t.Fatalf("risk High selected %+v", r.Stations)
	}
	if r := BuildFlow(s, allSpans(s)).Flow(FlowQuery{Risk: "unknown"}); stationOf(r, "verify").Visits != 3 {
		t.Fatal("unknown risk must select cells that recorded none")
	}
	// A station filter keeps its own waits and the transitions touching it.
	r := BuildFlow(s, allSpans(s)).Flow(FlowQuery{Station: "verify"})
	if len(r.Stations) != 1 || transitionOf(r, "plan", "build") != nil || transitionOf(r, "verify", "review") == nil {
		t.Fatalf("station filter %+v %+v", r.Stations, r.Transitions)
	}
}

func TestFlowWindowThatExcludesEverythingHasNoNumbers(t *testing.T) {
	s := project(flowScenario()...)
	day := flowDay(feedtest.At(0))
	rep := BuildFlow(s, allSpans(s)).Flow(FlowQuery{Window: true, From: day + 10*flowDayMS, To: day + 11*flowDayMS})
	if len(rep.Stations) != 0 || len(rep.Bottlenecks) != 0 || len(rep.Waits) != 0 || rep.Coverage.Tickets != 0 {
		t.Fatalf("window excludes everything, yet %+v", rep)
	}
	// Nothing measured: no statistics at all, never zeros.
	if sm := summarize(&durAgg{basis: [5]int64{0, 2, 0, 0, 0}}); sm.Measured != nil || sm.Bounded.TotalMaxMS == nil {
		t.Fatalf("no measured stats expected: %+v", sm)
	}
	// The day that holds the scenario selects all of it.
	all := BuildFlow(s, allSpans(s)).Flow(FlowQuery{})
	in := BuildFlow(s, allSpans(s)).Flow(FlowQuery{Window: true, From: day, To: day + flowDayMS})
	if !reflect.DeepEqual(all, in) {
		t.Fatalf("the scenario's day differs from everything:\n%+v\n%+v", all, in)
	}
}

// A visit is placed on the UTC day it was entered, even when it ends the next day.
func TestFlowVisitAcrossMidnight(t *testing.T) {
	midnight := flowDay(feedtest.At(0)) + flowDayMS - feedtest.At(0) // ms after Base
	s := project(append(visitPair("T-1", "build#1", 1, midnight-1000, midnight+1000, st("build")),
		lc("gate.evaluated", midnight+5000, "T-1", "build#1", 1).Data(map[string]any{"gate": "build.red", "verdict": "refused"}))...)
	ix := BuildFlow(s, allSpans(s))
	day := flowDay(feedtest.At(0))
	first := ix.Flow(FlowQuery{Window: true, From: day, To: day + flowDayMS})
	second := ix.Flow(FlowQuery{Window: true, From: day + flowDayMS, To: day + 2*flowDayMS})
	if b := stationOf(first, "build"); b == nil || b.Visits != 1 || b.Duration.Measured.TotalMS != 2000 || b.Gates.Evaluated != 0 {
		t.Fatalf("first day %+v", first.Stations)
	}
	if b := stationOf(second, "build"); b == nil || b.Visits != 0 || b.Gates.Refused != 1 || b.Duration.Measured != nil {
		t.Fatalf("second day %+v", second.Stations)
	}
}

// A visit entered twice (a duplicate entry) and exited twice is one visit; an exit delivered before
// its entry is one visit whose length is unknown (never measured, never dropped).
func TestFlowDuplicateAndLateEvents(t *testing.T) {
	s := project(
		lc("station.entered", 1000, "T-1", "build#1", 1).Data(st("build")),
		lc("station.entered", 1000, "T-1", "build#1", 1).Data(st("build")),
		lc("station.exited", 3000, "T-1", "build#1", 1).Data(map[string]any{"station": "build", "outcome": "built"}),
		lc("station.exited", 3000, "T-1", "build#1", 1).Data(map[string]any{"station": "build", "outcome": "built"}),
		lc("station.exited", 6000, "T-2", "verify#1", 1).Data(map[string]any{"station": "verify", "outcome": "verified"}),
		lc("station.entered", 5000, "T-2", "verify#1", 1).Data(st("verify")),
	)
	rep := BuildFlow(s, allSpans(s)).Flow(FlowQuery{})
	if b := stationOf(rep, "build"); b.Visits != 1 || b.Duration.Measured.TotalMS != 2000 {
		t.Fatalf("duplicate counted: %+v", b)
	}
	if v := stationOf(rep, "verify"); v.Visits != 1 || v.Duration.Measured != nil || v.Duration.Basis["unknown"] != 1 {
		t.Fatalf("late exit: %+v", v)
	}
}

func TestContributors(t *testing.T) {
	s := project(flowScenario()...)
	ix := BuildFlow(s, allSpans(s))
	q := ContributorQuery{Order: "impact", Limit: 500, Group: map[string]string{"station": "verify"}}
	page := ix.Contributors("C1", q)
	if page.Total != 3 || page.Items[0].Ref != "visit:T-1/verify#1" && *page.Items[0].Value < *page.Items[2].Value {
		t.Fatalf("C1 verify: %+v", page)
	}
	for _, it := range page.Items {
		if it.Unit != "ms" || it.Basis != "measured" || it.Ticket == nil || *it.Ticket != "T-1" || it.Cell == nil || it.SpanID == nil {
			t.Fatalf("item %+v", it)
		}
	}
	// recent: newest first.
	q.Order = "recent"
	if p := ix.Contributors("C1", q); p.Items[0].Ref != "visit:T-1/verify#3" {
		t.Fatalf("recent: %+v", p.Items[0])
	}
	// bounded paging.
	if p := ix.Contributors("C1", ContributorQuery{Order: "impact", Limit: 2}); !p.Truncated || len(p.Items) != 2 || p.Total < 10 {
		t.Fatalf("limit: %+v", p)
	}
	check := func(id string, group map[string]string, want int, ref string) {
		t.Helper()
		p := ix.Contributors(id, ContributorQuery{Order: "impact", Limit: 500, Group: group})
		if p.Total != want || want > 0 && ref != "" && p.Items[0].Ref != ref {
			t.Errorf("%s %v: total %d, items %+v", id, group, p.Total, p.Items)
		}
	}
	check("W3", nil, 1, "gate:T-2/approval:T-2#1")
	check("W1", nil, 1, "slice:SLICE-3")
	check("W2b", nil, 1, "cell:T-3")
	check("waits", map[string]string{"station": "plan"}, 3, "") // dependency, capacity, and the queue wait still open (never scheduled)
	check("verification_failures", nil, 1, "gate:T-1/verify#1")
	check("Q1", nil, 1, "gate:T-1/verify#1")
	check("Q4", map[string]string{"target_kind": "scenario"}, 1, "visit:T-1/verify#1")
	check("R1", nil, 1, "gate:T-1/review#2")
	check("X2", map[string]string{"reason_code": "checks-failed"}, 1, "gate:T-1/verify#1")
	check("X3", nil, 1, "gate:T-1/build")
	check("X1", nil, 2, "") // every execution.failed record: the failed one and the interrupted one
	check("X1", map[string]string{"state": "failed"}, 1, "execution:"+xf)
	check("S2", nil, 1, "execution:"+xu)
	check("executions", map[string]string{"state": "interrupted"}, 1, "execution:"+xi)
	check("S1", map[string]string{"kind": "outcome-unknown"}, 1, "execution:"+xu)
	check("K1", nil, 1, "execution:"+xk)
	if p := ix.Contributors("K1", ContributorQuery{Order: "impact", Limit: 5}); *p.Items[0].Value != 1.25 || p.Items[0].Unit != "USD" {
		t.Fatalf("K1 %+v", p.Items[0])
	}
	// No free text: every string is an identifier or a code.
	for id := range ContributorFigures {
		data, _ := json.Marshal(ix.Contributors(id, ContributorQuery{Order: "impact", Limit: 500}))
		var v any
		_ = json.Unmarshal(data, &v)
		var walk func(any)
		walk = func(x any) {
			switch x := x.(type) {
			case map[string]any:
				for k, y := range x {
					if k == "figure" {
						continue
					}
					walk(y)
				}
			case []any:
				for _, y := range x {
					walk(y)
				}
			case string:
				for _, r := range x {
					if r == ' ' {
						t.Errorf("%s: prose %q", id, x)
						return
					}
				}
			}
		}
		walk(v)
	}
	// A window that excludes everything: no items.
	day := flowDay(feedtest.At(0))
	if p := ix.Contributors("C1", ContributorQuery{Window: true, From: day + 5*flowDayMS, To: day + 6*flowDayMS, Order: "impact", Limit: 10}); p.Total != 0 || len(p.Items) != 0 {
		t.Fatalf("window: %+v", p)
	}
}

func TestExecutionUsage(t *testing.T) {
	s := project(flowScenario()...)
	if u := ExecutionUsage(s, s.Executions[xk]); !u.Recorded || u.Complete == nil || !*u.Complete || len(u.Sources) != 1 || u.Sources[0] != "execution.completed" ||
		*u.SupervisorCostUSD != 1.25 {
		t.Fatalf("completed: %+v", u)
	}
	if u := ExecutionUsage(s, s.Executions[xi]); u.Recorded || u.Complete != nil || len(u.IncompleteReasons) != 1 || u.IncompleteReasons[0] != "process-interrupted" {
		t.Fatalf("interrupted, nothing recorded: %+v", u)
	}
	if u := ExecutionUsage(s, s.Executions[xu]); u.Recorded || u.IncompleteReasons[0] != "outcome-unknown" {
		t.Fatalf("unknown: %+v", u)
	}
}

// Restart: a projection saved and loaded, or rebuilt by replay, gives the same flow figures and
// contributors as the one that applied the events live.
func TestFlowRestartAndRebuildGiveIdenticalAnswers(t *testing.T) {
	dir := t.TempDir()
	m := feedtest.NewMem("", 0)
	evs := flowScenario()
	half := len(evs) / 2
	for _, e := range evs[:half] {
		m.Append(e.Build())
	}
	p1 := New(Options{Log: m, PersistDir: dir, PersistEvery: 1, PersistMinInterval: -1})
	p1.Sync()
	for _, e := range evs[half:] {
		m.Append(e.Build())
	}
	answer := func(p *Projector) string {
		ix, err := p.Flow()
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]any{"pos": ix.Pos, "flow": ix.Flow(FlowQuery{})}
		for id := range ContributorFigures {
			out[id] = ix.Contributors(id, ContributorQuery{Order: "impact", Limit: 500})
		}
		data, _ := json.Marshal(out)
		return string(data)
	}
	live := answer(p1)
	p1.Close()
	if _, err := os.Stat(dir); err != nil {
		t.Fatal(err)
	}
	restarted := answer(New(Options{Log: m, PersistDir: dir}))
	rebuilt := answer(New(Options{Log: m}))
	if live != restarted || live != rebuilt {
		t.Fatalf("answers differ:\nlive      %s\nrestarted %s\nrebuilt   %s", live, restarted, rebuilt)
	}
	// At a cursor: the same as a projection that only ever saw events up to it.
	p := New(Options{Log: m})
	ix, err := p.FlowAt(uint64(half))
	if err != nil {
		t.Fatal(err)
	}
	m2 := feedtest.NewMem("", 0)
	for _, rec := range func() []map[string]any {
		var out []map[string]any
		recs, _ := m.After(0, half)
		for _, r := range recs {
			var ev map[string]any
			_ = json.Unmarshal(r.Raw, &ev)
			out = append(out, ev)
		}
		return out
	}() {
		m2.Append(rec)
	}
	fresh, _ := New(Options{Log: m2}).Flow()
	a, _ := json.Marshal(ix.Flow(FlowQuery{}))
	b, _ := json.Marshal(fresh.Flow(FlowQuery{}))
	if string(a) != string(b) || ix.Pos != uint64(half) {
		t.Fatalf("at a cursor:\n%s\n%s", a, b)
	}
}

// The figures added for the insights: run-record populations (Q2, Q3, R5 with last_runs), blockers
// by rule code (R2), and what is missing (K1-missing, usage-missing, lifecycle-missing).
func TestContributorsForInsights(t *testing.T) {
	evs := flowScenario()
	run := func(ticket string, ms int64, d map[string]any) *feedtest.Ev {
		return feedtest.New("run-record", "run.recorded", ms).Ticket(ticket).Data(d)
	}
	evs = append(evs,
		run("T-1", 100000, map[string]any{"outcome": "merged", "rounds": 3, "first_pass": false}),
		run("T-2", 101000, map[string]any{"outcome": "merged", "rounds": 1, "first_pass": true}),
		run("T-8", 102000, map[string]any{"outcome": "merged", "first_pass": true}),
		run("T-9", 103000, map[string]any{"outcome": "abandoned", "escalated": true}),
		feedtest.New("observer", "review.finding", 9950).Ticket("T-1").ID("round", 2).Data(map[string]any{"seat": "security", "n": 1, "severity": "blocker",
			"rule": "REVIEW.md#S3", "title": "The token is logged in plain text"}),
		feedtest.New("observer", "review.finding", 9960).Ticket("T-1").ID("round", 2).Data(map[string]any{"seat": "architecture", "n": 1, "severity": "blocker",
			"rule": "a sentence, not a code", "title": "Layering"}),
		feedtest.New("observer", "review.finding", 9970).Ticket("T-1").ID("round", 2).Data(map[string]any{"seat": "product", "n": 1, "severity": "note", "rule": "FR-01"}),
		claimed(xf+"0", "T-8", 63500),
		feedtest.New("intake-log", "execution.completed", 64000).Exec(xf+"0").Ticket("T-8").Data(map[string]any{"stage": "built", "next": "verify"}),
	)
	s := project(evs...)
	ix := BuildFlow(s, allSpans(s))
	get := func(id string, q ContributorQuery) ContributorPage {
		q.Order, q.Limit = orDefault(q.Order, "impact"), 500
		return ix.Contributors(id, q)
	}
	if p := get("Q2", ContributorQuery{}); p.Total != 3 || p.ByBasis["recorded"] != 3 {
		t.Fatalf("Q2 population: %+v", p)
	} else if first := get("Q2", ContributorQuery{Group: map[string]string{"first_pass": "true"}}); first.Total != 2 {
		t.Fatalf("Q2 first pass: %+v", first)
	}
	q3 := get("Q3", ContributorQuery{})
	if q3.Total != 3 || *q3.Items[0].Value != 3 || q3.Items[0].Ref != "cell:T-1" || q3.ByBasis["not-recorded"] != 1 {
		t.Fatalf("Q3: %+v", q3)
	}
	// last_runs: the observe station's population, the last N by closed_at.
	if p := get("Q2", ContributorQuery{LastRuns: 2}); p.Total != 1 || p.Items[0].Ref != "cell:T-8" {
		t.Fatalf("Q2 last 2 runs (T-8 merged, T-9 abandoned): %+v", p)
	}
	if p := get("R5", ContributorQuery{LastRuns: 1}); p.Total != 1 || p.Items[0].Ref != "cell:T-9" {
		t.Fatalf("R5 last run: %+v", p)
	}
	r2 := get("R2", ContributorQuery{})
	if r2.Total != 2 {
		t.Fatalf("R2 blockers: %+v", r2)
	}
	if p := get("R2", ContributorQuery{Group: map[string]string{"rule": "REVIEW.md#S3"}}); p.Total != 1 || p.Items[0].Ref != "finding:T-1/r2/security/1" {
		t.Fatalf("R2 by rule: %+v", p)
	}
	if p := get("R2", ContributorQuery{Group: map[string]string{"rule": "not-a-code"}}); p.Total != 1 {
		t.Fatalf("R2 prose rule is never passed through: %+v", p)
	}
	if p := get("K1-missing", ContributorQuery{}); p.Total != 1 || p.Items[0].Ref != "execution:"+xf+"0" || p.Items[0].Basis != "not-recorded" {
		t.Fatalf("K1-missing: %+v", p)
	}
	if p := get("usage-missing", ContributorQuery{}); p.Total != len(s.Executions) {
		t.Fatalf("usage-missing: %d of %d", p.Total, len(s.Executions))
	}
	missing := 0
	for _, c := range s.Cells {
		if !c.Lifecycle && c.FirstSeen != nil {
			missing++
		}
	}
	lm := get("lifecycle-missing", ContributorQuery{})
	if missing == 0 || lm.Total != missing {
		t.Fatalf("lifecycle-missing: %d, want %d", lm.Total, missing)
	}
	for _, it := range lm.Items {
		if it.Ref == "cell:T-1" {
			t.Fatal("T-1 has a lifecycle log")
		}
	}
	// No prose anywhere in the new figures.
	for _, id := range []string{"Q2", "Q3", "R2", "K1-missing", "usage-missing", "lifecycle-missing"} {
		data, _ := json.Marshal(get(id, ContributorQuery{}).Items)
		for _, bad := range []string{"plain text", "Layering", "sentence"} {
			if strings.Contains(string(data), bad) {
				t.Fatalf("%s carries prose: %s", id, data)
			}
		}
	}
}
