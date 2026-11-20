package normalize

import (
	"encoding/json"
	"testing"
	"time"

	"mach/observer/internal/redact"
)

// M12: review.exception_recorded is a known lifecycle kind, not a gap. Only codes are kept: the seat,
// the finding's place and impact, and what the round became. A name or a reason never passes.
func TestSecurityExceptionIsAKnownKindWithCodesOnly(t *testing.T) {
	data := map[string]any{"round": 1, "expires_given": true, "renewal": false, "outcome": "APPROVED",
		"findings": []any{
			map[string]any{"seat": "product", "index": 1, "impact": "high"},
			map[string]any{"seat": "Jane Doe", "index": 2, "impact": "high"},
			map[string]any{"seat": "security", "index": 0, "impact": "critical"},
		},
		"by": "Jane Doe", "reason": "we accept the risk"}
	b, _ := json.Marshal(map[string]any{"v": 1, "seq": 20, "at": "2026-11-20T10:00:00.000Z", "ticket_id": "T-1", "type": "review.exception_recorded",
		"station": "review", "visit": "review#2", "round": 1, "execution_id": nil, "data": data})
	now := time.Date(2026, 11, 20, 11, 0, 0, 0, time.UTC)
	var found bool
	for _, e := range NewLifecycle("T-1", "g", "/work/p", NewIdentity()).Line(b, Read{Line: 1, At: now}) {
		if e.Type == "history.gap" {
			t.Fatalf("the kind was read as a gap: %v", e.Data)
		}
		if e.Type != "review.exception_recorded" {
			continue
		}
		found = true
		if !redact.Enforce(e, nil) {
			t.Fatalf("refused by the allowlist: %v", e.Data)
		}
		got, _ := json.Marshal(e.Data)
		want := `{"expires_given":true,"findings":[{"impact":"high","index":1,"seat":"product"}],"outcome":"APPROVED","renewal":false}`
		if string(got) != want {
			t.Fatalf("data %s, want %s", got, want)
		}
		if e.Withheld < 2 {
			t.Fatalf("the name and the reason are withheld, not kept: withheld %d", e.Withheld)
		}
	}
	if !found {
		t.Fatal("no review.exception_recorded event")
	}
}
