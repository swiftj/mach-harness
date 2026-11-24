package normalize

import (
	"reflect"
	"slices"
	"testing"
)

// M22: revision 9. A task built in a lane names its lane; a build gate about one lane names it; the
// join's own task keeps its ID. Before revision 9 the lane was dropped (counted as withheld), the
// gates were kept with their codes and counts, and J-T01 was served as T0 with data.task_id unknown.

func buildLine(t *testing.T, typ string, data map[string]any) (map[string]any, int) {
	t.Helper()
	l := NewLifecycle("T-1", "0a1b2c3d", provRoot, NewIdentity())
	m15Lifecycle(t, l, 1, "station.entered", "build", "build#1", 1, map[string]any{"stage": "building"})
	ev := m15Lifecycle(t, l, 2, typ, "build", "build#1", 1, data)
	withheld := ev.Withheld
	return m15Served(t, ev), withheld
}

func TestATaskBuiltInALaneNamesItsLane(t *testing.T) {
	base := map[string]any{"task": "T03", "kind": "test", "step": "red", "first_run": "fail", "suite": "red", "commit": "abcdef1234"}
	d, _ := buildLine(t, "build.task_completed", base)
	if _, ok := d["lane"]; ok {
		t.Errorf("a task built in the cell is served with a lane: %v", d)
	}
	with := map[string]any{"lane": "L2"}
	for k, v := range base {
		with[k] = v
	}
	d, withheld := buildLine(t, "build.task_completed", with)
	if d["lane"] != "L2" || d["commit"] != "abcdef1234" || withheld != 0 {
		t.Fatalf("lane: %v (withheld %d)", d, withheld)
	}
	for _, bad := range []any{"L0", "lane two", "Ada", 2, "L1234"} {
		with["lane"] = bad
		if d, _ := buildLine(t, "build.task_completed", with); d["lane"] != nil {
			t.Errorf("%v served as a lane: %v", bad, d)
		}
	}
}

func TestTheJoinsTaskKeepsItsID(t *testing.T) {
	d, _ := buildLine(t, "build.task_completed", map[string]any{"task": "J-T01", "kind": "impl", "step": "green", "first_run": nil, "suite": "green", "commit": "abcdef1235"})
	if d["task_id"] != "J-T01" {
		t.Fatalf("J-T01: %v", d)
	}
	if d, _ := buildLine(t, "build.task_completed", map[string]any{"task": "X-T01", "kind": "impl", "step": "green", "suite": "green"}); d["task_id"] != "T0" {
		t.Errorf("another prefix: %v", d)
	}
}

func TestLaneGates(t *testing.T) {
	d, _ := buildLine(t, "gate.evaluated", map[string]any{"gate": "build.lanes-open", "outcome": "pass", "reason_code": nil, "overridden_by_reason": false,
		"lanes": []string{"L1", "L2"}, "granted": 2, "first": true})
	if d["gate"] != "build.lanes-open" || d["verdict"] != "passed" || !reflect.DeepEqual(d["counts"], map[string]any{"granted": float64(2), "first": true}) {
		t.Errorf("lanes-open: %v", d)
	}
	if _, ok := d["lane"]; ok {
		t.Errorf("a gate about every lane names one: %v", d)
	}
	d, _ = buildLine(t, "gate.evaluated", map[string]any{"gate": "build.lanes-open", "outcome": "refuse", "reason_code": "sequential", "overridden_by_reason": false, "lanes": 3, "granted": 1})
	if d["reason_code"] != "sequential" || d["verdict"] != "refused" || d["counts"].(map[string]any)["granted"] != float64(1) {
		t.Errorf("sequential: %v", d)
	}
	d, withheld := buildLine(t, "gate.evaluated", map[string]any{"gate": "build.join", "outcome": "refuse", "reason_code": "lane-set-aside", "overridden_by_reason": false,
		"lane": "L2", "why": "same-file"})
	if d["lane"] != "L2" || d["reason_code"] != "lane-set-aside" || withheld != 1 {
		t.Errorf("set aside: %v (withheld %d: why stays out)", d, withheld)
	}
	d, _ = buildLine(t, "gate.evaluated", map[string]any{"gate": "build.join", "outcome": "refuse", "reason_code": "lanes-interaction", "overridden_by_reason": false, "landed": 5, "set_aside": 0})
	if d["reason_code"] != "lanes-interaction" || d["counts"].(map[string]any)["landed"] != float64(5) {
		t.Errorf("interaction: %v", d)
	}
	if _, ok := d["lane"]; ok {
		t.Errorf("lane on a gate that names none: %v", d)
	}
}

// The task set-commands adds when a changed test or lint command leaves the suite or the linter failing
// (C-T01) keeps its ID, as J-T01 does. Checked on the event itself: the version 3 schema's task_id
// pattern (docs/mach-next/schemas/factory-event.v3.schema.json) names R1- and J- only and needs C- too.
func TestTheCommandsTaskKeepsItsID(t *testing.T) {
	l := NewLifecycle("T-1", "0a1b2c3d", provRoot, NewIdentity())
	m15Lifecycle(t, l, 1, "station.entered", "build", "build#1", 1, map[string]any{"stage": "building"})
	ev := m15Lifecycle(t, l, 2, "build.task_completed", "build", "build#1", 1, map[string]any{"task": "C-T01", "kind": "impl", "step": "green", "first_run": nil, "suite": "green", "commit": "abcdef1236"})
	if ev.Data["task_id"] != "C-T01" || slices.Contains(ev.Unknown, "data.task_id") {
		t.Fatalf("C-T01: %v (unknown %v)", ev.Data, ev.Unknown)
	}
	if d, _ := buildLine(t, "build.task_completed", map[string]any{"task": "CT-T01", "kind": "impl", "step": "green", "suite": "green"}); d["task_id"] != "T0" {
		t.Errorf("another prefix: %v", d)
	}
}

// The gates the build station records about a hand-back, a change of commands, a recovered step, a
// lane made fresh and a join that started or landed on a branch that moved: kept with their codes,
// the lane when they name one; the commands that changed stay out (a list of words is not a count).
func TestNewLaneGates(t *testing.T) {
	d, withheld := buildLine(t, "gate.evaluated", map[string]any{"gate": "build.hand-back", "outcome": "pass", "reason_code": "lane-handed-back", "overridden_by_reason": true, "lane": "L2"})
	if d["gate"] != "build.hand-back" || d["verdict"] != "passed" || d["reason_code"] != "lane-handed-back" || d["lane"] != "L2" || withheld != 0 {
		t.Errorf("hand-back: %v (withheld %d)", d, withheld)
	}
	d, withheld = buildLine(t, "gate.evaluated", map[string]any{"gate": "build.set-commands", "outcome": "pass", "reason_code": "commands-set", "overridden_by_reason": true, "commands": []string{"test"}})
	if d["gate"] != "build.set-commands" || d["verdict"] != "passed" || d["reason_code"] != "commands-set" || withheld != 1 {
		t.Errorf("set-commands: %v (withheld %d)", d, withheld)
	}
	if _, ok := d["commands"]; ok {
		t.Errorf("the commands served: %v", d)
	}
	d, _ = buildLine(t, "gate.evaluated", map[string]any{"gate": "build.green", "outcome": "pass", "reason_code": "step-recovered", "overridden_by_reason": false, "task": "T05", "lane": "L2"})
	if d["reason_code"] != "step-recovered" || d["subject"] != "T05" || d["lane"] != "L2" {
		t.Errorf("step recovered in a lane: %v", d)
	}
	d, _ = buildLine(t, "gate.evaluated", map[string]any{"gate": "build.next", "outcome": "pass", "reason_code": "step-recovered", "overridden_by_reason": false, "task": "C-T01"})
	if d["reason_code"] != "step-recovered" || d["subject"] != "C-T01" {
		t.Errorf("step recovered in the cell: %v", d)
	}
	if _, ok := d["lane"]; ok {
		t.Errorf("a lane on a step recovered in the cell: %v", d)
	}
	d, _ = buildLine(t, "gate.evaluated", map[string]any{"gate": "build.lanes-open", "outcome": "pass", "reason_code": "lane-made-fresh", "overridden_by_reason": false, "lane": "L3"})
	if d["reason_code"] != "lane-made-fresh" || d["lane"] != "L3" {
		t.Errorf("made fresh: %v", d)
	}
	d, _ = buildLine(t, "gate.evaluated", map[string]any{"gate": "build.join", "outcome": "pass", "reason_code": "landed-on-moved-branch", "overridden_by_reason": false})
	if d["reason_code"] != "landed-on-moved-branch" || d["verdict"] != "passed" {
		t.Errorf("moved branch: %v", d)
	}
	d, _ = buildLine(t, "gate.evaluated", map[string]any{"gate": "build.join", "outcome": "pass", "reason_code": "join-started", "overridden_by_reason": false, "lanes": 3})
	if d["reason_code"] != "join-started" || d["counts"].(map[string]any)["lanes"] != float64(3) {
		t.Errorf("join started: %v", d)
	}
}
