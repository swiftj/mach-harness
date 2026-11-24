package ingest

import (
	"os"
	"path/filepath"
	"testing"

	"mach/observer/internal/testkit"
)

// Item 3: the health reply lists each ticket folder under .factory/worktrees/ with whether it holds
// a lifecycle log and cell.json, so the Factory Floor can say a ticket exists on disk that none of
// its records describe yet, and tell when no station wrote any record for it at all.
func TestCellSourcesSayWhatTheFolderHolds(t *testing.T) {
	root := testkit.Project(t)
	cell(t, root, "5", cellRecords("5"))
	// Ticket 6: a station wrote cell.json but no lifecycle record (its helper could not be loaded).
	testkit.WriteFile(t, filepath.Join(testkit.CellDir(root, "6"), "cell.json"), mustJSON(map[string]any{"stage": "building"}))
	h := newHarness(t, root, "", false)
	h.drain()
	files := func() map[string]CellFiles {
		out := map[string]CellFiles{}
		for _, s := range h.o.Stats().Sources {
			if s.Cell != nil {
				out[s.Cell.Ticket] = *s.Cell
			}
		}
		return out
	}
	got := files()
	if c := got["5"]; !c.Folder || !c.LifecycleLog || !c.CellJSON || c.FirstSeenMS == 0 {
		t.Fatalf("ticket 5: %+v", c)
	}
	if c := got["6"]; !c.Folder || c.LifecycleLog || !c.CellJSON {
		t.Fatalf("ticket 6 (cell.json, no lifecycle log): %+v", c)
	}
	os.RemoveAll(testkit.CellDir(root, "5"))
	h.drain()
	if c := files()["5"]; c.Folder || c.LifecycleLog || c.CellJSON {
		t.Fatalf("ticket 5 after its folder went: %+v", c)
	}
}
