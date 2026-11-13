package synth_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/ingest"
	"mach/observer/internal/store"
	"mach/observer/internal/testkit"
	"mach/observer/internal/testkit/synth"
)

func small(t *testing.T, dir string) *synth.Summary {
	t.Helper()
	events := 12000
	if testing.Short() || testkit.Race {
		events = 5000 // the race detector slows ingest about twentyfold (12 cells need about 3,300 events before any agent progress)
	}
	sum, err := synth.Generate(synth.Options{Out: dir, Cells: 12, Events: events, Seed: 7, Hours: 30, AgentsPerExecution: 24})
	if err != nil {
		t.Fatal(err)
	}
	return sum
}

// contents hashes every file's content (not its time) under root.
func contents(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		h := sha256.Sum256(b)
		out[filepath.ToSlash(rel)] = hex.EncodeToString(h[:])
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestDeterministic(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	sa, sb := small(t, a), small(t, b)
	if sa.Events != sb.Events || len(sa.ByType) != len(sb.ByType) {
		t.Fatalf("summaries differ: %d vs %d events", sa.Events, sb.Events)
	}
	ha, hb := contents(t, a), contents(t, b)
	if len(ha) != len(hb) {
		t.Fatalf("%d files vs %d", len(ha), len(hb))
	}
	for k, v := range ha {
		if hb[k] != v {
			t.Fatalf("%s differs between two runs with the same seed", k)
		}
	}
	other := t.TempDir()
	if _, err := synth.Generate(synth.Options{Out: other, Cells: 12, Events: 5000, Seed: 8, Hours: 30, AgentsPerExecution: 24}); err != nil {
		t.Fatal(err)
	}
	if hc := contents(t, other); hc[".factory/intake/events.jsonl"] == ha[".factory/intake/events.jsonl"] {
		t.Fatal("another seed gave the same intake log")
	}
}

func TestSummaryCoversTheShapes(t *testing.T) {
	dir := t.TempDir()
	sum := small(t, dir)
	if d := sum.Events - sum.Target; d < -sum.Target/100 || d > sum.Target/100 {
		t.Fatalf("%d events for a target of %d", sum.Events, sum.Target)
	}
	for _, typ := range []string{"factory.activated", "wave.discovered", "dependency.blocked", "dependency.resolved", "revision.superseded", "scheduling.decided",
		"work.claimed", "execution.started", "execution.completed", "execution.failed", "recovery.started", "human.required", "slice.integrated",
		"station.entered", "station.exited", "gate.evaluated", "build.task_completed", "verify.check_recorded", "review.round_started",
		"review.verdict_submitted", "review.decided", "human.approval_recorded", "merge.completed", "cleanup.completed", "run.recorded",
		"execution.process_started", "execution.process_ended", "session.initialized", "tool.called", "tool.returned", "workflow.started",
		"workflow.phases_declared", "agent.queued", "agent.started", "agent.progressed", "agent.finished", "workflow.finished", "execution.usage", "history.gap"} {
		if sum.ByType[typ] == 0 {
			t.Errorf("no %s", typ)
		}
	}
	for _, f := range []string{"interrupted_execution", "outcome_unknown_execution", "open_execution", "human_wait_open", "human_wait_closed", "escalated_ticket",
		"resumed_visit", "arrival_only_stream", "late_intake_batch", "late_lifecycle_batch", "intake_gap", "blocked_several_times_slice", "blocked_at_end_slice", "capacity_waits"} {
		if sum.Features[f] == nil {
			t.Errorf("feature %s missing", f)
		}
	}
	if sum.Waves != 3 || sum.Slices != 13 || sum.Spans["capacity-wait"] == 0 {
		t.Errorf("waves %d, slices %d, capacity waits %d", sum.Waves, sum.Slices, sum.Spans["capacity-wait"])
	}
	// Rounds 1 to 3 occur, and executions do not line up with rounds: some execution writes records of two rounds.
	data, _ := os.ReadFile(testkit.CellLog(dir, sum.Features["escalated_ticket"].(string)))
	if !strings.Contains(string(data), `"round":3`) {
		t.Error("the escalated cell has no round 3")
	}
	if _, err := os.Stat(filepath.Join(dir, ".factory", "archive", "SYN-001.tar.gz")); err != nil {
		t.Error("no archive for the first cell")
	}
	if b, _ := os.ReadFile(filepath.Join(dir, ".factory", "intake", "events.jsonl")); strings.Contains(string(b), "/Users/") {
		t.Error("a path outside the generated folder")
	}
}

// TestObserverIndexesIt runs the observer's own ingest loop over a generated project: every line
// is accepted (no unparsable line, no unknown type or shape, no incompatible stream), and the only
// gap is the deliberate one.
func TestObserverIndexesIt(t *testing.T) {
	dir := t.TempDir()
	sum := small(t, dir)
	st, err := store.Open(filepath.Join(t.TempDir(), "index"), store.DefaultMaxMemory)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	clock := time.Now()
	o := ingest.New(ingest.Options{Root: dir, Store: st, NoSettle: true, Now: func() time.Time { return clock }})
	for idle := 0; idle < 3; {
		clock = clock.Add(200 * time.Millisecond)
		n, err := o.Tick()
		if err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			idle++
		} else {
			idle = 0
		}
	}
	types := map[string]int{}
	var gaps []string
	var pos uint64
	for {
		batch, err := st.After(pos, 10000)
		if err != nil {
			t.Fatal(err)
		}
		if len(batch) == 0 {
			break
		}
		for _, e := range batch {
			types[e.Event.Type]++
			if e.Event.Type == "history.gap" {
				gaps = append(gaps, string(e.Raw))
			}
			pos = e.Event.Pos
		}
	}
	stats := o.Stats()
	b, _ := json.Marshal(stats.Runtime)
	t.Logf("observer: %d events committed, runtime %s, unrecognised %v", stats.Committed, b, stats.Unrecognised)
	if len(gaps) != 1 || !strings.Contains(gaps[0], "missing-seq") {
		t.Fatalf("gaps: %v", gaps)
	}
	if len(stats.Unrecognised) > 0 {
		t.Fatalf("unrecognised records: %v", stats.Unrecognised)
	}
	if strings.Contains(string(b), "incompatible\":1") || strings.Contains(string(b), `"incompatible":[1-9]`) {
		t.Fatalf("incompatible streams: %s", b)
	}
	var missing []string
	for typ, n := range sum.ByType {
		if types[typ] < n {
			missing = append(missing, typ)
		}
	}
	sort.Strings(missing)
	for _, typ := range missing {
		t.Errorf("%s: generator wrote %d, observer indexed %d", typ, sum.ByType[typ], types[typ])
	}
}

func TestAppend(t *testing.T) {
	dir := t.TempDir()
	small(t, dir)
	before, _ := os.ReadFile(filepath.Join(dir, ".factory", "intake", "events.jsonl"))
	sum, err := synth.Append(synth.AppendOptions{Out: dir, Rate: 400, Duration: 1200 * time.Millisecond, Seed: 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if sum.Events < 200 || sum.ByType["agent.progressed"] == 0 || sum.Arrival == 0 {
		t.Fatalf("appended %+v", sum)
	}
	after, _ := os.ReadFile(filepath.Join(dir, ".factory", "intake", "events.jsonl"))
	if len(after) <= len(before) {
		t.Fatal("no supervisor pass appended")
	}
}
