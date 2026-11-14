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
//
// 3: smaller cells (min and max without pointers, basis counts as fields), so a saved projection
// of version 2 is rebuilt.
const DefinitionsVersion = 3

// Buckets is the histogram size: bucket 0 is under one second; bucket i (1..63) holds durations
// in [2^((i-1)/3), 2^(i/3)) seconds, so bucket 63 reaches about 30 days.
const Buckets = 64

// MaxGroups bounds the cells one metric keeps, so hostile identifiers cannot grow memory without
// limit. A member that would need a further cell is folded into its day's overflow cell (no
// dimension values): totals and periods stay exact, groups report it as "overflow".
const MaxGroups = 20000

// overflowKey marks a day's overflow cell.
const overflowKey = "~"

// Agg is one aggregate cell. Every field merges by addition (min and max by comparison). It is
// kept small: a long history holds tens of thousands (no pointers or maps on the common path).
type Agg struct {
	Num   float64 `json:"num,omitempty"`
	Den   float64 `json:"den,omitempty"`
	Count int64   `json:"count,omitempty"`
	Sum   float64 `json:"sum,omitempty"`
	// Min and Max are the measured durations' least and greatest; they hold only when Count > 0.
	Min float64 `json:"min,omitempty"`
	Max float64 `json:"max,omitempty"`
	// Hist holds histogram buckets HistLo .. HistLo+len(Hist)-1 only (the ones in use), not all
	// Buckets: most cells' durations span a few buckets.
	Hist   []int64 `json:"hist,omitempty"`
	HistLo int     `json:"hlo,omitempty"`
	// Durations not measured, counted apart (never averaged).
	Bounded  int64 `json:"bounded,omitempty"`
	Inferred int64 `json:"inferred,omitempty"`
	Unknown  int64 `json:"unknown,omitempty"`
	// Bounds over the bounded members: the least lower bound and the greatest upper bound.
	BMin *float64 `json:"bmin,omitempty"`
	BMax *float64 `json:"bmax,omitempty"`
	// Ex are members of the population left out of the value, by reason.
	Ex map[string]float64 `json:"ex,omitempty"`
}

// bases is the count field of a basis that is not measured (nil for any other).
func (a *Agg) bases(basis string) *int64 {
	switch basis {
	case "bounded":
		return &a.Bounded
	case "inferred":
		return &a.Inferred
	case "unknown":
		return &a.Unknown
	}
	return nil
}

func (a *Agg) merge(b *Agg) {
	if b.Count > 0 {
		if a.Count == 0 || b.Min < a.Min {
			a.Min = b.Min
		}
		if a.Count == 0 || b.Max > a.Max {
			a.Max = b.Max
		}
	}
	a.Num += b.Num
	a.Den += b.Den
	a.Count += b.Count
	a.Sum += b.Sum
	for i, n := range b.Hist {
		if n != 0 {
			a.histAdd(b.HistLo+i, n)
		}
	}
	a.Bounded += b.Bounded
	a.Inferred += b.Inferred
	a.Unknown += b.Unknown
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

	dirty map[string]struct{} // parts (metric, day) written since TakeDirty (for checkpoints)
	order map[string][]string // each metric's cell keys, sorted (a cache, never encoded)
}

// A part is one metric's cells of one day ("C1\x002026-11-12"): the unit a checkpoint encodes
// and shares, so a checkpoint re-encodes only the days events wrote to.

// keys is a metric's cell keys in a fixed order, so float sums merge the same way on every read.
func (t *Table) keys(id string) []string {
	m := t.Cells[id]
	if k, ok := t.order[id]; ok && len(k) == len(m) {
		return k
	}
	k := sortedKeys(m)
	if t.order == nil {
		t.order = map[string][]string{}
	}
	t.order[id] = k
	return k
}

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

// fact is a cell key read in place: its day, and its dimensions looked up without copying.
type fact struct {
	day      string
	overflow bool
	rest     string // key=value pairs joined by sep
}

// get is a dimension's value in the key ("" when absent).
func (f fact) get(k string) string {
	s := f.rest
	for s != "" {
		var p string
		p, s, _ = strings.Cut(s, sep)
		if len(p) > len(k) && p[len(k)] == '=' && p[:len(k)] == k {
			return p[len(k)+1:]
		}
	}
	return ""
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
	day, rest, _ := strings.Cut(k, sep)
	if rest == overflowKey {
		return fact{day: day, overflow: true}
	}
	return fact{day: day, rest: rest}
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
	if a.Count == 0 || v < a.Min {
		a.Min = v
	}
	if a.Count == 0 || v > a.Max {
		a.Max = v
	}
	a.Count++
	a.Sum += v
	a.histAdd(bucket(ms), 1)
}

// Basis records one duration that is not measured (bounded, inferred, unknown): counted apart,
// with its bounds when known, never added to the statistic.
func (t *Table) Basis(id string, dims []Dim, day, basis string, minMS, maxMS *int64) {
	a := t.cell(id, dims, day)
	if n := a.bases(basis); n != nil {
		*n++
	}
	if minMS != nil {
		a.BMin = minp(a.BMin, ptr(float64(*minMS)))
	}
	if maxMS != nil {
		a.BMax = maxp(a.BMax, ptr(float64(*maxMS)))
	}
}

// BasisAdd moves the count of members of a basis (an inferred visit later bounded otherwise).
func (t *Table) BasisAdd(id string, dims []Dim, day, basis string, delta int64) {
	if n := t.cell(id, dims, day).bases(basis); n != nil {
		*n += delta
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

// histAdd adds n to histogram bucket b, widening the kept range as needed.
func (a *Agg) histAdd(b int, n int64) {
	switch {
	case len(a.Hist) == 0:
		a.Hist, a.HistLo = []int64{n}, b
		return
	case b < a.HistLo:
		h := make([]int64, a.HistLo-b+len(a.Hist))
		copy(h[a.HistLo-b:], a.Hist)
		a.Hist, a.HistLo = h, b
	case b >= a.HistLo+len(a.Hist):
		a.Hist = append(a.Hist, make([]int64, b-a.HistLo-len(a.Hist)+1)...)
	}
	a.Hist[b-a.HistLo] += n
}

// full is the histogram over all Buckets.
func (a *Agg) full() []int64 {
	if len(a.Hist) == 0 {
		return nil
	}
	h := make([]int64, Buckets)
	copy(h[a.HistLo:], a.Hist)
	return h
}
