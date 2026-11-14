package project

import (
	"fmt"
	"math"
	"os"
	"reflect"
	"testing"
	"time"

	"mach/observer/internal/feedtest"
)

// The M6.3 additions: wait history, capacity waits, attrs, windows, the cache, concurrency, marks.

func i64(v int64) *int64 { return &v }

func intake(typ string, ms int64) *feedtest.Ev {
	return feedtest.New("intake-log", typ, ms).ID("project_id", "P-1").ID("wave_id", "WAVE-009")
}

func slice(e *feedtest.Ev, id string) *feedtest.Ev {
	return e.ID("slice_id", id).ID("revision", 1).Entity("slice:" + id).Entity("wave:WAVE-009")
}

func lc(typ string, ms int64, ticket, visit string, round int) *feedtest.Ev {
	return feedtest.New("cell-lifecycle", typ, ms).Ticket(ticket).Visit(ticket, visit, round)
}

func project(evs ...*feedtest.Ev) *State {
	m := feedtest.NewMem("", 0)
	for _, e := range evs {
		m.Append(e.Build())
	}
	var out *State
	New(Options{Log: m}).View(func(s *State) { out = s })
	return out
}

func byID(spans []*Span) map[string]*Span {
	out := map[string]*Span{}
	for _, sp := range spans {
		out[sp.SpanID] = sp
	}
	return out
}

func TestEveryDependencyWaitAndCapacityWaitIsASpan(t *testing.T) {
	cap := func(state string, ms int64) *feedtest.Ev {
		return feedtest.New("observer", "capacity.wait_changed", ms).Ticket("T-9").Data(map[string]any{"state": state, "scope": "execution", "limit": 2})
	}
	s := project(
		slice(intake("slice.materialized", 0), "SLICE-9").Ticket("T-9").Data(map[string]any{"dependencies": []string{"SLICE-8"}}),
		slice(intake("dependency.blocked", 1000), "SLICE-9").Data(map[string]any{"reasons": []string{"SLICE-8 is not integrated yet"}}),
		slice(intake("dependency.blocked", 1500), "SLICE-9").Data(map[string]any{"reasons": []string{"SLICE-8 is still not integrated"}}),
		slice(intake("dependency.resolved", 3000), "SLICE-9").Data(map[string]any{"depends_on": []string{"SLICE-8"}}),
		slice(intake("dependency.blocked", 5000), "SLICE-9").Data(map[string]any{"reasons": []string{"SLICE-7 is not integrated yet"}}),
		slice(intake("dependency.resolved", 8000), "SLICE-9").Data(map[string]any{"depends_on": []string{"SLICE-7"}}),
		slice(intake("dependency.blocked", 9000), "SLICE-9").Data(map[string]any{"reasons": []string{"SLICE-6 is not integrated yet"}}),
		cap("waiting", 10000), cap("released", 12000), cap("waiting", 14000),
	)
	got := byID(Spans(s, SpanFilter{Kinds: map[string]bool{"slice-wait": true, "capacity-wait": true}}))
	if len(got) != 5 {
		t.Fatalf("want 3 slice waits and 2 capacity waits, got %d: %v", len(got), keys(got))
	}
	cases := []struct {
		id       string
		open     bool
		reasons  string
		dependOn string
	}{
		{"slice-wait:slice:SLICE-9", false, "SLICE-8 is still not integrated", "SLICE-8"},
		{"slice-wait:slice:SLICE-9#2", false, "SLICE-7 is not integrated yet", "SLICE-7"},
		{"slice-wait:slice:SLICE-9#3", true, "SLICE-6 is not integrated yet", ""},
	}
	for _, c := range cases {
		sp := got[c.id]
		if sp == nil {
			t.Fatalf("no %s in %v", c.id, keys(got))
		}
		if (sp.End == nil) != c.open || (c.open && sp.Duration.Basis != "open") || sp.Attrs.Reasons[0] != c.reasons {
			t.Errorf("%s: %+v %+v", c.id, sp.End, sp.Attrs)
		}
		if c.dependOn != "" && (len(sp.Attrs.DependsOn) != 1 || sp.Attrs.DependsOn[0] != c.dependOn) || c.dependOn == "" && sp.Attrs.DependsOn != nil {
			t.Errorf("%s depends_on %v", c.id, sp.Attrs.DependsOn)
		}
	}
	var closed, open int
	for id, sp := range got {
		if sp.Kind != "capacity-wait" {
			continue
		}
		if sp.Entity != "cell:T-9" || sp.IDs["ticket_id"] != "T-9" {
			t.Errorf("%s: %+v", id, sp)
		}
		if sp.End == nil {
			open++
		} else if *sp.Duration.MS == 2000 {
			closed++
		}
	}
	if closed != 1 || open != 1 {
		t.Fatalf("capacity waits: %d closed of 2 s, %d open", closed, open)
	}
	// The bound: the oldest are dropped and counted, ids do not move.
	var evs []*feedtest.Ev
	for k := 0; k < maxWaitsPerSlice+5; k++ {
		evs = append(evs, slice(intake("dependency.blocked", int64(k)*2000), "SLICE-1"), slice(intake("dependency.resolved", int64(k)*2000+1000), "SLICE-1"))
	}
	s = project(evs...)
	if sl := s.Slices["SLICE-1"]; len(sl.Waits) != maxWaitsPerSlice || sl.WaitsDropped != 5 {
		t.Fatalf("kept %d dropped %d", len(sl.Waits), sl.WaitsDropped)
	}
	if got := byID(Spans(s, SpanFilter{Kinds: map[string]bool{"slice-wait": true}})); got["slice-wait:slice:SLICE-1#6"] == nil || got["slice-wait:slice:SLICE-1"] != nil {
		t.Fatal("the first kept wait is #6")
	}
}

func keys[V any](m map[string]V) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestSpanWindowsExactLookupAndOrder(t *testing.T) {
	// a: measured 1 s to 3 s. b: its end bounded between 5 s and 9 s. c: open from 20 s.
	s := project(
		lc("station.entered", 1000, "T-5", "build#1", 1).Data(map[string]any{"station": "build", "action": "build"}),
		lc("station.exited", 3000, "T-5", "build#1", 1).Data(map[string]any{"station": "build", "outcome": "built"}),
		lc("station.entered", 4000, "T-5", "verify#1", 1).Data(map[string]any{"station": "verify", "action": "verify"}),
		lc("station.exited", 0, "T-5", "verify#1", 1).Precision("bounded", nil, i64(5000), i64(9000)).Data(map[string]any{"station": "verify"}),
		lc("station.entered", 20000, "T-5", "build#2", 2).Data(map[string]any{"station": "build", "action": "revise"}),
	)
	at := feedtest.At
	visits := func(f SpanFilter) []string {
		f.Kinds = map[string]bool{"visit": true}
		var out []string
		for _, sp := range Spans(s, f) {
			out = append(out, sp.Entity)
		}
		return out
	}
	a, b, c := "visit:T-5/build#1", "visit:T-5/verify#1", "visit:T-5/build#2"
	cases := []struct {
		name     string
		from, to *int64
		want     []string
	}{
		{"everything, sorted by start", nil, nil, []string{a, b, c}},
		{"before anything", i64(at(0)), i64(at(500)), nil},
		{"touching a's start", i64(at(0)), i64(at(1000)), []string{a}},
		{"inside the bounded end of b", i64(at(8000)), i64(at(8500)), []string{b}},
		{"after b's latest bound", i64(at(9001)), i64(at(19999)), nil},
		{"an open span overlaps everything after its start", i64(at(100000)), i64(at(200000)), []string{c}},
		{"from only", i64(at(2500)), nil, []string{a, b, c}},
		{"to only", nil, i64(at(4000)), []string{a, b}},
	}
	for _, tc := range cases {
		got := visits(SpanFilter{FromMS: tc.from, ToMS: tc.to})
		if fmt.Sprint(got) != fmt.Sprint(tc.want) {
			t.Errorf("%s: got %v want %v", tc.name, got, tc.want)
		}
	}
	one := Spans(s, SpanFilter{SpanID: "visit:" + b})
	if len(one) != 1 || one[0].End.NotAfter == nil || one[0].Duration.Basis != "bounded" || one[0].To() != at(9000) {
		t.Fatalf("exact lookup %+v", one)
	}
	if len(Spans(s, SpanFilter{SpanID: "visit:nope"})) != 0 {
		t.Fatal("an unknown id matches nothing")
	}
	if sp := Spans(s, SpanFilter{SpanID: "visit:" + c})[0]; sp.To() != math.MaxInt64 || sp.Attrs.Action != "revise" || *sp.Attrs.Round != 2 {
		t.Fatalf("open span %+v", sp)
	}
	// Cached per position: the same list until another event is applied.
	first := allSpans(s)
	if &allSpans(s)[0] != &first[0] {
		t.Fatal("the span list was rebuilt at the same position")
	}
}

func TestSpanAttrsAreOnlyRecordedFacts(t *testing.T) {
	m, _ := scenarioLog(t)
	New(Options{Log: m}).View(func(s *State) {
		got := byID(Spans(s, SpanFilter{}))
		ag := got["agent:agent:x0123456789ab/a0000000000000001"]
		if ag == nil || ag.Attrs.Label != "T-1: build" || ag.Attrs.Model != "claude-sonnet-5-5" || ag.Attrs.AgentType != "mach-builder" ||
			*ag.Attrs.ToolCalls != 40 || !ag.Attrs.ToolsCountOnly || ag.Attrs.LastTool != "Bash" || *ag.Attrs.Tokens != 150000 {
			t.Fatalf("agent attrs %+v", ag.Attrs)
		}
		x := got["execution:execution:x0123456789ab"]
		if x == nil || *x.Attrs.Attempt != 1 || x.Attrs.State != "finished" || x.Attrs.CostUSD == nil {
			t.Fatalf("execution attrs %+v", x.Attrs)
		}
		seat := got["seat:seat:T-1/review#2/security"]
		if seat == nil || seat.Attrs.Vote != "APPROVE" || *seat.Attrs.Round != 2 {
			t.Fatalf("seat attrs %+v", seat.Attrs)
		}
		if v := got["visit:visit:T-1/build#1"]; v.Attrs.Action != "build" || *v.Attrs.Round != 1 || v.Attrs.Tokens != nil || v.Attrs.CostUSD != nil {
			t.Fatalf("visit attrs %+v", v.Attrs)
		}
		// Nothing recorded, nothing sent: a cell span has no attrs at all.
		if c := got["cell:cell:T-1"]; !reflect.DeepEqual(c.Attrs, SpanAttrs{}) {
			t.Fatalf("cell attrs %+v", c.Attrs)
		}
	})
}

func TestConcurrencyAgainstAHandComputedCase(t *testing.T) {
	// A [0 s, 10 s), B [5 s, 15 s), C an instant at 12 s, D open from 25 s; the history holds up to 30 s.
	s := project(
		lc("station.entered", 0, "T-6", "build#1", 1),
		lc("station.exited", 10000, "T-6", "build#1", 1),
		lc("station.entered", 5000, "T-7", "build#1", 1),
		lc("station.exited", 15000, "T-7", "build#1", 1),
		lc("station.entered", 12000, "T-8", "build#1", 1),
		lc("station.exited", 12000, "T-8", "build#1", 1),
		lc("station.entered", 25000, "T-6", "verify#1", 1),
		lc("gate.evaluated", 30000, "T-6", "verify#1", 1).Data(map[string]any{"gate": "verify.start", "verdict": "passed"}),
	)
	b := Concurrency(s, feedtest.At(0), feedtest.At(40000), 10000, map[string]bool{"visit": true})
	want := []Active{{2, 1.5, 0, 2}, {2, 0.5, 0, 2}, {1, 0.5, 0, 1}, {}}
	if len(b) != 4 {
		t.Fatalf("buckets %d", len(b))
	}
	for i, w := range want {
		got := b[i].Active["visit"]
		if got != w || b[i].FromMS != feedtest.At(int64(i)*10000) {
			t.Errorf("bucket %d: got %+v want %+v", i, got, w)
		}
		if _, other := b[i].Active["cell"]; other {
			t.Errorf("bucket %d counts a kind that was not asked for", i)
		}
	}
}

func TestLimitHistory(t *testing.T) {
	s := project(
		intake("factory.activated", 0).Data(map[string]any{"autonomy": "supervised", "limits": map[string]any{"max_parallel": 2}}),
		intake("factory.activated", 60000).Data(map[string]any{"autonomy": "supervised", "limits": map[string]any{"max_parallel": 3}}),
		intake("factory.disabled", 120000),
		intake("factory.activated", 180000).Data(map[string]any{"autonomy": "observe", "limits": map[string]any{"max_parallel": 1}}),
	)
	l := Limits(s)
	if len(l) != 3 || l[0].Value != 2 || l[0].ToMS == nil || l[1].Value != 3 || *l[1].ToMS != l[1].FromMS+60000 || l[2].ToMS != nil {
		t.Fatalf("limits %+v", l)
	}
}

func TestMarksOrderAndNextPrevious(t *testing.T) {
	m, _ := scenarioLog(t)
	New(Options{Log: m}).View(func(s *State) {
		all, total := Marks(s, MarkFilter{}, 1000)
		if total != len(all) || total == 0 {
			t.Fatalf("total %d", total)
		}
		kinds := map[string]int{}
		for i, mk := range all {
			kinds[mk.Kind]++
			if i > 0 && (mk.AtMS < all[i-1].AtMS || mk.AtMS == all[i-1].AtMS && mk.ID < all[i-1].ID) {
				t.Fatalf("out of order at %d", i)
			}
			if mk.EventID == "" || mk.Label == "" || mk.At == "" {
				t.Fatalf("incomplete %+v", mk)
			}
		}
		for _, k := range []string{"failure", "retry", "gate", "review", "human", "recovery", "interruption", "gap", "wave", "merge"} {
			if kinds[k] == 0 {
				t.Errorf("no %s mark in the scenario: %v", k, kinds)
			}
		}
		var human *Mark
		for _, mk := range all {
			if mk.Kind == "human" && mk.Verdict != nil && *mk.Verdict == "required" {
				human = mk
			}
		}
		if human == nil || human.UntilMS == nil || *human.UntilMS <= human.AtMS {
			t.Fatalf("the approval gate is an interval: %+v", human)
		}
		fails := map[string]bool{"review": true}
		first, _ := Marks(s, MarkFilter{Kinds: fails}, 1)
		next, _ := Marks(s, MarkFilter{Kinds: fails, AfterMS: &first[0].AtMS}, 1)
		if len(next) != 1 || next[0].AtMS <= first[0].AtMS {
			t.Fatalf("next failure after %+v: %+v", first[0], next)
		}
		prev, n := Marks(s, MarkFilter{Kinds: fails, BeforeMS: &next[0].AtMS}, 5)
		if len(prev) == 0 || prev[0].ID != first[0].ID || n != len(prev) {
			t.Fatalf("previous failure before %+v: %+v", next[0], prev)
		}
		last := all[len(all)-1].AtMS
		if none, _ := Marks(s, MarkFilter{AfterMS: &last}, 5); len(none) != 0 {
			t.Fatal("nothing after the last mark")
		}
		win, _ := Marks(s, MarkFilter{FromMS: i64(human.AtMS + 1), ToMS: i64(human.AtMS + 2)}, 100)
		found := false
		for _, mk := range win {
			found = found || mk.ID == human.ID
		}
		if !found {
			t.Fatal("an interval mark overlaps a window inside it")
		}
	})
}

// TestSpanVolume measures /spans' work on a large history: a 10-minute window, built from
// scratch at every query (the old behaviour) and from the per-position cache. Set
// MACH_SPAN_VOLUME=1 to run it.
func TestSpanVolume(t *testing.T) {
	if os.Getenv("MACH_SPAN_VOLUME") == "" {
		t.Skip("set MACH_SPAN_VOLUME=1")
	}
	m := feedtest.NewMem("", 0)
	n := 0
	const cells, visits = 250, 100 // 250 cells x 100 visits x 10 events = 250,000
	var batch []map[string]any
	for c := 0; c < cells; c++ {
		t0 := int64(c) * 7000
		ticket := fmt.Sprintf("V-%03d", c)
		for v := 1; v <= visits; v++ {
			at := t0 + int64(v)*60000
			visit := fmt.Sprintf("build#%d", v)
			batch = append(batch, lc("station.entered", at, ticket, visit, 1).Data(map[string]any{"station": "build", "action": "build"}).Build())
			for g := 0; g < 8; g++ {
				batch = append(batch, lc("gate.evaluated", at+int64(g)*1000, ticket, visit, 1).Data(map[string]any{"gate": "build.green", "verdict": "refused"}).Build())
			}
			batch = append(batch, lc("station.exited", at+40000, ticket, visit, 1).Data(map[string]any{"station": "build", "outcome": "built"}).Build())
			n += 10
		}
	}
	m.Append(batch...)
	p := New(Options{Log: m})
	from, to := feedtest.At(3_000_000), feedtest.At(3_600_000)
	f := SpanFilter{FromMS: &from, ToMS: &to}
	p.View(func(s *State) {
		start := time.Now()
		var got int
		for k := 0; k < 5; k++ {
			s.spanCache = nil
			got = len(Spans(s, f))
		}
		uncached := time.Since(start) / 5
		Spans(s, f)
		start = time.Now()
		for k := 0; k < 20; k++ {
			Spans(s, f)
		}
		cached := time.Since(start) / 20
		start = time.Now()
		Marks(s, MarkFilter{FromMS: &from, ToMS: &to}, 1000)
		marksFirst := time.Since(start)
		start = time.Now()
		Concurrency(s, from, to, 1000, nil)
		conc := time.Since(start)
		t.Logf("%d events, %d spans in all, %d in the window: build per query %v, cached %v; marks first %v; concurrency (600 buckets) %v",
			n, len(allSpans(s)), got, uncached, cached, marksFirst, conc)
	})
}
