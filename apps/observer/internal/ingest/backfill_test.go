package ingest

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"mach/observer/internal/testkit"
)

// lifecycleAt writes one lifecycle line for ticket at the given time.
func lifecycleAt(t *testing.T, root, ticket string, seq int, at string) {
	t.Helper()
	testkit.Append(t, testkit.CellLog(root, ticket), testkit.Record{Seq: seq, At: at, Ticket: ticket, Type: "gate.evaluated", Station: "build", Round: 1,
		Data: map[string]any{"gate": "build.start", "outcome": "pass"}}.Line())
}

// `late` means "read live, after the observer had already delivered past its place". History
// that was on disk before the observer started is backfill: it arrives in read order by nature,
// is never late, and says so in its provenance. A first read of real history flagged 174,003 of
// 254,479 events late before this rule.
func TestBackfillIsNeverLate(t *testing.T) {
	root := testkit.Project(t)
	// Before the observer starts: a ledger stamped at 10:00 and three cells whose logs are older
	// (09:xx), read after the ledger, so in delivery order they sort before what is delivered.
	testkit.Append(t, testkit.LedgerPath(root), v2(1, "intake.validated", "intake", "", "", map[string]any{"digest": "ab"}))
	for c := 1; c <= 3; c++ {
		ticket := fmt.Sprintf("T-%d", c)
		testkit.WriteFile(t, filepath.Join(testkit.CellDir(root, ticket), "cell.json"), mustJSON(map[string]any{"stage": "building", "created_at": "2026-11-12T09:00:00+00:00"}))
		for i := 1; i <= 5; i++ {
			lifecycleAt(t, root, ticket, i, fmt.Sprintf("2026-11-12T09:%02d:%02d.000Z", c, i))
		}
	}
	dir := filepath.Join(t.TempDir(), "index")
	h := newHarness(t, root, dir, true)
	h.drain()
	evs := h.events()
	if len(evs) != 16 {
		t.Fatalf("%d events", len(evs))
	}
	for _, e := range evs {
		if e.Late {
			t.Fatalf("backfill marked late: %s", e.ID)
		}
		if e.Provenance == nil || e.Provenance.Rule != "backfill" {
			t.Fatalf("backfill is not recorded in provenance: %s %+v", e.ID, e.Provenance)
		}
	}
	st := h.o.Stats()
	if st.CatchingUp || st.Backfill != 16 || st.Late != 0 {
		t.Fatalf("stats: catching up %v, backfill %d, late %d", st.CatchingUp, st.Backfill, st.Late)
	}

	// Live: a line written now but stamped before what was delivered is late; one stamped after
	// is not; neither is backfill.
	lifecycleAt(t, root, "T-1", 6, "2026-11-12T09:30:00.000Z")
	lifecycleAt(t, root, "T-2", 6, "2026-11-12T11:00:00.000Z")
	// A cell that appears while the observer runs: everything in it was written live.
	testkit.WriteFile(t, filepath.Join(testkit.CellDir(root, "T-9"), "cell.json"), mustJSON(map[string]any{"stage": "building", "created_at": "2026-11-12T09:00:00+00:00"}))
	lifecycleAt(t, root, "T-9", 1, "2026-11-12T09:59:00.000Z")
	h.drain()
	for _, e := range h.events()[16:] {
		if e.Provenance != nil {
			t.Fatalf("a live event carries provenance: %s %+v", e.ID, e.Provenance)
		}
	}
	late := 0
	for _, e := range h.events()[16:] {
		if e.Late {
			late++
		}
		switch e.IDs.TicketID {
		case "T-1", "T-9":
			if !e.Late {
				t.Fatalf("live and older than what was delivered, not late: %s", e.ID)
			}
		case "T-2":
			if e.Late {
				t.Fatalf("live and newest, marked late: %s", e.ID)
			}
		}
	}
	if late != 2 || h.o.Stats().Late != 2 {
		t.Fatalf("late %d (stats %d)", late, h.o.Stats().Late)
	}

	// Written while the observer was stopped: on restart it is catch-up again, so backfill.
	h.close()
	lifecycleAt(t, root, "T-3", 6, "2026-11-12T09:03:30.000Z")
	h.open(true)
	h.drain()
	all := h.events()
	last := all[len(all)-1]
	if last.IDs.TicketID != "T-3" || last.Late || last.Provenance == nil || last.Provenance.Rule != "backfill" {
		t.Fatalf("a line written while the observer was down is backfill: %+v %+v", last.IDs, last.Provenance)
	}
	h.validate()
}

// /health's freshness needs each source's size and when it was last read: lag_bytes is size -
// offset, and a source a busy tick did not reach shows an older read time than the tick.
func TestSourceStatsReportSizeAndReadTime(t *testing.T) {
	root := testkit.Project(t)
	var ledger []byte
	const budget = 50
	for i := 1; i <= 2*budget; i++ {
		ledger = append(ledger, v2(i, "intake.validated", "intake", "", "", map[string]any{"digest": "ab"})...)
	}
	testkit.WriteFile(t, testkit.LedgerPath(root), ledger)
	testkit.WriteFile(t, filepath.Join(testkit.CellDir(root, "T-1"), "cell.json"), mustJSON(map[string]any{"stage": "building"}))
	lifecycleAt(t, root, "T-1", 1, "2026-11-12T09:00:00.000Z")
	h := newHarness(t, root, "", false)
	h.o.opts.TickBudget = budget
	stat := func(key string) SourceStat {
		for _, s := range h.o.Stats().Sources {
			if s.Key == key {
				return s
			}
		}
		t.Fatalf("no source %s in %+v", key, h.o.Stats().Sources)
		return SourceStat{}
	}
	h.tick() // the ledger's backlog fills the tick's budget; the cell is not reached
	if s := stat(LedgerKey); s.Size == nil || *s.Size != int64(len(ledger)) || s.LastReadAt == "" {
		t.Fatalf("ledger mid-backlog: %+v", s)
	}
	if s := stat(cellKey + "T-1"); s.LastReadAt != "" || s.Size != nil {
		t.Fatalf("a source the tick did not reach reports a read: %+v", s)
	}
	if !h.o.Stats().CatchingUp {
		t.Fatal("not caught up while the ledger is still being read")
	}
	h.drain()
	s := stat(LedgerKey)
	if *s.Size != s.Offset {
		t.Fatalf("drained, lag %d", *s.Size-s.Offset)
	}
	cellRead := stat(cellKey + "T-1").LastReadAt
	if cellRead == "" || stat(cellKey+"T-1").Size == nil || h.o.Stats().CatchingUp {
		t.Fatalf("cell after drain: %+v", stat(cellKey+"T-1"))
	}
	// Growth not yet read shows as lag on the next read; a removed file has no size.
	testkit.Append(t, testkit.LedgerPath(root), v2(2*budget+1, "intake.validated", "intake", "", "", map[string]any{"digest": "ab"}))
	if s := stat(LedgerKey); *s.Size != s.Offset {
		t.Fatal("stats changed without a read")
	}
	os.RemoveAll(testkit.CellDir(root, "T-1"))
	h.tick()
	if s := stat(cellKey + "T-1"); s.Size != nil || s.LastReadAt != cellRead {
		t.Fatalf("a removed cell: %+v", s)
	}
}
