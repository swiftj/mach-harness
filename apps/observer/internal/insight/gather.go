package insight

import (
	"math"
	"strconv"
	"sync"
	"time"

	"mach/observer/internal/metrics"
	"mach/observer/internal/project"
)

// Params are the request's window and filters, already checked by the route.
type Params struct {
	// FromMS and ToMS are the effective window (whole UTC days; nil: open side).
	FromMS, ToMS *int64
	LastRuns     int
	Filters      map[string]string
	// AsOfMS: the as_of_ms asked; last_runs then selects from the runs recorded by it.
	AsOfMS *int64
}

// queryMu serialises metric reads on a private state that concurrent requests may share (a
// state rebuilt at a cursor is cached by the flow index): the table caches parsed cell keys on read.
var queryMu sync.Mutex

// GatherMetrics reads the metric rows the rules need from mst, a state holding metric cells (the
// live head under the projector's lock, or a private state rebuilt at a cursor; a timeline's state
// carries no metric cells). It computes no metric of its own: rows come from metrics.Table.Query.
func GatherMetrics(mst *project.State, p Params) Input {
	in := Input{Window: Span{FromMS: p.FromMS, ToMS: p.ToMS}, LastRuns: p.LastRuns, Filters: copyMap(p.Filters), AsOfMS: p.AsOfMS}

	// The comparison window: the same length, just before.
	switch {
	case p.LastRuns > 0:
		in.PrevWhy = "last_runs selects run records, not a time window"
	case p.FromMS == nil || p.ToMS == nil:
		in.PrevWhy = "ask a bounded window (from_ms and to_ms) to compare it with the window of the same length just before it"
	default:
		l := *p.ToMS - *p.FromMS
		from, to := *p.FromMS-l, *p.FromMS
		in.Prev = &Span{FromMS: &from, ToMS: &to}
	}

	queryMu.Lock()
	defer queryMu.Unlock()
	tbl := mst.Metrics
	if tbl == nil {
		tbl = metrics.NewTable()
	}
	if p.LastRuns == 0 {
		in.Cur = rowsFor(tbl, in.Window, p.Filters)
		if in.Prev != nil {
			in.PrevRows = rowsFor(tbl, *in.Prev, p.Filters)
		}
	}

	// The scorecard population: last_runs when asked, the window when one was asked, else the
	// observe station's default (the last 20 finished runs).
	sq := metrics.Query{IDs: []string{"Q2", "Q3", "R5"}, Filters: nonEmpty(p.Filters)}
	switch {
	case p.LastRuns > 0 || p.FromMS == nil && p.ToMS == nil:
		n := p.LastRuns
		if n == 0 {
			n = ObserveHistoryDepth
		}
		runsOf := mst
		if p.AsOfMS != nil {
			runsOf = project.CutAt(mst, *p.AsOfMS)
		}
		sq.Runs, sq.RunsSelected = project.LastRunsTable(runsOf, n)
		sq.LastRuns = n
		in.ScoreLastRuns = n
		in.ScorePopulation = "the last " + strconv.Itoa(n) + " finished runs by closed_at (" + strconv.Itoa(sq.RunsSelected) + " held)"
		if p.LastRuns == 0 {
			in.ScorePopulation += ", the observe station's default population"
		}
		in.Score = byID(sq.Runs.Query(sq))
	default:
		sq.Windowed, sq.FromDay, sq.ToDay = true, dayStr(p.FromMS, false), dayStr(p.ToMS, true)
		in.ScorePopulation = "finished runs closed in the selected window (the observe station reads the last 20 instead)"
		in.Score = byID(tbl.Query(sq))
	}
	return in
}

// GatherFlow adds, from the flow index, the station, wait and coverage figures and the ticket and
// execution counts of the engine's contributor lists. The index must be at the same position as
// the state GatherMetrics read.
func GatherFlow(ix *project.FlowIndex, in *Input, p Params) {
	st := ix.State()
	if p.LastRuns > 0 {
		return
	}
	// Flow figures.
	for _, k := range []string{"model", "outcome", "provenance"} {
		if p.Filters[k] != "" {
			in.FlowReason = fill(reasonFilter, map[string]string{"filter": k})
		}
	}
	if in.FlowReason == "" {
		q := project.FlowQuery{Risk: p.Filters["risk"], AppType: p.Filters["app_type"], Wave: p.Filters["wave"], Station: p.Filters["station"]}
		q.Window, q.From, q.To = windowMS(in.Window)
		rep := ix.Flow(q)
		in.Flow = &rep
	}

	cq := func(w Span, group map[string]string) project.ContributorQuery {
		q := project.ContributorQuery{Risk: p.Filters["risk"], AppType: p.Filters["app_type"], Wave: p.Filters["wave"], Group: group, Order: "recent", Limit: math.MaxInt32}
		q.Window, q.From, q.To = windowMS(w)
		return q
	}
	// Filters a contributor list cannot apply make the facts read from it not computable.
	contribReason := func(figure string) string {
		dims := map[string]bool{}
		for _, d := range project.ContributorFigures[figure].Dimensions {
			dims[d] = true
		}
		for _, k := range []string{"station", "model", "outcome", "provenance"} {
			if p.Filters[k] != "" && !(dims[k] && (k == "station" || k == "model")) {
				return fill(reasonFilter, map[string]string{"filter": k})
			}
		}
		return ""
	}
	group := func(figure string) map[string]string {
		g := map[string]string{}
		for _, k := range []string{"station", "model"} {
			if p.Filters[k] != "" {
				g[k] = p.Filters[k]
			}
		}
		return g
	}

	// Recurring categories (observe.py's pattern rule over distinct tickets).
	in.FailureKinds = recurringOf(ix, "Q4", "target_kind", contribReason("Q4"), cq(in.Window, group("Q4")))
	in.GateRefusals = recurringOf(ix, "X2", "gate", contribReason("X2"), cq(in.Window, group("X2")))
	in.BlockerRules = recurringOf(ix, "R2", "rule", contribReason("R2"), cq(in.Window, group("R2")))
	// A blocker with no rule, or a rule in prose, is not one category (observe groups prose by its
	// text, which the observer does not serve).
	kept := []RecurringGroup{}
	for _, g := range in.BlockerRules.Groups {
		if g.Key != "none" && g.Key != "not-a-code" {
			kept = append(kept, g)
		}
	}
	if in.BlockerRules.Groups != nil {
		in.BlockerRules.Groups = kept
	}
	switch {
	case in.Flow == nil:
		in.FailureKinds.Reason = joinText(in.FailureKinds.Reason, in.FlowReason)
		in.GateRefusals.Reason = joinText(in.GateRefusals.Reason, in.FlowReason)
		in.BlockerRules.Reason = joinText(in.BlockerRules.Reason, in.FlowReason)
	default:
		for _, s := range in.Flow.Stations {
			switch s.Station {
			case "verify":
				in.FailureKinds.Analyzed = s.Tickets
			case "review":
				in.BlockerRules.Analyzed = s.Tickets
			}
		}
		in.FailureKinds.Population = "unique tickets that visited verification in the selection"
		in.BlockerRules.Population = "unique tickets that visited review in the selection"
		in.GateRefusals.Analyzed = in.Flow.Coverage.TicketsWithLifecycle
		in.GateRefusals.Population = "tickets with a lifecycle log in the selection (by the day of their first recorded fact)"
	}

	// Executions by end state.
	in.Exec = execOf(ix, contribReason("executions"), cq(in.Window, nil))
	if in.Prev != nil {
		in.PrevExec = execOf(ix, contribReason("executions"), cq(*in.Prev, nil))
	}

	// Executions without a usage record from the stream.
	if r := contribReason("usage-missing"); r != "" {
		in.StreamUsage.Reason = r
	} else {
		in.StreamUsage.Executions = in.Exec.Total
		in.StreamUsage.Missing = int64(ix.Contributors("usage-missing", cq(in.Window, nil)).Total)
	}

	// Capacity waits the scheduler recorded.
	in.Capacity = capacityOf(ix, st, contribReason("waits"), cq, in.Window, group("waits"))
}

// rowsFor reads the metric rows the rules use, over one window.
func rowsFor(t *metrics.Table, w Span, filters map[string]string) map[string]metrics.Row {
	base := metrics.Query{Filters: nonEmpty(filters)}
	if w.FromMS != nil || w.ToMS != nil {
		base.Windowed, base.FromDay, base.ToDay = true, dayStr(w.FromMS, false), dayStr(w.ToMS, true)
	}
	out := map[string]metrics.Row{}
	q := base
	q.IDs = []string{"C3", "R1", "S1", "S2", "X1", "K1", "T2"}
	for k, r := range byID(t.Query(q)) {
		out[k] = r
	}
	q = base
	q.IDs, q.GroupBy = []string{"C1"}, []string{"round"}
	for _, r := range t.Query(q) {
		out["C1/round"] = r
	}
	q = base
	q.IDs = []string{"X2"}
	q.Filters = map[string]string{"gate": "verify.verdict"}
	for k, v := range filters {
		q.Filters[k] = v
	}
	for _, r := range t.Query(q) {
		out["X2/verify"] = r
	}
	return out
}

func recurringOf(ix *project.FlowIndex, figure, dim, reason string, q project.ContributorQuery) Recurring {
	if reason != "" {
		return Recurring{Reason: reason}
	}
	page := ix.Contributors(figure, q)
	tickets := map[string]map[string]bool{}
	counts := map[string]int64{}
	for _, c := range page.Items {
		k := c.Group[dim]
		if k == "" || c.Ticket == nil {
			continue
		}
		if tickets[k] == nil {
			tickets[k] = map[string]bool{}
		}
		tickets[k][*c.Ticket] = true
		counts[k]++
	}
	r := Recurring{Groups: []RecurringGroup{}}
	for _, k := range sortedKeys(tickets) {
		r.Groups = append(r.Groups, RecurringGroup{Key: k, Tickets: int64(len(tickets[k])), Count: counts[k]})
	}
	return r
}

// interruptedStates are execution end states that ended the work before it finished.
var interruptedStates = map[string]bool{"interrupted": true, "timed-out": true, "could-not-start": true}

func execOf(ix *project.FlowIndex, reason string, q project.ContributorQuery) ExecFacts {
	if reason != "" {
		return ExecFacts{Reason: reason}
	}
	page := ix.Contributors("executions", q)
	x := ExecFacts{Total: int64(page.Total)}
	for _, c := range page.Items {
		if interruptedStates[c.Group["state"]] {
			x.Interrupted++
		}
	}
	return x
}

func capacityOf(ix *project.FlowIndex, st *project.State, reason string, cq func(Span, map[string]string) project.ContributorQuery, w Span, group map[string]string) CapacityFacts {
	if reason != "" {
		return CapacityFacts{Reason: reason}
	}
	c := CapacityFacts{}
	for _, l := range project.Limits(st) {
		if l.Name == "max_parallel" {
			v := l.Value
			c.Limit = &v // the latest: Limits is oldest first
		}
	}
	days, items := map[int64]bool{}, map[string]bool{}
	best := int64(-1)
	for _, kind := range []string{project.WaitCapacity, project.WaitCapacitySlice} {
		g := map[string]string{"kind": kind}
		for k, v := range group {
			g[k] = v
		}
		page := ix.Contributors("waits", cq(w, g))
		for _, it := range page.Items {
			days[floorDay(it.AtMS)] = true
			items[it.Ref] = true
		}
		c.Waits += int64(page.Total)
		if int64(page.Total) > best {
			best, c.Kind = int64(page.Total), kind
		}
	}
	c.Days, c.Items = int64(len(days)), int64(len(items))
	return c
}

func floorDay(ms int64) int64 {
	const day = int64(86_400_000)
	d := ms % day
	if d < 0 {
		d += day
	}
	return ms - d
}

// dayStr is the first (or, for an exclusive end, the last) UTC day of a window side; "" when open.
func dayStr(ms *int64, end bool) string {
	if ms == nil {
		return ""
	}
	v := *ms
	if end {
		v--
	}
	return time.UnixMilli(v).UTC().Format("2006-01-02")
}

func windowMS(w Span) (bool, int64, int64) {
	if w.FromMS == nil && w.ToMS == nil {
		return false, 0, 0
	}
	from, to := int64(0), int64(1)<<62
	if w.FromMS != nil {
		from = *w.FromMS
	}
	if w.ToMS != nil {
		to = *w.ToMS
	}
	return true, from, to
}

func byID(rows []metrics.Row) map[string]metrics.Row {
	out := map[string]metrics.Row{}
	for _, r := range rows {
		out[r.ID] = r
	}
	return out
}

func nonEmpty(m map[string]string) map[string]string {
	if len(m) == 0 {
		return nil
	}
	return copyMap(m)
}
