package insight

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"mach/observer/internal/metrics"
	"mach/observer/internal/project"
)

// ---- constructors ----

func row(id string, num, den float64, share float64) metrics.Row {
	r := metrics.Row{Def: metrics.Def{ID: id, Name: id}, Status: "available", Numerator: f(num), Denominator: f(den), SampleCount: f(den)}
	if den > 0 {
		r.Value = f(num / den)
	}
	r.Coverage = metrics.Coverage{Share: f(share), Eligible: f(den / share), Counted: f(den)}
	return r
}

func covRow(id string, eligible, counted float64) metrics.Row {
	r := row(id, counted, counted, 1)
	r.Coverage = metrics.Coverage{Eligible: f(eligible), Counted: f(counted), Share: f(counted / eligible)}
	return r
}

func scoreRow(id string, num, den, target float64, below bool) metrics.Row {
	r := row(id, num, den, 1)
	v := num / den
	met := v > target
	dir := "above"
	if below {
		met, dir = v < target, "below"
	}
	r.TargetCheck = &metrics.TargetCheck{Value: target, Direction: dir, Met: &met}
	return r
}

func station(name string, measured, total, visits int64) project.StationFlow {
	return project.StationFlow{Station: name, Visits: visits, Tickets: visits, Duration: project.DurationSummary{Count: visits,
		Measured: &project.MeasuredStats{Count: measured, TotalMS: total, MedianMS: total / max(measured, 1), P90MS: total / max(measured, 1)}}}
}

func wait(kind string, measured, total, p90 int64) project.WaitSummary {
	return project.WaitSummary{Kind: kind, Count: measured, Tickets: measured, Duration: project.DurationSummary{Count: measured,
		Measured: &project.MeasuredStats{Count: measured, TotalMS: total, MedianMS: p90 / 2, P90MS: p90}}}
}

func i64(v int64) *int64 { return &v }

// quiet is an input on which every rule runs and none fires.
func quiet() Input {
	from, to, pf, pt := i64(1_000*86_400_000), i64(1_014*86_400_000), i64(986*86_400_000), i64(1_000*86_400_000)
	cur := map[string]metrics.Row{
		"C3": row("C3", 100*3_600_000, 10, 1), "R1": row("R1", 2, 20, 1), "X2/verify": row("X2", 2, 20, 1),
		"S1": row("S1", 0, 20, 1), "S2": row("S2", 0, 20, 1), "X1": row("X1", 0, 20, 1), "K1": row("K1", 10, 20, 1), "T2": row("T2", 5, 0, 1),
	}
	cur["T2"] = metrics.Row{Def: metrics.Def{ID: "T2"}, Status: "available", Value: f(5)}
	c3 := cur["C3"]
	c3.BasisCounts = &metrics.BasisCounts{Measured: 10}
	cur["C3"] = c3
	c1 := metrics.Row{Def: metrics.Def{ID: "C1"}, Status: "available", Groups: []metrics.Group{
		{Key: "1", Keys: map[string]string{"round": "1"}, Figure: metrics.Figure{Numerator: f(90), Denominator: f(25)}},
		{Key: "2", Keys: map[string]string{"round": "2"}, Figure: metrics.Figure{Numerator: f(10), Denominator: f(5)}},
	}}
	cur["C1/round"] = c1
	prev := map[string]metrics.Row{}
	for k, v := range cur {
		prev[k] = v
	}
	return Input{
		Window: Span{FromMS: from, ToMS: to}, Prev: &Span{FromMS: pf, ToMS: pt}, Filters: map[string]string{},
		Cur: cur, PrevRows: prev,
		Score:           map[string]metrics.Row{"Q2": scoreRow("Q2", 9, 10, 0.85, false), "Q3": scoreRow("Q3", 11, 10, 1.3, true), "R5": scoreRow("R5", 0, 10, 0.05, true)},
		ScorePopulation: "test population",
		Flow: &project.FlowReport{
			Stations: []project.StationFlow{station("build", 10, 30, 10), station("verify", 10, 30, 10), station("review", 10, 30, 10), station("merge", 10, 10, 10)},
			Waits:    []project.WaitSummary{wait("capacity", 10, 3_600_000, 3_600_000), wait("human-approval", 10, 3_600_000, 3_600_000)},
			Coverage: project.FlowCoverage{Tickets: 10, TicketsWithLifecycle: 10},
		},
		FailureKinds: Recurring{Analyzed: 20, Population: "tickets", Groups: []RecurringGroup{{Key: "scenario", Tickets: 2, Count: 3}}},
		BlockerRules: Recurring{Analyzed: 20, Population: "tickets", Groups: []RecurringGroup{{Key: "rev-3", Tickets: 1, Count: 2}}},
		GateRefusals: Recurring{Analyzed: 20, Population: "tickets", Groups: []RecurringGroup{{Key: "build.red", Tickets: 1, Count: 1}}},
		Exec:         ExecFacts{Total: 20}, PrevExec: ExecFacts{Total: 20},
		StreamUsage:   StreamUsageFacts{Executions: 20},
		HistoryFromMS: i64(900 * 86_400_000),
		Capacity:      CapacityFacts{Limit: f(4), Days: 2, Waits: 5, Items: 3, Kind: "capacity"},
	}
}

func rulesFired(r Report) map[string]int {
	out := map[string]int{}
	for _, f := range r.Findings {
		out[f.Rule]++
	}
	return out
}

func notEvaluated(r Report, rule string) []string {
	var out []string
	for _, n := range r.NotEvaluated {
		if n.Rule == rule {
			out = append(out, n.Reason)
		}
	}
	return out
}

// ---- tests ----

func TestQuietInputFiresNothing(t *testing.T) {
	r := Evaluate(quiet())
	if len(r.Findings) != 0 {
		t.Fatalf("findings on a quiet input: %v", rulesFired(r))
	}
	for _, n := range r.NotEvaluated {
		{
			t.Errorf("not evaluated on a full input: %s %v: %s", n.Rule, n.Subject, n.Reason)
		}
	}
}

func TestEmptyProject(t *testing.T) {
	r := Evaluate(Input{})
	if len(r.Findings) != 0 {
		t.Fatalf("findings on an empty project: %v", rulesFired(r))
	}
	for _, d := range Rules {
		if len(notEvaluated(r, d.ID)) == 0 {
			t.Errorf("rule %s is silent on an empty project: it must say why it did not run", d.ID)
		}
	}
	if len(r.Findings) != 0 || r.Findings == nil || r.NotEvaluated == nil {
		t.Fatal("findings and not_evaluated must be arrays")
	}
}

// Each rule: fires on a constructed input, is silent just under its threshold, and under its
// minimum sample returns nothing and says so.
func TestRules(t *testing.T) {
	cases := []struct {
		rule        string
		fire, under func(*Input)
		few         func(*Input)
	}{
		{RuleStationShare,
			func(in *Input) { in.Flow.Stations[2] = station("review", 10, 38, 10) }, // 38/108 = 35.2%
			func(in *Input) { in.Flow.Stations[2] = station("review", 10, 37, 10) }, // 37/107 = 34.6%
			func(in *Input) {
				in.Flow.Stations = []project.StationFlow{station("build", 6, 10, 6), station("review", 6, 90, 6)}
			}},
		{RuleWaitP90,
			func(in *Input) { in.Flow.Waits[0] = wait("capacity", 10, 3_600_000, WaitP90MinMS) },
			func(in *Input) { in.Flow.Waits[0] = wait("capacity", 10, 3_600_000, WaitP90MinMS-1) },
			func(in *Input) { in.Flow.Waits = []project.WaitSummary{wait("capacity", 4, 3_600_000, 2*WaitP90MinMS)} }},
		{RuleWaitShare,
			func(in *Input) { in.Flow.Waits[1] = wait("human-approval", 10, 25*3_600_000, 3_600_000) },
			func(in *Input) { in.Flow.Waits[1] = wait("human-approval", 10, 25*3_600_000-1, 3_600_000) },
			func(in *Input) {
				in.Flow.Waits = []project.WaitSummary{wait("human-approval", 4, 90*3_600_000, 3_600_000)}
			}},
		{RuleRemediationShare,
			func(in *Input) { in.Cur["C1/round"].Groups[1].Numerator = f(30) }, // 30/120
			func(in *Input) { in.Cur["C1/round"].Groups[1].Numerator = f(29) }, // 29/119
			func(in *Input) {
				in.Cur["C1/round"].Groups[0].Denominator = f(10)
				in.Cur["C1/round"].Groups[1].Numerator = f(900)
			}},
		{RuleFirstPass,
			func(in *Input) { in.Score["Q2"] = scoreRow("Q2", 8, 10, 0.85, false) },
			func(in *Input) { in.Score["Q2"] = scoreRow("Q2", 86, 100, 0.85, false) },
			func(in *Input) { in.Score["Q2"] = scoreRow("Q2", 0, 4, 0.85, false) }},
		{RuleRounds,
			func(in *Input) { in.Score["Q3"] = scoreRow("Q3", 13, 10, 1.3, true) },
			func(in *Input) { in.Score["Q3"] = scoreRow("Q3", 129, 100, 1.3, true) },
			func(in *Input) { in.Score["Q3"] = scoreRow("Q3", 12, 4, 1.3, true) }},
		{RuleEscalation,
			func(in *Input) { in.Score["R5"] = scoreRow("R5", 1, 20, 0.05, true) },
			func(in *Input) { in.Score["R5"] = scoreRow("R5", 4, 100, 0.05, true) },
			func(in *Input) { in.Score["R5"] = scoreRow("R5", 4, 4, 0.05, true) }},
		{RuleTrendRejections,
			func(in *Input) { in.Cur["R1"] = row("R1", 5, 20, 1) }, // 25% vs 10%
			func(in *Input) { in.Cur["R1"] = row("R1", 39, 200, 1) },
			func(in *Input) { in.Cur["R1"] = row("R1", 9, 9, 1) }},
		{RuleTrendVerification,
			func(in *Input) { in.Cur["X2/verify"] = row("X2", 5, 20, 1) },
			func(in *Input) { in.Cur["X2/verify"] = row("X2", 39, 200, 1) },
			func(in *Input) {
				in.PrevRows["X2/verify"] = row("X2", 0, 9, 1)
				in.Cur["X2/verify"] = row("X2", 9, 9, 1)
			}},
		{RuleRecurringFailure,
			func(in *Input) { in.FailureKinds.Groups[0].Tickets = 3 }, // 15%
			func(in *Input) { in.FailureKinds.Analyzed = 21; in.FailureKinds.Groups[0].Tickets = 3 },
			func(in *Input) { in.FailureKinds.Analyzed = 4; in.FailureKinds.Groups[0].Tickets = 4 }},
		{RuleRecurringGate,
			func(in *Input) { in.GateRefusals.Analyzed = 5; in.GateRefusals.Groups[0].Tickets = 2 },
			func(in *Input) { in.GateRefusals.Analyzed = 5; in.GateRefusals.Groups[0].Tickets = 1 }, // under 2 tickets
			func(in *Input) { in.GateRefusals.Analyzed = 4; in.GateRefusals.Groups[0].Tickets = 4 }},
		{RuleRecurringBlocker,
			func(in *Input) { in.BlockerRules.Groups[0].Tickets = 3 },
			func(in *Input) { in.BlockerRules.Groups[0].Tickets = 2 },
			func(in *Input) { in.BlockerRules.Analyzed = 4; in.BlockerRules.Groups[0].Tickets = 4 }},
		{RuleCapacityHeld,
			func(in *Input) { in.Capacity.Days = 3 },
			func(in *Input) { in.Capacity.Days = 3; in.Capacity.Waits = 2 },
			func(in *Input) { in.Capacity.Limit = nil; in.Capacity.Days = 9 }},
		{RuleExecShare,
			func(in *Input) { in.Cur["S2"] = row("S2", 1, 20, 1) },
			func(in *Input) { in.Cur["S2"] = row("S2", 4, 81, 1) },
			func(in *Input) { in.Cur["S2"] = row("S2", 9, 9, 1) }},
		{RuleExecLater,
			func(in *Input) { in.Exec.Interrupted = 1 }, // 5% vs 0%; also fires execution-share? 5% < 10%: no
			func(in *Input) { in.Exec.Total = 21; in.Exec.Interrupted = 1 },
			func(in *Input) { in.PrevExec.Total = 9; in.Exec.Interrupted = 5 }},
		{RuleCostLater,
			func(in *Input) { in.Cur["K1"] = row("K1", 12.5, 20, 1) },
			func(in *Input) { in.Cur["K1"] = row("K1", 12.49, 20, 1) },
			func(in *Input) { in.Cur["K1"] = row("K1", 50, 9, 1) }},
		{RuleUsageMissing,
			func(in *Input) { in.Cur["K1"] = covRow("K1", 20, 18) },
			func(in *Input) { in.Cur["K1"] = covRow("K1", 100, 91) },
			func(in *Input) { in.Cur["K1"] = covRow("K1", 9, 1) }},
		{RuleUsageMissing + "/stream",
			func(in *Input) { in.StreamUsage.Missing = 2 },
			func(in *Input) { in.StreamUsage = StreamUsageFacts{Executions: 21, Missing: 2} },
			func(in *Input) { in.StreamUsage = StreamUsageFacts{Executions: 9, Missing: 9} }},
		{RuleLifecycleCoverage,
			func(in *Input) { in.Flow.Coverage.TicketsWithLifecycle = 7 },
			func(in *Input) { in.Flow.Coverage.TicketsWithLifecycle = 8 },
			func(in *Input) { in.Flow.Coverage = project.FlowCoverage{Tickets: 4, TicketsWithLifecycle: 0} }},
	}
	seen := map[string]bool{}
	for _, c := range cases {
		rule, _, _ := strings.Cut(c.rule, "/")
		seen[rule] = true
		t.Run(c.rule, func(t *testing.T) {
			c := c
			c.rule = rule
			in := quiet()
			c.fire(&in)
			r := Evaluate(in)
			if rulesFired(r)[c.rule] == 0 {
				t.Fatalf("does not fire: %v; not evaluated %v", rulesFired(r), notEvaluated(r, c.rule))
			}
			for _, fd := range r.Findings {
				if fd.Rule == c.rule {
					checkFinding(t, fd)
				}
			}
			in = quiet()
			c.under(&in)
			if r := Evaluate(in); rulesFired(r)[c.rule] != 0 {
				t.Fatalf("fires just under its threshold: %+v", r.Findings)
			}
			in = quiet()
			c.few(&in)
			r = Evaluate(in)
			if rulesFired(r)[c.rule] != 0 {
				t.Fatalf("fires under its minimum sample: %+v", r.Findings)
			}
			if len(notEvaluated(r, c.rule)) == 0 {
				t.Fatal("under its minimum sample, the rule must say why it did not run")
			}
		})
	}
	for _, d := range Rules {
		if !seen[d.ID] {
			t.Errorf("no test for %s", d.ID)
		}
	}
}

// checkFinding: the eight things every insight carries.
func checkFinding(t *testing.T, f Finding) {
	t.Helper()
	if f.Condition == "" || strings.Contains(f.Condition+f.Title+f.Why+f.Investigation.Text, "{") {
		t.Errorf("%s: condition or a template left unfilled: %q", f.ID, f.Condition)
	}
	if len(f.Measurements) == 0 || f.Sample.Unit == "" || f.Sample.Population == "" {
		t.Errorf("%s: no measurements or sample", f.ID)
	}
	if f.Window.FromMS == nil && f.Window.LastRuns == nil {
		t.Errorf("%s: no window", f.ID)
	}
	if f.Filters == nil || f.Why == "" || f.Investigation.Label != InvestigationLabel || f.Investigation.Text == "" {
		t.Errorf("%s: filters, why or investigation missing", f.ID)
	}
	if f.Contributors.Metric == "" || !strings.HasPrefix(f.Contributors.Path, "/api/v1/analytics/contributors?metric=") ||
		(f.Contributors.Relation != "exact" && f.Contributors.Relation != "related") {
		t.Errorf("%s: contributors %+v", f.ID, f.Contributors)
	}
	if _, ok := project.ContributorFigures[f.Contributors.Metric]; !ok {
		t.Errorf("%s: contributors figure %q is not served", f.ID, f.Contributors.Metric)
	}
	if f.Severity != Attention && f.Severity != Note {
		t.Errorf("%s: severity %q", f.ID, f.Severity)
	}
}

// Two runs: no trend-style finding, and the scorecard does not judge.
func TestSparseData(t *testing.T) {
	in := quiet()
	for _, k := range []string{"R1", "X2/verify", "S1", "S2", "X1", "K1"} {
		in.Cur[k] = row(k, 2, 2, 1)
		in.PrevRows[k] = row(k, 0, 2, 1)
	}
	in.Exec, in.PrevExec = ExecFacts{Total: 2, Interrupted: 2}, ExecFacts{Total: 2}
	in.Score["Q2"] = scoreRow("Q2", 0, 2, 0.85, false)
	in.Score["R5"] = scoreRow("R5", 2, 2, 0.05, true)
	r := Evaluate(in)
	for _, f := range r.Findings {
		switch f.Rule {
		case RuleTrendRejections, RuleTrendVerification, RuleExecLater, RuleCostLater, RuleExecShare, RuleFirstPass, RuleEscalation:
			t.Errorf("finding on two runs: %s", f.ID)
		}
	}
}

func TestNoComparisonWindow(t *testing.T) {
	in := quiet()
	in.Prev, in.PrevWhy = nil, "no window"
	in.Cur["R1"] = row("R1", 20, 20, 1)
	r := Evaluate(in)
	if rulesFired(r)[RuleTrendRejections] != 0 || len(notEvaluated(r, RuleTrendRejections)) != 1 {
		t.Fatalf("trend without a comparison window: %v", r.NotEvaluated)
	}
}

// A two-window rule whose earlier window starts before the recorded history does not run.
func TestEarlierWindowBeforeHistory(t *testing.T) {
	for _, h := range []*int64{i64(987 * 86_400_000), nil} {
		in := quiet()
		in.HistoryFromMS = h
		in.Cur["R1"] = row("R1", 10, 20, 1)
		in.Exec.Interrupted = 5
		in.Cur["K1"] = row("K1", 50, 20, 1)
		r := Evaluate(in)
		for _, id := range []string{RuleTrendRejections, RuleExecLater, RuleCostLater} {
			if rulesFired(r)[id] != 0 || len(notEvaluated(r, id)) != 1 {
				t.Errorf("history %v: %s ran: %v", h, id, notEvaluated(r, id))
			}
		}
	}
}

func TestLowCoverageAndSuspect(t *testing.T) {
	in := quiet()
	in.Cur["R1"] = row("R1", 10, 20, 0.5)
	if r := Evaluate(in); rulesFired(r)[RuleTrendRejections] != 0 || len(notEvaluated(r, RuleTrendRejections)) == 0 {
		t.Fatal("trend on low coverage")
	}
	in = quiet()
	in.Cur["R1"] = row("R1", 10, 20, 1)
	in.Cur["R1"] = func(r metrics.Row) metrics.Row { r.Suspect = true; return r }(in.Cur["R1"])
	if r := Evaluate(in); rulesFired(r)[RuleTrendRejections] != 0 {
		t.Fatal("trend on a suspect window")
	}
	in = quiet()
	in.Cur["K1"] = row("K1", 100, 20, 0.5)
	if r := Evaluate(in); rulesFired(r)[RuleCostLater] != 0 || len(notEvaluated(r, RuleCostLater)) == 0 {
		t.Fatal("cost compared with too little coverage")
	}
}

func TestUnavailableMetricIsNotEvaluated(t *testing.T) {
	in := quiet()
	k := in.Cur["K1"]
	k.Status, k.StatusReason = "unavailable", "this metric is not recorded by station, so the station filter cannot be honoured"
	in.Cur["K1"] = k
	r := Evaluate(in)
	if got := notEvaluated(r, RuleUsageMissing); len(got) != 1 || !strings.Contains(got[0], "station filter") {
		t.Fatalf("not evaluated: %v", got)
	}
}

func TestStationFilterAndLastRuns(t *testing.T) {
	in := quiet()
	in.Filters = map[string]string{"station": "review"}
	in.Flow.Stations = []project.StationFlow{station("review", 30, 100, 30)}
	if r := Evaluate(in); rulesFired(r)[RuleStationShare] != 0 || len(notEvaluated(r, RuleStationShare)) != 1 {
		t.Fatal("a station filter makes the share meaningless")
	}
	in = quiet()
	in.LastRuns = 20
	in.Score["Q2"] = scoreRow("Q2", 1, 10, 0.85, false)
	r := Evaluate(in)
	if rulesFired(r)[RuleFirstPass] != 1 || len(r.Findings) != 1 {
		t.Fatalf("last_runs: only the scorecard rules run: %v", rulesFired(r))
	}
	if *r.Findings[0].Window.LastRuns != 20 {
		t.Fatal("last_runs not stated")
	}
	for _, d := range Rules {
		if !isScorecard(d.ID) && len(notEvaluated(r, d.ID)) == 0 {
			t.Errorf("%s silent under last_runs", d.ID)
		}
	}
}

func TestContributorLinkCarriesWindowAndFilters(t *testing.T) {
	in := quiet()
	in.Filters = map[string]string{"risk": "High", "station": "review"}
	in.Score["R5"] = scoreRow("R5", 5, 10, 0.05, true)
	in.Flow.Waits[0] = wait("capacity", 10, 3_600_000, WaitP90MinMS)
	r := Evaluate(in)
	for _, f := range r.Findings {
		p := f.Contributors.Path
		if !strings.Contains(p, "risk=High") || !strings.Contains(p, "from_ms=86400000000") || !strings.Contains(p, "to_ms=87609600000") {
			t.Errorf("%s: %s", f.ID, p)
		}
		if f.Contributors.Metric == "R5" && !strings.Contains(f.Contributors.Note, "station") {
			t.Errorf("R5 cannot be filtered by station and must say so: %+v", f.Contributors)
		}
		if f.Contributors.Metric == "waits" && f.Contributors.Group["station"] != "review" {
			t.Errorf("waits link should carry the station: %+v", f.Contributors)
		}
		if !reflect.DeepEqual(f.Filters, in.Filters) {
			t.Errorf("%s: filters %v", f.ID, f.Filters)
		}
	}
}

func TestScorecardLinkUsesItsPopulation(t *testing.T) {
	in := quiet()
	in.Window, in.Prev, in.ScoreLastRuns, in.AsOfMS = Span{ToMS: i64(5 * 86_400_000)}, nil, 20, i64(5*86_400_000+1)
	in.Score["Q2"] = scoreRow("Q2", 1, 10, 0.85, false)
	r := Evaluate(in)
	for _, f := range r.Findings {
		if f.Rule == RuleFirstPass {
			p := f.Contributors.Path
			if !strings.Contains(p, "last_runs=20") || strings.Contains(p, "to_ms") || !strings.Contains(p, "as_of_ms=432000001") ||
				f.Contributors.Metric != "Q2" || f.Contributors.Group["first_pass"] != "false" {
				t.Fatalf("Q2 link %+v", f.Contributors)
			}
			return
		}
	}
	t.Fatal("no first-pass finding")
}

func TestDeterministic(t *testing.T) {
	in := quiet()
	in.Flow.Stations[2] = station("review", 10, 60, 10)
	in.Cur["S2"] = row("S2", 5, 20, 1)
	in.Score["Q2"] = scoreRow("Q2", 1, 10, 0.85, false)
	in.FailureKinds.Groups = []RecurringGroup{{"a", 5, 5}, {"b", 5, 6}, {"c", 4, 4}}
	a, _ := json.Marshal(Evaluate(in))
	for i := 0; i < 20; i++ {
		b, _ := json.Marshal(Evaluate(in))
		if !bytes.Equal(a, b) {
			t.Fatal("same input, different output")
		}
	}
	r := Evaluate(in)
	if r.Findings[0].Severity != Attention {
		t.Fatal("attention first")
	}
}

// The wording never claims a cause and never suggests weakening a gate.
var forbidden = []string{
	"cause", "due to", "leads to", "lead to", "led to", "result in", "results in", "resulted in", "drive", "driven by", "explain", "responsible for",
	"because of", "therefore", "proves", "shows that", "trend", "increasing", "decreasing", "worsening", "improving",
	"skip", "bypass", "disable", "relax", "waive", "turn off", "switch off", "reduce review", "fewer review", "lower the threshold",
	"lower threshold", "raise the limit", "raise the threshold", "remove the gate", "remove a gate", "auto-approve", "without approval",
	"without review", "without verification", "loosen", "fix ", "should",
}

func TestTemplatesWording(t *testing.T) {
	texts := map[string]string{"notice": Notice, "label": InvestigationLabel}
	for id, tp := range Templates {
		texts[id+".title"], texts[id+".condition"], texts[id+".why"], texts[id+".investigation"] = tp.Title, tp.Condition, tp.Why, tp.Investigation
		if tp.Title == "" || tp.Condition == "" || tp.Why == "" || tp.Investigation == "" {
			t.Errorf("%s: an empty template", id)
		}
	}
	for _, s := range []string{reasonNoFlow, reasonFewVisits, reasonFewStations, reasonStationFilter, reasonFewSubject, reasonNoWaits, reasonFewDen,
		reasonNoValue, reasonNoCompare, reasonPrevFew, reasonCoverage, reasonSuspect, reasonFewAnalyzed, reasonLastRuns, reasonNoLimit, reasonHistoryUnknown, reasonBeforeHistory,
		reasonNoCapWaits, reasonFilter} {
		texts["reason:"+s] = s
	}
	for _, m := range execMeasures {
		texts["measure:"+m] = m
	}
	for _, d := range Rules {
		texts["rule:"+d.ID] = d.Condition
		if _, ok := Templates[d.ID]; !ok {
			t.Errorf("%s has no template", d.ID)
		}
	}
	for name, s := range texts {
		low := strings.ToLower(s)
		for _, w := range forbidden {
			// "two windows are two observations, not a trend" is the one permitted use: a denial.
			if w == "trend" && strings.Contains(low, "not a trend") {
				continue
			}
			if strings.Contains(low, w) {
				t.Errorf("%s contains %q: %q", name, w, s)
			}
		}
	}
}
