package analyticscheck

import (
	"testing"
	"time"
)

// Scenario 6: review rejection followed by remediation. Round 1 passes verification and is
// rejected by review with a security veto; round 2 revises, passes and is approved.
func TestS06ReviewRejectionRemediated(t *testing.T) {
	f := newFx(t)
	b := at(0)
	seats := M{"architecture": "APPROVE", "security": "REJECT", "product": "APPROVE"}
	recs := planVisit(b.Add(10*sec), b.Add(40*sec), "Medium", "cli")
	recs = append(recs, visit("build", 1, 1, "", b.Add(1*min_), b.Add(11*min_), "built", task(b.Add(5*min_), "T1"))...)
	recs = append(recs, visit("verify", 1, 1, "", b.Add(12*min_), b.Add(15*min_), "PASS", verdict(b.Add(14*min_), "PASS"))...)
	recs = append(recs, visit("review", 1, 1, "", b.Add(16*min_), b.Add(25*min_), "REJECTED", roundStarted(b.Add(16*min_+sec), 1, "Medium", "architecture", "security", "product"),
		vote(b.Add(18*min_), 1, "architecture", "APPROVE", 0), vote(b.Add(19*min_), 1, "security", "REJECT", 1), vote(b.Add(20*min_), 1, "product", "APPROVE", 0),
		decided(b.Add(24*min_), 1, "REJECTED", seats, true))...)
	revise := visit("build", 2, 2, "", b.Add(30*min_), b.Add(40*min_), "built", task(b.Add(35*min_), "T2"))
	revise[0].Data["revision"] = 2
	recs = append(recs, revise...)
	recs = append(recs, visit("verify", 2, 2, "", b.Add(41*min_), b.Add(44*min_), "PASS", verdict(b.Add(43*min_), "PASS"))...)
	recs = append(recs, visit("review", 2, 2, "", b.Add(45*min_), b.Add(50*min_), "APPROVED", roundStarted(b.Add(45*min_+sec), 2, "Medium", "architecture", "security", "product"),
		vote(b.Add(46*min_), 2, "architecture", "APPROVE", 0), vote(b.Add(46*min_), 2, "security", "APPROVE", 0), vote(b.Add(47*min_), 2, "product", "APPROVE", 0),
		decided(b.Add(49*min_), 2, "APPROVED", M{"architecture": "APPROVE", "security": "APPROVE", "product": "APPROVE"}, false))...)
	recs = append(recs, visit("merge", 1, 0, "", b.Add(51*min_), b.Add(52*min_), "merged",
		R{At: b.Add(51*min_ + 30*sec), Type: "merge.completed", Data: M{"method": "local", "merge_commit": "fedcba987654"}})...)
	f.lifecycle("T-6", recs...)
	f.run("T-6", at(55*min_), map[string]any{"rounds": 2, "first_pass": false, "review_rejections": 1,
		"blockers": []any{M{"reviewer": "security", "rule": "INV-01", "file": "src/a.go"}}})
	o := observe(f)
	d := o.metrics(allIDs(), "")
	// R1: 2 decided rounds, 1 rejected: 1/2. By round: round 1 1/1, round 2 0/1.
	fig(t, "R1", metric(t, d, "R1"), f64(0.5), f64(1), f64(2), f64(2))
	r1 := metric(t, o.metrics("R1", "&group_by=round"), "R1")
	fig(t, "R1 r1", group(t, r1, "round=1"), f64(1), f64(1), f64(1), f64(1))
	fig(t, "R1 r2", group(t, r1, "round=2"), f64(0), f64(0), f64(1), f64(1))
	// R3: both decided rounds sat a security seat; one veto: 1/2.
	fig(t, "R3", metric(t, d, "R3"), f64(0.5), f64(1), f64(2), f64(2))
	// Q1 (round-1 verification) passed: 1/1. Q2 (observe's first pass, which counts the review
	// rejection) did not: 0/1. Q3: 2 rounds / 1 merged.
	fig(t, "Q1", metric(t, d, "Q1"), f64(1), f64(1), f64(1), f64(1))
	fig(t, "Q2", metric(t, d, "Q2"), f64(0), f64(0), f64(1), f64(1))
	fig(t, "Q3", metric(t, d, "Q3"), f64(2), f64(2), f64(1), f64(1))
	// R4 is deferred: no number at all.
	fig(t, "R4", metric(t, d, "R4"), none, none, none, nil)
	if st := metric(t, d, "R4")["status"]; st != "deferred" {
		t.Errorf("R4 status %v", st)
	}
	// Contributors of R1: the one rejected round, valued at its 1 recorded blocker. Seats are not
	// rounds: three seats sat in round 1, still one contributor.
	c := o.contributors("R1", "")
	if !sameSet(refs(c), []string{"gate:T-6/review#1"}) {
		t.Errorf("R1 contributors %v", refs(c))
	}
	// Flow: review 2 visits; review->build 1 (the remediation loop, a revise entry).
	flow := o.get("/api/v1/analytics/flow")
	if r := station(t, flow, "review"); r["visits"].(float64) != 2 || r["tickets"].(float64) != 1 {
		t.Errorf("review %s", show(r))
	}
	tr := transitions(flow)
	for k, n := range map[string]float64{"build->verify": 2, "verify->review": 2, "review->build": 1, "review->merge": 1} {
		if tr[k] != n {
			t.Errorf("transition %s: %v want %v (%v)", k, tr[k], n, tr)
		}
	}
	common(t, o)
}

// Scenario 7: concurrent executions. Two tickets' executions overlap in time; each is counted
// once, and nothing is merged or apportioned between them.
func TestS07ConcurrentExecutions(t *testing.T) {
	f := newFx(t)
	f.product("WAVE-001", "SLICE-A", "T-7a", at(0), at(1*min_), "Medium")
	f.product("WAVE-001", "SLICE-B", "T-7b", at(20*sec), at(2*min_), "Medium")
	f.happyCell("T-7a", X1, 0, "Medium", "cli")
	f.happyCell("T-7b", X2, 1*min_, "Medium", "cli") // overlaps T-7a at every station
	// X1: claim 09:02:00, process 09:02:05 .. 09:40:00. X2: claim 09:03:00, process starts at
	// 09:03:05 (claim + 5 s) .. 09:41:00. W4 = 5,000 each.
	f.supervised("T-7a", X1, at(2*min_), at(40*min_), at(40*min_+20*sec), 1.0)
	f.supervised("T-7b", X2, at(3*min_), at(41*min_), at(41*min_+40*sec), 3.0)
	o := observe(f)
	d := o.metrics(allIDs(), "")
	// 2 executions claimed, 2 completed, 0 failed.
	fig(t, "X1", metric(t, d, "X1"), f64(0), f64(0), f64(2), f64(2))
	fig(t, "S3", metric(t, d, "S3"), f64(1), f64(2), f64(2), f64(2))
	// W5: 20,000 and 40,000 = 60,000 / 2 = 30,000.
	fig(t, "W5", metric(t, d, "W5"), f64(30000), f64(60000), f64(2), f64(2))
	// K1: (1 + 3) / 2 executions = 2. K4: (1 + 3) / 2 tickets = 2.
	fig(t, "K1", metric(t, d, "K1"), f64(2), f64(4), f64(2), f64(2))
	fig(t, "K4", metric(t, d, "K4"), f64(2), f64(4), f64(2), f64(2))
	// C1: 2 tickets x 5 visits = 10 measured; 2 x 1,620,000 = 3,240,000; mean 324,000.
	fig(t, "C1", metric(t, d, "C1"), f64(324000), f64(3240000), f64(10), f64(10))
	// K1 by ticket: each ticket its own execution's cost; nothing shared by time overlap.
	k1 := metric(t, o.metrics("K1", "&group_by=ticket"), "K1")
	fig(t, "K1 T-7a", group(t, k1, "ticket=T-7a"), f64(1), f64(1), f64(1), f64(1))
	fig(t, "K1 T-7b", group(t, k1, "ticket=T-7b"), f64(3), f64(3), f64(1), f64(1))
	// Flow: every station 2 visits by 2 tickets; build->verify twice (each cell's own sequence).
	flow := o.get("/api/v1/analytics/flow")
	for _, s := range []string{"plan", "build", "verify", "review", "merge"} {
		st := station(t, flow, s)
		if st["visits"].(float64) != 2 || st["tickets"].(float64) != 2 {
			t.Errorf("flow %s: %s", s, show(st))
		}
	}
	if tr := transitions(flow); tr["build->verify"] != 2 || tr["build->build"] != 0 || tr["verify->build"] != 0 {
		t.Errorf("transitions interleave tickets: %v", tr)
	}
	ex := o.contributors("executions", "")
	if !sameSet(refs(ex), []string{"execution:" + X1, "execution:" + X2}) {
		t.Errorf("executions %v", refs(ex))
	}
	common(t, o)
}

// Scenario 8: dependency waits. SLICE-B waits on SLICE-A; SLICE-C is blocked twice; SLICE-D is
// still blocked at the head.
func TestS08DependencyWaits(t *testing.T) {
	f := newFx(t)
	w := "WAVE-008"
	f.slice("SLICE-A", "T-8a", w, 1)
	f.slice("SLICE-B", "T-8b", w, 1)
	f.slice("SLICE-C", "T-8c", w, 1)
	f.slice("SLICE-D", "T-8d", w, 1)
	mat := func(s, tk string, at time.Time, deps ...string) L {
		if deps == nil {
			deps = []string{}
		}
		return L{At: at, Type: "slice.materialized", Wave: w, Slice: s, Ticket: tk, Source: "intake", Data: M{"dependencies": deps}}
	}
	ev := func(typ, s, tk string, at time.Time, data M) L {
		return L{At: at, Type: typ, Wave: w, Slice: s, Ticket: tk, Data: data}
	}
	f.intake(
		L{At: at(0), Type: "wave.discovered", Wave: w, Source: "intake", Data: M{"slices": []string{"SLICE-A", "SLICE-B", "SLICE-C", "SLICE-D"}}},
		mat("SLICE-A", "T-8a", at(10*sec)),
		mat("SLICE-B", "T-8b", at(10*sec), "SLICE-A"),
		mat("SLICE-C", "T-8c", at(10*sec), "SLICE-A"),
		ev("dependency.blocked", "SLICE-B", "T-8b", at(20*sec), M{"reasons": []string{"waits for SLICE-A"}}),
		ev("dependency.blocked", "SLICE-C", "T-8c", at(30*sec), M{"reasons": []string{"waits for SLICE-A"}}),
		ev("work.scheduled", "SLICE-A", "T-8a", at(1*min_), M{"stage": "spec-ready", "risk": "Low"}),
		ev("dependency.resolved", "SLICE-C", "T-8c", at(10*min_), M{"depends_on": []string{"SLICE-A"}}),
		ev("dependency.blocked", "SLICE-C", "T-8c", at(12*min_), M{"reasons": []string{"waits again"}}),
		ev("dependency.resolved", "SLICE-C", "T-8c", at(20*min_), M{"depends_on": []string{"SLICE-A"}}),
		ev("work.scheduled", "SLICE-C", "T-8c", at(21*min_), M{"stage": "spec-ready", "risk": "Low"}),
		L{At: at(39 * min_), Type: "slice.integrated", Wave: w, Slice: "SLICE-A", Ticket: "T-8a", Source: "intake", Data: M{"commit": "fedcba987654"}},
		ev("dependency.resolved", "SLICE-B", "T-8b", at(40*min_), M{"depends_on": []string{"SLICE-A"}}),
		ev("work.scheduled", "SLICE-B", "T-8b", at(41*min_), M{"stage": "spec-ready", "risk": "Low"}),
		mat("SLICE-D", "T-8d", at(45*min_), "SLICE-B"),
		ev("dependency.blocked", "SLICE-D", "T-8d", at(50*min_), M{"reasons": []string{"waits for SLICE-B"}}),
	)
	f.happyCell("T-8a", "", 0, "Low", "cli")
	o := observe(f)
	d := o.metrics(allIDs(), "")
	// W1, closed waits: B 09:00:20 -> 09:40:00 = 2,380,000; C 09:00:30 -> 09:10:00 = 570,000;
	// C again 09:12:00 -> 09:20:00 = 480,000. Sum 3,430,000 over 3 waits (2 slices: the catalog's
	// population; the engine declares W1 partial for counting waits). D's wait is open.
	w1 := metric(t, d, "W1")
	fig(t, "W1", w1, f64(3430000.0/3), f64(3430000), f64(3), f64(3))
	if w1["status"] != "partial" {
		t.Errorf("W1 counts waits, not slices, and must say so: status %v", w1["status"])
	}
	// The open wait (SLICE-D) is counted apart, not dropped: open = 1.
	if b := basis(w1); b["open"] == nil || b["open"].(float64) != 1 {
		t.Errorf("W1 open waits: basis %v (SLICE-D is blocked at the head)", b)
	}
	// W2: A 09:00:10 -> 09:01:00 = 50,000; C (eligible at its last resolution) 09:20:00 ->
	// 09:21:00 = 60,000; B 09:40:00 -> 09:41:00 = 60,000. 170,000 / 3.
	fig(t, "W2", metric(t, d, "W2"), f64(170000.0/3), f64(170000), f64(3), f64(3))
	// C4: only A integrated: 09:00:10 -> 09:39:00 = 38 min 50 s = 2,330,000.
	fig(t, "C4", metric(t, d, "C4"), f64(2330000), f64(2330000), f64(1), f64(1))
	// Contributors W1: one item per wait (4, one open), refs to slices; the measured values sum to
	// the numerator.
	c := o.contributors("W1", "")
	if c["total"].(float64) != 4 {
		t.Errorf("W1 contributors: %v items %v", c["total"], refs(c))
	}
	var sum float64
	for _, it := range arr(c["items"]) {
		if v := num(obj(it)["value"]); v != nil {
			sum += *v
		}
	}
	if sum != 3430000 {
		t.Errorf("W1 contributors' measured values sum to %v, numerator 3,430,000", sum)
	}
	// Flow: dependency waits 4 (3 closed, 1 open), 3 slices (tickets T-8b, T-8c, T-8d).
	flow := o.get("/api/v1/analytics/flow")
	for _, wv := range arr(flow["waits"]) {
		wm := obj(wv)
		if wm["kind"] != "dependency" {
			continue
		}
		dur := obj(wm["duration"])
		if wm["count"].(float64) != 4 || wm["tickets"].(float64) != 3 || obj(dur["basis"])["open"].(float64) != 1 || obj(dur["measured"])["total_ms"].(float64) != 3430000 {
			t.Errorf("flow dependency waits %s", show(wm))
		}
	}
	// Waits are not additive into elapsed time: B and C waited at the same time. The sum of wait
	// durations (3,430,000) exceeds the wall time any slice waited (B: 2,380,000); W1 by wave
	// still reconciles as a sum of waits.
	byWave := metric(t, o.metrics("W1", "&group_by=wave"), "W1")
	reconcile(t, "W1 by wave", byWave)
	common(t, o)
}

// Scenario 9: human approval waits. T-9 waits two hours for a person; T-9b is still waiting at the
// head; T-9c is parked for a person by the supervisor.
func TestS09HumanApprovalWaits(t *testing.T) {
	f := newFx(t)
	b := at(0)
	high := func(ticket string, approveAt time.Time) {
		recs := planVisit(b.Add(10*sec), b.Add(40*sec), "High", "api")
		recs = append(recs, visit("build", 1, 1, "", b.Add(1*min_), b.Add(11*min_), "built", task(b.Add(5*min_), "T1"))...)
		recs = append(recs, visit("verify", 1, 1, "", b.Add(12*min_), b.Add(15*min_), "PASS", verdict(b.Add(14*min_), "PASS"))...)
		rs := roundStarted(b.Add(16*min_+sec), 1, "High", "architecture", "security", "product")
		rs.Data["human_approval_required"] = true
		recs = append(recs, visit("review", 1, 1, "", b.Add(16*min_), b.Add(30*min_), "AWAITING_HUMAN", rs,
			vote(b.Add(18*min_), 1, "architecture", "APPROVE", 0), vote(b.Add(19*min_), 1, "security", "APPROVE", 0), vote(b.Add(20*min_), 1, "product", "APPROVE", 0),
			decided(b.Add(30*min_), 1, "AWAITING_HUMAN", M{"architecture": "APPROVE", "security": "APPROVE", "product": "APPROVE"}, false))...)
		if !approveAt.IsZero() {
			recs = append(recs, R{At: approveAt, Type: "human.approval_recorded", Station: "human-approval", Visit: 1, Round: 1, Data: M{"round": 1, "decision": "APPROVED", "note_given": false}})
		}
		f.lifecycle(ticket, recs...)
	}
	high("T-9", at(2*hour+30*min_))
	high("T-9b", time.Time{})
	f.intake(L{At: at(40 * min_), Type: "human.required", Ticket: "T-9c", Data: M{"reason": "merging is kept for a person"}})
	o := observe(f)
	d := o.metrics(allIDs(), "")
	// W3: T-9 decided AWAITING_HUMAN 09:30:00.000, approved 11:30:00.000: 7,200,000 measured.
	// T-9b is open: counted apart, never averaged.
	w3 := metric(t, d, "W3")
	fig(t, "W3", w3, f64(7200000), f64(7200000), f64(1), f64(1))
	if b := basis(w3); b["open"] == nil || b["open"].(float64) != 1 {
		t.Errorf("W3 open %v", b)
	}
	if ex := excluded(w3); ex["open"] != 1 {
		t.Errorf("W3 coverage excluded %v", ex)
	}
	// R1: AWAITING_HUMAN is not a rejection: 0/2 decided rounds.
	fig(t, "R1", metric(t, d, "R1"), f64(0), f64(0), f64(2), f64(2))
	// S4: one human.required event.
	fig(t, "S4", metric(t, d, "S4"), f64(1), f64(1), none, f64(1))
	// Contributors W3: both waits (one measured 7,200,000, one open with no value).
	c := o.contributors("W3", "")
	if c["total"].(float64) != 2 {
		t.Errorf("W3 contributors %v", refs(c))
	}
	byb := obj(c["by_basis"])
	if byb["measured"] != 1.0 || byb["open"] != 1.0 {
		t.Errorf("W3 contributors by basis %v", byb)
	}
	for _, it := range arr(c["items"]) {
		im := obj(it)
		if im["basis"] == "open" && im["value"] != nil {
			t.Errorf("an open wait has a value: %s", show(im))
		}
	}
	// Flow: the human-approval waits: 2 (1 measured, 1 open).
	flow := o.get("/api/v1/analytics/flow")
	found := false
	for _, wv := range arr(flow["waits"]) {
		wm := obj(wv)
		if wm["kind"] == "human-approval" {
			found = true
			dur := obj(wm["duration"])
			if wm["count"].(float64) != 2 || obj(dur["basis"])["open"].(float64) != 1 || obj(dur["measured"])["total_ms"].(float64) != 7200000 {
				t.Errorf("human-approval waits %s", show(wm))
			}
		}
	}
	if !found {
		t.Errorf("no human-approval waits in %s", show(flow["waits"]))
	}
	common(t, o)
}

// Scenario 10: interrupted executions. X1 is interrupted during build; the supervisor records the
// failure; X2 resumes the ticket, re-enters build and finishes it.
func TestS10Interrupted(t *testing.T) {
	f := newFx(t)
	b := at(0)
	f.lifecycle("T-10", append(planVisit(b.Add(10*sec), b.Add(40*sec), "Medium", "cli"),
		R{At: b.Add(2 * min_), Type: "station.entered", Station: "build", Visit: 1, Round: 1, Exec: X1, Data: M{"stage": "building"}})...)
	f.exec(X1, "T-10", at(1*min_+5*sec), at(20*min_), "interrupted", nil)
	f.intake(
		L{At: at(1 * min_), Type: "work.claimed", Ticket: "T-10", Exec: X1, Data: M{"stage": "planned", "next": "build", "attempt": 1}},
		L{At: at(1*min_ + sec), Type: "execution.started", Ticket: "T-10", Exec: X1, Data: M{"until": "merge", "workflow": "mach-belt"}},
		L{At: at(20*min_ + 30*sec), Type: "execution.failed", Ticket: "T-10", Exec: X1, Data: M{"stage": "building", "next": "build", "how": "interrupted", "attempt": 1}},
	)
	f.lifecycle("T-10", R{At: b.Add(31 * min_), Type: "station.entered", Station: "build", Visit: 2, Round: 1, Exec: X2, Data: M{"stage": "building", "unclosed_visit": "build#1"}},
		task(b.Add(35*min_), "T1"))
	f.lifecycle("T-10", R{At: b.Add(41 * min_), Type: "station.exited", Station: "build", Visit: 2, Round: 1, Exec: X2, Data: M{"outcome": "built", "stage": "built"}})
	f.supervised("T-10", X2, at(30*min_), at(42*min_), at(42*min_+10*sec), 0.4)
	o := observe(f)
	d := o.metrics(allIDs(), "")
	// X1: 1 failed / 2 claimed. S3: 1 completed / (1 + 1). An interruption is not an unknown
	// outcome: S2 0/2.
	fig(t, "X1", metric(t, d, "X1"), f64(0.5), f64(1), f64(2), f64(2))
	fig(t, "S3", metric(t, d, "S3"), f64(0.5), f64(1), f64(2), f64(2))
	fig(t, "S2", metric(t, d, "S2"), f64(0), f64(0), f64(2), f64(2))
	// C1: plan 30,000 + build#2 10 min 600,000 = 630,000 over 2 measured. build#1 never exited:
	// its end is inferred at X1's end; never measured and never averaged; not open either (the
	// execution that ran it has ended).
	c1 := metric(t, d, "C1")
	fig(t, "C1", c1, f64(315000), f64(630000), f64(2), f64(2))
	bc := basis(c1)
	if bc["open"] != nil && bc["open"].(float64) != 0 {
		t.Errorf("C1: build#1 is reported open after its execution ended: %v", bc)
	}
	if bc["inferred"].(float64)+bc["bounded"].(float64)+bc["unknown"].(float64) != 1 {
		t.Errorf("C1: build#1 not counted apart: %v", bc)
	}
	// K1: X2 0.40 / 1 execution with a cost; X1 failed (no cost recorded, and not a zero).
	k1 := metric(t, d, "K1")
	fig(t, "K1", k1, f64(0.4), f64(0.4), f64(1), f64(1))
	// Contributors: the one failed execution, state interrupted; C1's items agree with the metric's
	// basis counts.
	if x := o.contributors("X1", ""); !sameSet(refs(x), []string{"execution:" + X1}) {
		t.Errorf("X1 contributors %v", refs(x))
	}
	if x := o.contributors("executions", "&group=state:interrupted"); !sameSet(refs(x), []string{"execution:" + X1}) {
		t.Errorf("interrupted executions %v", refs(x))
	}
	c := o.contributors("C1", "")
	byb := obj(c["by_basis"])
	if byb["measured"] != 2.0 || c["total"].(float64) != 3 {
		t.Errorf("C1 contributors %v by basis %v", refs(c), byb)
	}
	for k, n := range byb {
		if k != "measured" && bc[k] != n {
			t.Errorf("C1 basis %s: metric %v, contributors %v", k, bc[k], n)
		}
	}
	// Flow: build visits 2 (one ticket); the first one is not measured.
	flow := o.get("/api/v1/analytics/flow")
	bs := station(t, flow, "build")
	if bs["visits"].(float64) != 2 || bs["tickets"].(float64) != 1 || obj(obj(bs["duration"])["basis"])["measured"].(float64) != 1 {
		t.Errorf("build %s", show(bs))
	}
	if tr := transitions(flow); tr["build->build"] != 1 || tr["plan->build"] != 1 {
		t.Errorf("transitions %v", tr)
	}
	common(t, o)
}
