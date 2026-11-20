package server

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/feedtest"
)

// M15: a design mock's side-by-side record (MOCK-N) is a check in the evidence route, with the
// approved mock and the capture each marked, the recorded result, the binding flag and the
// verifier's words labelled as free text. verify.py's compare writes no lifecycle line, so the
// check comes from results.json; a check the lifecycle log does record keeps its lifecycle basis.
func TestEvidenceRouteListsDesignMockChecks(t *testing.T) {
	mock := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{7}, 40)...)
	capture := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{9}, 40)...)
	m := sha(mock)
	scenario := feedtest.New("cell-lifecycle", "verify.check_recorded", 1000).Ticket("T-9").Visit("T-9", "verify#1", 1).
		Data(map[string]any{"target_id": "AC-01", "target_kind": "scenario", "result": "pass", "rerecorded": false,
			"evidence": []map[string]any{{"file": "evidence/signin.png", "sha256": sha(capture), "bytes": len(capture)}}}).Build()
	h := start(t, config{events: []map[string]any{scenario}})
	cell := filepath.Join(h.root, ".factory/worktrees/T-9")
	results, _ := json.Marshal(map[string]any{"head": "abcdef1", "review_loop": 0,
		"mocks": map[string]any{"MOCK-1": map[string]any{"sha256": m, "file": "mocks/" + m + ".png", "for": "AC-01", "binding": true}},
		"mock_records": map[string]any{"MOCK-1": map[string]any{"result": "differs", "note": "Captured the sign-in screen and set it beside the mock.",
			"differences": []any{"the button is grey, the mock's is blue"}, "capture": []any{"signin.png"}}},
		"records": map[string]any{
			"AC-01":  map[string]any{"kind": "scenario", "result": "pass", "evidence": []map[string]any{{"file": "signin.png", "sha256": sha(capture)}}},
			"MOCK-1": map[string]any{"kind": "design mock", "result": "fail", "evidence": []map[string]any{{"file": "mocks/" + m + ".png", "sha256": m}, {"file": "signin.png", "sha256": sha(capture)}}},
		}})
	writeFile(t, filepath.Join(cell, "evidence/mocks/"+m+".png"), mock)
	writeFile(t, filepath.Join(cell, "evidence/signin.png"), capture)
	writeFile(t, filepath.Join(cell, "evidence/results.json"), results)

	var v map[string]any
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		v = h.get(t, "/api/v1/cells/T-9/evidence")
		if checks, _ := v["checks"].([]any); len(checks) == 2 || time.Now().After(deadline) {
			break
		}
	}
	checks, _ := v["checks"].([]any)
	if len(checks) != 2 {
		t.Fatalf("checks: %v", checks)
	}
	var mk map[string]any
	for _, it := range checks {
		k := it.(map[string]any)
		switch k["target_id"] {
		case "AC-01":
			if k["basis"] != "lifecycle" || k["mock"] != nil {
				t.Errorf("the scenario's check: %v", k)
			}
			if f := k["evidence"].([]any)[0].(map[string]any); f["role"] != nil {
				t.Errorf("a scenario's file carries a mock role: %v", f)
			}
		case "MOCK-1":
			mk = k
		}
	}
	if mk == nil || mk["target_kind"] != "design mock" || mk["result"] != "fail" || mk["basis"] != "results.json" || mk["round"] != float64(1) {
		t.Fatalf("the mock's check: %v", mk)
	}
	files := mk["evidence"].([]any)
	if len(files) != 2 {
		t.Fatalf("files: %v", files)
	}
	approved, shot := files[0].(map[string]any), files[1].(map[string]any)
	if approved["role"] != "approved-mock" || approved["file"] != "evidence/mocks/"+m+".png" || approved["integrity"] != "match" || approved["artifact_id"] == nil {
		t.Fatalf("approved mock: %v", approved)
	}
	if shot["role"] != "capture" || shot["file"] != "evidence/signin.png" || shot["integrity"] != "match" {
		t.Fatalf("capture: %v", shot)
	}
	// Pictures are media: withheld until the project opts in, with the catalogue's reason.
	if approved["content_access"] != "media-disabled" || shot["content_access"] != "media-disabled" {
		t.Fatalf("media access: %v %v", approved["content_access"], shot["content_access"])
	}
	mv := mk["mock"].(map[string]any)
	if mv["compared"] != "differs" || mv["binding"] != true || mv["for"] != "AC-01" || mv["free_text"] != true || mv["free_text_note"] != "free text, not checked for names" {
		t.Fatalf("mock view: %v", mv)
	}
	if d := mv["differences"].([]any); len(d) != 1 || !strings.Contains(d[0].(string), "grey") {
		t.Fatalf("differences: %v", d)
	}
	// The policy names where these words are served.
	s := h.get(t, "/api/v1/session")
	b, _ := json.Marshal(s)
	if !strings.Contains(string(b), "checks[].mock.differences[]") {
		t.Fatalf("display policy does not name the mock's words: %s", b)
	}
}
