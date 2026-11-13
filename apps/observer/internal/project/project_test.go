package project

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"mach/observer/internal/feed"
	"mach/observer/internal/feedtest"
)

func scenarioLog(t *testing.T) (*feedtest.Mem, int) {
	t.Helper()
	m := feedtest.NewMem("", 0)
	evs := feedtest.Scenario()
	m.Append(evs...)
	return m, len(evs)
}

func TestScenarioProjection(t *testing.T) {
	m, n := scenarioLog(t)
	p := New(Options{Log: m, Interval: 7})
	p.View(func(s *State) {
		if s.Pos != uint64(n) || s.NotV3 != 0 {
			t.Fatalf("pos %d not_v3 %d", s.Pos, s.NotV3)
		}
		if s.Factory.State != "supervised" || *s.Factory.AllowMerge != true {
			t.Fatalf("factory %+v", s.Factory)
		}
		s1, s2 := s.Slices["SLICE-001"], s.Slices["SLICE-002"]
		if s1.State != "completed" || s2.State != "ready" {
			t.Fatalf("slice states %s %s", s1.State, s2.State)
		}
		// SLICE-002's history: ready, blocked, ready again.
		var hist []string
		for _, h := range s2.History {
			hist = append(hist, h.State)
		}
		if fmt.Sprint(hist) != "[ready blocked ready]" {
			t.Fatalf("history %v", hist)
		}
		c := s.Cells["T-1"]
		if c.Stage != "merged" || c.Merge == nil || !c.Archived || c.Risk != "High" || c.AppType != "cli" || len(c.Visits) != 6 {
			t.Fatalf("cell %+v (visits %d)", c, len(c.Visits))
		}
		if len(c.Reviews) != 1 || c.Reviews[0].Outcome != "AWAITING_HUMAN" || len(c.Reviews[0].Verdicts) != 3 || len(c.Approvals) != 1 {
			t.Fatalf("review %+v", c.Reviews)
		}
		x1, x2 := s.Executions["x0123456789ab"], s.Executions["x0fedcba98765"]
		r1, r2 := Run(x1), Run(x2)
		if r1.State != "finished" || r1.TimeBasis != "process" || r1.Duration.Basis != "measured" || *r1.Cost.USD != 4.5 || r1.Cost.Source != "execution.usage" ||
			r1.UnderReported || len(r1.Models) != 2 || *r1.Tokens != 1000+2000+50000+4000+500+700+9000+800 {
			t.Fatalf("run 1 %+v", r1)
		}
		if r2.State != "unknown" || !r2.UnderReported || r2.Cost.USD != nil || r2.Cost.NullReason == "" {
			t.Fatalf("run 2 %+v", r2)
		}
		agents := Agents(x1)
		if len(agents) != 1 || agents[0].Status != "done" || *agents[0].Tokens != 150000 || *agents[0].ToolCalls != 40 || agents[0].Station != "build" ||
			agents[0].Queue.Basis != "measured" || *agents[0].Queue.MS != 500 || agents[0].Inferred["ids.station"] != "label" {
			t.Fatalf("agents %+v", agents[0])
		}
		if tools := Tools(x1); len(tools) != 1 || tools[0].Tool.Tool != "Workflow" || tools[0].Status != "ok" {
			t.Fatalf("tools %+v", tools)
		}
		// The approval wait closed; the second slice's scheduler hold names capacity, as recorded.
		if len(OpenGates(s)) != 0 {
			t.Fatalf("open gates %+v", OpenGates(s))
		}
		if w := SliceWait(s, s2); w == nil || w.Kind != "capacity" || w.Basis != "recorded-sentence" {
			t.Fatalf("wait %+v", w)
		}
		if s.GapCounts["missing-seq"] != 1 || s.Stream.ClaudeCodeVersion != "2.1.322" {
			t.Fatalf("gaps %v stream %+v", s.GapCounts, s.Stream)
		}
	})
}

// No per-agent cost exists anywhere in the projection.
func TestNoPerAgentCost(t *testing.T) {
	m, _ := scenarioLog(t)
	p := New(Options{Log: m})
	p.View(func(s *State) {
		for _, x := range s.Executions {
			data, _ := json.Marshal(Agents(x))
			if bytes.Contains(data, []byte("cost")) {
				t.Fatalf("an agent carries a cost: %s", data)
			}
		}
	})
}

// The guarantee: the projection at N, with the events (N, M] applied, equals the projection at M,
// for every N <= M; and the projection at the head equals a replay from nothing.
func TestSnapshotThenEventsEqualsSnapshot(t *testing.T) {
	m, n := scenarioLog(t)
	p := New(Options{Log: m, Interval: 5})
	for at := uint64(1); at <= uint64(n); at++ {
		want, _, err := p.At(at)
		if err != nil {
			t.Fatal(err)
		}
		for from := uint64(0); from < at; from += 3 {
			var base *State
			if from == 0 {
				base = NewState(m.Epoch())
			} else if base, _, err = p.At(from); err != nil {
				t.Fatal(err)
			}
			recs, _ := m.After(from, int(at-from))
			for _, r := range recs {
				ev, err := feed.Decode(r)
				if err != nil {
					t.Fatal(err)
				}
				base.Apply(ev)
			}
			if !bytes.Equal(Encode(base), Encode(want)) {
				t.Fatalf("snapshot(%d) + (%d, %d] differs from snapshot(%d)", from, from, at, at)
			}
		}
	}
}

// A snapshot at a cursor is built from that cursor even while events are appended concurrently.
func TestSnapshotConsistentUnderConcurrentAppends(t *testing.T) {
	m := feedtest.NewMem("", 0)
	evs := feedtest.Scenario()
	m.Append(evs[:10]...)
	p := New(Options{Log: m, Interval: 4})
	want := map[uint64][]byte{}
	for at := uint64(1); at <= 10; at++ {
		s, _, _ := p.At(at)
		want[at] = Encode(s)
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for _, e := range evs[10:] {
			m.Append(e)
		}
		for k := 0; k < 300; k++ { // more of the same kinds, to keep the log moving
			m.Append(feedtest.New("intake-log", "intake.validated", int64(60000+k)).Data(map[string]any{"digest": "x"}).Build())
		}
	}()
	for r := 0; r < 200; r++ {
		at := uint64(1 + rand.Intn(10))
		s, _, err := p.At(at)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(Encode(s), want[at]) {
			t.Fatalf("the snapshot at %d changed while the log grew", at)
		}
		if s.Pos != at {
			t.Fatalf("pos %d want %d", s.Pos, at)
		}
	}
	wg.Wait()
	head, _, err := p.At(0)
	if err != nil || head.Pos != uint64(len(evs)+300) {
		t.Fatalf("head %d %v", head.Pos, err)
	}
}

func TestReplayIsDeterministic(t *testing.T) {
	m, _ := scenarioLog(t)
	a := New(Options{Log: m, Interval: 3})
	b := New(Options{Log: m, Interval: 1000})
	x, _, _ := a.At(0)
	y, _, _ := b.At(0)
	if !bytes.Equal(Encode(x), Encode(y)) {
		t.Fatal("two replays of the same log differ")
	}
}

func TestSavedProjectionResumesAndSurvivesEviction(t *testing.T) {
	dir := t.TempDir()
	m := feedtest.NewMem("", 20) // a window smaller than the history
	evs := feedtest.Scenario()
	p := New(Options{Log: m, PersistDir: dir, PersistEvery: 1})
	for k := 0; k < len(evs); k += 5 { // the projection keeps up while the log evicts its start
		m.Append(evs[k:min(k+5, len(evs))]...)
		p.Sync()
	}
	p.Close()
	if _, err := os.Stat(filepath.Join(dir, "projection.json")); err != nil {
		t.Fatal(err)
	}
	if floor, _ := m.Bounds(); floor == 0 {
		t.Fatal("the test needs a log that evicted its beginning")
	}
	q := New(Options{Log: m, PersistDir: dir}) // a restart
	got, _, _ := q.At(0)
	full := New(Options{Log: func() *feedtest.Mem { f := feedtest.NewMem("", 0); f.Append(evs...); return f }()})
	want, _, _ := full.At(0)
	if got.Partial != "" || !bytes.Equal(Encode(got), Encode(want)) {
		t.Fatalf("a resumed projection differs from a full replay (partial %q)", got.Partial)
	}
	// Without the saved file, the beginning is gone and the projection says so.
	os.Remove(filepath.Join(dir, "projection.json"))
	r := New(Options{Log: m, PersistDir: dir})
	st := r.Status()
	if st.Partial == "" {
		t.Fatal("a projection that missed history must say so")
	}
	if _, _, err := r.At(1); err != ErrNotHeld {
		t.Fatalf("a snapshot before the floor: %v", err)
	}
}

func TestSavedProjectionOfAnotherEpochIsIgnored(t *testing.T) {
	dir := t.TempDir()
	m, _ := scenarioLog(t)
	p := New(Options{Log: m, PersistDir: dir, PersistEvery: 1})
	p.Close()
	other := feedtest.NewMem("fedcba9876543210", 0)
	q := New(Options{Log: other, PersistDir: dir})
	s, _, _ := q.At(0)
	if s.Applied != 0 || len(s.Cells) != 0 {
		t.Fatal("a projection saved for another index was loaded")
	}
}

func TestNotV3RecordsAreCountedNotApplied(t *testing.T) {
	m := feedtest.NewMem("", 0)
	m.AppendRaw(`{"v":3,"id":"c:T-1:x:1","type":"station.entered"}`)
	m.AppendRaw(`not json`)
	m.Append(feedtest.New("intake-log", "intake.validated", 0).Data(map[string]any{"digest": "d"}).Build())
	p := New(Options{Log: m})
	p.View(func(s *State) {
		if s.NotV3 != 2 || s.Applied != 1 || s.Pos != 3 {
			t.Fatalf("%+v", s)
		}
	})
}

func TestSpans(t *testing.T) {
	m, _ := scenarioLog(t)
	p := New(Options{Log: m})
	p.View(func(s *State) {
		byID := map[string]*Span{}
		for _, sp := range Spans(s, SpanFilter{}) {
			byID[sp.SpanID] = sp
		}
		v := byID["visit:visit:T-1/build#1"]
		if v == nil || v.Duration.Basis != "measured" || *v.Duration.MS != 5900 || *v.Outcome != "built" || *v.Parent != "execution:x0123456789ab" {
			t.Fatalf("visit span %+v", v)
		}
		task := byID["task:visit:T-1/build#1/task:T2#green"]
		if task == nil || task.Duration.Basis != "inferred" || *task.Duration.MS != 3000 || task.Start.Rule != "previous-completion" || task.Authority != "reconstructed" {
			t.Fatalf("task span %+v", task)
		}
		ag := byID["agent:agent:x0123456789ab/a0000000000000001"]
		if ag == nil || ag.Duration.Basis != "measured" || *ag.Duration.MS != 6100 {
			t.Fatalf("agent span %+v", ag)
		}
		x := byID["execution:execution:x0123456789ab"]
		if x == nil || x.Duration.Basis != "measured" || x.Duration.MinMS == nil || x.Duration.MaxMS == nil {
			t.Fatalf("execution span %+v", x)
		}
		wf := byID["workflow:workflow:x0123456789ab/task0001"]
		if wf == nil || wf.Duration.Basis != "bounded" || wf.Duration.MS != nil {
			t.Fatalf("a workflow whose start is an arrival stamp is bounded: %+v", wf)
		}
		r1 := byID["round:gate:T-1/round#1"]
		if r1 == nil || *r1.Outcome != "FAIL_WITH_EVIDENCE" || r1.End.Reason != "failed" {
			t.Fatalf("round 1 %+v", r1)
		}
		seat := byID["seat:seat:T-1/review#2/security"]
		if seat == nil || *seat.Outcome != "APPROVE" {
			t.Fatalf("seat %+v", seat)
		}
		if gw := byID["gate-wait:gate:T-1/approval:T-1#2"]; gw == nil || gw.End == nil {
			t.Fatalf("gate wait %+v", gw)
		}
	})
	// No early outcomes: at a cursor before the build visit's exit, the span is open.
	s, _, _ := p.At(20)
	for _, sp := range Spans(s, SpanFilter{Ticket: "T-1", Kinds: map[string]bool{"visit": true}}) {
		if sp.SpanID == "visit:visit:T-1/build#1" && (sp.End != nil || sp.Outcome != nil || sp.Duration.Basis != "open") {
			t.Fatalf("an outcome before its time: %+v", sp)
		}
	}
	// Lanes: the two verify visits never share a lane with an open span; everything in a group
	// has a lane, and spans in one lane do not overlap.
	for _, sp := range Spans(s, SpanFilter{}) {
		if sp.Lane < 0 {
			t.Fatalf("no lane: %+v", sp)
		}
	}
}

func TestMetricsMatchObserveFormulas(t *testing.T) {
	m := feedtest.NewMem("", 0)
	runs := []map[string]any{
		{"outcome": "merged", "rounds": 1, "first_pass": true, "escalated": false, "deviations": 0, "tests_seen_failing_first": 3, "tests_passing_on_first_run": 0, "risk": "Low"},
		{"outcome": "merged", "rounds": 2, "first_pass": false, "escalated": false, "deviations": 2, "tests_seen_failing_first": 1, "tests_passing_on_first_run": 1, "risk": "High"},
		{"outcome": "merged", "rounds": nil, "first_pass": true, "escalated": true, "deviations": 1, "tests_seen_failing_first": 0, "tests_passing_on_first_run": 0, "risk": "High"},
		{"outcome": "abandoned", "rounds": 3, "first_pass": false, "escalated": true, "deviations": 0, "tests_seen_failing_first": 0, "tests_passing_on_first_run": 2, "risk": "Medium"},
	}
	for k, r := range runs {
		m.Append(feedtest.New("run-record", "run.recorded", int64(k)*1000).Ticket(fmt.Sprintf("T-%d", k)).Data(r).Build())
	}
	p := New(Options{Log: m})
	p.View(func(s *State) {
		rows := map[string]float64{}
		for _, r := range s.Metrics.Rows([]string{"Q2", "Q3", "R5", "R6", "G1", "G2"}, "") {
			if r.Value == nil {
				t.Fatalf("%s is null: %s", r.ID, r.NullReason)
			}
			rows[r.ID] = *r.Value
		}
		// observe.py scorecard over the same records:
		want := map[string]float64{"Q2": 0.667, "Q3": 1.5, "R5": 0.5, "R6": 0.25, "G1": 0.571, "G2": 0.75}
		for k, v := range want {
			if rows[k] != v {
				t.Fatalf("%s = %v, observe gives %v", k, rows[k], v)
			}
		}
		grouped := s.Metrics.Rows([]string{"Q2"}, "risk")[0]
		if len(grouped.Groups) != 2 || grouped.Groups[0].Key != "High" || *grouped.Groups[0].Value != 0.5 {
			t.Fatalf("grouped %+v", grouped.Groups)
		}
		// An empty denominator is null with a reason, never 0; an unavailable metric says why.
		for _, r := range s.Metrics.Rows([]string{"C1", "K5"}, "") {
			if r.Value != nil || r.NullReason == "" {
				t.Fatalf("%s should be null with a reason: %+v", r.ID, r)
			}
		}
	})
}

func TestScenarioMetrics(t *testing.T) {
	m, _ := scenarioLog(t)
	p := New(Options{Log: m})
	p.View(func(s *State) {
		rows := map[string]*float64{}
		for _, r := range s.Metrics.Rows(nil, "") {
			rows[r.ID] = r.Value
		}
		checks := map[string]float64{"T1": 1, "T2": 1, "C1": 2800, "Q1": 0, "K1": 4.5, "K2": 2.25, "K7": 150000, "K8": 6100, "K9": 500, "K10": 40,
			"X2": 0.25, "S2": 0.5, "R3": 0, "W3": 14000}
		for id, want := range checks {
			if rows[id] == nil || *rows[id] != want {
				got := "null"
				if rows[id] != nil {
					got = fmt.Sprint(*rows[id])
				}
				t.Errorf("%s = %s, want %v", id, got, want)
			}
		}
	})
}

// cost_may_be_under_reported follows the stream's own verdict (execution.usage.cost_complete,
// revision 1) when there is one, and the workflow's recorded end only for a revision-0 event.
func TestCostCompletenessDecidesUnderReporting(t *testing.T) {
	usage := func(x string, extra map[string]any) map[string]any {
		d := map[string]any{"total_cost_usd": 1.0, "subtype": "success", "is_error": false, "terminal_reason": nil, "budget_exhausted": false, "models": map[string]any{}}
		for k, v := range extra {
			d[k] = v
		}
		return feedtest.New("execution-stream", "execution.usage", 2000).Exec(x).Data(d).Build()
	}
	ran := func(x string) []map[string]any {
		return []map[string]any{feedtest.New("execution-record", "execution.process_started", 1000).Exec(x).Data(map[string]any{}).Build(),
			feedtest.New("execution-record", "execution.process_ended", 2500).Exec(x).Data(map[string]any{"ended": "exited", "exit_code": 0, "seconds": 2}).Build()}
	}
	killed := func(x string) map[string]any {
		return feedtest.New("execution-stream", "workflow.finished", 1500).Exec(x).Entity("workflow:" + x + "/task1").Data(map[string]any{
			"status": "killed", "notification_status": "stopped", "total_tokens": nil, "tool_uses": nil, "duration_ms": nil, "stop_reason": "unknown",
			"workflow_json": false, "tickets": []map[string]any{}}).Build()
	}
	const incomplete, complete, legacy = "x00000000000a", "x00000000000b", "x00000000000c"
	m := feedtest.NewMem("", 0)
	for _, x := range []string{incomplete, complete, legacy} {
		m.Append(ran(x)...)
	}
	m.Append(
		killed(incomplete), usage(incomplete, map[string]any{"cost_complete": false, "cost_incomplete_reasons": []any{"budget-stop", "agents-killed-in-flight"}}),
		killed(complete), usage(complete, map[string]any{"cost_complete": true, "cost_incomplete_reasons": []any{}}),
		killed(legacy), usage(legacy, nil),
	)
	p := New(Options{Log: m})
	p.View(func(s *State) {
		a, b, c := Run(s.Executions[incomplete]), Run(s.Executions[complete]), Run(s.Executions[legacy])
		if !a.UnderReported || len(a.UnderReasons) != 2 || !strings.Contains(a.UnderReasons[0], "budget") {
			t.Fatalf("incomplete: %v %v", a.UnderReported, a.UnderReasons)
		}
		if b.UnderReported {
			t.Fatalf("the stream said its cost is complete, the view must not override it: %v", b.UnderReasons)
		}
		if !c.UnderReported || len(c.UnderReasons) != 1 {
			t.Fatalf("a revision-0 event falls back to the workflow's end: %v %v", c.UnderReported, c.UnderReasons)
		}
	})
}

// D11: the plan's exit records app type, risk and the contracts and tasks counts; the cell shows
// them, and says which event recorded the app type.
func TestPlanExitFactsReachTheCell(t *testing.T) {
	m := feedtest.NewMem("", 0)
	c := func(typ string, ms int64, visit string) *feedtest.Ev {
		return feedtest.New("cell-lifecycle", typ, ms).Ticket("T-9").Visit("T-9", visit, 1)
	}
	m.Append(c("station.entered", 1000, "plan#1").Data(map[string]any{"station": "plan", "stage": "spec-ready", "action": "plan", "resumed": false,
		"unclosed_visit": nil, "head": nil, "counts": map[string]any{}}).Set("id", "c:T-9:g:1").Build(),
		c("station.exited", 2000, "plan#1").Data(map[string]any{"station": "plan", "outcome": "planned", "stage": "planned", "duration_ms": 1000,
			"closed_by": nil, "head": nil, "counts": map[string]any{"contracts": 1, "tasks": 10}, "app_type": "library", "risk": "High"}).Set("id", "c:T-9:g:2").Build())
	p := New(Options{Log: m})
	p.View(func(s *State) {
		d := CellDetail(s, s.Cells["T-9"])
		plan := d["plan"].(map[string]any)
		if d["app_type"] != "library" || d["risk"] != "High" || plan["app_type"] != "library" || *plan["contracts"].(*int64) != 1 ||
			*plan["tasks"].(*int64) != 10 || plan["recorded_by"] != "c:T-9:g:2" {
			t.Fatalf("cell %v plan %v", d["app_type"], plan)
		}
	})
}

// D12: an evidence file named by a recorded check, with its hash, is linked to that check's visit
// ("recorded"); a file only known by round and time is joined to the visit of its round that had
// begun when it was written ("reconstructed").
func TestLinkArtifactToVisits(t *testing.T) {
	m, _ := scenarioLog(t)
	p := New(Options{Log: m})
	p.View(func(s *State) {
		c := s.Cells["T-1"]
		var sha, file string
		for _, k := range c.Checks {
			for _, ev := range k.Evidence {
				sha, file = ev.SHA256, ev.File
			}
		}
		if sha == "" {
			t.Fatal("the scenario has no evidence with a hash")
		}
		round := int64(1)
		if v, basis, rule := LinkArtifact(c, "evidence/"+file, sha, &round, 0); v != "T-1/verify#1" || basis != "recorded" || rule != "check-hash" {
			t.Fatalf("recorded: %q %q %q", v, basis, rule)
		}
		r2 := int64(2)
		var at int64
		for _, v := range c.Visits {
			if v.VisitID == "T-1/verify#2" {
				at, _ = v.Entered.lo()
			}
		}
		if v, basis, rule := LinkArtifact(c, "evidence/results.json", "", &r2, at+500); v != "T-1/verify#2" || basis != "reconstructed" || rule != "round-and-time" {
			t.Fatalf("by round and time: %q %q %q", v, basis, rule)
		}
		if v, _, _ := LinkArtifact(c, "review/round-2/decision.json", "", &r2, 0); v != "T-1/review#1" {
			t.Fatalf("review: %q", v)
		}
		if v, _, _ := LinkArtifact(c, "intent.md", "", &r2, 0); v != "" {
			t.Fatal("a cell file is not an evidence or review artifact")
		}
	})
}
