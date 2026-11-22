package server

import (
	"testing"

	"mach/observer/internal/feedtest"
)

// M18: time at Groom for small changes beside full slices. The groom station's exit says when a
// ticket is a small change (revision 8); the observer joins change (small or full) and widened to
// a ticket's figures when they are read, so a small change that became a full slice counts as a
// full slice for every one of its groom visits, the earlier ones too, and is counted apart as
// widened.
func TestTimeAtGroomBySmallChangeAndFullSlice(t *testing.T) {
	visit := func(ticket, v string, from, to int64, exit map[string]any) []map[string]any {
		data := map[string]any{"station": "groom", "outcome": "spec-ready", "stage": "spec-ready", "duration_ms": to - from, "closed_by": nil, "head": nil, "counts": map[string]any{}}
		for k, x := range exit {
			data[k] = x
		}
		return []map[string]any{
			feedtest.New("cell-lifecycle", "station.entered", from).Ticket(ticket).Visit(ticket, v, 1).Data(map[string]any{
				"station": "groom", "stage": "interview", "action": "groom", "resumed": false, "unclosed_visit": nil, "head": nil, "counts": map[string]any{}}).Build(),
			feedtest.New("cell-lifecycle", "station.exited", to).Ticket(ticket).Visit(ticket, v, 1).Data(data).Build(),
		}
	}
	small := map[string]any{"kind": "small", "widened": false, "widened_rule": nil}
	var events []map[string]any
	events = append(events, visit("T-1", "groom#1", 0, 10_000, nil)...)    // a full slice: its exit names no kind
	events = append(events, visit("T-2", "groom#1", 1_000, 5_000, small)...) // a small change
	// A small change whose plan found a file in a high-risk area: its first groom visit was on the
	// short interview, its second ended widened. Both count as a full slice.
	events = append(events, visit("T-3", "groom#1", 2_000, 5_000, small)...)
	events = append(events, visit("T-3", "groom#2", 20_000, 26_000, map[string]any{"kind": "small", "widened": true, "widened_rule": "high-risk-file"})...)
	h := start2(t, events)

	d := h.get(t, "/api/v1/analytics/metrics?ids=C1&group_by=station,change&distribution=1&from_ms=0")
	byChange := map[string]map[string]any{}
	for _, g := range metricRow(t, d, "C1")["groups"].([]any) {
		g := g.(map[string]any)
		keys := g["keys"].(map[string]any)
		if keys["station"] == "groom" {
			byChange[keys["change"].(string)] = g
		}
	}
	if len(byChange) != 2 || byChange["small"] == nil || byChange["full"] == nil {
		t.Fatalf("groups %v", byChange)
	}
	if s := byChange["small"]; s["denominator"] != 1.0 || s["numerator"] != 4000.0 {
		t.Errorf("small: %v visits, %v ms", s["denominator"], s["numerator"])
	}
	if f := byChange["full"]; f["denominator"] != 3.0 || f["numerator"] != 19000.0 {
		t.Errorf("full (the widened change's two visits with the full slice's one): %v visits, %v ms", f["denominator"], f["numerator"])
	}

	d = h.get(t, "/api/v1/analytics/metrics?ids=C2&group_by=station,widened&from_ms=0")
	widened := map[string]any{}
	for _, g := range metricRow(t, d, "C2")["groups"].([]any) {
		g := g.(map[string]any)
		keys := g["keys"].(map[string]any)
		if keys["station"] == "groom" {
			widened[keys["widened"].(string)] = g["denominator"]
		}
	}
	if widened["yes"] != 1.0 || widened["no"] != 2.0 {
		t.Errorf("tickets at groom by widened: %v", widened)
	}
}

// An exit cleanup closed records nothing of the ticket's size: a small change abandoned in grooming
// stays a small change.
func TestACleanupClosedGroomExitKeepsTheKind(t *testing.T) {
	ev := func(typ string, ms int64, data map[string]any) map[string]any {
		return feedtest.New("cell-lifecycle", typ, ms).Ticket("T-1").Visit("T-1", map[bool]string{true: "groom#1", false: "groom#2"}[ms < 10_000], 1).Data(data).Build()
	}
	entered := map[string]any{"station": "groom", "stage": "interview", "action": "groom", "resumed": false, "unclosed_visit": nil, "head": nil, "counts": map[string]any{}}
	h := start2(t, []map[string]any{
		ev("station.entered", 0, entered),
		ev("station.exited", 3_000, map[string]any{"station": "groom", "outcome": "spec-open", "stage": "spec-open", "duration_ms": 3000, "closed_by": nil, "head": nil,
			"counts": map[string]any{}, "kind": "small", "widened": false, "widened_rule": nil}),
		ev("station.entered", 20_000, entered),
		ev("station.exited", 22_000, map[string]any{"station": "groom", "outcome": "abandoned", "stage": nil, "duration_ms": 2000, "closed_by": "cleanup", "head": nil, "counts": map[string]any{}}),
	})
	d := h.get(t, "/api/v1/analytics/metrics?ids=C1&group_by=station,change&from_ms=0")
	for _, g := range metricRow(t, d, "C1")["groups"].([]any) {
		if keys := g.(map[string]any)["keys"].(map[string]any); keys["station"] == "groom" && keys["change"] != "small" {
			t.Errorf("groom visit counted as %v", keys["change"])
		}
	}
}
