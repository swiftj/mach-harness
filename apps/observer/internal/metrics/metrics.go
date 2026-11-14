// Package metrics holds Factory Analytics' source data: the metric catalog of
// M6_1_SHARED_CONTRACTS.md section 4.2 and mergeable aggregate cells (counts, sums, minimum,
// maximum and a fixed log-scale histogram) that the projection updates as events arrive.
//
// Rules kept here (shared contracts 4.1, M6_5_DESIGN.md section 2): recorded values only; every
// metric states its numerator, denominator, grouping, source and limitations; an empty
// denominator is null with a reason, never 0; nothing is estimated or apportioned; measured,
// bounded, inferred, open, unknown and not-recorded are counted apart and a duration statistic is
// computed over measured durations only. Where the observe station defines a metric, the same
// formula is used (observe.py scorecard).
//
// Cells. Each fold writes one cell keyed by the UTC day of the event and every dimension value
// the member carries ("fact cells"). A query merges the cells its window, filters and groups
// select: the cost of a read is the number of distinct (day, dimension values) cells of the
// metrics asked, never the number of events.
package metrics

import (
	"math"
	"sort"
	"strings"
)

// DefinitionsVersion changes whenever a definition or a fold rule changes; aggregates built under
// another version are rebuilt by replaying the log.
//
// 2 (M6.5): fact cells keyed by day and every dimension; basis counts, bounds, open members,
// exclusions; K4 counted once; split and distinct denominators; risk, app type and wave on
// cell-attached metrics; a run with no recorded outcome is neither merged nor abandoned; conflict
// gaps mark days suspect; refused records counted.
const DefinitionsVersion = 2

// Buckets is the histogram size: bucket 0 is under one second; bucket i (1..63) holds durations
// in [2^((i-1)/3), 2^(i/3)) seconds, so bucket 63 reaches about 30 days.
const Buckets = 64

// MaxGroups bounds the cells one metric keeps, so hostile identifiers cannot grow memory without
// limit. A member that would need a further cell is folded into its day's overflow cell (no
// dimension values): totals and periods stay exact, groups report it as "overflow".
const MaxGroups = 20000

// overflowKey marks a day's overflow cell.
const overflowKey = "~"

// Agg is one aggregate cell. Every field merges by addition (min and max by comparison).
type Agg struct {
	Num     float64  `json:"num,omitempty"`
	Den     float64  `json:"den,omitempty"`
	Count   int64    `json:"count,omitempty"`
	Sum     float64  `json:"sum,omitempty"`
	Min     *float64 `json:"min,omitempty"`
	Max     *float64 `json:"max,omitempty"`
	Hist    []int64  `json:"hist,omitempty"`
	Covered float64  `json:"covered,omitempty"`
	Of      float64  `json:"of,omitempty"`
	// Durations not measured, counted apart (never averaged): basis -> members.
	Bases map[string]int64 `json:"bases,omitempty"`
	// Bounds over the bounded members: the least lower bound and the greatest upper bound.
	BMin *float64 `json:"bmin,omitempty"`
	BMax *float64 `json:"bmax,omitempty"`
	// Ex are members of the population left out of the value, by reason.
	Ex map[string]float64 `json:"ex,omitempty"`
}

func (a *Agg) merge(b *Agg) {
	a.Num += b.Num
	a.Den += b.Den
	a.Count += b.Count
	a.Sum += b.Sum
	a.Min = minp(a.Min, b.Min)
	a.Max = maxp(a.Max, b.Max)
	if b.Hist != nil {
		if a.Hist == nil {
			a.Hist = make([]int64, Buckets)
		}
		for i, n := range b.Hist {
			a.Hist[i] += n
		}
	}
	a.Covered += b.Covered
	a.Of += b.Of
	for k, n := range b.Bases {
		if a.Bases == nil {
			a.Bases = map[string]int64{}
		}
		a.Bases[k] += n
	}
	a.BMin = minp(a.BMin, b.BMin)
	a.BMax = maxp(a.BMax, b.BMax)
	for k, n := range b.Ex {
		if a.Ex == nil {
			a.Ex = map[string]float64{}
		}
		a.Ex[k] += n
	}
}

func minp(a, b *float64) *float64 {
	if b != nil && (a == nil || *b < *a) {
		return ptr(*b)
	}
	return a
}

func maxp(a, b *float64) *float64 {
	if b != nil && (a == nil || *b > *a) {
		return ptr(*b)
	}
	return a
}

// Dim is one dimension value.
type Dim struct{ Key, Value string }

// Table is every aggregate: by metric, fact cells keyed by day and dimension values.
type Table struct {
	Version  int                        `json:"definitions_version"`
	Cells    map[string]map[string]*Agg `json:"cells"`
	Overflow int64                      `json:"overflow"`
	// Open counts members started and not yet ended, by metric and the day they started.
	Open map[string]map[string]int64 `json:"open,omitempty"`
	// Suspect counts history.gap conflicts by the day they were recorded: periods holding one are
	// suspect until the next rebuild (shared contracts 4.5).
	Suspect map[string]int64 `json:"suspect,omitempty"`
	// Refused counts source records the observer refused (unreadable, or an identifier outside its
	// pattern), by source stream and day.
	Refused map[string]map[string]int64 `json:"refused,omitempty"`

	parsed map[string]fact     // fact key -> its parts (a cache, never encoded)
	dirty  map[string]struct{} // parts (metric, day) written since TakeDirty (for checkpoints)
}

// A part is one metric's cells of one day ("C1\x002026-11-12"): the unit a checkpoint encodes
// and shares, so a checkpoint re-encodes only the days events wrote to.

// TakeDirty returns the parts whose cells changed since the last call, and forgets them.
func (t *Table) TakeDirty() []string {
	out := sortedKeys(t.dirty)
	t.dirty = nil
	return out
}

// NewTable makes an empty table.
func NewTable() *Table {
	return &Table{Version: DefinitionsVersion, Cells: map[string]map[string]*Agg{}}
}

// fact is a parsed cell key.
type fact struct {
	day      string
	overflow bool
	dims     map[string]string
}

const sep = "|"

// key is the cell key: the day, then each non-empty dimension as key=value, sorted.
func key(dims []Dim, day string) string {
	parts := make([]string, 0, len(dims))
	for _, d := range dims {
		if d.Value != "" {
			parts = append(parts, d.Key+"="+strings.ReplaceAll(d.Value, sep, "/"))
		}
	}
	sort.Strings(parts)
	return day + sep + strings.Join(parts, sep)
}

func (t *Table) fact(k string) fact {
	if f, ok := t.parsed[k]; ok {
		return f
	}
	day, rest, _ := strings.Cut(k, sep)
	f := fact{day: day, dims: map[string]string{}}
	if rest == overflowKey {
		f.overflow = true
	} else if rest != "" {
		for _, p := range strings.Split(rest, sep) {
			if kk, v, ok := strings.Cut(p, "="); ok {
				f.dims[kk] = v
			}
		}
	}
	if t.parsed == nil {
		t.parsed = map[string]fact{}
	}
	if len(t.parsed) < 4*MaxGroups*len(Catalog) {
		t.parsed[k] = f
	}
	return f
}

func (t *Table) cell(id string, dims []Dim, day string) *Agg {
	if t.dirty == nil {
		t.dirty = map[string]struct{}{}
	}
	t.dirty[id+"\x00"+day] = struct{}{}
	m := t.Cells[id]
	if m == nil {
		m = map[string]*Agg{}
		t.Cells[id] = m
	}
	k := key(dims, day)
	a := m[k]
	if a == nil {
		if len(m) >= MaxGroups {
			t.Overflow++
			k = day + sep + overflowKey
			if a = m[k]; a != nil {
				return a
			}
		}
		a = &Agg{}
		m[k] = a
	}
	return a
}

// PartKeys lists every part of the table.
func (t *Table) PartKeys() []string {
	seen := map[string]struct{}{}
	for id, m := range t.Cells {
		for k := range m {
			day, _, _ := strings.Cut(k, sep)
			seen[id+"\x00"+day] = struct{}{}
		}
	}
	return sortedKeys(seen)
}

// Part is one part's cells (nil when it has none).
func (t *Table) Part(part string) map[string]*Agg {
	id, day, _ := strings.Cut(part, "\x00")
	var out map[string]*Agg
	for k, a := range t.Cells[id] {
		if d, _, _ := strings.Cut(k, sep); d == day {
			if out == nil {
				out = map[string]*Agg{}
			}
			out[k] = a
		}
	}
	return out
}

// SetPart adds a part's cells (decoding a checkpoint).
func (t *Table) SetPart(part string, cells map[string]*Agg) {
	id, _, _ := strings.Cut(part, "\x00")
	m := t.Cells[id]
	if m == nil {
		m = map[string]*Agg{}
		t.Cells[id] = m
	}
	for k, a := range cells {
		m[k] = a
	}
}

// Rate adds to a ratio: num over den.
func (t *Table) Rate(id string, dims []Dim, day string, num, den float64) {
	a := t.cell(id, dims, day)
	a.Num += num
	a.Den += den
}

// Count adds n occurrences.
func (t *Table) Count(id string, dims []Dim, day string, n float64) {
	t.cell(id, dims, day).Num += n
}

// Cover records whether the source existed for one member of the population; a member without
// it is also an exclusion with the reason given.
func (t *Table) Cover(id string, dims []Dim, day string, covered bool, reason string) {
	a := t.cell(id, dims, day)
	a.Of++
	if covered {
		a.Covered++
	} else {
		a.exclude(reason, 1)
	}
}

// Exclude records n members of the population left out of the value, with the reason.
func (t *Table) Exclude(id string, dims []Dim, day, reason string, n float64) {
	t.cell(id, dims, day).exclude(reason, n)
}

func (a *Agg) exclude(reason string, n float64) {
	if a.Ex == nil {
		a.Ex = map[string]float64{}
	}
	a.Ex[reason] += n
	if a.Ex[reason] == 0 {
		delete(a.Ex, reason)
	}
}

// Duration adds one measured duration in milliseconds.
func (t *Table) Duration(id string, dims []Dim, day string, ms int64) {
	v := float64(ms)
	a := t.cell(id, dims, day)
	a.Count++
	a.Sum += v
	a.Min = minp(a.Min, &v)
	a.Max = maxp(a.Max, &v)
	if a.Hist == nil {
		a.Hist = make([]int64, Buckets)
	}
	a.Hist[bucket(ms)]++
}

// Basis records one duration that is not measured (bounded, inferred, unknown): counted apart,
// with its bounds when known, never added to the statistic.
func (t *Table) Basis(id string, dims []Dim, day, basis string, minMS, maxMS *int64) {
	a := t.cell(id, dims, day)
	if a.Bases == nil {
		a.Bases = map[string]int64{}
	}
	a.Bases[basis]++
	if minMS != nil {
		a.BMin = minp(a.BMin, ptr(float64(*minMS)))
	}
	if maxMS != nil {
		a.BMax = maxp(a.BMax, ptr(float64(*maxMS)))
	}
}

// BasisAdd moves the count of members of a basis (an inferred visit later bounded otherwise).
func (t *Table) BasisAdd(id string, dims []Dim, day, basis string, delta int64) {
	a := t.cell(id, dims, day)
	if a.Bases == nil {
		a.Bases = map[string]int64{}
	}
	a.Bases[basis] += delta
	if a.Bases[basis] == 0 {
		delete(a.Bases, basis)
	}
}

// OpenAdd moves the count of open members of a metric started on day.
func (t *Table) OpenAdd(id, day string, delta int64) {
	if t.Open == nil {
		t.Open = map[string]map[string]int64{}
	}
	m := t.Open[id]
	if m == nil {
		m = map[string]int64{}
		t.Open[id] = m
	}
	m[day] += delta
	if m[day] <= 0 {
		delete(m, day)
	}
}

// MarkSuspect notes a history.gap conflict recorded on day.
func (t *Table) MarkSuspect(day string) {
	if t.Suspect == nil {
		t.Suspect = map[string]int64{}
	}
	t.Suspect[day]++
}

// Refuse counts n source records of a stream the observer refused, on day.
func (t *Table) Refuse(stream, day string, n int64) {
	if t.Refused == nil {
		t.Refused = map[string]map[string]int64{}
	}
	if t.Refused[stream] == nil {
		t.Refused[stream] = map[string]int64{}
	}
	t.Refused[stream][day] += n
}

func ptr[T any](v T) *T { return &v }

func bucket(ms int64) int {
	if ms < 1000 {
		return 0
	}
	b := int(math.Floor(3*math.Log2(float64(ms)/1000))) + 1
	return min(max(b, 1), Buckets-1)
}

// upper is a bucket's upper bound in milliseconds (exclusive).
func upper(b int) float64 {
	if b == 0 {
		return 1000
	}
	return 1000 * math.Pow(2, float64(b)/3)
}

// lower is a bucket's lower bound in milliseconds (inclusive).
func lower(b int) float64 {
	if b == 0 {
		return 0
	}
	return upper(b - 1)
}

// quantile is the histogram bucket that holds the q-th member: its upper bound (clamped to the
// observed minimum and maximum), and the bucket's bounds.
func quantile(h []int64, count int64, q float64, lo, hi *float64) (*float64, [2]float64) {
	if count == 0 || len(h) == 0 {
		return nil, [2]float64{}
	}
	target := max(int64(math.Ceil(q*float64(count))), 1)
	var seen int64
	for i, n := range h {
		seen += n
		if seen >= target {
			v := math.Round(upper(i))
			if hi != nil && v > *hi {
				v = *hi
			}
			if lo != nil && v < *lo {
				v = *lo
			}
			return ptr(v), [2]float64{math.Round(lower(i)), math.Round(upper(i))}
		}
	}
	return nil, [2]float64{}
}
