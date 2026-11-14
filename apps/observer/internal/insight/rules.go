package insight

import (
	"math"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"mach/observer/internal/metrics"
	"mach/observer/internal/project"
)

// Evaluate runs every rule over in. Pure: the same input gives the same report, in the same order.
func Evaluate(in Input) Report {
	e := &eval{in: in, out: Report{Findings: []Finding{}, NotEvaluated: []NotEvaluated{}}}
	for _, r := range Rules {
		switch {
		case in.LastRuns > 0 && !isScorecard(r.ID):
			e.ne(r.ID, "", reasonLastRuns)
			continue
		}
		ruleFuncs[r.ID](e)
	}
	order := map[string]int{}
	for i, r := range Rules {
		order[r.ID] = i
	}
	sort.SliceStable(e.out.Findings, func(i, j int) bool {
		a, b := e.out.Findings[i], e.out.Findings[j]
		if (a.Severity == Attention) != (b.Severity == Attention) {
			return a.Severity == Attention
		}
		if order[a.Rule] != order[b.Rule] {
			return order[a.Rule] < order[b.Rule]
		}
		return a.ID < b.ID
	})
	return e.out
}

func isScorecard(id string) bool {
	return id == RuleFirstPass || id == RuleRounds || id == RuleEscalation
}

var ruleFuncs = map[string]func(*eval){
	RuleStationShare:      stationShare,
	RuleWaitP90:           waitP90,
	RuleWaitShare:         waitShare,
	RuleRemediationShare:  remediationShare,
	RuleFirstPass:         func(e *eval) { scorecard(e, RuleFirstPass, "Q2") },
	RuleRounds:            func(e *eval) { scorecard(e, RuleRounds, "Q3") },
	RuleEscalation:        func(e *eval) { scorecard(e, RuleEscalation, "R5") },
	RuleTrendRejections:   func(e *eval) { trend(e, RuleTrendRejections, "R1", "decided rounds") },
	RuleTrendVerification: func(e *eval) { trend(e, RuleTrendVerification, "X2/verify", "verification verdicts") },
	RuleRecurringFailure:  recurringFailure,
	RuleRecurringGate:     recurringGate,
	RuleRecurringBlocker:  recurringBlocker,
	RuleCapacityHeld:      capacityHeld,
	RuleExecShare:         execShare,
	RuleExecLater:         execLater,
	RuleCostLater:         costLater,
	RuleUsageMissing:      usageMissing,
	RuleLifecycleCoverage: lifecycleCoverage,
}

type eval struct {
	in  Input
	out Report
}

func (e *eval) ne(rule, subject, reason string) {
	n := NotEvaluated{Rule: rule, Reason: reason}
	if subject != "" {
		n.Subject = &subject
	}
	e.out.NotEvaluated = append(e.out.NotEvaluated, n)
}

// add builds a finding from the rule's templates and vars.
func (e *eval) add(rule, subject, severity, threshold string, vars map[string]string, ms []Measurement, sample Sample, link Contributors, compare bool) {
	t := Templates[rule]
	vars["threshold"] = threshold
	f := Finding{ID: rule, Rule: rule, Severity: severity, Title: fill(t.Title, vars), Condition: fill(t.Condition, vars), Threshold: threshold,
		Measurements: ms, Sample: sample, Filters: copyMap(e.in.Filters), Why: fill(t.Why, vars),
		Investigation: Investigation{Label: InvestigationLabel, Text: fill(t.Investigation, vars)}, Contributors: link,
		Window: FindingWindow{FromMS: e.in.Window.FromMS, ToMS: e.in.Window.ToMS}}
	if subject != "" {
		f.ID += ":" + subject
		f.Subject = &subject
	}
	if e.in.LastRuns > 0 {
		n := e.in.LastRuns
		f.Window.LastRuns = &n
	}
	if compare && e.in.Prev != nil {
		p := *e.in.Prev
		f.Window.Comparison = &p
	}
	e.out.Findings = append(e.out.Findings, f)
}

// ---- the rules ----

func stationShare(e *eval) {
	const id = RuleStationShare
	fl := e.in.Flow
	if fl == nil {
		e.ne(id, "", fill(reasonNoFlow, map[string]string{"why": e.in.FlowReason}))
		return
	}
	if e.in.Filters["station"] != "" {
		e.ne(id, "", reasonStationFilter)
		return
	}
	var total, measured int64
	stations := 0
	for _, s := range fl.Stations {
		if m := s.Duration.Measured; m != nil {
			total += m.TotalMS
			measured += m.Count
			stations++
		}
	}
	if measured < StationMinVisits {
		e.ne(id, "", fill(reasonFewVisits, map[string]string{"min": itoa(StationMinVisits), "n": itoa(measured)}))
		return
	}
	if stations < 2 || total <= 0 {
		e.ne(id, "", fill(reasonFewStations, map[string]string{"n": itoa(int64(stations))}))
		return
	}
	for _, s := range fl.Stations {
		m := s.Duration.Measured
		if m == nil {
			continue
		}
		share := float64(m.TotalMS) / float64(total)
		if share < StationShareMin {
			continue
		}
		if m.Count < StationMinOwnVisits {
			e.ne(id, s.Station, fill(reasonFewSubject, map[string]string{"min": itoa(StationMinOwnVisits), "what": "visits at the station", "n": itoa(m.Count)}))
			continue
		}
		vars := map[string]string{"station": s.Station, "share": pct(share), "station_time": dur(float64(m.TotalMS)), "total_time": dur(float64(total)),
			"visits": itoa(s.Visits), "measured": itoa(m.Count), "median": dur(float64(m.MedianMS)), "p90": dur(float64(m.P90MS))}
		cov := ratioCov(float64(m.Count), float64(s.Visits))
		ms := []Measurement{
			{Metric: "C1", Label: "measured visit time at the station", Value: f(float64(m.TotalMS)), Unit: "ms", SampleCount: f(float64(m.Count)), Coverage: cov, Window: "selection"},
			{Metric: "C1", Label: "share of measured station time", Value: f(share), Unit: "ratio", Numerator: f(float64(m.TotalMS)), Denominator: f(float64(total)), SampleCount: f(float64(measured)), Window: "selection"},
			{Metric: "C1", Label: "visits at the station (every basis)", Value: f(float64(s.Visits)), Unit: "visits", Window: "selection"},
			{Metric: "C1", Label: "unique tickets at the station", Value: f(float64(s.Tickets)), Unit: "tickets", Window: "selection"},
			{Metric: "C1", Label: "median measured visit", Value: f(float64(m.MedianMS)), Unit: "ms", SampleCount: f(float64(m.Count)), Window: "selection"},
			{Metric: "C1", Label: "90th percentile measured visit", Value: f(float64(m.P90MS)), Unit: "ms", SampleCount: f(float64(m.Count)), Window: "selection"},
		}
		e.add(id, s.Station, Note, "share >= "+pct(StationShareMin), vars, ms, Sample{Count: float64(m.Count), Unit: "measured visits", CoverageShare: cov.Share,
			Population: "visits at " + s.Station + " in the selection; not-measured visits counted apart"},
			e.link("C1", map[string]string{"station": s.Station}, "impact", "exact", "", e.in.Window), false)
	}
}

func waitP90(e *eval) {
	const id = RuleWaitP90
	fl := e.in.Flow
	if fl == nil {
		e.ne(id, "", fill(reasonNoFlow, map[string]string{"why": e.in.FlowReason}))
		return
	}
	if len(fl.Waits) == 0 {
		e.ne(id, "", reasonNoWaits)
		return
	}
	for _, w := range fl.Waits {
		m := w.Duration.Measured
		n := int64(0)
		if m != nil {
			n = m.Count
		}
		if n < WaitMinMeasured {
			e.ne(id, w.Kind, fill(reasonFewSubject, map[string]string{"min": itoa(WaitMinMeasured), "what": "waits of this kind", "n": itoa(n)}))
			continue
		}
		if m.P90MS < WaitP90MinMS {
			continue
		}
		vars := map[string]string{"wait": waitLabels[w.Kind], "p90": dur(float64(m.P90MS)), "median": dur(float64(m.MedianMS)), "measured": itoa(m.Count), "waits": itoa(w.Count)}
		cov := ratioCov(float64(m.Count), float64(w.Count))
		ms := []Measurement{
			{Metric: waitMetric(w.Kind), Label: "90th percentile of measured waits", Value: f(float64(m.P90MS)), Unit: "ms", SampleCount: f(float64(m.Count)), Coverage: cov, Window: "selection"},
			{Metric: waitMetric(w.Kind), Label: "median of measured waits", Value: f(float64(m.MedianMS)), Unit: "ms", SampleCount: f(float64(m.Count)), Window: "selection"},
			{Metric: waitMetric(w.Kind), Label: "waits recorded (every basis)", Value: f(float64(w.Count)), Unit: "waits", Window: "selection"},
			{Metric: waitMetric(w.Kind), Label: "unique tickets that waited", Value: f(float64(w.Tickets)), Unit: "tickets", Window: "selection"},
		}
		e.add(id, w.Kind, Note, "p90 >= "+dur(WaitP90MinMS), vars, ms, Sample{Count: float64(m.Count), Unit: "measured waits", CoverageShare: cov.Share, Population: "waits of this kind in the selection"},
			e.link("waits", map[string]string{"kind": w.Kind}, "impact", "exact", "", e.in.Window), false)
	}
}

// waitInside are the wait kinds that fall between dispatch and merge.
var waitInside = map[string]bool{project.WaitCapacity: true, project.WaitHuman: true, project.WaitPerson: true}

func waitShare(e *eval) {
	const id = RuleWaitShare
	fl := e.in.Flow
	if fl == nil {
		e.ne(id, "", fill(reasonNoFlow, map[string]string{"why": e.in.FlowReason}))
		return
	}
	c3, ok, why := usable(e.in.Cur, "C3")
	if !ok {
		e.ne(id, "", why)
		return
	}
	n3 := float64(0)
	if c3.BasisCounts != nil {
		n3 = float64(c3.BasisCounts.Measured)
	}
	if n3 < C3MinMeasured || c3.Numerator == nil || *c3.Numerator <= 0 {
		e.ne(id, "", fill(reasonFewSubject, map[string]string{"min": itoa(C3MinMeasured), "what": "dispatch-to-merge times (C3)", "n": num(n3)}))
		return
	}
	found := false
	for _, w := range fl.Waits {
		if !waitInside[w.Kind] {
			continue
		}
		found = true
		m := w.Duration.Measured
		n := int64(0)
		if m != nil {
			n = m.Count
		}
		if n < WaitMinMeasured {
			e.ne(id, w.Kind, fill(reasonFewSubject, map[string]string{"min": itoa(WaitMinMeasured), "what": "waits of this kind", "n": itoa(n)}))
			continue
		}
		share := float64(m.TotalMS) / *c3.Numerator
		if share < WaitShareMin {
			continue
		}
		vars := map[string]string{"wait": waitLabels[w.Kind], "wait_time": dur(float64(m.TotalMS)), "measured": itoa(m.Count), "c3_time": dur(*c3.Numerator),
			"c3_count": num(n3), "share": pct(share)}
		ms := []Measurement{
			{Metric: waitMetric(w.Kind), Label: "total measured wait time", Value: f(float64(m.TotalMS)), Unit: "ms", SampleCount: f(float64(m.Count)), Coverage: ratioCov(float64(m.Count), float64(w.Count)), Window: "selection"},
			rowMeasure("C3", "total measured dispatch-to-merge time", c3, "selection", c3.Numerator, "ms"),
			{Metric: waitMetric(w.Kind) + "/C3", Label: "wait total over dispatch-to-merge total", Value: f(share), Unit: "ratio", Numerator: f(float64(m.TotalMS)), Denominator: c3.Numerator, Window: "selection"},
		}
		e.add(id, w.Kind, Note, "share >= "+pct(WaitShareMin), vars, ms, Sample{Count: float64(m.Count), Unit: "measured waits", CoverageShare: ratioCov(float64(m.Count), float64(w.Count)).Share,
			Population: "waits of this kind, and merged product tickets (C3), in the selection"},
			e.link("waits", map[string]string{"kind": w.Kind}, "impact", "exact", "", e.in.Window), false)
	}
	if !found {
		e.ne(id, "", reasonNoWaits)
	}
}

func remediationShare(e *eval) {
	const id = RuleRemediationShare
	row, ok, why := usable(e.in.Cur, "C1/round")
	if !ok {
		e.ne(id, "", why)
		return
	}
	var total, later, nAll, nLater float64
	for _, g := range row.Groups {
		r, err := strconv.Atoi(g.Keys["round"])
		if err != nil || g.Numerator == nil || g.Denominator == nil {
			continue // unknown round: counted apart by the engine
		}
		total += *g.Numerator
		nAll += *g.Denominator
		if r >= 2 {
			later += *g.Numerator
			nLater += *g.Denominator
		}
	}
	if nAll < RemediationMinVisits || nLater < RemediationMinLater || total <= 0 {
		e.ne(id, "", fill(reasonFewSubject, map[string]string{"min": itoa(RemediationMinVisits) + " (" + itoa(RemediationMinLater) + " in round 2 or later)",
			"what": "visits with a recorded round", "n": num(nAll) + " (" + num(nLater) + " in round 2 or later)"}))
		return
	}
	share := later / total
	if share < RemediationShareMin {
		return
	}
	vars := map[string]string{"share": pct(share), "later_time": dur(later), "total_time": dur(total), "later_visits": num(nLater), "visits": num(nAll)}
	cov := covOf(row.Coverage)
	ms := []Measurement{
		{Metric: "C1", Label: "measured visit time in round 2 or later", Value: f(later), Unit: "ms", SampleCount: f(nLater), Window: "selection"},
		{Metric: "C1", Label: "measured visit time with a recorded round", Value: f(total), Unit: "ms", SampleCount: f(nAll), Coverage: cov, Window: "selection"},
		{Metric: "C1", Label: "share in round 2 or later", Value: f(share), Unit: "ratio", Numerator: f(later), Denominator: f(total), Window: "selection"},
	}
	e.add(id, "", Note, "share >= "+pct(RemediationShareMin), vars, ms, Sample{Count: nAll, Unit: "measured visits", CoverageShare: cov.Share, Population: "station visits with a recorded round in the selection"},
		e.link("C1", map[string]string{"round": "2"}, "impact", "related", "lists round-2 visits; later rounds are listed with group=round:3 and so on", e.in.Window), false)
}

func scorecard(e *eval, id, metric string) {
	row, ok, why := usable(e.in.Score, metric)
	if !ok {
		e.ne(id, "", why)
		return
	}
	den := deref(row.Denominator)
	if den < ScorecardMinDen {
		e.ne(id, "", fill(reasonFewDen, map[string]string{"min": itoa(ScorecardMinDen), "what": map[string]string{"Q2": "merged tickets", "Q3": "merged tickets with recorded rounds", "R5": "finished tickets"}[metric], "n": num(den)}))
		return
	}
	if row.Value == nil {
		e.ne(id, "", fill(reasonNoValue, map[string]string{"why": row.NullReason}))
		return
	}
	if row.TargetCheck == nil || row.TargetCheck.Met == nil || *row.TargetCheck.Met {
		return
	}
	v := *row.Value
	vars := map[string]string{"num": num(deref(row.Numerator)), "den": num(den), "target": num(row.TargetCheck.Value), "population": e.in.ScorePopulation, "value": num3(v)}
	if metric != "Q3" {
		vars["value"], vars["target"] = pct(v), pct(row.TargetCheck.Value)
	}
	threshold := map[string]string{"Q2": "target above 85% (observe.py)", "Q3": "target below 1.3 (observe.py)", "R5": "target below 5% (observe.py)"}[metric]
	cov := covOf(row.Coverage)
	link := map[string]Contributors{
		"Q2": e.scoreLink("Q2", map[string]string{"first_pass": "false"}),
		"Q3": e.scoreLink("Q3", nil),
		"R5": e.scoreLink("R5", nil),
	}[metric]
	e.add(id, "", Attention, threshold, vars, []Measurement{rowMeasure(metric, row.Name, row, "selection", row.Value, unitOf(row))},
		Sample{Count: den, Unit: map[string]string{"Q2": "merged tickets", "Q3": "merged tickets", "R5": "finished tickets"}[metric], CoverageShare: cov.Share, Population: e.in.ScorePopulation},
		link, false)
}

// noPrev reports (and records) a two-window rule that has no usable earlier window.
func (e *eval) noPrev(id string) bool {
	switch {
	case e.in.Prev == nil:
		e.ne(id, "", fill(reasonNoCompare, map[string]string{"why": e.in.PrevWhy}))
	case e.in.HistoryFromMS == nil:
		e.ne(id, "", reasonHistoryUnknown)
	case e.in.Prev.FromMS == nil || *e.in.Prev.FromMS < *e.in.HistoryFromMS:
		e.ne(id, "", fill(reasonBeforeHistory, map[string]string{"from": dayText(e.in.Prev.FromMS), "history": dayText(e.in.HistoryFromMS)}))
	default:
		return false
	}
	return true
}

func trend(e *eval, id, key, what string) {
	if e.noPrev(id) {
		return
	}
	cur, ok, why := usable(e.in.Cur, key)
	if !ok {
		e.ne(id, "", why)
		return
	}
	prev, ok, why := usable(e.in.PrevRows, key)
	if !ok {
		e.ne(id, "", why)
		return
	}
	lden, eden := deref(cur.Denominator), deref(prev.Denominator)
	if lden < TrendMinDen || eden < TrendMinDen {
		e.ne(id, "", fill(reasonPrevFew, map[string]string{"min": itoa(TrendMinDen), "what": what, "later": num(lden), "earlier": num(eden)}))
		return
	}
	lc, ec := cur.Coverage.Share, prev.Coverage.Share
	if lc == nil || ec == nil || *lc < TrendMinCoverage || *ec < TrendMinCoverage {
		e.ne(id, "", fill(reasonCoverage, map[string]string{"min": pct(TrendMinCoverage), "later": pctp(lc), "earlier": pctp(ec)}))
		return
	}
	if cur.Suspect || prev.Suspect {
		e.ne(id, "", reasonSuspect)
		return
	}
	if cur.Value == nil || prev.Value == nil || *cur.Value-*prev.Value < TrendMinRise {
		return
	}
	vars := map[string]string{"later": pct(*cur.Value), "earlier": pct(*prev.Value), "later_num": num(deref(cur.Numerator)), "later_den": num(lden),
		"earlier_num": num(deref(prev.Numerator)), "earlier_den": num(eden)}
	metric := strings.Split(key, "/")[0]
	figure, relation := "R1", "exact"
	if metric == "X2" {
		figure = "verification_failures"
	}
	e.add(id, "", Attention, "later - earlier >= "+points(TrendMinRise), vars,
		[]Measurement{rowMeasure(key, cur.Name, cur, "later", cur.Value, "ratio"), rowMeasure(key, prev.Name, prev, "earlier", prev.Value, "ratio")},
		Sample{Count: lden + eden, Unit: what, CoverageShare: lc, Population: what + " in the later and earlier windows"},
		e.link(figure, nil, "recent", relation, "the later window's records; ask the earlier window with its from_ms and to_ms", e.in.Window), true)
}

func recurring(e *eval, id string, r Recurring, figure, dim string, vars func(g RecurringGroup) map[string]string) {
	if r.Reason != "" {
		e.ne(id, "", r.Reason)
		return
	}
	if r.Analyzed < PatternMinAnalyzed {
		e.ne(id, "", fill(reasonFewAnalyzed, map[string]string{"min": itoa(PatternMinAnalyzed), "n": itoa(r.Analyzed)}))
		return
	}
	for _, g := range r.Groups {
		share := float64(g.Tickets) / float64(r.Analyzed)
		if g.Tickets < PatternMinTickets || share < PatternMinShare {
			continue
		}
		v := vars(g)
		v["tickets"], v["count"], v["share"], v["analyzed"], v["min_tickets"], v["min_share"] = itoa(g.Tickets), itoa(g.Count), pct(share), itoa(r.Analyzed),
			itoa(PatternMinTickets), pct(PatternMinShare)
		ms := []Measurement{
			{Metric: figure, Label: "tickets with this category", Value: f(float64(g.Tickets)), Unit: "tickets", Numerator: f(float64(g.Tickets)), Denominator: f(float64(r.Analyzed)), Window: "selection"},
			{Metric: figure, Label: "share of tickets analyzed", Value: f(share), Unit: "ratio", Numerator: f(float64(g.Tickets)), Denominator: f(float64(r.Analyzed)), SampleCount: f(float64(r.Analyzed)), Window: "selection"},
			{Metric: figure, Label: "records with this category", Value: f(float64(g.Count)), Unit: "records", Window: "selection"},
		}
		e.add(id, g.Key, Note, ">= "+itoa(PatternMinTickets)+" tickets and >= "+pct(PatternMinShare)+" of tickets analyzed", v, ms,
			Sample{Count: float64(r.Analyzed), Unit: "tickets analyzed", Population: r.Population},
			e.link(figure, map[string]string{dim: g.Key}, "recent", "exact", "", e.in.Window), false)
	}
}

func recurringFailure(e *eval) {
	recurring(e, RuleRecurringFailure, e.in.FailureKinds, "Q4", "target_kind", func(g RecurringGroup) map[string]string { return map[string]string{"kind": g.Key} })
}

func recurringBlocker(e *eval) {
	recurring(e, RuleRecurringBlocker, e.in.BlockerRules, "R2", "rule", func(g RecurringGroup) map[string]string { return map[string]string{"rule": g.Key} })
}

func recurringGate(e *eval) {
	recurring(e, RuleRecurringGate, e.in.GateRefusals, "X2", "gate", func(g RecurringGroup) map[string]string { return map[string]string{"gate": g.Key} })
}

func capacityHeld(e *eval) {
	const id = RuleCapacityHeld
	c := e.in.Capacity
	switch {
	case c.Reason != "":
		e.ne(id, "", c.Reason)
		return
	case c.Limit == nil:
		e.ne(id, "", reasonNoLimit)
		return
	case c.Waits == 0:
		e.ne(id, "", reasonNoCapWaits)
		return
	}
	if c.Days < CapacityMinDays || c.Waits < CapacityMinWaits {
		return
	}
	vars := map[string]string{"days": itoa(c.Days), "limit": num(*c.Limit), "waits": itoa(c.Waits), "items": itoa(c.Items)}
	ms := []Measurement{
		{Metric: "W2b", Label: "day buckets in which a recorded capacity wait began", Value: f(float64(c.Days)), Unit: "days", Window: "selection"},
		{Metric: "W2b", Label: "capacity waits recorded (tickets and slices)", Value: f(float64(c.Waits)), Unit: "waits", Window: "selection"},
		{Metric: "W2b", Label: "distinct tickets or slices held", Value: f(float64(c.Items)), Unit: "items", Window: "selection"},
		{Metric: "max_parallel", Label: "recorded limit (latest)", Value: c.Limit, Unit: "places", Window: "selection"},
	}
	e.add(id, "", Note, ">= "+itoa(CapacityMinDays)+" day buckets and >= "+itoa(CapacityMinWaits)+" waits", vars, ms,
		Sample{Count: float64(c.Waits), Unit: "capacity waits", Population: "waits for a free place the scheduler recorded in the selection"},
		e.link("waits", map[string]string{"kind": c.Kind}, "recent", "exact", "lists the wait kind with more waits; the other is listed with group=kind:capacity or kind:capacity-slice", e.in.Window), false)
}

var execOrder = []string{"S1", "S2", "X1", "interrupted"}

// execFigure is an execution measure's numerator, denominator and value.
func execFigure(rows map[string]metrics.Row, x ExecFacts, key string) (n, d float64, row *metrics.Row, why string) {
	if key == "interrupted" {
		if x.Reason != "" {
			return 0, 0, nil, x.Reason
		}
		return float64(x.Interrupted), float64(x.Total), nil, ""
	}
	r, ok, why := usable(rows, key)
	if !ok {
		return 0, 0, nil, why
	}
	return deref(r.Numerator), deref(r.Denominator), &r, ""
}

var execPop = map[string]string{"S1": "claimed executions", "S2": "claimed executions", "X1": "claimed executions", "interrupted": "executions started"}
var execLink = map[string][2]string{"S1": {"S1", ""}, "S2": {"S2", ""}, "X1": {"X1", ""}, "interrupted": {"executions", ""}}

func execShare(e *eval) {
	const id = RuleExecShare
	for _, k := range execOrder {
		n, d, row, why := execFigure(e.in.Cur, e.in.Exec, k)
		if why != "" {
			e.ne(id, k, why)
			continue
		}
		if d < ExecMinClaimed {
			e.ne(id, k, fill(reasonFewDen, map[string]string{"min": itoa(ExecMinClaimed), "what": execPop[k], "n": num(d)}))
			continue
		}
		v := n / d
		if v < execShareMin[k] {
			continue
		}
		sev := Note
		if k == "S2" {
			sev = Attention
		}
		vars := map[string]string{"measure": execMeasures[k], "num": num(n), "den": num(d), "population": execPop[k], "value": pct(v)}
		m := Measurement{Metric: k, Label: execMeasures[k], Value: f(v), Unit: "ratio", Numerator: f(n), Denominator: f(d), SampleCount: f(d), Window: "selection"}
		var cs *float64
		if row != nil {
			m = rowMeasure(k, execMeasures[k], *row, "selection", row.Value, "ratio")
			cs = row.Coverage.Share
		}
		link := e.link(execLink[k][0], nil, "recent", "exact", "", e.in.Window)
		if k == "interrupted" {
			link = e.link("executions", nil, "recent", "related", "lists every execution with its state; interrupted, timed-out and could-not-start are the ones counted", e.in.Window)
		}
		e.add(id, k, sev, ">= "+pct(execShareMin[k]), vars, []Measurement{m}, Sample{Count: d, Unit: execPop[k], CoverageShare: cs, Population: execPop[k] + " in the selection"}, link, false)
	}
}

func execLater(e *eval) {
	const id = RuleExecLater
	if e.noPrev(id) {
		return
	}
	for _, k := range execOrder {
		ln, ld, lrow, why := execFigure(e.in.Cur, e.in.Exec, k)
		if why != "" {
			e.ne(id, k, why)
			continue
		}
		en, ed, erow, why := execFigure(e.in.PrevRows, e.in.PrevExec, k)
		if why != "" {
			e.ne(id, k, why)
			continue
		}
		if ld < ExecMinClaimed || ed < ExecMinClaimed {
			e.ne(id, k, fill(reasonPrevFew, map[string]string{"min": itoa(ExecMinClaimed), "what": execPop[k], "later": num(ld), "earlier": num(ed)}))
			continue
		}
		if (lrow != nil && lrow.Suspect) || (erow != nil && erow.Suspect) {
			e.ne(id, k, reasonSuspect)
			continue
		}
		lv, ev := ln/ld, en/ed
		if lv-ev < ExecLaterMinRise {
			continue
		}
		vars := map[string]string{"measure": execMeasures[k], "later": pct(lv), "earlier": pct(ev), "later_num": num(ln), "later_den": num(ld), "earlier_num": num(en), "earlier_den": num(ed)}
		ms := []Measurement{
			{Metric: k, Label: execMeasures[k], Value: f(lv), Unit: "ratio", Numerator: f(ln), Denominator: f(ld), SampleCount: f(ld), Window: "later"},
			{Metric: k, Label: execMeasures[k], Value: f(ev), Unit: "ratio", Numerator: f(en), Denominator: f(ed), SampleCount: f(ed), Window: "earlier"},
		}
		rel, note := "exact", "the later window's records; ask the earlier window with its from_ms and to_ms"
		if k == "interrupted" {
			rel = "related"
		}
		e.add(id, k, Note, "later - earlier >= "+points(ExecLaterMinRise), vars, ms, Sample{Count: ld + ed, Unit: execPop[k], Population: execPop[k] + " in the later and earlier windows"},
			e.link(execLink[k][0], nil, "recent", rel, note, e.in.Window), true)
	}
}

func costLater(e *eval) {
	const id = RuleCostLater
	if e.noPrev(id) {
		return
	}
	var rows [4]metrics.Row
	for i, src := range []struct {
		m   map[string]metrics.Row
		key string
	}{{e.in.Cur, "K1"}, {e.in.PrevRows, "K1"}, {e.in.Cur, "T2"}, {e.in.PrevRows, "T2"}} {
		r, ok, why := usable(src.m, src.key)
		if !ok {
			e.ne(id, "", why)
			return
		}
		rows[i] = r
	}
	lk, ek, lt, et := rows[0], rows[1], rows[2], rows[3]
	ld, ed := deref(lk.Denominator), deref(ek.Denominator)
	if ld < CostMinExecutions || ed < CostMinExecutions {
		e.ne(id, "", fill(reasonPrevFew, map[string]string{"min": itoa(CostMinExecutions), "what": "executions with a recorded cost", "later": num(ld), "earlier": num(ed)}))
		return
	}
	lc, ec := lk.Coverage.Share, ek.Coverage.Share
	if lc == nil || ec == nil || *lc < CostMinCoverage || *ec < CostMinCoverage {
		e.ne(id, "", fill(reasonCoverage, map[string]string{"min": pct(CostMinCoverage), "later": pctp(lc), "earlier": pctp(ec)}))
		return
	}
	if lk.Suspect || ek.Suspect {
		e.ne(id, "", reasonSuspect)
		return
	}
	lcost, ecost := deref(lk.Numerator), deref(ek.Numerator)
	// T2 is a count of recorded integrations: none recorded in a window is a count of none.
	lt2, et2 := deref(lt.Value), deref(et.Value)
	if ecost <= 0 || lcost < CostRatioMin*ecost || lt2 > et2 {
		return
	}
	vars := map[string]string{"later_cost": usd(lcost), "earlier_cost": usd(ecost), "later_den": num(ld), "earlier_den": num(ed), "ratio": pct(lcost / ecost),
		"later_t2": num(lt2), "earlier_t2": num(et2), "later_cov": pct(*lc), "earlier_cov": pct(*ec)}
	ms := []Measurement{
		rowMeasure("K1", "recorded cost (sum)", lk, "later", lk.Numerator, "usd"),
		rowMeasure("K1", "recorded cost (sum)", ek, "earlier", ek.Numerator, "usd"),
		rowMeasure("T2", "integrated slices recorded", lt, "later", f(lt2), "slices"),
		rowMeasure("T2", "integrated slices recorded", et, "earlier", f(et2), "slices"),
	}
	e.add(id, "", Note, "later cost >= "+pct(CostRatioMin)+" of earlier, and integrated slices later <= earlier", vars, ms,
		Sample{Count: ld + ed, Unit: "executions with a recorded cost", CoverageShare: lc, Population: "completed executions in the later and earlier windows"},
		e.link("K1", nil, "impact", "exact", "the later window's records; ask the earlier window with its from_ms and to_ms", e.in.Window), true)
}

func usageMissing(e *eval) {
	const id = RuleUsageMissing
	// Subject cost: completed executions with no cost recorded by the supervisor (K1's coverage,
	// the population every recorded-cost figure stands on).
	if row, ok, why := usable(e.in.Cur, "K1"); !ok {
		e.ne(id, "cost", why)
	} else if el := deref(row.Coverage.Eligible); el < UsageMinEligible {
		e.ne(id, "cost", fill(reasonFewDen, map[string]string{"min": itoa(UsageMinEligible), "what": "completed executions", "n": num(el)}))
	} else if without := el - deref(row.Coverage.Counted); without/el >= UsageMissingMin {
		missing := without / el
		vars := map[string]string{"missing": pct(missing), "without": num(without), "eligible": num(el), "record": "a cost recorded by the supervisor", "population": "completed executions"}
		ms := []Measurement{
			rowMeasure("K1", "completed executions with a recorded cost", row, "selection", row.Coverage.Counted, "executions"),
			{Metric: "K1", Label: "share without a recorded cost", Value: f(missing), Unit: "ratio", Numerator: f(without), Denominator: f(el), Window: "selection"},
		}
		e.add(id, "cost", Note, "missing >= "+pct(UsageMissingMin), vars, ms, Sample{Count: el, Unit: "completed executions", CoverageShare: row.Coverage.Share, Population: "completed executions in the selection"},
			e.link("K1-missing", nil, "recent", "exact", "", e.in.Window), false)
	}
	// Subject stream: executions with no execution.usage record from the stream (the population of
	// K2 and K3, per-model cost and tokens).
	u := e.in.StreamUsage
	switch {
	case u.Reason != "":
		e.ne(id, "stream", u.Reason)
	case u.Executions < UsageMinEligible:
		e.ne(id, "stream", fill(reasonFewDen, map[string]string{"min": itoa(UsageMinEligible), "what": "executions", "n": itoa(u.Executions)}))
	default:
		missing := float64(u.Missing) / float64(u.Executions)
		if missing < StreamUsageMissingMin {
			return
		}
		vars := map[string]string{"missing": pct(missing), "without": itoa(u.Missing), "eligible": itoa(u.Executions), "record": "a usage record from the stream", "population": "executions"}
		ms := []Measurement{{Metric: "usage-missing", Label: "executions without a usage record", Value: f(missing), Unit: "ratio", Numerator: f(float64(u.Missing)),
			Denominator: f(float64(u.Executions)), SampleCount: f(float64(u.Executions)), Window: "selection"}}
		e.add(id, "stream", Note, "missing >= "+pct(StreamUsageMissingMin), vars, ms, Sample{Count: float64(u.Executions), Unit: "executions", Population: "executions started in the selection"},
			e.link("usage-missing", nil, "recent", "exact", "", e.in.Window), false)
	}
}

func lifecycleCoverage(e *eval) {
	const id = RuleLifecycleCoverage
	fl := e.in.Flow
	if fl == nil {
		e.ne(id, "", fill(reasonNoFlow, map[string]string{"why": e.in.FlowReason}))
		return
	}
	c := fl.Coverage
	if c.Tickets < LifecycleMinTickets {
		e.ne(id, "", fill(reasonFewDen, map[string]string{"min": itoa(LifecycleMinTickets), "what": "tickets", "n": itoa(c.Tickets)}))
		return
	}
	share := float64(c.TicketsWithLifecycle) / float64(c.Tickets)
	if share >= LifecycleCoverageMax {
		return
	}
	vars := map[string]string{"share": pct(share), "with": itoa(c.TicketsWithLifecycle), "tickets": itoa(c.Tickets)}
	ms := []Measurement{{Metric: "flow.coverage", Label: "tickets with a lifecycle log", Value: f(share), Unit: "ratio", Numerator: f(float64(c.TicketsWithLifecycle)),
		Denominator: f(float64(c.Tickets)), SampleCount: f(float64(c.Tickets)), Window: "selection"}}
	e.add(id, "", Note, "share with a log < "+pct(LifecycleCoverageMax), vars, ms, Sample{Count: float64(c.Tickets), Unit: "tickets", CoverageShare: f(share), Population: "tickets selected by the day of their first recorded fact"},
		e.link("lifecycle-missing", nil, "recent", "exact", "", e.in.Window), false)
}

// ---- helpers ----

// usable returns a row the rules can read, or why not.
func usable(rows map[string]metrics.Row, key string) (metrics.Row, bool, string) {
	r, ok := rows[key]
	if !ok {
		return r, false, "the figure " + key + " was not read for this selection"
	}
	switch r.Status {
	case "unavailable", "deferred", "not-recorded":
		return r, false, r.ID + ": " + r.StatusReason
	}
	return r, true, ""
}

func (e *eval) link(figure string, group map[string]string, order, relation, note string, w Span) Contributors {
	c := Contributors{Metric: figure, Group: map[string]string{}, Order: order, Limit: DefaultContributorMax, Relation: relation, Note: note}
	for k, v := range group {
		c.Group[k] = v
	}
	dims := map[string]bool{}
	for _, d := range project.ContributorFigures[figure].Dimensions {
		dims[d] = true
	}
	q := url.Values{}
	q.Set("order", order)
	q.Set("limit", strconv.Itoa(c.Limit))
	if w.FromMS != nil {
		q.Set("from_ms", strconv.FormatInt(*w.FromMS, 10))
	}
	if w.ToMS != nil {
		q.Set("to_ms", strconv.FormatInt(*w.ToMS, 10))
	}
	if e.in.AsOfMS != nil {
		q.Set("as_of_ms", strconv.FormatInt(*e.in.AsOfMS, 10))
	}
	var unapplied []string
	for _, k := range sortedKeys(e.in.Filters) {
		v := e.in.Filters[k]
		switch {
		case k == "risk" || k == "app_type" || k == "wave":
			q.Set(k, v)
		case (k == "station" || k == "model") && dims[k]:
			if _, set := c.Group[k]; !set {
				c.Group[k] = v
			}
		default:
			unapplied = append(unapplied, k)
		}
	}
	var parts []string
	for _, k := range sortedKeys(c.Group) {
		parts = append(parts, k+":"+c.Group[k])
	}
	if len(parts) > 0 {
		q.Set("group", strings.Join(parts, ","))
	}
	c.Path = "/api/v1/analytics/contributors?metric=" + url.QueryEscape(figure) + "&" + q.Encode()
	if len(unapplied) > 0 {
		c.Note = joinText(c.Note, "the contributors list cannot apply the "+strings.Join(unapplied, ", ")+" filter")
	}
	return c
}

// scoreLink links a scorecard finding to its run records: the scorecard's population (last_runs
// when it reads the last N runs, else the window).
func (e *eval) scoreLink(figure string, group map[string]string) Contributors {
	if e.in.ScoreLastRuns == 0 {
		return e.link(figure, group, "recent", "exact", "", e.in.Window)
	}
	c := e.link(figure, group, "recent", "exact", "", Span{})
	c.Path += "&last_runs=" + strconv.Itoa(e.in.ScoreLastRuns)
	return c
}

func rowMeasure(metric, label string, r metrics.Row, window string, value *float64, unit string) Measurement {
	return Measurement{Metric: metric, Label: label, Value: value, Unit: unit, Numerator: r.Numerator, Denominator: r.Denominator, SampleCount: r.SampleCount,
		Coverage: covOf(r.Coverage), Window: window}
}

func covOf(c metrics.Coverage) *Coverage {
	return &Coverage{Eligible: c.Eligible, Counted: c.Counted, Share: c.Share}
}

func ratioCov(counted, eligible float64) *Coverage {
	c := &Coverage{Eligible: f(eligible), Counted: f(counted)}
	if eligible > 0 {
		c.Share = f(counted / eligible)
	}
	return c
}

func unitOf(r metrics.Row) string {
	if r.Unit != "" {
		return r.Unit
	}
	return "ratio"
}

func waitMetric(kind string) string {
	switch kind {
	case project.WaitDependency:
		return "W1"
	case project.WaitQueue:
		return "W2"
	case project.WaitCapacity:
		return "W2b"
	case project.WaitHuman:
		return "W3"
	case project.WaitPerson:
		return "S4"
	}
	return "waits"
}

func fill(t string, vars map[string]string) string {
	keys := sortedKeys(vars)
	pairs := make([]string, 0, 2*len(keys))
	for _, k := range keys {
		pairs = append(pairs, "{"+k+"}", vars[k])
	}
	return strings.NewReplacer(pairs...).Replace(t)
}

func f(v float64) *float64 { return &v }

func deref(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func num(v float64) string { return strconv.FormatFloat(math.Round(v*1000)/1000, 'f', -1, 64) }

func num3(v float64) string { return strconv.FormatFloat(v, 'f', 3, 64) }

func pct(v float64) string { return strconv.FormatFloat(v*100, 'f', 1, 64) + "%" }

func pctp(v *float64) string {
	if v == nil {
		return "none"
	}
	return pct(*v)
}

func points(v float64) string { return strconv.FormatFloat(v*100, 'f', 0, 64) + " percentage points" }

func dayText(ms *int64) string {
	if ms == nil {
		return "unknown"
	}
	return time.UnixMilli(*ms).UTC().Format("2006-01-02 15:04 UTC")
}

func usd(v float64) string { return "USD " + strconv.FormatFloat(v, 'f', 2, 64) }

func dur(ms float64) string {
	s := ms / 1000
	switch {
	case s < 60:
		return strconv.FormatFloat(s, 'f', 0, 64) + " s"
	case s < 3600:
		return strconv.FormatFloat(s/60, 'f', 1, 64) + " min"
	case s < 48*3600:
		return strconv.FormatFloat(s/3600, 'f', 1, 64) + " h"
	}
	return strconv.FormatFloat(s/86400, 'f', 1, 64) + " d"
}

func joinText(a, b string) string {
	if a == "" {
		return b
	}
	return a + "; " + b
}

func copyMap(m map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range m {
		out[k] = v
	}
	return out
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
