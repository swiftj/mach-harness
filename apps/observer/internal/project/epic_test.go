package project

import (
	"testing"

	"mach/observer/internal/feedtest"
)

// M11: a slice from an issue carries its epic, the epic's name and its issue number; its cell
// carries the epic and the issue; the epic is the dimension a metric read joins to the ticket. A
// slice from a folder has no issue, and one from a version 2 history has no epic: both stay absent.
func TestASliceCarriesItsEpicAndIssue(t *testing.T) {
	var ev []map[string]any
	add := func(e *feedtest.Ev) { ev = append(ev, e.Build()) }
	add(feedtest.New("intake-log", "slice.materialized", 1000).ID("epic_id", "EPIC-002").ID("issue", 57).ID("slice_id", "SLICE-007").ID("revision", 1).
		Entity("slice:SLICE-007").Ticket("57").Data(map[string]any{"digest": "a", "adopted": false, "dependencies": []string{}, "reissued": nil,
		"title": "Short links", "epic_title": "Sharing"}))
	add(feedtest.New("intake-log", "slice.materialized", 2000).ID("epic_id", "EPIC-002").ID("slice_id", "SLICE-008").ID("revision", 1).
		Entity("slice:SLICE-008").Ticket("LOCAL-008").Data(map[string]any{"digest": "b", "adopted": false, "dependencies": []string{}, "reissued": nil,
		"title": nil, "epic_title": nil}))
	add(feedtest.New("intake-log", "slice.materialized", 3000).ID("slice_id", "SLICE-009").ID("revision", 1).
		Entity("slice:SLICE-009").Ticket("LOCAL-009").Data(map[string]any{"digest": "c", "adopted": false, "dependencies": []string{}, "reissued": nil}))
	s := m66State(t, ev)
	if sl := s.Slices["SLICE-007"]; sl.EpicID != "EPIC-002" || sl.EpicTitle != "Sharing" || sl.Issue != 57 {
		t.Errorf("SLICE-007 = %+v", sl)
	}
	if c := s.Cells["57"]; c == nil || c.EpicID != "EPIC-002" || c.Issue != 57 {
		t.Errorf("cell 57 = %+v", c)
	}
	if d := TicketDims(s, "57"); d["epic"] != "EPIC-002" {
		t.Errorf("dims %v", d)
	}
	v := SliceView(s, s.Slices["SLICE-008"])
	if v["epic_id"] != "EPIC-002" || v["epic_title"] != nil || v["issue"] != nil {
		t.Errorf("SLICE-008 view %v", v)
	}
	v = SliceView(s, s.Slices["SLICE-009"])
	if v["epic_id"] != nil || v["epic_title"] != nil || v["issue"] != nil {
		t.Errorf("SLICE-009 view %v", v)
	}
	if got := Slices(s, "EPIC-002", ""); len(got) != 2 {
		t.Errorf("slices of EPIC-002: %d", len(got))
	}
	if c := CellSummary(s.Cells["LOCAL-009"]); c["epic_id"] != nil || c["issue"] != nil {
		t.Errorf("LOCAL-009 summary %v", c)
	}
}
