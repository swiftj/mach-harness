package ingest

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"mach/observer/internal/event"
	"mach/observer/internal/store"
	"mach/observer/internal/testkit"
)

var (
	schemaOnce sync.Once
	schema     *testkit.Schema
	schemaErr  error
)

func eventSchema(t testing.TB) *testkit.Schema {
	t.Helper()
	schemaOnce.Do(func() { schema, schemaErr = testkit.EventSchema() })
	if schemaErr != nil {
		t.Fatal(schemaErr)
	}
	return schema
}

type harness struct {
	t    testing.TB
	root string
	dir  string
	st   *store.Store
	o    *Observer
	now  time.Time
}

// clock starts at a fixed time and moves 200 ms per tick.
func newHarness(t testing.TB, root, dir string, settle bool) *harness {
	t.Helper()
	h := &harness{t: t, root: root, dir: dir, now: time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)}
	h.open(settle)
	return h
}

func (h *harness) open(settle bool) {
	st, err := store.Open(h.dir, 1_000_000)
	if err != nil {
		h.t.Fatal(err)
	}
	h.st = st
	h.o = New(Options{Root: h.root, Store: st, NoSettle: !settle, Now: func() time.Time { return h.now }})
}

func (h *harness) close() {
	h.st.Close()
}

func (h *harness) tick() int {
	h.t.Helper()
	h.now = h.now.Add(200 * time.Millisecond)
	n, err := h.o.Tick()
	if err != nil {
		h.t.Fatal(err)
	}
	return n
}

// drain ticks until nothing new is read and nothing is held.
func (h *harness) drain() {
	h.t.Helper()
	for i := 0; i < 400; i++ {
		before := h.st.Head()
		h.tick()
		if h.st.Head() == before && len(h.o.queue) == 0 && i > 15 {
			return
		}
	}
}

func (h *harness) events() []*event.Event {
	h.t.Helper()
	var out []*event.Event
	var pos uint64
	for {
		batch, err := h.st.After(pos, 5000)
		if err != nil {
			h.t.Fatal(err)
		}
		if len(batch) == 0 {
			return out
		}
		for _, e := range batch {
			out = append(out, full(h.t, e.Raw))
			pos = e.Event.Pos
		}
	}
}

// full decodes a stored event's envelope (the store keeps only index fields decoded).
func full(t testing.TB, raw []byte) *event.Event {
	t.Helper()
	var ev event.Event
	if err := json.Unmarshal(raw, &ev); err != nil {
		t.Fatal(err)
	}
	return &ev
}

func (h *harness) raws() [][]byte {
	var out [][]byte
	var pos uint64
	for {
		batch, _ := h.st.After(pos, 5000)
		if len(batch) == 0 {
			return out
		}
		for _, e := range batch {
			out = append(out, e.Raw)
			pos = e.Event.Pos
		}
	}
}

// validate checks every stored event against the version 3 schema.
func (h *harness) validate() int {
	h.t.Helper()
	s := eventSchema(h.t)
	n := 0
	for _, raw := range h.raws() {
		if errs := s.ValidateJSON(raw); len(errs) > 0 {
			h.t.Fatalf("schema violation in %s:\n%s", raw, strings.Join(errs, "\n"))
		}
		n++
	}
	return n
}

func ofType(evs []*event.Event, typ string) []*event.Event {
	var out []*event.Event
	for _, e := range evs {
		if e.Type == typ {
			out = append(out, e)
		}
	}
	return out
}

func kinds(evs []*event.Event) map[string]int {
	out := map[string]int{}
	for _, e := range evs {
		out[e.Type]++
	}
	return out
}

func ids(evs []*event.Event) []string {
	var out []string
	for _, e := range evs {
		out = append(out, e.ID)
	}
	sort.Strings(out)
	return out
}

// execution sets up an execution folder from a stream fixture, with its records.
func execution(t testing.TB, root, x, fixture string, ended bool) {
	t.Helper()
	dir := testkit.ExecDir(root, x)
	data, err := os.ReadFile(testkit.StreamFixture(fixture))
	if err != nil {
		t.Fatal(err)
	}
	testkit.WriteFile(t, filepath.Join(dir, "started.json"), mustJSON(map[string]any{"execution_id": x, "wrapper_pid": 4242, "child_pid": 4243, "started_at": "2023-11-14T22:13:18Z"}))
	testkit.WriteFile(t, filepath.Join(dir, "stream.jsonl"), data)
	if ended {
		testkit.WriteFile(t, filepath.Join(dir, "result.json"), mustJSON(map[string]any{"execution_id": x, "ended": "exited", "exit_code": 0, "ended_at": "2023-11-14T22:20:00Z", "seconds": 402}))
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
