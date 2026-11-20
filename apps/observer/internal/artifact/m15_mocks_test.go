package artifact

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

// mockResults is results.json as verify.py leaves it after start and compare with one binding mock
// (MOCK-1, differs) and one that could not be compared (MOCK-2), M14 part C.
func mockResults(mock, capture []byte, extra map[string]any) []byte {
	m := sum(mock)
	r := map[string]any{"head": "abcdef1", "review_loop": 0,
		"mocks": map[string]any{
			"MOCK-1": map[string]any{"sha256": m, "file": "mocks/" + m + ".png", "for": "AC-01", "binding": true, "note": "the sign-in screen"},
			"MOCK-2": map[string]any{"sha256": m, "file": "mocks/" + m + ".png", "for": nil, "binding": false},
			"MOCK-9": map[string]any{"sha256": m, "file": "../" + m + ".png", "binding": false}, // not verify.py's copy: never listed
		},
		"mock_records": map[string]any{
			"MOCK-1": map[string]any{"result": "differs", "note": "Captured the sign-in screen at 1280 wide and set it beside the mock.",
				"differences": []any{"the button is grey, the mock's is blue", "token: sk-ant-abcdefghijklmnopqrstuvwxyz"}, "capture": []any{"signin.png"}},
			"MOCK-2": map[string]any{"result": "cannot compare", "note": "The screen needs a sign-in the verifier does not have.", "differences": []any{}, "capture": []any{}},
		},
		"records": map[string]any{
			"MOCK-1": map[string]any{"kind": "design mock", "result": "fail", "evidence": []map[string]any{
				{"file": "mocks/" + m + ".png", "sha256": m}, {"file": "signin.png", "sha256": sum(capture)}}},
			"MOCK-2": map[string]any{"kind": "design mock", "result": "pass", "evidence": []map[string]any{}},
			"AC-01":  map[string]any{"kind": "scenario", "result": "pass", "evidence": []map[string]any{{"file": "signin.png", "sha256": sum(capture)}}},
		}}
	for k, v := range extra {
		r[k] = v
	}
	b, _ := json.Marshal(r)
	return b
}

// The approved mock and the capture are both catalogued under the check that cites them, each marked
// for what it is, with the recorded result and the binding flag. The verifier's words come with the
// run's mock records, scrubbed; nothing is compared.
func TestDesignMocksAreCataloguedSideBySide(t *testing.T) {
	f := project(t, nil)
	mock := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{7}, 40)...)
	capture := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{9}, 40)...)
	write(t, filepath.Join(f.cell, "evidence/mocks/"+sum(mock)+".png"), mock)
	write(t, filepath.Join(f.cell, "evidence/signin.png"), capture)
	write(t, filepath.Join(f.cell, "evidence/results.json"), mockResults(mock, capture, nil))
	got := byPath(New(f.root))
	copyEntry, shot := got["cell:evidence/mocks/"+sum(mock)+".png"], got["cell:evidence/signin.png"]
	if copyEntry.ID == "" || shot.ID == "" {
		t.Fatalf("not catalogued: mock %+v, capture %+v", copyEntry, shot)
	}
	roles := func(e Entry) map[string]Target {
		out := map[string]Target{}
		for _, t := range e.Targets {
			out[t.ID] = t
		}
		return out
	}
	m, c := roles(copyEntry)["MOCK-1"], roles(shot)["MOCK-1"]
	if m.Role != RoleApprovedMock || m.Compared != "differs" || m.Binding == nil || !*m.Binding || m.Kind != "design mock" || m.Result != "fail" {
		t.Fatalf("the mock copy: %+v", m)
	}
	if c.Role != RoleCapture || c.Compared != "differs" {
		t.Fatalf("the capture: %+v", c)
	}
	// The same capture proves a scenario too: there it carries no mock role.
	if ac := roles(shot)["AC-01"]; ac.Role != "" || ac.Compared != "" || ac.Binding != nil {
		t.Fatalf("a scenario's target took mock fields: %+v", ac)
	}
	if copyEntry.Integrity != "match" || copyEntry.ContentAccess != "media-disabled" {
		t.Fatalf("the mock copy is media like any picture: %s %s", copyEntry.Integrity, copyEntry.ContentAccess)
	}
	mocks := got["cell:evidence/results.json"].Mocks()
	if len(mocks) != 2 || mocks[0].ID != "MOCK-1" || mocks[1].ID != "MOCK-2" {
		t.Fatalf("mock records: %+v", mocks)
	}
	one, two := mocks[0], mocks[1]
	if one.Compared != "differs" || one.For != "AC-01" || len(one.Captures) != 1 || one.Captures[0] != "signin.png" || one.Result != "fail" || len(one.Differences) != 2 {
		t.Fatalf("MOCK-1: %+v", one)
	}
	if strings.Contains(strings.Join(one.Differences, " "), "sk-ant-") {
		t.Fatalf("a credential passed in the verifier's words: %v", one.Differences)
	}
	if two.Compared != "cannot compare" || two.Binding == nil || *two.Binding || two.For != "" || len(two.Captures) != 0 || two.Note == "" {
		t.Fatalf("MOCK-2: %+v", two)
	}
	// A run without mocks has none (every earlier verification).
	if m := byPath(New(project(t, nil).root))["cell:evidence/results.json"].Mocks(); m != nil {
		t.Fatalf("a run without mocks: %+v", m)
	}
}

// A result verify.py does not write (a later MACH's) is not passed on: the record reads as not compared.
func TestAnUnknownMockResultIsNotPassedOn(t *testing.T) {
	f := project(t, nil)
	mock := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{7}, 40)...)
	capture := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{9}, 40)...)
	res := mockResults(mock, capture, nil)
	res = bytes.Replace(res, []byte(`"result":"differs"`), []byte(`"result":"looks-similar"`), 1)
	write(t, filepath.Join(f.cell, "evidence/results.json"), res)
	mocks := byPath(New(f.root))["cell:evidence/results.json"].Mocks()
	if len(mocks) != 2 || mocks[0].Compared != "" {
		t.Fatalf("unknown result: %+v", mocks)
	}
}

func TestALandedOverlapVoidHasItsOwnCode(t *testing.T) {
	f := project(t, nil)
	write(t, filepath.Join(f.cell, "review/round-1/decision.json"), []byte(`{"round":1,"outcome":"VOID","head":"fc3ca1f70388",
"void":{"reason":"Work that landed on the main branch after approval touches the same ground as this ticket.","approved_commit":"fc3ca1f70388","branch_commit":"0a1b2c3d4e5f","by":"merge station","findings_path":"/x/review/merge-recheck.md","landed_files":["README.md"]},
"outcome_before_void":"APPROVED"}`))
	v := byPath(New(f.root))["cell:review/round-1/decision.json"].Voided
	if v == nil || v.ReasonCode != "landed-overlap" || v.OutcomeBefore != "APPROVED" {
		t.Fatalf("voided %+v", v)
	}
}
