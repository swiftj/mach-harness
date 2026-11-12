package ingest

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"mach/observer/internal/store"
	"mach/observer/internal/testkit"
)

// A 100 MB line with no newline for most of its length is skipped and counted, never held whole;
// the lines around it are read; memory does not grow with it.
func TestHundredMegabyteLine(t *testing.T) {
	root := testkit.Project(t)
	f, err := os.Create(testkit.LedgerPath(root))
	if err != nil {
		t.Fatal(err)
	}
	f.Write(v2(1, "intake.validated", "intake", "", "", map[string]any{"digest": "ab"}))
	chunk := bytes.Repeat([]byte(`{"x":"aaaaaaaaaaaaaaaa`), 1<<15) // 720 KiB
	for written := 0; written < 100<<20; written += len(chunk) {
		f.Write(chunk)
	}
	f.Write([]byte("\n"))
	f.Write(v2(3, "human.required", "intake", "T-1", "", map[string]any{"reason": "after the long line"}))
	f.Close()
	runtime.GC()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	base := ms.HeapAlloc
	h := newHarness(t, root, "", false)
	var peak uint64
	for i := 0; i < 60 && h.st.Head() < 2; i++ {
		h.tick()
		runtime.ReadMemStats(&ms)
		peak = max(peak, ms.HeapAlloc)
	}
	h.drain()
	evs := h.events()
	if len(ofType(evs, "intake.validated")) != 1 || len(ofType(evs, "human.required")) != 1 {
		t.Fatalf("the lines around the long one: %v", kinds(evs))
	}
	var oversized int64
	for _, s := range h.o.Stats().Sources {
		if s.Key == LedgerKey {
			oversized = s.Oversized
		}
	}
	if oversized != 1 {
		t.Fatalf("oversized %d", oversized)
	}
	if grew := peak - min(peak, base); grew > 48<<20 {
		t.Fatalf("reading past a 100 MB line held %d MiB", grew>>20)
	}
}

// A lifecycle log written while it is being read, in pieces that tear lines at every point: every
// line is read exactly once, in order, with nothing invented.
func TestFileGrowingWhileRead(t *testing.T) {
	root := testkit.Project(t)
	testkit.WriteFile(t, filepath.Join(testkit.CellDir(root, "T-1"), "cell.json"), mustJSON(map[string]any{"stage": "building"}))
	path := testkit.CellLog(root, "T-1")
	testkit.WriteFile(t, path, nil)
	h := newHarness(t, root, "", false)
	const lines = 3000
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			t.Error(err)
			return
		}
		defer f.Close()
		for i := 1; i <= lines; i++ {
			line := testkit.Record{Seq: i, At: time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC).Add(time.Duration(i) * time.Millisecond).Format("2006-01-02T15:04:05.000Z"),
				Ticket: "T-1", Type: "gate.evaluated", Station: "build", Visit: 1, Round: 1, Data: map[string]any{"gate": "build.start", "outcome": "pass"}}.Line()
			cut := i % len(line)
			f.Write(line[:cut]) // a torn line the reader may see
			f.Write(line[cut:])
			if i%150 == 0 {
				time.Sleep(time.Millisecond)
			}
		}
	}()
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	for running := true; running; {
		select {
		case <-done:
			running = false
		default:
			h.tick()
		}
	}
	h.drain()
	evs := ofType(h.events(), "gate.evaluated")
	if len(evs) != lines {
		t.Fatalf("%d of %d lines read", len(evs), lines)
	}
	for i, e := range evs {
		if e.Origin.Seq != int64(i+1) {
			t.Fatalf("line %d read as %d", i+1, e.Origin.Seq)
		}
	}
	if gaps := ofType(h.events(), "history.gap"); len(gaps) != 0 {
		t.Fatalf("gaps invented: %+v", gaps[0].Data)
	}
	h.validate()
}

// .factory created after the observer started: it is picked up on the next tick, and what it
// holds was written while the observer watched, so it is live (not backfill).
func TestFactoryAppearsAfterStart(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	st, err := store.Open("", 1000)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)
	o := New(Options{Root: root, Store: st, NoSettle: true, Now: func() time.Time { return now }})
	for i := 0; i < 3; i++ {
		now = now.Add(200 * time.Millisecond)
		o.Tick()
	}
	if s := o.Stats(); s.FactoryFound || s.CatchingUp || st.Head() != 0 {
		t.Fatalf("no Factory: %+v", s)
	}
	testkit.WriteFile(t, testkit.LedgerPath(root), append(v2(1, "intake.validated", "intake", "", "", map[string]any{"digest": "ab"}),
		v2(2, "human.required", "intake", "T-1", "", map[string]any{"reason": "a person"})...))
	for i := 0; i < 3; i++ {
		now = now.Add(200 * time.Millisecond)
		o.Tick()
	}
	if st.Head() != 2 || !o.Stats().FactoryFound {
		t.Fatalf("head %d", st.Head())
	}
	entries, _ := st.After(0, 10)
	for _, e := range entries {
		if e.Event.Provenance != nil || e.Event.Late {
			t.Fatalf("written while watched, read as backfill or late: %+v", e.Event.Provenance)
		}
	}
	if _, err := os.Lstat(filepath.Join(root, ".factory", "local")); err == nil {
		t.Fatal("ingest created a folder")
	}
}
