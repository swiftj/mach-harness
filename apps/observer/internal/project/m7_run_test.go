package project

import (
	"testing"

	"mach/observer/internal/feedtest"
)

// The shape of the M7 real Factory run (lending-desk; intake events seq 5-41 and 95-111):
// WAVE-003 approved at revision 2 with SLICE-005/006/003, SLICE-003 waiting at revision 4 for
// SLICE-005; the definition changes, intake validates WAVE-003 at revision 4 and the waiting
// ticket LOCAL-005 takes SLICE-003 revision 6 (revision.superseded with from_revision), then is
// blocked again at revision 6. LOCAL-003's claim xa1b6c30c0e44 is released without starting (the
// supervisor held the ticket in the same pass: "the readiness audit is stale"); a later execution
// is killed (how "killed", exit -9) after moving the ticket.
func m7Run() []map[string]any {
	i := func(typ string, ms int64) *feedtest.Ev {
		return feedtest.New("intake-log", typ, ms).ID("project_id", "lending-desk").ID("wave_id", "WAVE-003")
	}
	sl := func(e *feedtest.Ev, slice string, rev int) *feedtest.Ev {
		return e.ID("slice_id", slice).ID("revision", rev).Entity("slice:" + slice).Entity("wave:WAVE-003")
	}
	var out []map[string]any
	add := func(e *feedtest.Ev) { out = append(out, e.Build()) }
	add(i("wave.discovered", 0).ID("revision", 2).Entity("wave:WAVE-003").Data(map[string]any{"slices": []string{"SLICE-005", "SLICE-006", "SLICE-003"},
		"approval": map[string]any{"approved_at": "2026-11-14T22:12:50Z", "by_role": "person"}}))
	add(i("intake.validated", 0).ID("revision", 2).Entity("wave:WAVE-003").Data(map[string]any{"digest": "427809bf"}))
	add(sl(i("slice.materialized", 1000), "SLICE-005", 4).Ticket("LOCAL-003").Data(map[string]any{"digest": "a", "adopted": false, "dependencies": []string{}, "reissued": nil, "title": nil}))
	add(sl(i("slice.materialized", 1000), "SLICE-003", 4).Ticket("LOCAL-005").Data(map[string]any{"digest": "b", "adopted": false, "dependencies": []string{"SLICE-005"}, "reissued": nil, "title": nil}))
	add(sl(i("dependency.blocked", 1000), "SLICE-003", 4).Ticket("LOCAL-005").Data(map[string]any{"reasons": []string{"It waits for SLICE-005 to be integrated (now queued)."}}))
	add(i("intake.validated", 60_000).ID("revision", 4).Entity("wave:WAVE-003").Data(map[string]any{"digest": "70a281c5"}))
	add(sl(i("dependency.blocked", 60_000), "SLICE-003", 4).Ticket("LOCAL-005").Data(map[string]any{"reasons": []string{"The approved definition changed since intake. Run intake to take the new revision."}}))
	add(sl(i("revision.superseded", 60_000), "SLICE-003", 6).Ticket("LOCAL-005").Data(map[string]any{"from_revision": 4, "effect": "The waiting ticket now carries the new revision."}))
	add(sl(i("dependency.blocked", 61_000), "SLICE-003", 6).Ticket("LOCAL-005").Data(map[string]any{"reasons": []string{"It waits for SLICE-005 to be integrated (now queued)."}}))
	add(sl(i("work.scheduled", 100_000), "SLICE-005", 4).Ticket("LOCAL-003").Data(map[string]any{"stage": "spec-ready", "risk": "Medium", "branch": "feature/LOCAL-003", "by_role": "supervisor", "authorization": nil}))
	// The released claim, held in the same pass.
	add(i("scheduling.decided", 200_000).Data(map[string]any{"state": "supervised", "dispatched": []string{}, "started": []string{}, "held": []map[string]any{}}))
	add(i("work.claimed", 260_000).Ticket("LOCAL-003").Exec("xa1b6c30c0e44").ID("slice_id", "SLICE-005").Data(map[string]any{"stage": "building", "next": "build", "attempt": 1}))
	add(i("scheduling.decided", 260_000).Data(map[string]any{"state": "supervised", "dispatched": []string{}, "started": []string{},
		"held": []map[string]any{{"slice_id": "SLICE-005", "ticket_id": "LOCAL-003", "why": "the readiness audit is stale"}}}))
	// The next claim runs and is killed after it moved the ticket.
	add(i("work.claimed", 320_000).Ticket("LOCAL-003").Exec("x4e27653da783").ID("slice_id", "SLICE-005").Data(map[string]any{"stage": "building", "next": "build", "attempt": 1}))
	add(i("execution.started", 320_500).Ticket("LOCAL-003").Exec("x4e27653da783").ID("slice_id", "SLICE-005").Data(map[string]any{"until": "merge", "workflow": "mach-belt",
		"limits": map[string]any{"minutes": 30, "budget_usd": 2.5}, "provenance": nil, "provenance_reason": "not-recorded", "source_commit": nil}))
	add(i("scheduling.decided", 321_000).Data(map[string]any{"state": "supervised", "dispatched": []string{}, "started": []string{"LOCAL-003"}, "held": []map[string]any{}}))
	add(i("execution.completed", 400_000).Ticket("LOCAL-003").Exec("x4e27653da783").ID("slice_id", "SLICE-005").Data(map[string]any{"stage": "built", "next": "verify",
		"waiting_for": nil, "how": "killed", "exit_code": -9, "seen_to_end": false, "cost_usd": nil, "refused_tools": []string{}}))
	return out
}

// D6: a waiting ticket that takes a new revision is that slice at the new revision, blocked, not
// superseded; the wave carries the revision intake validated last.
func TestM7RevisionTakenByTheWaitingTicket(t *testing.T) {
	s := m66State(t, m7Run())
	sl := s.Slices["SLICE-003"]
	if sl == nil || sl.State != "blocked" || sl.Revision == nil || *sl.Revision != 6 || sl.TicketID != "LOCAL-005" || sl.Superseded != nil {
		t.Fatalf("SLICE-003 = %+v, want blocked at revision 6 under LOCAL-005", sl)
	}
	if len(sl.Revisions) != 1 || sl.Revisions[0].Revision == nil || *sl.Revisions[0].Revision != 4 {
		t.Errorf("earlier revisions = %+v, want revision 4 kept", sl.Revisions)
	}
	if w := s.Waves["WAVE-003"]; w == nil || w.Revision == nil || *w.Revision != 4 {
		t.Errorf("WAVE-003 = %+v, want revision 4 (validated by intake)", w)
	}
}

// D6: a definition change while the slice is in the line leaves the work's revision alone and
// records the newer one as pending; a withdrawal (no from_revision) still supersedes.
func TestM7RevisionPendingWhileInTheLineAndWithdrawal(t *testing.T) {
	ev := m7Run()
	add := func(e *feedtest.Ev) { ev = append(ev, e.Build()) }
	add(feedtest.New("intake-log", "revision.superseded", 500_000).ID("project_id", "lending-desk").ID("wave_id", "WAVE-003").ID("slice_id", "SLICE-005").ID("revision", 5).
		Entity("slice:SLICE-005").Ticket("LOCAL-003").Data(map[string]any{"from_revision": 4, "effect": "Work in progress is building an older revision."}))
	add(feedtest.New("intake-log", "revision.superseded", 500_000).ID("project_id", "lending-desk").ID("wave_id", "WAVE-003").ID("slice_id", "SLICE-003").ID("revision", 6).
		Entity("slice:SLICE-003").Ticket("LOCAL-005").Data(map[string]any{"from_revision": nil, "effect": "withdrawn"}))
	s := m66State(t, ev)
	if sl := s.Slices["SLICE-005"]; sl.State != "active" || *sl.Revision != 4 || sl.PendingRevision == nil || *sl.PendingRevision != 5 {
		t.Errorf("SLICE-005 = %s r%d pending %v, want active r4 with r5 pending", sl.State, *sl.Revision, sl.PendingRevision)
	}
	if sl := s.Slices["SLICE-003"]; sl.State != "superseded" {
		t.Errorf("SLICE-003 withdrawn = %s, want superseded", sl.State)
	}
}

// D10: a claim released without starting is "released", ends at the decision that released it,
// and is not an execution in X1, S1, S2 or K1 (each says so in its exclusions).
func TestM7ReleasedClaimIsNotAnExecution(t *testing.T) {
	s := m66State(t, m7Run())
	x := s.Executions["xa1b6c30c0e44"]
	if got := ExecStateIn(s, x); got != "released" {
		t.Fatalf("released claim state = %q, want released", got)
	}
	if end, inferred := execEnd(s, x); end == nil || !inferred || end.Pos != x.Released.Pos {
		t.Errorf("released claim ends at %+v (inferred %v), want the releasing decision", end, inferred)
	}
	if StateClass("released") != "finished" {
		t.Error("a released claim is not active")
	}
	for _, id := range []string{"X1", "S1", "S2"} {
		num, den := rateTotals(s, id)
		if den != 1 {
			t.Errorf("%s denominator = %v (numerator %v), want 1: only the killed execution is an execution", id, den, num)
		}
	}
	if n := exclusions(s, "K1", exReleased); n != 1 {
		t.Errorf("K1 exclusions for a released claim = %v, want 1", n)
	}
}

// Item 5: a killed execution that moved the ticket is "killed", never completed: S3 counts it as
// not completed and X1 as an execution that did not finish; its exit code is kept.
func TestM7KilledExecutionIsNotCompleted(t *testing.T) {
	s := m66State(t, m7Run())
	x := s.Executions["x4e27653da783"]
	if got := ExecStateIn(s, x); got != "killed" {
		t.Fatalf("killed execution state = %q", got)
	}
	if x.ExitCode == nil || *x.ExitCode != -9 {
		t.Errorf("exit code = %v, want -9", x.ExitCode)
	}
	if execReason("killed") != "interrupted" {
		t.Error("a killed execution's span does not end completed")
	}
	if num, den := rateTotals(s, "S3"); num != 0 || den != 1 {
		t.Errorf("S3 = %v/%v, want 0/1", num, den)
	}
	if num, _ := rateTotals(s, "X1"); num != 1 {
		t.Errorf("X1 numerator = %v, want 1 (the killed execution)", num)
	}
}

func rateTotals(s *State, id string) (num, den float64) {
	for _, r := range s.Metrics.Rows([]string{id}, "") {
		if r.Numerator != nil {
			num = *r.Numerator
		}
		if r.Denominator != nil {
			den = *r.Denominator
		}
	}
	return num, den
}

func exclusions(s *State, id, reason string) (n float64) {
	for _, r := range s.Metrics.Rows([]string{id}, "") {
		for _, x := range r.Coverage.Excluded {
			if x.Reason == reason {
				n += x.Count
			}
		}
	}
	return n
}

// M7 (7e23f84): an execution that is not progressing fails with not_progressing and the supervisor
// parks the ticket at once (human.required, the reason in its words): the gate carries the code.
func TestM7NotProgressingParksWithACode(t *testing.T) {
	ev := m7Run()
	add := func(e *feedtest.Ev) { ev = append(ev, e.Build()) }
	add(feedtest.New("intake-log", "work.claimed", 500_000).Ticket("LOCAL-003").Exec("xcd07441a6874").ID("slice_id", "SLICE-005").Data(map[string]any{"stage": "building", "next": "build", "attempt": 2}))
	add(feedtest.New("intake-log", "execution.failed", 600_000).Ticket("LOCAL-003").Exec("xcd07441a6874").ID("slice_id", "SLICE-005").Data(map[string]any{"stage": "building", "next": "build",
		"how": "exited", "claude_error": nil, "exit_code": 0, "attempt": 2, "not_progressing": "same-refusal"}))
	add(feedtest.New("intake-log", "human.required", 600_000).Ticket("LOCAL-003").Exec("xcd07441a6874").ID("slice_id", "SLICE-005").Data(map[string]any{
		"reason": "Two executions in a row stopped at build task T05, refused by build.green (suite-failing). Retrying would repeat it; the plan or the code needs a person."}))
	s := m66State(t, ev)
	if x := s.Executions["xcd07441a6874"]; x.NotProgressing != "same-refusal" || ExecStateIn(s, x) != "failed" {
		t.Fatalf("execution = %q %q", x.NotProgressing, ExecStateIn(s, x))
	}
	found := false
	for _, g := range OpenGates(s) {
		if g.TicketID == "LOCAL-003" && g.Kind == "required" {
			found = g.Code == "same-refusal"
		}
	}
	if !found {
		t.Fatal("LOCAL-003's open gate does not carry same-refusal")
	}
}
