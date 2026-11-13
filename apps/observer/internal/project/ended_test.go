package project

import (
	"testing"

	"mach/observer/internal/feedtest"
)

// M6.3 round 5: an execution stopped from outside says so, and nothing under an ended (or
// unknown-outcome) execution stays open.

const xc = "x0123456789cc"

func started(x, ticket string, ms int64) *feedtest.Ev {
	return feedtest.New("execution-record", "execution.process_started", ms).Exec(x).Ticket(ticket).Data(map[string]any{})
}

func processEnded(x, ticket string, ms int64, how string) *feedtest.Ev {
	return feedtest.New("execution-record", "execution.process_ended", ms).Exec(x).Ticket(ticket).Data(map[string]any{"ended": how, "exit_code": nil, "seconds": 1})
}

func failed(x, ticket string, ms int64, how string) *feedtest.Ev {
	return feedtest.New("intake-log", "execution.failed", ms).Exec(x).Ticket(ticket).Data(map[string]any{"attempt": 1, "how": how, "stage": "building", "next": "build"})
}

func claimed(x, ticket string, ms int64) *feedtest.Ev {
	return feedtest.New("intake-log", "work.claimed", ms).Exec(x).Ticket(ticket).Data(map[string]any{"attempt": 1, "stage": "planned", "next": "build"})
}

// Children of execution x: one workflow, one workflow agent and one main-loop tool call, all left
// open by the stream.
func openChildren(x string, ms int64) []*feedtest.Ev {
	wf := "workflow:" + x + "/task1"
	return []*feedtest.Ev{
		feedtest.New("execution-stream", "workflow.started", ms).Exec(x).Entity(wf).Data(map[string]any{"workflow": "mach-belt"}),
		feedtest.New("execution-stream", "agent.started", ms+100).Exec(x).ID("agent_id", x+"/a1").Parent(wf).Entity("agent:" + x + "/a1").Data(map[string]any{"index": 1, "label": "T-4: build"}),
		feedtest.New("execution-stream", "agent.started", ms+150).Exec(x).ID("agent_id", x+"/a2").Parent(wf).Entity("agent:" + x + "/a2").Data(map[string]any{"index": 2, "label": "T-4: build"}),
		feedtest.New("execution-stream", "tool.called", ms+200).Exec(x).ID("agent_id", x+"/main").ID("tool_call_id", x+"/toolu_1").Data(map[string]any{"tool": "Bash"}),
	}
}

// assertClosedUnder checks that no span of execution x is open and that each child closed at the
// execution's end reads as inferred, rule execution-ended, with the given reason, no outcome.
func assertClosedUnder(t *testing.T, s *State, x, reason string, toAtMost int64) {
	t.Helper()
	n := 0
	for _, sp := range Spans(s, SpanFilter{Execution: x}) {
		if sp.meta.src != srcExec {
			continue
		}
		if sp.End == nil {
			t.Errorf("%s is still open", sp.SpanID)
			continue
		}
		if sp.Kind == "execution" || sp.Kind == "claim" && sp.End.Basis == "recorded" {
			continue
		}
		n++
		e := sp.End
		if e.Basis != "inferred" || e.Rule != "execution-ended" || e.Reason != reason || sp.Outcome != nil || sp.Authority != "reconstructed" ||
			sp.Duration.Basis != "inferred" || sp.Duration.MS != nil {
			t.Errorf("%s: end %+v outcome %v authority %s duration %+v", sp.SpanID, e, sp.Outcome, sp.Authority, sp.Duration)
		}
		if sp.To() > toAtMost {
			t.Errorf("%s: active until %d, after the execution's end %d", sp.SpanID, sp.To(), toAtMost)
		}
	}
	if n < 4 {
		t.Errorf("only %d children closed under %s", n, x)
	}
}

// An interrupted process (result.json ended: interrupted; the supervisor then records
// execution.failed with how: interrupted) is interrupted, not failed; it never "took" its length;
// its open workflow, agents and tools close at its end; an interruption mark sits there.
func TestAnInterruptedExecutionIsNotAFailureAndLeavesNothingOpen(t *testing.T) {
	evs := append([]*feedtest.Ev{started(xc, "T-4", 1000)}, openChildren(xc, 2000)...)
	evs = append(evs,
		// The observer's own closing of one agent at the process end (contract 8): the same, inferred.
		feedtest.New("observer", "agent.finished", 9000).Exec(xc).ID("agent_id", xc+"/a2").Parent("workflow:"+xc+"/task1").
			Precision("bounded", nil, ptr(int64(3000)), ptr(int64(9999))).Data(map[string]any{"status": "unknown", "duration_ms": nil}),
		processEnded(xc, "T-4", 9000, "interrupted"),
		failed(xc, "T-4", 12000, "interrupted"),
		lc("gate.evaluated", 900000, "T-5", "plan#1", 1).Data(map[string]any{"gate": "x", "verdict": "passed"}), // history goes on
	)
	s := project(evs...)
	sp := byID(Spans(s, SpanFilter{}))
	x := sp["execution:execution:"+xc]
	if x == nil || x.End == nil || x.End.Reason != "interrupted" || x.Attrs.State != "interrupted" || x.Duration.Basis != "bounded" {
		t.Fatalf("execution: %+v end %+v duration %+v", x, x.End, x.Duration)
	}
	if got := Run(s.Executions[xc]); got.State != "interrupted" || got.Duration.Basis != "bounded" {
		t.Fatalf("/runs: %s %+v", got.State, got.Duration)
	}
	assertClosedUnder(t, s, xc, "interrupted", feedtest.At(9999))
	if a := s.Executions[xc].Agents[xc+"/a2"]; a.Status != "unknown" || a.Finished == nil {
		t.Fatalf("the observer's closing was not applied: %+v", a)
	}
	b := Concurrency(s, feedtest.At(100000), feedtest.At(200000), 100000, map[string]bool{"execution": true, "workflow": true, "agent": true, "tool": true})
	if len(b[0].Active) != 0 {
		t.Fatalf("counted active after the execution ended: %+v", b[0].Active)
	}
	marks, _ := Marks(s, MarkFilter{Kinds: map[string]bool{"interruption": true, "failure": true}}, 10)
	if len(marks) != 1 || marks[0].Kind != "interruption" || feedStr(marks[0].Verdict) != "interrupted" || marks[0].AtMS != feedtest.At(9999) {
		t.Fatalf("marks %+v", marks)
	}
}

// Without result.json, the supervisor's how still says the process was stopped.
func TestAFailureRecordThatSaysInterruptedIsAnInterruption(t *testing.T) {
	for _, how := range []string{"interrupted", "timed-out", "could-not-start"} {
		s := project(append(append([]*feedtest.Ev{started(xc, "T-4", 1000)}, openChildren(xc, 2000)...), failed(xc, "T-4", 9000, how))...)
		x := byID(Spans(s, SpanFilter{}))["execution:execution:"+xc]
		if x.End == nil || x.End.Reason != "interrupted" || x.Attrs.State != how || x.Duration.Basis == "measured" {
			t.Fatalf("%s: end %+v state %s duration %+v", how, x.End, x.Attrs.State, x.Duration)
		}
		assertClosedUnder(t, s, xc, "interrupted", feedtest.At(9999))
	}
}

// A process that ran to its end and reported a failure stays failed and measured.
func TestAGenuineFailureStaysFailed(t *testing.T) {
	s := project(started(xc, "T-4", 1000), processEnded(xc, "T-4", 9000, "exited"), failed(xc, "T-4", 12000, "exited"))
	x := byID(Spans(s, SpanFilter{}))["execution:execution:"+xc]
	if x.End.Reason != "failed" || x.Attrs.State != "failed" || x.Duration.Basis != "measured" || feedStr(x.Outcome) != "failed" {
		t.Fatalf("end %+v state %s duration %+v", x.End, x.Attrs.State, x.Duration)
	}
	marks, _ := Marks(s, MarkFilter{Kinds: map[string]bool{"interruption": true, "failure": true}}, 10)
	// At the supervisor's failure record, not the earlier process end: the outcome is not known before it.
	if len(marks) != 1 || marks[0].Kind != "failure" || marks[0].AtMS != feedtest.At(12999) {
		t.Fatalf("marks %+v", marks)
	}
}

// An execution whose process ended (interrupted) and whose outcome the supervisor could not learn:
// unknown, and its children close at the process end with reason unknown.
func TestAnUnknownOutcomeWithARecordedEndClosesItsChildren(t *testing.T) {
	evs := append([]*feedtest.Ev{started(xc, "T-4", 1000)}, openChildren(xc, 2000)...)
	evs = append(evs, processEnded(xc, "T-4", 9000, "interrupted"),
		feedtest.New("intake-log", "recovery.started", 30000).Exec(xc).Ticket("T-4").Data(map[string]any{"kind": "outcome-unknown"}))
	s := project(evs...)
	x := byID(Spans(s, SpanFilter{}))["execution:execution:"+xc]
	if x.End == nil || x.End.Reason != "unknown" || x.Attrs.State != "unknown" || x.Duration.Basis == "measured" {
		t.Fatalf("end %+v state %s duration %+v", x.End, x.Attrs.State, x.Duration)
	}
	assertClosedUnder(t, s, xc, "unknown", feedtest.At(9999))
}

// An outcome-unknown recovery with no recorded end: children close at the recovery, reason unknown.
func TestAnUnknownOutcomeWithoutAnEndClosesItsChildrenAtTheRecovery(t *testing.T) {
	evs := append([]*feedtest.Ev{started(xc, "T-4", 1000)}, openChildren(xc, 2000)...)
	evs = append(evs, feedtest.New("intake-log", "recovery.started", 30000).Exec(xc).Ticket("T-4").Data(map[string]any{"kind": "outcome-unknown"}))
	s := project(evs...)
	assertClosedUnder(t, s, xc, "unknown", feedtest.At(30999))
}

// No end and no recovery, but the supervisor claimed the ticket again later: the first execution
// ended by that claim (one execution runs a ticket at a time); its outcome is unknown.
func TestAnExecutionTheSupervisorMovedOnFromIsBoundedThere(t *testing.T) {
	const later = "x0123456789dd"
	evs := append([]*feedtest.Ev{claimed(xc, "T-4", 500), started(xc, "T-4", 1000)}, openChildren(xc, 2000)...)
	open := project(evs...)
	if x := byID(Spans(open, SpanFilter{}))["execution:execution:"+xc]; x.End != nil || x.Attrs.State != "running" {
		t.Fatalf("with nothing later it may still be running: %+v %s", x.End, x.Attrs.State)
	}
	evs = append(evs, claimed(later, "T-4", 40000), started(later, "T-4", 41000))
	s := project(evs...)
	x := byID(Spans(s, SpanFilter{}))["execution:execution:"+xc]
	if x.End == nil || x.End.At != nil || x.End.NotAfter == nil || x.End.Basis != "inferred" || x.End.Reason != "unknown" || x.Attrs.State != "unknown" || x.Outcome != nil {
		t.Fatalf("end %+v state %s outcome %v", x.End, x.Attrs.State, x.Outcome)
	}
	assertClosedUnder(t, s, xc, "unknown", feedtest.At(40999))
	if l := byID(Spans(s, SpanFilter{}))["execution:execution:"+later]; l.End != nil || l.Attrs.State != "running" {
		t.Fatalf("the later execution: %+v %s", l.End, l.Attrs.State)
	}
	marks, _ := Marks(s, MarkFilter{Kinds: map[string]bool{"interruption": true}}, 10)
	if len(marks) != 1 || feedStr(marks[0].Entity) != "execution:"+xc || marks[0].AtMS != feedtest.At(40999) || marks[0].Authority != "reconstructed" {
		t.Fatalf("marks %+v", marks)
	}
}

// attrs.state is sent on every execution span.
func TestEveryExecutionSpanCarriesItsState(t *testing.T) {
	s := project(claimed(xc, "T-4", 500), started(xc, "T-4", 1000))
	for _, sp := range Spans(s, SpanFilter{Kinds: map[string]bool{"execution": true}}) {
		if sp.Attrs.State == "" {
			t.Fatalf("%s has no state", sp.SpanID)
		}
	}
}
