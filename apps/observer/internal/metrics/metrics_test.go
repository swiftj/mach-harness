package metrics

import (
	"testing"
)

func i64(v int64) *int64     { return &v }
func f64(v float64) *float64 { return &v }

func TestDurationsAndNulls(t *testing.T) {
	tb := NewTable()
	for _, ms := range []int64{500, 2000, 4000, 60000} {
		tb.Duration("C1", []Dim{{"station", "build"}}, "2026-11-12", ms)
	}
	row := tb.Rows([]string{"C1"}, "station")[0]
	if row.PercentileBasis != "histogram" || row.Groups[0].PercentileBasis != "histogram" {
		t.Fatalf("p50 and p90 must say they come from the histogram: %+v", row)
	}
	if *row.Value != 16625 || *row.Min != 500 || *row.Max != 60000 || row.P50 == nil || len(row.Groups) != 1 || row.Groups[0].Key != "build" {
		t.Fatalf("%+v", row)
	}
	if day := tb.Rows([]string{"C1"}, "day")[0]; len(day.Groups) != 1 || day.Groups[0].Key != "2026-11-12" {
		t.Fatalf("%+v", day.Groups)
	}
	tb.Rate("Q1", nil, "", 0, 0)
	if r := tb.Rows([]string{"Q1"}, "")[0]; r.Value != nil || r.NullReason != "the denominator is empty" {
		t.Fatalf("%+v", r)
	}
	if r := tb.Rows([]string{"Q2"}, "")[0]; r.Value != nil || r.NullReason != "no events of this kind have been observed" {
		t.Fatalf("%+v", r)
	}
	if r := tb.Rows([]string{"G4"}, "")[0]; r.Value != nil || r.Basis != "not-recorded" || r.Status != "not-recorded" {
		t.Fatalf("%+v", r)
	}
	if len(tb.Rows(nil, "")) != len(Catalog) {
		t.Fatal("not every metric was returned")
	}
}

// A member that would need a cell past the limit is folded into its day's overflow cell: the
// total stays exact and groups name it "overflow".
func TestGroupsAreBounded(t *testing.T) {
	tb := NewTable()
	n := MaxGroups + 50
	for i := 0; i < n; i++ {
		tb.Count("S5", []Dim{{"tool", string(rune('a'+i%26)) + string(rune(i))}}, "2026-11-12", 1)
	}
	if len(tb.Cells["S5"]) > MaxGroups+1 || tb.Overflow != 50 {
		t.Fatalf("%d cells, overflow %d", len(tb.Cells["S5"]), tb.Overflow)
	}
	row := tb.Query(Query{IDs: []string{"S5"}, GroupBy: []string{"tool"}})[0]
	if *row.Value != float64(n) {
		t.Fatalf("total %v, want %d", *row.Value, n)
	}
	if len(row.Groups) != MaxResponseGroups || row.GroupsOmit != MaxGroups+1-MaxResponseGroups {
		t.Fatalf("%d groups served, %d omitted", len(row.Groups), row.GroupsOmit)
	}
	// The overflow cell is a group of its own, so nothing is lost from the total.
	if a := tb.Cells["S5"]["2026-11-12"+sep+overflowKey]; a == nil || a.Num != 50 {
		t.Fatalf("overflow cell %+v", a)
	}
}

// K6 is not computed: the catalog marked it available, the code never had a source.
func TestK6IsNotRecorded(t *testing.T) {
	r := NewTable().Rows([]string{"K6"}, "")[0]
	if r.Status != "not-recorded" || r.Value != nil || r.NullReason == "" || r.Avail != "no" {
		t.Fatalf("%+v", r)
	}
}

// A group by a split dimension takes its numerator from its own cells and its denominator from
// the whole population (the audit's X3 by gate, S1 by kind, K3 by token kind: always null).
func TestSplitDenominators(t *testing.T) {
	tb := NewTable()
	day := "2026-11-12"
	for i := 0; i < 4; i++ {
		tb.Rate("X3", []Dim{{"risk", "High"}}, day, 0, 1) // build tasks
	}
	tb.Rate("X3", []Dim{{"gate", "build.green"}, {"risk", "High"}}, day, 1, 0)
	row := tb.Rows([]string{"X3"}, "gate")[0]
	if *row.Value != 0.25 || len(row.Groups) != 1 || row.Groups[0].Key != "build.green" || row.Groups[0].Value == nil || *row.Groups[0].Value != 0.25 {
		t.Fatalf("%+v", row.Groups)
	}
	// Two dimensions, one split: the denominator follows the other.
	tb.Rate("K3", []Dim{{"model", "m1"}}, day, 0, 1)
	tb.Rate("K3", []Dim{{"model", "m1"}, {"token_kind", "input"}}, day, 100, 0)
	tb.Rate("K3", []Dim{{"model", "m1"}, {"token_kind", "output"}}, day, 300, 0)
	tb.Rate("K3", []Dim{{"model", "m2"}}, day, 0, 1)
	tb.Rate("K3", []Dim{{"model", "m2"}}, day, 0, 1)
	tb.Rate("K3", []Dim{{"model", "m2"}, {"token_kind", "input"}}, day, 50, 0)
	k3 := tb.Query(Query{IDs: []string{"K3"}, GroupBy: []string{"model", "token_kind"}})[0]
	got := map[string]float64{}
	for _, g := range k3.Groups {
		if g.Value == nil {
			t.Fatalf("null group %+v", g)
		}
		got[g.Key] = *g.Value
	}
	if got["m1|input"] != 100 || got["m1|output"] != 300 || got["m2|input"] != 25 || len(got) != 3 {
		t.Fatalf("%v", got)
	}
	if *k3.Value != 450.0/3 {
		t.Fatalf("total %v", *k3.Value)
	}
}

// A distinct denominator counts each ticket once in a window or group (K4, C2).
func TestDistinctDenominator(t *testing.T) {
	tb := NewTable()
	tb.Rate("K4", []Dim{{"ticket", "T-1"}}, "2026-11-10", 2, 1)
	tb.Rate("K4", []Dim{{"ticket", "T-1"}}, "2026-11-11", 3, 1)
	tb.Rate("K4", []Dim{{"ticket", "T-2"}}, "2026-11-11", 4, 1)
	r := tb.Rows([]string{"K4"}, "")[0]
	if *r.Numerator != 9 || *r.Denominator != 2 || *r.Value != 4.5 {
		t.Fatalf("%v / %v = %v", *r.Numerator, *r.Denominator, *r.Value)
	}
	w := tb.Query(Query{IDs: []string{"K4"}, Windowed: true, FromDay: "2026-11-11", ToDay: "2026-11-11"})[0]
	if *w.Numerator != 7 || *w.Denominator != 2 {
		t.Fatalf("window %v / %v", *w.Numerator, *w.Denominator)
	}
	byTicket := tb.Rows([]string{"K4"}, "ticket")[0]
	if len(byTicket.Groups) != 2 || *byTicket.Groups[0].Value != 5 || *byTicket.Groups[0].Denominator != 1 {
		t.Fatalf("%+v", byTicket.Groups)
	}
}

// Durations: measured, bounded, unknown and open are counted apart; the statistic is over
// measured only; coverage says what was left out and why.
func TestBasisAndCoverage(t *testing.T) {
	tb := NewTable()
	day := "2026-11-12"
	tb.Duration("C1", nil, day, 10000)
	tb.Basis("C1", nil, day, "bounded", i64(2000), i64(9000))
	tb.Basis("C1", nil, day, "unknown", nil, nil)
	tb.OpenAdd("C1", day, 1)
	tb.OpenAdd("C1", day, 1)
	tb.OpenAdd("C1", day, -1)
	r := tb.Rows([]string{"C1"}, "")[0]
	b := r.BasisCounts
	if *r.Value != 10000 || b.Measured != 1 || b.Bounded != 1 || b.Unknown != 1 || b.Open == nil || *b.Open != 1 {
		t.Fatalf("%v %+v", *r.Value, b)
	}
	if r.Bounds == nil || *r.Bounds.MinMS != 2000 || *r.Bounds.MaxMS != 9000 {
		t.Fatalf("%+v", r.Bounds)
	}
	if *r.Coverage.Eligible != 4 || *r.Coverage.Counted != 1 || len(r.Coverage.Excluded) != 3 || *r.Coverage.Share != 0.25 {
		t.Fatalf("%+v", r.Coverage)
	}
	// Every metric carries coverage fields.
	for _, row := range tb.Rows(nil, "") {
		if row.Coverage.Excluded == nil || row.BasisCounts == nil && row.Status == "available" {
			t.Fatalf("%s has no coverage or basis: %+v", row.ID, row.Coverage)
		}
	}
	// Refused records count against the metrics of their stream.
	tb.Rate("Q2", nil, day, 1, 1)
	tb.Refuse("run", day, 2)
	q2 := tb.Rows([]string{"Q2"}, "")[0]
	if *q2.Coverage.Eligible != 3 || q2.Coverage.Excluded[0].Reason != exRefused || q2.Coverage.Excluded[0].Count != 2 {
		t.Fatalf("%+v", q2.Coverage)
	}
}

// observe.py measure: round(value, 3) (ties to even, on the binary value) for display; the target
// is decided on the unrounded value; the API serves the unrounded value too.
func TestObserveRoundingAndTarget(t *testing.T) {
	for v, want := range map[float64]float64{0.0625: 0.062, 0.8125: 0.812, 0.3125: 0.312, 0.0015: 0.002, 2.675: 2.675, 0.1235: 0.123, 1.0005: 1} {
		if got := RoundObserve(v); got != want {
			t.Errorf("RoundObserve(%v) = %v, want %v", v, got, want)
		}
	}
	tb := NewTable()
	tb.Rate("R5", nil, "", 99, 1983) // 0.049924..., which rounds to 0.05
	r := tb.Rows([]string{"R5"}, "")[0]
	if *r.ValueRounded != 0.05 || *r.Value != 99.0/1983 || r.Met == nil || !*r.Met || r.TargetCheck == nil || !*r.TargetCheck.Met || r.TargetCheck.Direction != "below" {
		t.Fatalf("value %v rounded %v met %v", *r.Value, *r.ValueRounded, r.Met)
	}
}

// A run with no outcome is neither merged nor abandoned (observe.py scorecard); unknown risk is
// its own group.
func TestFoldRunParity(t *testing.T) {
	tb := NewTable()
	tb.FoldRun(RunFacts{Outcome: "merged", Rounds: f64(1), FirstPass: true, Risk: "High"}, "2026-11-12")
	tb.FoldRun(RunFacts{Outcome: "", Rounds: f64(3), FirstPass: true, Escalated: true}, "2026-11-12")
	tb.FoldRun(RunFacts{Outcome: "abandoned", Risk: "Low"}, "2026-11-12")
	rows := map[string]Row{}
	for _, r := range tb.Rows([]string{"Q2", "Q3", "R5", "R6"}, "risk") {
		rows[r.ID] = r
	}
	if *rows["Q2"].Value != 1 || *rows["Q2"].Denominator != 1 || *rows["Q3"].Value != 1 || *rows["R6"].Value != 1.0/3 || *rows["R5"].Value != 1.0/3 {
		t.Fatalf("Q2 %v Q3 %v R6 %v R5 %v", *rows["Q2"].Value, *rows["Q3"].Value, *rows["R6"].Value, *rows["R5"].Value)
	}
	if ex := rows["Q2"].Coverage.Excluded; len(ex) != 1 || ex[0].Reason != exNoOutcome {
		t.Fatalf("%+v", ex)
	}
	keys := map[string]bool{}
	for _, g := range rows["R5"].Groups {
		keys[g.Key] = true
	}
	if !keys["unknown"] || !keys["High"] || !keys["Low"] {
		t.Fatalf("%v", keys)
	}
}

// last_runs: observe.py select, the last n by closed_at, ties in record order, unreadable times
// the oldest.
func TestLastRuns(t *testing.T) {
	runs := []RunFacts{
		{Outcome: "merged", ClosedMS: 300, ClosedOK: true, Risk: "a"},
		{Outcome: "merged", ClosedMS: 100, ClosedOK: true, Risk: "b"},
		{Outcome: "merged", Risk: "c"},
		{Outcome: "merged", ClosedMS: 300, ClosedOK: true, Risk: "d"},
		{Outcome: "merged", ClosedMS: 200, ClosedOK: true, Risk: "e"},
	}
	got := ""
	for _, r := range LastRuns(runs, 3) {
		got += r.Risk
	}
	if got != "ead" {
		t.Fatalf("selected %q", got)
	}
	if got := LastRuns(runs, 9); len(got) != 5 || got[0].Risk != "c" {
		t.Fatalf("%+v", got)
	}
}

// The query surface: a window over day cells, filters with "unknown", two group dimensions,
// week buckets with suspect periods, and the distribution.
func TestQuerySurface(t *testing.T) {
	tb := NewTable()
	add := func(day, station, risk string, ms int64) {
		tb.Duration("C1", []Dim{{"station", station}, {"risk", risk}}, day, ms)
	}
	add("2026-11-02", "build", "High", 4000) // a Monday
	add("2026-11-03", "build", "", 8000)
	add("2026-11-09", "verify", "High", 2000)
	add("2026-11-10", "build", "High", 60000)
	tb.MarkSuspect("2026-11-10")

	w := tb.Query(Query{IDs: []string{"C1"}, Windowed: true, FromDay: "2026-11-03", ToDay: "2026-11-09"})[0]
	if *w.SampleCount != 2 || *w.Value != 5000 || w.Suspect {
		t.Fatalf("window %v %v suspect %v", *w.SampleCount, *w.Value, w.Suspect)
	}
	f := tb.Query(Query{IDs: []string{"C1"}, Filters: map[string]string{"risk": "unknown"}})[0]
	if *f.SampleCount != 1 || *f.Value != 8000 {
		t.Fatalf("unknown filter %v", *f.SampleCount)
	}
	if u := tb.Query(Query{IDs: []string{"C1"}, Filters: map[string]string{"model": "x"}})[0]; u.Status != "unavailable" || u.Value != nil {
		t.Fatalf("a filter the metric cannot honour must make it unavailable: %+v", u.Status)
	}
	g := tb.Query(Query{IDs: []string{"C1"}, GroupBy: []string{"station", "risk"}})[0]
	keys := map[string]float64{}
	for _, x := range g.Groups {
		keys[x.Key] = *x.SampleCount
		if len(x.Keys) != 2 {
			t.Fatalf("%+v", x.Keys)
		}
	}
	if keys["build|High"] != 2 || keys["build|unknown"] != 1 || keys["verify|High"] != 1 {
		t.Fatalf("%v", keys)
	}
	b := tb.Query(Query{IDs: []string{"C1"}, Bucket: "week", Distribution: true})[0]
	if len(b.Buckets) != 2 || b.Buckets[0].Period != "2026-11-02" || *b.Buckets[0].SampleCount != 2 || b.Buckets[0].Suspect || !b.Buckets[1].Suspect {
		t.Fatalf("%+v", b.Buckets)
	}
	if b.Buckets[1].ToMS-b.Buckets[1].FromMS != 7*86400000 {
		t.Fatal("a week bucket is seven days")
	}
	d := b.Distribution
	if d == nil || d.P10 == nil || d.P90 == nil || *d.P90 != 60000 || len(d.Histogram) != 4 || d.Basis != "histogram" || d.Bounds["p50"][1] < *d.P50 {
		t.Fatalf("%+v", d)
	}
	days := tb.Query(Query{IDs: []string{"C1"}, Bucket: "day", Windowed: true, FromDay: "2026-11-01", ToDay: "2026-11-04"})[0]
	if len(days.Buckets) != 4 || days.Buckets[0].Value != nil || days.Buckets[1].Value == nil {
		t.Fatalf("every day of the window is a bucket; an empty one is null, never 0: %+v", days.Buckets)
	}
}

// Float sums are merged in a fixed order: the same cells give the same bits on every read.
func TestReadsAreBitStable(t *testing.T) {
	tb := NewTable()
	for i, v := range []float64{0.1, 0.7, 1e-9, 3.3, 0.2, 1e9, 0.03} {
		tb.Rate("K1", []Dim{{"ticket", string(rune('a' + i))}}, "2026-11-12", v, 1)
	}
	first := *tb.Rows([]string{"K1"}, "")[0].Value
	for range 50 {
		if v := *tb.Rows([]string{"K1"}, "")[0].Value; v != first {
			t.Fatalf("%v then %v", first, v)
		}
	}
}
