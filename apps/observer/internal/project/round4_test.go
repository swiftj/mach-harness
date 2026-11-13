package project

import (
	"testing"

	"mach/observer/internal/feedtest"
)

// M6.3 round 4: T1, T2, T9, T13 and marks paging.

const xb = "x0123456789bb"

// T1: an execution whose outcome is unknown and that recorded no end is closed at the recovery as
// a bound (not_after, no at), inferred, no outcome, reconstructed; its visits and open children
// close there too, and /concurrency stops counting them after it.
func TestAnUnknownOutcomeExecutionIsClosedAtItsRecovery(t *testing.T) {
	s := project(
		feedtest.New("execution-record", "execution.process_started", 1000).Exec(xa).Ticket("T-4").Data(map[string]any{}),
		lc("station.entered", 2000, "T-4", "build#1", 1).Exec(xa).Data(map[string]any{"station": "build"}),
		feedtest.New("intake-log", "recovery.started", 50000).Exec(xa).Ticket("T-4").Data(map[string]any{"kind": "outcome-unknown"}),
		lc("gate.evaluated", 900000, "T-5", "plan#1", 1).Data(map[string]any{"gate": "x", "verdict": "passed"}),
	)
	sp := byID(Spans(s, SpanFilter{}))
	for _, id := range []string{"execution:execution:" + xa, "visit:visit:T-4/build#1"} {
		x := sp[id]
		if x == nil || x.End == nil {
			t.Fatalf("%s: open or missing: %+v", id, x)
		}
		e := x.End
		if e.At != nil || e.NotAfter == nil || e.Precision != "bounded" || e.Basis != "inferred" ||
			e.Rule != "execution-outcome-unknown" || e.Reason != "unknown" {
			t.Errorf("%s end %+v", id, e)
		}
		if x.Outcome != nil || x.Authority != "reconstructed" || x.Duration.Basis != "inferred" || x.Duration.MS != nil || x.Duration.MaxMS == nil {
			t.Errorf("%s: outcome %v authority %s duration %+v", id, x.Outcome, x.Authority, x.Duration)
		}
		if x.To() < feedtest.At(50000) || x.To() >= feedtest.At(51000) {
			t.Errorf("%s: active until %d", id, x.To())
		}
	}
	b := Concurrency(s, feedtest.At(800000), feedtest.At(900000), 100000, map[string]bool{"execution": true, "visit": true})
	if len(b[0].Active) != 0 {
		t.Fatalf("still counted long after the recovery: %+v", b[0].Active)
	}
	b = Concurrency(s, feedtest.At(0), feedtest.At(100000), 100000, map[string]bool{"execution": true})
	if a := b[0].Active["execution"]; a.Max != 1 || a.InferredMax != 1 {
		t.Fatalf("before the recovery: %+v", a)
	}
}

// T2: a visit whose only exit was written by cleanup reads as inferred, never measured.
func TestACleanupClosedVisitIsInferred(t *testing.T) {
	s := project(
		lc("station.entered", 2000, "T-4", "build#1", 1).Data(map[string]any{"station": "build"}),
		lc("station.exited", 9000000, "T-4", "build#1", 1).Data(map[string]any{"station": "build", "outcome": "abandoned", "closed_by": "cleanup"}),
	)
	v := byID(Spans(s, SpanFilter{}))["visit:visit:T-4/build#1"]
	if v.End.Basis != "inferred" || v.End.Rule != "closed-by-cleanup" || v.End.Reason != "unknown" || v.Outcome != nil ||
		v.Duration.Basis != "inferred" || v.Duration.MS != nil || v.Duration.MaxMS == nil || v.Authority != "reconstructed" {
		t.Fatalf("cleanup-closed visit: end %+v outcome %v duration %+v authority %s", v.End, v.Outcome, v.Duration, v.Authority)
	}
	b := Concurrency(s, feedtest.At(0), feedtest.At(100000), 100000, map[string]bool{"visit": true})
	if a := b[0].Active["visit"]; a.Max != 1 || a.InferredMax != 1 {
		t.Fatalf("counted as recorded: %+v", a)
	}
	marks, _ := Marks(s, MarkFilter{Kinds: map[string]bool{"interruption": true}}, 10)
	if len(marks) != 1 || marks[0].Authority != "reconstructed" {
		t.Fatalf("interruption marks %+v", marks)
	}
}

// T2: a cleanup-closed visit whose execution ended earlier is closed at the execution's end.
func TestACleanupClosedVisitTakesTheEarlierBound(t *testing.T) {
	s := project(
		feedtest.New("execution-record", "execution.process_started", 1000).Exec(xa).Ticket("T-4").Data(map[string]any{}),
		lc("station.entered", 2000, "T-4", "build#1", 1).Exec(xa).Data(map[string]any{"station": "build"}),
		ended(60000),
		lc("station.exited", 9000000, "T-4", "build#1", 1).Exec(xa).Data(map[string]any{"station": "build", "outcome": "abandoned", "closed_by": "cleanup"}),
	)
	v := byID(Spans(s, SpanFilter{}))["visit:visit:T-4/build#1"]
	if v.End.Rule != "execution-ended" || v.To() < feedtest.At(60000) || v.To() >= feedtest.At(61000) || v.Outcome != nil {
		t.Fatalf("end %+v to %d", v.End, v.To())
	}
}

// T9: recorded and inferred ends are told apart per bucket.
func TestConcurrencySaysHowManyEndsAreInferred(t *testing.T) {
	s := project(
		feedtest.New("execution-record", "execution.process_started", 1000).Exec(xa).Ticket("T-4").Data(map[string]any{}),
		lc("station.entered", 2000, "T-4", "build#1", 1).Exec(xa).Data(map[string]any{"station": "build"}),
		ended(30000),
		lc("station.entered", 3000, "T-5", "build#1", 1).Data(map[string]any{"station": "build"}),
		lc("station.exited", 20000, "T-5", "build#1", 1).Data(map[string]any{"station": "build", "outcome": "passed"}),
	)
	b := Concurrency(s, feedtest.At(0), feedtest.At(40000), 10000, map[string]bool{"visit": true})
	// The bound (a whole-second stamp) is active to the end of its second.
	want := []Active{{2, 1.5, 1}, {2, 2, 1}, {1, 1, 1}, {1, 0.1, 1}}
	for i, w := range want {
		if got := b[i].Active["visit"]; got != w {
			t.Errorf("bucket %d: got %+v want %+v", i, got, w)
		}
	}
}

// T13: retry is a revise visit only; attempt is a cell's execution after its first by start
// order, even when the recorded attempt number repeats.
func TestRetryAndAttemptMarksAreApart(t *testing.T) {
	claim := func(x string, ms int64) *feedtest.Ev {
		return feedtest.New("intake-log", "work.claimed", ms).Ticket("T-4").Exec(x).Data(map[string]any{"stage": "planned", "next": "build", "attempt": 1})
	}
	s := project(
		claim(xa, 1000),
		lc("station.entered", 2000, "T-4", "build#1", 1).Exec(xa).Data(map[string]any{"station": "build"}),
		lc("station.exited", 3000, "T-4", "build#1", 1).Exec(xa).Data(map[string]any{"station": "build", "outcome": "built"}),
		claim(xb, 10000),
		lc("station.entered", 11000, "T-4", "build#2", 2).Exec(xb).Data(map[string]any{"station": "build", "action": "revise"}),
	)
	marks, _ := Marks(s, MarkFilter{Kinds: map[string]bool{"retry": true, "attempt": true}}, 10)
	if len(marks) != 2 || marks[0].Kind != "attempt" || *marks[0].Entity != "execution:"+xb || marks[1].Kind != "retry" || *marks[1].Entity != "visit:T-4/build#2" {
		for _, m := range marks {
			t.Logf("%s %s %v %s", m.Kind, m.ID, *m.Entity, m.Label)
		}
		t.Fatalf("marks %d", len(marks))
	}
}

// T8: marks page to completion in a stable order.
func TestMarksPageWithAnOffset(t *testing.T) {
	var evs []*feedtest.Ev
	for i := range 25 {
		evs = append(evs, lc("gate.evaluated", int64(1000+i/2*1000), "T-4", "build#1", 1).Data(map[string]any{"gate": "g", "verdict": "passed"}))
	}
	s := project(evs...)
	all, total := Marks(s, MarkFilter{}, 1000)
	var paged []*Mark
	for off := 0; ; off += 10 {
		page, tot := Marks(s, MarkFilter{Offset: off}, 10)
		if tot != total {
			t.Fatalf("total %d then %d", total, tot)
		}
		paged = append(paged, page...)
		if off+len(page) >= tot {
			break
		}
	}
	if len(paged) != len(all) || total != 25 {
		t.Fatalf("paged %d of %d (%d)", len(paged), len(all), total)
	}
	for i := range all {
		if paged[i].ID != all[i].ID {
			t.Fatalf("order differs at %d", i)
		}
	}
}

// Recheck R3: a visit closed only by cleanup is bounded by the cell's next entry into another
// station, not counted active until cleanup hours later.
func TestACleanupClosedVisitEndsWhenTheCellMovesOn(t *testing.T) {
	s := project(
		lc("station.entered", 2000, "T-4", "build#1", 1).Data(map[string]any{"station": "build"}),
		lc("station.entered", 10000, "T-4", "verify#1", 1).Data(map[string]any{"station": "verify"}),
		lc("station.exited", 20000, "T-4", "verify#1", 1).Data(map[string]any{"station": "verify", "outcome": "passed"}),
		lc("station.exited", 9000000, "T-4", "build#1", 1).Data(map[string]any{"station": "build", "outcome": "abandoned", "closed_by": "cleanup"}),
	)
	v := byID(Spans(s, SpanFilter{}))["visit:visit:T-4/build#1"]
	if v.End == nil || v.End.Rule != "unclosed-visit" || v.End.Reason != "superseded" || v.To() > feedtest.At(10999) {
		t.Fatalf("end %+v to %d", v.End, v.To())
	}
	b := Concurrency(s, feedtest.At(1000000), feedtest.At(1010000), 10000, map[string]bool{"visit": true})
	if len(b) == 0 || b[0].Active["visit"].Max != 0 {
		t.Fatalf("still counted long after the cell moved on: %+v", b)
	}
}
