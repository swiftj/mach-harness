package ingest

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/event"
	"mach/observer/internal/testkit"
)

// v2 writes one intake log line as intake.Factory.emit does.
func v2(seq int, typ, source, ticket, execution string, data map[string]any) []byte {
	var tk, x any
	if ticket != "" {
		tk = ticket
	}
	if execution != "" {
		x = execution
	}
	b, _ := json.Marshal(map[string]any{"schema_version": 2, "seq": seq, "at": "2026-11-12T10:00:00Z", "type": typ, "project_id": "P-1",
		"source_commit": "abcdef1", "wave_id": "WAVE-001", "slice_id": "SLICE-001", "revision": 1, "ticket_id": tk, "runner_id": "R-1",
		"execution_id": x, "source": source, "cause": nil, "refs": map[string]any{"cell": ".factory/worktrees/T-1/cell.json"}, "data": data})
	return append(b, '\n')
}

// intakeSample is one record of every intake kind, as the writers emit them.
func intakeSample() [][]byte {
	return [][]byte{
		v2(1, "wave.discovered", "intake", "", "", map[string]any{"slices": []any{"SLICE-001"}, "approval": map[string]any{"actor": "Ada Lovelace", "approved_at": "2026-11-11T09:00:00Z"}}),
		v2(2, "intake.validated", "intake", "", "", map[string]any{"digest": strings.Repeat("ab", 32)}),
		v2(3, "intake.refused", "intake", "", "", map[string]any{"problems": []any{"the wave has no recorded approval"}}),
		v2(4, "slice.materialized", "intake", "T-1", "", map[string]any{"digest": strings.Repeat("cd", 32), "adopted": false, "dependencies": []any{"SLICE-000"}}),
		v2(5, "slice.integrated", "intake", "T-1", "", map[string]any{"commit": "0123456789abcdef"}),
		v2(6, "dependency.resolved", "intake", "T-1", "", map[string]any{"depends_on": []any{"SLICE-000"}}),
		v2(7, "dependency.blocked", "intake", "T-1", "", map[string]any{"reasons": []any{"waiting for SLICE-000 to be integrated"}}),
		v2(8, "work.scheduled", "engineer", "T-1", "", map[string]any{"stage": "spec-ready", "risk": "Medium", "branch": "feature/T-1", "by": "Ada Lovelace", "authorization": nil}),
		v2(9, "revision.superseded", "intake", "T-1", "", map[string]any{"from_revision": 1, "effect": "The waiting ticket now carries the new revision."}),
		v2(10, "human.required", "intake", "T-1", "", map[string]any{"reason": "It is approved. This machine does not merge unattended, so a person merges it."}),
		v2(11, "factory.activated", "engineer", "", "", map[string]any{"autonomy": "supervised", "by": "Ada Lovelace", "limits": map[string]any{"max_parallel": 2, "max_budget_usd_per_run": 5}, "allow_merge": false, "persistent": true, "backlog": "include", "excluded_slices": []any{}}),
		v2(12, "factory.paused", "engineer", "", "", map[string]any{"by": "Ada Lovelace", "reason": "lunch"}),
		v2(13, "factory.resumed", "engineer", "", "", map[string]any{"by": "Ada Lovelace", "retrying": []any{"T-1"}}),
		v2(14, "revision.discovered", "supervisor", "", "", map[string]any{"from_commit": "1111111", "commit": "2222222"}),
		v2(15, "scheduling.decided", "supervisor", "", "", map[string]any{"state": "supervised", "dispatched": []any{}, "started": []any{}, "held": []any{map[string]any{"ticket_id": "T-2", "why": "all 2 place(s) are in use"}}}),
		v2(16, "work.claimed", "supervisor", "T-1", x1, map[string]any{"stage": "planned", "next": "build", "attempt": 1}),
		v2(17, "execution.started", "supervisor", "T-1", x1, map[string]any{"session_id": "00000000-0000-4000-8000-000000000001", "until": "merge", "workflow": "mach:belt", "limits": map[string]any{"minutes": 60, "budget_usd": 5}}),
		v2(18, "station.observed", "supervisor", "T-1", "", map[string]any{"from_stage": "planned", "stage": "building"}),
		v2(19, "recovery.started", "supervisor", "T-1", x1, map[string]any{"kind": "still-running"}),
		v2(20, "execution.completed", "supervisor", "T-1", x1, map[string]any{"stage": "built", "next": "verify", "waiting_for": nil, "how": "exited", "seen_to_end": true, "cost_usd": 1.82, "session_id": "s", "refused_tools": []any{"Bash: git push"}}),
		v2(21, "execution.failed", "supervisor", "T-1", x1, map[string]any{"stage": "built", "next": "verify", "how": "exited", "claude_error": "error_max_budget_usd", "exit_code": 1, "attempt": 2, "session_id": "s"}),
		v2(22, "scheduling.decided", "supervisor", "", "", map[string]any{"state": "supervised", "dispatched": []any{}, "started": []any{"T-2"}, "held": []any{}}),
		v2(23, "factory.disabled", "engineer", "", "", map[string]any{"by": "Ada Lovelace", "stopped": true}),
	}
}

func TestIntakeLogEveryKind(t *testing.T) {
	root := testkit.Project(t)
	for _, line := range intakeSample() {
		testkit.Append(t, testkit.LedgerPath(root), line)
	}
	h := newHarness(t, root, "", false)
	h.drain()
	h.validate()
	evs := h.events()
	k := kinds(evs)
	for _, kind := range event.Kinds[:22] {
		if k[kind] == 0 {
			t.Errorf("no %s", kind)
		}
	}
	for _, raw := range h.raws() {
		for _, bad := range []string{"Ada Lovelace", "00000000-0000-4000-8000", "cell.json", "session_id", "abcdef1"} {
			if strings.Contains(string(raw), bad) {
				t.Fatalf("%q reached an event: %s", bad, raw)
			}
		}
	}
	for _, e := range evs {
		if e.Origin.Stream == event.StreamIntake {
			if !strings.HasPrefix(e.ID, "i:") || e.Time.Precision != "s" || e.Time.OccurredAt != "2026-11-12T10:00:00.999Z" {
				t.Fatalf("%+v", e)
			}
		}
	}
	so := ofType(evs, "station.observed")[0]
	if so.Authority != event.Observed {
		t.Fatal("station.observed is sampled, not decided")
	}
	ex := ofType(evs, "execution.started")[0]
	if ex.Cause == nil || ex.Cause.Basis != "identity" || !strings.HasSuffix(ex.Cause.EventID, ":16") {
		t.Fatalf("execution.started <- work.claimed: %+v", ex.Cause)
	}
	if ofType(evs, "work.claimed")[0].IDs.Attempt != 1 {
		t.Fatal("attempt")
	}
	if ofType(evs, "factory.activated")[0].Data["by_role"] != "engineer" || ofType(evs, "work.scheduled")[0].Data["by_role"] != "engineer" {
		t.Fatal("by_role")
	}
	waits := ofType(evs, "capacity.wait_changed")
	if len(waits) != 2 || waits[0].Data["state"] != "waiting" || waits[0].Data["limit"] != int64(2) && waits[0].Data["limit"] != float64(2) ||
		waits[1].Data["state"] != "released" || waits[0].IDs.TicketID != "T-2" || waits[0].Inferred["data.state"] != "held-sentence" {
		t.Fatalf("capacity: %+v", waits)
	}
	if waits[0].Order <= ofType(evs, "scheduling.decided")[0].Order {
		t.Fatal("a reconstructed event sorts after its basis")
	}
}

func TestIntakeGapsAndUnknownKinds(t *testing.T) {
	root := testkit.Project(t)
	testkit.Append(t, testkit.LedgerPath(root), v2(1, "intake.validated", "intake", "", "", map[string]any{"digest": strings.Repeat("ab", 32)}))
	testkit.Append(t, testkit.LedgerPath(root), []byte("{\"schema_version\":2,\"seq\":2,\"type\":\"intake.val\n"))
	testkit.Append(t, testkit.LedgerPath(root), v2(4, "brand.new_kind", "intake", "", "", map[string]any{"secret": "sk-ant-api03-AAAAAAAAAAAAAAAA"}))
	h := newHarness(t, root, "", false)
	h.drain()
	h.validate()
	reasons := map[string]bool{}
	for _, g := range ofType(h.events(), "history.gap") {
		reasons[g.Data["reason"].(string)] = true
		if g.Authority != event.Reconstructed || g.Provenance == nil {
			t.Fatal("gaps are reconstructed")
		}
	}
	if !reasons["unparsable-line"] || !reasons["missing-seq"] || !reasons["unknown-type"] {
		t.Fatalf("%v", reasons)
	}
}

func TestExecutionRecordsAndRunRecord(t *testing.T) {
	root := testkit.Project(t)
	testkit.Append(t, testkit.LedgerPath(root), v2(1, "work.claimed", "supervisor", "T-1", x1, map[string]any{"stage": "planned", "next": "build", "attempt": 1}))
	dir := testkit.ExecDir(root, x1)
	testkit.WriteFile(t, filepath.Join(dir, "started.json"), mustJSON(map[string]any{"execution_id": x1, "wrapper_pid": 1, "child_pid": 2, "started_at": "2026-11-12T10:00:00Z"}))
	testkit.WriteFile(t, filepath.Join(dir, "result.json"), mustJSON(map[string]any{"execution_id": x1, "ended": "timed-out", "exit_code": nil, "ended_at": "2026-11-12T11:00:00Z", "seconds": 3600, "error": "/Users/someone/x"}))
	run := mustJSON(map[string]any{"record_version": 2, "ticket_id": "T-1", "slice_id": "SLICE-001", "title": "Secret project name", "outcome": "merged",
		"abandon_reason": nil, "rounds": 2, "first_pass": false, "verify_failures": 1, "review_rejections": 0, "escalated": false, "human_approval": true,
		"deviations": []any{map[string]any{"type": "scope", "detail": "/Users/someone"}}, "blockers": []any{map[string]any{"title": "x"}}, "notes": []any{},
		"tests_seen_failing_first": 4, "tests_passing_on_first_run": 1, "risk": "Medium", "app_type": "cli", "closed_at": "2026-11-12T12:00:00+00:00",
		"integration": map[string]any{"method": "local", "merge_commit": "abcdef0123456789"}, "product": map[string]any{"slice_id": "SLICE-001", "revision": 1, "wave_id": "WAVE-001"}})
	testkit.Append(t, filepath.Join(root, ".factory", "archive", "runs.jsonl"), append(run, '\n'))
	h := newHarness(t, root, "", false)
	h.drain()
	h.validate()
	evs := h.events()
	st, end := ofType(evs, "execution.process_started"), ofType(evs, "execution.process_ended")
	if len(st) != 1 || len(end) != 1 || st[0].IDs.TicketID != "T-1" || end[0].Data["ended"] != "timed-out" || end[0].ID != "x:"+x1+":ended" {
		t.Fatalf("%+v %+v", st, end)
	}
	r := ofType(evs, "run.recorded")
	if len(r) != 1 || r[0].Data["deviations"] != int64(1) && r[0].Data["deviations"] != float64(1) || r[0].Data["merge_method"] != "local" || r[0].IDs.WaveID != "WAVE-001" {
		t.Fatalf("%+v", r)
	}
	for _, raw := range h.raws() {
		if strings.Contains(string(raw), "Secret project") || strings.Contains(string(raw), "/Users/") {
			t.Fatalf("leak: %s", raw)
		}
	}
}

// cell writes a cell with a lifecycle log, a spec, evidence and a vote file.
func cell(t *testing.T, root, ticket string, records []testkit.Record) {
	dir := testkit.CellDir(root, ticket)
	testkit.WriteFile(t, filepath.Join(dir, "cell.json"), mustJSON(map[string]any{"stage": "approved", "created_at": "2026-11-12T09:00:00+00:00",
		"product": map[string]any{"slice_id": "SLICE-009", "revision": 2, "wave_id": "WAVE-003"}}))
	testkit.WriteFile(t, filepath.Join(dir, "spec.json"), mustJSON(map[string]any{"scenarios": []any{map[string]any{"id": "AC-01"}, map[string]any{"id": "AC-02"}},
		"decision_matrix": map[string]any{"rules": []any{map[string]any{"id": "R1"}}}}))
	testkit.WriteFile(t, filepath.Join(dir, "evidence", "ac-01.png"), []byte("png bytes"))
	testkit.WriteFile(t, filepath.Join(dir, "review", "round-1", "votes", "security.json"), mustJSON(map[string]any{"reviewer": "security", "vote": "REJECT",
		"summary": "a long model summary that must not be shown", "findings": []any{
			map[string]any{"severity": "blocker", "rule": "FR-01 says the token must expire", "title": "Token never expires", "file": "src/auth.py"},
			map[string]any{"severity": "note", "rule": "", "title": "Consider /Users/someone/.ssh/id_rsa", "file": "/etc/passwd"}}}))
	testkit.WriteFile(t, filepath.Join(root, ".factory", "holdouts", ticket, "edge case.md"), []byte("secret holdout content"))
	for _, r := range records {
		testkit.Append(t, testkit.CellLog(root, ticket), r.Line())
	}
}

func cellRecords(ticket string) []testkit.Record {
	sum := "6b4c3e8a1f1fe7b1e7a8e5e6cba1b62d72a44a3bf41fb7f1d7e3d4b7b0b2e1c4"
	return []testkit.Record{
		{Seq: 1, At: "2026-11-12T10:00:00.000Z", Ticket: ticket, Type: "station.entered", Station: "verify", Round: 1, Execution: x1, Data: map[string]any{"stage": "built", "head": "abc1234", "items": 3}},
		{Seq: 2, At: "2026-11-12T10:00:01.000Z", Ticket: ticket, Type: "verify.check_recorded", Station: "verify", Round: 1, Data: map[string]any{"item": "AC-01", "kind": "scenario", "result": "pass",
			"evidence": []any{map[string]any{"path": "evidence/ac-01.png", "sha256": sum}}}},
		{Seq: 3, At: "2026-11-12T10:00:02.000Z", Ticket: ticket, Type: "station.exited", Station: "verify", Round: 1, Data: map[string]any{"outcome": "PASS", "stage": "verified", "checks_passed": 3}},
		{Seq: 4, At: "2026-11-12T10:00:03.000Z", Ticket: ticket, Type: "station.entered", Station: "review", Round: 1, Data: map[string]any{"stage": "verified", "head": "abc1234", "round": 1}},
		{Seq: 5, At: "2026-11-12T10:00:03.100Z", Ticket: ticket, Type: "review.round_started", Station: "review", Round: 1, Data: map[string]any{"round": 1, "max_rounds": 3, "risk": "High",
			"tuning": false, "seats": []any{"architecture", "security", "product"}, "models": map[string]any{"architecture": "opus", "security": "opus", "product": "opus"},
			"approvals_needed": 3, "human_approval_required": true, "delta": false}},
		{Seq: 6, At: "2026-11-12T10:00:09.000Z", Ticket: ticket, Type: "review.verdict_submitted", Station: "review", Round: 1, Data: map[string]any{"round": 1, "seat": "security", "vote": "REJECT", "blockers": 1, "notes": 1, "rules": []any{"FR-01"}}},
	}
}

func TestLifecycleReconstructions(t *testing.T) {
	root := testkit.Project(t)
	cell(t, root, "T-9", cellRecords("T-9"))
	h := newHarness(t, root, "", false)
	h.drain()
	h.validate()
	evs := h.events()
	tl := ofType(evs, "verify.targets_listed")
	if len(tl) != 1 || len(tl[0].Data["targets"].([]any)) != 4 || tl[0].IDs.VisitID != "T-9/verify#1" {
		t.Fatalf("targets: %+v %+v", len(tl), tl[0].Data)
	}
	findings := ofType(evs, "review.finding")
	if len(findings) != 2 || findings[0].Data["rule"] != "FR-01" || findings[0].Data["severity"] != "blocker" || findings[0].IDs.Seat != "security" {
		t.Fatalf("findings: %+v", findings)
	}
	if findings[1].Data["file_rel"] != nil || strings.Contains(findings[1].Data["title"].(string), "/Users/") {
		t.Fatalf("a finding's path or title leaked: %+v", findings[1].Data)
	}
	arts := ofType(evs, "artifact.recorded")
	integrity := map[string]string{}
	for _, a := range arts {
		integrity[a.Data["path_rel"].(string)] = a.Data["integrity"].(string)
	}
	if integrity["evidence/ac-01.png"] != "mismatch" || integrity["review/round-1/votes/security.json"] != "unchecked" {
		t.Fatalf("artifacts: %v", integrity)
	}
	v := ofType(evs, "review.verdict_submitted")[0]
	if v.Data["model"] != "opus" || v.IDs.SliceID != "SLICE-009" || v.IDs.Revision == nil || *v.IDs.Revision != 2 {
		t.Fatalf("%+v %+v", v.Data, v.IDs)
	}
	for _, raw := range h.raws() {
		for _, bad := range []string{"secret holdout content", "long model summary", "/etc/passwd"} {
			if strings.Contains(string(raw), bad) {
				t.Fatalf("leak %q: %s", bad, raw)
			}
		}
	}
}

func TestStateMismatchIsAGap(t *testing.T) {
	root := testkit.Project(t)
	recs := cellRecords("T-9")[:3] // the log says verified; cell.json says approved
	cell(t, root, "T-9", recs)
	future := time.Now().Add(time.Hour)
	os.Chtimes(filepath.Join(testkit.CellDir(root, "T-9"), "cell.json"), future, future)
	h := newHarness(t, root, "", false)
	h.drain()
	h.validate()
	gaps := ofType(h.events(), "history.gap")
	if len(gaps) != 1 || gaps[0].Data["reason"] != "state-mismatch" || gaps[0].IDs.TicketID != "T-9" {
		t.Fatalf("%+v", gaps)
	}
}

func TestCellWithoutLifecycleBeginsHistory(t *testing.T) {
	root := testkit.Project(t)
	testkit.WriteFile(t, filepath.Join(testkit.CellDir(root, "OLD-1"), "cell.json"), mustJSON(map[string]any{"stage": "building", "created_at": "2026-01-01T00:00:00+00:00"}))
	past := time.Now().Add(-time.Hour)
	os.Chtimes(filepath.Join(testkit.CellDir(root, "OLD-1"), "cell.json"), past, past)
	h := newHarness(t, root, "", false)
	h.drain()
	h.validate()
	b := ofType(h.events(), "history.began")
	if len(b) != 1 || b[0].Data["reason"] != "no-lifecycle-log" || b[0].IDs.CellInstance != event.Hash8([]byte("2026-01-01T00:00:00+00:00")) {
		t.Fatalf("%+v", b)
	}
}

func TestLifecycleSeqGapsTornLinesAndForeignTicket(t *testing.T) {
	root := testkit.Project(t)
	log := testkit.CellLog(root, "T-1")
	testkit.Append(t, log, testkit.Record{Seq: 1, Ticket: "T-1", Type: "station.entered", Station: "build", Round: 1, Data: map[string]any{"stage": "building"}}.Line())
	testkit.Append(t, log, []byte(`{"v":1,"seq":2,"at":"2026-11-1`+"\n")) // torn, then a new line as the helper does
	testkit.Append(t, log, testkit.Record{Seq: 0, Ticket: "T-1", Type: "gate.evaluated", Station: "build", Round: 1, Data: map[string]any{"gate": "build.green", "outcome": "refuse", "reason_code": "suite-red", "task": "T3"}}.Line())
	testkit.Append(t, log, testkit.Record{Seq: 5, Ticket: "T-1", Type: "station.exited", Station: "build", Round: 1, Data: map[string]any{"outcome": "built", "stage": "built"}}.Line())
	testkit.Append(t, log, testkit.Record{Seq: 6, Ticket: "T-2", Type: "station.entered", Station: "build", Round: 1}.Line())
	h := newHarness(t, root, "", false)
	h.drain()
	h.validate()
	evs := h.events()
	reasons := map[string]int{}
	for _, g := range ofType(evs, "history.gap") {
		reasons[g.Data["reason"].(string)]++
	}
	if reasons["unparsable-line"] != 2 || reasons["missing-seq"] != 1 {
		t.Fatalf("%v", reasons)
	}
	if ofType(evs, "gate.evaluated")[0].ID != "c:T-1:"+ofType(evs, "station.entered")[0].IDs.CellInstance+":3" {
		t.Fatal("ids are physical lines, counting the torn one")
	}
}
