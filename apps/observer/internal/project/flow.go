package project

import (
	"math"
	"sort"
	"strings"
	"sync"
)

// Flow (M6_5_DESIGN.md section 3.2): stations, the transitions the lifecycle records, the waits
// before each station and the bottleneck ranking, kept as mergeable cells per UTC day.
//
// The index is derived from one projection position (its spans and cells), never stored as truth:
// it is built once per position (with the timeline the observer already builds per position, or
// from a private state rebuilt at a cursor) and a request only merges the day cells of its window
// and filters. Every duration keeps its basis (measured, bounded, inferred, open, unknown); a
// statistic is computed over measured durations only and the others are counted beside it.
//
// Placement: a visit, wait or transition belongs to the UTC day it began (the earliest bound of
// its start); a gate evaluation to the day it was recorded. A visit spanning midnight is counted
// once, on the day it was entered. Filters (risk, app type, wave) are the cell's recorded values at
// the position read; "" is reported as unknown.

// StampMS is the time a stamp is placed at: the recorded time, else the earliest bound, else the
// order time.
func StampMS(st *Stamp) int64 { return stampMS(st) }

const flowDayMS = int64(86_400_000)

func flowDay(ms int64) int64 {
	d := ms % flowDayMS
	if d < 0 {
		d += flowDayMS
	}
	return ms - d
}

// Bases, in the order the counts are kept.
var flowBases = [...]string{"measured", "bounded", "inferred", "open", "unknown"}

func basisIndex(b string) int {
	for i, v := range flowBases {
		if v == b {
			return i
		}
	}
	return 4
}

// Wait kinds: the span kind each comes from.
const (
	WaitDependency    = "dependency"     // slice-wait: dependency.blocked to dependency.resolved
	WaitQueue         = "queue"          // slice-eligible: eligible to work.scheduled
	WaitCapacity      = "capacity"       // capacity-wait of a ticket: capacity.wait_changed waiting to released (execution capacity)
	WaitCapacitySlice = "capacity-slice" // capacity-wait of a ready slice, reconstructed from the scheduler's decisions (bounded)
	WaitHuman         = "human-approval" // gate-wait: a review AWAITING_HUMAN to the approval
	WaitPerson        = "person"         // person-wait: the supervisor parked the ticket for a person
)

// WaitKinds lists the wait kinds in display order.
var WaitKinds = []string{WaitDependency, WaitQueue, WaitCapacity, WaitCapacitySlice, WaitHuman, WaitPerson}

func waitKindOf(sp *Span) string {
	switch sp.Kind {
	case "slice-wait":
		return WaitDependency
	case "slice-eligible":
		return WaitQueue
	case "capacity-wait":
		if strings.HasPrefix(sp.Entity, "slice:") {
			return WaitCapacitySlice
		}
		return WaitCapacity
	case "gate-wait":
		return WaitHuman
	case "person-wait":
		return WaitPerson
	}
	return ""
}

// stationOrder is the belt's order; other stations follow alphabetically.
var stationOrder = map[string]int{"groom": 1, "intent": 2, "plan": 3, "audit": 4, "build": 5, "verify": 6, "review": 7, "human-approval": 8,
	"merge": 9, "cleanup": 10}

func stationLess(a, b string) bool {
	oa, ob := stationOrder[a], stationOrder[b]
	if oa == 0 {
		oa = 100
	}
	if ob == 0 {
		ob = 100
	}
	if oa != ob {
		return oa < ob
	}
	return a < b
}

// Terminal outcomes a transition can end at.
const (
	TerminalMerged    = "merged"
	TerminalAbandoned = "abandoned"
	TerminalBlocked   = "blocked"
)

type flowDims struct {
	day             int64
	risk, app, wave string
}

type stationKey struct {
	flowDims
	station string
}

type waitKey struct {
	flowDims
	kind, next string // next: the station the ticket entered next ("" when none was recorded)
}

type transKey struct {
	flowDims
	from, to string
}

// durAgg is a mergeable duration aggregate: counts by basis, the exact measured durations, the
// bounds of bounded and inferred ones, and the tickets.
type durAgg struct {
	basis       [5]int64
	measured    []int64
	boundMin    int64 // sum of the lower bounds of bounded durations
	boundMax    int64 // sum of the upper bounds of bounded durations that have one
	boundNoMax  int64 // bounded durations with no upper bound
	inferMax    int64 // sum of the upper bounds of inferred durations
	inferNoMax  int64
	tickets     map[string]struct{}
	measuredTix map[string]struct{}
	noTicket    int64
}

func (a *durAgg) add(d Duration, ticket string) {
	i := basisIndex(d.Basis)
	a.basis[i]++
	switch d.Basis {
	case "measured":
		if d.MS != nil {
			a.measured = append(a.measured, *d.MS)
		}
		if ticket != "" {
			if a.measuredTix == nil {
				a.measuredTix = map[string]struct{}{}
			}
			a.measuredTix[ticket] = struct{}{}
		}
	case "bounded":
		if d.MinMS != nil {
			a.boundMin += *d.MinMS
		}
		if d.MaxMS != nil {
			a.boundMax += *d.MaxMS
		} else {
			a.boundNoMax++
		}
	case "inferred":
		if d.MaxMS != nil {
			a.inferMax += *d.MaxMS
		} else {
			a.inferNoMax++
		}
	}
	a.ticket(ticket)
}

func (a *durAgg) ticket(t string) {
	if t == "" {
		a.noTicket++
		return
	}
	if a.tickets == nil {
		a.tickets = map[string]struct{}{}
	}
	a.tickets[t] = struct{}{}
}

func (a *durAgg) merge(o *durAgg) {
	for i := range a.basis {
		a.basis[i] += o.basis[i]
	}
	a.measured = append(a.measured, o.measured...)
	a.boundMin += o.boundMin
	a.boundMax += o.boundMax
	a.boundNoMax += o.boundNoMax
	a.inferMax += o.inferMax
	a.inferNoMax += o.inferNoMax
	a.noTicket += o.noTicket
	for t := range o.tickets {
		if a.tickets == nil {
			a.tickets = map[string]struct{}{}
		}
		a.tickets[t] = struct{}{}
	}
	for t := range o.measuredTix {
		if a.measuredTix == nil {
			a.measuredTix = map[string]struct{}{}
		}
		a.measuredTix[t] = struct{}{}
	}
}

func (a *durAgg) count() int64 {
	var n int64
	for _, v := range a.basis {
		n += v
	}
	return n
}

type stationAgg struct {
	durAgg
	revise                         int64
	gateEval, gateRefused, gateOvr int64
	gateTickets                    map[string]struct{}
}

type transAgg struct {
	count, revise int64
	tickets       map[string]struct{}
}

// FlowIndex is the flow aggregates of one projection position. Built once, read by many requests,
// never changed after it is built (the contributor lists are built on first use, under a lock).
type FlowIndex struct {
	Epoch   string
	Pos     uint64
	Partial string

	stations    map[stationKey]*stationAgg
	waits       map[waitKey]*durAgg
	transitions map[transKey]*transAgg
	cellsSeen   map[flowDims]map[string]bool // ticket -> has a lifecycle, per (day of first fact, dims)

	st    *State
	spans []*Span

	mu      sync.Mutex
	contrib map[string][]Contributor
	asOf    map[int64]*FlowIndex // indexes as of a time (flow_asof.go)
}

// BuildFlow builds the flow index of a state from its spans (allSpans(s) or a timeline's).
func BuildFlow(s *State, spans []*Span) *FlowIndex {
	ix := &FlowIndex{Epoch: s.Epoch, Pos: s.Pos, Partial: s.Partial, stations: map[stationKey]*stationAgg{}, waits: map[waitKey]*durAgg{},
		transitions: map[transKey]*transAgg{}, cellsSeen: map[flowDims]map[string]bool{}, st: s, spans: spans}
	visitSpan := map[string]*Span{}
	var waits []*Span
	for _, sp := range spans {
		switch sp.Kind {
		case "visit":
			visitSpan[sp.Entity] = sp
		case "slice-wait", "slice-eligible", "capacity-wait", "gate-wait", "person-wait":
			waits = append(waits, sp)
		}
	}
	// Per ticket: its visits' starts (in recorded order) and stations, for the waits.
	type entry struct {
		from    int64
		station string
	}
	entries := map[string][]entry{}
	for _, t := range sortedKeys(s.Cells) {
		c := s.Cells[t]
		base := flowDims{risk: c.Risk, app: c.AppType, wave: c.WaveID}
		first := int64(math.MaxInt64)
		stationOf := map[string]string{}
		prev, prevVisit := "", (*Visit)(nil)
		var lastSpan *Span
		for _, v := range c.Visits {
			station := orDefault(v.Station, "unknown")
			stationOf[v.VisitID] = station
			sp := visitSpan["visit:"+v.VisitID]
			if sp == nil {
				continue
			}
			first = min(first, sp.from)
			d := base
			d.day = flowDay(sp.from)
			a := ix.station(stationKey{d, station})
			a.add(sp.Duration, t)
			if v.Action == "revise" {
				a.revise++
			}
			entries[t] = append(entries[t], entry{sp.from, station})
			if prevVisit != nil {
				tr := ix.transition(transKey{d, prev, station})
				tr.count++
				tr.tickets[t] = struct{}{}
				if v.Action == "revise" {
					tr.revise++
				}
			}
			prev, prevVisit, lastSpan = station, v, sp
		}
		if lastSpan != nil {
			term, at := "", int64(0)
			switch {
			case c.Merge != nil && c.Merge.At != nil:
				term, at = TerminalMerged, stampMS(c.Merge.At)
			case c.Cleanup != nil && c.Cleanup.Outcome == "abandoned" && c.Cleanup.At != nil:
				term, at = TerminalAbandoned, stampMS(c.Cleanup.At)
			case c.Stage == "blocked":
				term, at = TerminalBlocked, lastSpan.from
				if c.Updated != nil {
					at = stampMS(c.Updated)
				}
			}
			if term != "" {
				d := base
				d.day = flowDay(at)
				tr := ix.transition(transKey{d, prev, term})
				tr.count++
				tr.tickets[t] = struct{}{}
			}
		}
		for _, g := range c.Gates {
			if g.At == nil {
				continue
			}
			station := stationOf[g.VisitID]
			if station == "" {
				station, _, _ = strings.Cut(g.Gate, ".")
				station = orDefault(station, "unknown")
			}
			d := base
			d.day = flowDay(stampMS(g.At))
			a := ix.station(stationKey{d, station})
			a.gateEval++
			switch g.Verdict {
			case "refused":
				a.gateRefused++
			case "overridden":
				a.gateOvr++
			}
			if g.Verdict == "refused" || g.Verdict == "overridden" {
				if a.gateTickets == nil {
					a.gateTickets = map[string]struct{}{}
				}
				a.gateTickets[t] = struct{}{}
			}
		}
		if first == math.MaxInt64 && c.FirstSeen != nil {
			first = stampMS(c.FirstSeen)
		}
		if first != math.MaxInt64 {
			d := base
			d.day = flowDay(first)
			if ix.cellsSeen[d] == nil {
				ix.cellsSeen[d] = map[string]bool{}
			}
			ix.cellsSeen[d][t] = c.Lifecycle
		}
	}
	for _, l := range entries {
		sort.SliceStable(l, func(i, j int) bool { return l[i].from < l[j].from })
	}
	for _, sp := range waits {
		kind := waitKindOf(sp)
		t := sp.meta.ticket
		d := flowDims{day: flowDay(sp.from), wave: sp.meta.wave}
		if c := s.Cells[t]; t != "" && c != nil {
			d.risk, d.app, d.wave = c.Risk, c.AppType, c.WaveID
		}
		next := ""
		for _, e := range entries[t] {
			if e.from >= sp.from {
				next = e.station
				break
			}
		}
		a := ix.waits[waitKey{d, kind, next}]
		if a == nil {
			a = &durAgg{}
			ix.waits[waitKey{d, kind, next}] = a
		}
		a.add(sp.Duration, t)
	}
	return ix
}

func (ix *FlowIndex) station(k stationKey) *stationAgg {
	a := ix.stations[k]
	if a == nil {
		a = &stationAgg{}
		ix.stations[k] = a
	}
	return a
}

func (ix *FlowIndex) transition(k transKey) *transAgg {
	a := ix.transitions[k]
	if a == nil {
		a = &transAgg{tickets: map[string]struct{}{}}
		ix.transitions[k] = a
	}
	return a
}

// FlowQuery selects the cells a reply merges. A window is [From, To) in whole UTC days.
type FlowQuery struct {
	Window                       bool
	From, To                     int64
	Risk, AppType, Wave, Station string
}

func (q FlowQuery) wantDims(d flowDims) bool {
	if q.Window && (d.day < q.From || d.day >= q.To) {
		return false
	}
	return want(q.Risk, d.risk) && want(q.AppType, d.app) && want(q.Wave, d.wave)
}

// want: a filter value ("" asks nothing; "unknown" matches what recorded no value).
func want(filter, v string) bool {
	switch filter {
	case "":
		return true
	case "unknown":
		return v == "" || v == "unknown"
	}
	return filter == v
}

// ---- the reply ----

// MeasuredStats are statistics over measured durations only (exact, nearest rank). nil when none.
type MeasuredStats struct {
	Count           int64  `json:"count"`
	TotalMS         int64  `json:"total_ms"`
	MeanMS          int64  `json:"mean_ms"`
	MedianMS        int64  `json:"median_ms"`
	P90MS           int64  `json:"p90_ms"`
	MinMS           int64  `json:"min_ms"`
	MaxMS           int64  `json:"max_ms"`
	PercentileBasis string `json:"percentile_basis"` // exact: nearest rank over every measured duration
}

// DurationSummary is a duration distribution kept apart by basis.
type DurationSummary struct {
	Count int64            `json:"count"`
	Basis map[string]int64 `json:"basis"` // measured, bounded, inferred, open, unknown (all present)
	// Measured: statistics over measured durations only; null when there are none.
	Measured *MeasuredStats `json:"measured"`
	// Bounded: the sums of the known lower and upper bounds (null when no bounded duration has
	// one); upper_unknown counts bounded durations with no upper bound.
	Bounded BoundSummary `json:"bounded"`
	// Inferred: an inferred end gives an upper bound only.
	Inferred BoundSummary `json:"inferred"`
}

// BoundSummary sums bounds of non-measured durations.
type BoundSummary struct {
	Count        int64  `json:"count"`
	TotalMinMS   *int64 `json:"total_min_ms"`
	TotalMaxMS   *int64 `json:"total_max_ms"`
	UpperUnknown int64  `json:"upper_unknown"`
}

func summarize(a *durAgg) DurationSummary {
	out := DurationSummary{Count: a.count(), Basis: map[string]int64{}}
	for i, b := range flowBases {
		out.Basis[b] = a.basis[i]
	}
	if n := len(a.measured); n > 0 {
		v := append([]int64(nil), a.measured...)
		sort.Slice(v, func(i, j int) bool { return v[i] < v[j] })
		var sum int64
		for _, x := range v {
			sum += x
		}
		rank := func(p float64) int64 {
			k := int(math.Ceil(p*float64(n))) - 1
			return v[max(0, min(n-1, k))]
		}
		out.Measured = &MeasuredStats{Count: int64(n), TotalMS: sum, MeanMS: int64(math.Round(float64(sum) / float64(n))), MedianMS: rank(0.5),
			P90MS: rank(0.9), MinMS: v[0], MaxMS: v[n-1], PercentileBasis: "exact"}
	}
	if b := a.basis[1]; b > 0 {
		out.Bounded = BoundSummary{Count: b, TotalMinMS: ptr(a.boundMin), UpperUnknown: a.boundNoMax}
		if a.boundNoMax < b {
			out.Bounded.TotalMaxMS = ptr(a.boundMax)
		}
	}
	if b := a.basis[2]; b > 0 {
		out.Inferred = BoundSummary{Count: b, UpperUnknown: a.inferNoMax}
		if a.inferNoMax < b {
			out.Inferred.TotalMaxMS = ptr(a.inferMax)
		}
	}
	return out
}

// GateCounts are a station's gate evaluations.
type GateCounts struct {
	Evaluated  int64 `json:"evaluated"`
	Refused    int64 `json:"refused"`
	Overridden int64 `json:"overridden"`
	// Tickets: unique tickets with a refusal or an override.
	Tickets int64 `json:"tickets"`
}

// WaitSummary is one wait kind's waits (before a station, or overall).
type WaitSummary struct {
	Kind    string `json:"kind"`
	Count   int64  `json:"count"`
	Tickets int64  `json:"tickets"`
	// WithoutTicket: waits of a slice that had no ticket yet.
	WithoutTicket int64           `json:"without_ticket"`
	Duration      DurationSummary `json:"duration"`
	// NextStationUnknown (overall only): waits after which no station visit was recorded.
	NextStationUnknown *int64 `json:"next_station_unknown,omitempty"`
}

// StationFlow is one station's figures.
type StationFlow struct {
	Station       string          `json:"station"`
	Visits        int64           `json:"visits"`
	Tickets       int64           `json:"tickets"`
	ReviseEntries int64           `json:"revise_entries"`
	OpenVisits    int64           `json:"open_visits"`
	Duration      DurationSummary `json:"duration"`
	Gates         GateCounts      `json:"gates"`
	WaitsBefore   []WaitSummary   `json:"waits_before"`
}

// Transition is a count of recorded consecutive visits of one cell (from one station to the next,
// or from the last station to a terminal outcome); never a claim about any ticket's trajectory.
type Transition struct {
	From     string `json:"from"`
	To       string `json:"to"`
	Terminal bool   `json:"terminal"`
	Count    int64  `json:"count"`
	Tickets  int64  `json:"tickets"`
	Revise   int64  `json:"revise"` // into a revision of the build (a loop back after a failed verification or a rejection)
}

// Bottleneck is one entry of the ranking: a station's visits or a wait kind, ranked by total
// measured time (so volume counts), with the volume and what was not measured beside it.
type Bottleneck struct {
	Rank            *int   `json:"rank"` // null when nothing was measured
	Kind            string `json:"kind"` // station | wait
	Key             string `json:"key"`
	TotalMeasuredMS *int64 `json:"total_measured_ms"`
	Count           int64  `json:"count"` // visits or waits, every basis
	Measured        int64  `json:"measured"`
	NotMeasured     int64  `json:"not_measured"`
	TicketsDelayed  int64  `json:"tickets_delayed"` // unique tickets with a measured duration counted in the total
	MedianMS        *int64 `json:"median_ms"`
	P90MS           *int64 `json:"p90_ms"`
}

// FlowCoverage says what the figures cover.
type FlowCoverage struct {
	Tickets              int64 `json:"tickets"`                // cells selected (by the day of their first recorded fact)
	TicketsWithLifecycle int64 `json:"tickets_with_lifecycle"` // of which have a lifecycle log (the only source of visits)
	Visits               int64 `json:"visits"`
	VisitsMeasured       int64 `json:"visits_measured"`
	// WaitsDropped counts, by wait kind, the oldest waits the projection no longer keeps (its
	// bounds per slice and overall): they are in no figure above, whatever the window or filter.
	WaitsDropped map[string]int64 `json:"waits_dropped"`
}

// FlowReport is the flow reply's data.
type FlowReport struct {
	Stations    []StationFlow `json:"stations"`
	Transitions []Transition  `json:"transitions"`
	Waits       []WaitSummary `json:"waits"`
	Bottlenecks []Bottleneck  `json:"bottlenecks"`
	Coverage    FlowCoverage  `json:"coverage"`
	Unit        string        `json:"unit"`
}

// Flow merges the day cells q selects.
func (ix *FlowIndex) Flow(q FlowQuery) FlowReport {
	rep := FlowReport{Stations: []StationFlow{}, Transitions: []Transition{}, Waits: []WaitSummary{}, Bottlenecks: []Bottleneck{}, Unit: "ms"}
	stations := map[string]*stationAgg{}
	for k, a := range ix.stations {
		if !q.wantDims(k.flowDims) || (q.Station != "" && k.station != q.Station) {
			continue
		}
		m := stations[k.station]
		if m == nil {
			m = &stationAgg{}
			stations[k.station] = m
		}
		m.merge(&a.durAgg)
		m.revise += a.revise
		m.gateEval += a.gateEval
		m.gateRefused += a.gateRefused
		m.gateOvr += a.gateOvr
		for t := range a.gateTickets {
			if m.gateTickets == nil {
				m.gateTickets = map[string]struct{}{}
			}
			m.gateTickets[t] = struct{}{}
		}
	}
	before := map[string]map[string]*durAgg{} // station -> kind
	overall := map[string]*durAgg{}
	unknownNext := map[string]int64{}
	for k, a := range ix.waits {
		if !q.wantDims(k.flowDims) {
			continue
		}
		o := overall[k.kind]
		if o == nil {
			o = &durAgg{}
			overall[k.kind] = o
		}
		if k.next == "" {
			unknownNext[k.kind] += a.count()
		}
		if q.Station != "" && k.next != q.Station {
			continue
		}
		o.merge(a)
		if k.next == "" {
			continue
		}
		if before[k.next] == nil {
			before[k.next] = map[string]*durAgg{}
		}
		b := before[k.next][k.kind]
		if b == nil {
			b = &durAgg{}
			before[k.next][k.kind] = b
		}
		b.merge(a)
		if stations[k.next] == nil {
			stations[k.next] = &stationAgg{}
		}
	}
	names := make([]string, 0, len(stations))
	for n := range stations {
		names = append(names, n)
	}
	sort.Slice(names, func(i, j int) bool { return stationLess(names[i], names[j]) })
	waitSummary := func(kind string, a *durAgg) WaitSummary {
		return WaitSummary{Kind: kind, Count: a.count(), Tickets: int64(len(a.tickets)), WithoutTicket: a.noTicket, Duration: summarize(a)}
	}
	for _, n := range names {
		a := stations[n]
		sf := StationFlow{Station: n, Visits: a.count(), Tickets: int64(len(a.tickets)), ReviseEntries: a.revise, OpenVisits: a.basis[3],
			Duration: summarize(&a.durAgg), Gates: GateCounts{Evaluated: a.gateEval, Refused: a.gateRefused, Overridden: a.gateOvr, Tickets: int64(len(a.gateTickets))},
			WaitsBefore: []WaitSummary{}}
		for _, kind := range WaitKinds {
			if b := before[n][kind]; b != nil {
				sf.WaitsBefore = append(sf.WaitsBefore, waitSummary(kind, b))
			}
		}
		rep.Stations = append(rep.Stations, sf)
		rep.Coverage.Visits += sf.Visits
		rep.Coverage.VisitsMeasured += a.basis[0]
		rep.Bottlenecks = append(rep.Bottlenecks, bottleneck("station", n, &a.durAgg))
	}
	for _, kind := range WaitKinds {
		o := overall[kind]
		if o == nil {
			continue
		}
		ws := waitSummary(kind, o)
		if q.Station == "" {
			n := unknownNext[kind]
			ws.NextStationUnknown = &n
		}
		rep.Waits = append(rep.Waits, ws)
		rep.Bottlenecks = append(rep.Bottlenecks, bottleneck("wait", kind, o))
	}
	trans := map[[2]string]*transAgg{}
	for k, a := range ix.transitions {
		if !q.wantDims(k.flowDims) || (q.Station != "" && k.from != q.Station && k.to != q.Station) {
			continue
		}
		m := trans[[2]string{k.from, k.to}]
		if m == nil {
			m = &transAgg{tickets: map[string]struct{}{}}
			trans[[2]string{k.from, k.to}] = m
		}
		m.count += a.count
		m.revise += a.revise
		for t := range a.tickets {
			m.tickets[t] = struct{}{}
		}
	}
	for k, a := range trans {
		terminal := k[1] == TerminalMerged || k[1] == TerminalAbandoned || k[1] == TerminalBlocked
		rep.Transitions = append(rep.Transitions, Transition{From: k[0], To: k[1], Terminal: terminal, Count: a.count, Tickets: int64(len(a.tickets)), Revise: a.revise})
	}
	sort.Slice(rep.Transitions, func(i, j int) bool {
		a, b := rep.Transitions[i], rep.Transitions[j]
		if a.From != b.From {
			return stationLess(a.From, b.From)
		}
		if a.Terminal != b.Terminal {
			return !a.Terminal
		}
		return stationLess(a.To, b.To)
	})
	sort.SliceStable(rep.Bottlenecks, func(i, j int) bool {
		a, b := rep.Bottlenecks[i], rep.Bottlenecks[j]
		if (a.TotalMeasuredMS == nil) != (b.TotalMeasuredMS == nil) {
			return a.TotalMeasuredMS != nil
		}
		if a.TotalMeasuredMS != nil && *a.TotalMeasuredMS != *b.TotalMeasuredMS {
			return *a.TotalMeasuredMS > *b.TotalMeasuredMS
		}
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		return a.Key < b.Key
	})
	r := 0
	for i := range rep.Bottlenecks {
		if rep.Bottlenecks[i].TotalMeasuredMS != nil {
			r++
			rep.Bottlenecks[i].Rank = ptr(r)
		}
	}
	rep.Coverage.WaitsDropped = map[string]int64{WaitCapacity: ix.st.CapacityWaitsDropped, WaitCapacitySlice: ix.st.SliceCapacityWaitsDropped, WaitDependency: 0}
	for _, sl := range ix.st.Slices {
		rep.Coverage.WaitsDropped[WaitDependency] += sl.WaitsDropped
	}
	for d, tix := range ix.cellsSeen {
		if !q.wantDims(d) {
			continue
		}
		for _, lc := range tix {
			rep.Coverage.Tickets++
			if lc {
				rep.Coverage.TicketsWithLifecycle++
			}
		}
	}
	return rep
}

func bottleneck(kind, key string, a *durAgg) Bottleneck {
	b := Bottleneck{Kind: kind, Key: key, Count: a.count(), Measured: a.basis[0], NotMeasured: a.count() - a.basis[0], TicketsDelayed: int64(len(a.measuredTix))}
	if s := summarize(a).Measured; s != nil {
		b.TotalMeasuredMS, b.MedianMS, b.P90MS = ptr(s.TotalMS), ptr(s.MedianMS), ptr(s.P90MS)
	}
	return b
}

// ---- the cache ----

// flowCache keeps, per projector, the latest index built from a head timeline and the latest built
// at a cursor. (Kept beside the projector rather than in it, so the projector is unchanged.)
type flowCache struct {
	mu   sync.Mutex
	tl   *Timeline
	head *FlowIndex
	at   *FlowIndex
}

var flowCaches sync.Map // *Projector -> *flowCache

func (p *Projector) flowCache() *flowCache {
	c, _ := flowCaches.LoadOrStore(p, &flowCache{})
	return c.(*flowCache)
}

// Flow returns the flow index at the projection's position: the timeline's (built once per
// timeline; a timeline may be up to TimelineMaxAge behind the head, and the index says its Pos).
func (p *Projector) Flow() (*FlowIndex, error) {
	tl, err := p.Timeline()
	if err != nil {
		return nil, err
	}
	c := p.flowCache()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.tl != tl || c.head == nil {
		c.tl, c.head = tl, BuildFlow(tl.st, tl.spans)
	}
	return c.head, nil
}

// FlowAt returns the flow index at a cursor: the head's when it is at that position, else built from
// a private state rebuilt there (Projector.At) and kept while the same position is asked again.
func (p *Projector) FlowAt(at uint64) (*FlowIndex, error) {
	if head, err := p.Flow(); err == nil && head.Pos == at {
		return head, nil
	}
	c := p.flowCache()
	c.mu.Lock()
	if a := c.at; a != nil && a.Pos == at && a.Epoch == p.opts.Log.Epoch() {
		c.mu.Unlock()
		return a, nil
	}
	c.mu.Unlock()
	s, _, err := p.At(at)
	if err != nil {
		return nil, err
	}
	ix := BuildFlow(s, allSpans(s))
	c.mu.Lock()
	c.at = ix
	c.mu.Unlock()
	return ix, nil
}

// State is the state the index was built from (read only).
func (ix *FlowIndex) State() *State { return ix.st }
