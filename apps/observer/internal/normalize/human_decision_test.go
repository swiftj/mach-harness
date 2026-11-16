package normalize

import (
	"encoding/json"
	"testing"
	"time"

	"mach/observer/internal/redact"
)

// M9: human.approval_recorded's decision is an enumerated code. The normaliser keeps APPROVED or
// SENT_BACK (any case; a synthetic history's "approve" is APPROVED) and nothing else; a missing
// or unknown value is null, which the projection reads as an approval.
func TestHumanApprovalDecisionIsKeptAsACode(t *testing.T) {
	cases := []struct {
		name string
		data map[string]any
		want any
	}{
		{"approved", map[string]any{"round": 1, "decision": "APPROVED", "note_given": true}, "APPROVED"},
		{"synthetic approve", map[string]any{"round": 1, "decision": "approve", "note_given": true}, "APPROVED"},
		{"sent back", map[string]any{"round": 1, "decision": "SENT_BACK", "note_given": true}, "SENT_BACK"},
		{"sent back, mixed case", map[string]any{"round": 1, "decision": "Sent_Back", "note_given": true}, "SENT_BACK"},
		{"no decision", map[string]any{"round": 1, "note_given": false}, nil},
		{"unknown value", map[string]any{"round": 1, "decision": "Ask Jane Doe tomorrow", "note_given": true}, nil},
		{"not a string", map[string]any{"round": 1, "decision": 7, "note_given": true}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b, _ := json.Marshal(map[string]any{"v": 1, "seq": 13, "at": "2026-11-12T20:55:42.486Z", "ticket_id": "T-1", "type": "human.approval_recorded",
				"station": "human-approval", "visit": "human-approval#1", "round": 1, "execution_id": nil, "data": tc.data})
			now := time.Date(2026, 11, 12, 21, 0, 0, 0, time.UTC)
			var found bool
			for _, e := range NewLifecycle("T-1", "g", "/work/p", NewIdentity()).Line(b, Read{Line: 1, At: now}) {
				if e.Type != "human.approval_recorded" {
					continue
				}
				found = true
				got, ok := e.Data["decision"]
				if !ok || got != tc.want {
					t.Fatalf("decision %#v (present %v), want %#v; data %v", got, ok, tc.want, e.Data)
				}
				if e.Data["by_role"] != "person" {
					t.Fatalf("by_role %v", e.Data["by_role"])
				}
				// The allowlist keeps it as it is.
				w := e.Withheld
				if !redact.Enforce(e, nil) || e.Data["decision"] != tc.want || e.Withheld != w {
					t.Fatalf("after Enforce: %v (withheld %d, was %d)", e.Data, e.Withheld, w)
				}
			}
			if !found {
				t.Fatal("no human.approval_recorded event")
			}
		})
	}
}
