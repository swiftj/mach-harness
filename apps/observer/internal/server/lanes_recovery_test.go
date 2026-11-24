package server

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"mach/observer/internal/feedtest"
)

// M22, the station's later states: a lane handed back to the cell, a step recovered after an
// interruption, a lane made fresh, a lane set aside for the newer reasons, a join that landed on a
// branch that moved, the commands task (C-T01), and a changed test command. The files are written
// as skills/build/scripts/build.py writes them; every free text in them (a hand-back's reason, the
// holder, a command and why it changed, a file's path, a branch name) is the prose marker, and none
// of it may be served.

const (
	keptRef  = "refs/mach/lanes-set-aside/T-3/L2/1"
	recovC   = "aaaaaaaaaa1111111111"
	movedC1  = "bbbbbbbbbb2222222222"
	movedC2  = "cccccccccc3333333333"
	notApplC = "dddddddddd4444444444"
)

func readJSONFile(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestALaneHandedBack(t *testing.T) {
	h := start(t, config{events: laneEvents(laneGate(20000, "build.hand-back", "passed", "lane-handed-back", "L2"))})
	openLanesCell(t, h.root)
	cell := filepath.Join(h.root, ".factory/worktrees/T-3")
	pending := func(id, kind string) map[string]any { return task(id, kind, "pending", nil) }
	l2 := laneEntry("L2", "handed-back", "T04", "T05")
	l2["handed_back"] = map[string]any{"at": "2026-11-24T10:15:00+00:00", "reason": prose, "holder": prose, "finished_then": []string{"T04"}, "unfinished_then": []string{"T05"}}
	b := buildJSON("open", []map[string]any{laneEntry("L1", "open", "T02", "T03"), l2, laneEntry("L3", "planned", "T06")},
		[]map[string]any{task("T01", "contract", "done", map[string]any{"commit": "abcdef1234"}), pending("T02", "test"), pending("T03", "impl"), pending("T04", "test"),
			pending("T05", "impl"), pending("T06", "docs"), pending("T07", "docs")}, nil)
	b["deviations"] = []map[string]any{{"task": nil, "type": "lane-handed-back", "detail": prose, "loop": 0, "at": "2026-11-24T10:15:00+00:00", "lane": "L2",
		"tasks": []string{"T05"}, "finished": []string{"T04"}, "reason": prose, "holder": prose}}
	writeJSONFile(t, filepath.Join(cell, "build.json"), b)
	writeJSONFile(t, filepath.Join(cell, "lanes/L2/lane.json"), laneJSON("L2", "open", task("T04", "test", "done", map[string]any{"commit": lc3}), task("T05", "impl", "pending", nil)))
	d, body := cellWith(t, h, "T-3")
	noProse(t, body)
	l := lanesOfReply(t, d)
	got := laneByName(t, l, "L2")
	hb, _ := got["handed_back"].(map[string]any)
	if got["status"] != "handed-back" || hb == nil || hb["at"] != "2026-11-24T10:15:00Z" || !reflect.DeepEqual(hb["finished_then"], []any{"T04"}) ||
		!reflect.DeepEqual(hb["unfinished_then"], []any{"T05"}) || !reflect.DeepEqual(hb["built_in_cell"], []any{}) || got["done"] != float64(1) {
		t.Fatalf("L2 handed back: %v", got)
	}
	if _, ok := hb["reason"]; ok {
		t.Errorf("a hand-back's reason served: %v", hb)
	}
	devs := l["deviations"].([]any)
	if len(devs) != 1 || devs[0].(map[string]any)["type"] != "lane-handed-back" || devs[0].(map[string]any)["lane"] != "L2" {
		t.Errorf("deviations: %v", devs)
	}
	gates := l["gates"].([]any)
	if g := gates[len(gates)-1].(map[string]any); g["gate"] != "build.hand-back" || g["lane"] != "L2" || g["reason_code"] != "lane-handed-back" {
		t.Errorf("the hand-back's gate: %v", g)
	}
	if laneByName(t, l, "L1")["handed_back"] != nil {
		t.Error("a lane not handed back has a hand-back")
	}
}

func TestAStepRecoveredAndALaneMadeFresh(t *testing.T) {
	h := start(t, config{events: laneEvents(laneGate(5000, "build.lanes-open", "passed", "lane-made-fresh", "L2"), laneGate(20000, "build.green", "passed", "step-recovered", "L1"))})
	openLanesCell(t, h.root)
	cell := filepath.Join(h.root, ".factory/worktrees/T-3")
	b := buildJSON("open", nil, nil, nil)
	pending := func(id, kind string) map[string]any { return task(id, kind, "pending", nil) }
	l2 := laneEntry("L2", "open", "T04", "T05")
	l2["made_fresh"] = []map[string]any{
		{"at": "2026-11-24T10:05:00+00:00", "why": prose, "ref": keptRef, "state_file": "lanes/L2/" + prose + ".json"},
		{"at": "2026-11-24T10:06:00+00:00", "why": "branch-elsewhere", "ref": "refs/mach/lanes-set-aside/T-9/L2/1", "state_file": nil},
	}
	b["lanes"].(map[string]any)["lanes"] = []map[string]any{laneEntry("L1", "open", "T02", "T03"), l2, laneEntry("L3", "planned", "T06")}
	b["tasks"] = []map[string]any{task("T01", "contract", "done", map[string]any{"commit": "abcdef1234"}), pending("T02", "test"), pending("T03", "impl"), pending("T04", "test"),
		pending("T05", "impl"), pending("T06", "docs"), pending("T07", "docs")}
	b["deviations"] = []map[string]any{
		{"task": nil, "type": "lane-made-fresh", "detail": prose, "loop": 0, "at": "2026-11-24T10:05:00+00:00", "lane": "L2", "ref": keptRef, "state_file": prose},
		{"task": nil, "type": "lane-worktree-remade", "detail": prose, "loop": 0, "at": "2026-11-24T10:05:01+00:00", "lane": "L2", "branch": prose, "old_branch": prose},
		{"task": "T01", "type": "test-amended", "detail": prose, "loop": 0, "at": "2026-11-24T10:04:00+00:00"},
	}
	writeJSONFile(t, filepath.Join(cell, "build.json"), b)
	l1 := laneJSON("L1", "open",
		task("T02", "test", "done", map[string]any{"commit": recovC, "lane": "L1", "at": "2026-11-24T10:10:00+00:00", "recovered": map[string]any{"at": "2026-11-24T10:11:00+00:00", "commit": recovC}}),
		task("T03", "impl", "pending", nil))
	l1["deviations"] = []map[string]any{{"task": "T02", "type": "step-recovered", "detail": prose, "loop": 0, "at": "2026-11-24T10:11:00+00:00", "commit": recovC, "lane": "L1"}}
	writeJSONFile(t, filepath.Join(cell, "lanes/L1/lane.json"), l1)
	d, body := cellWith(t, h, "T-3")
	noProse(t, body)
	l := lanesOfReply(t, d)
	got := laneByName(t, l, "L1")
	if !reflect.DeepEqual(got["recovered"], []any{map[string]any{"task": "T02", "at": "2026-11-24T10:11:00Z", "commit": recovC}}) {
		t.Errorf("L1's recovered step: %v", got["recovered"])
	}
	if t2 := taskByID(t, l, "T02"); t2["status"] != "done" || t2["recovered"].(map[string]any)["commit"] != recovC {
		t.Errorf("T02: %v", t2)
	}
	fresh := laneByName(t, l, "L2")["made_fresh"].([]any)
	if len(fresh) != 2 {
		t.Fatalf("made fresh: %v", fresh)
	}
	if f := fresh[0].(map[string]any); f["ref"] != keptRef || f["state_file_kept"] != true || f["why"] != nil || f["at"] != "2026-11-24T10:05:00Z" {
		t.Errorf("made fresh, kept: %v", f)
	}
	if f := fresh[1].(map[string]any); f["ref"] != nil || f["state_file_kept"] != false || f["why"] != "branch-elsewhere" {
		t.Errorf("made fresh, another ticket's ref is not served: %v", f)
	}
	var types []string
	for _, x := range l["deviations"].([]any) {
		m := x.(map[string]any)
		types = append(types, m["type"].(string))
		if m["type"] == "step-recovered" && (m["lane"] != "L1" || m["task"] != "T02" || m["commit"] != recovC) {
			t.Errorf("the lane's own deviation: %v", m)
		}
		if m["type"] == "lane-made-fresh" && m["ref"] != keptRef {
			t.Errorf("made fresh: %v", m)
		}
	}
	if !reflect.DeepEqual(types, []string{"lane-made-fresh", "lane-worktree-remade", "step-recovered"}) {
		t.Errorf("deviations served (an override's is not one of them): %v", types)
	}
	if bytes.Contains(body, []byte("old_branch")) || bytes.Contains(body, []byte(`"branch"`)) {
		t.Errorf("a branch name served: %s", body)
	}
	gates := l["gates"].([]any)
	if len(gates) != 3 || gates[2].(map[string]any)["gate"] != "build.green" || gates[2].(map[string]any)["lane"] != "L1" || gates[2].(map[string]any)["reason_code"] != "step-recovered" {
		t.Errorf("a gate about one lane is served with the lanes: %v", gates)
	}
}

func TestSetAsideForTheNewerReasonsAndAMovedBranch(t *testing.T) {
	h := start(t, config{events: laneEvents(laneGate(30000, "build.join", "refused", "lane-set-aside", "L2"), laneGate(30001, "build.join", "passed", "landed-on-moved-branch", nil))})
	joinedCell(t, h.root, true, false)
	cell := filepath.Join(h.root, ".factory/worktrees/T-3")
	b := readJSONFile(t, filepath.Join(cell, "build.json"))
	join := b["lanes"].(map[string]any)["join"].(map[string]any)
	join["set_aside"] = []any{map[string]any{"lane": "L2", "tasks": []string{"T04", "T05"}, "lane_commits": []string{lc3, lc4}, "kept_as": keptRef, "tip": lc4,
		"because": []any{
			map[string]any{"why": "branch-moved", "file": "src/" + prose, "commits": []string{movedC1, movedC2}},
			map[string]any{"why": "did-not-apply", "commit": notApplC, "detail": prose},
			map[string]any{"why": "case-clash", "other": "L1", "file": "src/" + prose},
			map[string]any{"why": "file-folder", "other": "L1", "file": "src/" + prose},
			map[string]any{"why": "unrecorded-commits"},
			map[string]any{"why": "lane-history"},
			map[string]any{"why": prose},
		}}}
	join["moved_branch"] = map[string]any{"from": forkC, "to": movedC2, "commits": []string{movedC1, movedC2}, "files": []string{"src/" + prose, "src/b"}}
	b["deviations"] = []any{map[string]any{"task": nil, "type": "lanes-landed-on-moved-branch", "detail": prose, "loop": 0, "at": "2026-11-24T10:31:00+00:00"},
		map[string]any{"task": nil, "type": "lane-set-aside", "detail": prose, "loop": 0, "at": "2026-11-24T10:31:00+00:00", "lane": "L2", "because": []any{map[string]any{"file": "src/" + prose}}}}
	writeJSONFile(t, filepath.Join(cell, "build.json"), b)
	d, body := cellWith(t, h, "T-3")
	noProse(t, body)
	j := lanesOfReply(t, d)["join"].(map[string]any)
	sa := j["set_aside"].([]any)[0].(map[string]any)
	if sa["kept_as"] != keptRef {
		t.Errorf("kept as: %v", sa)
	}
	want := []any{
		map[string]any{"why": "branch-moved", "other": nil, "commits": float64(2), "commit": nil},
		map[string]any{"why": "did-not-apply", "other": nil, "commits": nil, "commit": notApplC},
		map[string]any{"why": "case-clash", "other": "L1", "commits": nil, "commit": nil},
		map[string]any{"why": "file-folder", "other": "L1", "commits": nil, "commit": nil},
		map[string]any{"why": "unrecorded-commits", "other": nil, "commits": nil, "commit": nil},
		map[string]any{"why": "lane-history", "other": nil, "commits": nil, "commit": nil},
		map[string]any{"why": nil, "other": nil, "commits": nil, "commit": nil},
	}
	if !reflect.DeepEqual(sa["because"], want) {
		t.Errorf("because:\n%v\nwant\n%v", sa["because"], want)
	}
	mb := j["moved_branch"].(map[string]any)
	if mb["from"] != forkC || mb["to"] != movedC2 || !reflect.DeepEqual(mb["commits"], []any{movedC1, movedC2}) || mb["files"] != float64(2) {
		t.Errorf("moved branch: %v", mb)
	}
}

// The commands task, and a changed test command in a build in lanes: which command and when only.
func TestTheCommandsTaskInABuildInLanes(t *testing.T) {
	h := start(t, config{events: laneEvents(laneGate(40000, "build.set-commands", "passed", "commands-set", nil))})
	joinedCell(t, h.root, false, false)
	cell := filepath.Join(h.root, ".factory/worktrees/T-3")
	b := readJSONFile(t, filepath.Join(cell, "build.json"))
	b["tasks"] = append(b["tasks"].([]any), map[string]any{"id": "C-T01", "kind": "impl", "text": prose, "ids": []any{}, "files": []any{}, "status": "pending", "added_by": "set-commands", "loop": 0})
	b["command_changes"] = []any{map[string]any{"at": "2026-11-24T10:40:00+00:00", "changed": []any{map[string]any{"command": "test", "old": prose, "new": prose}}, "reason": prose, "loop": 0}}
	b["deviations"] = []any{map[string]any{"task": nil, "type": "test-command-set", "detail": prose, "loop": 0, "at": "2026-11-24T10:40:00+00:00", "command": "test", "old": prose, "new": prose, "reason": prose, "during": prose}}
	writeJSONFile(t, filepath.Join(cell, "build.json"), b)
	d, body := cellWith(t, h, "T-3")
	noProse(t, body)
	l := lanesOfReply(t, d)
	if ct := taskByID(t, l, "C-T01"); ct["part"] != "commands" || ct["status"] != "pending" {
		t.Errorf("C-T01: %v", ct)
	}
	want := []any{map[string]any{"at": "2026-11-24T10:40:00Z", "commands": []any{"test"}, "loop": float64(0)}}
	if !reflect.DeepEqual(l["command_changes"], want) || !reflect.DeepEqual(d["command_changes"], want) {
		t.Errorf("command changes: lanes %v, cell %v", l["command_changes"], d["command_changes"])
	}
	devs := l["deviations"].([]any)
	if len(devs) != 1 || devs[0].(map[string]any)["command"] != "test" || devs[0].(map[string]any)["type"] != "test-command-set" {
		t.Errorf("the command's deviation: %v", devs)
	}
}

// A build not in lanes whose test command changed: the cell's reply gains command_changes (which
// command, when), and no "lanes"; the commands and the reason, chosen freely by a builder, are not served.
func TestAChangedTestCommandOfABuildNotInLanes(t *testing.T) {
	gate := feedtest.New("cell-lifecycle", "gate.evaluated", 3000).Data(map[string]any{"gate": "build.set-commands", "verdict": "passed", "reason_code": "commands-set", "subject": nil, "status": nil, "audit_tier": nil, "counts": map[string]any{}})
	events := []map[string]any{
		feedtest.New("cell-lifecycle", "station.entered", 1000).Ticket("T-4").ID("slice_id", "SLICE-004").Visit("T-4", "build#1", 1).
			Data(map[string]any{"station": "build", "stage": "building", "action": "build", "resumed": false, "unclosed_visit": nil, "head": "1111111", "counts": map[string]any{}}).Build(),
		gate.Ticket("T-4").ID("slice_id", "SLICE-004").Visit("T-4", "build#1", 1).Build(),
	}
	h := start(t, config{events: events})
	d0, before := cellWith(t, h, "T-4")
	if _, ok := d0["command_changes"]; ok {
		t.Fatal("command changes with no build.json")
	}
	writeJSONFile(t, filepath.Join(h.root, ".factory/worktrees/T-4/build.json"), map[string]any{"ticket_id": "T-4", "suite": "red", "test_cmd": prose, "lint_cmd": prose,
		"tasks": []any{task("T01", "test", "done", nil), map[string]any{"id": "C-T01", "kind": "impl", "text": prose, "status": "pending", "added_by": "set-commands"}},
		"command_changes": []any{
			map[string]any{"at": "2026-11-24T11:00:00+00:00", "changed": []any{map[string]any{"command": "test", "old": nil, "new": prose}}, "reason": prose, "loop": 0},
			map[string]any{"at": "2026-11-24T11:30:00+00:00", "changed": []any{map[string]any{"command": "test", "old": prose, "new": prose}, map[string]any{"command": "lint", "old": prose, "new": prose}}, "reason": prose, "loop": 1},
			map[string]any{"at": "2026-11-24T11:40:00+00:00", "changed": []any{map[string]any{"command": prose}}, "reason": prose},
		}})
	d, body := cellWith(t, h, "T-4")
	noProse(t, body)
	if _, ok := d["lanes"]; ok {
		t.Error("lanes on a build not in lanes")
	}
	want := []any{
		map[string]any{"at": "2026-11-24T11:00:00Z", "commands": []any{"test"}, "loop": float64(0)},
		map[string]any{"at": "2026-11-24T11:30:00Z", "commands": []any{"test", "lint"}, "loop": float64(1)},
	}
	if !reflect.DeepEqual(d["command_changes"], want) {
		t.Fatalf("command changes: %v", d["command_changes"])
	}
	// No change recorded: the reply is as before.
	writeJSONFile(t, filepath.Join(h.root, ".factory/worktrees/T-4/build.json"), map[string]any{"ticket_id": "T-4", "tasks": []any{task("T01", "test", "done", nil)}, "command_changes": []any{}})
	if _, after := cellWith(t, h, "T-4"); !bytes.Equal(before, after) {
		t.Fatalf("no change, but the reply changed:\n%s\n%s", before, after)
	}
}
