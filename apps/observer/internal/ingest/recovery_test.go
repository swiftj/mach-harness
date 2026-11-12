package ingest

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"mach/observer/internal/event"
	"mach/observer/internal/testkit"
)

// project builds a small but complete Factory: intake log, two cells, an execution with the
// real belt stream, a run record.
func project(t *testing.T, root string, streamLines int) {
	for _, line := range intakeSample() {
		testkit.Append(t, testkit.LedgerPath(root), line)
	}
	cell(t, root, "T-9", cellRecords("T-9"))
	data, _ := os.ReadFile(filepath.Join("..", "normalize", "testdata", "lifecycle-helper.jsonl"))
	testkit.WriteFile(t, filepath.Join(testkit.CellDir(root, "LOCAL-001"), "cell.json"), mustJSON(map[string]any{"stage": "merged", "created_at": "2026-11-12T20:55:40+00:00"}))
	testkit.Append(t, testkit.CellLog(root, "LOCAL-001"), data)
	execution(t, root, x1, "belt-build-verify-review.jsonl", streamLines < 0)
	if streamLines > 0 {
		p := filepath.Join(testkit.ExecDir(root, x1), "stream.jsonl")
		b, _ := os.ReadFile(p)
		lines := strings.SplitAfter(string(b), "\n")
		os.WriteFile(p, []byte(strings.Join(lines[:streamLines], "")), 0o644)
	}
}

type fingerprint struct{ id, order, hash string }

func prints(h *harness) []fingerprint {
	var out []fingerprint
	for _, e := range h.events() {
		out = append(out, fingerprint{e.ID, e.Order, e.ContentHash()})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].order < out[j].order || out[i].order == out[j].order && out[i].id < out[j].id
	})
	return out
}

func noDuplicateIDs(t *testing.T, h *harness) {
	seen := map[string]bool{}
	for _, e := range h.events() {
		if seen[e.ID] {
			t.Fatalf("duplicate %s", e.ID)
		}
		seen[e.ID] = true
	}
}

func TestRebuildGivesIdenticalIdsAndOrder(t *testing.T) {
	root := testkit.Project(t)
	project(t, root, -1)
	a := newHarness(t, root, filepath.Join(t.TempDir(), "a"), true)
	a.drain()
	b := newHarness(t, root, filepath.Join(t.TempDir(), "b"), false)
	b.drain()
	pa, pb := prints(a), prints(b)
	if a.st.Epoch() == b.st.Epoch() {
		t.Fatal("a rebuild is a new epoch")
	}
	if len(pa) != len(pb) || len(pa) < 100 {
		t.Fatalf("%d vs %d events", len(pa), len(pb))
	}
	for i := range pa {
		if pa[i] != pb[i] {
			t.Fatalf("event %d differs:\n%+v\n%+v", i, pa[i], pb[i])
		}
	}
	a.validate()
}

func TestRestartMidStreamNoDuplicateNoLoss(t *testing.T) {
	ref := testkit.Project(t)
	project(t, ref, -1)
	whole := newHarness(t, ref, "", false)
	whole.drain()
	want := prints(whole)

	root := testkit.Project(t)
	project(t, root, 30)
	dir := filepath.Join(t.TempDir(), "index")
	first := newHarness(t, root, dir, false)
	first.drain()
	if first.st.Head() == 0 {
		t.Fatal("nothing read")
	}
	first.close()
	// The rest of the stream, the process end, and one more lifecycle record arrive while it is down.
	full, _ := os.ReadFile(testkit.StreamFixture("belt-build-verify-review.jsonl"))
	os.WriteFile(filepath.Join(testkit.ExecDir(root, x1), "stream.jsonl"), full, 0o644)
	testkit.WriteFile(t, filepath.Join(testkit.ExecDir(root, x1), "result.json"), mustJSON(map[string]any{"execution_id": x1, "ended": "exited", "exit_code": 0, "ended_at": "2023-11-14T22:20:00Z", "seconds": 402}))
	second := newHarness(t, root, dir, false)
	second.now = first.now
	if second.st.Info().Rebuilt != "" {
		t.Fatalf("the index was rebuilt: %s", second.st.Info().Rebuilt)
	}
	second.drain()
	noDuplicateIDs(t, second)
	got := prints(second)
	if len(got) != len(want) {
		t.Fatalf("%d events after the restart, %d in one pass", len(got), len(want))
	}
	gotIDs := map[string]string{}
	for _, f := range got {
		gotIDs[f.id] = f.hash
	}
	for _, f := range want {
		if h, ok := gotIDs[f.id]; !ok {
			t.Fatalf("lost %s", f.id)
		} else if h != f.hash {
			t.Fatalf("%s says something else after the restart", f.id)
		}
	}
	if second.o.Stats().Suppressed == 0 {
		t.Fatal("the committed lines were not replayed")
	}
	second.validate()
}

func TestCrashBetweenLogAndCheckpointsRepeatsNothing(t *testing.T) {
	root := testkit.Project(t)
	project(t, root, 40)
	dir := filepath.Join(t.TempDir(), "index")
	h := newHarness(t, root, dir, false)
	h.drain()
	old, _ := os.ReadFile(filepath.Join(dir, "checkpoints.json"))
	for _, line := range [][]byte{v2(24, "human.required", "intake", "", "", map[string]any{"reason": "more"})} {
		testkit.Append(t, testkit.LedgerPath(root), line)
	}
	full, _ := os.ReadFile(testkit.StreamFixture("belt-build-verify-review.jsonl"))
	os.WriteFile(filepath.Join(testkit.ExecDir(root, x1), "stream.jsonl"), full, 0o644)
	h.drain()
	head := h.st.Head()
	h.close()
	os.WriteFile(filepath.Join(dir, "checkpoints.json"), old, 0o600) // the log was synced, the checkpoints were not
	again := newHarness(t, root, dir, false)
	again.drain()
	noDuplicateIDs(t, again)
	if again.st.Head() != head {
		t.Fatalf("head %d, want %d: repeated or lost events", again.st.Head(), head)
	}
}

func TestArchiveCatchUpKeepsIDs(t *testing.T) {
	root := testkit.Project(t)
	recs := cellRecords("T-9")
	cell(t, root, "T-9", recs)
	h := newHarness(t, root, filepath.Join(t.TempDir(), "i"), false)
	h.drain()
	before := map[string]bool{}
	for _, e := range h.events() {
		before[e.ID] = true
	}
	// Cleanup: the decision written after the last poll, then cleanup's own records, only in the archive.
	live, _ := os.ReadFile(testkit.CellLog(root, "T-9"))
	more := []testkit.Record{
		{Seq: 7, At: "2026-11-12T10:00:10.000Z", Ticket: "T-9", Type: "review.decided", Station: "review", Round: 1, Data: map[string]any{"round": 1, "decision": "REJECTED", "approvals": 2, "needed": 3, "votes": map[string]any{"security": "REJECT"}, "blockers": 1, "security_veto": true, "human_approval_required": true}},
		{Seq: 8, At: "2026-11-12T10:00:11.000Z", Ticket: "T-9", Type: "station.exited", Station: "review", Round: 1, Data: map[string]any{"outcome": "abandoned", "closed_by": "cleanup"}},
		{Seq: 9, At: "2026-11-12T10:00:11.000Z", Ticket: "T-9", Type: "gate.evaluated", Station: "cleanup", Data: map[string]any{"gate": "cleanup.run", "outcome": "pass", "reason_code": nil, "overridden_by_reason": false}},
		{Seq: 10, At: "2026-11-12T10:00:11.000Z", Ticket: "T-9", Type: "station.entered", Station: "cleanup", Data: map[string]any{"stage": "approved"}},
		{Seq: 11, At: "2026-11-12T10:00:11.000Z", Ticket: "T-9", Type: "cleanup.completed", Station: "cleanup", Data: map[string]any{"outcome": "abandoned", "archive": ".factory/archive/T-9.tar.gz", "bundle": true, "uncommitted_saved": false}},
		{Seq: 12, At: "2026-11-12T10:00:11.000Z", Ticket: "T-9", Type: "station.exited", Station: "cleanup", Data: map[string]any{"outcome": "abandoned"}},
	}
	archived := append([]byte(nil), live...)
	for _, r := range more {
		archived = append(archived, r.Line()...)
	}
	files := map[string][]byte{"lifecycle.jsonl": archived}
	for _, rel := range []string{"cell.json", "spec.json", "evidence/ac-01.png", "review/round-1/votes/security.json"} {
		files[rel], _ = os.ReadFile(filepath.Join(testkit.CellDir(root, "T-9"), rel))
	}
	files["review/round-1/decision.json"] = mustJSON(map[string]any{"outcome": "REJECTED"})
	testkit.WriteArchive(t, filepath.Join(root, ".factory", "archive", "T-9.tar.gz"), "T-9", files)
	// While the cell folder exists the live log wins and the archive waits.
	h.drain()
	if h.st.Head() != uint64(len(before)) {
		t.Fatal("the archive was read while the cell was live")
	}
	os.RemoveAll(testkit.CellDir(root, "T-9"))
	h.drain()
	h.validate()
	noDuplicateIDs(t, h)
	var fresh []*event.Event
	for _, e := range h.events() {
		if !before[e.ID] {
			fresh = append(fresh, e)
		}
	}
	life := 0
	for _, e := range fresh {
		if e.Origin.Stream == event.StreamLifecycle {
			life++
			if e.Authority != event.Authoritative {
				t.Fatal("an archived record is still authoritative")
			}
		}
	}
	if life != len(more) {
		t.Fatalf("%d new lifecycle events from the archive, want %d", life, len(more))
	}

	// An observer that only ever sees the archive gives the same ids.
	other := testkit.Project(t)
	testkit.WriteArchive(t, filepath.Join(other, ".factory", "archive", "T-9.tar.gz"), "T-9", files)
	o := newHarness(t, other, "", false)
	o.drain()
	o.validate()
	all := map[string]bool{}
	for _, e := range h.events() {
		all[e.ID] = true
	}
	for _, e := range o.events() {
		if e.Origin.Stream == event.StreamLifecycle && !all[e.ID] {
			t.Fatalf("%s from the archive alone is not an id the live read gave", e.ID)
		}
	}
	if len(ofType(o.events(), "cleanup.completed")) != 1 {
		t.Fatal("cleanup's own record")
	}
}

func TestSettleWindowOrdersAcrossSourcesAndMarksLate(t *testing.T) {
	root := testkit.Project(t)
	h := newHarness(t, root, "", true)
	testkit.Append(t, testkit.LedgerPath(root), v2(1, "intake.validated", "intake", "", "", map[string]any{"digest": strings.Repeat("ab", 32)})) // 10:00:00.999
	h.tick()
	testkit.Append(t, testkit.CellLog(root, "T-1"), testkit.Record{Seq: 1, At: "2026-11-12T10:00:00.100Z", Ticket: "T-1", Type: "station.entered", Station: "build", Round: 1, Data: map[string]any{"stage": "building"}}.Line())
	h.tick()
	if h.st.Head() != 0 {
		t.Fatal("committed inside the settle window")
	}
	for i := 0; i < 10; i++ {
		h.tick()
	}
	evs := h.events()
	if len(evs) != 2 || evs[0].Type != "station.entered" || evs[0].Late || evs[1].Late {
		t.Fatalf("history order within the window: %v", ids(evs))
	}
	testkit.Append(t, testkit.CellLog(root, "T-1"), testkit.Record{Seq: 2, At: "2026-11-12T10:00:00.050Z", Ticket: "T-1", Type: "gate.evaluated", Station: "build", Round: 1, Data: map[string]any{"gate": "build.start", "outcome": "pass"}}.Line())
	for i := 0; i < 12; i++ {
		h.tick()
	}
	evs = h.events()
	if len(evs) != 3 || !evs[2].Late || evs[2].Pos != 3 {
		t.Fatalf("a late arrival keeps its pos and is flagged: %+v", evs[2])
	}
	if h.st.Watermark() == 0 {
		t.Fatal("no watermark")
	}
}

func TestRewrittenAndTruncatedLedger(t *testing.T) {
	root := testkit.Project(t)
	for _, line := range intakeSample()[:3] {
		testkit.Append(t, testkit.LedgerPath(root), line)
	}
	h := newHarness(t, root, "", false)
	h.drain()
	n := h.st.Head()
	// Truncated with the same history: read again, nothing repeated, a gap says so.
	os.WriteFile(testkit.LedgerPath(root), intakeSample()[0], 0o644)
	h.drain()
	testkit.Append(t, testkit.LedgerPath(root), intakeSample()[1])
	testkit.Append(t, testkit.LedgerPath(root), intakeSample()[2])
	testkit.Append(t, testkit.LedgerPath(root), intakeSample()[3])
	h.drain()
	evs := h.events()
	if got := len(ofType(evs, "slice.materialized")); got != 1 {
		t.Fatalf("after truncation: %d", got)
	}
	if uint64(len(evs)) != n+2 { // the new line and the truncation gap
		t.Fatalf("%d events, had %d", len(evs), n)
	}
	// Rewritten with other contents: a new generation, new ids.
	os.WriteFile(testkit.LedgerPath(root), v2(1, "human.required", "intake", "", "", map[string]any{"reason": "a new ledger"}), 0o644)
	h.drain()
	h.validate()
	reasons := map[string]int{}
	for _, g := range ofType(h.events(), "history.gap") {
		reasons[g.Data["reason"].(string)]++
	}
	if reasons["truncated"] != 1 || reasons["rewritten"] != 1 || len(ofType(h.events(), "human.required")) != 1 {
		t.Fatalf("%v", reasons)
	}
}

func TestLinkedCellFolderIsIgnored(t *testing.T) {
	root := testkit.Project(t)
	outside := t.TempDir()
	testkit.Append(t, filepath.Join(outside, "lifecycle.jsonl"), testkit.Record{Seq: 1, Ticket: "T-1", Type: "station.entered", Station: "build", Round: 1}.Line())
	if err := os.Symlink(outside, testkit.CellDir(root, "T-1")); err != nil {
		t.Skip(err)
	}
	before := testkit.HashTree(t, root, ".factory/local/observer")
	h := newHarness(t, root, "", false)
	h.drain()
	if h.st.Head() != 0 {
		t.Fatal("a linked cell folder was followed")
	}
	if d := testkit.DiffTrees(before, testkit.HashTree(t, root, ".factory/local/observer")); len(d) > 0 {
		t.Fatalf("the observer changed the project: %v", d)
	}
}
