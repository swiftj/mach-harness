package project

import (
	"testing"

	"mach/observer/internal/feed"
	"mach/observer/internal/feedtest"
	"mach/observer/internal/metrics"
)

// The shape of a real supervised run (M6.6 live run, LOCAL-001..003): tickets filed at intake
// before any cell opens; LOCAL-001 reviewed AWAITING_HUMAN (lifecycle), its execution ending and
// the supervisor recording human.required ("waiting for human-approval") about 20 s later, a person
// approving 26 s after that, the merge, and the supervisor seeing SLICE-001 integrated a pass
// later; SLICE-003 then eligible and held by the supervisor for a reason recorded only in words.
func m66Run() []map[string]any {
	const x1 = "xeb8b948e8cf9"
	i := func(typ string, ms int64) *feedtest.Ev {
		return feedtest.New("intake-log", typ, ms).ID("project_id", "textkit").ID("wave_id", "WAVE-001")
	}
	sl := func(e *feedtest.Ev, slice string) *feedtest.Ev {
		return e.ID("slice_id", slice).ID("revision", 2).Entity("slice:" + slice).Entity("wave:WAVE-001")
	}
	c := func(typ string, ms int64, visit string, round int) *feedtest.Ev {
		return feedtest.New("cell-lifecycle", typ, ms).Ticket("LOCAL-001").ID("slice_id", "SLICE-001").ID("wave_id", "WAVE-001").Visit("LOCAL-001", visit, round)
	}
	var out []map[string]any
	add := func(e *feedtest.Ev) { out = append(out, e.Build()) }
	add(i("wave.discovered", 0).Entity("wave:WAVE-001").Data(map[string]any{"slices": []string{"SLICE-001", "SLICE-003"},
		"approval": map[string]any{"approved_at": "2026-11-13T09:00:00Z", "by_role": "person"}}))
	add(sl(i("slice.materialized", 0), "SLICE-001").Ticket("LOCAL-001").Data(map[string]any{"digest": "abc", "adopted": false, "dependencies": []string{}, "reissued": nil, "title": "Make a link name"}))
	add(sl(i("slice.materialized", 0), "SLICE-003").Ticket("LOCAL-003").Data(map[string]any{"digest": "def", "adopted": false, "dependencies": []string{"SLICE-001"}, "reissued": nil, "title": "Unique link name"}))
	add(sl(i("dependency.blocked", 0), "SLICE-003").Ticket("LOCAL-003").Data(map[string]any{"reasons": []string{"SLICE-001 is not integrated yet"}}))
	add(i("factory.activated", 100_000).Data(map[string]any{"autonomy": "supervised", "by_role": "engineer", "limits": map[string]any{"max_parallel": 2},
		"allow_merge": false, "persistent": false, "backlog": nil, "excluded_slices": []string{}}))
	add(sl(i("work.scheduled", 190_000), "SLICE-001").Ticket("LOCAL-001").Data(map[string]any{"stage": "spec-ready", "risk": "Medium", "branch": "feature/LOCAL-001", "by_role": "supervisor", "authorization": nil}))
	add(i("work.claimed", 191_000).Ticket("LOCAL-001").Exec(x1).ID("slice_id", "SLICE-001").Data(map[string]any{"stage": "spec-ready", "next": "plan", "attempt": 1}))
	add(c("review.decided", 412_760, "review#1", 1).Exec(x1).Data(map[string]any{"outcome": "AWAITING_HUMAN", "approvals": 3, "approvals_needed": 2,
		"votes": map[string]any{"architecture": "APPROVE", "security": "APPROVE", "product": "APPROVE"}, "blockers": 0, "security_veto": false, "human_approval_required": true}))
	add(c("station.exited", 412_761, "review#1", 1).Exec(x1).Data(map[string]any{"station": "review", "outcome": "AWAITING_HUMAN", "stage": "awaiting-human", "duration_ms": 4100, "closed_by": nil, "head": nil, "counts": map[string]any{}}))
	add(i("execution.completed", 433_000).Ticket("LOCAL-001").Exec(x1).ID("slice_id", "SLICE-001").Data(map[string]any{"stage": "awaiting-human", "next": "stop", "waiting_for": "human-approval",
		"how": "exited", "seen_to_end": true, "cost_usd": 1.15, "refused_tools": []string{"Bash: git"}}))
	add(sl(i("human.required", 433_000), "SLICE-001").Ticket("LOCAL-001").Data(map[string]any{"reason": "waiting for human-approval"}))
	add(c("human.approval_recorded", 458_941, "human-approval#1", 1).Data(map[string]any{"by_role": "person", "note_given": true}))
	add(feedtest.New("cell-lifecycle", "merge.completed", 463_076).Ticket("LOCAL-001").Visit("LOCAL-001", "merge#1", 0).Data(map[string]any{"method": "local", "merge_commit": "cbabbc635b5c", "approved_commit": "fc3ca1f70388", "landed_commit": "fc3ca1f70388", "revalidated": false, "pull_request": nil}))
	add(sl(i("slice.integrated", 494_000), "SLICE-001").Ticket("LOCAL-001").Data(map[string]any{"commit": "cbabbc635b5c"}))
	add(sl(i("dependency.resolved", 494_000), "SLICE-003").Ticket("LOCAL-003").Data(map[string]any{"depends_on": []string{"SLICE-001"}}))
	add(i("scheduling.decided", 495_000).Data(map[string]any{"state": "supervised", "dispatched": []string{}, "started": []string{},
		"held": []map[string]any{{"slice_id": "SLICE-003", "why": "Dispatch by 'supervisor' was not authorized: the readiness audit is stale. Nothing was dispatched."}}}))
	return out
}

func m66State(t *testing.T, events []map[string]any) *State {
	t.Helper()
	m := feedtest.NewMem("", 0)
	m.Append(events...)
	var out *State
	New(Options{Log: m, Interval: 7}).View(func(s *State) { out = CutAt(s, 1<<62) })
	return out
}

// D5: the supervisor's "waiting for a person" ends on the recorded approval, not on the next pass
// that sees the work integrated, and the ticket leaves the open gates then.
func TestRequiredGateEndsOnTheRecordedApproval(t *testing.T) {
	s := m66State(t, m66Run())
	approved := feedtest.At(458_941)
	for _, g := range s.Gates {
		if g.TicketID != "LOCAL-001" {
			continue
		}
		if g.Closed == nil || g.Closed.At == nil || *g.Closed.At != approved || g.ClosedBy != "human.approval_recorded" {
			t.Errorf("%s gate closed %+v by %q, want at the approval (%d)", g.Kind, g.Closed, g.ClosedBy, approved)
		}
	}
	for _, g := range OpenGates(CutAt(s, approved)) {
		if g.TicketID == "LOCAL-001" {
			t.Errorf("LOCAL-001 still has an open %s gate at the approval", g.Kind)
		}
	}
	if n := len(OpenGates(CutAt(s, approved-1))); n != 2 {
		t.Errorf("before the approval: %d open gates, want the approval and the supervisor's wait", n)
	}
	waits := 0
	for _, sp := range allSpans(s) {
		if sp.Kind == "person-wait" && sp.IDs["ticket_id"] == "LOCAL-001" {
			waits++
			if sp.End == nil || sp.End.At == nil || *sp.End.At != feed.FormatMS(approved) {
				t.Errorf("person-wait ends %+v, want at %s", sp.End, feed.FormatMS(approved))
			}
		}
	}
	if waits != 1 {
		t.Errorf("%d person-wait spans for LOCAL-001", waits)
	}
}

// A human.required recorded with no approval awaited (a parked ticket) is not ended by an approval.
func TestRequiredGateWithoutAnAwaitedApprovalStaysOpen(t *testing.T) {
	events := m66Run()
	var kept []map[string]any
	for _, e := range events {
		if e["type"] != "review.decided" {
			kept = append(kept, e)
		}
	}
	s := m66State(t, kept)
	open := 0
	for _, g := range OpenGates(CutAt(s, feedtest.At(460_000))) {
		if g.TicketID == "LOCAL-001" && g.Kind == "required" {
			open++
		}
	}
	if open != 1 {
		t.Fatalf("required gate open %d, want 1", open)
	}
}

// N6: a ticket filed at intake has no cell yet; it is not an active cell.
func TestTicketWithNoCellIsNotAnActiveCell(t *testing.T) {
	run := m66Run()
	active := ProjectView(m66State(t, run[:5]))["active_cells"].([]string)
	if len(active) != 0 {
		t.Fatalf("before any cell opened: active %v", active)
	}
	active = ProjectView(m66State(t, run[:7]))["active_cells"].([]string)
	if len(active) != 1 || active[0] != "LOCAL-001" {
		t.Fatalf("after dispatch: active %v", active)
	}
}

// D2 and D6: the slice carries its recorded title, and the supervisor's hold in its own words, on
// the slice's wait (rule "held", kind unknown: nothing classifies prose) and on its eligible span.
func TestHeldSliceCarriesItsRecordedReasonAndTitle(t *testing.T) {
	s := m66State(t, m66Run())
	why := "Dispatch by 'supervisor' was not authorized: the readiness audit is stale. Nothing was dispatched."
	v := SliceView(s, s.Slices["SLICE-003"])
	if v["title"] != "Unique link name" {
		t.Errorf("title %v", v["title"])
	}
	w := v["waiting"].(*Wait)
	if w == nil || w.Kind != "unknown" || w.Rule != "held" || len(w.Reasons) != 1 || w.Reasons[0] != why {
		t.Errorf("waiting %+v", w)
	}
	found := false
	for _, sp := range allSpans(s) {
		if sp.Kind == "slice-eligible" && sp.Entity == "slice:SLICE-003" {
			found = len(sp.Attrs.Reasons) == 1 && sp.Attrs.Reasons[0] == why
		}
	}
	if !found {
		t.Error("the eligible span does not carry the hold's words")
	}
	if got := CutAt(s, feedtest.At(494_000)).Slices["SLICE-003"].Holds; len(got) != 0 {
		t.Errorf("as of before the decision: holds %v", got)
	}
}

// The shape of the recorded real run replayed in M6.6 (REPORT 2; times in ms after 05:29:53):
// LOCAL-001 builds in one execution that ends while build#1 is open; a second execution fails and
// the supervisor asks for a person; SLICE-002 arrives; the engineer disables the Factory, later
// re-activates it and resumes with LOCAL-001 to retry; a third execution records build#1's exit
// an hour after it was entered, and fails; SLICE-002 is held for a free place.
func m66Retry() []map[string]any {
	const x1, x2, x3 = "x73bd00000001", "x62319da40f49", "x24760000003a"
	i := func(typ string, ms int64) *feedtest.Ev {
		return feedtest.New("intake-log", typ, ms).ID("project_id", "P-1")
	}
	sl := func(e *feedtest.Ev, slice, ticket string) *feedtest.Ev {
		return e.ID("slice_id", slice).ID("revision", 1).ID("wave_id", "WAVE-001").Entity("slice:" + slice).Ticket(ticket)
	}
	rec := func(typ string, ms int64, x string) *feedtest.Ev {
		return feedtest.New("execution-record", typ, ms).Exec(x).Ticket("LOCAL-001")
	}
	act := map[string]any{"autonomy": "supervised", "by_role": "engineer", "limits": map[string]any{"max_parallel": 1}, "allow_merge": false, "persistent": false, "backlog": "include", "excluded_slices": []string{}}
	var out []map[string]any
	add := func(e *feedtest.Ev) { out = append(out, e.Build()) }
	add(sl(i("slice.materialized", 0), "SLICE-001", "LOCAL-001").Data(map[string]any{"digest": "abc", "adopted": false, "dependencies": []string{}, "reissued": nil}))
	add(sl(i("dependency.resolved", 0), "SLICE-001", "LOCAL-001").Data(map[string]any{"depends_on": []string{}}))
	add(sl(i("work.scheduled", 4_000), "SLICE-001", "LOCAL-001").Data(map[string]any{"stage": "spec-ready", "risk": "High", "branch": "feature/LOCAL-001", "by_role": "engineer", "authorization": nil}))
	add(i("factory.activated", 18_000).Data(act))
	add(i("work.claimed", 22_000).Ticket("LOCAL-001").Exec(x1).ID("slice_id", "SLICE-001").Data(map[string]any{"stage": "spec-ready", "next": "plan", "attempt": 1}))
	add(rec("execution.process_started", 22_000, x1).Data(map[string]any{}))
	add(feedtest.New("cell-lifecycle", "station.entered", 182_893).Ticket("LOCAL-001").ID("slice_id", "SLICE-001").Visit("LOCAL-001", "build#1", 1).Exec(x1).
		Data(map[string]any{"station": "build", "stage": "building", "action": "build", "resumed": false, "unclosed_visit": nil, "head": "1111111", "counts": map[string]any{}}))
	add(rec("execution.process_ended", 318_000, x1).Data(map[string]any{"ended": "exited", "exit_code": 0, "seconds": 296}))
	add(i("execution.completed", 485_000).Ticket("LOCAL-001").Exec(x1).Data(map[string]any{"stage": "building", "next": "build", "waiting_for": nil, "how": "exited", "seen_to_end": true, "cost_usd": 1.2864, "refused_tools": []string{"Bash: git"}}))
	add(i("work.claimed", 485_000).Ticket("LOCAL-001").Exec(x2).ID("slice_id", "SLICE-001").Data(map[string]any{"stage": "building", "next": "build", "attempt": 1}))
	add(rec("execution.process_started", 485_000, x2).Data(map[string]any{}))
	add(rec("execution.process_ended", 576_000, x2).Data(map[string]any{"ended": "exited", "exit_code": 0, "seconds": 91}))
	add(i("execution.failed", 608_000).Ticket("LOCAL-001").Exec(x2).Data(map[string]any{"stage": "building", "next": "build", "how": "exited", "claude_error": nil, "exit_code": 0, "attempt": 1}))
	add(sl(i("human.required", 608_000), "SLICE-001", "LOCAL-001").Data(map[string]any{"reason": "1 execution(s) ended without moving it past 'building'."}))
	add(i("scheduling.decided", 608_000).Data(map[string]any{"state": "supervised", "dispatched": []string{}, "started": []string{},
		"held": []map[string]any{{"slice_id": "SLICE-001", "ticket_id": "LOCAL-001", "why": "waiting for a person: 1 execution(s) ended without moving it past 'building'."}}}))
	add(sl(i("slice.materialized", 669_000), "SLICE-002", "LOCAL-002").Data(map[string]any{"digest": "def", "adopted": false, "dependencies": []string{}, "reissued": nil}))
	add(sl(i("dependency.resolved", 669_000), "SLICE-002", "LOCAL-002").Data(map[string]any{"depends_on": []string{}}))
	add(i("factory.disabled", 731_000).Data(map[string]any{"by_role": "engineer", "stopped": []string{}}))
	add(i("factory.activated", 3_669_000).Data(act))
	add(i("factory.resumed", 3_669_000).Data(map[string]any{"by_role": "engineer", "retrying": []string{"LOCAL-001"}}))
	add(i("work.claimed", 3_717_000).Ticket("LOCAL-001").Exec(x3).ID("slice_id", "SLICE-001").Data(map[string]any{"stage": "building", "next": "build", "attempt": 1}))
	add(rec("execution.process_started", 3_717_000, x3).Data(map[string]any{}))
	add(i("scheduling.decided", 3_717_000).Data(map[string]any{"state": "supervised", "dispatched": []string{}, "started": []string{"LOCAL-001"},
		"held": []map[string]any{{"slice_id": "SLICE-002", "why": "it is ready and waits for a free place: 1 of 1 in use"}}}))
	add(feedtest.New("cell-lifecycle", "station.exited", 3_790_599).Ticket("LOCAL-001").ID("slice_id", "SLICE-001").Visit("LOCAL-001", "build#1", 1).Exec(x3).
		Data(map[string]any{"station": "build", "outcome": "built", "stage": "built", "duration_ms": 3607706, "closed_by": nil, "head": nil, "counts": map[string]any{}}))
	add(rec("execution.process_ended", 4_211_000, x3).Data(map[string]any{"ended": "exited", "exit_code": 0, "seconds": 494}))
	add(i("execution.failed", 4_228_000).Ticket("LOCAL-001").Exec(x3).Data(map[string]any{"stage": "building", "next": "build", "how": "exited", "claude_error": nil, "exit_code": 0, "attempt": 1}))
	return out
}

// D8: K1 and K4 keep their definition (execution.completed's cost); the two failed executions are
// excluded for the reason that is true of them, not as "no result".
func TestFailedExecutionsAreExcludedFromK1AsFailed(t *testing.T) {
	s := m66State(t, m66Retry())
	k1 := s.Metrics.Query(metrics.Query{IDs: []string{"K1"}})[0]
	if k1.Value == nil || *k1.Value != 1.2864 || *k1.Coverage.Counted != 1 || *k1.Coverage.Eligible != 3 {
		t.Fatalf("K1 %v coverage %+v", k1.Value, k1.Coverage)
	}
	got := map[string]float64{}
	for _, x := range k1.Coverage.Excluded {
		got[x.Reason] = x.Count
	}
	if got[exK1Failed] != 2 || got[exK1NoResult] != 0 || len(got) != 1 {
		t.Fatalf("excluded %v", got)
	}
}

// D5: the engineer's resume with LOCAL-001 to retry ends its wait for a person, not the claim 48 s later.
func TestResumeWithRetryEndsTheWaitForAPerson(t *testing.T) {
	s := m66State(t, m66Retry())
	for _, g := range s.Gates {
		if g.TicketID == "LOCAL-001" && (g.Closed == nil || g.ClosedBy != "factory.resumed" || g.Closed.OrderMS != feedtest.At(3_669_999)) {
			t.Fatalf("gate %+v closed %+v by %q", g, g.Closed, g.ClosedBy)
		}
	}
}

// D10: LOCAL-002 was never dispatched and has no cell: no cell span, not a cell in the flow.
func TestNeverDispatchedTicketHasNoCellSpan(t *testing.T) {
	s := m66State(t, m66Retry())
	for _, sp := range allSpans(s) {
		if sp.Kind == "cell" && sp.Entity == "cell:LOCAL-002" {
			t.Fatalf("cell span for a ticket with no cell: %+v", sp)
		}
	}
	if f := BuildFlow(s, allSpans(s)).Flow(FlowQuery{}); f.Coverage.Tickets != 1 || f.Coverage.TicketsWithLifecycle != 1 {
		t.Fatalf("flow coverage %+v", f.Coverage)
	}
}

// D11: SLICE-002's wait for a free place starts at its first record, not before the slice existed
// nor across the disabled Factory.
func TestCapacityWaitStartsAtItsFirstRecordAfterReactivation(t *testing.T) {
	s := m66State(t, m66Retry())
	w := s.Pending.SliceCapacity["SLICE-002"]
	if w == nil || w.Opened == nil || w.Opened.OrderMS != feedtest.At(3_717_999) || w.Opened.Precision == "bounded" || *w.Opened.NotBefore < feedtest.At(3_717_000) {
		t.Fatalf("wait %+v opened %+v", w, w.Opened)
	}
}

// D9: build#1 was entered by the first execution and exited by the third an hour later: not
// continuous work. It is bounded, not measured: no C1 measured duration, and the flow's measured
// station time leaves it out (counted under bounded).
func TestNotContinuousVisitIsNotMeasuredStationTime(t *testing.T) {
	s := m66State(t, m66Retry())
	c1 := s.Metrics.Query(metrics.Query{IDs: []string{"C1"}})[0]
	if c1.Value != nil {
		t.Fatalf("C1 measured value %v from a not-continuous visit; coverage %+v", *c1.Value, c1.Coverage)
	}
	for _, sp := range allSpans(s) {
		if sp.Entity == "visit:LOCAL-001/build#1" && (sp.Duration.Basis != "bounded" || sp.Attrs.InterruptedAt == nil) {
			t.Fatalf("build#1 %+v %+v", sp.Duration, sp.Attrs)
		}
	}
	for _, st := range BuildFlow(s, allSpans(s)).Flow(FlowQuery{}).Stations {
		if st.Station == "build" && (st.Duration.Measured != nil || st.Duration.Basis["bounded"] != 1) {
			t.Fatalf("build %+v", st.Duration)
		}
	}
}
