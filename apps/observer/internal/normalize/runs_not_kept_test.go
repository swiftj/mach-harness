package normalize

import (
	"testing"
	"time"
)

// cleanup.archive: a run record with no archive kept (archive null) and the fields that say why
// (raised_to_person, archive_kept) is read like any other: one run.recorded, never a gap. The new
// fields are not part of the event; they are counted as withheld, like the archive path.
func TestARunRecordWithNoArchiveKept(t *testing.T) {
	n := NewRuns("0badc0de", "", nil)
	r := Read{Line: 1, At: time.Unix(1794477600, 0)}
	line := `{"record_version":2,"ticket_id":"T-5","outcome":"abandoned","rounds":1,"archive":null,"raised_to_person":["abandoned-by-person"],` +
		`"archive_kept":{"kept":false,"setting":"raised","chosen_by":"setting","published":null,"reason":"Not kept."},"closed_at":"2026-11-12T10:00:00Z"}`
	evs := n.Line([]byte(line), r)
	if len(evs) != 1 || evs[0].Type != "run.recorded" || evs[0].IDs.TicketID != "T-5" || evs[0].Data["outcome"] != "abandoned" {
		t.Fatalf("%+v", evs)
	}
	if evs[0].Withheld != 3 {
		t.Errorf("withheld %d, want 3 (archive, raised_to_person, archive_kept)", evs[0].Withheld)
	}
}
