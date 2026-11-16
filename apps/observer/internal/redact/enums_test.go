package redact

import (
	"testing"

	"mach/observer/internal/event"
)

// M9: human.approval_recorded's decision is an enumerated code, not prose. Enforce keeps the
// known values (APPROVED, SENT_BACK) and turns anything else into null, counted as withheld; a
// record without a decision stays without one; the person's reason never has a field.
func TestHumanApprovalDecisionKeepsOnlyKnownCodes(t *testing.T) {
	cases := []struct {
		name     string
		data     map[string]any
		want     any
		present  bool
		withheld int
	}{
		{"approved", map[string]any{"by_role": "person", "note_given": true, "decision": "APPROVED"}, "APPROVED", true, 0},
		{"sent back", map[string]any{"by_role": "person", "note_given": true, "decision": "SENT_BACK"}, "SENT_BACK", true, 0},
		{"no decision", map[string]any{"by_role": "person", "note_given": false}, nil, false, 0},
		{"null decision", map[string]any{"by_role": "person", "note_given": false, "decision": nil}, nil, true, 0},
		{"unknown value", map[string]any{"by_role": "person", "note_given": true, "decision": "Jane said: ship it"}, nil, true, 1},
		{"lower case is not a stored code", map[string]any{"by_role": "person", "note_given": true, "decision": "sent_back"}, nil, true, 1},
		{"a number", map[string]any{"by_role": "person", "note_given": true, "decision": 2.0}, nil, true, 1},
		{"the reason is dropped", map[string]any{"by_role": "person", "note_given": true, "decision": "SENT_BACK", "note": "needs the error copy fixed"}, "SENT_BACK", true, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ev := &event.Event{Type: "human.approval_recorded", Authority: event.Authoritative,
				Origin: event.Origin{Stream: event.StreamLifecycle, Key: "c:T-1:g", Writer: "station", Script: "review.py"},
				IDs:    event.IDs{TicketID: "T-1", CellInstance: "g", VisitID: "T-1/human-approval#1", Station: "human-approval", Round: 1},
				Data:   tc.data}
			if !Enforce(ev, nil) {
				t.Fatal("refused")
			}
			got, ok := ev.Data["decision"]
			if ok != tc.present || got != tc.want || ev.Withheld != tc.withheld {
				t.Fatalf("decision %#v (present %v), withheld %d; want %#v (present %v), withheld %d", got, ok, ev.Withheld, tc.want, tc.present, tc.withheld)
			}
			if _, ok := ev.Data["note"]; ok {
				t.Fatal("the person's reason survived")
			}
		})
	}
}
