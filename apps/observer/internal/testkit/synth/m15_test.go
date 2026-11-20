package synth_test

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/ingest"
	"mach/observer/internal/store"
	"mach/observer/internal/testkit/synth"
)

// M15: with M15 on, the generated project holds the states of M13 and M14 the Floor shows, and the
// observer indexes every line of it with no new gap and nothing unrecognised: the stop codes, the
// repeat review round, the design mock's check, Jira keys and change records come out as revision 7
// fields.
func TestM15StatesAreInTheTestData(t *testing.T) {
	dir := t.TempDir()
	sum, err := synth.Generate(synth.Options{Out: dir, Cells: 12, Events: 5000, Seed: 7, Hours: 30, AgentsPerExecution: 24, M15: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"main_conflict_ticket", "policy_owner_ticket", "merge_recheck_ticket", "waiting_for_mocks_slice"} {
		if sum.Features[f] == nil {
			t.Errorf("feature %s missing", f)
		}
	}
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
	if u := o.Stats().Unrecognised; len(u) > 0 {
		t.Fatalf("unrecognised records: %v", u)
	}
	seen := map[string]bool{}
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
			pos = e.Event.Pos
			raw := string(e.Raw)
			var v struct {
				Type string         `json:"type"`
				Data map[string]any `json:"data"`
			}
			_ = json.Unmarshal(e.Raw, &v)
			switch {
			case v.Type == "history.gap" && !strings.Contains(raw, "missing-seq"):
				t.Errorf("a new gap: %s", raw)
			case v.Type == "human.required" && v.Data["needs"] == "main-conflict":
				seen["main-conflict"] = true
			case v.Type == "human.required" && v.Data["needs"] == "policy-owner":
				seen["policy-owner"] = true
			case v.Type == "intake.refused" && v.Data["waiting"] == "mocks":
				seen["waiting-mocks"] = true
			case v.Type == "review.round_started" && v.Data["repeat"] == float64(1):
				seen["repeat"] = true
			case v.Type == "gate.evaluated" && v.Data["gate"] == "merge.landed_overlap" && v.Data["reason_code"] == "landed-overlap":
				seen["landed-overlap"] = true
			case v.Type == "gate.evaluated" && v.Data["gate"] == "build.start" && v.Data["reason_code"] == "main-conflict":
				seen["build-start-conflict"] = true
			case v.Type == "slice.materialized" && v.Data["jira"] != nil:
				seen["jira-slice"] = true
			case v.Type == "run.recorded" && v.Data["change_record"] != nil:
				seen["change-record-run"] = true
			case v.Type == "merge.completed" && v.Data["change_record"] != nil:
				seen["change-record-merge"] = true
			}
		}
	}
	for _, k := range []string{"main-conflict", "policy-owner", "waiting-mocks", "repeat", "landed-overlap", "build-start-conflict", "jira-slice", "change-record-run", "change-record-merge"} {
		if !seen[k] {
			t.Errorf("no %s in the indexed events", k)
		}
	}
}
