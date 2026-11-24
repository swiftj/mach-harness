package server

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/feedtest"
)

// M22: a build in lanes, on GET /api/v1/cells/{ticket}. The cell's files are written as the build
// station writes them (skills/build/scripts/build.py: plan_lanes_at_start, cmd_lanes_open, Lane,
// join_record, report_lanes); the events as the lifecycle log has them after normalising.

const (
	lc1, lc2, lc3, lc4 = "1111111111aaaaaaaaaa", "2222222222bbbbbbbbbb", "3333333333cccccccccc", "4444444444dddddddddd"
	ld1, ld2, ld3, ld4 = "5555555555eeeeeeeeee", "6666666666ffffffffff", "7777777777aaaaaaaaaa", "8888888888bbbbbbbbbb"
	forkC              = "9999999999cccccccccc"
	prose              = "QQLANEPROSE Ada Lovelace wrote this"
)

// laneEvents are T-3's build: the tasks before the lanes, lanes open, lane tasks, and what is given.
func laneEvents(extra ...*feedtest.Ev) []map[string]any {
	c := func(typ string, ms int64) *feedtest.Ev {
		return feedtest.New("cell-lifecycle", typ, ms).Ticket("T-3").ID("slice_id", "SLICE-003").Visit("T-3", "build#1", 1)
	}
	out := []map[string]any{
		c("station.entered", 1000).Data(map[string]any{"station": "build", "stage": "building", "action": "build", "resumed": false, "unclosed_visit": nil, "head": "1111111", "counts": map[string]any{}}).Build(),
		c("build.task_completed", 2000).Data(map[string]any{"task_id": "T01", "kind": "contract", "step": "done", "first_run": nil, "suite": "green", "commit": "abcdef1"}).Build(),
		c("gate.evaluated", 3000).Data(map[string]any{"gate": "build.lanes-open", "verdict": "passed", "reason_code": nil, "subject": nil, "status": nil, "audit_tier": nil, "counts": map[string]any{"granted": 2, "first": true}}).Build(),
		c("build.task_completed", 4000).Data(map[string]any{"task_id": "T02", "kind": "test", "step": "red", "first_run": "fail", "suite": "red", "commit": lc1, "lane": "L1"}).Build(),
	}
	for _, e := range extra {
		out = append(out, e.Ticket("T-3").ID("slice_id", "SLICE-003").Visit("T-3", "build#1", 1).Build())
	}
	return out
}

func laneGate(ms int64, gate, verdict string, reason any, lane any) *feedtest.Ev {
	d := map[string]any{"gate": gate, "verdict": verdict, "reason_code": reason, "subject": nil, "status": nil, "audit_tier": nil, "counts": map[string]any{}}
	if lane != nil {
		d["lane"] = lane
	}
	return feedtest.New("cell-lifecycle", "gate.evaluated", ms).Data(d)
}

func task(id, kind, status string, extra map[string]any) map[string]any {
	t := map[string]any{"id": id, "kind": kind, "status": status, "text": prose + " task text", "files": []string{"src/" + prose + ".py"},
		"ids": []string{"FR-01"}, "note": prose + " note"}
	for k, v := range extra {
		t[k] = v
	}
	return t
}

// buildJSON is build.json with a lane record: T01 before the lanes, L1 = T02 T03, L2 = T04 T05, L3 = T06, T07 after.
func buildJSON(state string, lanes []map[string]any, tasks []map[string]any, join map[string]any) map[string]any {
	rec := map[string]any{"state": state, "setting": 3, "planned_at": "2026-11-24T10:00:00+00:00", "fork": forkC, "opened_at": "2026-11-24T10:05:00+00:00",
		"plan":  map[string]any{"before": []string{"T01"}, "after": []string{"T07"}, "joined_because": []map[string]any{{"tasks": []string{"T02", "T03"}, "why": prose}}, "single_reason": prose},
		"lanes": lanes, "why": prose,
		"batches": []map[string]any{{"at": "2026-11-24T10:05:00+00:00", "lanes": []string{"L1", "L2"}, "granted": 2, "free_places": 2, "others": []string{prose}}}}
	if join != nil {
		rec["join"] = join
	}
	return map[string]any{"ticket_id": "T-3", "suite": "green", "started_at": "2026-11-24T10:00:00+00:00", "test_cmd": prose, "deviations": []map[string]any{{"type": "lane-set-aside", "detail": prose}},
		"tasks": tasks, "lanes": rec}
}

func laneEntry(name, status string, tasks ...string) map[string]any {
	return map[string]any{"lane": name, "tasks": tasks, "files": []string{"src/" + prose}, "status": status, "branch": "mach-lane/T-3/" + name}
}

func laneJSON(name, status string, tasks ...map[string]any) map[string]any {
	return map[string]any{"ticket_id": "T-3", "lane": name, "branch": "mach-lane/T-3/" + name, "fork": forkC, "status": status, "holder": prose,
		"opened_at": "2026-11-24T10:05:00+00:00", "handed_at": "2026-11-24T10:05:00+00:00", "started_at": "2026-11-24T10:05:30+00:00",
		"last_step_at": "2026-11-24T10:20:00+00:00", "worktree_seconds": 1.5, "tasks": tasks, "deviations": []map[string]any{{"detail": prose}}}
}

func writeJSONFile(t *testing.T, path string, v any) {
	t.Helper()
	b, _ := json.Marshal(v)
	writeFile(t, path, b)
}

// cellWith waits for the projection to hold the ticket, then returns its detail.
func cellWith(t *testing.T, h *harness, ticket string) (map[string]any, []byte) {
	t.Helper()
	for i := 0; i < 200; i++ {
		resp, env, body := h.do(t, "GET", "/api/v1/cells/"+ticket, nil)
		if resp.StatusCode == 200 && env.OK {
			var out struct {
				Data map[string]any `json:"data"`
			}
			json.Unmarshal(body, &out)
			return out.Data, body
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no cell %s", ticket)
	return nil, nil
}

func lanesOfReply(t *testing.T, d map[string]any) map[string]any {
	t.Helper()
	l, ok := d["lanes"].(map[string]any)
	if !ok {
		t.Fatalf("no lanes in the reply: %v", mapKeys(d))
	}
	return l
}

func laneByName(t *testing.T, l map[string]any, name string) map[string]any {
	t.Helper()
	for _, x := range l["lanes"].([]any) {
		if m := x.(map[string]any); m["lane"] == name {
			return m
		}
	}
	t.Fatalf("no lane %s in %v", name, l["lanes"])
	return nil
}

func taskByID(t *testing.T, l map[string]any, id string) map[string]any {
	t.Helper()
	for _, x := range l["tasks"].([]any) {
		if m := x.(map[string]any); m["task"] == id {
			return m
		}
	}
	t.Fatalf("no task %s", id)
	return nil
}

func noProse(t *testing.T, body []byte) {
	t.Helper()
	for _, s := range []string{"QQLANEPROSE", "Lovelace", "src/"} {
		if bytes.Contains(body, []byte(s)) {
			t.Fatalf("prose from the cell's files served (%q): %s", s, body)
		}
	}
}

func openLanesCell(t *testing.T, root string) {
	cell := filepath.Join(root, ".factory/worktrees/T-3")
	pending := func(id, kind string) map[string]any { return task(id, kind, "pending", nil) }
	writeJSONFile(t, filepath.Join(cell, "build.json"), buildJSON("open",
		[]map[string]any{laneEntry("L1", "open", "T02", "T03"), laneEntry("L2", "open", "T04", "T05"), laneEntry("L3", "planned", "T06")},
		[]map[string]any{task("T01", "contract", "done", map[string]any{"commit": "abcdef1234", "at": "2026-11-24T10:04:00+00:00"}),
			pending("T02", "test"), pending("T03", "impl"), pending("T04", "test"), pending("T05", "impl"), pending("T06", "docs"), pending("T07", "docs")}, nil))
	writeJSONFile(t, filepath.Join(cell, "lanes/L1/lane.json"), laneJSON("L1", "open",
		task("T02", "test", "done", map[string]any{"commit": lc1, "lane": "L1", "lane_commit": lc1, "ran_on": lc1, "at": "2026-11-24T10:10:00+00:00", "test_run": map[string]any{"seconds": 4.5, "command": prose}}),
		task("T03", "impl", "pending", nil)))
	writeJSONFile(t, filepath.Join(cell, "lanes/L2/lane.json"), laneJSON("L2", "open", task("T04", "test", "pending", nil), task("T05", "impl", "pending", nil)))
}

func TestLanesOpen(t *testing.T) {
	h := start(t, config{events: laneEvents()})
	openLanesCell(t, h.root)
	d, body := cellWith(t, h, "T-3")
	noProse(t, body)
	l := lanesOfReply(t, d)
	if l["state"] != "open" || l["source"] != "cell" || l["fork"] != forkC || l["setting"] != float64(3) || l["opened_at"] != "2026-11-24T10:05:00Z" || l["build_started_at"] != "2026-11-24T10:00:00Z" {
		t.Fatalf("lanes: %v", l)
	}
	if !reflect.DeepEqual(l["before"], []any{"T01"}) || !reflect.DeepEqual(l["after"], []any{"T07"}) {
		t.Errorf("parts: %v %v", l["before"], l["after"])
	}
	l1, l2, l3 := laneByName(t, l, "L1"), laneByName(t, l, "L2"), laneByName(t, l, "L3")
	if l1["done"] != float64(1) || l1["total"] != float64(2) || l1["current"] != "T03" || l1["status"] != "open" || l1["waiting"] != nil {
		t.Errorf("L1: %v", l1)
	}
	if l2["done"] != float64(0) || l2["current"] != "T04" || l2["record"].(map[string]any)["read"] != "read" {
		t.Errorf("L2: %v", l2)
	}
	if l3["waiting"] != "free-place" || l3["record"].(map[string]any)["read"] != "absent" || l3["done"] != float64(0) || l3["current"] != nil {
		t.Errorf("L3 waits for a free place: %v", l3)
	}
	t2 := taskByID(t, l, "T02")
	if t2["status"] != "done" || t2["lane_commit"] != lc1 || t2["commit"] != nil || t2["part"] != "lane" || t2["lane"] != "L1" || t2["test_seconds"] != 4.5 {
		t.Errorf("T02 while its lane is open: %v", t2)
	}
	if t1 := taskByID(t, l, "T01"); t1["part"] != "before" || t1["commit"] != "abcdef1234" {
		t.Errorf("T01: %v", t1)
	}
	commits := l["commits"].([]any)
	if len(commits) != 1 || commits[0].(map[string]any)["state"] != "not-joined" || commits[0].(map[string]any)["landed_commit"] != nil {
		t.Errorf("commits: %v", commits)
	}
	gates := l["gates"].([]any)
	if len(gates) != 1 || gates[0].(map[string]any)["gate"] != "build.lanes-open" || gates[0].(map[string]any)["verdict"] != "passed" {
		t.Errorf("gates: %v", gates)
	}
	// The task's event names its lane (revision 9).
	tasks := d["tasks"].([]any)
	if last := tasks[len(tasks)-1].(map[string]any); last["lane"] != "L1" || last["commit"] != lc1 {
		t.Errorf("the event's task: %v", last)
	}
	if l["report_timing"] != nil || l["build_report"].(map[string]any)["read"] != "absent" {
		t.Errorf("no report yet: %v %v", l["report_timing"], l["build_report"])
	}
}

// joinedCell writes a build whose lanes were joined: L1 and L2 landed; aside names a lane set aside;
// interaction makes the joined suite fail with J-T01 added.
func joinedCell(t *testing.T, root string, aside, interaction bool) {
	cell := filepath.Join(root, ".factory/worktrees/T-3")
	l2Status := "joined"
	if aside {
		l2Status = "set-aside"
	}
	join := map[string]any{"state": "joined", "started_at": "2026-11-24T10:30:00+00:00", "finished_at": "2026-11-24T10:31:00+00:00", "status": "JOINED",
		"fork": forkC, "tip": ld2, "landing_seconds": 2.5,
		"landed":    []map[string]any{{"task": "T02", "lane": "L1", "commit": ld1, "lane_commit": lc1, "patch_id": "x"}, {"task": "T03", "lane": "L1", "commit": ld2, "lane_commit": lc2, "patch_id": "y"}},
		"set_aside": []any{}, "interaction": nil,
		"suite": map[string]any{"passed": true, "exit_code": 0, "seconds": 30.0, "command": prose, "output_tail": prose, "ran_on": ld2}}
	tasks := []map[string]any{task("T01", "contract", "done", map[string]any{"commit": "abcdef1234", "at": "2026-11-24T10:04:00+00:00"}),
		task("T02", "test", "done", map[string]any{"lane": "L1", "commit": ld1, "lane_commit": lc1, "ran_on": lc1, "at": "2026-11-24T10:10:00+00:00", "test_run": map[string]any{"seconds": 4.5}}),
		task("T03", "impl", "done", map[string]any{"lane": "L1", "commit": ld2, "lane_commit": lc2, "ran_on": lc2, "at": "2026-11-24T10:20:00+00:00"})}
	if aside {
		join["set_aside"] = []map[string]any{{"lane": "L2", "tasks": []string{"T04", "T05"}, "lane_commits": []string{lc3, lc4},
			"because": []map[string]any{{"other": "L1", "file": "src/" + prose, "why": "same-file"}}}}
		tasks = append(tasks, task("T04", "test", "pending", map[string]any{"lane": "L2", "set_aside": true}), task("T05", "impl", "pending", map[string]any{"lane": "L2", "set_aside": true}))
	} else {
		join["landed"] = append(join["landed"].([]map[string]any), map[string]any{"task": "T04", "lane": "L2", "commit": ld3, "lane_commit": lc3}, map[string]any{"task": "T05", "lane": "L2", "commit": ld4, "lane_commit": lc4})
		tasks = append(tasks, task("T04", "test", "done", map[string]any{"lane": "L2", "commit": ld3, "lane_commit": lc3, "at": "2026-11-24T10:12:00+00:00"}),
			task("T05", "impl", "done", map[string]any{"lane": "L2", "commit": ld4, "lane_commit": lc4, "at": "2026-11-24T10:25:00+00:00"}))
	}
	if interaction {
		join["status"] = "INTERACTION"
		join["suite"].(map[string]any)["passed"] = false
		join["interaction"] = map[string]any{"failing": []string{"tests/test_" + prose + ".py::test_a", "tests/test_b.py::test_b"}, "lanes_named": []map[string]any{{"lane": "L2", "files": []string{"src/" + prose}}},
			"lanes": []string{"L1", "L2"}, "fix_files": []string{"src/" + prose}, "output_tail": prose}
		tasks = append(tasks, map[string]any{"id": "J-T01", "kind": "impl", "text": "Make the lanes pass together — `src/" + prose + "`", "files": []string{"src/" + prose}, "status": "pending", "added_by": "join"})
	}
	tasks = append(tasks, task("T07", "docs", "pending", nil))
	lanes := []map[string]any{laneEntry("L1", "joined", "T02", "T03"), laneEntry("L2", l2Status, "T04", "T05")}
	for _, e := range lanes {
		e["handed_at"], e["started_at"], e["finished_at"] = "2026-11-24T10:05:00+00:00", "2026-11-24T10:05:30+00:00", "2026-11-24T10:25:00+00:00"
		e["test_seconds"], e["worktree_seconds"] = 12.0, 1.5
	}
	writeJSONFile(t, filepath.Join(cell, "build.json"), buildJSON("joined", lanes, tasks, join))
	writeJSONFile(t, filepath.Join(cell, "lanes/L1/lane.json"), laneJSON("L1", "done", task("T02", "test", "done", map[string]any{"commit": lc1}), task("T03", "impl", "done", map[string]any{"commit": lc2})))
	writeJSONFile(t, filepath.Join(cell, "lanes/L2/lane.json"), laneJSON("L2", "done", task("T04", "test", "done", map[string]any{"commit": lc3}), task("T05", "impl", "done", map[string]any{"commit": lc4})))
}

func TestLanesJoinedLinkEachLaneCommitToItsLandedCopy(t *testing.T) {
	h := start(t, config{events: laneEvents(laneGate(30000, "build.join", "passed", nil, nil))})
	joinedCell(t, h.root, false, false)
	writeJSONFile(t, filepath.Join(h.root, ".factory/worktrees/T-3/build-report.json"), map[string]any{"status": "BUILT", "finished_at": "2026-11-24T10:40:00+00:00",
		"timing": map[string]any{"elapsed_seconds": 2400.0, "note": prose, "steps": []map[string]any{
			{"task": "T01", "kind": "contract", "seconds_since_previous_step": 240.0, "test_seconds": 3.0},
			{"task": "T02", "kind": "test", "lane": "L1", "seconds_since_previous_step": 300.0, "test_seconds": 4.5},
			{"task": "T03", "kind": "impl", "lane": "L1", "seconds_since_previous_step": nil, "test_seconds": nil}},
			"lanes": map[string]any{"wall_seconds": 1200.0, "summed_lane_seconds": 2340.0, "ratio": 1.95, "worktree_seconds": 3.0, "landing_seconds": 2.5, "joined_suite_seconds": 30.0, "note": prose,
				"lanes": []map[string]any{{"lane": "L1", "elapsed_seconds": 1170.0, "test_seconds": 12.0}, {"lane": "L2", "elapsed_seconds": 1170.0, "test_seconds": nil}}}}})
	d, body := cellWith(t, h, "T-3")
	noProse(t, body)
	l := lanesOfReply(t, d)
	if l["state"] != "joined" {
		t.Fatalf("state %v", l["state"])
	}
	j := l["join"].(map[string]any)
	if j["status"] != "JOINED" || j["landed"] != float64(4) || j["suite_passed"] != true || j["suite_seconds"] != float64(30) || j["tip"] != ld2 || j["interaction"] != nil || len(j["set_aside"].([]any)) != 0 {
		t.Errorf("join: %v", j)
	}
	want := map[string]string{lc1: ld1, lc2: ld2, lc3: ld3, lc4: ld4}
	commits := l["commits"].([]any)
	if len(commits) != 4 {
		t.Fatalf("commits: %v", commits)
	}
	for _, c := range commits {
		m := c.(map[string]any)
		if m["state"] != "landed" || m["landed_commit"] != want[m["lane_commit"].(string)] {
			t.Errorf("a lane commit not followed to its landed copy: %v", m)
		}
	}
	if t2 := taskByID(t, l, "T02"); t2["commit"] != ld1 || t2["lane_commit"] != lc1 {
		t.Errorf("T02 after the join: %v", t2)
	}
	if l1 := laneByName(t, l, "L1"); l1["status"] != "joined" || l1["done"] != float64(2) || l1["current"] != nil || l1["finished_at"] != "2026-11-24T10:25:00Z" {
		t.Errorf("L1: %v", l1)
	}
	rt := l["report_timing"].(map[string]any)
	if rt["elapsed_seconds"] != float64(2400) || rt["lanes_wall_seconds"] != float64(1200) || rt["lanes_summed_seconds"] != float64(2340) || rt["lanes_ratio"] != 1.95 {
		t.Errorf("report timing: %v", rt)
	}
	steps := rt["steps"].([]any)
	if len(steps) != 3 || steps[1].(map[string]any)["lane"] != "L1" || steps[2].(map[string]any)["seconds"] != nil {
		t.Errorf("steps (a time not recorded stays null): %v", steps)
	}
}

func TestLanesSetAside(t *testing.T) {
	h := start(t, config{events: laneEvents(laneGate(30000, "build.join", "refused", "lane-set-aside", "L2"), laneGate(30001, "build.join", "passed", nil, nil))})
	joinedCell(t, h.root, true, false)
	d, body := cellWith(t, h, "T-3")
	noProse(t, body)
	l := lanesOfReply(t, d)
	sa := l["join"].(map[string]any)["set_aside"].([]any)
	if len(sa) != 1 {
		t.Fatalf("set aside: %v", sa)
	}
	item := sa[0].(map[string]any)
	if item["lane"] != "L2" || !reflect.DeepEqual(item["tasks"], []any{"T04", "T05"}) ||
		!reflect.DeepEqual(item["because"], []any{map[string]any{"other": "L1", "why": "same-file", "commits": nil, "commit": nil}}) || item["kept_as"] != nil {
		t.Errorf("set aside: %v", item)
	}
	if t4 := taskByID(t, l, "T04"); t4["set_aside"] != true || t4["status"] != "pending" || t4["lane_commit"] != lc3 || t4["commit"] != nil {
		t.Errorf("T04, to be built again in the cell: %v", t4)
	}
	for _, c := range l["commits"].([]any) {
		m := c.(map[string]any)
		if m["lane"] == "L2" && (m["state"] != "set-aside" || m["landed_commit"] != nil) {
			t.Errorf("a set-aside lane's commit: %v", m)
		}
	}
	gates := l["gates"].([]any)
	if g := gates[1].(map[string]any); g["reason_code"] != "lane-set-aside" || g["lane"] != "L2" || g["verdict"] != "refused" {
		t.Errorf("the set-aside gate names its lane: %v", g)
	}
	if l2 := laneByName(t, l, "L2"); l2["status"] != "set-aside" {
		t.Errorf("L2: %v", l2)
	}
}

func TestLanesFailTogetherAtTheJoin(t *testing.T) {
	jt := feedtest.New("cell-lifecycle", "build.task_completed", 40000).Data(map[string]any{"task_id": "J-T01", "kind": "impl", "step": "green", "first_run": nil, "suite": "green", "commit": "fedcba9"})
	h := start(t, config{events: laneEvents(laneGate(30000, "build.join", "refused", "lanes-interaction", nil), jt)})
	joinedCell(t, h.root, false, true)
	d, body := cellWith(t, h, "T-3")
	noProse(t, body)
	l := lanesOfReply(t, d)
	j := l["join"].(map[string]any)
	in, _ := j["interaction"].(map[string]any)
	if j["status"] != "INTERACTION" || j["suite_passed"] != false || in == nil || in["failing"] != float64(2) || in["task"] != "J-T01" ||
		!reflect.DeepEqual(in["lanes_named"], []any{"L2"}) {
		t.Fatalf("interaction: %v", j)
	}
	if jt := taskByID(t, l, "J-T01"); jt["part"] != "join" || jt["status"] != "pending" || jt["lane"] != nil {
		t.Errorf("J-T01: %v", jt)
	}
	// The join's task keeps its own ID in the events (revision 9), not T0.
	found := false
	for _, x := range d["tasks"].([]any) {
		found = found || x.(map[string]any)["task_id"] == "J-T01"
	}
	if !found {
		t.Errorf("J-T01's event: %v", d["tasks"])
	}
}

func TestALaneFileThatCannotBeReadIsSaidSo(t *testing.T) {
	h := start(t, config{events: laneEvents()})
	openLanesCell(t, h.root)
	cell := filepath.Join(h.root, ".factory/worktrees/T-3")
	writeFile(t, filepath.Join(cell, "lanes/L2/lane.json"), []byte("{not json"))
	os.MkdirAll(filepath.Join(cell, "lanes/L3"), 0o755)
	outside := filepath.Join(h.root, "elsewhere.json")
	writeJSONFile(t, outside, laneJSON("L3", "open"))
	if err := os.Symlink(outside, filepath.Join(cell, "lanes/L3/lane.json")); err != nil {
		t.Skip("no symlinks here")
	}
	// L3 is open in build.json, so its record is expected.
	b, _ := os.ReadFile(filepath.Join(cell, "build.json"))
	b = bytes.Replace(b, []byte(`"status":"planned"`), []byte(`"status":"open"`), 1)
	writeFile(t, filepath.Join(cell, "build.json"), b)
	d, _ := cellWith(t, h, "T-3")
	l := lanesOfReply(t, d)
	l2 := laneByName(t, l, "L2")
	r2 := l2["record"].(map[string]any)
	if r2["read"] != "unreadable" || r2["why"] != "not the JSON the build station writes" || l2["done"] != nil || l2["current"] != nil {
		t.Errorf("L2: %v", l2)
	}
	r3 := laneByName(t, l, "L3")["record"].(map[string]any)
	if r3["read"] != "unreadable" || !strings.Contains(r3["why"].(string), "link") {
		t.Errorf("L3 behind a link: %v", r3)
	}
	// A lane open with no record at all.
	os.Remove(filepath.Join(cell, "lanes/L2/lane.json"))
	d, _ = cellWith(t, h, "T-3")
	r2 = laneByName(t, lanesOfReply(t, d), "L2")["record"].(map[string]any)
	if r2["read"] != "absent" || r2["why"] != "the lane's record is missing" {
		t.Errorf("L2 without a record: %v", r2)
	}
	// build.json itself unreadable, while the events show lanes: said, not left out.
	writeFile(t, filepath.Join(cell, "build.json"), []byte("{"))
	d, _ = cellWith(t, h, "T-3")
	l = lanesOfReply(t, d)
	if l["state"] != "unreadable" || l["build_json"].(map[string]any)["read"] != "unreadable" {
		t.Errorf("build.json unreadable: %v", l)
	}
}

func TestACellWithoutLanesIsServedAsBefore(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	d0, before := cellWith(t, h, "T-1")
	if _, ok := d0["lanes"]; ok {
		t.Fatal("lanes on a cell with no files")
	}
	// A build.json without a lane record: nothing changes.
	writeJSONFile(t, filepath.Join(h.root, ".factory/worktrees/T-1/build.json"), map[string]any{"tasks": []map[string]any{task("T1", "test", "done", nil)}, "suite": "green"})
	d1, after := cellWith(t, h, "T-1")
	if _, ok := d1["lanes"]; ok || !bytes.Equal(before, after) {
		t.Fatalf("a build without lanes changed the reply:\n%s\n%s", before, after)
	}
	// An unreadable build.json for a cell whose events show no lanes: nothing is said either.
	writeFile(t, filepath.Join(h.root, ".factory/worktrees/T-1/build.json"), []byte("{"))
	if _, after = cellWith(t, h, "T-1"); !bytes.Equal(before, after) {
		t.Fatal("an unreadable build.json of a build without lanes changed the reply")
	}
	// Tasks of a build without lanes carry no lane.
	for _, x := range d0["tasks"].([]any) {
		if _, ok := x.(map[string]any)["lane"]; ok {
			t.Errorf("a lane on a task built in the cell: %v", x)
		}
	}
}

func TestLanesReadFromTheArchive(t *testing.T) {
	h := start(t, config{events: laneEvents(laneGate(30000, "build.join", "passed", nil, nil))})
	joinedCell(t, h.root, false, false)
	cell := filepath.Join(h.root, ".factory/worktrees/T-3")
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, rel := range []string{"build.json", "lanes/L1/lane.json", "lanes/L2/lane.json"} {
		data, _ := os.ReadFile(filepath.Join(cell, rel))
		tw.WriteHeader(&tar.Header{Name: "T-3/" + rel, Mode: 0o644, Size: int64(len(data)), Typeflag: tar.TypeReg})
		tw.Write(data)
	}
	tw.Close()
	gz.Close()
	writeFile(t, filepath.Join(h.root, ".factory/archive/T-3.tar.gz"), buf.Bytes())
	os.RemoveAll(cell)
	d, body := cellWith(t, h, "T-3")
	noProse(t, body)
	l := lanesOfReply(t, d)
	if l["source"] != "archive" || l["state"] != "joined" || len(l["commits"].([]any)) != 4 || laneByName(t, l, "L2")["done"] != float64(2) {
		t.Fatalf("from the archive: %v", l)
	}
	// Neither a folder nor an archive: the events show lanes, so it is said.
	os.Remove(filepath.Join(h.root, ".factory/archive/T-3.tar.gz"))
	d, _ = cellWith(t, h, "T-3")
	if l := lanesOfReply(t, d); l["state"] != "unreadable" || l["build_json"].(map[string]any)["read"] != "unreadable" && l["build_json"].(map[string]any)["read"] != "absent" {
		t.Fatalf("no files: %v", l)
	}
}

// joiningCell writes T-3 with every lane done and a join that started at 10:30 and has no result yet,
// done by the process pid on host.
func joiningCell(t *testing.T, root string, pid int, host string) {
	cell := filepath.Join(root, ".factory/worktrees/T-3")
	pending := func(id, kind string) map[string]any { return task(id, kind, "pending", nil) }
	b := buildJSON("open", []map[string]any{laneEntry("L1", "open", "T02", "T03"), laneEntry("L2", "open", "T04", "T05")},
		[]map[string]any{task("T01", "contract", "done", map[string]any{"commit": "abcdef1234"}), pending("T02", "test"), pending("T03", "impl"),
			pending("T04", "test"), pending("T05", "impl"), pending("T07", "docs")}, nil)
	rec := b["lanes"].(map[string]any)
	rec["join_started_at"] = "2026-11-24T10:30:00+00:00"
	rec["join_running"] = map[string]any{"since": "2026-11-24T10:30:00+00:00", "pid": pid, "host": host}
	writeJSONFile(t, filepath.Join(cell, "build.json"), b)
	writeJSONFile(t, filepath.Join(cell, "lanes/L1/lane.json"), laneJSON("L1", "done", task("T02", "test", "done", map[string]any{"commit": lc1}), task("T03", "impl", "done", map[string]any{"commit": lc2})))
	writeJSONFile(t, filepath.Join(cell, "lanes/L2/lane.json"), laneJSON("L2", "done", task("T04", "test", "done", map[string]any{"commit": lc3}), task("T05", "impl", "done", map[string]any{"commit": lc4})))
}

func TestTheJoinsMomentIsServedFromTheRecordedStart(t *testing.T) {
	host, err := os.Hostname()
	if err != nil {
		t.Skip("no host name here")
	}
	h := start(t, config{events: laneEvents(laneGate(30000, "build.join", "passed", "join-started", nil))})
	// Under way: the process doing it is alive (this test's own).
	joiningCell(t, h.root, os.Getpid(), host)
	d, body := cellWith(t, h, "T-3")
	noProse(t, body)
	l := lanesOfReply(t, d)
	if l["join_started_at"] != "2026-11-24T10:30:00Z" || l["joining"] != "running" || l["join"] != nil {
		t.Fatalf("being joined: started %v, joining %v, join %v", l["join_started_at"], l["joining"], l["join"])
	}
	for _, s := range []string{"join_running", `"pid"`, host} {
		if bytes.Contains(body, []byte(s)) {
			t.Fatalf("the join's process is checked, never served (%q): %s", s, body)
		}
	}
	gates := l["gates"].([]any)
	if g := gates[len(gates)-1].(map[string]any); g["gate"] != "build.join" || g["verdict"] != "passed" || g["reason_code"] != "join-started" {
		t.Errorf("the start's gate: %v", g)
	}
	// Interrupted: the process that started it is gone.
	gone := exec.Command("true")
	if err := gone.Run(); err != nil {
		t.Skip("cannot run a process here")
	}
	joiningCell(t, h.root, gone.Process.Pid, host)
	d, _ = cellWith(t, h, "T-3")
	if l = lanesOfReply(t, d); l["joining"] != "interrupted" || l["join_started_at"] != "2026-11-24T10:30:00Z" {
		t.Fatalf("interrupted: %v %v", l["joining"], l["join_started_at"])
	}
	// Another machine's process cannot be checked from here.
	joiningCell(t, h.root, os.Getpid(), host+"-elsewhere")
	d, _ = cellWith(t, h, "T-3")
	if l = lanesOfReply(t, d); l["joining"] != "unknown" {
		t.Fatalf("elsewhere: %v", l["joining"])
	}
	// No join under way: no moment, as before.
	openLanesCell(t, h.root)
	d, _ = cellWith(t, h, "T-3")
	if l = lanesOfReply(t, d); l["joining"] != nil || l["join_started_at"] != nil {
		t.Fatalf("no join: %v %v", l["joining"], l["join_started_at"])
	}
}
