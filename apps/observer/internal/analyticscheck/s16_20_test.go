package analyticscheck

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mach/observer/internal/testkit"
)

// Scenario 16: observer restart and index rebuild. The answers after a restart over the same index
// are identical byte for byte apart from generated_ms (cursors included); after the projection is
// discarded and replayed from the index, the same; after the index itself is rebuilt, identical
// apart from the cursor's epoch and positions.
func TestS16RestartAndRebuild(t *testing.T) {
	f := newFx(t)
	dupHistory(f)
	f.happyCell("T-2", "", 2*hour, "High", "web")
	f.run("T-2", at(3*hour), map[string]any{"risk": "High", "app_type": "web", "first_pass": false, "rounds": 2})
	index := t.TempDir()
	first := open(t, f.root, index)
	read := func(o *obs) map[string]string {
		out := map[string]string{}
		for _, p := range analyticsPaths {
			code, b := o.raw(p)
			if code != 200 {
				t.Fatalf("%s: %d", p, code)
			}
			out[p] = stripGenerated(b)
		}
		return out
	}
	before := read(first)
	cursor := cursorOf([]byte(before[analyticsPaths[0]]))
	first.close()

	// Restart over the same index and saved projection.
	second := open(t, f.root, index)
	after := read(second)
	sameAnswers(t, "restart", before, after)
	if _, head := second.st.Bounds(); cursorOf([]byte(after[analyticsPaths[0]])) != cursor {
		t.Errorf("restart moved the head to %d (cursor was %s): sources were re-read", head, cursor)
	}
	// The old cursor still answers the same.
	sameAt(t, second, analyticsPaths[0], cursor, before[analyticsPaths[0]])
	second.close()

	// The saved projection discarded: replayed from the index.
	if err := os.RemoveAll(filepath.Join(index, "projection")); err != nil {
		t.Fatal(err)
	}
	third := open(t, f.root, index)
	sameAnswers(t, "projection replayed", before, read(third))
	third.close()

	// The index rebuilt from the sources: a new epoch; every figure the same.
	rebuilt := answers(t, open(t, f.root, t.TempDir()))
	// Delivery positions ("pos" in stamps) belong to an index, not to the history: left out.
	norm := map[string]string{}
	for p, s := range before {
		norm[p] = strings.ReplaceAll(stripKeys([]byte(s), "pos"), cursor, "<cursor>")
	}
	sameAnswers(t, "index rebuilt", norm, rebuilt)
}

// Scenario 17: superseded product revisions. SLICE-017 revision 1 is dispatched to T-17 and
// superseded during build; revision 2 is dispatched to T-17b, merged and integrated.
func TestS17SupersededRevision(t *testing.T) {
	f := newFx(t)
	w, s := "WAVE-017", "SLICE-017"
	f.slice(s, "T-17", w, 1)
	f.intake(
		L{At: at(0), Type: "wave.discovered", Wave: w, Source: "intake", Data: M{"slices": []string{s}}},
		L{At: at(10 * sec), Type: "slice.materialized", Wave: w, Slice: s, Rev: 1, Ticket: "T-17", Source: "intake", Data: M{"dependencies": []string{}}},
		L{At: at(1 * min_), Type: "work.scheduled", Wave: w, Slice: s, Rev: 1, Ticket: "T-17", Data: M{"stage": "spec-ready", "risk": "Medium"}},
		L{At: at(20 * min_), Type: "revision.superseded", Wave: w, Slice: s, Rev: 1, Ticket: "T-17", Source: "intake", Data: M{"from_revision": 1, "effect": "flagged"}},
		L{At: at(21 * min_), Type: "slice.materialized", Wave: w, Slice: s, Rev: 2, Ticket: "T-17b", Source: "intake", Data: M{"dependencies": []string{}}},
		L{At: at(22 * min_), Type: "work.scheduled", Wave: w, Slice: s, Rev: 2, Ticket: "T-17b", Data: M{"stage": "spec-ready", "risk": "Medium"}},
	)
	f.lifecycle("T-17", append(planVisit(at(70*sec), at(100*sec), "Medium", "cli"), visit("build", 1, 1, "", at(3*min_), at(13*min_), "built")...)...)
	f.run("T-17", at(25*min_), map[string]any{"outcome": "abandoned", "first_pass": false, "integration": nil})
	f.slice(s, "T-17b", w, 2)
	f.happyCell("T-17b", "", 21*min_, "Medium", "cli")
	f.intake(L{At: at(60 * min_), Type: "slice.integrated", Wave: w, Slice: s, Rev: 2, Ticket: "T-17b", Source: "intake", Data: M{"commit": "fedcba987654"}})
	f.run("T-17b", at(62*min_), nil)
	o := observe(f)
	d := o.metrics(allIDs(), "")
	// One slice integrated (revision 2): T2 = 1. One ticket merged: T1 = 1. T3 is deferred.
	fig(t, "T2", metric(t, d, "T2"), f64(1), f64(1), none, f64(1))
	fig(t, "T1", metric(t, d, "T1"), f64(1), f64(1), none, f64(1))
	fig(t, "T3", metric(t, d, "T3"), none, none, none, nil)
	// C4: revision 2 became eligible when materialized, 09:21:00.999, integrated 10:00:00.999:
	// 39 min = 2,340,000. Revision 1's history does not stretch it.
	fig(t, "C4", metric(t, d, "C4"), f64(2340000), f64(2340000), f64(1), f64(1))
	// W2: each revision was dispatched once: rev 1 09:00:10 -> 09:01:00 = 50,000; rev 2
	// 09:21:00 -> 09:22:00 = 60,000. 110,000 / 2 dispatches.
	fig(t, "W2", metric(t, d, "W2"), f64(55000), f64(110000), f64(2), f64(2))
	// C3: T-17b dispatched 09:22:00.999, merged at 21 min + 32 min = 09:53:00.000: 31 min - 999.
	fig(t, "C3", metric(t, d, "C3"), f64(1859001), f64(1859001), f64(1), f64(1))
	// R6: 1 abandoned / 2 finished. Q2: 1/1 merged first pass.
	fig(t, "R6", metric(t, d, "R6"), f64(0.5), f64(1), f64(2), f64(2))
	fig(t, "Q2", metric(t, d, "Q2"), f64(1), f64(1), f64(1), f64(1))
	common(t, o)
}

// Scenario 18: historical backfill. The observer starts over a history already on disk, then the
// rest arrives live. Every answer equals that of an observer that read the whole history as
// backfill, and a cursor taken at the end of backfill answers the same after the live part.
func TestS18Backfill(t *testing.T) {
	f := newFx(t)
	f.product("WAVE-001", "SLICE-001", "T-1", at(0), at(1*min_), "Medium")
	f.happyCell("T-1", X1, 0, "Medium", "cli")
	f.supervised("T-1", X1, at(2*min_), at(40*min_+5*sec), at(40*min_+30*sec), 1.25)
	o := observe(f)
	cursorStable(t, o, func() {
		f.intake(L{At: at(45 * min_), Type: "slice.integrated", Wave: "WAVE-001", Slice: "SLICE-001", Ticket: "T-1", Source: "intake", Data: M{"commit": "fedcba987654"}})
		f.run("T-1", at(50*min_), nil)
		f.product("WAVE-002", "SLICE-002", "T-2", at(1*hour), at(1*hour+min_), "Low")
		f.happyCell("T-2", X2, 1*hour, "Low", "api")
		f.supervised("T-2", X2, at(1*hour+2*min_), at(1*hour+40*min_), at(1*hour+41*min_), 0.75)
	}, analyticsPaths...)
	live := answers(t, o)
	fresh := answers(t, observe(f))
	sameAnswers(t, "backfill then live, against backfill only", fresh, live)
	d := o.metrics("T1,T2,C1,K1", "")
	// T1 2, T2 1 (only SLICE-001 integrated), C1 10 visits, K1 (1.25 + 0.75) / 2 = 1.
	fig(t, "T1", metric(t, d, "T1"), f64(2), f64(2), none, f64(2))
	fig(t, "T2", metric(t, d, "T2"), f64(1), f64(1), none, f64(1))
	fig(t, "C1", metric(t, d, "C1"), f64(324000), f64(3240000), f64(10), f64(10))
	fig(t, "K1", metric(t, d, "K1"), f64(1), f64(2), f64(2), f64(2))
	common(t, o)
}

// Scenario 19: mismatched source versions. A lifecycle log written before the judging round was
// called round (it says attempt); a run record of record_version 1 without risk and test counts;
// a run record whose outcome is not one the observer knows; a stream from an unproven Claude Code
// version; an unreadable intake line and a run record with an unusable ticket id.
func TestS19MismatchedVersions(t *testing.T) {
	f := newFx(t)
	b := at(0)
	old := func(r R) []byte {
		return testkit.Record{At: r.At.UTC().Format("2006-01-02T15:04:05.000Z"), Ticket: "T-19a", Type: r.Type, Station: r.Station, Visit: 1, Round: r.Round, Data: r.Data, OldRound: true}.Line()
	}
	f.cellJSON("T-19a", "", nil)
	var buf []byte
	for _, r := range visit("verify", 1, 1, "", b.Add(1*min_), b.Add(5*min_), "PASS", verdict(b.Add(4*min_), "PASS")) {
		buf = append(buf, old(r)...)
	}
	testkit.Append(t, testkit.CellLog(f.root, "T-19a"), buf)
	f.run("T-19a", at(10*min_), nil)
	f.run("T-19b", at(11*min_), map[string]any{"record_version": 1, "risk": nil, "app_type": nil, "tests_seen_failing_first": nil,
		"tests_passing_on_first_run": nil, "integration": nil})
	f.run("T-19c", at(12*min_), map[string]any{"outcome": "paused"})
	f.run("bad ticket!", at(13*min_), nil)
	testkit.Append(t, filepath.Join(f.root, ".factory", "archive", "runs.jsonl"), []byte("{not json\n"))
	f.supervised("T-19d", X1, at(20*min_), at(30*min_), at(30*min_+5*sec), 0.2)
	f.rawIntake([]byte("{\"schema_version\": 2, \"seq\": \n"))
	f.seq++ // the torn line held a seq
	f.intake(L{At: at(31 * min_), Type: "human.required", Ticket: "T-19d", Data: M{"reason": "x"}})
	f.usage(X1, at(30*min_), 0.2, U{Model: "claude-sonnet-5-5", Cost: 0.2, Input: 1, Output: 1, CacheRead: 1, CacheCreation: 1})
	// the stream's init says an unproven version
	sp := filepath.Join(testkit.ExecDir(f.root, X1), "stream.jsonl")
	sb, _ := os.ReadFile(sp)
	testkit.WriteFile(t, sp, []byte(strings.Replace(string(sb), "2.1.322", "2.1.999", 1)))
	o := observe(f)
	d := o.metrics(allIDs(), "")
	// Q1: the old log's round (written as attempt) is round 1: 1/1.
	fig(t, "Q1", metric(t, d, "Q1"), f64(1), f64(1), f64(1), f64(1))
	// Runs read: T-19a merged, T-19b merged (version 1), T-19c outcome not understood (observe:
	// neither merged nor abandoned). Q2 = 2 first-pass / 2 merged; R6 = 0/3 finished.
	q2 := metric(t, d, "Q2")
	fig(t, "Q2", q2, f64(1), f64(2), f64(2), f64(2))
	fig(t, "R6", metric(t, d, "R6"), f64(0), f64(0), f64(3), f64(3))
	// The refused run records (an unusable ticket id, a line that is not JSON) are counted in
	// coverage, never silently dropped: 2.
	if ex := excluded(q2); ex["source records the observer refused (an unreadable line, or an identifier outside its pattern)"] != 2 {
		t.Errorf("Q2 coverage excluded %v (two run records refused)", ex)
	}
	// G1: tests counts from version 2 records only: T-19a 2/2, T-19c 2/2 = 4/4; T-19b has none and
	// is not a zero.
	fig(t, "G1", metric(t, d, "G1"), f64(1), f64(4), f64(4), f64(4))
	// Grouped by risk: T-19b recorded none: its own "unknown" group, never merged into another.
	q2r := metric(t, o.metrics("Q2", "&group_by=risk"), "Q2")
	fig(t, "Q2 unknown risk", group(t, q2r, "risk=unknown"), f64(1), f64(1), f64(1), f64(1))
	fig(t, "Q2 Medium", group(t, q2r, "risk=Medium"), f64(1), f64(1), f64(1), f64(1))
	// The stream from an unproven version still counts its recorded usage: K2 0.20 / 1.
	fig(t, "K2", metric(t, d, "K2"), f64(0.2), f64(0.2), f64(1), f64(1))
	// The torn intake line: counted against intake metrics' coverage.
	if ex := excluded(metric(t, d, "X1")); ex["source records the observer refused (an unreadable line, or an identifier outside its pattern)"] != 1 {
		t.Errorf("X1 coverage excluded %v (one intake line unreadable)", ex)
	}
	if h := obj(d["history"]); h["complete"] != false {
		t.Errorf("history %v: an unreadable line loses history", h)
	}
	common(t, o)
}

// Scenario 20: archived completed runs. T-20's cell was cleaned up: its folder is gone; the archive
// holds its lifecycle log with cleanup's own visit; the run record is in runs.jsonl. The figures are
// those of the live cell plus the cleanup visit.
func TestS20Archived(t *testing.T) {
	f := newFx(t)
	f.product("WAVE-001", "SLICE-001", "T-20", at(0), at(1*min_), "Medium")
	f.happyCell("T-20", X1, 0, "Medium", "cli")
	f.supervised("T-20", X1, at(2*min_), at(40*min_+5*sec), at(40*min_+30*sec), 1.25)
	f.intake(L{At: at(45 * min_), Type: "slice.integrated", Wave: "WAVE-001", Slice: "SLICE-001", Ticket: "T-20", Source: "intake", Data: M{"commit": "fedcba987654"}})
	// cleanup 09:46:00 .. 09:46:20 (20,000 ms), recorded only in the archived copy.
	f.lifecycle("T-20", visit("cleanup", 1, 0, "", at(46*min_), at(46*min_+20*sec), "archived",
		R{At: at(46*min_ + 10*sec), Type: "cleanup.completed", Data: M{"outcome": "merged", "archive": "T-20.tar.gz", "bundle": false}})...)
	life, _ := os.ReadFile(testkit.CellLog(f.root, "T-20"))
	cj, _ := os.ReadFile(filepath.Join(testkit.CellDir(f.root, "T-20"), "cell.json"))
	testkit.WriteArchive(t, filepath.Join(f.root, ".factory", "archive", "T-20.tar.gz"), "T-20", map[string][]byte{"lifecycle.jsonl": life, "cell.json": cj})
	if err := os.RemoveAll(testkit.CellDir(f.root, "T-20")); err != nil {
		t.Fatal(err)
	}
	f.run("T-20", at(47*min_), nil)
	o := observe(f)
	d := o.metrics(allIDs(), "")
	// C1: 1,620,000 + cleanup 20,000 = 1,640,000 over 6 visits.
	fig(t, "C1", metric(t, d, "C1"), f64(1640000.0/6), f64(1640000), f64(6), f64(6))
	fig(t, "C2", metric(t, d, "C2"), f64(6), f64(6), f64(1), f64(1))
	fig(t, "T1", metric(t, d, "T1"), f64(1), f64(1), none, f64(1))
	fig(t, "T2", metric(t, d, "T2"), f64(1), f64(1), none, f64(1))
	fig(t, "Q1", metric(t, d, "Q1"), f64(1), f64(1), f64(1), f64(1))
	fig(t, "Q2", metric(t, d, "Q2"), f64(1), f64(1), f64(1), f64(1))
	fig(t, "R1", metric(t, d, "R1"), f64(0), f64(0), f64(1), f64(1))
	fig(t, "C3", metric(t, d, "C3"), f64(1859001), f64(1859001), f64(1), f64(1))
	fig(t, "K1", metric(t, d, "K1"), f64(1.25), f64(1.25), f64(1), f64(1))
	// The archived cell is listed among runs, with its execution.
	runs := o.get("/api/v1/analytics/runs")
	if runs["total"].(float64) != 1 || obj(arr(runs["items"])[0])["ticket_id"] != "T-20" {
		t.Errorf("runs %s", show(runs["items"]))
	}
	flow := o.get("/api/v1/analytics/flow")
	if tr := transitions(flow); tr["merge->cleanup"] != 1 {
		t.Errorf("transitions %v", tr)
	}
	common(t, o)
}
