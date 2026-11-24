package project

import (
	"encoding/json"
	"strings"
	"testing"

	"mach/observer/internal/feedtest"
)

// Item 7: the history facts list each range of history that was lost (which source, between which
// record numbers, the reason, when it sits in history and when the observer noticed it), so the
// Factory Floor's Partial badge can say what happened. A conflict keeps the first copy and records
// not interpreted are received: neither is listed.
func TestHistoryFactsListTheLostRanges(t *testing.T) {
	gap := func(id string, ms int64, key, reason string, from, to int) map[string]any {
		return feedtest.New("observer", "history.gap", ms).Set("id", id).
			Data(map[string]any{"source_key": key, "reason": reason, "from_seq": from, "to_seq": to, "count": to - from + 1}).Build()
	}
	s := m66State(t, []map[string]any{
		gap("g1", 1_000, "c:6:0adc4f0c", "missing-seq", 4, 6),
		gap("g2", 2_000, "c:6:0adc4f0c", "conflict", 8, 8),
		gap("g3", 3_000, "i:00aa11bb", "truncated", 12, 12),
		gap("g4", 4_000, "s:x0123456789ab", "unknown-type", 3, 3),
	})
	h := HistoryFacts(s)
	ranges := h["lost_ranges"].([]map[string]any)
	if len(ranges) != 2 {
		t.Fatalf("lost ranges: %v", ranges)
	}
	first := ranges[0]
	if first["source_key"] != "c:6:0adc4f0c" || first["reason"] != "missing-seq" || first["class"] != "not-received" ||
		*first["from_seq"].(*int64) != 4 || *first["to_seq"].(*int64) != 6 || first["noticed_ms"] == nil || first["at_ms"] == nil {
		t.Fatalf("first lost range: %v", first)
	}
	if ranges[1]["source_key"] != "i:00aa11bb" || ranges[1]["reason"] != "truncated" {
		t.Fatalf("second lost range: %v", ranges[1])
	}
	// Identifiers, codes, numbers and times only.
	b, _ := json.Marshal(ranges)
	if strings.Contains(string(b), "/") {
		t.Fatalf("a path or text in the lost ranges: %s", b)
	}
}
