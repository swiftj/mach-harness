package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"testing"
	"time"

	"mach/observer/internal/project"
	"mach/observer/internal/testkit"
	"mach/observer/internal/testkit/synth"
)

// A10: the synthetic Factory history end to end, through the real observer (sources, normalisers,
// store, projection, routes): every span kind the generator modelled reaches /spans, spans page
// to completion, a window's marks page to completion with offset, and /concurrency splits
// recorded from inferred ends. 20,000 events by default (about 20 s); MACH_OBSERVER_SYNTH_EVENTS
// sets the size (220000 for the generator's full history).
func TestSyntheticHistoryEndToEnd(t *testing.T) {
	events := 20000
	if testing.Short() || testkit.Race {
		events = 6000
	}
	if v, err := strconv.Atoi(os.Getenv("MACH_OBSERVER_SYNTH_EVENTS")); err == nil && v > 0 {
		events = v
	}
	root := t.TempDir()
	sum, err := synth.Generate(synth.Options{Out: root, Events: events, Seed: 5, Cells: 12, AgentsPerExecution: 24})
	if err != nil {
		t.Fatal(err)
	}
	r := launch(t, root)
	defer r.stop(t)
	r.client.Timeout = 2 * time.Minute
	waitSettled(t, r, 10*time.Minute, uint64(sum.Events)*98/100)

	// Every span, paged.
	kinds := map[string]int{}
	var liveMS int64
	openExec := 0
	for off := 0; ; off += 1000 {
		var reply struct {
			Data struct {
				Items     []project.Span `json:"items"`
				Total     int            `json:"total"`
				Truncated bool           `json:"truncated"`
				LiveMS    int64          `json:"live_ms"`
			} `json:"data"`
		}
		if err := json.Unmarshal(r.get(t, fmt.Sprintf("/api/v1/spans?limit=1000&offset=%d", off)), &reply); err != nil {
			t.Fatal(err)
		}
		liveMS = reply.Data.LiveMS
		for _, sp := range reply.Data.Items {
			kinds[sp.Kind]++
			if sp.Kind == "execution" && sp.End == nil {
				openExec++
			}
			if sp.End != nil && sp.End.Basis == "inferred" && (sp.Outcome != nil || sp.Duration.MS != nil) {
				t.Fatalf("%s: an inferred end with an outcome or a measured length", sp.SpanID)
			}
		}
		if off+len(reply.Data.Items) >= reply.Data.Total || len(reply.Data.Items) == 0 {
			if reply.Data.Truncated {
				t.Logf("spans capped at %d", reply.Data.Total)
			}
			break
		}
	}
	for kind, n := range sum.Spans {
		if n > 0 && kinds[kind] == 0 && spanKindServed(kind) {
			t.Errorf("the generator modelled %d %s spans; /spans has none", n, kind)
		}
	}
	if openExec > sum.MaxPar {
		t.Errorf("%d executions open (at most %d run at once)", openExec, sum.MaxPar)
	}
	t.Logf("%d events: spans by kind %v", sum.Events, kinds)

	// The whole history's marks, paged with offset.
	path := fmt.Sprintf("/api/v1/marks?from_ms=0&to_ms=%d&limit=1000", liveMS+1)
	seen := map[string]bool{}
	total := -1
	for off := 0; ; {
		var reply struct {
			Data struct {
				Items []struct {
					ID   string `json:"id"`
					Kind string `json:"kind"`
				} `json:"items"`
				Total int  `json:"total"`
				More  bool `json:"more"`
				Next  *int `json:"next_offset"`
			} `json:"data"`
		}
		json.Unmarshal(r.get(t, path+fmt.Sprintf("&offset=%d", off)), &reply)
		if total < 0 {
			total = reply.Data.Total
		}
		for _, m := range reply.Data.Items {
			if seen[m.ID] {
				t.Fatalf("mark %s on two pages", m.ID)
			}
			seen[m.ID] = true
		}
		if !reply.Data.More {
			break
		}
		off = *reply.Data.Next
	}
	if len(seen) != total {
		t.Fatalf("paged %d of %d marks", len(seen), total)
	}

	var conc struct {
		Data struct {
			Buckets []project.ConcurrencyBucket `json:"buckets"`
		} `json:"data"`
	}
	json.Unmarshal(r.get(t, "/api/v1/concurrency"), &conc)
	peak := 0
	for _, b := range conc.Data.Buckets {
		for _, a := range b.Active {
			if a.InferredMax > a.Max {
				t.Fatalf("inferred_max %d above max %d", a.InferredMax, a.Max)
			}
		}
		peak = max(peak, b.Active["execution"].Max)
	}
	if peak == 0 {
		t.Fatal("no execution was ever active")
	}
	t.Logf("%d marks; executions at once at most %d", total, peak)
}

// spanKindServed: the generator's model names a few kinds the observer does not serve as spans.
func spanKindServed(kind string) bool {
	switch kind {
	case "wave", "slice-wait", "slice-eligible", "capacity-wait", "cell", "round", "visit", "gate-wait", "person-wait", "seat", "claim", "execution",
		"workflow", "agent-queue", "agent", "tool", "task":
		return true
	}
	return false
}
