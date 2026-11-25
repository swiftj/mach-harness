package ingest

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"mach/observer/internal/testkit"
)

// A station inside its own visit writes its own state before it records its exit: the merge
// station saves cell.json at "pr-open" as soon as the pull request exists, then posts the
// findings, reads the pull request and merges it (several calls to GitHub, seconds each) before
// it records station.exited. Reproduced with the real merge station and a slow stand-in for gh
// (2.5 s a call): one state-mismatch gap per ticket merged by pull request, the Floor's top bar
// said Partial, and nothing was lost (the log then holds every record). So while the log's
// latest visit is open, cell.json being ahead of it is that station at work, not lost records,
// until it has stayed ahead for openVisitGrace.
func mergeVisit(t *testing.T, root, ticket string) {
	t.Helper()
	dir := testkit.CellDir(root, ticket)
	testkit.WriteFile(t, filepath.Join(dir, "cell.json"), mustJSON(map[string]any{"stage": "pr-open", "created_at": "2026-11-12T09:00:00+00:00"}))
	for _, r := range []testkit.Record{
		{Seq: 1, At: "2026-11-12T10:00:00.000Z", Ticket: ticket, Type: "station.entered", Station: "review", Round: 1, Data: map[string]any{"stage": "verified", "round": 1}},
		{Seq: 2, At: "2026-11-12T10:00:01.000Z", Ticket: ticket, Type: "station.exited", Station: "review", Round: 1, Data: map[string]any{"outcome": "APPROVED", "stage": "approved", "round": 1}},
		{Seq: 3, At: "2026-11-12T10:00:02.000Z", Ticket: ticket, Type: "station.entered", Station: "merge", Data: map[string]any{"stage": "approved", "method": "pr", "behind_main": false}},
	} {
		testkit.Append(t, testkit.CellLog(root, ticket), r.Line())
	}
}

func mismatches(h *harness) int {
	n := 0
	for _, g := range ofType(h.events(), "history.gap") {
		if g.Data["reason"] == "state-mismatch" {
			n++
		}
	}
	return n
}

func TestAStationAheadOfItsOwnOpenVisitIsNoGap(t *testing.T) {
	root := testkit.Project(t)
	mergeVisit(t, root, "6") // a GitHub issue's ticket: a bare number
	// The log was last written a few seconds ago; cell.json just now, by the station in its visit.
	now := time.Now()
	os.Chtimes(testkit.CellLog(root, "6"), now.Add(-5*time.Second), now.Add(-5*time.Second))
	os.Chtimes(filepath.Join(testkit.CellDir(root, "6"), "cell.json"), now, now)
	h := newHarness(t, root, "", false)
	h.drain()
	h.validate()
	if n := mismatches(h); n != 0 {
		t.Fatalf("the merge station at work was reported as %d range(s) of lost history", n)
	}
}

func TestAnOpenVisitLeftBehindItsStationsFileStillSaysRecordsAreMissing(t *testing.T) {
	root := testkit.Project(t)
	mergeVisit(t, root, "6")
	// cell.json moved on long ago and the log never caught up: a record was lost (contract 6.5).
	long := time.Now().Add(-2 * openVisitGrace)
	os.Chtimes(testkit.CellLog(root, "6"), long.Add(-time.Minute), long.Add(-time.Minute))
	os.Chtimes(filepath.Join(testkit.CellDir(root, "6"), "cell.json"), long, long)
	h := newHarness(t, root, "", false)
	h.drain()
	h.validate()
	if n := mismatches(h); n != 1 {
		t.Fatalf("state-mismatch gaps: %d, want 1", n)
	}
}
