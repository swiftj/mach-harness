package synth_test

import (
	"bufio"
	"encoding/json"
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

func analytics(t *testing.T, dir string, cells, waves int, seed uint64) *synth.Summary {
	t.Helper()
	sum, err := synth.Generate(synth.Options{Out: dir, Analytics: true, Cells: cells, Waves: waves, Seed: seed})
	if err != nil {
		t.Fatal(err)
	}
	return sum
}

func readExpected(t *testing.T, dir string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, synth.ExpectedFile))
	if err != nil {
		t.Fatal(err)
	}
	var e map[string]any
	if err := json.Unmarshal(b, &e); err != nil {
		t.Fatal(err)
	}
	return e
}

func num(m map[string]any, path ...string) float64 {
	var v any = m
	for _, p := range path {
		v = v.(map[string]any)[p]
	}
	f, _ := v.(float64)
	return f
}

func runRecords(t *testing.T, dir string) []map[string]any {
	t.Helper()
	f, err := os.Open(filepath.Join(dir, ".factory", "archive", "runs.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []map[string]any
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		var r map[string]any
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

func TestAnalyticsDeterministic(t *testing.T) {
	a, b, c := t.TempDir(), t.TempDir(), t.TempDir()
	analytics(t, a, 30, 4, 5)
	analytics(t, b, 30, 4, 5)
	analytics(t, c, 30, 4, 6)
	if da, db := treeDigest(t, a), treeDigest(t, b); da != db {
		t.Fatal("two analytics runs with the same seed differ")
	}
	if treeDigest(t, a) == treeDigest(t, c) {
		t.Fatal("another seed gave the same project")
	}
}

// TestAnalyticsShapes: the project has what analytics needs, and the run records agree with the
// ground truth.
func TestAnalyticsShapes(t *testing.T) {
	dir := t.TempDir()
	analytics(t, dir, 80, 10, 11)
	e := readExpected(t, dir)
	runs := runRecords(t, dir)
	if float64(len(runs)) != num(e, "tickets", "finished") {
		t.Fatalf("%d run records, expected.json says %v finished", len(runs), num(e, "tickets", "finished"))
	}
	outcomes := map[string]int{}
	risks, apps := map[string]bool{}, map[string]bool{}
	escalated, human, veto, devs := 0, 0, 0, 0
	for _, r := range runs {
		outcomes[r["outcome"].(string)]++
		risks[r["risk"].(string)] = true
		apps[r["app_type"].(string)] = true
		if r["escalated"] == true {
			escalated++
		}
		if r["human_approval"] == true {
			human++
		}
		if r["record_version"].(float64) != 2 {
			t.Fatal("record_version is not 2")
		}
		if r["outcome"] == "merged" && r["integration"] == nil || r["outcome"] == "abandoned" && r["integration"] != nil {
			t.Fatalf("%s: integration %v for outcome %v", r["ticket_id"], r["integration"], r["outcome"])
		}
		devs += len(r["deviations"].([]any))
		for _, b := range r["blockers"].([]any) {
			if b.(map[string]any)["reviewer"] == "security" {
				veto++
			}
		}
	}
	if float64(outcomes["merged"]) != num(e, "tickets", "merged") || float64(outcomes["abandoned"]) != num(e, "tickets", "abandoned") || outcomes["abandoned"] == 0 {
		t.Errorf("outcomes %v against %v", outcomes, e["tickets"])
	}
	if float64(escalated) != num(e, "tickets", "escalated") || escalated == 0 || human == 0 || veto == 0 || devs == 0 {
		t.Errorf("escalated %d, human approvals %d, security blockers %d, deviations %d", escalated, human, veto, devs)
	}
	if len(risks) != 3 || len(apps) < 4 {
		t.Errorf("risks %v, app types %v", risks, apps)
	}
	for _, path := range [][]string{{"executions", "completed_without_usage"}, {"executions", "failed"}, {"executions", "outcome_unknown"},
		{"recoveries", "ended-while-unwatched"}, {"recoveries", "outcome-unknown"}, {"waits", "capacity_waits"}, {"waits", "dependency_blocked"},
		{"waits", "human_approvals_recorded"}, {"slices", "revisions_superseded"}, {"gates", "refused"}, {"gates", "overridden"},
		{"rounds", "security_vetoes"}, {"history_quirks", "intake_duplicate_lines"}} {
		if num(e, path...) == 0 {
			t.Errorf("expected.json %v is zero", path)
		}
	}
	if len(e["cost"].(map[string]any)["by_model"].(map[string]any)) < 4 {
		t.Error("fewer than four models with recorded cost")
	}
	if num(e, "waves", "total") != 10 || num(e, "tickets", "total") != 80 {
		t.Errorf("waves %v, tickets %v", e["waves"], e["tickets"])
	}
	for _, f := range []string{"partial_lifecycle_tickets", "no_lifecycle_tickets"} {
		if len(e["history_quirks"].(map[string]any)[f].([]any)) == 0 {
			t.Errorf("no %s", f)
		}
	}
	b, _ := os.ReadFile(filepath.Join(dir, ".factory", "archive", "runs.jsonl"))
	for _, bad := range []string{"/Users/", "cleanup.py", "observe.py"} {
		if strings.Contains(string(b), bad) {
			t.Errorf("runs.jsonl contains %q", bad)
		}
	}
}

// TestAnalyticsObserverIndexesIt runs the observer's own ingest over an analytics project: every
// line is accepted, the only history-losing gap is the deliberate missing seq, the duplicate intake
// lines are absorbed, and every run record is indexed.
func TestAnalyticsObserverIndexesIt(t *testing.T) {
	dir := t.TempDir()
	cells := 60
	if testing.Short() || testkit.Race {
		cells = 24
	}
	sum := analytics(t, dir, cells, 6, 3)
	e := readExpected(t, dir)
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
	unknown := map[string]int{}
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
		for _, ev := range batch {
			types[ev.Event.Type]++
			if ev.Event.Type == "history.gap" {
				gaps = append(gaps, string(ev.Raw))
			}
			var u struct {
				Unknown []string `json:"unknown"`
			}
			json.Unmarshal(ev.Raw, &u)
			for _, f := range u.Unknown {
				unknown[ev.Event.Type+" "+f]++
			}
			pos = ev.Event.Pos
		}
	}
	stats := o.Stats()
	t.Logf("observer: %d events committed, %d duplicates, unknown fields %v", stats.Committed, stats.Duplicates, unknown)
	if len(gaps) != 1 || !strings.Contains(gaps[0], "missing-seq") {
		t.Fatalf("gaps: %v", gaps)
	}
	if len(stats.Unrecognised) > 0 {
		t.Fatalf("unrecognised records: %v", stats.Unrecognised)
	}
	b, _ := json.Marshal(stats.Runtime)
	if strings.Contains(string(b), `"incompatible":[1-9]`) {
		t.Fatalf("incompatible streams: %s", b)
	}
	if float64(types["run.recorded"]) != num(e, "tickets", "finished") {
		t.Errorf("run.recorded: %d indexed, %v finished", types["run.recorded"], num(e, "tickets", "finished"))
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
	for k := range unknown {
		if strings.HasPrefix(k, "run.recorded ") {
			t.Errorf("a run record field the observer could not read: %s", k)
		}
	}
}
