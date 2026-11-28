package ingest

import (
	"os"
	"path/filepath"
	"testing"

	"mach/observer/internal/testkit"
)

// M6.6: a cell's lifecycle log that went away because cleanup archived the cell is reported as
// "archived" (finished), not as a lost source; a cell folder removed with no archive stays "ended"
// and Gone, so a client still says it is unavailable.
func TestArchivedCellSourceIsNotLost(t *testing.T) {
	root := testkit.Project(t)
	cell(t, root, "T-1", cellRecords("T-1"))
	cell(t, root, "T-2", cellRecords("T-2"))
	h := newHarness(t, root, filepath.Join(t.TempDir(), "i"), false)
	h.drain()
	testkit.WriteArchive(t, filepath.Join(root, ".factory", "archive", "T-1.tar.gz"), "T-1", map[string][]byte{"lifecycle.jsonl": []byte{}})
	os.RemoveAll(testkit.CellDir(root, "T-1"))
	os.RemoveAll(testkit.CellDir(root, "T-2"))
	h.drain()
	got := map[string]SourceStat{}
	for _, s := range h.o.Stats().Sources {
		got[s.Key] = s
	}
	if s := got["cell/T-1"]; s.State != "archived" || !s.Archived || !s.Gone {
		t.Fatalf("archived cell: %+v", s)
	}
	if s := got["cell/T-2"]; s.State == "archived" || s.Archived || s.Closed || !s.Gone {
		t.Fatalf("cell removed without an archive: %+v", s)
	}
}

// A cell abandoned, which deletes its folder and keeps no archive, is closed by cleanup's run record:
// its log is reported "closed" (finished), never as a lost source.
func TestAbandonedCellSourceIsClosed(t *testing.T) {
	root := testkit.Project(t)
	cell(t, root, "T-3", cellRecords("T-3"))
	h := newHarness(t, root, filepath.Join(t.TempDir(), "i"), false)
	h.drain()
	os.RemoveAll(testkit.CellDir(root, "T-3"))
	runs := filepath.Join(root, ".factory", "archive", "runs.jsonl")
	os.MkdirAll(filepath.Dir(runs), 0o755)
	os.WriteFile(runs, []byte(`{"ticket_id":"T-3","outcome":"abandoned","rounds":3,"closed_at":"2026-11-27T22:08:30+00:00","archive":null}`+"\n"), 0o644)
	h.drain()
	found := false
	for _, s := range h.o.Stats().Sources {
		if s.Key != "cell/T-3" {
			continue
		}
		found = true
		if s.State != "closed" || !s.Closed || s.Archived || !s.Gone {
			t.Fatalf("abandoned cell: %+v", s)
		}
	}
	if !found {
		t.Fatal("no source for the abandoned cell")
	}
}
