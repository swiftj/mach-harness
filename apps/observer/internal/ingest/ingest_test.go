package ingest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mach/observer/internal/store"
	"mach/observer/internal/testkit"
)

func open(t *testing.T, dir string) *store.Store {
	t.Helper()
	s, err := store.Open(dir, 1000)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func tick(t *testing.T, o *Observer) int {
	t.Helper()
	n, err := o.Tick()
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func types(t *testing.T, s *store.Store, after uint64) []string {
	t.Helper()
	entries, err := s.After(after, 1000)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		out = append(out, e.Event.Type)
	}
	return out
}

func TestLedgerAndCellsMergeAndNewCellAppears(t *testing.T) {
	root := testkit.Project(t)
	s := open(t, "")
	o := New(Options{Root: root, Store: s})
	testkit.Append(t, testkit.LedgerPath(root), testkit.LedgerLine(1, "wave.discovered", "", map[string]any{"slices": []string{"SLICE-001"}}))
	if n := tick(t, o); n != 1 {
		t.Fatalf("added %d", n)
	}
	testkit.Append(t, testkit.CellLog(root, "T-1"), testkit.LifecycleLine("T-1", 1, "station.entered", "build", map[string]any{"stage": "building"}))
	testkit.Append(t, testkit.LedgerPath(root), testkit.LedgerLine(2, "work.claimed", "T-1", map[string]any{"stage": "planned", "attempt": 1}))
	if n := tick(t, o); n != 2 {
		t.Fatalf("a new cell and a ledger line: added %d", n)
	}
	got := types(t, s, 0)
	if len(got) != 3 || got[0] != "wave.discovered" || got[1] != "work.claimed" || got[2] != "station.entered" {
		t.Fatalf("merged order (ledger first within a tick): %v", got)
	}
	if n := tick(t, o); n != 0 {
		t.Fatalf("nothing new, added %d", n)
	}
}

func TestRestartResumesWithoutDuplicates(t *testing.T) {
	root := testkit.Project(t)
	index := filepath.Join(root, ".factory/local/observer/index")
	s := open(t, index)
	o := New(Options{Root: root, Store: s})
	testkit.Append(t, testkit.LedgerPath(root), append(testkit.LedgerLine(1, "work.claimed", "T-1", nil), testkit.LedgerLine(2, "execution.started", "T-1", nil)...))
	testkit.Append(t, testkit.CellLog(root, "T-1"), testkit.LifecycleLine("T-1", 1, "station.entered", "build", nil))
	tick(t, o)
	gen := s.Generation()
	s.Close()

	testkit.Append(t, testkit.LedgerPath(root), testkit.LedgerLine(3, "station.observed", "T-1", nil))
	testkit.Append(t, testkit.CellLog(root, "T-1"), testkit.LifecycleLine("T-1", 2, "station.exited", "build", nil))

	s2 := open(t, index)
	defer s2.Close()
	if s2.Generation() != gen {
		t.Fatal("a restart keeps the generation")
	}
	o2 := New(Options{Root: root, Store: s2})
	if n := tick(t, o2); n != 2 {
		t.Fatalf("after restart only the two new lines are added, got %d", n)
	}
	if _, head := s2.Bounds(); head != 5 {
		t.Fatalf("head %d", head)
	}
	if got := types(t, s2, 3); got[0] != "station.observed" || got[1] != "station.exited" {
		t.Fatalf("%v", got)
	}
}

func TestCrashBetweenLogAndCheckpointsRepeatsNothing(t *testing.T) {
	root := testkit.Project(t)
	index := filepath.Join(root, ".factory/local/observer/index")
	s := open(t, index)
	o := New(Options{Root: root, Store: s})
	testkit.Append(t, testkit.LedgerPath(root), testkit.LedgerLine(1, "work.claimed", "T-1", nil))
	tick(t, o)
	stale, err := os.ReadFile(filepath.Join(index, "checkpoints.json"))
	if err != nil {
		t.Fatal(err)
	}
	testkit.Append(t, testkit.LedgerPath(root), testkit.LedgerLine(2, "execution.started", "T-1", nil))
	tick(t, o)
	s.Close()
	// The crash: events.log has line 2, the checkpoints were never moved past line 1.
	if err := os.WriteFile(filepath.Join(index, "checkpoints.json"), stale, 0o600); err != nil {
		t.Fatal(err)
	}
	s2 := open(t, index)
	defer s2.Close()
	o2 := New(Options{Root: root, Store: s2})
	if n := tick(t, o2); n != 0 {
		t.Fatalf("the re-read line must be dropped by its ID, added %d", n)
	}
	if _, head := s2.Bounds(); head != 2 || s2.Info().Duplicates != 1 {
		t.Fatalf("head %d duplicates %d", head, s2.Info().Duplicates)
	}
}

func TestTruncatedAndRewrittenLedgerIsDeduplicated(t *testing.T) {
	root := testkit.Project(t)
	s := open(t, "")
	o := New(Options{Root: root, Store: s})
	content := append(testkit.LedgerLine(1, "work.claimed", "T-1", nil), testkit.LedgerLine(2, "execution.started", "T-1", nil)...)
	testkit.Append(t, testkit.LedgerPath(root), content)
	tick(t, o)
	// Something rewrote the log: shorter, same history, then one new line.
	os.WriteFile(testkit.LedgerPath(root), testkit.LedgerLine(1, "work.claimed", "T-1", nil), 0o644)
	tick(t, o)
	testkit.Append(t, testkit.LedgerPath(root), testkit.LedgerLine(2, "execution.started", "T-1", nil))
	testkit.Append(t, testkit.LedgerPath(root), testkit.LedgerLine(3, "execution.completed", "T-1", nil))
	tick(t, o)
	got := types(t, s, 0)
	want := []string{"work.claimed", "execution.started", "history.gap", "execution.completed"}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
}

func TestSequenceGapIsReported(t *testing.T) {
	root := testkit.Project(t)
	s := open(t, "")
	o := New(Options{Root: root, Store: s})
	// MACH's torn-line failure (M6_0_TELEMETRY_GAPS 2.1): line 2 was cut by a crash and line 3 was
	// appended onto it, so both are one unreadable line. Line 4 is whole.
	torn := append(testkit.LedgerLine(1, "work.claimed", "T-1", nil), []byte(`{"schema_version":2,"seq":2,"at`)...)
	torn = append(torn, testkit.LedgerLine(3, "execution.started", "T-1", nil)...)
	testkit.Append(t, testkit.LedgerPath(root), append(torn, testkit.LedgerLine(4, "execution.completed", "T-1", nil)...))
	tick(t, o)
	entries, _ := s.After(0, 10)
	if len(entries) != 3 || entries[1].Event.Type != "history.gap" || entries[1].Event.Authority != "reconstructed" {
		t.Fatalf("%v", types(t, s, 0))
	}
	d := entries[1].Event.Data
	if d["from_seq"] != int64(2) || d["to_seq"] != int64(3) || d["count"] != int64(2) || d["reason"] != "sequence" {
		t.Fatalf("gap %v", d)
	}
	if !strings.HasPrefix(entries[1].Event.ID, "o:gap:i:") || !strings.HasPrefix(entries[2].Event.ID, "i:") {
		t.Fatalf("ids %s %s", entries[1].Event.ID, entries[2].Event.ID)
	}
	if o.Stats().Sources[0].Refused != 1 {
		t.Fatal("the unreadable line is counted")
	}
}

func TestForeignTicketLineRefusedAndCellGone(t *testing.T) {
	root := testkit.Project(t)
	s := open(t, "")
	o := New(Options{Root: root, Store: s})
	testkit.Append(t, testkit.CellLog(root, "T-1"), testkit.LifecycleLine("T-2", 1, "station.entered", "build", nil))
	testkit.Append(t, testkit.CellLog(root, "T-1"), testkit.LifecycleLine("T-1", 1, "station.entered", "build", nil))
	tick(t, o)
	if got := types(t, s, 0); len(got) != 1 {
		t.Fatalf("one cell cannot speak for another: %v", got)
	}
	os.RemoveAll(filepath.Join(root, ".factory/worktrees/T-1"))
	tick(t, o)
	tick(t, o)
	if _, head := s.Bounds(); head != 1 {
		t.Fatal("a vanished cell is source state, not history")
	}
	for _, src := range o.Stats().Sources {
		if src.Key == "cell/T-1" && (!src.Gone || src.Refused != 1) {
			t.Fatalf("%+v", src)
		}
	}
}

func TestLinkedCellFolderIsIgnored(t *testing.T) {
	root := testkit.Project(t)
	outside := t.TempDir()
	testkit.Append(t, filepath.Join(outside, "lifecycle.jsonl"), testkit.LifecycleLine("T-9", 1, "station.entered", "build", nil))
	if err := os.Symlink(outside, filepath.Join(root, ".factory/worktrees/T-9")); err != nil {
		t.Fatal(err)
	}
	s := open(t, "")
	o := New(Options{Root: root, Store: s})
	tick(t, o)
	if _, head := s.Bounds(); head != 0 {
		t.Fatal("a linked cell folder was followed")
	}
}

func TestLifecycleNullSeqAndRepeatedLines(t *testing.T) {
	root := testkit.Project(t)
	s := open(t, "")
	o := New(Options{Root: root, Store: s})
	log := testkit.CellLog(root, "T-1")
	testkit.Append(t, log, testkit.LifecycleLine("T-1", 1, "station.entered", "build", nil))
	testkit.Append(t, log, testkit.LifecycleLine("T-1", 0, "gate.evaluated", "build", map[string]any{"gate": "build.start", "outcome": "pass"}))
	testkit.Append(t, log, testkit.LifecycleLine("T-1", 3, "station.exited", "build", map[string]any{"outcome": "built"}))
	tick(t, o)
	entries, _ := s.After(0, 10)
	if len(entries) != 4 || entries[1].Event.ID == entries[0].Event.ID {
		t.Fatalf("%v", types(t, s, 0))
	}
	// Records 1, (null), 3: the jump from 1 to 3 is a gap of one; the null record has its own line.
	if entries[2].Event.Type != "history.gap" || entries[2].Event.Data["from_seq"] != int64(2) {
		t.Fatalf("%v", types(t, s, 0))
	}
	if !strings.HasSuffix(entries[1].Event.ID, ":2") || !strings.HasSuffix(entries[3].Event.ID, ":3") {
		t.Fatalf("lifecycle ids are by physical line: %s %s", entries[1].Event.ID, entries[3].Event.ID)
	}
	// The file is cut back to its first line and the same lines are written again: nothing repeats.
	data, _ := os.ReadFile(log)
	first := data[:len(testkit.LifecycleLine("T-1", 1, "station.entered", "build", nil))]
	os.WriteFile(log, first, 0o644)
	tick(t, o)
	os.WriteFile(log, data, 0o644)
	tick(t, o)
	if got := types(t, s, 4); len(got) != 1 || got[0] != "history.gap" {
		t.Fatalf("after a truncation only the truncation is reported: %v", got)
	}
}
