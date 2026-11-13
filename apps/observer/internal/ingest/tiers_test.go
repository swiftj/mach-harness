package ingest

import (
	"testing"
	"time"

	"mach/observer/internal/store"
	"mach/observer/internal/testkit"
)

// tieredHarness is newHarness with the polling tiers the observer runs with (scaled down: hot for
// 10 s after a change, cold sources every 1 s) and the adaptive settle.
func tieredHarness(t *testing.T, root string) *harness {
	t.Helper()
	h := &harness{t: t, root: root, now: time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)}
	st, err := store.Open("", 1_000_000)
	if err != nil {
		t.Fatal(err)
	}
	h.st = st
	h.o = New(Options{Root: root, Store: st, Now: func() time.Time { return h.now }, HotFor: 10 * time.Second, ColdEvery: time.Second})
	return h
}

func lifecycleCount(h *harness, ticket string) int {
	n := 0
	for _, e := range h.events() {
		if e.IDs.TicketID == ticket && e.Type == "station.entered" {
			n++
		}
	}
	return n
}

// R3: a source that has been quiet is polled once a ColdEvery, not every tick; a line makes it hot
// again (polled every tick); a cold source does not hold back the settle of a hot one.
func TestQuietSourcesArePolledColdAndWakeUpHot(t *testing.T) {
	root := testkit.Project(t)
	for _, tk := range []string{"T-1", "T-2"} {
		testkit.Append(t, testkit.CellLog(root, tk), testkit.LifecycleLine(tk, 1, "station.entered", "groom", map[string]any{"stage": "interview"}))
	}
	h := tieredHarness(t, root)
	h.drain() // catch-up: every source is read every tick
	if h.o.catchingUp {
		t.Fatal("still catching up")
	}
	for i := 0; i < 60; i++ { // 12 s of quiet: both cells turn cold
		h.tick()
	}
	if c := h.o.sources["cell/T-1"]; c == nil || !c.cold {
		t.Fatal("a quiet cell is not cold")
	}

	// A cold cell's line is read within ColdEvery (five 200 ms ticks), not at once.
	testkit.Append(t, testkit.CellLog(root, "T-1"), testkit.LifecycleLine("T-1", 2, "station.entered", "plan", map[string]any{"stage": "spec-ready"}))
	ticks := 0
	for lifecycleCount(h, "T-1") < 2 {
		h.tick()
		if ticks++; ticks > 6 {
			t.Fatalf("a cold cell's line was not read within ColdEvery (%d ticks)", ticks)
		}
	}
	if c := h.o.sources["cell/T-1"]; c.cold {
		t.Fatal("a cell with a new line is still cold")
	}
	// Now hot: the next line is read at the next tick, and committed at once although T-2 is
	// cold (a cold source does not hold the adaptive settle).
	testkit.Append(t, testkit.CellLog(root, "T-1"), testkit.LifecycleLine("T-1", 3, "station.entered", "audit", map[string]any{"stage": "planned"}))
	h.tick()
	if got := lifecycleCount(h, "T-1"); got != 3 {
		t.Fatalf("a hot cell's line took more than one tick: %d", got)
	}
	if c := h.o.sources["cell/T-2"]; !c.cold {
		t.Fatal("the other cell woke up with no line")
	}
}

// R3: a cell made after the catch-up is hot from the start (found by its folder's change), and a
// running execution keeps its cell hot.
func TestNewCellsAndRunningExecutionsAreHot(t *testing.T) {
	root := testkit.Project(t)
	h := tieredHarness(t, root)
	h.drain()
	testkit.Append(t, testkit.CellLog(root, "T-9"), testkit.LifecycleLine("T-9", 1, "station.entered", "groom", map[string]any{"stage": "interview"}))
	h.tick()
	if lifecycleCount(h, "T-9") != 1 {
		t.Fatal("a new cell's first line was not read at the next tick")
	}
	for i := 0; i < 60; i++ {
		h.tick()
	}
	src := h.o.sources["cell/T-9"]
	if !src.cold {
		t.Fatal("the new cell did not turn cold")
	}
	// An execution starts for T-9: the intake log says which ticket it works on.
	testkit.Append(t, testkit.LedgerPath(root), testkit.LedgerLineFor(1, "work.claimed", "T-9", "x0123456789ab", map[string]any{"stage": "planned", "next": "build", "attempt": 1}))
	testkit.WriteFile(t, testkit.ExecDir(root, "x0123456789ab")+"/started.json", mustJSON(map[string]any{"execution_id": "x0123456789ab", "wrapper_pid": 1, "child_pid": 2, "started_at": "2026-11-12T10:00:00Z"}))
	for i := 0; i < 3; i++ {
		h.tick()
	}
	if src.cold {
		t.Fatal("a running execution's cell is cold")
	}
	for i := 0; i < 60; i++ { // the execution keeps it hot however long it runs quietly
		h.tick()
	}
	if src.cold || h.o.sources["stream/x0123456789ab"].cold {
		t.Fatal("a running execution or its cell turned cold")
	}
}
