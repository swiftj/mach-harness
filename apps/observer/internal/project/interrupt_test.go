package project

import (
	"testing"

	"mach/observer/internal/feedtest"
)

// Visits that never recorded an exit (lead's finding 4 of M6.3 wave 2): closed in the span
// projection at their execution's end or at the next entry of the same station, as the Control
// Tower's scene does (reduce-v3.ts closeVisits), never left running.

const xa = "x0123456789ab"

func ended(ms int64) *feedtest.Ev {
	return feedtest.New("execution-record", "execution.process_ended", ms).Exec(xa).Ticket("T-4").Data(map[string]any{"ended": "exited", "exit_code": 0, "seconds": 9})
}

func TestAVisitWhoseExecutionEndedIsClosedThere(t *testing.T) {
	evs := []*feedtest.Ev{
		feedtest.New("execution-record", "execution.process_started", 1000).Exec(xa).Ticket("T-4").Data(map[string]any{}),
		lc("station.entered", 2000, "T-4", "build#1", 1).Exec(xa).Data(map[string]any{"station": "build", "action": "revise"}),
		lc("station.entered", 2500, "T-4", "human-approval#1", 1).Exec(xa).Data(map[string]any{"station": "human-approval"}),
		ended(10000),
		lc("gate.evaluated", 15000, "T-4", "human-approval#1", 1).Data(map[string]any{"gate": "x", "verdict": "passed"}), // history goes on to 15 s
	}
	s := project(evs...)
	got := byID(Spans(s, SpanFilter{Kinds: map[string]bool{"visit": true}}))
	sp := got["visit:visit:T-4/build#1"]
	if sp == nil {
		t.Fatalf("no build visit in %v", keys(got))
	}
	if sp.End == nil || sp.End.Basis != "inferred" || sp.End.Rule != "execution-ended" || sp.End.Reason != "interrupted" || sp.Outcome != nil {
		t.Fatalf("end %+v outcome %v", sp.End, sp.Outcome)
	}
	if sp.Duration.Basis != "inferred" || sp.Duration.MS != nil || sp.Duration.MaxMS == nil || *sp.Duration.MaxMS != 8999 || sp.Authority != "reconstructed" {
		t.Fatalf("duration %+v authority %s", sp.Duration, sp.Authority)
	}
	if sp.To() != feedtest.At(10999) {
		t.Fatalf("to %d", sp.To())
	}
	// A wait on a person is not the execution's work: it stays open.
	if h := got["visit:visit:T-4/human-approval#1"]; h == nil || h.End != nil || h.Duration.Basis != "open" {
		t.Fatalf("human approval %+v", h)
	}
	// /concurrency: not active after the bound.
	at := feedtest.At
	b := Concurrency(s, at(5000), at(15000), 5000, map[string]bool{"visit": true})
	if b[0].Active["visit"].Max != 2 || b[1].Active["visit"].Max != 2 || b[1].Active["visit"].Mean >= 2 {
		t.Fatalf("buckets %+v", b)
	}
	if b = Concurrency(s, at(11000), at(15000), 1000, map[string]bool{"visit": true}); b[0].Active["visit"].Max != 1 || b[3].Active["visit"].Max != 1 {
		t.Fatalf("buckets %+v", b)
	}
	// An interruption mark at the bound, reconstructed.
	marks, _ := Marks(s, MarkFilter{Kinds: map[string]bool{"interruption": true}}, 10)
	if len(marks) != 1 || marks[0].AtMS != feedtest.At(10999) || feedStr(marks[0].Entity) != "visit:T-4/build#1" || marks[0].Authority != "reconstructed" || feedStr(marks[0].Verdict) != "interrupted" {
		t.Fatalf("marks %+v", marks)
	}

	// The exit arrives later, stamped after the bound: the recorded exit wins and the span says where it had stopped.
	evs = append(evs, lc("station.exited", 12000, "T-4", "build#1", 1).Exec(xa).Data(map[string]any{"station": "build", "outcome": "built"}))
	s = project(evs...)
	sp = byID(Spans(s, SpanFilter{Kinds: map[string]bool{"visit": true}}))["visit:visit:T-4/build#1"]
	if sp.End == nil || sp.End.Basis != "recorded" || feedStr(sp.Outcome) != "built" || sp.Duration.Basis != "measured" {
		t.Fatalf("recorded exit %+v %+v", sp.End, sp.Duration)
	}
	if sp.Attrs.InterruptedAt == nil || *sp.Attrs.InterruptedAt != feedtest.At(10999) || sp.Attrs.InterruptedReason != "interrupted" {
		t.Fatalf("attrs %+v", sp.Attrs)
	}
	if marks, _ := Marks(s, MarkFilter{Kinds: map[string]bool{"interruption": true}}, 10); len(marks) != 0 {
		t.Fatalf("an exited visit keeps no interruption mark: %+v", marks)
	}
}

// An exit delivered after the execution's end but stamped before it was never interrupted.
func TestALateDeliveredExitStampedEarlierIsNotAnInterruption(t *testing.T) {
	s := project(
		lc("station.entered", 2000, "T-4", "build#1", 1).Exec(xa).Data(map[string]any{"station": "build"}),
		ended(10000),
		lc("station.exited", 9000, "T-4", "build#1", 1).Exec(xa).Data(map[string]any{"station": "build", "outcome": "built"}),
	)
	sp := byID(Spans(s, SpanFilter{Kinds: map[string]bool{"visit": true}}))["visit:visit:T-4/build#1"]
	if sp.End.Basis != "recorded" || sp.Attrs.InterruptedAt != nil {
		t.Fatalf("%+v %+v", sp.End, sp.Attrs)
	}
}

func TestAVisitEnteredAgainIsSuperseded(t *testing.T) {
	s := project(
		lc("station.entered", 1000, "T-4", "verify#1", 1).Data(map[string]any{"station": "verify"}),
		lc("station.entered", 4000, "T-4", "verify#2", 1).Data(map[string]any{"station": "verify", "unclosed_visit": "verify#1"}),
	)
	got := byID(Spans(s, SpanFilter{Kinds: map[string]bool{"visit": true}}))
	sp := got["visit:visit:T-4/verify#1"]
	if sp.End == nil || sp.End.Rule != "unclosed-visit" || sp.End.Reason != "superseded" || sp.End.Basis != "inferred" || *sp.Duration.MaxMS != 3000 {
		t.Fatalf("%+v %+v", sp.End, sp.Duration)
	}
	if n := got["visit:visit:T-4/verify#2"]; n.End != nil {
		t.Fatalf("the newer visit is still open: %+v", n.End)
	}
	marks, _ := Marks(s, MarkFilter{Kinds: map[string]bool{"interruption": true}}, 10)
	if len(marks) != 1 || feedStr(marks[0].Verdict) != "superseded" {
		t.Fatalf("%+v", marks)
	}
}

func TestOnlyMaxParallelAppliesToSpanKinds(t *testing.T) {
	s := project(feedtest.New("intake-log", "factory.activated", 1000).ID("project_id", "P-1").Data(map[string]any{
		"autonomy": "supervised", "limits": map[string]any{"max_parallel": 2, "poll_seconds": 300}}))
	got := map[string][]string{}
	for _, l := range Limits(s) {
		got[l.Name] = l.AppliesTo
	}
	if len(got) != 2 || len(got["max_parallel"]) != 2 || got["max_parallel"][0] != "execution" || got["max_parallel"][1] != "cell" || got["poll_seconds"] != nil {
		t.Fatalf("%v", got)
	}
}
