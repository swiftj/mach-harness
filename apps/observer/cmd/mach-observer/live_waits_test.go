package main

import (
	"encoding/json"
	"testing"
	"time"

	"mach/observer/internal/project"
	"mach/observer/internal/testkit"
)

// Waits found watching a real supervised run (M6.3 live pass): a ready slice the supervisor held
// because its only place was in use, and a dependency wait whose slice is named only in prose.
// Raw intake lines, with the supervisor's and the scheduler's exact sentences, through the real
// normaliser and projection to /spans.

// intakeLine is one intake log line about a slice (and its ticket, when given).
func intakeLine(seq int, at, typ, slice, ticket string, data map[string]any) []byte {
	var sl, tk any
	if slice != "" {
		sl = slice
	}
	if ticket != "" {
		tk = ticket
	}
	line, _ := json.Marshal(map[string]any{"schema_version": 2, "seq": seq, "at": at, "type": typ, "project_id": "P-1", "source_commit": nil,
		"wave_id": "WAVE-001", "slice_id": sl, "revision": 2, "ticket_id": tk, "runner_id": nil, "execution_id": nil,
		"source": "supervisor", "cause": nil, "refs": nil, "data": data})
	return append(line, '\n')
}

func decided(dispatched []any, held ...map[string]any) map[string]any {
	h := []any{}
	for _, x := range held {
		h = append(h, x)
	}
	return map[string]any{"state": "supervised", "dispatched": dispatched, "started": []any{}, "held": h}
}

func spansOf(t *testing.T, r *running, query string, want func([]project.Span) bool) []project.Span {
	t.Helper()
	var reply struct {
		Data struct {
			Items []project.Span `json:"items"`
		} `json:"data"`
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		reply.Data.Items = nil
		json.Unmarshal(r.get(t, "/api/v1/spans?"+query), &reply)
		if want(reply.Data.Items) || time.Now().After(deadline) {
			return reply.Data.Items
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func ms(t *testing.T, s *string) int64 {
	t.Helper()
	if s == nil {
		t.Fatalf("no time")
	}
	v, err := time.Parse(time.RFC3339Nano, *s)
	if err != nil {
		t.Fatal(err)
	}
	return v.UnixMilli()
}

// A ready slice held with "it is ready and waits for a free place: <n> of <limit> in use"
// (supervisor.py waiting_for_a_place) waits for capacity from the first decision that holds it
// (bounded below by the decision before, or the activation) until it is dispatched; a slice
// whose ticket is later held with "all <n> place(s) are in use" is not counted twice.
func TestASliceHeldForAFreePlaceIsACapacityWait(t *testing.T) {
	root := testkit.Project(t)
	free := func(slice, why string) map[string]any { return map[string]any{"slice_id": slice, "why": why} }
	var lines []byte
	for _, l := range [][]byte{
		intakeLine(1, "2026-11-13T16:52:43Z", "slice.materialized", "SLICE-001", "LOCAL-001", map[string]any{"adopted": false, "dependencies": []any{}, "digest": "a"}),
		intakeLine(2, "2026-11-13T16:52:43Z", "slice.materialized", "SLICE-002", "LOCAL-002", map[string]any{"adopted": false, "dependencies": []any{}, "digest": "b"}),
		intakeLine(3, "2026-11-13T16:52:43Z", "slice.materialized", "SLICE-004", "LOCAL-004", map[string]any{"adopted": false, "dependencies": []any{}, "digest": "c"}),
		intakeLine(4, "2026-11-13T16:54:57Z", "factory.activated", "", "", map[string]any{"autonomy": "supervised", "limits": map[string]any{"max_parallel": 1}, "allow_merge": false, "persistent": false}),
		intakeLine(5, "2026-11-13T16:55:02Z", "work.scheduled", "SLICE-001", "LOCAL-001", map[string]any{"stage": "spec-ready", "risk": "Medium", "branch": "feature/LOCAL-001"}),
		// The plan counted the places before the one just taken: "0 of 1" (recorded as written).
		intakeLine(6, "2026-11-13T16:55:02Z", "scheduling.decided", "", "", decided([]any{"SLICE-001"},
			free("SLICE-002", "it is ready and waits for a free place: 0 of 1 in use"),
			free("SLICE-004", "it is ready and waits for a free place: 0 of 1 in use"))),
		// Held for another reason: not a capacity wait.
		intakeLine(7, "2026-11-13T17:00:32Z", "scheduling.decided", "", "", decided([]any{},
			free("SLICE-002", "it is ready and waits for a free place: 1 of 1 in use"),
			map[string]any{"slice_id": "SLICE-004", "ticket_id": "LOCAL-004", "why": "all 1 place(s) are in use"},
			free("SLICE-009", "it was already waiting when the Factory was enabled, and was left to the engineer"))),
		intakeLine(8, "2026-11-13T17:05:00Z", "work.scheduled", "SLICE-002", "LOCAL-002", map[string]any{"stage": "spec-ready", "risk": "Medium", "branch": "feature/LOCAL-002"}),
	} {
		lines = append(lines, l...)
	}
	testkit.Append(t, testkit.LedgerPath(root), lines)
	r := launch(t, root)
	defer r.stop(t)
	items := spansOf(t, r, "kinds=capacity-wait", func(s []project.Span) bool {
		closed := 0
		for _, sp := range s {
			if sp.End != nil && sp.Entity != "cell:LOCAL-004" {
				closed++
			}
		}
		return closed >= 2
	})
	byEntity := map[string][]project.Span{}
	for _, sp := range items {
		byEntity[sp.Entity] = append(byEntity[sp.Entity], sp)
	}
	if len(items) != 3 || len(byEntity["slice:SLICE-002"]) != 1 || len(byEntity["slice:SLICE-004"]) != 1 || len(byEntity["cell:LOCAL-004"]) != 1 {
		t.Fatalf("want one wait for SLICE-002, one for SLICE-004 and LOCAL-004's own: %+v", items)
	}
	sp := byEntity["slice:SLICE-002"][0]
	if sp.IDs["slice_id"] != "SLICE-002" || sp.IDs["wave_id"] != "WAVE-001" || sp.IDs["ticket_id"] != "" || sp.Authority != "reconstructed" || sp.Parent == nil || *sp.Parent != "slice:SLICE-002" {
		t.Fatalf("ids, authority, parent: %+v", sp)
	}
	if sp.Attrs.Limit == nil || *sp.Attrs.Limit != 1 || len(sp.Attrs.Reasons) != 1 || sp.Attrs.Reasons[0] != "it is ready and waits for a free place: 1 of 1 in use" {
		t.Fatalf("attrs: %+v", sp.Attrs)
	}
	// The start: sampled by the decision at 16:55:02, not before the activation at 16:54:57.
	if sp.Start.Precision != "bounded" || sp.Start.Rule != "held-sentence" || ms(t, sp.Start.At) != ms(t, ptrS("2026-11-13T16:55:02.999Z")) ||
		ms(t, sp.Start.NotBefore) != ms(t, ptrS("2026-11-13T16:54:57Z")) || ms(t, sp.Start.NotAfter) != ms(t, ptrS("2026-11-13T16:55:02.999Z")) {
		t.Fatalf("start %+v", sp.Start)
	}
	// The end: dispatched at 17:05:00, after the last decision that held it (17:00:32).
	if sp.End == nil || sp.End.Precision != "bounded" || ms(t, sp.End.NotBefore) != ms(t, ptrS("2026-11-13T17:00:32Z")) || ms(t, sp.End.NotAfter) != ms(t, ptrS("2026-11-13T17:05:00.999Z")) {
		t.Fatalf("end %+v", sp.End)
	}
	if sp.Duration.Basis != "bounded" || sp.Duration.MS != nil {
		t.Fatalf("a sampled wait is never measured: %+v", sp.Duration)
	}
	// SLICE-004: its ticket was held for a place at 17:00:32, so the slice's own wait ends there and the ticket's begins: never both.
	sw, tw := byEntity["slice:SLICE-004"][0], byEntity["cell:LOCAL-004"][0]
	if sw.End == nil || tw.End != nil || ms(t, sw.End.At) > ms(t, tw.Start.At) || ms(t, sw.End.NotBefore) != ms(t, ptrS("2026-11-13T16:55:02Z")) {
		t.Fatalf("slice %+v / ticket %+v", sw.End, tw.Start)
	}
}

// dependency.blocked names what a slice waits on only in its sentences; the wait span names the
// slice's recorded dependencies that those sentences name, never one they do not.
func TestADependencyWaitNamesTheRecordedDependency(t *testing.T) {
	root := testkit.Project(t)
	var lines []byte
	for _, l := range [][]byte{
		intakeLine(1, "2026-11-13T16:52:43Z", "slice.materialized", "SLICE-003", "LOCAL-003", map[string]any{"adopted": false, "dependencies": []any{"SLICE-001", "SLICE-007"}, "digest": "c"}),
		intakeLine(2, "2026-11-13T16:52:43Z", "dependency.blocked", "SLICE-003", "LOCAL-003", map[string]any{"reasons": []any{"It waits for SLICE-001 to be integrated (now queued)."}}),
	} {
		lines = append(lines, l...)
	}
	testkit.Append(t, testkit.LedgerPath(root), lines)
	r := launch(t, root)
	defer r.stop(t)
	items := spansOf(t, r, "kinds=slice-wait", func(s []project.Span) bool { return len(s) > 0 })
	if len(items) != 1 || len(items[0].Attrs.DependsOn) != 1 || items[0].Attrs.DependsOn[0] != "SLICE-001" {
		t.Fatalf("want one wait on SLICE-001 (SLICE-007 is not named): %+v", items)
	}
}

func ptrS(s string) *string { return &s }
