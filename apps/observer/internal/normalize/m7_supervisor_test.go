package normalize

import (
	"testing"
	"time"

	"mach/observer/internal/redact"
)

// M7 (7e23f84): the supervisor's execution.failed with not_progressing, and execution.completed
// with exit_code and how "killed", exactly as supervisor.py emits them. The code is carried; an
// unknown code is not.
func TestM7SupervisorShapes(t *testing.T) {
	read := Read{Line: 1, At: time.Date(2026, 11, 14, 23, 10, 0, 0, time.UTC)}
	l := NewLedger("0badc0de", "/work/p", NewIdentity())
	failed := []byte(`{"at":"2026-11-14T23:09:00Z","cause":null,"data":{"stage":"building","next":"build","how":"exited","claude_error":null,"exit_code":0,"attempt":2,"session_id":"858be6fe-455c-4214-a54c-d301c69409d4","not_progressing":"same-refusal"},"execution_id":"xcd07441a6874","project_id":"lending-desk","refs":{"cell":".factory/worktrees/LOCAL-003/cell.json","execution":".factory/local/executions/xcd07441a6874/"},"revision":null,"runner_id":"cabfa844-c469-494c-8e91-2fb561b12635","schema_version":2,"seq":1,"slice_id":"SLICE-005","source":"supervisor","source_commit":null,"ticket_id":"LOCAL-003","type":"execution.failed","wave_id":null}`)
	evs := l.Line(failed, read)
	if len(evs) != 1 || evs[0].Data["not_progressing"] != "same-refusal" || !redact.Enforce(evs[0], &redact.Counters{}) || evs[0].Data["not_progressing"] != "same-refusal" {
		t.Fatalf("execution.failed = %+v", evs)
	}
	killed := []byte(`{"at":"2026-11-14T23:10:00Z","cause":null,"data":{"stage":"built","next":"verify","waiting_for":null,"how":"killed","exit_code":-9,"seen_to_end":true,"cost_usd":null,"session_id":"6a226f9d-fcdc-4e43-a5fd-7af5f419495e","refused_tools":[]},"execution_id":"xf4a33789d169","project_id":"lending-desk","refs":null,"revision":null,"runner_id":null,"schema_version":2,"seq":2,"slice_id":"SLICE-002","source":"supervisor","source_commit":null,"ticket_id":"LOCAL-002","type":"execution.completed","wave_id":null}`)
	evs = l.Line(killed, read)
	if len(evs) != 1 || evs[0].Data["how"] != "killed" || evs[0].Data["exit_code"] != int64(-9) {
		t.Fatalf("execution.completed = %+v", evs[0].Data)
	}
	odd := []byte(`{"at":"2026-11-14T23:11:00Z","data":{"stage":"building","next":"build","how":"exited","claude_error":null,"exit_code":0,"attempt":3,"not_progressing":"The build is stuck, ask Ann"},"execution_id":"xcd07441a6875","project_id":"lending-desk","schema_version":2,"seq":3,"source":"supervisor","ticket_id":"LOCAL-003","type":"execution.failed"}`)
	if evs = l.Line(odd, read); evs[0].Data["not_progressing"] != nil {
		t.Fatalf("prose carried as a code: %v", evs[0].Data["not_progressing"])
	}
}
