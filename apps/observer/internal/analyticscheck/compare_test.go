package analyticscheck

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/testkit"
)

// Comparison correctness: the figures a Compare view puts side by side.

// twoWeeks: week 1 (Mon 2 Nov) holds T-A (High, web) and T-B (Medium, cli); week 2 (Mon 9 Nov)
// holds T-C (Medium, cli). Each is scenario 2's pass through the line (1,620,000 ms of visits).
func twoWeeks(t *testing.T) (*fx, *obs) {
	f := newFx(t)
	f.happyCell("T-A", "", 0, "High", "web")
	f.run("T-A", at(1*hour), map[string]any{"risk": "High", "app_type": "web", "first_pass": false, "rounds": 2})
	f.happyCell("T-B", "", 2*hour, "Medium", "cli")
	f.run("T-B", at(3*hour), nil)
	f.happyCell("T-C", "", 7*day_, "Medium", "cli")
	f.run("T-C", at(7*day_+hour), nil)
	return f, observe(f)
}

func TestCompareTimePeriods(t *testing.T) {
	_, o := twoWeeks(t)
	// from_ms is inclusive, to_ms exclusive, both widened to whole UTC days: week 1 is asked from
	// 09:00 on 2 Nov (widened to 00:00) to 00:00 on 9 Nov (already a midnight).
	mid := func(d int) int64 { return ms(time.Date(2026, 11, d, 0, 0, 0, 0, time.UTC)) }
	w1 := pf("&from_ms=%d&to_ms=%d", ms(at(0)), mid(9))
	w2 := pf("&from_ms=%d&to_ms=%d", mid(9), mid(16))
	a, b := o.metrics("T1,C1,Q2", w1), o.metrics("T1,C1,Q2", w2)
	// Week 1: 2 tickets merged; C1 10 visits, 3,240,000; Q2 1/2. Week 2: 1; 5 visits; Q2 1/1.
	fig(t, "T1 w1", metric(t, a, "T1"), f64(2), f64(2), none, f64(2))
	fig(t, "T1 w2", metric(t, b, "T1"), f64(1), f64(1), none, f64(1))
	fig(t, "C1 w1", metric(t, a, "C1"), f64(324000), f64(3240000), f64(10), f64(10))
	fig(t, "C1 w2", metric(t, b, "C1"), f64(324000), f64(1620000), f64(5), f64(5))
	fig(t, "Q2 w1", metric(t, a, "Q2"), f64(0.5), f64(1), f64(2), f64(2))
	fig(t, "Q2 w2", metric(t, b, "Q2"), f64(1), f64(1), f64(1), f64(1))
	// The window is widened to whole UTC days and says so: 09:00 on 2 Nov -> 00:00 on 2 Nov.
	win := obj(a["window"])
	eqNum(t, "effective_from_ms", win["effective_from_ms"], f64(float64(ms(time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)))))
	eqNum(t, "effective_to_ms", win["effective_to_ms"], f64(float64(ms(time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)))))
	// The weekly trend's buckets sum to the total: T1 2 + 1 = 3.
	tr := metric(t, o.metrics("T1,C1", "&bucket=week"), "T1")
	var sum float64
	for _, bk := range arr(tr["buckets"]) {
		if v := num(obj(bk)["value"]); v != nil {
			sum += *v
		}
	}
	if sum != 3 || len(arr(tr["buckets"])) != 2 {
		t.Errorf("T1 weekly buckets %s", show(tr["buckets"]))
	}
	// Contributors honour the window: week 2 holds T-C's five visits only.
	c := o.contributors("C1", w2)
	if c["total"].(float64) != 5 {
		t.Errorf("C1 contributors in week 2: %v", refs(c))
	}
	for _, r := range refs(c) {
		if !strings.HasPrefix(r, "visit:T-C/") {
			t.Errorf("week 2 contributor %s", r)
		}
	}
	// Sparse data: a daily trend over the whole first week: 7 buckets, data on Monday only; every
	// other day has no number (not 0) and a sample of 0.
	daily := metric(t, o.metrics("T1,C1", w1+"&bucket=day"), "C1")
	if n := len(arr(daily["buckets"])); n != 7 {
		t.Fatalf("C1 daily buckets: %d", n)
	}
	for i, bk := range arr(daily["buckets"]) {
		bm := obj(bk)
		if i == 0 {
			eqNum(t, "C1 Monday", bm["denominator"], f64(10))
			continue
		}
		if bm["value"] != nil || (bm["sample_count"] != nil && bm["sample_count"].(float64) != 0) {
			t.Errorf("C1 on an empty day %s: %s", bm["period"], show(bm))
		}
	}
}

func TestCompareRiskAndAppType(t *testing.T) {
	_, o := twoWeeks(t)
	// C1 by risk and app type: High/web 5 visits, Medium/cli 10 visits; sums reconcile.
	c1 := metric(t, o.metrics("C1", "&group_by=risk,app_type"), "C1")
	fig(t, "C1 High web", group(t, c1, "risk=High,app_type=web"), f64(324000), f64(1620000), f64(5), f64(5))
	fig(t, "C1 Medium cli", group(t, c1, "risk=Medium,app_type=cli"), f64(324000), f64(3240000), f64(10), f64(10))
	reconcile(t, "C1 by risk,app_type", c1)
	// Unequal samples are never averaged as rates: Q2 High 0/1, Medium 2/2; the total is
	// (0 + 2) / (1 + 2) = 0.667, not the mean of the two rates (0.5).
	q2 := metric(t, o.metrics("Q2", "&group_by=risk"), "Q2")
	fig(t, "Q2 High", group(t, q2, "risk=High"), f64(0), f64(0), f64(1), f64(1))
	fig(t, "Q2 Medium", group(t, q2, "risk=Medium"), f64(1), f64(2), f64(2), f64(2))
	fig(t, "Q2", q2, f64(2.0/3), f64(2), f64(3), f64(3))
	// A filter narrows; a filter the metric cannot honour makes it unavailable, never unfiltered.
	hi := o.metrics("C1,Q2,K2", "&risk=High")
	fig(t, "C1 High", metric(t, hi, "C1"), f64(324000), f64(1620000), f64(5), f64(5))
	fig(t, "Q2 High", metric(t, hi, "Q2"), f64(0), f64(0), f64(1), f64(1))
	cm := o.metrics("C1,K2", "&model=claude-opus-5-5")
	if r := metric(t, cm, "C1"); r["status"] != "unavailable" || r["value"] != nil {
		t.Errorf("C1 filtered by model: %v %v", r["status"], r["value"])
	}
	// A risk no ticket had: no number.
	lo := o.metrics("C1,Q2,T1", "&risk=Low")
	for _, id := range []string{"C1", "Q2", "T1"} {
		if r := metric(t, lo, id); r["value"] != nil {
			t.Errorf("%s at risk Low: %v", id, r["value"])
		}
	}
	// Flow by risk: High has 5 stations of 1 visit each.
	fl := o.get("/api/v1/analytics/flow?risk=High")
	if s := station(t, fl, "build"); s["visits"].(float64) != 1 {
		t.Errorf("flow High build %v", s)
	}
}

// Model configurations and missing version metadata: executions started with configuration A,
// with configuration B, with a capture that failed, and before provenance existed. The
// not-recorded cohort is its own; never merged into a recorded one.
func TestCompareConfigurations(t *testing.T) {
	f := newFx(t)
	cfgA, cfgB := strings.Repeat("a1", 32), strings.Repeat("b2", 32)
	start := func(tk, x string, c time.Time, prov any, reason string) {
		data := M{"until": "merge", "workflow": "mach-belt"}
		if prov != nil {
			data["provenance"] = prov
		}
		if reason != "" {
			data["provenance"], data["provenance_reason"] = nil, reason
		}
		f.exec(x, tk, c.Add(5*sec), c.Add(10*min_), "exited", 0)
		f.intake(L{At: c, Type: "work.claimed", Ticket: tk, Exec: x, Data: M{"stage": "planned", "next": "build", "attempt": 1}},
			L{At: c.Add(sec), Type: "execution.started", Ticket: tk, Exec: x, Commit: "0123456789abcdef", Data: data},
			L{At: c.Add(11 * min_), Type: "execution.completed", Ticket: tk, Exec: x, Data: M{"stage": "built", "next": "verify", "cost_usd": 1.0}})
	}
	start("T-1", X1, at(0), M{"schema": 1, "config_id": cfgA}, "")
	start("T-2", X2, at(20*min_), M{"schema": 1, "config_id": cfgA}, "")
	start("T-3", X3, at(40*min_), M{"schema": 1, "config_id": cfgB}, "")
	start("T-4", X4, at(60*min_), nil, "capture-failed")
	start("T-5", X5, at(80*min_), nil, "")
	f.usage(X1, at(10*min_), 1.0, U{Model: "claude-opus-5-5", Cost: 1.0})
	f.usage(X3, at(50*min_), 1.0, U{Model: "claude-sonnet-5-5", Cost: 1.0})
	o := observe(f)
	count := func(q string) float64 { return o.get("/api/v1/analytics/runs?of=executions" + q)["total"].(float64) }
	if a, b, nr, all := count("&provenance="+cfgA), count("&provenance="+cfgB), count("&provenance=not-recorded"), count(""); a != 2 || b != 1 || nr != 2 || all != 5 {
		t.Errorf("cohorts: A %v, B %v, not recorded %v, all %v", a, b, nr, all)
	}
	reasons := map[string]string{}
	for _, it := range arr(o.get("/api/v1/analytics/runs?of=executions&provenance=not-recorded")["items"]) {
		im := obj(it)
		reasons[im["execution_id"].(string)], _ = im["provenance_reason"].(string)
		if im["provenance"] != nil || im["provenance_recorded"] != false {
			t.Errorf("not-recorded cohort member %s carries provenance %v", im["execution_id"], im["provenance"])
		}
	}
	if reasons[X4] != "capture-failed" || reasons[X5] != "not-recorded" {
		t.Errorf("reasons %v (capture-failed and not-recorded stay distinguishable)", reasons)
	}
	// Metrics cannot be filtered by provenance: unavailable with a reason, never a number.
	for _, m := range arr(o.metrics("K1,X1,S3", "&provenance="+cfgA)["metrics"]) {
		if row := obj(m); row["status"] != "unavailable" || row["value"] != nil {
			t.Errorf("%s by provenance: %v %v", row["id"], row["status"], row["value"])
		}
	}
	// Model: K2 by model, one execution each.
	k2 := metric(t, o.metrics("K2", "&group_by=model"), "K2")
	fig(t, "K2 opus", group(t, k2, "model=claude-opus-5-5"), f64(1), f64(1), f64(1), f64(1))
	fig(t, "K2 sonnet", group(t, k2, "model=claude-sonnet-5-5"), f64(1), f64(1), f64(1), f64(1))
	if len(arr(k2["groups"])) != 2 {
		t.Errorf("K2 groups %v (executions with no usage form no model group)", groupKeys(k2))
	}
	if r := o.get("/api/v1/analytics/runs?of=executions&model=claude-opus-5-5"); r["total"].(float64) != 1 {
		t.Errorf("executions by model %v", r["total"])
	}
}

// Incomplete usage accounting: a workflow killed at its budget reports a spend that may be low.
// The figure keeps the recorded number and discloses that it may be under-reported; nothing is
// added to it.
func TestCompareIncompleteUsageAccounting(t *testing.T) {
	f := newFx(t)
	f.supervised("T-1", X1, at(0), at(10*min_), at(10*min_+5*sec), 2.0)
	f.workflow(X1, at(10*sec), at(9*min_), "killed")
	res, _ := json.Marshal(M{"type": "result", "subtype": "error_max_budget_usd", "is_error": true, "total_cost_usd": 2.0, "terminal_reason": "budget",
		"result_index": 0, "session_id": "s-" + X1, "modelUsage": M{"claude-sonnet-5-5": M{"costUSD": 2.0, "inputTokens": 1, "outputTokens": 1,
			"cacheReadInputTokens": 0, "cacheCreationInputTokens": 0}}})
	testkit.Append(t, filepath.Join(testkit.ExecDir(f.root, X1), "stream.jsonl"), append(res, '\n'))
	f.supervised("T-2", X2, at(20*min_), at(30*min_), at(30*min_+5*sec), 1.0)
	f.usage(X2, at(30*min_), 1.0, U{Model: "claude-sonnet-5-5", Cost: 1.0})
	o := observe(f)
	d := o.metrics(allIDs(), "")
	// K1 keeps what was recorded: (2.0 + 1.0) / 2. S6: 1 killed / 1 workflow finished.
	fig(t, "K1", metric(t, d, "K1"), f64(1.5), f64(3), f64(2), f64(2))
	fig(t, "S6", metric(t, d, "S6"), f64(1), f64(1), f64(1), f64(1))
	s6 := metric(t, o.metrics("S6", "&group_by=stop_reason"), "S6")
	fig(t, "S6 budget", group(t, s6, "stop_reason=budget"), f64(1), f64(1), f64(1), f64(1))
	var x1 M
	for _, it := range arr(o.get("/api/v1/analytics/runs?of=executions")["items"]) {
		if obj(it)["execution_id"] == X1 {
			x1 = obj(it)
		}
	}
	u := obj(x1["usage"])
	if u["complete"] != false || !strings.Contains(show(u["incomplete_reasons"]), "budget-stop") {
		t.Errorf("X1 usage %s: a budget stop must say the cost may be incomplete", show(u))
	}
}

// Unavailable metrics never carry a number: not recorded, deferred, a population they are not
// computed from (last_runs), or a filter they cannot honour.
func TestCompareUnavailable(t *testing.T) {
	_, o := twoWeeks(t)
	d := o.metrics(allIDs(), "")
	for id, status := range map[string]string{"K5": "not-recorded", "K6": "not-recorded", "G4": "not-recorded", "T3": "deferred", "C5": "deferred", "R4": "deferred"} {
		r := metric(t, d, id)
		if r["status"] != status || r["value"] != nil || r["numerator_value"] != nil || r["denominator_value"] != nil {
			t.Errorf("%s: status %v value %v", id, r["status"], r["value"])
		}
		if r["status_reason"] == nil {
			t.Errorf("%s: no reason", id)
		}
	}
	lr := o.metrics(allIDs(), "&last_runs=2")
	for _, m := range arr(lr["metrics"]) {
		r := obj(m)
		switch r["id"] {
		case "Q2", "Q3", "R5", "R6", "G1", "G2":
		default:
			if r["value"] != nil {
				t.Errorf("%s under last_runs: %v", r["id"], r["value"])
			}
		}
	}
	// last_runs=2 is observe's population: the two most recent by closed_at (T-B, T-C): Q2 2/2.
	fig(t, "Q2 last 2", metric(t, lr, "Q2"), f64(1), f64(2), f64(2), f64(2))
	// Group by a dimension a metric is not recorded by: no groups and a reason, never the total
	// passed off as a group.
	k1 := metric(t, o.metrics("K1", "&group_by=station"), "K1")
	if len(arr(k1["groups"])) != 0 || k1["groups_reason"] == nil {
		t.Errorf("K1 by station: %s %v", show(k1["groups"]), k1["groups_reason"])
	}
}

// The same population by risk in /metrics and /flow. A hand-driven ticket whose plan records its
// risk (High) on the plan's exit: all five of its visits are High-risk work. C2 and C1 filtered by
// risk=High must count the visits /flow?risk=High counts (5); and the ticket must not be split
// across risk groups (a ticket has one risk at a time; its plan visit is not of "unknown" risk once
// the plan has recorded it).
func TestCompareDimensionAttribution(t *testing.T) {
	f := newFx(t)
	f.happyCell("T-1", "", 0, "High", "web")
	o := observe(f)
	flowVisits := 0.0
	for _, s := range arr(o.get("/api/v1/analytics/flow?risk=High")["stations"]) {
		flowVisits += obj(s)["visits"].(float64)
	}
	if flowVisits != 5 {
		t.Fatalf("flow?risk=High: %v visits", flowVisits)
	}
	hi := o.metrics("C1,C2", "&risk=High")
	// C2 at risk High: 5 visits / 1 ticket. C1 at risk High: 5 measured visits, 1,620,000.
	fig(t, "C2 risk=High", metric(t, hi, "C2"), f64(5), f64(5), f64(1), f64(1))
	fig(t, "C1 risk=High", metric(t, hi, "C1"), f64(324000), f64(1620000), f64(5), f64(5))
	c2 := metric(t, o.metrics("C2", "&group_by=risk"), "C2")
	if keys := groupKeys(c2); len(keys) != 1 || keys[0] != "High" {
		t.Errorf("C2 by risk: one ticket of risk High split into groups %v", keys)
	}
}
