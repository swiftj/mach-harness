package project

import (
	"encoding/json"
	"testing"

	"mach/observer/internal/feedtest"
)

// M6.5 (event revision 3): an execution carries the provenance snapshot its start recorded, or
// says it has none. An execution from before M6.5 is "not recorded"; nothing is filled in.
func TestExecutionProvenanceIsCarriedOrNotRecorded(t *testing.T) {
	started := func(x string, ms int64, data map[string]any) map[string]any {
		d := map[string]any{"until": "merge", "workflow": "mach:belt", "limits": map[string]any{"minutes": 60, "budget_usd": 5}}
		for k, v := range data {
			d[k] = v
		}
		return feedtest.New("intake-log", "execution.started", ms).Ticket("T-1").Exec(x).Data(d).Build()
	}
	snap := map[string]any{"schema": 1, "config_id": "2222222222222222222222222222222222222222222222222222222222222222",
		"mach": map[string]any{"version": "0.12.0", "install": "plugin", "commit": nil}}
	const recorded, failed, legacy, claimedOnly = "x00000000000a", "x00000000000b", "x00000000000c", "x00000000000d"
	m := feedtest.NewMem("", 0)
	m.Append(
		started(recorded, 1000, map[string]any{"provenance": snap, "provenance_reason": nil, "source_commit": "abcdef1"}),
		started(failed, 1100, map[string]any{"provenance": nil, "provenance_reason": "capture-failed", "source_commit": nil}),
		started(legacy, 1200, nil), // revision 2 and before: no such keys at all
		feedtest.New("intake-log", "work.claimed", 1300).Ticket("T-1").Exec(claimedOnly).Data(map[string]any{"stage": "planned", "next": "build", "attempt": 1}).Build(),
	)
	p := New(Options{Log: m})
	p.View(func(s *State) {
		a := Run(s, s.Executions[recorded])
		if !a.ProvenanceRecorded || a.ProvenanceReason != "" || a.Provenance["config_id"] != snap["config_id"] || a.SourceCommit == nil || *a.SourceCommit != "abcdef1" {
			t.Fatalf("recorded: %+v", a)
		}
		for x, reason := range map[string]string{failed: "capture-failed", legacy: "not-recorded", claimedOnly: "not-recorded"} {
			v := Run(s, s.Executions[x])
			if v.ProvenanceRecorded || v.Provenance != nil || v.ProvenanceReason != reason || v.SourceCommit != nil {
				t.Fatalf("%s: %+v", x, v)
			}
			b, _ := json.Marshal(v)
			var served map[string]any
			_ = json.Unmarshal(b, &served)
			if p, ok := served["provenance"]; !ok || p != nil || served["provenance_recorded"] != false || served["source_commit"] != nil {
				t.Fatalf("%s served as %s", x, b)
			}
		}
	})
}
