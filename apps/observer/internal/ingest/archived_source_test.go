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
	if s := got["cell/T-2"]; s.State == "archived" || s.Archived || !s.Gone {
		t.Fatalf("cell removed without an archive: %+v", s)
	}
}
