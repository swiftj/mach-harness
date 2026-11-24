package ingest

import (
	"os"
	"path/filepath"
	"testing"

	"mach/observer/internal/testkit"
)

// archiveOf packs what is in a cell folder now into a cleanup archive, as cleanup does.
func archiveOf(t *testing.T, root, ticket string) {
	t.Helper()
	dir := testkit.CellDir(root, ticket)
	files := map[string][]byte{}
	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		b, _ := os.ReadFile(p)
		files[filepath.ToSlash(rel)] = b
		return nil
	})
	testkit.WriteArchive(t, filepath.Join(root, ".factory", "archive", ticket+".tar.gz"), ticket, files)
}

func gapsByReason(h *harness) map[string]int {
	out := map[string]int{}
	for _, e := range ofType(h.events(), "history.gap") {
		r, _ := e.Data["reason"].(string)
		out[r]++
	}
	return out
}

// Item 5: the observer read a cell while it was at work and was stopped; cleanup then archived the
// cell and removed its folder; the observer started again. The archive's records up to where the
// live log had been read are the same records, read again: they agree, so no gap of any class.
// Cleanup's own records, written after the observer stopped, are new and are stored.
func TestRestartAfterCleanupWithArchiveMakesNoConflictGaps(t *testing.T) {
	root := testkit.Project(t)
	cell(t, root, "6", cellRecords("6"))
	dir := filepath.Join(t.TempDir(), "i")
	h := newHarness(t, root, dir, false)
	h.drain()
	before := len(h.events())
	h.close()

	// While the observer is down: the ticket is cleaned up, its own records go into the archive.
	testkit.Append(t, testkit.CellLog(root, "6"), testkit.Record{Seq: 7, At: "2026-11-12T10:05:00.000Z", Ticket: "6", Type: "station.entered", Station: "cleanup", Data: map[string]any{"stage": "merged"}}.Line())
	archiveOf(t, root, "6")
	os.RemoveAll(testkit.CellDir(root, "6"))

	h.open(false)
	h.drain()
	if g := gapsByReason(h); g["conflict"] != 0 {
		t.Fatalf("records read again from the archive agree with what was stored, yet: %v", g)
	}
	evs := h.events()
	if len(evs) <= before {
		t.Fatalf("cleanup's record written while the observer was down was not stored: %d then %d", before, len(evs))
	}
	entered := ofType(evs, "station.entered")
	if len(entered) != 3 {
		t.Fatalf("station.entered: %d, want verify, review and cleanup once each", len(entered))
	}
	// Cleanup's record, read only from the archive, names the slice the live cell.json gave.
	if last := entered[len(entered)-1]; last.IDs.Station != "cleanup" || last.IDs.SliceID != "SLICE-009" {
		t.Fatalf("cleanup's record from the archive: station %q slice %q", last.IDs.Station, last.IDs.SliceID)
	}
}

// Item 5: records stored ahead of the committed checkpoint (a tick's events are stored before the
// tick's checkpoint is) are read again from the archive after a restart. Read with the slice the
// archive's cell.json names, they agree with what was stored and make no gap.
func TestArchiveReadsWithTheCellsSliceSoRereadRecordsAgree(t *testing.T) {
	root := testkit.Project(t)
	cell(t, root, "6", cellRecords("6"))
	dir := filepath.Join(t.TempDir(), "i")
	h := newHarness(t, root, dir, false)
	h.drain()
	h.close()
	archiveOf(t, root, "6")
	os.RemoveAll(testkit.CellDir(root, "6"))
	h.open(false)
	// Started again, as if no checkpoint had been committed for the live log.
	src := h.o.sources[cellKey+"6"]
	src.saved, src.suppress = "", 0
	h.drain()
	if g := gapsByReason(h); g["conflict"] != 0 {
		t.Fatalf("the same records read again made conflict gaps: %v", g)
	}
}

// Item 5, with cleanup.archive at its default: no archive at all. A restart neither invents a gap
// nor loses what was stored of the finished ticket.
func TestRestartAfterCleanupWithNoArchiveKeepsHistoryAndMakesNoGaps(t *testing.T) {
	root := testkit.Project(t)
	cell(t, root, "6", cellRecords("6"))
	dir := filepath.Join(t.TempDir(), "i")
	h := newHarness(t, root, dir, false)
	h.drain()
	before := len(h.events())
	gapsBefore := gapsByReason(h)
	h.close()

	os.RemoveAll(testkit.CellDir(root, "6"))
	h.open(false)
	h.drain()
	evs := h.events()
	if len(evs) < before {
		t.Fatalf("stored history shrank: %d then %d", before, len(evs))
	}
	g := gapsByReason(h)
	for r, n := range g {
		if n != gapsBefore[r] {
			t.Fatalf("a restart with no archive made gaps: before %v, after %v", gapsBefore, g)
		}
	}
	if n := len(ofType(evs, "review.verdict_submitted")); n != 1 {
		t.Fatalf("the finished ticket's stored records: verdicts %d", n)
	}
}
