package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"mach/observer/internal/feedtest"
)

// A ticket verified twice: verify.py moved the first run's files to evidence/previous-1/, and both
// runs' checks name evidence/<file>. Each check is matched to the file of its own run, by the hash
// it recorded; an earlier run's file that changed or is gone says so, and is not hidden behind the
// current file.
func TestEvidenceChecksMatchTheirOwnRun(t *testing.T) {
	old1, new1 := []byte("run one: the CLI printed 3 rows\n"), []byte("run two: the CLI printed 4 rows\n")
	same := []byte("identical in both runs\n")
	gone := []byte("the first run's transcript\n")
	tampered := []byte("the first run's log\n")
	ev := func(file string, b []byte) map[string]any {
		return map[string]any{"file": "evidence/" + file, "sha256": sha(b), "bytes": len(b)}
	}
	c := func(ms int64, visit string, round int, target string, files ...map[string]any) map[string]any {
		return feedtest.New("cell-lifecycle", "verify.check_recorded", ms).Ticket("T-9").Visit("T-9", visit, round).
			Data(map[string]any{"target_id": target, "target_kind": "scenario", "result": "pass", "evidence": files, "rerecorded": false}).Build()
	}
	events := []map[string]any{
		c(1000, "verify#1", 1, "AC-01", ev("AC-01.txt", old1)),
		c(1100, "verify#1", 1, "AC-02", ev("same.txt", same)),
		c(1200, "verify#1", 1, "AC-03", ev("gone.txt", gone)),
		c(1300, "verify#1", 1, "AC-04", ev("tampered.txt", tampered)),
		c(5000, "verify#2", 2, "AC-01", ev("AC-01.txt", new1)),
		c(5100, "verify#2", 2, "AC-02", ev("same.txt", same)),
	}
	h := start(t, config{events: events})
	cell := filepath.Join(h.root, ".factory/worktrees/T-9")
	results := func(loop int, recs map[string][]byte) []byte {
		r := map[string]any{}
		for id, b := range recs {
			name := map[string]string{"AC-01": "AC-01.txt", "AC-02": "same.txt", "AC-03": "gone.txt", "AC-04": "tampered.txt"}[id]
			r[id] = map[string]any{"kind": "scenario", "result": "pass", "evidence": []map[string]string{{"file": name, "sha256": sha(b)}}}
		}
		data, _ := json.Marshal(map[string]any{"head": "abcdef1", "review_loop": loop, "records": r})
		return data
	}
	// the first run, as verify.py left it in previous-1/
	writeFile(t, filepath.Join(cell, "evidence/previous-1/AC-01.txt"), old1)
	writeFile(t, filepath.Join(cell, "evidence/previous-1/same.txt"), same)
	writeFile(t, filepath.Join(cell, "evidence/previous-1/tampered.txt"), []byte("changed after the run\n"))
	writeFile(t, filepath.Join(cell, "evidence/previous-1/results.json"),
		results(0, map[string][]byte{"AC-01": old1, "AC-02": same, "AC-03": gone, "AC-04": tampered}))
	// the current run: the same names, AC-01.txt with different bytes
	writeFile(t, filepath.Join(cell, "evidence/AC-01.txt"), new1)
	writeFile(t, filepath.Join(cell, "evidence/same.txt"), same)
	writeFile(t, filepath.Join(cell, "evidence/results.json"), results(1, map[string][]byte{"AC-01": new1, "AC-02": same}))

	var v map[string]any
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		v = h.get(t, "/api/v1/cells/T-9/evidence")
		if checks, _ := v["checks"].([]any); len(checks) == len(events) || time.Now().After(deadline) {
			break
		}
	}
	paths := map[string]string{}
	for _, it := range v["artifacts"].([]any) {
		a := it.(map[string]any)
		paths[a["id"].(string)] = a["path_rel"].(string)
	}
	type got struct{ path, integrity string }
	seen := map[string]got{}
	checks := v["checks"].([]any)
	if len(checks) != len(events) {
		t.Fatalf("%d checks: %v", len(checks), checks)
	}
	for _, it := range checks {
		k := it.(map[string]any)
		f := k["evidence"].([]any)[0].(map[string]any)
		id, _ := f["artifact_id"].(string)
		seen[k["target_id"].(string)+"@"+k["visit_id"].(string)] = got{paths[id], f["integrity"].(string)}
	}
	want := map[string]got{
		"AC-01@T-9/verify#1": {"evidence/previous-1/AC-01.txt", "match"},
		"AC-01@T-9/verify#2": {"evidence/AC-01.txt", "match"},
		"AC-02@T-9/verify#1": {"evidence/previous-1/same.txt", "match"},
		"AC-02@T-9/verify#2": {"evidence/same.txt", "match"},
		// earlier run, file gone: its own run's record names it, and it is missing
		"AC-03@T-9/verify#1": {"evidence/previous-1/gone.txt", "missing"},
		// earlier run, file changed after the run: a mismatch against its own run's file
		"AC-04@T-9/verify#1": {"evidence/previous-1/tampered.txt", "mismatch"},
	}
	for key, w := range want {
		if seen[key] != w {
			t.Errorf("%s: got %+v, want %+v", key, seen[key], w)
		}
	}
	// With no earlier run catalogued, a check whose bytes are not the current file's is a mismatch, as before.
	os.RemoveAll(filepath.Join(cell, "evidence/previous-1"))
	time.Sleep(2100 * time.Millisecond) // the catalog's cache
	v = h.get(t, "/api/v1/cells/T-9/evidence")
	for _, it := range v["checks"].([]any) {
		k := it.(map[string]any)
		f := k["evidence"].([]any)[0].(map[string]any)
		if k["target_id"] == "AC-01" && k["visit_id"] == "T-9/verify#1" && f["integrity"] != "mismatch" {
			t.Errorf("first run's AC-01 without its folder: %v", f)
		}
		if k["target_id"] == "AC-03" && f["integrity"] != "missing" {
			t.Errorf("AC-03 without its folder: %v", f)
		}
	}
}
