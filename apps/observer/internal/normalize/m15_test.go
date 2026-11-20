package normalize

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/event"
	"mach/observer/internal/redact"
	"mach/observer/internal/testkit"
)

// M15: revision 7 of the event contract. Each new field is a code or an identifier, read from what
// MACH recorded, checked again, and null when it is not one the observer knows: a value a later
// MACH adds degrades to the generic account the Floor gave before.

var m15Now = time.Date(2026, 11, 20, 12, 0, 1, 0, time.UTC)

// m15Served runs an event through what ingest does before storing (allowlist, scrub) and checks it
// against the version 3 schema. It returns the served data.
func m15Served(t *testing.T, ev *event.Event) map[string]any {
	t.Helper()
	ev.Pos, ev.Order = 1, "001794657600999~1~i:0badc0de~000000000001~0000"
	if !redact.Enforce(ev, nil) {
		t.Fatalf("refused by the allowlist: %+v", ev)
	}
	redact.ScrubEvent(ev, provRoot, nil)
	ev.Tidy()
	b, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	schema, err := testkit.EventSchema()
	if err != nil {
		t.Fatal(err)
	}
	if errs := schema.ValidateJSON(b); len(errs) > 0 {
		t.Fatalf("not valid against the version 3 schema: %v\n%s", errs, b)
	}
	var served map[string]any
	_ = json.Unmarshal(b, &served)
	if served["schema_revision"] != float64(7) {
		t.Fatalf("schema_revision %v", served["schema_revision"])
	}
	return served["data"].(map[string]any)
}

func m15Intake(t *testing.T, l *Ledger, seq int, typ string, data map[string]any) *event.Event {
	t.Helper()
	line, _ := json.Marshal(map[string]any{"schema_version": 3, "seq": seq, "at": "2026-11-20T12:00:00Z", "type": typ,
		"source_commit": nil, "epic_id": "EPIC-001", "issue": 41, "slice_id": "SLICE-004", "revision": 2, "ticket_id": "GH-41", "runner_id": "R-1",
		"execution_id": "x0123456789ab", "source": "supervisor", "cause": nil, "refs": nil, "data": data})
	for _, ev := range l.Line(line, Read{Line: int64(seq), At: m15Now}) {
		if ev.Type == typ {
			return ev
		}
	}
	t.Fatalf("no %s event", typ)
	return nil
}

func TestHumanRequiredCarriesTheKnownStopCode(t *testing.T) {
	l := NewLedger("0badc0de", provRoot, NewIdentity())
	cases := []struct {
		reason string
		want   any
	}{
		{"waiting for main-conflict", "main-conflict"},
		{"waiting for policy-owner", "policy-owner"},
		{"Built against SLICE-001 revision 1; SLICE-001 is now revision 2.; waiting for human-approval", "human-approval"},
		// A stop a later MACH adds: no code, the words stay the only account (a generic wait).
		{"waiting for some-future-stop", nil},
		// Not intake's phrase: the supervisor's own words are never read for a code.
		{"The slice changed while it was being built. An engineer decides whether to finish the work.", nil},
		{"I am waiting for main-conflict resolution by Bob", nil},
	}
	for i, c := range cases {
		ev := m15Intake(t, l, i+1, "human.required", map[string]any{"reason": c.reason})
		d := m15Served(t, ev)
		if d["needs"] != c.want {
			t.Errorf("%q: needs %v, want %v", c.reason, d["needs"], c.want)
		}
		if (c.want != nil) != (ev.Inferred["data.needs"] == "fixed-phrase") {
			t.Errorf("%q: inferred %v", c.reason, ev.Inferred)
		}
		if d["reason"] == "" {
			t.Errorf("%q: the reason is no longer kept", c.reason)
		}
	}
}

func TestExecutionCompletedCarriesTheKnownStopCode(t *testing.T) {
	l := NewLedger("0badc0de", provRoot, NewIdentity())
	for i, c := range []struct {
		waiting any
		want    any
	}{{"main-conflict", "main-conflict"}, {"policy-owner", "policy-owner"}, {"a-stop-from-the-future", nil}, {nil, nil}} {
		ev := m15Intake(t, l, i+1, "execution.completed", map[string]any{"stage": "planned", "next": "stop", "waiting_for": c.waiting,
			"how": "exited", "seen_to_end": true, "cost_usd": 1.5, "refused_tools": []any{}})
		d := m15Served(t, ev)
		if d["needs"] != c.want {
			t.Errorf("waiting_for %v: needs %v, want %v", c.waiting, d["needs"], c.want)
		}
	}
}

func TestIntakeRefusedSaysWhenASliceWaitsForItsMocks(t *testing.T) {
	l := NewLedger("0badc0de", provRoot, NewIdentity())
	mocks := "Waiting for its design mocks: the approved pictures must be committed to the integration branch at product/ready/SLICE-004/mocks/. " +
		"product/ready/SLICE-004/mocks/" + strings.Repeat("a", 64) + ".png: it is not there."
	d := m15Served(t, m15Intake(t, l, 1, "intake.refused", map[string]any{"problems": []any{mocks}}))
	if d["waiting"] != "mocks" || len(d["problems"].([]any)) != 1 {
		t.Fatalf("mocks: %v", d)
	}
	d = m15Served(t, m15Intake(t, l, 2, "intake.refused", map[string]any{"problems": []any{"its Jira key is not the one that was approved"}}))
	if d["waiting"] != nil {
		t.Fatalf("another refusal: %v", d)
	}
	// A value smuggled into the payload is not read: only intake's sentence counts.
	d = m15Served(t, m15Intake(t, l, 3, "intake.refused", map[string]any{"problems": []any{"no"}, "waiting": "mocks"}))
	if d["waiting"] != nil {
		t.Fatalf("waiting from the payload: %v", d)
	}
}

func TestSliceMaterializedCarriesTheCheckedJiraKey(t *testing.T) {
	for _, c := range []struct {
		key  any
		want any
	}{{"KEY-123", "KEY-123"}, {"key-123", nil}, {"KEY-0123", nil}, {"KEY-1 OR 1=1", nil}, {strings.Repeat("A", 40) + "-1", nil}, {nil, nil}} {
		id := NewIdentity()
		ledger, _ := json.Marshal(map[string]any{"slices": map[string]any{"SLICE-004": map[string]any{"ticket_id": "GH-41", "revision": 2, "title": "Late returns", "jira": c.key,
			"epic": map[string]any{"epic_id": "EPIC-001", "title": "Returns"}}}})
		id.ReadLedger(ledger)
		l := NewLedger("0badc0de", provRoot, id)
		d := m15Served(t, m15Intake(t, l, 1, "slice.materialized", map[string]any{"digest": strings.Repeat("b", 64), "adopted": false, "dependencies": []any{}}))
		if d["jira"] != c.want {
			t.Errorf("key %v: jira %v, want %v", c.key, d["jira"], c.want)
		}
	}
}

func TestRunRecordCarriesJiraAndTheChangeRecord(t *testing.T) {
	sum := strings.Repeat("c", 64)
	for _, c := range []struct {
		name         string
		jira, record any
		wantJira     any
		wantPath     any
	}{
		{"both", "ABC-7", map[string]any{"path": "docs/changes/GH-41.md", "sha256": sum, "commit": "abcdef1"}, "ABC-7", "docs/changes/GH-41.md"},
		{"none", nil, nil, nil, nil},
		{"a bad key and a path outside the form", "abc-7", map[string]any{"path": "../../etc/passwd", "sha256": sum}, nil, nil},
		{"a record under .factory", nil, map[string]any{"path": ".factory/x.md", "sha256": sum}, nil, nil},
		{"not markdown", nil, map[string]any{"path": "docs/changes/x.html", "sha256": sum}, nil, nil},
	} {
		raw := map[string]any{"record_version": 2, "ticket_id": "GH-41", "outcome": "merged", "rounds": 1, "first_pass": true, "verify_failures": 0,
			"review_rejections": 0, "closed_at": "2026-11-20T12:00:00Z", "jira": c.jira, "change_record": c.record}
		line, _ := json.Marshal(raw)
		evs := NewRuns("g", provRoot, NewIdentity()).Line(line, Read{Line: 1, At: m15Now})
		d := m15Served(t, evs[0])
		if d["jira"] != c.wantJira {
			t.Errorf("%s: jira %v", c.name, d["jira"])
		}
		var path any
		if rec, ok := d["change_record"].(map[string]any); ok {
			path = rec["path"]
			if rec["sha256"] != sum {
				t.Errorf("%s: sha256 %v", c.name, rec["sha256"])
			}
		}
		if path != c.wantPath {
			t.Errorf("%s: change record %v", c.name, d["change_record"])
		}
	}
}

func m15Lifecycle(t *testing.T, l *Lifecycle, n int, typ, station, visit string, round int, data map[string]any) *event.Event {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"v": 1, "seq": n, "at": "2026-11-20T10:00:0" + string(rune('0'+n%10)) + ".000Z", "ticket_id": "T-1", "type": typ,
		"station": station, "visit": visit, "round": round, "execution_id": nil, "data": data})
	for _, ev := range l.Line(b, Read{Line: int64(n), At: m15Now}) {
		if ev.Type == typ {
			return ev
		}
	}
	t.Fatalf("no %s", typ)
	return nil
}

// A start of a judging round that was already decided is its repeat (round-N.k after the merge
// station voided the approval). A restart without a decision is not.
func TestReviewRoundStartedSaysARepeat(t *testing.T) {
	l := NewLifecycle("T-1", "0a1b2c3d", provRoot, NewIdentity())
	start := map[string]any{"risk": "Medium", "max_rounds": 3, "tuning": false, "approvals_needed": 2, "human_approval_required": false,
		"seats": []any{"architecture", "security", "product"}, "models": map[string]any{}, "delta": false}
	first := m15Served(t, m15Lifecycle(t, l, 1, "review.round_started", "review", "review#1", 1, start))
	restart := m15Served(t, m15Lifecycle(t, l, 2, "review.round_started", "review", "review#1", 1, start))
	m15Lifecycle(t, l, 3, "review.decided", "review", "review#1", 1, map[string]any{"decision": "APPROVED", "approvals": 3, "needed": 2, "votes": map[string]any{}, "blockers": 0})
	repeat := m15Lifecycle(t, l, 4, "review.round_started", "review", "review#2", 1, start)
	again := m15Served(t, repeat)
	if first["repeat"] != float64(0) || restart["repeat"] != float64(0) || restart["restarted"] != true {
		t.Fatalf("first %v, restart %v", first, restart)
	}
	if again["repeat"] != float64(1) || repeat.Inferred["data.repeat"] != "decided-before" || repeat.IDs.Round != 1 {
		t.Fatalf("repeat %v (round %d, inferred %v)", again, repeat.IDs.Round, repeat.Inferred)
	}
}

func TestADesignMockCheckIsItsOwnKind(t *testing.T) {
	l := NewLifecycle("T-1", "0a1b2c3d", provRoot, NewIdentity())
	ev := func(n int, kind any, id string) map[string]any {
		data := map[string]any{"item": id, "result": "pass", "evidence": []any{map[string]any{"path": "evidence/mocks/" + strings.Repeat("d", 64) + ".png", "sha256": strings.Repeat("d", 64)}}}
		if kind != nil {
			data["kind"] = kind
		}
		return m15Served(t, m15Lifecycle(t, l, n, "verify.check_recorded", "verify", "verify#1", 1, data))
	}
	if d := ev(1, "design mock", "MOCK-1"); d["target_kind"] != "design mock" {
		t.Fatalf("recorded kind: %v", d)
	}
	if d := ev(2, nil, "MOCK-2"); d["target_kind"] != "design mock" {
		t.Fatalf("by its id: %v", d)
	}
	// A kind a later verify.py adds is read from the id, never passed on.
	if d := ev(3, "a new kind", "AC-01"); d["target_kind"] != "scenario" {
		t.Fatalf("unknown kind: %v", d)
	}
}

func TestMergeCompletedCarriesTheChangeRecordFromCellJSON(t *testing.T) {
	dir := t.TempDir()
	sum := strings.Repeat("e", 64)
	cell, _ := json.Marshal(map[string]any{"stage": "merged", "change_record": map[string]any{"path": "docs/changes/T-1.md", "sha256": sum, "commit": "abcdef1"}})
	if err := os.WriteFile(filepath.Join(dir, "cell.json"), cell, 0o644); err != nil {
		t.Fatal(err)
	}
	merge := map[string]any{"method": "local", "approved_commit": "abcdef1", "landed_commit": "abcdef2", "merge_commit": "abcdef3", "revalidated": false, "pull_request": nil}
	l := NewLifecycle("T-1", "0a1b2c3d", provRoot, NewIdentity())
	l.Files = DirFiles{Dir: dir}
	ev := m15Lifecycle(t, l, 1, "merge.completed", "merge", "merge#1", 1, merge)
	d := m15Served(t, ev)
	rec, _ := d["change_record"].(map[string]any)
	if rec == nil || rec["path"] != "docs/changes/T-1.md" || rec["sha256"] != sum || ev.Inferred["data.change_record"] != "cell-file" {
		t.Fatalf("change record %v (inferred %v)", d["change_record"], ev.Inferred)
	}
	// No cell files to read (an archive the observer cannot open): null, never guessed.
	l = NewLifecycle("T-1", "0a1b2c3e", provRoot, NewIdentity())
	if d := m15Served(t, m15Lifecycle(t, l, 1, "merge.completed", "merge", "merge#1", 1, merge)); d["change_record"] != nil {
		t.Fatalf("without files: %v", d["change_record"])
	}
}

// The merge-time recheck's gate (merge.py check_landed, M13) keeps its own name, with its reason
// code and counts; the landed slice IDs it also records are withheld (counts only).
func TestTheMergeRecheckGateKeepsItsName(t *testing.T) {
	l := NewLifecycle("T-1", "0a1b2c3d", provRoot, NewIdentity())
	ev := m15Lifecycle(t, l, 1, "gate.evaluated", "merge", "merge#1", 1, map[string]any{"gate": "merge.landed_overlap", "outcome": "refuse",
		"reason_code": "landed-overlap", "overridden_by_reason": false, "landed_commits": 2, "files": 1, "slices": []any{"SLICE-004"}, "problems": 0})
	d := m15Served(t, ev)
	counts, _ := d["counts"].(map[string]any)
	if d["gate"] != "merge.landed_overlap" || d["verdict"] != "refused" || d["reason_code"] != "landed-overlap" || counts["landed_commits"] != float64(2) || counts["files"] != float64(1) {
		t.Fatalf("gate %v", d)
	}
	if len(ev.Unknown) != 1 || ev.Unknown[0] != "ids.execution_id" || ev.Withheld != 1 {
		t.Fatalf("unknown %v, withheld %d", ev.Unknown, ev.Withheld)
	}
	// A name outside the form is still the station's own (unknown), as before.
	ev = m15Lifecycle(t, l, 2, "gate.evaluated", "merge", "merge#1", 1, map[string]any{"gate": "Merge.Land!", "outcome": "pass", "reason_code": nil})
	if d := m15Served(t, ev); d["gate"] != "merge" {
		t.Fatalf("bad name: %v", d["gate"])
	}
}
