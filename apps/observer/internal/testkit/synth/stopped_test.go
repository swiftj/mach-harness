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

// Stopped: with Stopped on, the generated project holds a ticket stopped after its third round, one a
// person carried on with one more round (round 4 of 4) and one given a fresh set of rounds by a person
// starting the Factory (round 1 of 3, then 2 of 3); the observer indexes every line with no new gap and
// nothing unrecognised, and the carry-on records come out as data.carried_on.
func TestStoppedTicketsAreInTheTestData(t *testing.T) {
	dir := t.TempDir()
	sum, err := synth.Generate(synth.Options{Out: dir, Cells: 12, Events: 5000, Seed: 7, Hours: 30, AgentsPerExecution: 24, Stopped: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"stopped_ticket", "carried_on_ticket", "fresh_rounds_ticket"} {
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
	carried := map[string]string{}
	escalated := map[string]bool{}
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
				Type string `json:"type"`
				IDs  struct {
					Ticket string `json:"ticket_id"`
				} `json:"ids"`
				Data map[string]any `json:"data"`
			}
			_ = json.Unmarshal(e.Raw, &v)
			if v.Type == "history.gap" && !strings.Contains(raw, "missing-seq") && strings.Contains(raw, "SYN-STOP") {
				t.Errorf("a new gap: %s", raw)
			}
			if co, ok := v.Data["carried_on"].(map[string]any); ok {
				b, _ := json.Marshal(co)
				carried[v.IDs.Ticket] = string(b)
			}
			if v.Type == "station.exited" && v.Data["outcome"] == "escalated" {
				escalated[v.IDs.Ticket] = true
			}
		}
	}
	if carried["SYN-STOP2"] != `{"by":"person-decision","max":4,"round":4}` || carried["SYN-STOP3"] != `{"by":"person-start","max":3,"round":1}` || carried["SYN-STOP1"] != "" {
		t.Fatalf("carry-ons: %v", carried)
	}
	if !escalated["SYN-STOP1"] || !escalated["SYN-STOP2"] || !escalated["SYN-STOP3"] {
		t.Fatalf("escalations: %v", escalated)
	}
}
