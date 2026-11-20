package normalize

import (
	"encoding/json"
	"testing"
	"time"

	"mach/observer/internal/redact"
)

// M12: review.scan_recorded is a known lifecycle kind, not a gap. Only booleans and counts are kept: a file name, a
// package name or a preview that reached the line is withheld.
func TestScanRecordedIsAKnownKindWithCountsOnly(t *testing.T) {
	data := map[string]any{"round": 1, "enabled": true, "flagged": true, "panel_raised": true, "secret_candidates": 2, "real": 1,
		"not_a_secret": 1, "overridden_by_builder": 0, "dependencies": 3, "dependencies_added": 2, "acceptable": 2, "concerns": 1,
		"lockfile_only": -4, "file": "app/settings.py", "package": "left-pad"}
	b, _ := json.Marshal(map[string]any{"v": 1, "seq": 20, "at": "2026-11-20T10:00:00.000Z", "ticket_id": "T-1", "type": "review.scan_recorded",
		"station": "review", "visit": "review#1", "round": 1, "execution_id": nil, "data": data})
	now := time.Date(2026, 11, 20, 11, 0, 0, 0, time.UTC)
	var found bool
	for _, e := range NewLifecycle("T-1", "g", "/work/p", NewIdentity()).Line(b, Read{Line: 1, At: now}) {
		if e.Type == "history.gap" {
			t.Fatalf("the kind was read as a gap: %v", e.Data)
		}
		if e.Type != "review.scan_recorded" {
			continue
		}
		found = true
		if !redact.Enforce(e, nil) {
			t.Fatalf("refused by the allowlist: %v", e.Data)
		}
		got, _ := json.Marshal(e.Data)
		want := `{"acceptable":2,"concerns":1,"dependencies":3,"dependencies_added":2,"enabled":true,"flagged":true,"lockfile_only":null,` +
			`"not_a_secret":1,"overridden_by_builder":0,"panel_raised":true,"real":1,"secret_candidates":2}`
		if string(got) != want {
			t.Fatalf("data %s, want %s", got, want)
		}
		if e.Withheld < 2 {
			t.Fatalf("the file and the package are withheld, not kept: withheld %d", e.Withheld)
		}
	}
	if !found {
		t.Fatal("no review.scan_recorded event")
	}
}
