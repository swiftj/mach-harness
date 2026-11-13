package ingest

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/store"
	"mach/observer/internal/testkit"
)

// TestLargeVolume ingests well over 200,000 events from all three line sources at once (the
// intake log, 100 cells' lifecycle logs, 40 real belt streams) into a persisted index with the
// default memory window, and reports throughput and memory. It checks the result is complete,
// in order and duplicate-free, that memory stays bounded by the window, not the history, and
// that reading existing history marks nothing late (it is all backfill).
//
// Full size normally; a tenth of it under -short or the race detector (which slows ingest about
// twentyfold), so `go test -race ./...` finishes in reasonable time and still crosses many ticks.
func TestLargeVolume(t *testing.T) {
	intake, cells, visits, streams := 90000, 100, 100, 40
	if testing.Short() || testkit.Race {
		intake, cells, visits, streams = 9000, 20, 50, 8
	}
	root := testkit.Project(t)
	var buf bytes.Buffer
	for i := 1; i <= intake; i++ {
		switch i % 3 {
		case 0:
			buf.Write(v2(i, "dependency.blocked", "intake", fmt.Sprintf("T-%d", i%500), "", map[string]any{"reasons": []any{"waiting for SLICE-000 to be integrated"}}))
		case 1:
			buf.Write(v2(i, "station.observed", "supervisor", fmt.Sprintf("T-%d", i%500), "", map[string]any{"from_stage": "planned", "stage": "building"}))
		default:
			buf.Write(v2(i, "scheduling.decided", "supervisor", "", "", map[string]any{"state": "supervised", "dispatched": []any{}, "started": []any{},
				"held": []any{map[string]any{"ticket_id": fmt.Sprintf("T-%d", i%7), "why": "all 2 place(s) are in use"}}}))
		}
	}
	testkit.WriteFile(t, testkit.LedgerPath(root), buf.Bytes())
	lifecycle := 0
	for c := 0; c < cells; c++ {
		ticket := fmt.Sprintf("C-%03d", c)
		buf.Reset()
		seq := 0
		at := time.Date(2026, 11, 12, 9, 0, 0, 0, time.UTC)
		rec := func(typ, station string, visit int, data map[string]any) {
			seq++
			at = at.Add(37 * time.Millisecond)
			buf.Write(testkit.Record{Seq: seq, At: at.Format("2006-01-02T15:04:05.000Z"), Ticket: ticket, Type: typ, Station: station, Visit: visit, Round: 1, Data: data}.Line())
			lifecycle++
		}
		for v := 1; v <= visits; v++ {
			rec("station.entered", "build", v, map[string]any{"stage": "building", "tasks": 5})
			for k := 0; k < 8; k++ {
				rec("gate.evaluated", "build", v, map[string]any{"gate": "build.green", "outcome": "refuse", "reason_code": "suite-red", "task": "T1"})
			}
			rec("station.exited", "build", v, map[string]any{"outcome": "built", "stage": "built"})
		}
		testkit.WriteFile(t, filepath.Join(testkit.CellDir(root, ticket), "cell.json"), mustJSON(map[string]any{"stage": "built", "created_at": "2026-11-12T09:00:00+00:00"}))
		testkit.WriteFile(t, testkit.CellLog(root, ticket), buf.Bytes())
	}
	belt, _ := os.ReadFile(testkit.StreamFixture("belt-build-verify-review.jsonl"))
	for x := 0; x < streams; x++ {
		dir := testkit.ExecDir(root, fmt.Sprintf("x%012x", x+1))
		testkit.WriteFile(t, filepath.Join(dir, "stream.jsonl"), belt)
		testkit.WriteFile(t, filepath.Join(dir, "started.json"), mustJSON(map[string]any{"started_at": "2023-11-14T22:13:18Z"}))
		testkit.WriteFile(t, filepath.Join(dir, "result.json"), mustJSON(map[string]any{"ended": "exited", "exit_code": 0, "ended_at": "2023-11-14T22:20:00Z", "seconds": 402}))
	}

	dir := filepath.Join(t.TempDir(), "index")
	st, err := store.Open(dir, store.DefaultMaxMemory)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	clock := time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)
	o := New(Options{Root: root, Store: st, NoSettle: true, Now: func() time.Time { return clock }})
	runtime.GC()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	base := ms.HeapAlloc
	var peak uint64
	start := time.Now()
	idle := 0
	ticks := 0
	for idle < 3 {
		clock = clock.Add(200 * time.Millisecond)
		n, err := o.Tick()
		if err != nil {
			t.Fatal(err)
		}
		ticks++
		if n == 0 {
			idle++
		} else {
			idle = 0
		}
		runtime.ReadMemStats(&ms)
		if ms.HeapAlloc > peak {
			peak = ms.HeapAlloc
		}
	}
	elapsed := time.Since(start)
	head := st.Head()
	if head < uint64(intake+lifecycle) {
		t.Fatalf("only %d events from %d intake and %d lifecycle lines", head, intake, lifecycle)
	}
	runtime.GC()
	runtime.ReadMemStats(&ms)
	info := st.Info()
	t.Logf("volume: %d events (%d intake lines, %d lifecycle lines, %d belt streams; race detector %v) in %s over %d ticks: %.0f events/s; heap peak %.1f MiB above baseline, %.1f MiB after GC; index %d segments, %.1f MiB on disk, %d in memory",
		head, intake, lifecycle, streams, testkit.Race, elapsed.Round(time.Millisecond), ticks, float64(head)/elapsed.Seconds(),
		float64(peak-base)/(1<<20), float64(ms.HeapAlloc-min(ms.HeapAlloc, base))/(1<<20), info.Segments, float64(info.DiskBytes)/(1<<20), info.InMemory)
	if info.InMemory != min(int(head), store.DefaultMaxMemory) {
		t.Fatalf("memory window %d", info.InMemory)
	}
	// Complete and duplicate-free, read back across the segments.
	seen := make(map[string]bool, head)
	var pos uint64
	late := 0
	for {
		batch, err := st.After(pos, 10000)
		if err != nil {
			t.Fatal(err)
		}
		if len(batch) == 0 {
			break
		}
		for _, e := range batch {
			if seen[e.Event.ID] {
				t.Fatalf("duplicate %s", e.Event.ID)
			}
			seen[e.Event.ID] = true
			if e.Event.Late {
				late++
			}
			if strings.Contains(string(e.Raw), "/Users/") {
				t.Fatal("a path")
			}
			pos = e.Event.Pos
		}
	}
	if uint64(len(seen)) != head {
		t.Fatalf("%d read back, head %d", len(seen), head)
	}
	st2 := o.Stats()
	t.Logf("volume: %d late, %d backfill", late, st2.Backfill)
	if late != 0 || st2.Late != 0 || uint64(st2.Backfill) != head || st2.CatchingUp {
		t.Fatalf("existing history is backfill, never late: %d late (stats %d), %d backfill of %d, catching up %v", late, st2.Late, st2.Backfill, head, st2.CatchingUp)
	}
}
