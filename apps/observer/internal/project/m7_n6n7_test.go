package project

import (
	"testing"

	"mach/observer/internal/feedtest"
)

// The second live run's records (lending-desk, intake seq 105-197 and the archive's runs.jsonl):
// xa1b6c30c0e44 released before starting; LOCAL-003 abandoned, the supervisor then asking a person
// ("Its ticket LOCAL-003 was abandoned. Reissue it to try again.") and intake reissuing SLICE-005 as
// LOCAL-006 (slice.materialized, reissued true); x207c3682ca00 killed without moving the ticket
// (execution.failed, how "killed", exit -9).
func m7Run2() []map[string]any {
	i := func(typ string, ms int64) *feedtest.Ev {
		return feedtest.New("intake-log", typ, ms).ID("project_id", "lending-desk").ID("wave_id", "WAVE-003")
	}
	var out []map[string]any
	add := func(e *feedtest.Ev) { out = append(out, e.Build()) }
	add(i("slice.materialized", 0).ID("slice_id", "SLICE-005").ID("revision", 4).Entity("slice:SLICE-005").Ticket("LOCAL-003").
		Data(map[string]any{"digest": "a", "adopted": false, "dependencies": []string{}, "reissued": nil, "title": nil}))
	add(i("work.claimed", 10_000).Ticket("LOCAL-003").Exec("xa1b6c30c0e44").ID("slice_id", "SLICE-005").Data(map[string]any{"stage": "building", "next": "build", "attempt": 1}))
	add(i("scheduling.decided", 10_000).Data(map[string]any{"state": "supervised", "dispatched": []string{}, "started": []string{},
		"held": []map[string]any{{"slice_id": "SLICE-005", "ticket_id": "LOCAL-003", "why": "the readiness audit is stale"}}}))
	add(feedtest.New("run-record", "run.recorded", 50_000).Ticket("LOCAL-003").ID("slice_id", "SLICE-005").Data(map[string]any{"record_version": 2, "outcome": "abandoned"}))
	add(i("human.required", 60_000).ID("slice_id", "SLICE-005").ID("revision", 4).Ticket("LOCAL-003").Data(map[string]any{"reason": "Its ticket LOCAL-003 was abandoned. Reissue it to try again."}))
	add(i("slice.materialized", 70_000).ID("slice_id", "SLICE-005").ID("revision", 4).Entity("slice:SLICE-005").Ticket("LOCAL-006").
		Data(map[string]any{"digest": "a", "adopted": false, "dependencies": []string{}, "reissued": true, "title": nil}))
	add(i("work.claimed", 100_000).Ticket("LOCAL-006").Exec("x207c3682ca00").ID("slice_id", "SLICE-005").Data(map[string]any{"stage": "spec-ready", "next": "plan", "attempt": 1}))
	add(i("execution.started", 100_500).Ticket("LOCAL-006").Exec("x207c3682ca00").ID("slice_id", "SLICE-005").Data(map[string]any{"until": "merge", "workflow": "mach-belt",
		"limits": map[string]any{"minutes": 30, "budget_usd": 2.5}, "provenance": nil, "provenance_reason": "not-recorded", "source_commit": nil}))
	add(i("execution.failed", 200_000).Ticket("LOCAL-006").Exec("x207c3682ca00").ID("slice_id", "SLICE-005").Data(map[string]any{"attempt": 1, "claude_error": nil,
		"exit_code": -9, "how": "killed", "next": "plan", "stage": "spec-ready"}))
	return out
}

// N6: a killed execution that did not move the ticket (execution.failed) is killed in runs and
// spans, with its exit code; a released claim's span ends with its own reason.
func TestM7N6KilledByFailureAndReleasedReason(t *testing.T) {
	s := m66State(t, m7Run2())
	x := s.Executions["x207c3682ca00"]
	if got := ExecStateIn(s, x); got != "killed" {
		t.Fatalf("state = %q, want killed", got)
	}
	var exec, claim *Span
	for _, sp := range allSpans(s) {
		switch sp.SpanID {
		case "execution:execution:x207c3682ca00":
			exec = sp
		case "claim:execution:xa1b6c30c0e44":
			claim = sp
		}
	}
	if exec == nil || exec.Outcome == nil || *exec.Outcome != "killed" || exec.Attrs.ExitCode == nil || *exec.Attrs.ExitCode != -9 {
		t.Fatalf("killed span = %+v", exec)
	}
	if claim == nil || claim.End == nil || claim.End.Reason != "released" {
		t.Fatalf("released claim span = %+v", claim)
	}
	if num, _ := rateTotals(s, "X1"); num != 1 {
		t.Errorf("X1 numerator = %v, want 1 (killed counted with failures)", num)
	}
}

// N7: an abandoned ticket is abandoned, not waiting on a person, even when asked about after it was
// abandoned; and it says what it was reissued as.
func TestM7N7AbandonedAndReissued(t *testing.T) {
	s := m66State(t, m7Run2())
	c := s.Cells["LOCAL-003"]
	if c == nil || c.Abandoned == nil || c.ReissuedAs != "LOCAL-006" {
		t.Fatalf("LOCAL-003 = %+v", c)
	}
	for _, g := range OpenGates(s) {
		if g.TicketID == "LOCAL-003" {
			t.Errorf("LOCAL-003 still waits on a person: %+v", g)
		}
	}
	if v := CellSummary(c); v["abandoned"] != true || v["reissued_as"] != "LOCAL-006" {
		t.Errorf("cell summary = %v", v)
	}
}
