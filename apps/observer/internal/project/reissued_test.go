package project

import (
	"slices"
	"testing"

	"mach/observer/internal/feedtest"
)

// Item 4: a ticket used again. A slice reissued after its work was abandoned keeps its ticket (a
// GitHub issue's number, "6"); the new run's cell folder is a new cell instance. Ticket 6 was
// groomed, planned and abandoned (cleanup's record and the run record), then groomed, planned and
// built again: the run at work is at work, the first run is history.
func reissuedSix(firstRunLate bool) []map[string]any {
	life := func(typ, visit, inst string, ms int64, data map[string]any) *feedtest.Ev {
		return feedtest.New("cell-lifecycle", typ, ms).Ticket("6").Visit("6", visit, 0).ID("cell_instance", inst).ID("slice_id", "SLICE-002").Data(data)
	}
	first := []*feedtest.Ev{
		life("station.entered", "groom#1", "aaaa1111", 1_000, map[string]any{"stage": "interview", "station": "groom"}),
		life("station.exited", "groom#1", "aaaa1111", 2_000, map[string]any{"stage": "spec-ready", "outcome": "spec-ready", "station": "groom"}),
		life("station.entered", "plan#1", "aaaa1111", 3_000, map[string]any{"stage": "spec-ready", "station": "plan"}),
		life("station.exited", "plan#1", "aaaa1111", 4_000, map[string]any{"stage": "planned", "outcome": "planned", "station": "plan", "risk": "Low", "app_type": "api"}),
		life("cleanup.completed", "cleanup#1", "aaaa1111", 5_000, map[string]any{"outcome": "abandoned", "archive": nil, "bundle": false}),
		feedtest.New("run-record", "run.recorded", 5_100).Ticket("6").ID("slice_id", "SLICE-002").Data(map[string]any{"record_version": 2, "outcome": "abandoned", "rounds": 0}),
	}
	second := []*feedtest.Ev{
		life("station.entered", "groom#1", "bbbb2222", 10_000, map[string]any{"stage": "interview", "station": "groom"}),
		life("station.exited", "groom#1", "bbbb2222", 11_000, map[string]any{"stage": "spec-ready", "outcome": "spec-ready", "station": "groom"}),
		life("station.entered", "plan#1", "bbbb2222", 12_000, map[string]any{"stage": "spec-ready", "station": "plan"}),
		life("station.exited", "plan#1", "bbbb2222", 13_000, map[string]any{"stage": "planned", "outcome": "planned", "station": "plan", "risk": "High", "app_type": "api"}),
		life("station.entered", "build#1", "bbbb2222", 14_000, map[string]any{"stage": "planned", "station": "build"}),
	}
	order := append(append([]*feedtest.Ev{}, first...), second...)
	if firstRunLate {
		// Read back from files after a restart: the live cell first, then the archive and runs.jsonl.
		order = append(append([]*feedtest.Ev{}, second...), first...)
	}
	out := make([]map[string]any, 0, len(order))
	for i, e := range order {
		e.Set("id", "e"+string(rune('a'+i)))
		out = append(out, e.Build())
	}
	return out
}

func TestReissuedTicketRunAtWorkIsAtWork(t *testing.T) {
	for _, late := range []bool{false, true} {
		s := m66State(t, reissuedSix(late))
		c := s.Cells["6"]
		if c == nil {
			t.Fatal("ticket 6 not projected")
		}
		v := CellSummary(c)
		if v["archived"] != false || v["abandoned"] != false {
			t.Fatalf("late=%v: the run at work is reported as finished: archived %v abandoned %v", late, v["archived"], v["abandoned"])
		}
		if v["stage"] != "planned" || v["cell_instance"] != "bbbb2222" || v["current_visit"] != "6/build#1" {
			t.Fatalf("late=%v: stage %v instance %v visit %v", late, v["stage"], v["cell_instance"], v["current_visit"])
		}
		if v["visits"] != 3 || v["risk"] != "High" {
			t.Fatalf("late=%v: this run's visits %v risk %v", late, v["visits"], v["risk"])
		}
		runs := v["earlier_runs"].([]map[string]any)
		if len(runs) != 1 || runs[0]["cell_instance"] != "aaaa1111" || runs[0]["outcome"] != "abandoned" || runs[0]["abandoned"] != true || runs[0]["run_records"] != 1 {
			t.Fatalf("late=%v: earlier runs %v", late, runs)
		}
		d := CellDetail(s, c)
		var ids []string
		for _, vv := range d["visits"].([]VisitView) {
			ids = append(ids, vv.VisitID)
		}
		if !slices.Equal(ids, []string{"6/groom#1", "6/plan#1", "6/build#1"}) {
			t.Fatalf("late=%v: this run's visits %v", late, ids)
		}
		if got := Cells(s, "", new(bool)); len(got) != 1 {
			t.Fatalf("late=%v: /cells?archived=false lists %d", late, len(got))
		}
		// The metrics keyed by ticket measured every visit of both runs (C1 counts each), when the
		// first run's records come first. Read after the run at work began, they are kept as the
		// earlier run's summary only, never as the run at work's.
		if want := map[bool]int{false: 5, true: 3}[late]; len(c.Visits) != want {
			t.Fatalf("late=%v: the cell's visits for the metrics: %d, want %d", late, len(c.Visits), want)
		}
	}
}

// cleanup.archive kept nothing of the first run: its only traces are its run record and the
// intake's records. Whichever is read first, the run at work is at work and the run record is the
// earlier run's, with its cell instance not recorded.
func TestReissuedTicketWithNoArchiveOfTheFirstRun(t *testing.T) {
	var second []map[string]any
	var runRecord map[string]any
	for _, e := range reissuedSix(false) {
		inst, _ := e["ids"].(map[string]any)["cell_instance"].(string)
		switch {
		case e["type"] == "run.recorded":
			runRecord = e
		case inst == "bbbb2222":
			second = append(second, e)
		}
	}
	claimed := func() map[string]any {
		return feedtest.New("intake-log", "work.claimed", 500).Ticket("6").ID("slice_id", "SLICE-002").
			Data(map[string]any{"stage": "spec-ready", "next": "plan", "attempt": 1}).Set("id", "claim").Build()
	}
	for _, late := range []bool{false, true} {
		events := append([]map[string]any{claimed(), runRecord}, second...)
		if late {
			events = append(append([]map[string]any{}, second...), claimed(), runRecord)
		}
		c := m66State(t, events).Cells["6"]
		v := CellSummary(c)
		if v["archived"] != false || v["abandoned"] != false || v["stage"] != "planned" {
			t.Fatalf("late=%v: archived %v abandoned %v stage %v", late, v["archived"], v["abandoned"], v["stage"])
		}
		runs := v["earlier_runs"].([]map[string]any)
		if len(runs) != 1 || runs[0]["cell_instance"] != nil || runs[0]["outcome"] != "abandoned" || runs[0]["run_records"] != 1 {
			t.Fatalf("late=%v: earlier runs %v", late, runs)
		}
	}
}

// A run record written before any record of the ticket's runs closes a run of its own, whose cell
// instance is not recorded: never added to a run it did not close.
func TestRunRecordBeforeEveryRunIsItsOwnRun(t *testing.T) {
	events := reissuedSix(false)
	events = append(events, feedtest.New("run-record", "run.recorded", 500).Ticket("6").ID("slice_id", "SLICE-002").
		Data(map[string]any{"record_version": 2, "outcome": "merged"}).Set("id", "ez").Build())
	c := m66State(t, events).Cells["6"]
	if c.Archived || len(c.EarlierRuns) != 2 || c.EarlierRuns[0].CellInstance != "" || c.EarlierRuns[0].Outcome != "merged" ||
		c.EarlierRuns[1].CellInstance != "aaaa1111" || c.EarlierRuns[1].RunRecords != 1 {
		t.Fatalf("archived %v earlier %+v", c.Archived, c.EarlierRuns)
	}
}
