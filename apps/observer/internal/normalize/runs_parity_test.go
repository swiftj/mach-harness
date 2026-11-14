package normalize

import (
	"testing"
	"time"
)

// runs.jsonl as observe.py reads it (M6.5 parity): a ticket id is stripped, fractional numbers
// are numbers, and cleanup's four merge methods are kept; an id still unusable is a gap (counted
// in the analytics coverage), never a silent drop.
func TestRunsReadAsObserveDoes(t *testing.T) {
	n := NewRuns("0badc0de", "", nil)
	r := Read{Line: 1, At: time.Unix(1794477600, 0)}
	evs := n.Line([]byte(`{"ticket_id":"  EDGE-07 ","outcome":"merged","rounds":1.5,"tests_seen_failing_first":2.5,"tests_passing_on_first_run":1,"integration":{"method":"squash-or-rebase"},"closed_at":"2026-11-12T10:00:00Z"}`), r)
	if len(evs) != 1 || evs[0].Type != "run.recorded" || evs[0].IDs.TicketID != "EDGE-07" {
		t.Fatalf("%+v", evs)
	}
	d := evs[0].Data
	if d["rounds"] != 1.5 || d["tests_seen_failing_first"] != 2.5 || d["merge_method"] != "squash-or-rebase" {
		t.Fatalf("%+v", d)
	}
	evs = n.Line([]byte(`{"ticket_id":"bad id!","outcome":"merged"}`), Read{Line: 2, At: r.At})
	if len(evs) != 1 || evs[0].Type != "history.gap" {
		t.Fatalf("an unusable id must be a gap: %+v", evs)
	}
}
