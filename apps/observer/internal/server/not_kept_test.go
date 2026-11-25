package server

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// cleanup.archive: once a ticket is cleaned up with no archive kept, its evidence and its lanes say
// so, with the run record's reason: never an error, never an empty panel with nothing said.

const notKeptWords = `The evidence files were not kept after cleanup: cleanup.archive is "raised" and no person decided anything on this ticket.`

func TestEvidenceOfATicketWithNoArchiveKept(t *testing.T) {
	h := start(t, config{events: laneEvents()})
	writeFile(t, filepath.Join(h.root, ".factory/archive/runs.jsonl"), []byte(
		`{"record_version":2,"ticket_id":"T-3","outcome":"abandoned","archive":null,"raised_to_person":[],`+
			`"archive_kept":{"kept":false,"setting":"raised","chosen_by":"setting","published":null,"reason":"The evidence files were not kept after cleanup: cleanup.archive is \"raised\" and no person decided anything on this ticket."}}`+"\n"))
	v := h.get(t, "/api/v1/cells/T-3/evidence")
	nk, ok := v["not_kept"].(map[string]any)
	if !ok {
		t.Fatalf("no not_kept: %v", v)
	}
	if nk["reason"] != notKeptWords || nk["setting"] != "raised" || nk["chosen_by"] != "setting" || nk["archive"] != nil || nk["outcome"] != "abandoned" ||
		!reflect.DeepEqual(nk["raised_to_person"], []any{}) {
		t.Errorf("not_kept: %v", nk)
	}
	if a, _ := v["artifacts"].([]any); len(a) != 0 {
		t.Errorf("artifacts: %v", a)
	}
	// The lanes of the build, read from nowhere: said the same way.
	d, _ := cellWith(t, h, "T-3")
	l := lanesOfReply(t, d)
	if l["state"] != "not-kept" || l["source"] != "none" || l["not_kept"].(map[string]any)["reason"] != notKeptWords {
		t.Errorf("lanes: %v", l)
	}
}

func TestEvidenceOfALiveCellHasNoNotKept(t *testing.T) {
	h := start(t, config{events: laneEvents()})
	openLanesCell(t, h.root)
	writeFile(t, filepath.Join(h.root, ".factory/archive/runs.jsonl"), []byte(`{"ticket_id":"T-3","outcome":"merged","archive":null}`+"\n"))
	v := h.get(t, "/api/v1/cells/T-3/evidence")
	if v["not_kept"] != nil {
		t.Errorf("a live cell said not kept: %v", v["not_kept"])
	}
	if _, err := os.Stat(filepath.Join(h.root, ".factory/worktrees/T-3")); err != nil {
		t.Fatal(err)
	}
	d, _ := cellWith(t, h, "T-3")
	if l := lanesOfReply(t, d); l["state"] == "not-kept" {
		t.Errorf("a live cell's lanes: %v", l)
	}
}
