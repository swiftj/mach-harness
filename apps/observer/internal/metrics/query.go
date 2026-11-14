package metrics

import (
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ---- reading ----

// Query is what a read asks of the table.
type Query struct {
	IDs []string
	// GroupBy is up to two dimensions ("day" and "week" are periods).
	GroupBy []string
	// FromDay and ToDay bound the window, inclusive UTC days ("2006-01-02"); "" is an open side.
	FromDay, ToDay string
	Windowed       bool
	// Filters select cells by dimension value; "unknown" selects cells that recorded none.
	Filters map[string]string
	// Bucket asks for a trend: "day" or "week" (weeks start on Monday, UTC).
	Bucket string
	// Distribution asks for percentiles and the histogram of duration metrics.
	Distribution bool
	// Runs, when set, is the table of the last LastRuns run records (observe's population): the
	// scorecard metrics are read from it and every other metric is unavailable.
	Runs *Table
	// Resolve gives a ticket's risk, app type and wave at the cursor read: ticket-keyed cells take
	// those dimensions from it, never from when the event was applied.
	Resolve func(ticket string) map[string]string
	joined  map[string]map[string]string // Resolve's answers, shared by the rows of one query
	// AsOf, when set, is put on every row: what the figure stands on when a playhead is asked.
	AsOf     *AsOf
	LastRuns int
	// RunsSelected is how many run records the last_runs population holds.
	RunsSelected int
}

// AsOf says how a figure is cut at a playhead (as_of_ms). Day-celled figures end at the UTC
// midnight at or before it (Exact false, EffectiveToMS that midnight); open members are kept by
// their start day and cannot be cut, so basis_counts.open is null.
type AsOf struct {
	MS            int64  `json:"ms"`
	Exact         bool   `json:"exact"`
	EffectiveToMS int64  `json:"effective_to_ms"`
	Rule          string `json:"rule"`
}

// MaxResponseGroups bounds the groups one metric returns; the rest are counted.
const MaxResponseGroups = 2000

// BasisCounts are members by how their value is known. Open is null where it cannot be
// attributed (a filter, a group, a period: open members are kept by start day only).
type BasisCounts struct {
	Measured    int64  `json:"measured"`
	Bounded     int64  `json:"bounded"`
	Inferred    int64  `json:"inferred"`
	Open        *int64 `json:"open"`
	Unknown     int64  `json:"unknown"`
	NotRecorded int64  `json:"not_recorded"`
}

// Bounds are the least lower and greatest upper bound of the bounded members.
type Bounds struct {
	MinMS *float64 `json:"min_ms"`
	MaxMS *float64 `json:"max_ms"`
}

// Excluded is one reason members of the population were left out of the value.
type Excluded struct {
	Reason string  `json:"reason"`
	Count  float64 `json:"count"`
	// Unit, when set, says the count is in another unit than the coverage's and is not part of it.
	Unit string `json:"unit,omitempty"`
}

// ExPairNoCost: a model's usage within an execution that carries no cost (K2, per pair).
const ExPairNoCost = "the model's usage carries no cost"

// ExK1Failed is K1's coverage reason for a failed execution: K1 reads execution.completed's cost
// and the Factory's execution.failed records none, so a failed execution is excluded by the
// definition, not missing a cost. Rules that judge missing cost leave it out (M6.6).
const ExK1Failed = "failed: the Factory's record of a failed execution carries no cost"

// Coverage is how much of the population the value stands on. Covered, Of and Share are the
// fields served before M6.5 (Covered = Counted, Of = Eligible); Eligible = Counted + the excluded.
type Coverage struct {
	Covered  *float64   `json:"covered"`
	Of       *float64   `json:"of"`
	Share    *float64   `json:"share"`
	Reason   string     `json:"reason,omitempty"`
	Eligible *float64   `json:"eligible"`
	Counted  *float64   `json:"counted"`
	Excluded []Excluded `json:"excluded"`
	// Unit names the population the coverage counts when it is not the denominator's.
	Unit string `json:"unit,omitempty"`
	// Other are exclusions counted in another unit (K2: execution-model pairs with no cost):
	// reported beside the coverage, not part of eligible = counted + excluded.
	Other []Excluded `json:"other,omitempty"`
}

// TargetCheck is a scorecard target, decided on the unrounded value (observe.py measure).
type TargetCheck struct {
	Value     float64 `json:"value"`
	Direction string  `json:"direction"` // below | above
	Met       *bool   `json:"met"`
}

// HistBucket is one histogram bucket: members with ge_ms <= duration < le_ms.
type HistBucket struct {
	GeMS  float64 `json:"ge_ms"`
	LeMS  float64 `json:"le_ms"`
	Count int64   `json:"count"`
}

// Distribution: percentiles exact (nearest rank) while the population's values are all kept, else
// interpolated in the log histogram (Percentile); Bounds gives, per percentile, the bucket it lies in
// (equal bounds when exact).
type Distribution struct {
	P10       *float64              `json:"p10"`
	P25       *float64              `json:"p25"`
	P50       *float64              `json:"p50"`
	P75       *float64              `json:"p75"`
	P90       *float64              `json:"p90"`
	Min       *float64              `json:"min"`
	Max       *float64              `json:"max"`
	Histogram []HistBucket          `json:"histogram"`
	Basis     string                `json:"percentile_basis"`
	Bounds    map[string][2]float64 `json:"percentile_bounds"`
	Over      string                `json:"over"`
}

// Figure is one computed value with what it stands on.
type Figure struct {
	Value       *float64 `json:"value"`
	Numerator   *float64 `json:"numerator"`
	Denominator *float64 `json:"denominator"`
	P50         *float64 `json:"p50_ms,omitempty"`
	P90         *float64 `json:"p90_ms,omitempty"`
	Min         *float64 `json:"min_ms,omitempty"`
	Max         *float64 `json:"max_ms,omitempty"`
	// PercentileBasis is "exact" (nearest rank over every measured duration) or "histogram"
	// (interpolated in the log-histogram bucket; P50Bounds and P90Bounds are that bucket's bounds).
	PercentileBasis string        `json:"percentile_basis,omitempty"`
	P50Bounds       *[2]float64   `json:"p50_bounds_ms,omitempty"`
	P90Bounds       *[2]float64   `json:"p90_bounds_ms,omitempty"`
	NullReason      string        `json:"null_reason,omitempty"`
	ValueRounded    *float64      `json:"value_rounded,omitempty"`
	SampleCount     *float64      `json:"sample_count"`
	BasisCounts     *BasisCounts  `json:"basis_counts"`
	Bounds          *Bounds       `json:"bounds,omitempty"`
	Coverage        Coverage      `json:"coverage"`
	Met             *bool         `json:"met,omitempty"`
	Distribution    *Distribution `json:"distribution,omitempty"`
}

// Group is one row of a grouped metric. Key is the value (two dimensions: "a|b"); Keys names them.
type Group struct {
	Key  string            `json:"key"`
	Keys map[string]string `json:"keys"`
	Figure
}

// Bucket is one period of a trend.
type Bucket struct {
	Period  string `json:"period"` // the day, or the week's Monday
	FromMS  int64  `json:"from_ms"`
	ToMS    int64  `json:"to_ms"`
	Suspect bool   `json:"suspect"`
	Figure
}

// Row is one metric as the API returns it. The fields before "family" are those served before
// M6.5, with the same names and meaning (value is now unrounded; value_rounded is observe's).
type Row struct {
	Def
	Value       *float64 `json:"value"`
	Numerator   *float64 `json:"numerator_value"`
	Denominator *float64 `json:"denominator_value"`
	P50         *float64 `json:"p50_ms,omitempty"`
	P90         *float64 `json:"p90_ms,omitempty"`
	Min         *float64 `json:"min_ms,omitempty"`
	Max         *float64 `json:"max_ms,omitempty"`
	Met         *bool    `json:"met,omitempty"`
	// PercentileBasis is "exact" or "histogram"; with the histogram, P50Bounds and P90Bounds say
	// between which values the percentile lies.
	PercentileBasis string      `json:"percentile_basis,omitempty"`
	P50Bounds       *[2]float64 `json:"p50_bounds_ms,omitempty"`
	P90Bounds       *[2]float64 `json:"p90_bounds_ms,omitempty"`
	Basis           string      `json:"basis"`
	NullReason      string      `json:"null_reason,omitempty"`
	Coverage        Coverage    `json:"coverage"`
	GroupBy         string      `json:"group_by,omitempty"`
	Groups          []Group     `json:"groups"` // null when not grouped, [] when grouped and empty

	Family       string        `json:"family"`
	Description  string        `json:"description"`
	Formula      string        `json:"formula"`
	Status       string        `json:"status"` // available | partial | deferred | not-recorded | unavailable
	StatusReason string        `json:"status_reason,omitempty"`
	ValueRounded *float64      `json:"value_rounded,omitempty"`
	SampleCount  *float64      `json:"sample_count"`
	Population   string        `json:"population"`
	BasisCounts  *BasisCounts  `json:"basis_counts"`
	Bounds       *Bounds       `json:"bounds,omitempty"`
	Sources      []string      `json:"sources"`
	TargetCheck  *TargetCheck  `json:"target_check,omitempty"`
	GroupDims    []string      `json:"group_dims,omitempty"`
	GroupsReason string        `json:"groups_reason,omitempty"`
	GroupsOmit   int           `json:"groups_omitted,omitempty"`
	Buckets      []Bucket      `json:"buckets,omitempty"`
	Distribution *Distribution `json:"distribution,omitempty"`
	Suspect      bool          `json:"suspect"`
	// AsOf: with a playhead, how this figure is cut (every figure of the reply has the same).
	AsOf *AsOf `json:"as_of,omitempty"`
}

// joinable are the dimensions a read joins to a ticket-keyed cell (Query.Resolve).
var joinable = map[string]bool{"risk": true, "app_type": true, "wave": true}

// Exclusion reasons for durations that are not measured.
const (
	exBounded  = "bounded: an end's time is known only within limits (counted apart, never averaged)"
	exInferred = "inferred: the duration is reconstructed, not measured"
	exUnknown  = "unknown: an end's time, or its start, was not recorded"
	exOpen     = "open: started and not yet ended"
	exRefused  = "source records the observer refused (an unreadable line, or an identifier outside its pattern)"
	exNoTime   = "the event's time is not recorded, so it falls in no window"
	exOverflow = "dimension values not kept (the metric's cell limit was reached)"
)

// Rows evaluates the given metrics (all when ids is empty), grouped by one dimension when groupBy
// is set: the read served before M6.5.
func (t *Table) Rows(ids []string, groupBy string) []Row {
	q := Query{IDs: ids}
	if groupBy != "" {
		q.GroupBy = []string{groupBy}
	}
	return t.Query(q)
}

// Query evaluates the metrics asked.
func (t *Table) Query(q Query) []Row {
	q.joined = map[string]map[string]string{}
	want := map[string]bool{}
	for _, id := range q.IDs {
		want[id] = true
	}
	var out []Row
	for _, d := range Catalog {
		if len(want) > 0 && !want[d.ID] {
			continue
		}
		out = append(out, t.row(d, q))
	}
	return out
}

func (t *Table) row(d Def, q Query) Row {
	row := Row{Def: d, GroupBy: strings.Join(q.GroupBy, ","), Family: family(d.ID), Formula: formula(d), Population: d.Denominator,
		Sources: []string{d.Source}, Basis: "measured"}
	row.Description = d.Name + ": " + row.Formula
	if d.Authority == "reconstructed" {
		row.Basis = "inferred"
	}
	row.Status, row.StatusReason = d.Status()
	if len(q.GroupBy) > 0 {
		row.GroupDims = q.GroupBy
	}
	if d.Target != "" {
		op, lim, _ := strings.Cut(d.Target, " ")
		v, _ := strconv.ParseFloat(lim, 64)
		row.TargetCheck = &TargetCheck{Value: v, Direction: map[string]string{"<": "below", ">": "above"}[op]}
	}
	none := func(basis, reason string) Row {
		row.Basis, row.NullReason = basis, reason
		row.Coverage = Coverage{Reason: "no value", Excluded: []Excluded{}}
		if len(q.GroupBy) > 0 {
			row.Groups = []Group{}
		}
		return row
	}
	if d.Unavailable != "" {
		if d.Avail != "no" {
			return none("unknown", d.Unavailable)
		}
		return none("not-recorded", d.Unavailable)
	}
	src := t
	if q.Runs != nil {
		if !d.Runs {
			row.Status, row.StatusReason = "unavailable", "last_runs selects the observe station's run records; this metric is not computed from them"
			return none("unknown", row.StatusReason)
		}
		src = q.Runs
		row.Population = d.Denominator + " among the last " + strconv.Itoa(q.LastRuns) + " finished runs by closed_at (observe.py's population; " +
			strconv.Itoa(q.RunsSelected) + " held)"
	}
	for _, k := range sortedKeys(q.Filters) {
		if k == "provenance" {
			row.Status, row.StatusReason = "unavailable", "execution provenance is not recorded yet (M6_5_DESIGN.md section 5), so no metric can be filtered by it"
			return none("unknown", row.StatusReason)
		}
		if !d.Supports(k) {
			row.Status, row.StatusReason = "unavailable", "this metric is not recorded by "+k+", so the "+k+" filter cannot be honoured"
			return none("unknown", row.StatusReason)
		}
	}
	groupable := true
	for _, g := range q.GroupBy {
		if !d.Supports(g) {
			groupable = false
			row.GroupsReason = "this metric is not recorded by " + g
		}
	}

	total := &Agg{}
	extra := map[string]float64{} // exclusions outside the cells read
	distinct := map[string]bool{}
	type grp struct {
		agg      *Agg
		keys     map[string]string
		distinct map[string]bool
	}
	groups := map[string]*grp{}
	pool := map[string]*Agg{} // split metrics: the population by the non-split group keys
	periods := map[string]*grp{}
	splitGroup := false
	for _, g := range q.GroupBy {
		splitGroup = splitGroup || d.split(g)
	}
	var minDay, maxDay string
	matched := 0
	joined := q.joined
	dimOf := func(f fact, key string) string {
		if v := f.get(key); v != "" || q.Resolve == nil || !joinable[key] {
			return v
		}
		t := f.get("ticket")
		if t == "" {
			return ""
		}
		m, ok := joined[t]
		if !ok {
			m = q.Resolve(t)
			joined[t] = m
		}
		return m[key]
	}
	cells := src.Cells[d.ID]
	for _, k := range src.keys(d.ID) {
		a := cells[k]
		f := src.fact(k)
		if q.Windowed {
			if f.day == "" {
				extra[exNoTime] += weight(d, a)
				continue
			}
			if q.FromDay != "" && f.day < q.FromDay || q.ToDay != "" && f.day > q.ToDay {
				continue
			}
		}
		if len(q.Filters) > 0 && f.overflow {
			extra[exOverflow] += weight(d, a)
			continue
		}
		match := true
		for fk, fv := range q.Filters {
			v := dimOf(f, fk)
			if !(v == fv || fv == "unknown" && v == "") {
				match = false
				break
			}
		}
		if !match {
			continue
		}
		matched++
		total.merge(a)
		dv := ""
		if d.Distinct != "" {
			dv = f.get(d.Distinct)
			if dv != "" {
				distinct[dv] = true
			}
		}
		if f.day != "" {
			if minDay == "" || f.day < minDay {
				minDay = f.day
			}
			if f.day > maxDay {
				maxDay = f.day
			}
		}
		if q.Bucket != "" && f.day != "" {
			p := f.day
			if q.Bucket == "week" {
				p = weekOf(f.day)
			}
			b := periods[p]
			if b == nil {
				b = &grp{agg: &Agg{}, distinct: map[string]bool{}}
				periods[p] = b
			}
			b.agg.merge(a)
			if dv != "" {
				b.distinct[dv] = true
			}
		}
		if len(q.GroupBy) == 0 || !groupable {
			continue
		}
		if d.CoverUnit != "" && a.Num == 0 && a.Den == 0 && a.Count == 0 {
			// A coverage-only cell (Def.CoverUnit: an execution with or without usage) carries no
			// group dimension: it counts in the total's coverage and forms no "unknown" group.
			missing := false
			for _, g := range q.GroupBy {
				missing = missing || g != "day" && g != "week" && dimOf(f, g) == ""
			}
			if missing {
				continue
			}
		}
		var parts, poolParts []string
		isDen := false
		for _, g := range q.GroupBy {
			var v string
			switch {
			case g == "day":
				v = f.day
			case g == "week" && f.day != "":
				v = weekOf(f.day)
			case f.overflow:
				v = "overflow"
			default:
				v = dimOf(f, g)
			}
			if v == "" {
				if d.split(g) && !f.overflow {
					isDen = true
				}
				v = "unknown"
			}
			parts = append(parts, v)
			if !d.split(g) {
				poolParts = append(poolParts, v)
			}
		}
		if splitGroup && isDen {
			pk := strings.Join(poolParts, "|")
			if pool[pk] == nil {
				pool[pk] = &Agg{}
			}
			pool[pk].merge(a)
			continue
		}
		gk := strings.Join(parts, "|")
		g := groups[gk]
		if g == nil {
			keys := make(map[string]string, len(parts))
			for i, dim := range q.GroupBy {
				keys[dim] = parts[i]
			}
			g = &grp{agg: &Agg{}, keys: keys, distinct: map[string]bool{}}
			groups[gk] = g
		}
		g.agg.merge(a)
		if dv != "" {
			g.distinct[dv] = true
		}
	}

	// Refused source records and open members: whole-population facts, attributable only
	// without a filter (open: and without a group or period).
	var refused int64
	if d.Stream != "" && len(q.Filters) == 0 {
		for day, n := range t.Refused[d.Stream] {
			if !q.Windowed || day != "" && (q.FromDay == "" || day >= q.FromDay) && (q.ToDay == "" || day <= q.ToDay) {
				refused += n
			}
		}
	}
	var open *int64
	if d.Open && q.Runs == nil && len(q.Filters) == 0 && q.AsOf == nil {
		var n int64
		for day, c := range t.Open[d.ID] {
			if !q.Windowed || day != "" && (q.FromDay == "" || day >= q.FromDay) && (q.ToDay == "" || day <= q.ToDay) {
				n += c
			}
		}
		open = &n
	}

	if matched == 0 {
		total = nil
	}
	if refused > 0 {
		extra[exRefused] += float64(refused)
	}
	fig := t.figure(d, total, distinct, extra, open, q)
	if q.Runs != nil && refused > 0 {
		for i := range fig.Coverage.Excluded {
			if fig.Coverage.Excluded[i].Reason == exRefused {
				fig.Coverage.Excluded[i].Reason = exRefused + "; observe.py would count those with a non-empty ticket id, and whether they fall among the last runs is not known"
			}
		}
	}
	row.Value, row.Numerator, row.Denominator, row.NullReason = fig.Value, fig.Numerator, fig.Denominator, fig.NullReason
	row.P50, row.P90, row.Min, row.Max, row.PercentileBasis = fig.P50, fig.P90, fig.Min, fig.Max, fig.PercentileBasis
	row.P50Bounds, row.P90Bounds = fig.P50Bounds, fig.P90Bounds
	row.ValueRounded, row.SampleCount, row.BasisCounts, row.Bounds, row.Coverage = fig.ValueRounded, fig.SampleCount, fig.BasisCounts, fig.Bounds, fig.Coverage
	row.Met, row.Distribution = fig.Met, fig.Distribution
	if row.TargetCheck != nil {
		row.TargetCheck.Met = fig.Met
	}
	if len(q.Filters) > 0 && d.Stream != "" {
		row.Limitations = joinText(row.Limitations, "records the observer refused cannot be attributed to a filter and are not counted in this coverage")
	}
	row.Suspect = t.suspectIn(q.FromDay, q.ToDay, q.Windowed)
	row.AsOf = q.AsOf

	if len(q.GroupBy) > 0 {
		row.Groups = []Group{}
		keys := make([]string, 0, len(groups))
		for k := range groups {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			g := groups[k]
			if splitGroup {
				var pk []string
				for _, dim := range q.GroupBy {
					if !d.split(dim) {
						pk = append(pk, g.keys[dim])
					}
				}
				if p := pool[strings.Join(pk, "|")]; p != nil {
					g.agg.merge(p)
				}
			}
			if len(row.Groups) >= MaxResponseGroups {
				row.GroupsOmit++
				continue
			}
			row.Groups = append(row.Groups, Group{Key: k, Keys: g.keys, Figure: t.figure(d, g.agg, g.distinct, nil, nil, q)})
		}
	}
	if q.Bucket != "" {
		lo, hi := q.FromDay, q.ToDay
		if lo == "" {
			lo = minDay
		}
		if hi == "" {
			hi = maxDay
		}
		row.Buckets = []Bucket{}
		if lo != "" && hi != "" {
			for _, p := range periodsBetween(lo, hi, q.Bucket) {
				from, _ := time.Parse("2006-01-02", p)
				to := from.AddDate(0, 0, 1)
				last := p
				if q.Bucket == "week" {
					to = from.AddDate(0, 0, 7)
					last = to.AddDate(0, 0, -1).Format("2006-01-02")
				}
				b := Bucket{Period: p, FromMS: from.UnixMilli(), ToMS: to.UnixMilli(), Suspect: t.suspectIn(p, last, true)}
				if g := periods[p]; g != nil {
					b.Figure = t.figure(d, g.agg, g.distinct, nil, nil, q)
				} else {
					b.Figure = t.figure(d, nil, nil, nil, nil, q)
				}
				row.Buckets = append(row.Buckets, b)
			}
		}
	}
	return row
}

// figure turns merged cells into a value with its sample, basis, coverage and distribution.
func (t *Table) figure(d Def, a *Agg, distinct map[string]bool, extra map[string]float64, open *int64, q Query) (g Figure) {
	g.Coverage.Excluded = []Excluded{}
	g.BasisCounts = &BasisCounts{Open: open}
	var counted float64
	empty := a == nil
	if a == nil {
		a = &Agg{}
	}
	switch d.Kind {
	case "count":
		excluded := false
		for _, n := range a.Ex {
			excluded = excluded || n > 0
		}
		switch {
		case !empty && a.Num == 0 && excluded:
			// Members are known only from records this count does not read: no count of 0.
			g.Numerator = ptr(a.Num)
			g.NullReason = "none of the known members is counted by this metric's source; the coverage says why"
		case !empty:
			g.Value, g.Numerator = ptr(a.Num), ptr(a.Num)
		}
		counted = a.Num
	case "rate", "mean":
		den := a.Den
		if d.Distinct != "" && distinct != nil {
			den = float64(len(distinct))
		}
		if !empty {
			g.Numerator, g.Denominator = ptr(a.Num), ptr(den)
		}
		if den == 0 {
			if !empty {
				g.NullReason = "the denominator is empty"
			}
		} else {
			v := a.Num / den
			g.Value = &v
			if d.Kind == "rate" || d.Kind == "mean" {
				g.ValueRounded = ptr(RoundObserve(v))
			}
		}
		counted = den
	case "duration":
		if !empty {
			g.Numerator, g.Denominator = ptr(a.Sum), ptr(float64(a.Count))
		}
		if a.Count == 0 {
			if !empty {
				g.NullReason = "no measured durations"
			}
		} else {
			g.Value = ptr(a.Sum / float64(a.Count))
			h, sv := a.full(), a.sortedVals()
			p50, _ := Percentile(sv, h, a.Count, a.Min, a.Max, 0.5)
			p90, _ := Percentile(sv, h, a.Count, a.Min, a.Max, 0.9)
			g.P50, g.P90, g.PercentileBasis = ptr(p50.Value), ptr(p90.Value), p50.Basis
			if p50.Basis == "histogram" {
				g.P50Bounds, g.P90Bounds = &[2]float64{p50.Lo, p50.Hi}, &[2]float64{p90.Lo, p90.Hi}
			}
			g.Min, g.Max = ptr(a.Min), ptr(a.Max)
		}
		counted = float64(a.Count)
		if a.BMin != nil || a.BMax != nil {
			g.Bounds = &Bounds{MinMS: a.BMin, MaxMS: a.BMax}
		}
	}
	if empty {
		g.NullReason = "no events of this kind have been observed"
	}
	if d.Kind == "duration" {
		g.BasisCounts.Measured = a.Count
	} else {
		g.BasisCounts.Measured = int64(counted)
	}
	g.BasisCounts.Bounded, g.BasisCounts.Inferred, g.BasisCounts.Unknown = a.Bounded, a.Inferred, a.Unknown
	g.SampleCount = ptr(counted)

	ex := map[string]float64{}
	for k, n := range a.Ex {
		ex[k] += n
	}
	if n := a.Bounded; n > 0 {
		ex[exBounded] += float64(n)
	}
	if n := a.Inferred; n > 0 {
		ex[exInferred] += float64(n)
	}
	if n := a.Unknown; n > 0 {
		ex[exUnknown] += float64(n)
	}
	if open != nil && *open > 0 {
		ex[exOpen] += float64(*open)
	}
	for k, n := range extra {
		ex[k] += n
	}
	covCounted := counted
	if d.CoverUnit != "" {
		covCounted = float64(a.Cov)
	}
	eligible := covCounted
	for _, k := range sortedKeys(ex) {
		if ex[k] == 0 {
			continue // an exclusion later undone (a member that became counted)
		}
		if u := d.OtherUnit[k]; u != "" {
			g.Coverage.Other = append(g.Coverage.Other, Excluded{Reason: k, Count: ex[k], Unit: u})
			continue // another unit: reported beside the coverage, not part of it
		}
		g.Coverage.Excluded = append(g.Coverage.Excluded, Excluded{Reason: k, Count: ex[k]})
		eligible += ex[k]
	}
	g.Coverage.Eligible, g.Coverage.Counted = ptr(eligible), ptr(covCounted)
	if d.CoverUnit != "" {
		g.Coverage.Unit = d.CoverUnit
	}
	if eligible > 0 {
		g.Coverage.Covered, g.Coverage.Of, g.Coverage.Share = ptr(covCounted), ptr(eligible), ptr(covCounted/eligible)
	} else {
		g.Coverage.Reason = "no member of the population was observed"
	}

	if g.Value != nil && d.Target != "" {
		op, lim, _ := strings.Cut(d.Target, " ")
		limit, _ := strconv.ParseFloat(lim, 64)
		met := (op == "<" && *g.Value < limit) || (op == ">" && *g.Value > limit)
		g.Met = &met
	}
	if q.Distribution {
		g.Distribution = distribution(d, a)
	}
	return g
}

func distribution(d Def, a *Agg) *Distribution {
	if d.Kind != "duration" {
		return nil
	}
	hist, sv := a.full(), a.sortedVals()
	basis := "histogram"
	if sv != nil {
		basis = "exact"
	}
	out := &Distribution{Basis: basis, Bounds: map[string][2]float64{}, Histogram: []HistBucket{},
		Over: "measured durations only"}
	if a.Count > 0 {
		out.Min, out.Max = ptr(a.Min), ptr(a.Max)
	}
	for _, p := range []struct {
		name string
		q    float64
		dst  **float64
	}{{"p10", 0.1, &out.P10}, {"p25", 0.25, &out.P25}, {"p50", 0.5, &out.P50}, {"p75", 0.75, &out.P75}, {"p90", 0.9, &out.P90}} {
		if v, ok := Percentile(sv, hist, a.Count, a.Min, a.Max, p.q); ok {
			*p.dst = ptr(v.Value)
			out.Bounds[p.name] = [2]float64{v.Lo, v.Hi}
		}
	}
	for i, n := range hist {
		if n > 0 {
			out.Histogram = append(out.Histogram, HistBucket{GeMS: math.Round(lower(i)), LeMS: math.Round(upper(i)), Count: n})
		}
	}
	return out
}

// weight is how many members of the population a cell holds.
func weight(d Def, a *Agg) float64 {
	switch d.Kind {
	case "count":
		return a.Num
	case "duration":
		return float64(a.Count + a.Bounded + a.Inferred + a.Unknown)
	}
	return a.Den
}

func (t *Table) suspectIn(from, to string, windowed bool) bool {
	for day := range t.Suspect {
		if !windowed || (from == "" || day >= from) && (to == "" || day <= to) {
			return true
		}
	}
	return false
}

// SuspectDays lists the days holding a history.gap conflict.
func (t *Table) SuspectDays() []string { return sortedKeys(t.Suspect) }

func weekOf(day string) string {
	d, err := time.Parse("2006-01-02", day)
	if err != nil {
		return day
	}
	off := (int(d.Weekday()) + 6) % 7 // Monday 0
	return d.AddDate(0, 0, -off).Format("2006-01-02")
}

// MaxPeriods bounds the periods of one trend.
const MaxPeriods = 1100

func periodsBetween(lo, hi, unit string) []string {
	if unit == "week" {
		lo, hi = weekOf(lo), weekOf(hi)
	}
	from, err1 := time.Parse("2006-01-02", lo)
	to, err2 := time.Parse("2006-01-02", hi)
	if err1 != nil || err2 != nil || to.Before(from) {
		return nil
	}
	step := 1
	if unit == "week" {
		step = 7
	}
	var out []string
	for d := from; !d.After(to) && len(out) < MaxPeriods; d = d.AddDate(0, 0, step) {
		out = append(out, d.Format("2006-01-02"))
	}
	return out
}

func family(id string) string { return id[:1] }

func formula(d Def) string {
	if d.Numerator == "" {
		return ""
	}
	return d.Numerator + " / " + d.Denominator
}

func joinText(a, b string) string {
	if a == "" {
		return b
	}
	return a + "; " + b
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
