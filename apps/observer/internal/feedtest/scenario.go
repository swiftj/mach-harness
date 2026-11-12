package feedtest

// Scenario is one product ticket's whole life in version 3 events, as the contract's sources
// would yield it: a wave with two slices (one blocked on the other), a supervised execution of
// T-1 running a Dynamic Workflow whose agents build, verify (round 1 fails), revise, verify again
// and review (awaiting a person), a human approval, the merge, cleanup and the run record; and a
// second execution that is interrupted with its outcome unknown. Times are milliseconds after Base.
func Scenario() []map[string]any {
	const x1, x2 = "x0123456789ab", "x0fedcba98765"
	wf := "workflow:" + x1 + "/task0001"
	i := func(typ string, ms int64) *Ev {
		return New("intake-log", typ, ms).ID("project_id", "P-1").ID("wave_id", "WAVE-001")
	}
	sl := func(e *Ev, slice string, rev int) *Ev {
		return e.ID("slice_id", slice).ID("revision", rev).Entity("slice:" + slice).Entity("wave:WAVE-001")
	}
	c := func(typ string, ms int64, visit string, round int) *Ev {
		return New("cell-lifecycle", typ, ms).Ticket("T-1").ID("slice_id", "SLICE-001").ID("wave_id", "WAVE-001").Visit("T-1", visit, round).Exec(x1)
	}
	s := func(typ string, ms int64) *Ev { return New("execution-stream", typ, ms).Exec(x1).Ticket("T-1") }
	agent := func(typ string, ms int64, id, label, station string) *Ev {
		e := New("execution-stream", typ, ms).Exec(x1).ID("agent_id", x1+"/"+id).Entity("agent:" + x1 + "/" + id).Parent(wf).Entity(wf)
		if station != "" {
			e.ID("ticket_id", "T-1").ID("station", station).Inferred("ids.ticket_id", "label").Inferred("ids.station", "label")
		}
		return e
	}
	var out []map[string]any
	add := func(e *Ev) { out = append(out, e.Build()) }

	add(i("factory.activated", 0).Data(map[string]any{"autonomy": "supervised", "by_role": "engineer", "limits": map[string]any{"max_parallel": 2},
		"allow_merge": true, "persistent": false, "backlog": nil, "excluded_slices": []string{}}))
	add(i("wave.discovered", 1000).Entity("wave:WAVE-001").Data(map[string]any{"slices": []string{"SLICE-001", "SLICE-002"},
		"approval": map[string]any{"approved_at": "2026-11-11T09:00:00Z", "by_role": "person"}}))
	add(sl(i("slice.materialized", 2000), "SLICE-001", 1).Ticket("T-1").Data(map[string]any{"digest": "abc", "adopted": false, "dependencies": []string{}, "reissued": nil}))
	add(sl(i("slice.materialized", 2000), "SLICE-002", 1).Ticket("T-2").Data(map[string]any{"digest": "def", "adopted": false, "dependencies": []string{"SLICE-001"}, "reissued": nil}))
	add(sl(i("dependency.blocked", 3000), "SLICE-002", 1).Data(map[string]any{"reasons": []string{"SLICE-001 is not integrated yet"}}))
	add(sl(i("work.scheduled", 4000), "SLICE-001", 1).Ticket("T-1").Data(map[string]any{"stage": "spec-ready", "risk": "Medium", "branch": "feature/T-1", "by_role": "supervisor", "authorization": nil}))
	add(i("scheduling.decided", 4000).Data(map[string]any{"state": "supervised", "dispatched": []string{"SLICE-001"}, "started": []string{},
		"held": []map[string]any{{"slice_id": "SLICE-002", "ticket_id": "T-2", "why": "all 2 places are in use"}}}))
	add(i("work.claimed", 5000).Ticket("T-1").Exec(x1).ID("slice_id", "SLICE-001").Data(map[string]any{"stage": "spec-ready", "next": "build", "attempt": 1}))
	add(i("execution.started", 5000).Ticket("T-1").Exec(x1).Data(map[string]any{"until": "merge", "workflow": "mach-belt", "limits": map[string]any{"minutes": 60, "budget_usd": 20}}))
	add(New("execution-record", "execution.process_started", 6000).Exec(x1).Ticket("T-1").Data(map[string]any{}))
	add(s("session.initialized", 6200).Data(map[string]any{"claude_code_version": "2.1.322", "model": "claude-sonnet-5-5", "permission_mode": "dontAsk", "tools": []string{"Workflow"}, "agents": []string{}}))
	add(s("tool.called", 6300).ID("agent_id", x1+"/main").ID("tool_call_id", "toolu_01").Entity("tool:" + x1 + "/toolu_01").Parent("agent:" + x1 + "/main").
		Data(map[string]any{"tool": "Workflow", "target_class": "workflow", "script": nil, "path_rel": nil}))
	add(New("execution-stream", "workflow.started", 6400).Exec(x1).Entity(wf).Parent("agent:"+x1+"/main").Precision("arrival", ptrI(6400), ptrI(6300), ptrI(6400)).
		Data(map[string]any{"workflow": "mach-belt", "tickets": []string{"T-1"}, "until": "merge"}))
	add(agent("agent.queued", 6500, "", "T-1: build", "").ID("agent_id", nil).Data(map[string]any{"index": 0, "label": "T-1: build", "phase": "Build", "phase_index": 1, "model": "sonnet"}))
	add(agent("agent.started", 7000, "a0000000000000001", "T-1: build", "build").Data(map[string]any{"index": 0, "label": "T-1: build", "phase": "Build", "phase_index": 1,
		"agent_type": "mach-builder", "model": "claude-sonnet-5-5", "agent_try": 1}))
	// the build visit, round 1
	add(c("station.entered", 7100, "build#1", 1).Data(map[string]any{"station": "build", "stage": "building", "action": "build", "resumed": false, "unclosed_visit": nil, "head": "1111111", "counts": map[string]any{}}))
	add(c("gate.evaluated", 7200, "build#1", 1).Data(map[string]any{"gate": "build.start", "verdict": "passed", "reason_code": nil, "subject": nil, "status": nil, "audit_tier": "Gold", "counts": map[string]any{}}))
	add(c("build.task_completed", 9000, "build#1", 1).Data(map[string]any{"task_id": "T1", "kind": "test", "step": "red", "first_run": "fail", "suite": "red", "commit": "aaaaaaa"}))
	add(c("gate.evaluated", 9500, "build#1", 1).Data(map[string]any{"gate": "build.green", "verdict": "refused", "reason_code": "suite-failing", "subject": "T2", "status": nil, "audit_tier": nil, "counts": map[string]any{}}))
	add(c("build.task_completed", 12000, "build#1", 1).Data(map[string]any{"task_id": "T2", "kind": "impl", "step": "green", "first_run": "pass", "suite": "green", "commit": "bbbbbbb"}))
	add(c("station.exited", 13000, "build#1", 1).Data(map[string]any{"station": "build", "outcome": "built", "stage": "built", "duration_ms": 5900, "closed_by": nil, "head": "bbbbbbb", "counts": map[string]any{}}))
	add(agent("agent.progressed", 13000, "a0000000000000001", "", "build").Data(map[string]any{"tool_calls": 31, "tokens": 120000, "last_tool": "Bash"}))
	add(agent("agent.finished", 13100, "a0000000000000001", "", "build").Data(map[string]any{"status": "done", "duration_ms": 6100, "tokens": 150000, "tool_calls": 40}))
	// verify, round 1: fails
	add(c("station.entered", 14000, "verify#1", 1).Data(map[string]any{"station": "verify", "stage": "built", "action": "verify", "resumed": false, "unclosed_visit": nil, "head": "bbbbbbb", "counts": map[string]any{"items": 2}}))
	add(c("verify.check_recorded", 15000, "verify#1", 1).Data(map[string]any{"target_id": "AC-01", "target_kind": "scenario", "result": "pass",
		"evidence": []map[string]any{{"file": "evidence/AC-01.txt", "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "bytes": 12}}, "rerecorded": false}))
	add(c("verify.check_recorded", 15500, "verify#1", 1).Data(map[string]any{"target_id": "R1", "target_kind": "matrix rule", "result": "fail", "evidence": []map[string]any{}, "rerecorded": false}))
	add(c("gate.evaluated", 16000, "verify#1", 1).Data(map[string]any{"gate": "verify.verdict", "verdict": "passed", "reason_code": "FAIL_WITH_EVIDENCE", "subject": nil, "status": "FAIL_WITH_EVIDENCE", "audit_tier": nil, "counts": map[string]any{}}))
	add(c("station.exited", 16100, "verify#1", 1).Data(map[string]any{"station": "verify", "outcome": "FAIL_WITH_EVIDENCE", "stage": "built", "duration_ms": 2100, "closed_by": nil, "head": nil, "counts": map[string]any{}}))
	// revise, round 2
	add(c("station.entered", 17000, "build#2", 2).Data(map[string]any{"station": "build", "stage": "building", "action": "revise", "resumed": false, "unclosed_visit": nil, "head": "bbbbbbb", "counts": map[string]any{}}))
	add(c("build.task_completed", 19000, "build#2", 2).Data(map[string]any{"task_id": "T3", "kind": "impl", "step": "green", "first_run": "pass", "suite": "green", "commit": "ccccccc"}))
	add(c("station.exited", 19500, "build#2", 2).Data(map[string]any{"station": "build", "outcome": "built", "stage": "built", "duration_ms": 2500, "closed_by": nil, "head": "ccccccc", "counts": map[string]any{}}))
	add(c("station.entered", 20000, "verify#2", 2).Data(map[string]any{"station": "verify", "stage": "built", "action": "verify", "resumed": false, "unclosed_visit": nil, "head": "ccccccc", "counts": map[string]any{}}))
	add(c("gate.evaluated", 21000, "verify#2", 2).Data(map[string]any{"gate": "verify.verdict", "verdict": "passed", "reason_code": "PASS", "subject": nil, "status": "PASS", "audit_tier": nil, "counts": map[string]any{}}))
	add(c("station.exited", 21100, "verify#2", 2).Data(map[string]any{"station": "verify", "outcome": "PASS", "stage": "verified", "duration_ms": 1100, "closed_by": nil, "head": nil, "counts": map[string]any{}}))
	// review, round 2: awaiting a person
	add(c("station.entered", 22000, "review#1", 2).Data(map[string]any{"station": "review", "stage": "verified", "action": "review", "resumed": false, "unclosed_visit": nil, "head": "ccccccc", "counts": map[string]any{}}))
	add(c("review.round_started", 22100, "review#1", 2).Data(map[string]any{"risk": "High", "max_rounds": 3, "tuning": false, "approvals_needed": 3, "human_approval_required": true,
		"panel": []map[string]any{{"seat": "architecture", "model": "claude-opus-5-5"}, {"seat": "security", "model": "claude-opus-5-5"}, {"seat": "product", "model": "claude-opus-5-5"}}, "delta": false, "restarted": false}))
	for k, seat := range []string{"architecture", "security", "product"} {
		add(c("review.verdict_submitted", 24000+int64(k)*500, "review#1", 2).ID("seat", seat).Data(map[string]any{"seat": seat, "vote": "APPROVE", "blockers": 0, "notes": 1, "rules": []string{}, "model": "claude-opus-5-5"}))
	}
	add(c("review.decided", 26000, "review#1", 2).Data(map[string]any{"outcome": "AWAITING_HUMAN", "approvals": 3, "approvals_needed": 3,
		"votes": map[string]any{"architecture": "APPROVE", "security": "APPROVE", "product": "APPROVE"}, "blockers": 0, "security_veto": false, "human_approval_required": true}))
	add(c("station.exited", 26100, "review#1", 2).Data(map[string]any{"station": "review", "outcome": "AWAITING_HUMAN", "stage": "awaiting-human", "duration_ms": 4100, "closed_by": nil, "head": nil, "counts": map[string]any{}}))
	add(New("execution-stream", "workflow.finished", 26500).Exec(x1).Entity(wf).Data(map[string]any{"status": "completed", "notification_status": "completed", "total_tokens": 150000,
		"tool_uses": 40, "duration_ms": 20000, "stop_reason": nil, "workflow_json": true, "tickets": []map[string]any{}}))
	add(s("tool.returned", 26600).ID("agent_id", x1+"/main").ID("tool_call_id", "toolu_01").Data(map[string]any{"status": "ok", "duration_ms": 20300}))
	add(s("execution.usage", 27000).Data(map[string]any{"total_cost_usd": 4.5, "subtype": "success", "is_error": false, "terminal_reason": nil, "budget_exhausted": false,
		"models": map[string]any{"claude-sonnet-5-5": map[string]any{"cost_usd": 3.0, "input_tokens": 1000, "output_tokens": 2000, "cache_read_tokens": 50000, "cache_creation_tokens": 4000},
			"claude-opus-5-5": map[string]any{"cost_usd": 1.5, "input_tokens": 500, "output_tokens": 700, "cache_read_tokens": 9000, "cache_creation_tokens": 800}}}))
	add(New("execution-record", "execution.process_ended", 28000).Exec(x1).Ticket("T-1").Data(map[string]any{"ended": "exited", "exit_code": 0, "seconds": 22}))
	add(i("execution.completed", 30000).Ticket("T-1").Exec(x1).Data(map[string]any{"stage": "awaiting-human", "next": "stop", "waiting_for": "a person's approval", "how": "exited",
		"seen_to_end": true, "cost_usd": 4.5, "refused_tools": []string{}}))
	// a person approves; a second execution merges and is interrupted, outcome unknown
	add(c("human.approval_recorded", 40000, "human-approval#1", 2).Data(map[string]any{"by_role": "person", "note_given": true}))
	add(i("work.claimed", 41000).Ticket("T-1").Exec(x2).Data(map[string]any{"stage": "approved", "next": "merge", "attempt": 1}))
	add(New("execution-record", "execution.process_started", 42000).Exec(x2).Ticket("T-1").Data(map[string]any{}))
	add(New("cell-lifecycle", "station.entered", 43000).Ticket("T-1").Visit("T-1", "merge#1", 0).Exec(x2).Data(map[string]any{"station": "merge", "stage": "approved", "action": "merge", "resumed": false, "unclosed_visit": nil, "head": "ccccccc", "counts": map[string]any{}}))
	add(New("cell-lifecycle", "merge.completed", 44000).Ticket("T-1").Visit("T-1", "merge#1", 0).Exec(x2).Data(map[string]any{"method": "local", "merge_commit": "ddddddd", "approved_commit": "ccccccc", "landed_commit": "ccccccc", "revalidated": false, "pull_request": nil}))
	add(New("cell-lifecycle", "station.exited", 44100).Ticket("T-1").Visit("T-1", "merge#1", 0).Exec(x2).Data(map[string]any{"station": "merge", "outcome": "merged", "stage": "merged", "duration_ms": 1100, "closed_by": nil, "head": nil, "counts": map[string]any{}}))
	add(New("execution-record", "execution.process_ended", 45000).Exec(x2).Ticket("T-1").Data(map[string]any{"ended": "interrupted", "exit_code": nil, "seconds": 3}))
	add(i("recovery.started", 46000).Ticket("T-1").Exec(x2).Data(map[string]any{"kind": "outcome-unknown"}))
	add(sl(i("slice.integrated", 50000), "SLICE-001", 1).Ticket("T-1").Data(map[string]any{"commit": "ddddddd"}))
	add(sl(i("dependency.resolved", 51000), "SLICE-002", 1).Data(map[string]any{"depends_on": []string{"SLICE-001"}}))
	add(New("run-record", "run.recorded", 52000).Ticket("T-1").ID("slice_id", "SLICE-001").Data(map[string]any{"record_version": 2, "outcome": "merged", "rounds": 2, "first_pass": false,
		"verify_failures": 1, "review_rejections": 0, "escalated": false, "human_approval": true, "deviations": 1, "blockers": 0, "tests_seen_failing_first": 1,
		"tests_passing_on_first_run": 1, "risk": "High", "app_type": "cli", "merge_method": "local", "merge_commit": "ddddddd"}))
	add(New("observer", "history.gap", 53000).Data(map[string]any{"source_key": "i:0badc0de", "from_seq": 90, "to_seq": 91, "reason": "missing-seq", "count": 2}))
	return out
}

func ptrI(v int64) *int64 { return &v }
