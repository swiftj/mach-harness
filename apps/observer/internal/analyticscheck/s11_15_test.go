package analyticscheck

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/testkit"
)

// Scenario 11: unknown execution outcomes. X1 started a process that left no result and the
// supervisor recorded outcome-unknown; X2 then ran the ticket to the end. X3 was interrupted (its
// process record says so) before an outcome-unknown recovery. X4 got two outcome-unknown
// recoveries.
func TestS11UnknownOutcomes(t *testing.T) {
	f := newFx(t)
	claim := func(tk, x string, c time.Time) {
		f.intake(L{At: c, Type: "work.claimed", Ticket: tk, Exec: x, Data: M{"stage": "planned", "next": "build", "attempt": 1}},
			L{At: c.Add(sec), Type: "execution.started", Ticket: tk, Exec: x, Data: M{"until": "merge", "workflow": "mach-belt"}})
	}
	recovery := func(tk, x string, at time.Time) L {
		return L{At: at, Type: "recovery.started", Ticket: tk, Exec: x, Data: M{"kind": "outcome-unknown"}}
	}
	// The intake log is written in time order (an append-only log never goes back in time).
	claim("T-11a", X1, at(0))
	f.exec(X1, "T-11a", at(5*sec), time.Time{}, "", nil)
	claim("T-11b", X3, at(1*min_))
	f.exec(X3, "T-11b", at(1*min_+5*sec), at(10*min_), "interrupted", nil)
	claim("T-11c", X4, at(2*min_))
	f.exec(X4, "T-11c", at(2*min_+5*sec), time.Time{}, "", nil)
	f.intake(recovery("T-11a", X1, at(30*min_)), recovery("T-11b", X3, at(31*min_)), recovery("T-11c", X4, at(32*min_)), recovery("T-11c", X4, at(33*min_)))
	f.supervised("T-11a", X2, at(35*min_), at(50*min_), at(50*min_+10*sec), 0.3)
	o := observe(f)
	d := o.metrics(allIDs(), "")
	// 4 executions claimed. Outcome unknown (catalog: "executions closed unknown"; the projection's
	// state): X1 and X4 = 2. X3 was interrupted: its process says how it stopped. S2 = 2/4 = 0.5.
	// X4's second recovery is a second event about the same execution, not a second execution.
	fig(t, "S2", metric(t, d, "S2"), f64(0.5), f64(2), f64(4), f64(4))
	if c := o.contributors("S2", ""); !sameSet(refs(c), []string{"execution:" + X1, "execution:" + X4}) {
		t.Errorf("S2 contributors %v", refs(c))
	}
	// S1 counts recovery events: 4 / 4 executions claimed = 1.
	fig(t, "S1", metric(t, d, "S1"), f64(1), f64(4), f64(4), f64(4))
	// S3: only X2 reached execution.completed, nothing failed: 1/1. X1: 0/4.
	fig(t, "S3", metric(t, d, "S3"), f64(1), f64(1), f64(1), f64(1))
	fig(t, "X1", metric(t, d, "X1"), f64(0), f64(0), f64(4), f64(4))
	// W4: every claim has a process start, 5,000 each: 4 measured.
	fig(t, "W4", metric(t, d, "W4"), f64(5000), f64(20000), f64(4), f64(4))
	// K1: one execution with a recorded cost (X2, 0.30). The three without a result have no cost
	// and are excluded from the figure, and the coverage says so: eligible 4, counted 1.
	k1 := metric(t, d, "K1")
	fig(t, "K1", k1, f64(0.3), f64(0.3), f64(1), f64(1))
	cov := obj(k1["coverage"])
	eqNum(t, "K1 coverage eligible", cov["eligible"], f64(4))
	eqNum(t, "K1 coverage counted", cov["counted"], f64(1))
	// The execution listing agrees: X1 and X4 unknown, X3 interrupted.
	states := map[string]string{}
	for _, it := range arr(o.contributors("executions", "")["items"]) {
		states[obj(it)["ref"].(string)] = obj(obj(it)["group"])["state"].(string)
	}
	if states["execution:"+X1] != "unknown" || states["execution:"+X4] != "unknown" || states["execution:"+X3] != "interrupted" || states["execution:"+X2] != "finished" {
		t.Errorf("states %v", states)
	}
	common(t, o)
}

// Scenario 12: incomplete or missing Claude usage records.
//
//	X1: completed, cost 1.00, usage: sonnet 1.00 (10/20/30/40 tokens)
//	X2: completed, cost 0.50, no stream at all (no usage)
//	X3: completed, cost 0.70, usage: sonnet 0.70 (1/1/1/1), opus with tokens and no cost (2/2/2/2)
//	X4: completed with no cost recorded, usage: haiku 0.05 (5/5/5/5)
func TestS12IncompleteUsage(t *testing.T) {
	f := newFx(t)
	f.supervised("T-12a", X1, at(0), at(10*min_), at(10*min_+5*sec), 1.0)
	f.usage(X1, at(10*min_), 1.0, U{Model: "claude-sonnet-5-5", Cost: 1.0, Input: 10, Output: 20, CacheRead: 30, CacheCreation: 40})
	f.supervised("T-12b", X2, at(1*min_), at(11*min_), at(11*min_+5*sec), 0.5)
	f.supervised("T-12c", X3, at(2*min_), at(12*min_), at(12*min_+5*sec), 0.7)
	f.usage(X3, at(12*min_), 0.7, U{Model: "claude-sonnet-5-5", Cost: 0.7, Input: 1, Output: 1, CacheRead: 1, CacheCreation: 1},
		U{Model: "claude-opus-5-5", Input: 2, Output: 2, CacheRead: 2, CacheCreation: 2})
	f.supervised("T-12d", X4, at(3*min_), at(13*min_), at(13*min_+5*sec), nil)
	f.usage(X4, at(13*min_), nil, U{Model: "claude-haiku-5-5", Cost: 0.05, Input: 5, Output: 5, CacheRead: 5, CacheCreation: 5})
	o := observe(f)
	d := o.metrics(allIDs(), "")
	// K1: (1.00 + 0.50 + 0.70) / 3 = 0.7333…; X4 is excluded (no recorded cost), never a zero.
	k1 := metric(t, d, "K1")
	fig(t, "K1", k1, f64(2.2/3), f64(2.2), f64(3), f64(3))
	if ex := excluded(k1); ex["completed with no recorded cost"] != 1 {
		t.Errorf("K1 excluded %v", ex)
	}
	// K4: the same three tickets, 2.2 / 3.
	fig(t, "K4", metric(t, d, "K4"), f64(2.2/3), f64(2.2), f64(3), f64(3))
	// K2: execution-model pairs with a cost: X1 sonnet 1.00, X3 sonnet 0.70, X4 haiku 0.05 =
	// 1.75 / 3. X3's opus usage has no cost: excluded with its reason. X2 has no usage: no pair.
	k2 := metric(t, d, "K2")
	fig(t, "K2", k2, f64(1.75/3), f64(1.75), f64(3), f64(3))
	if ex := excluded(k2); ex["the model's usage carries no cost"] != 1 {
		t.Errorf("K2 excluded %v", ex)
	}
	k2m := metric(t, o.metrics("K2", "&group_by=model"), "K2")
	fig(t, "K2 sonnet", group(t, k2m, "model=claude-sonnet-5-5"), f64(0.85), f64(1.7), f64(2), f64(2))
	// K3: tokens by pair: X1 sonnet 100, X3 sonnet 4, X3 opus 8, X4 haiku 20 = 132 / 4 pairs = 33.
	fig(t, "K3", metric(t, d, "K3"), f64(33), f64(132), f64(4), f64(4))
	// The run listing: X2 recorded no usage (recorded false), never a zero.
	runs := o.get("/api/v1/analytics/runs?of=executions")
	for _, it := range arr(runs["items"]) {
		im := obj(it)
		u := obj(im["usage"])
		// X2: the supervisor's cost is recorded; no model usage was, and no token total is invented.
		if im["execution_id"] == X2 && (len(arr(u["models"])) != 0 || u["tokens_total"] != nil) {
			t.Errorf("X2 usage %v", u)
		}
		if im["execution_id"] == X1 && u["recorded"] != true {
			t.Errorf("X1 usage %v", u)
		}
	}
	// K2 contributors: only executions with usage; X3 counts once with its recorded per-model cost.
	if c := o.contributors("K2", ""); c["total"].(float64) == 0 || strings.Contains(strings.Join(refs(c), ","), X2) {
		t.Errorf("K2 contributors %v", refs(c))
	}
	common(t, o)
}

// Scenario 13: partial lifecycle history. T-13a's log begins part-way (its first record is a
// verification exit with no entry); T-13b has no lifecycle log at all, only its cell.json and run
// record.
func TestS13PartialLifecycle(t *testing.T) {
	f := newFx(t)
	b := at(0)
	recs := []R{{At: b.Add(10 * min_), Type: "station.exited", Station: "verify", Visit: 1, Round: 1, Data: M{"outcome": "PASS", "stage": "verified"}}}
	recs = append(recs, visit("review", 1, 1, "", b.Add(11*min_), b.Add(15*min_), "APPROVED", roundStarted(b.Add(11*min_+sec), 1, "Low", "general"),
		vote(b.Add(12*min_), 1, "general", "APPROVE", 0), decided(b.Add(14*min_), 1, "APPROVED", M{"general": "APPROVE"}, false))...)
	recs = append(recs, visit("merge", 1, 0, "", b.Add(16*min_), b.Add(17*min_), "merged",
		R{At: b.Add(16*min_ + 30*sec), Type: "merge.completed", Data: M{"method": "local", "merge_commit": "fedcba987654"}})...)
	f.lifecycle("T-13a", recs...)
	f.cellJSON("T-13b", "merged", nil)
	f.run("T-13a", at(20*min_), map[string]any{"risk": "Low"})
	f.run("T-13b", at(21*min_), map[string]any{"risk": "Low", "first_pass": false, "rounds": 2})
	o := observe(f)
	d := o.metrics(allIDs(), "")
	// C1: review 240,000 + merge 60,000 = 300,000 over 2 measured. The verify visit has no
	// recorded start: unknown, counted apart.
	c1 := metric(t, d, "C1")
	fig(t, "C1", c1, f64(150000), f64(300000), f64(2), f64(2))
	if b := basis(c1); b["unknown"].(float64) != 1 {
		t.Errorf("C1 basis %v (the verify visit with no entry is unknown)", b)
	}
	// Run records cover both tickets: Q2 1/2, Q3 (1 + 2)/2 = 1.5.
	fig(t, "Q2", metric(t, d, "Q2"), f64(0.5), f64(1), f64(2), f64(2))
	fig(t, "Q3", metric(t, d, "Q3"), f64(1.5), f64(3), f64(2), f64(2))
	// T1: one merge.completed recorded (T-13a); T-13b's merge is not in any lifecycle record.
	fig(t, "T1", metric(t, d, "T1"), f64(1), f64(1), none, f64(1))
	// C2: T-13a recorded 3 visits (verify known by its exit, review, merge) / 1 ticket with a log.
	fig(t, "C2", metric(t, d, "C2"), f64(3), f64(3), f64(1), f64(1))
	flow := o.get("/api/v1/analytics/flow")
	cov := obj(flow["coverage"])
	if cov["tickets"].(float64) != 2 || cov["tickets_with_lifecycle"].(float64) != 1 {
		t.Errorf("flow coverage %v (two tickets, one with a lifecycle log)", cov)
	}
	if v := station(t, flow, "verify"); v["visits"].(float64) != 1 || obj(obj(v["duration"])["basis"])["unknown"].(float64) != 1 {
		t.Errorf("verify %s", show(v))
	}
	common(t, o)
}

// dupHistory is scenario 2's history.
func dupHistory(f *fx) {
	f.product("WAVE-001", "SLICE-001", "T-1", at(0), at(1*min_), "Medium")
	f.happyCell("T-1", X1, 0, "Medium", "cli")
	f.supervised("T-1", X1, at(2*min_), at(40*min_+5*sec), at(40*min_+30*sec), 1.25)
	f.usage(X1, at(40*min_), 1.25, U{Model: "claude-sonnet-5-5", Cost: 1.0, Input: 10, Output: 20, CacheRead: 30, CacheCreation: 40})
	f.intake(L{At: at(45 * min_), Type: "slice.integrated", Wave: "WAVE-001", Slice: "SLICE-001", Ticket: "T-1", Source: "intake", Data: M{"commit": "fedcba987654"}})
	f.run("T-1", at(50*min_), nil)
}

// analyticsPaths are the replies compared across deliveries.
var analyticsPaths = []string{
	"/api/v1/analytics/metrics?ids=" + allIDs(),
	"/api/v1/analytics/metrics?ids=" + allIDs() + "&group_by=station,risk",
	"/api/v1/analytics/metrics?ids=C1,C3,W2,W4&distribution=1&bucket=day",
	"/api/v1/analytics/flow",
	"/api/v1/analytics/contributors?metric=C1",
	"/api/v1/analytics/contributors?metric=waits",
	"/api/v1/analytics/contributors?metric=executions",
	"/api/v1/analytics/runs",
	"/api/v1/analytics/insights",
}

// answers reads every analytics path, without generated_ms, the cursor and delivery positions
// ("pos" in a stamp): positions differ between two indexes of the same history.
func answers(t *testing.T, o *obs) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, p := range analyticsPaths {
		code, b := o.raw(p)
		if code != 200 {
			t.Fatalf("%s: %d %s", p, code, b)
		}
		s := stripKeys(b, "generated_ms", "pos")
		if c := cursorOf(b); c != "" {
			s = strings.ReplaceAll(s, c, "<cursor>")
		}
		out[p] = s
	}
	return out
}

func sameAnswers(t *testing.T, what string, a, b map[string]string) {
	t.Helper()
	for p, x := range a {
		if b[p] != x {
			var va, vb any
			json.Unmarshal([]byte(x), &va)
			json.Unmarshal([]byte(b[p]), &vb)
			diffs := jsonDiff("", va, vb, nil)
			if len(diffs) > 12 {
				diffs = append(diffs[:12], fmt.Sprintf("… %d more", len(diffs)-12))
			}
			t.Errorf("%s: %s differs:\n  %s", what, p, strings.Join(diffs, "\n  "))
		}
	}
}

// jsonDiff lists the paths at which two decoded JSON documents differ.
func jsonDiff(path string, a, b any, out []string) []string {
	switch x := a.(type) {
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok {
			return append(out, fmt.Sprintf("%s: %s != %s", path, show(a), show(b)))
		}
		keys := map[string]bool{}
		for k := range x {
			keys[k] = true
		}
		for k := range y {
			keys[k] = true
		}
		var ks []string
		for k := range keys {
			ks = append(ks, k)
		}
		sort.Strings(ks)
		for _, k := range ks {
			out = jsonDiff(path+"."+k, x[k], y[k], out)
		}
		return out
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return append(out, fmt.Sprintf("%s: %s != %s", path, clip(show(a)), clip(show(b))))
		}
		for i := range x {
			out = jsonDiff(fmt.Sprintf("%s[%d]", path, i), x[i], y[i], out)
		}
		return out
	}
	if show(a) != show(b) {
		out = append(out, fmt.Sprintf("%s: %s != %s", path, show(a), show(b)))
	}
	return out
}

// Scenario 14: duplicate events. Every intake line written twice (an identical rewrite), and the
// cell archived while its live log is still on disk (the archive holds the same lines plus
// cleanup's own). The analytics equal the same history delivered once.
func TestS14Duplicates(t *testing.T) {
	once := newFx(t)
	dupHistory(once)
	want := answers(t, observe(once))

	dup := newFx(t)
	dupHistory(dup)
	b, err := os.ReadFile(testkit.LedgerPath(dup.root))
	if err != nil {
		t.Fatal(err)
	}
	var doubled []byte
	for _, line := range strings.SplitAfter(string(b), "\n") {
		doubled = append(doubled, line...)
		doubled = append(doubled, line...)
	}
	testkit.WriteFile(t, testkit.LedgerPath(dup.root), doubled)
	life, _ := os.ReadFile(testkit.CellLog(dup.root, "T-1"))
	cellJSON, _ := os.ReadFile(filepath.Join(testkit.CellDir(dup.root, "T-1"), "cell.json"))
	testkit.WriteArchive(t, filepath.Join(dup.root, ".factory", "archive", "T-1.tar.gz"), "T-1", map[string][]byte{"lifecycle.jsonl": life, "cell.json": cellJSON})
	o := observe(dup)
	got := answers(t, o)
	sameAnswers(t, "duplicated delivery", want, got)
	d := o.metrics("T1,T2,C2,X1,K1", "")
	fig(t, "T1", metric(t, d, "T1"), f64(1), f64(1), none, f64(1))
	fig(t, "T2", metric(t, d, "T2"), f64(1), f64(1), none, f64(1))
	fig(t, "C2", metric(t, d, "C2"), f64(5), f64(5), f64(1), f64(1))
	fig(t, "X1", metric(t, d, "X1"), f64(0), f64(0), f64(1), f64(1))
	fig(t, "K1", metric(t, d, "K1"), f64(1.25), f64(1.25), f64(1), f64(1))
	common(t, o)
}

// Scenario 15: late-arriving events. The observer has delivered T-1's merge (09:32) before T-1's
// review records (09:21 to 09:30) are appended; they arrive late. The final answers equal those of
// an observer that read the finished files at once, and a cursor taken before the late lines
// still answers as it did.
func TestS15LateEvents(t *testing.T) {
	f := newFx(t)
	f.product("WAVE-001", "SLICE-001", "T-1", at(0), at(1*min_), "Medium")
	b := T0
	early := planVisit(b.Add(70*sec), b.Add(100*sec), "Medium", "cli")
	early = append(early, visit("build", 1, 1, X1, b.Add(3*min_), b.Add(13*min_), "built", task(b.Add(5*min_), "T1"))...)
	early = append(early, visit("verify", 1, 1, X1, b.Add(14*min_), b.Add(20*min_), "PASS", verdict(b.Add(19*min_), "PASS"))...)
	review := visit("review", 1, 1, X1, b.Add(21*min_), b.Add(30*min_), "APPROVED", roundStarted(b.Add(21*min_+sec), 1, "Medium", "general"),
		vote(b.Add(25*min_), 1, "general", "APPROVE", 0), decided(b.Add(29*min_), 1, "APPROVED", M{"general": "APPROVE"}, false))
	merge := visit("merge", 1, 0, X1, b.Add(31*min_), b.Add(32*min_+30*sec), "merged",
		R{At: b.Add(32 * min_), Type: "merge.completed", Data: M{"method": "local", "merge_commit": "fedcba987654"}})
	f.lifecycle("T-1", early...)
	f.supervised("T-1", X1, at(2*min_), at(40*min_), at(40*min_+30*sec), 1.0)
	f.intake(L{At: at(45 * min_), Type: "slice.integrated", Wave: "WAVE-001", Slice: "SLICE-001", Ticket: "T-1", Source: "intake", Data: M{"commit": "fedcba987654"}})
	o := observe(f)
	// A second ticket's lifecycle, written later in the day, is delivered live first.
	f.lifecycle("T-2", visit("build", 1, 1, "", at(3*hour), at(3*hour+10*min_), "built")...)
	o.sync()
	cursor, before := snapshot(t, o, analyticsPaths[0], analyticsPaths[3])
	// T-1's review and merge records arrive now, stamped hours before what was delivered.
	f.lifecycle("T-1", append(review, merge...)...)
	o.sync()
	for _, p := range []string{analyticsPaths[0], analyticsPaths[3]} {
		sameAt(t, o, p, cursor, before[p])
	}
	// The late events were marked late.
	_, hb := o.raw("/api/v1/events?limit=1000")
	if !strings.Contains(string(hb), `"late":true`) {
		t.Errorf("no event delivered late: the scenario did not exercise late arrival")
	}
	got := answers(t, o)
	fresh := answers(t, open(t, f.root, t.TempDir()))
	sameAnswers(t, "late delivery against reading at once", fresh, got)
	// T-1 counts once, with its merge: T1 = 1; C1: T-1 5 visits + T-2 1 visit = 6 measured.
	d := o.metrics("T1,C1,C3", "")
	fig(t, "T1", metric(t, d, "T1"), f64(1), f64(1), none, f64(1))
	eqNum(t, "C1 denominator", metric(t, d, "C1")["denominator_value"], f64(6))
	// C3: dispatch 09:01:00.999 to merge 09:32:00.000 = 1,859,001.
	fig(t, "C3", metric(t, d, "C3"), f64(1859001), f64(1859001), f64(1), f64(1))
	common(t, o)
}
