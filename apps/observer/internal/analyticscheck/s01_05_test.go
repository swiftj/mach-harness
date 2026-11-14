package analyticscheck

import (
	"testing"
	"time"
)

// Scenario 1: no execution history. An empty Factory: no figure has a number, no list has an
// entry, and nothing reads as zero.
func TestS01NoHistory(t *testing.T) {
	f := newFx(t)
	o := observe(f)
	all := o.metrics(allIDs(), "")
	for _, m := range arr(all["metrics"]) {
		row := obj(m)
		if row["value"] != nil || row["numerator_value"] != nil || row["denominator_value"] != nil {
			t.Errorf("%s: value %v numerator %v denominator %v in an empty history", row["id"], row["value"], row["numerator_value"], row["denominator_value"])
		}
		if row["null_reason"] == nil || row["null_reason"] == "" {
			t.Errorf("%s: null with no reason", row["id"])
		}
		if b := basis(row); b != nil && (b["measured"].(float64) != 0) {
			t.Errorf("%s: measured %v", row["id"], b["measured"])
		}
	}
	// last_runs over no runs: the observe metrics still have no number (observe.py: 0 runs).
	lr := o.metrics("Q2,Q3,R5,R6,G1,G2", "&last_runs=20")
	for _, m := range arr(lr["metrics"]) {
		if row := obj(m); row["value"] != nil {
			t.Errorf("%s over 0 runs: %v", row["id"], row["value"])
		}
	}
	flow := o.get("/api/v1/analytics/flow")
	if len(arr(flow["stations"])) != 0 || len(arr(flow["transitions"])) != 0 || len(arr(flow["bottlenecks"])) != 0 || len(arr(flow["waits"])) != 0 {
		t.Errorf("flow in an empty history: %s", show(flow))
	}
	for _, id := range []string{"C1", "waits", "Q1", "X1", "K1", "executions"} {
		if c := o.contributors(id, ""); c["total"].(float64) != 0 || len(arr(c["items"])) != 0 {
			t.Errorf("contributors %s: %s", id, show(c))
		}
	}
	if r := o.get("/api/v1/analytics/runs"); r["total"].(float64) != 0 {
		t.Errorf("runs: %s", show(r))
	}
	common(t, o)
}

// Scenario 2: one successful integrated slice. One wave, one slice, one ticket (T-1), one
// supervised execution, one judging round with three seats, five station visits.
func TestS02OneIntegratedSlice(t *testing.T) {
	f := newFx(t)
	f.product("WAVE-001", "SLICE-001", "T-1", at(0), at(1*min_), "Medium")
	f.happyCell("T-1", X1, 0, "Medium", "cli")
	f.supervised("T-1", X1, at(2*min_), at(40*min_+5*sec), at(40*min_+30*sec), 1.25)
	f.usage(X1, at(40*min_), 1.25, U{Model: "claude-sonnet-5-5", Cost: 1.0, Input: 10, Output: 20, CacheRead: 30, CacheCreation: 40},
		U{Model: "claude-opus-5-5", Cost: 0.25, Input: 1, Output: 2, CacheRead: 3, CacheCreation: 4})
	f.intake(L{At: at(45 * min_), Type: "slice.integrated", Wave: "WAVE-001", Slice: "SLICE-001", Ticket: "T-1", Source: "intake", Data: M{"commit": "fedcba987654"}})
	f.run("T-1", at(50*min_), map[string]any{"tests_seen_failing_first": 2, "tests_passing_on_first_run": 0})
	o := observe(f)

	d := o.metrics(allIDs(), "")
	// Entities: 1 ticket merged (T1), 1 slice integrated (T2), 5 visits over 1 ticket (C2 = 5/1),
	// 1 execution claimed (X1, S1, S2 denominators), 1 judging round decided (R1, R3), 1 run.
	fig(t, "T1", metric(t, d, "T1"), f64(1), f64(1), none, f64(1))
	fig(t, "T2", metric(t, d, "T2"), f64(1), f64(1), none, f64(1))
	fig(t, "C2", metric(t, d, "C2"), f64(5), f64(5), f64(1), f64(1))
	// C1: 30,000 + 600,000 + 360,000 + 540,000 + 90,000 = 1,620,000 ms over 5 measured visits = 324,000.
	c1 := metric(t, d, "C1")
	fig(t, "C1", c1, f64(324000), f64(1620000), f64(5), f64(5))
	eqNum(t, "C1 min", c1["min_ms"], f64(30000))
	eqNum(t, "C1 max", c1["max_ms"], f64(600000))
	// C3: work.scheduled at 09:01:00 (whole second, placed at +999 ms) to merge.completed at
	// 09:32:00.000: 31 min - 999 ms = 1,860,000 - 999 = 1,859,001 ms.
	fig(t, "C3", metric(t, d, "C3"), f64(1859001), f64(1859001), f64(1), f64(1))
	// C4: slice.materialized 09:00:10(+999) to slice.integrated 09:45:00(+999) = 44 min 50 s = 2,690,000.
	fig(t, "C4", metric(t, d, "C4"), f64(2690000), f64(2690000), f64(1), f64(1))
	// W2: 09:00:10 to 09:01:00 = 50,000. W4: claim 09:02:00 to process start 09:02:05 = 5,000.
	// W5: process end 09:40:05 to execution.completed 09:40:30 = 25,000.
	fig(t, "W2", metric(t, d, "W2"), f64(50000), f64(50000), f64(1), f64(1))
	fig(t, "W4", metric(t, d, "W4"), f64(5000), f64(5000), f64(1), f64(1))
	fig(t, "W5", metric(t, d, "W5"), f64(25000), f64(25000), f64(1), f64(1))
	// No dependency wait, no approval wait, no capacity wait: no events, no number (never 0).
	for _, id := range []string{"W1", "W2b", "W3", "Q4", "R2", "S4", "S5", "S6", "K7", "K8", "K9", "K10", "G3"} {
		fig(t, id, metric(t, d, id), none, none, none, f64(0))
	}
	// Rates: Q1 1/1, Q2 1/1, Q3 1 round / 1 merged, R1 0/1, R3 0/1 (a security seat sat),
	// R5 0/1, R6 0/1, X1 0/1, X2 0/1 (one verify.verdict, passed), X3 0 overrides / 2 tasks,
	// S1 0/1, S2 0/1, S3 1/1, G1 2/(2+0) = 1, G2 0/1.
	for id, want := range map[string][2]float64{"Q1": {1, 1}, "Q2": {1, 1}, "Q3": {1, 1}, "R1": {0, 1}, "R3": {0, 1}, "R5": {0, 1}, "R6": {0, 1},
		"X1": {0, 1}, "X2": {0, 1}, "X3": {0, 2}, "S1": {0, 1}, "S2": {0, 1}, "S3": {1, 1}, "G1": {2, 2}, "G2": {0, 1}} {
		fig(t, id, metric(t, d, id), f64(want[0]/want[1]), f64(want[0]), f64(want[1]), f64(want[1]))
	}
	// K1: 1.25 / 1 execution. K4: 1.25 / 1 ticket. K2: (1.00 + 0.25) / 2 execution-model pairs =
	// 0.625. K3: (10+20+30+40 + 1+2+3+4) = 110 tokens / 2 = 55.
	fig(t, "K1", metric(t, d, "K1"), f64(1.25), f64(1.25), f64(1), f64(1))
	fig(t, "K4", metric(t, d, "K4"), f64(1.25), f64(1.25), f64(1), f64(1))
	fig(t, "K2", metric(t, d, "K2"), f64(0.625), f64(1.25), f64(2), f64(2))
	fig(t, "K3", metric(t, d, "K3"), f64(55), f64(110), f64(2), f64(2))
	k2 := metric(t, o.metrics("K2", "&group_by=model"), "K2")
	fig(t, "K2 sonnet", group(t, k2, "model=claude-sonnet-5-5"), f64(1), f64(1), f64(1), f64(1))
	fig(t, "K2 opus", group(t, k2, "model=claude-opus-5-5"), f64(0.25), f64(0.25), f64(1), f64(1))
	// K3 by token kind: input 10+1 = 11 over the 2 pairs = 5.5; output 22/2 = 11.
	k3 := metric(t, o.metrics("K3", "&group_by=token_kind"), "K3")
	fig(t, "K3 input", group(t, k3, "token_kind=input"), f64(5.5), f64(11), f64(2), f64(2))
	fig(t, "K3 output", group(t, k3, "token_kind=output"), f64(11), f64(22), f64(2), f64(2))

	// Flow: 5 stations with one visit each; transitions are the 4 consecutive pairs plus the end.
	flow := o.get("/api/v1/analytics/flow")
	for _, s := range []string{"plan", "build", "verify", "review", "merge"} {
		st := station(t, flow, s)
		if st["visits"].(float64) != 1 || st["tickets"].(float64) != 1 {
			t.Errorf("flow %s: %s", s, show(st))
		}
	}
	tr := transitions(flow)
	for k, n := range map[string]float64{"plan->build": 1, "build->verify": 1, "verify->review": 1, "review->merge": 1, "merge->(end)": 1} {
		if tr[k] != n {
			t.Errorf("transition %s: %v, want %v (all %v)", k, tr[k], n, tr)
		}
	}
	if len(tr) != 5 {
		t.Errorf("transitions %v", tr)
	}
	// Contributors of C1: exactly the five visits; their values sum to C1's numerator.
	c := o.contributors("C1", "")
	want := []string{"visit:T-1/build#1", "visit:T-1/merge#1", "visit:T-1/plan#1", "visit:T-1/review#1", "visit:T-1/verify#1"}
	if !sameSet(refs(c), want) || c["total"].(float64) != 5 {
		t.Errorf("C1 contributors %v", refs(c))
	}
	var sum float64
	for _, it := range arr(c["items"]) {
		sum += *num(obj(it)["value"])
	}
	if sum != 1620000 {
		t.Errorf("C1 contributors sum to %v, numerator 1,620,000", sum)
	}
	// K1 contributors: the one execution, 1.25.
	k1 := o.contributors("K1", "")
	if !sameSet(refs(k1), []string{"execution:" + X1}) || *num(obj(arr(k1["items"])[0])["value"]) != 1.25 {
		t.Errorf("K1 contributors %s", show(k1["items"]))
	}
	// The run listing: one ticket, one execution, usage recorded and complete.
	runs := o.get("/api/v1/analytics/runs")
	if runs["total"].(float64) != 1 {
		t.Fatalf("runs %s", show(runs))
	}
	common(t, o)

	// The same cursor gives the same answer after a second ticket arrives.
	cursorStable(t, o, func() {
		f.product("WAVE-002", "SLICE-002", "T-2", at(2*hour), at(2*hour+min_), "High")
		f.happyCell("T-2", X2, 2*hour, "High", "web")
		f.supervised("T-2", X2, at(2*hour+2*min_), at(2*hour+40*min_), at(2*hour+41*min_), 2.0)
		f.run("T-2", at(3*hour), map[string]any{"risk": "High", "app_type": "web"})
	}, "/api/v1/analytics/metrics?ids="+allIDs(), "/api/v1/analytics/flow", "/api/v1/analytics/contributors?metric=C1",
		"/api/v1/analytics/contributors?metric=K1", "/api/v1/analytics/runs")
	// And the head now counts both: T1 = 2, K1 = (1.25 + 2.00) / 2 = 1.625.
	d2 := o.metrics("T1,K1", "")
	fig(t, "T1 after", metric(t, d2, "T1"), f64(2), f64(2), none, f64(2))
	fig(t, "K1 after", metric(t, d2, "K1"), f64(1.625), f64(3.25), f64(2), f64(2))
}

// Scenario 3: multiple tickets belonging to one slice. SLICE-001's first ticket T-1 is abandoned
// after build; the slice is reissued to T-2, which merges; the slice integrates once.
func TestS03TicketsOfOneSlice(t *testing.T) {
	f := newFx(t)
	f.product("WAVE-001", "SLICE-001", "T-1", at(0), at(1*min_), "Medium")
	f.lifecycle("T-1", append(planVisit(at(70*sec), at(100*sec), "Medium", "cli"),
		visit("build", 1, 1, "", at(3*min_), at(13*min_), "built", task(at(5*min_), "T1"))...)...)
	f.run("T-1", at(20*min_), map[string]any{"outcome": "abandoned", "first_pass": false, "integration": nil, "tests_seen_failing_first": 1,
		"tests_passing_on_first_run": 1})
	f.slice("SLICE-001", "T-2", "WAVE-001", 1)
	f.intake(
		L{At: at(25 * min_), Type: "slice.materialized", Wave: "WAVE-001", Slice: "SLICE-001", Ticket: "T-2", Source: "intake", Data: M{"dependencies": []string{}, "reissued": true}},
		L{At: at(26 * min_), Type: "work.scheduled", Wave: "WAVE-001", Slice: "SLICE-001", Ticket: "T-2", Data: M{"stage": "spec-ready", "risk": "Medium"}},
	)
	f.happyCell("T-2", "", 25*min_, "Medium", "cli")
	f.intake(L{At: at(60 * min_), Type: "slice.integrated", Wave: "WAVE-001", Slice: "SLICE-001", Ticket: "T-2", Source: "intake", Data: M{"commit": "fedcba987654"}})
	f.run("T-2", at(62*min_), map[string]any{"tests_seen_failing_first": 3, "tests_passing_on_first_run": 0})
	o := observe(f)
	d := o.metrics(allIDs(), "")
	// Tickets merged: T-2 only = 1. Slices integrated: SLICE-001 once = 1 (two tickets, one slice).
	fig(t, "T1", metric(t, d, "T1"), f64(1), f64(1), none, f64(1))
	fig(t, "T2", metric(t, d, "T2"), f64(1), f64(1), none, f64(1))
	// C2: T-1 2 visits (plan, build) + T-2 5 visits = 7 visits over 2 tickets = 3.5.
	fig(t, "C2", metric(t, d, "C2"), f64(3.5), f64(7), f64(2), f64(2))
	// Run records: 2 finished, 1 merged. Q2 = 1/1 (abandoned is not in the denominator),
	// R6 = 1/2, R5 = 0/2, G1 = (1+3)/(1+1+3+0) = 4/5, G2 = 0/2.
	fig(t, "Q2", metric(t, d, "Q2"), f64(1), f64(1), f64(1), f64(1))
	fig(t, "R6", metric(t, d, "R6"), f64(0.5), f64(1), f64(2), f64(2))
	fig(t, "R5", metric(t, d, "R5"), f64(0), f64(0), f64(2), f64(2))
	fig(t, "G1", metric(t, d, "G1"), f64(0.8), f64(4), f64(5), f64(5))
	fig(t, "G2", metric(t, d, "G2"), f64(0), f64(0), f64(2), f64(2))
	// W2: one dispatched slice, waited once: eligible 09:00:10 to the first work.scheduled
	// 09:01:00 = 50,000 (a reissue does not dispatch a second slice).
	fig(t, "W2", metric(t, d, "W2"), f64(50000), f64(50000), f64(1), f64(1))
	// C4: one integrated slice. It became eligible when first materialized (09:00:10.999), and
	// integrated at 10:00:00.999: 59 min 50 s = 3,590,000 ms. (A reissue to another ticket does not
	// make the slice newly eligible.)
	fig(t, "C4", metric(t, d, "C4"), f64(3590000), f64(3590000), f64(1), f64(1))
	// C3: T-2's own dispatch 09:26:00.999 to its merge 09:57:00.000 = 31 min - 999 ms = 1,859,001.
	fig(t, "C3", metric(t, d, "C3"), f64(1859001), f64(1859001), f64(1), f64(1))
	// Flow: plan and build were visited by both tickets.
	flow := o.get("/api/v1/analytics/flow")
	for s, want := range map[string][2]float64{"plan": {2, 2}, "build": {2, 2}, "verify": {1, 1}, "review": {1, 1}, "merge": {1, 1}} {
		st := station(t, flow, s)
		if st["visits"].(float64) != want[0] || st["tickets"].(float64) != want[1] {
			t.Errorf("flow %s: visits %v tickets %v, want %v", s, st["visits"], st["tickets"], want)
		}
	}
	// Transitions: plan->build twice (one per ticket); T-1's build is its last recorded visit.
	tr := transitions(flow)
	if tr["plan->build"] != 2 || tr["build->verify"] != 1 {
		t.Errorf("transitions %v", tr)
	}
	if cov := obj(flow["coverage"]); cov["tickets"].(float64) != 2 || cov["tickets_with_lifecycle"].(float64) != 2 {
		t.Errorf("flow coverage %v", cov)
	}
	common(t, o)
}

// Scenario 4: repeated verification visits. T-4 enters verification three times in round 1:
// twice refused for incomplete evidence, then PASS. One ticket, three visits, one verdict.
func TestS04RepeatedVerification(t *testing.T) {
	f := newFx(t)
	b := at(0)
	recs := planVisit(b.Add(10*sec), b.Add(40*sec), "Low", "api")
	recs = append(recs, visit("build", 1, 1, "", b.Add(1*min_), b.Add(11*min_), "built", task(b.Add(5*min_), "T1"))...)
	finish := func(m int) R {
		return R{At: b.Add(time.Duration(m) * min_), Type: "gate.evaluated", Data: M{"gate": "verify.finish", "outcome": "refuse", "reason_code": "incomplete-evidence"}}
	}
	// verify#1 12m..14m (120,000), verify#2 15m..18m (180,000), verify#3 19m..23m (240,000).
	recs = append(recs, visit("verify", 1, 1, "", b.Add(12*min_), b.Add(14*min_), "INCOMPLETE_EVIDENCE", finish(13))...)
	recs = append(recs, visit("verify", 2, 1, "", b.Add(15*min_), b.Add(18*min_), "INCOMPLETE_EVIDENCE", finish(17))...)
	recs = append(recs, visit("verify", 3, 1, "", b.Add(19*min_), b.Add(23*min_), "PASS", check(b.Add(20*min_), "AC-01", "scenario", "pass"), verdict(b.Add(22*min_), "PASS"))...)
	recs = append(recs, visit("review", 1, 1, "", b.Add(24*min_), b.Add(30*min_), "APPROVED", roundStarted(b.Add(24*min_+sec), 1, "Low", "general"),
		vote(b.Add(26*min_), 1, "general", "APPROVE", 0), decided(b.Add(29*min_), 1, "APPROVED", M{"general": "APPROVE"}, false))...)
	recs = append(recs, visit("merge", 1, 0, "", b.Add(31*min_), b.Add(32*min_), "merged",
		R{At: b.Add(31*min_ + 30*sec), Type: "merge.completed", Data: M{"method": "local", "merge_commit": "fedcba987654"}})...)
	f.lifecycle("T-4", recs...)
	f.run("T-4", at(40*min_), map[string]any{"risk": "Low", "app_type": "api"})
	o := observe(f)
	d := o.metrics(allIDs(), "")
	// One ticket: T1 = 1 (hand-driven), Q1 = 1/1 (one round-1 verdict, PASS).
	fig(t, "T1", metric(t, d, "T1"), f64(1), f64(1), none, f64(1))
	fig(t, "Q1", metric(t, d, "Q1"), f64(1), f64(1), f64(1), f64(1))
	// C2: 1 plan + 1 build + 3 verify + 1 review + 1 merge = 7 visits / 1 ticket = 7.
	fig(t, "C2", metric(t, d, "C2"), f64(7), f64(7), f64(1), f64(1))
	c2 := metric(t, o.metrics("C2", "&group_by=station"), "C2")
	fig(t, "C2 verify", group(t, c2, "station=verify"), f64(3), f64(3), f64(1), f64(1))
	// C1 at verify: (120,000 + 180,000 + 240,000) / 3 = 180,000.
	c1 := metric(t, o.metrics("C1", "&group_by=station"), "C1")
	fig(t, "C1 verify", group(t, c1, "station=verify"), f64(180000), f64(540000), f64(3), f64(3))
	// X2: evaluations verify.finish x2 (refused) + verify.verdict (passed) = 2/3.
	fig(t, "X2", metric(t, d, "X2"), f64(2.0/3), f64(2), f64(3), f64(3))
	// Flow: verify 3 visits by 1 ticket; transitions build->verify 1, verify->verify 2,
	// verify->review 1.
	flow := o.get("/api/v1/analytics/flow")
	v := station(t, flow, "verify")
	if v["visits"].(float64) != 3 || v["tickets"].(float64) != 1 {
		t.Errorf("verify %s", show(v))
	}
	if g := obj(v["gates"]); g["evaluated"].(float64) != 3 || g["refused"].(float64) != 2 {
		t.Errorf("verify gates %v", g)
	}
	tr := transitions(flow)
	for k, n := range map[string]float64{"plan->build": 1, "build->verify": 1, "verify->verify": 2, "verify->review": 1, "review->merge": 1, "merge->(end)": 1} {
		if tr[k] != n {
			t.Errorf("transition %s: %v want %v (%v)", k, tr[k], n, tr)
		}
	}
	// X2 contributors: exactly the two refusals.
	x2 := o.contributors("X2", "")
	if x2["total"].(float64) != 2 {
		t.Errorf("X2 contributors %s", show(x2["items"]))
	}
	common(t, o)
}

// Scenario 5: verification failure followed by success. Round 1 verification fails with
// evidence; the build is revised in round 2, which passes review. The execution of round 1 ran a
// belt workflow that completed: a completed workflow is not a passed gate.
func TestS05VerifyFailThenPass(t *testing.T) {
	f := newFx(t)
	b := at(0)
	recs := planVisit(b.Add(10*sec), b.Add(40*sec), "Medium", "web")
	recs = append(recs, visit("build", 1, 1, X1, b.Add(1*min_), b.Add(11*min_), "built", task(b.Add(5*min_), "T1"))...)
	recs = append(recs, visit("verify", 1, 1, X1, b.Add(12*min_), b.Add(20*min_), "FAIL_WITH_EVIDENCE",
		check(b.Add(14*min_), "AC-01", "scenario", "fail"), check(b.Add(15*min_), "R1", "matrix-rule", "pass"), verdict(b.Add(19*min_), "FAIL_WITH_EVIDENCE"))...)
	revise := visit("build", 2, 2, X2, b.Add(30*min_), b.Add(40*min_), "built", task(b.Add(35*min_), "T1"))
	revise[0].Data["revision"] = 2
	recs = append(recs, revise...)
	recs = append(recs, visit("verify", 2, 2, X2, b.Add(41*min_), b.Add(45*min_), "PASS", check(b.Add(42*min_), "AC-01", "scenario", "pass"), verdict(b.Add(44*min_), "PASS"))...)
	recs = append(recs, visit("review", 1, 2, X2, b.Add(46*min_), b.Add(50*min_), "APPROVED", roundStarted(b.Add(46*min_+sec), 2, "Medium", "architecture", "security", "product"),
		vote(b.Add(47*min_), 2, "architecture", "APPROVE", 0), vote(b.Add(47*min_), 2, "security", "APPROVE", 0), vote(b.Add(48*min_), 2, "product", "APPROVE", 0),
		decided(b.Add(49*min_), 2, "APPROVED", M{"architecture": "APPROVE", "security": "APPROVE", "product": "APPROVE"}, false))...)
	recs = append(recs, visit("merge", 1, 0, X2, b.Add(51*min_), b.Add(52*min_), "merged",
		R{At: b.Add(51*min_ + 30*sec), Type: "merge.completed", Data: M{"method": "local", "merge_commit": "fedcba987654"}})...)
	f.lifecycle("T-5", recs...)
	// Two executions: X1 ran round 1 (its workflow completed; the ticket's verification failed);
	// X2 ran round 2 to the merge.
	f.supervised("T-5", X1, at(50*sec), at(21*min_), at(21*min_+10*sec), 0.5)
	f.workflow(X1, at(56*sec), at(20*min_+30*sec), "completed")
	f.supervised("T-5", X2, at(29*min_), at(53*min_), at(53*min_+10*sec), 0.75)
	f.run("T-5", at(55*min_), map[string]any{"rounds": 2, "first_pass": false, "verify_failures": 1, "app_type": "web"})
	o := observe(f)
	d := o.metrics(allIDs(), "")
	// Q1: round-1 verdict FAIL_WITH_EVIDENCE: 0/1. Q2: 0 first-pass / 1 merged. Q3: 2 rounds / 1.
	fig(t, "Q1", metric(t, d, "Q1"), f64(0), f64(0), f64(1), f64(1))
	fig(t, "Q2", metric(t, d, "Q2"), f64(0), f64(0), f64(1), f64(1))
	fig(t, "Q3", metric(t, d, "Q3"), f64(2), f64(2), f64(1), f64(1))
	// Q4: one failed check, kind scenario.
	fig(t, "Q4", metric(t, d, "Q4"), f64(1), f64(1), none, f64(1))
	q4 := metric(t, o.metrics("Q4", "&group_by=target_kind"), "Q4")
	fig(t, "Q4 scenario", group(t, q4, "target_kind=scenario"), f64(1), f64(1), none, f64(1))
	// X2: verify.verdict refused 1 of 2 evaluations.
	fig(t, "X2", metric(t, d, "X2"), f64(0.5), f64(1), f64(2), f64(2))
	// S6: 1 workflow finished, completed, 0 killed: 0/1. S3: 2 completed / 2 = 1. One ticket
	// merged (T1 = 1) from two executions (X1 denominator 2, numerator 0: no execution failed).
	fig(t, "S6", metric(t, d, "S6"), f64(0), f64(0), f64(1), f64(1))
	fig(t, "S3", metric(t, d, "S3"), f64(1), f64(2), f64(2), f64(2))
	fig(t, "X1", metric(t, d, "X1"), f64(0), f64(0), f64(2), f64(2))
	fig(t, "T1", metric(t, d, "T1"), f64(1), f64(1), none, f64(1))
	// K4: one ticket, 0.50 + 0.75 = 1.25 over 1 ticket; K1: 1.25 / 2 executions = 0.625.
	fig(t, "K4", metric(t, d, "K4"), f64(1.25), f64(1.25), f64(1), f64(1))
	fig(t, "K1", metric(t, d, "K1"), f64(0.625), f64(1.25), f64(2), f64(2))
	// R1 by round: one decided round (round 2), approved: 0/1.
	r1 := metric(t, o.metrics("R1", "&group_by=round"), "R1")
	fig(t, "R1 round 2", group(t, r1, "round=2"), f64(0), f64(0), f64(1), f64(1))
	if len(arr(r1["groups"])) != 1 {
		t.Errorf("R1 groups %v", groupKeys(r1))
	}
	// Flow: build 2 visits (1 revise entry), verify 2; verify->build 1 (a revise loop).
	flow := o.get("/api/v1/analytics/flow")
	bst := station(t, flow, "build")
	if bst["visits"].(float64) != 2 || bst["tickets"].(float64) != 1 || bst["revise_entries"].(float64) != 1 {
		t.Errorf("build %s", show(bst))
	}
	tr := transitions(flow)
	for k, n := range map[string]float64{"plan->build": 1, "build->verify": 2, "verify->build": 1, "verify->review": 1, "review->merge": 1, "merge->(end)": 1} {
		if tr[k] != n {
			t.Errorf("transition %s: %v want %v (%v)", k, tr[k], n, tr)
		}
	}
	// Contributors: Q1 is the one round-1 verification that did not pass; Q4 the one failed check.
	if q := o.contributors("Q1", ""); !sameSet(refs(q), []string{"gate:T-5/verify#1"}) {
		t.Errorf("Q1 contributors %v", refs(q))
	}
	if q := o.contributors("Q4", ""); q["total"].(float64) != 1 {
		t.Errorf("Q4 contributors %s", show(q["items"]))
	}
	if q := o.contributors("verification_failures", ""); q["total"].(float64) != 1 {
		t.Errorf("verification_failures %s", show(q["items"]))
	}
	common(t, o)
}
